#!/usr/bin/env python3
"""Bothy updating ITSELF, end to end, against a THROWAWAY clone. Needs docker and
a systemd user manager (the rollback timer lives there).

Run: python3 checks/e2e_owncode.py            (about three minutes)

NEVER the live stack, and nothing here publishes a port. Everything is its own:

  a repo        a bare "origin" with annotated release tags, a "dev" clone that
                cuts releases, and the "live" clone on main the updater moves -
                laid out like Bothy: apps/bothy/compose.yml, apps/bothy-{web,files,
                ops}/, a justfile whose `up-apps *services` honours BOTHY_IMAGE_TAG
                and BOTHY_UP_NO_BUILD, updates.toml, and an updater/ file
  a project     `-p bothy-owncode-test`: three containers (nginx for web with a
                real catch-all and /version.json; busybox httpd /healthz for files
                and ops), images `bothy-owncode-test-*:<sha>`, no host ports -
                every probe runs inside the container's network namespace
  state         temporary state, backups and updater-lib directories; CI's verdict
                is a function that says green

and it drives the REAL pieces: plans.write_all, bothy-ops' own
updates.request_update() writing the spool file, the executor as a separate
process (`--worker`, as systemd runs it), `systemd-run --user` for the rollback
timer, and the timer's own program when it fires. In order:

  1  SUCCESS        v1 -> v2: built from a temporary worktree first, the checkout
                    fast-forwarded, web last, /version.json names v2, disarmed
  2  ROLLBACK       the box back on v1; v1 -> v2 with verify forced to fail: the
                    armed rollback restores v1 (sha AND images), and v2 is not
                    offered again
  2b THE TIMER      v1 -> v2 with the executor KILLED during verify: the rollback
                    timer (compressed from 10 min to 8 s) fires on its own,
                    restores v1 and finishes the job's record
  3  SELF-CHANGE    v1 -> v3, a release that changes the updater: it succeeds, the
                    new updater copy is STAGED, `current` is not switched
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)
os.environ.setdefault("ADMIN_AUDIT_LOG", os.devnull)

import updater  # noqa: E402,F401
from updater import canaries, executor, hostio, install, owncode, plans, record  # noqa: E402
from updater.config import Config  # noqa: E402

P = "bothy-owncode-test"
SVCS = ("bothy-files", "bothy-ops", "bothy-web")
CONT = {s: f"{P}-{s.split('-')[1]}" for s in SVCS}
IMG = {s: f"{P}-{s.split('-')[1]}" for s in SVCS}


def green(slug: str, sha: str) -> dict:
    return {"green": True, "via": "the test", "runs": 1, "detail": "green (the test says so)"}


def make_cfg(d: dict, force: str | None = None) -> Config:
    return Config(repo=d["repo"], catalog=d["catalog"], state=d["state"], backups=d["backups"],
                  textfile=d["textfile"], lib=d["lib"], own_containers=CONT, own_images=IMG,
                  own_edge_url=None, own_rollback_after=8, own_apply_timeout=150, verify_timeout=60,
                  min_free_bytes=1 << 20, own_checks=green, own_force_verify=force)


# ── worker mode: what systemd runs, with the test's Config ────────────────────
if len(sys.argv) >= 3 and sys.argv[1] == "--worker":
    with open(sys.argv[2]) as fh:
        wcfg = make_cfg(json.load(fh), sys.argv[3] if len(sys.argv) > 3 else None)
    sys.exit(executor.run_spool(wcfg, log=lambda m: print(m, flush=True)))

import updates  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label, flush=True)
    if not cond:
        fails.append(label)


def sh(*argv: str, cwd: str | None = None, check: bool = True, env: dict | None = None) -> str:
    p = subprocess.run(list(argv), cwd=cwd, capture_output=True, text=True, env=env)
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(argv)} -> {p.returncode}: {(p.stderr or p.stdout)[-800:]}")
    return p.stdout.strip()


def user_units() -> list[str]:
    out = sh("systemctl", "--user", "list-units", "--all", "--plain", "--no-legend", "bothy-own-rollback-*",
             check=False, env=owncode.user_env())
    return [ln.split()[0] for ln in out.splitlines() if ln.strip()]


JOBS: list[str] = []


def cleanup() -> None:
    subprocess.run(["docker", "compose", "-p", P, "down", "-v", "--remove-orphans"], capture_output=True)
    subprocess.run(["docker", "rm", "-f", *CONT.values()], capture_output=True)
    for repo in IMG.values():
        tags = sh("docker", "image", "ls", repo, "--format", "{{.Repository}}:{{.Tag}}", check=False).split()
        if tags:
            subprocess.run(["docker", "image", "rm", "-f", *tags], capture_output=True)
    # Only OUR jobs' units: a real rollback timer on this box is never touched.
    for u in user_units():
        if any(j[:12] in u for j in JOBS):
            subprocess.run(["systemctl", "--user", "stop", u], capture_output=True, env=owncode.user_env())
            subprocess.run(["systemctl", "--user", "reset-failed", u], capture_output=True, env=owncode.user_env())


if shutil.which("docker") is None or subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
    print("SKIP: no docker daemon")
    sys.exit(0)
if shutil.which("just") is None or shutil.which("systemd-run") is None:
    print("SKIP: no `just` or no systemd-run")
    sys.exit(0)
if subprocess.run(["systemctl", "--user", "show-environment"], capture_output=True,
                  env=owncode.user_env()).returncode != 0:
    print("SKIP: no systemd user manager (the rollback timer needs one)")
    sys.exit(0)

GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false",
       "-c", "tag.gpgsign=false"]

JUSTFILE = r"""# A stand-in for Bothy's up-apps: same interface (services, BOTHY_IMAGE_TAG,
# BOTHY_UP_NO_BUILD), a throwaway project, no host ports.
up-apps *services:
    #!/usr/bin/env bash
    set -euo pipefail
    BOTHY_REVISION="$(git rev-parse HEAD)"
    BOTHY_IMAGE_TAG="${BOTHY_IMAGE_TAG:-$BOTHY_REVISION}"
    export BOTHY_REVISION BOTHY_IMAGE_TAG BUILDX_NO_DEFAULT_ATTESTATIONS=1
    svcs=({{services}})
    flags=()
    if [ "${BOTHY_UP_NO_BUILD:-}" = 1 ]; then
      flags=(--no-build)
    else
      docker compose -f apps/bothy/compose.yml build ${svcs[@]+"${svcs[@]}"}
    fi
    docker compose -f apps/bothy/compose.yml up -d --wait --wait-timeout 90 ${flags[@]+"${flags[@]}"} ${svcs[@]+"${svcs[@]}"}
"""


def compose() -> str:
    out = [f"name: {P}", "services:"]
    for s in SVCS:
        out += [f"  {s}:", f"    build:", f"      context: ../{s}", "      args:",
                "        REVISION: ${BOTHY_REVISION:-unknown}",
                f"    image: {IMG[s]}:${{BOTHY_IMAGE_TAG:-latest}}", "    pull_policy: never",
                f"    container_name: {CONT[s]}"]
    return "\n".join(out) + "\n"


HTTPD = """FROM busybox:1.36.1
RUN mkdir /www && printf '{"ok": true, "svc": "%s"}' "{svc}" > /www/healthz
HEALTHCHECK --interval=2s --timeout=2s --retries=20 CMD wget -qO /dev/null http://127.0.0.1:{port}/healthz || exit 1
CMD ["httpd", "-f", "-p", "{port}", "-h", "/www"]
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=$REVISION
"""

WEB = """FROM nginx:1.31-alpine
COPY default.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
HEALTHCHECK --interval=2s --timeout=2s --retries=20 CMD wget -qO /dev/null http://127.0.0.1:80/ || exit 1
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=$REVISION
RUN printf '{"revision":"%s"}\\n' "$REVISION" > /usr/share/nginx/html/version.json
"""

NGINX = """server {
    listen 80;
    root /usr/share/nginx/html;
    location = /version.json { add_header Cache-Control "no-cache"; }
    location / { try_files $uri $uri/ /index.html; }
}
"""

CATALOG = """[policy]
window_start = "03:30"
window_end = "05:00"
require_backup = "stacks-backup.service"
require_doctor = true
max_auto_per_night = 1
pause_on_failure = true
discover_every_hours = 6

[components.bothy]
title = "Bothy (web, files, ops)"
class = "own-code"
source = "github"
repo = "example/bothy-test"
pins = ["VERSION"]
apply = "just up-apps"
dependants = ["bothy-web", "bothy-files", "bothy-ops"]
changelog = "https://example.invalid/releases/tag/v{version}"
channel = "notify"
one_way = false
verify = ["the body names the version"]
"""

cleanup()
TMP = tempfile.mkdtemp(prefix="bothy-owncode-e2e-")
try:
    ORIGIN, DEV, LIVE = (os.path.join(TMP, n) for n in ("origin.git", "dev", "live"))

    def git(*args: str, cwd: str) -> str:
        return sh(*GIT, *args, cwd=cwd)

    def write(rel: str, text: str) -> None:
        p = os.path.join(DEV, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as fh:
            fh.write(text)

    def release(version: str, body: str, extra: dict | None = None) -> str:
        write("VERSION", version + "\n")
        write("apps/bothy-web/index.html",
              f'<!doctype html><html><body><div id="root">{body}</div><script src="/assets/{body}.js"></script>'
              "</body></html>\n")
        for k, v in (extra or {}).items():
            write(k, v)
        git("add", "-A", cwd=DEV)
        git("commit", "-q", "-m", f"release {version}", cwd=DEV)
        git("tag", "-a", f"v{version}", "-m", f"Bothy v{version}", cwd=DEV)
        git("push", "-q", "origin", "main", f"v{version}", cwd=DEV)
        return git("rev-parse", "HEAD", cwd=DEV)

    sh("git", "init", "-q", "--bare", "-b", "main", ORIGIN)
    sh("git", "clone", "-q", ORIGIN, DEV)
    git("checkout", "-q", "-b", "main", cwd=DEV)
    write("justfile", JUSTFILE)
    write("apps/bothy/compose.yml", compose())
    write("apps/bothy-files/Dockerfile", HTTPD.replace("{port}", "8099").replace("{svc}", "files"))
    write("apps/bothy-ops/Dockerfile", HTTPD.replace("{port}", "8097").replace("{svc}", "ops"))
    write("apps/bothy-web/Dockerfile", WEB)
    write("apps/bothy-web/default.conf", NGINX)
    write("apps/bothy-ops/updates.toml", CATALOG)
    write("apps/bothy-ops/updater/marker.py", "# the updater, v1\n")
    V1 = release("2026.1.0", "web v1")
    sh("git", "clone", "-q", ORIGIN, LIVE)
    V2 = release("2026.1.1", "web v2")

    D = {"repo": LIVE, "catalog": os.path.join(LIVE, "apps/bothy-ops/updates.toml"),
         "state": os.path.join(TMP, "state"), "backups": os.path.join(TMP, "backups"),
         "textfile": os.path.join(TMP, "textfile"), "lib": os.path.join(TMP, "lib")}
    CFGFILE = os.path.join(TMP, "cfg.json")
    json.dump(D, open(CFGFILE, "w"))
    cfg = make_cfg(D)
    os.makedirs(cfg.spool, mode=0o700)
    AVAIL = {"version": 1, "generatedAt": "2026-09-19T10:00:00Z", "components": {}}
    hostio.write_json(cfg.available, AVAIL)

    print("── setup: the box runs v1 ────────────────────────────────────────", flush=True)
    sh("just", "up-apps", cwd=LIVE)
    install.install(cfg, V1)
    catalog = updates.load(cfg.catalog)

    updates.CATALOG = catalog
    updates.AVAILABLE_FILE = cfg.available
    updates.UPDATES_DIR = cfg.state
    updates.SPOOL_DIR = cfg.spool

    class H:
        def __init__(self, body: dict) -> None:
            self.body = body

        def read_json_object(self, _max: int) -> dict:
            return self.body

    def request() -> str:
        plans.write_all(cfg, catalog, AVAIL)
        doc = plans.read_plan(cfg, "bothy")
        assert doc and doc["ok"], f"no plan for bothy: {doc}"
        p = doc["plan"]
        out, _ = updates.request_update(H({"component": "bothy", "plan_id": p["id"],
                                           "confirm": True if p["confirm"] == "click" else "bothy"}),
                                        "operator@example.com")
        JOBS.append(out["jobId"])
        return out["jobId"]

    def worker(force: str | None = None) -> subprocess.Popen:
        return subprocess.Popen([sys.executable, os.path.abspath(__file__), "--worker", CFGFILE,
                                 *([force] if force else [])],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def job(jid: str) -> dict:
        return next((h for h in record.history(cfg, 100) if h["id"] == jid), {})

    def head() -> str:
        return git("rev-parse", "HEAD", cwd=LIVE)

    def running() -> dict:
        out = {}
        for s in SVCS:
            c = hostio.container(CONT[s]) or {}
            img = hostio.image(c.get("imageId") or "x") or {}
            out[s] = (c.get("imageId"), (img.get("labels") or {}).get(owncode.REVISION), c.get("health"))
        return out

    def version_json() -> str:
        st, b = canaries.probe(canaries.Ctx(cfg, CONT["bothy-web"]), "http://127.0.0.1:80/version.json")
        try:
            return json.loads(b).get("revision")
        except (ValueError, AttributeError):
            return f"<{st} {b[:60]}>"

    def on_version(sha: str) -> bool:
        return all(rev == sha for _, rev, _ in running().values())

    ok(head() == V1 and on_version(V1) and version_json() == V1, "the box runs v1: checkout, labels, /version.json")
    V1_IDS = {s: v[0] for s, v in running().items()}

    # ── 1. success ──────────────────────────────────────────────────────────
    print("── 1. SUCCESS: v1 -> v2 ─────────────────────────────────────────", flush=True)
    p = plans.plan("bothy", cfg=cfg, catalog=catalog, available=AVAIL)
    ok(p["to"]["sha"] == V2 and p["confirm"] == "click" and p["own"]["apps"] == ["bothy-web"],
       f"the plan: v2026.1.0 -> {p['to']['tag']}, one click, bothy-web changed")
    j1 = request()
    out = worker().communicate(timeout=600)[0]
    r = job(j1)
    ok(r.get("state") == "succeeded", f"succeeded ({r.get('state')}: {r.get('error')}) {out[-400:] if r.get('state') != 'succeeded' else ''}")
    ok(head() == V2 and sh("git", "status", "--porcelain", cwd=LIVE) == "", "the checkout fast-forwarded to v2, clean")
    ok(on_version(V2) and version_json() == V2, "every container runs v2's image, and /version.json names v2")
    ok(all(hostio.image(f"{IMG[s]}:{V2}") for s in SVCS) and all(hostio.image(f"{IMG[s]}:{V1}") for s in SVCS),
       "images are named by commit: :v2 runs, :v1 is still there for a rollback")
    st = hostio.read_json(cfg.status_file)["job"]
    names = [(s["name"], s["state"]) for s in st["steps"]]
    ok([n for n, s in names if s == "ok"] == ["validate", "preflight", "build", "snapshot", "arm", "switch", "apply",
                                              "verify", "record"] and ("stage", "skipped") in names,
       f"status.json: every step in order, stage skipped: {names}")
    wts = sh("git", "worktree", "list", "--porcelain", cwd=LIVE)
    ok(wts.count("worktree ") == 1, "the temporary build worktree is gone")
    ok(os.path.exists(os.path.join(cfg.own_dir, f"{j1}.disarmed.json")) and not [u for u in user_units() if j1[:12] in u],
       "verify disarmed the rollback: no timer is left")
    ok(os.path.realpath(os.path.join(cfg.lib, "current")).endswith(V1) and not os.path.islink(os.path.join(cfg.lib, "staged")),
       "the updater is unchanged: nothing staged")

    # ── 2. forced verify failure -> the armed rollback restores v1 ──────────
    print("── 2. ROLLBACK: v1 -> v2, verify forced to fail ─────────────────", flush=True)
    git("reset", "-q", "--hard", V1, cwd=LIVE)
    env = {**os.environ, "BOTHY_UP_NO_BUILD": "1"}
    sh("just", "up-apps", cwd=LIVE, env=env)
    ok(head() == V1 and on_version(V1), "the box is back on v1 (by hand) for the next two")
    j2 = request()
    out = worker("fail").communicate(timeout=600)[0]
    r = job(j2)
    ok(r.get("state") == "rolled_back" and "forced" in (r.get("error") or ""),
       f"rolled back ({r.get('state')}: {r.get('error')}) {out[-300:] if r.get('state') != 'rolled_back' else ''}")
    ok(head() == V1 and sh("git", "status", "--porcelain", cwd=LIVE) == "", "the checkout is v1 again, clean")
    ok({s: v[0] for s, v in running().items()} == V1_IDS and version_json() == V1,
       "the SAME v1 images run again (no rebuild), and /version.json names v1")
    ok(json.load(open(os.path.join(cfg.own_dir, "blocked.json")))["sha"] == V2, "v2 is recorded as rolled back")
    try:
        plans.plan("bothy", cfg=cfg, catalog=catalog, available=AVAIL)
        ok(False, "…and not offered again (a plan was MADE)")
    except plans.PlanRefused as e:
        ok("rolled back" in str(e), f"…and not offered again: {str(e)[:90]}")
    ok(not [u for u in user_units() if j2[:12] in u and u.endswith(".timer") and "active" in u],
       "the executor fired the rollback itself and stopped the timer")

    # ── 2b. the executor dies during verify -> the TIMER restores v1 ────────
    print("── 2b. THE TIMER: the executor is killed during verify ───────────", flush=True)
    os.unlink(os.path.join(cfg.own_dir, "blocked.json"))
    j3 = request()
    w = worker("hang")
    t0 = time.monotonic()
    while time.monotonic() - t0 < 400:
        try:
            stj = hostio.read_json(cfg.status_file)["job"]
        except (OSError, ValueError, KeyError):
            stj = {}
        if stj.get("id") == j3 and any(s["name"] == "verify" and s["state"] == "running" for s in stj.get("steps", [])):
            break
        time.sleep(1)
    ok(head() == V2 and on_version(V2), "the executor got as far as verify: the box runs v2")
    w.send_signal(signal.SIGKILL)
    w.wait(timeout=30)
    t_kill = time.monotonic()
    r = {}
    while time.monotonic() - t_kill < 300:
        r = job(j3)
        if r:
            break
        time.sleep(2)
    ok(r.get("state") == "rolled_back" and "timer fired" in (r.get("error") or ""),
       f"the timer fired on its own and finished the record ({r.get('state')}: {r.get('error')})")
    ok(head() == V1 and {s: v[0] for s, v in running().items()} == V1_IDS and version_json() == V1,
       "…and v1 is back: the sha, the same images, /version.json")
    ok(os.path.exists(os.path.join(cfg.own_dir, f"{j3}.fired.json"))
       and json.load(open(os.path.join(cfg.own_dir, f"{j3}.result.json")))["ok"] is True,
       "the armed file was claimed by the timer, and its result says ok")
    print(f"  (the timer restored v1 {int(time.monotonic() - t_kill)} s after the kill)", flush=True)

    # ── 3. a release that changes the updater: staged, not switched ─────────
    print("── 3. SELF-CHANGE: v1 -> v3, which changes the updater ──────────", flush=True)
    os.unlink(os.path.join(cfg.own_dir, "blocked.json"))
    V3 = release("2026.1.2", "web v3", {"apps/bothy-ops/updater/marker.py": "# the updater, v3\n"})
    p = plans.plan("bothy", cfg=cfg, catalog=catalog, available=AVAIL)
    ok(p["to"]["sha"] == V3 and p["own"]["updater"] is True and p["own"]["updaterFiles"] == ["apps/bothy-ops/updater"],
       "the plan says the release changes the updater")
    j4 = request()
    out = worker().communicate(timeout=600)[0]
    r = job(j4)
    ok(r.get("state") == "succeeded" and "STAGED" in (r.get("note") or ""),
       f"succeeded, and says the updater is staged ({r.get('state')}: {r.get('error') or r.get('note')})")
    ok(head() == V3 and on_version(V3) and version_json() == V3, "the box runs v3")
    ok(os.path.realpath(os.path.join(cfg.lib, "staged")).endswith(V3)
       and os.path.realpath(os.path.join(cfg.lib, "current")).endswith(V1),
       "the new updater is STAGED beside current; current still points at v1's copy")
    ok(open(os.path.join(cfg.lib, V3, "apps/bothy-ops/updater/marker.py")).read() == "# the updater, v3\n",
       "…and the staged copy is v3's updater, from git")
    u = updates._updater()
    ok(u and u["staged"] == V3 and u["current"] == V1, f"bothy-ops tells Settings a switch is pending: {u}")
finally:
    cleanup()
    shutil.rmtree(TMP, ignore_errors=True)

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("e2e_owncode: all passed")
