#!/usr/bin/env python3
"""The host updater END TO END, against a THROWAWAY compose project. Needs docker.

Run: python3 checks/e2e_updater.py            (about eight minutes)

NEVER the live stack. Everything here is its own:

  a registry      registry:2 as `bothy-updater-test-registry`, on 127.0.0.1 and a
                  random port, holding images built here FROM busybox
  two projects    `-p bothy-updater-test` (container bothy-updater-test-web) and
                  `-p bothy-updater-test2` (bothy-updater-test-web2), each a
                  busybox httpd whose BODY names its version
  a git repo      a bare "origin" and a clone on main, with its own compose files,
                  justfile (`up-web`, `up-web2`) and updates.toml
  state           a temporary state dir (available.json, plans, spool, status,
                  history, audit), backups dir and textfile dir

and it drives the REAL pieces: discover_updates.Discoverer against the registry,
plans.write_all, bothy-ops' own updates.request_update() writing the spool file,
and the executor as separate processes (`--worker`), exactly as systemd runs it.

  1  PRE-FLIGHT REFUSAL  the newest backup is two days old -> refused, nothing
                         touched, no snapshot taken
  2  SUCCESS             1.0.0 -> 1.0.1 (merged on main): snapshot, pull, recipe,
                         canary on the body; the tree stays clean
  3  ROLLBACK            main pins 1.0.2, which is HEALTHY but serves the wrong
                         body - only a canary on bytes catches it (rule 7). Rolled
                         back to 1.0.1, the old pin line written back (one line,
                         uncommitted), the plan for it then refuses
  4  CONCURRENCY         two requests, two executor processes started together:
                         one holds the lock and runs both, one after the other;
                         the other says so and does nothing
  5  TIME-SERIES         the timeseries class's snapshot (scripts/snapshot.sh ->
                         bk_snapshot_vm / bk_snapshot_loki) and restore
                         (scripts/restore.sh) on throwaway VictoriaMetrics and Loki
                         containers - the same code the nightly backup runs
  6  ONE-WAY: GRAFANA    a throwaway Grafana (13.1.4, its own volume, a datasource
                         uid=prometheus on a throwaway VictoriaMetrics) and two
                         dashboards made through the API. bothy-ops refuses a click
                         (type-the-name). 13.2.2 with a FORCED verify failure that
                         first deletes one dashboard and makes another -> the
                         volume tar is restored, 13.1.4 runs, the old dashboards
                         are back and the new one is gone. Then 13.2.2 succeeds.
  7  ONE-WAY: KEYCLOAK   a throwaway postgres + Keycloak 26.7.3-0 (start-dev, the
                         LIVE realm file and the LIVE keycloak-init script) +
                         oauth2-proxy, and Keycloak's real canaries - a real
                         sign-in, viewer 202 / shell 403. Both pins -> 26.7.4-0
                         with a FORCED failure that deletes a client -> the
                         pg_dump is restored, both pin lines go back, the client
                         is back. Then 26.7.4-0 succeeds.

Images it had to pull are removed again; the ones already on the box (the live
stack's) are left alone.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)
os.environ.setdefault("ADMIN_AUDIT_LOG", os.devnull)

import updater  # noqa: E402,F401
from updater import canaries, executor, hostio, plans, record  # noqa: E402
from updater.config import Config  # noqa: E402

P1, P2 = "bothy-updater-test", "bothy-updater-test2"
C1, C2 = f"{P1}-web", f"{P2}-web2"
REG = f"{P1}-registry"
VM, LOKI = f"{P1}-vm", f"{P1}-loki"
# The app-db stand-ins (sections 6 and 7): two more compose projects, a network,
# and the containers they talk to. All names start with bothy-updater-test.
P3, P4 = f"{P1}-mon", f"{P1}-auth"
NET = f"{P1}-net"
GF, GFVM = f"{P1}-grafana", f"{P1}-gfvm"
KC, KCI, KPG, O2P = f"{P1}-kc", f"{P1}-kc-init", f"{P1}-pg", f"{P1}-o2p"
GF_OLD, GF_NEW = "grafana/grafana:13.1.4", "grafana/grafana:13.2.2"
KC_OLD, KC_NEW = "quay.io/keycloak/keycloak:26.7.3-0", "quay.io/keycloak/keycloak:26.7.4-0"
O2P_IMG = "quay.io/oauth2-proxy/oauth2-proxy:v7.15.4"
VM_IMG = "victoriametrics/victoria-metrics:v1.152.0"
GF_PASS, LOGIN_USER, LOGIN_PASS, PG_PASS = "e2e-grafana-pass", "e2e@example.com", "e2e-login-pass-1", "e2e-pg-pass"


def _flag(cid: str) -> str:
    """While this file exists, the injected canary of `cid` fails verify."""
    return os.path.join(os.environ.get("E2E_TMP", "/nonexistent"), f"inject-{cid}")


def _gf_api(ctx, method: str, path: str, body: str | None = None) -> tuple[int, str]:
    return canaries.probe(ctx, "http://127.0.0.1:3000" + path, method=method, cred=f"admin:{GF_PASS}",
                          body=body, ctype="application/json" if body else None)


def _gf_dashboard(uid: str) -> str:
    return json.dumps({"dashboard": {"uid": uid, "title": uid, "panels": [], "schemaVersion": 39},
                       "overwrite": True})


def kcadm(*args: str) -> tuple[int, str]:
    """kcadm.sh in the THROWAWAY keycloak, as its bootstrap admin (test values only)."""
    cfgf = "/tmp/e2e-kcadm.config"
    subprocess.run(["docker", "exec", KC, "/opt/keycloak/bin/kcadm.sh", "config", "credentials", "--server",
                    "http://localhost:8080", "--realm", "master", "--user", "admin", "--password", LOGIN_PASS,
                    "--config", cfgf], capture_output=True)
    p = subprocess.run(["docker", "exec", KC, "/opt/keycloak/bin/kcadm.sh", *args, "--config", cfgf],
                       capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def kc_client(client_id: str) -> str | None:
    rc, out = kcadm("get", "clients", "-r", "devbox", "-q", f"clientId={client_id}", "--fields", "id,clientId")
    try:
        return next((c["id"] for c in json.loads(out) if c.get("clientId") == client_id), None)
    except (ValueError, TypeError):
        return None


def inject_grafana() -> canaries.Canary:
    """A forced verify failure AFTER the new version has written to its database:
    a dashboard made before the update is deleted and a new one made. Only the
    snapshot restore brings the first back and removes the second."""
    def check(ctx):
        if ctx.phase != "verify" or not os.path.exists(_flag("grafana")):
            return True, "not injected"
        _gf_api(ctx, "DELETE", "/api/dashboards/uid/e2e-before-b")
        _gf_api(ctx, "POST", "/api/dashboards/db", _gf_dashboard("e2e-after"))
        return False, "FORCED: deleted e2e-before-b, made e2e-after, then failed"
    return canaries.Canary("e2e: an injected failure (grafana)", check, retry=False)


def inject_keycloak() -> canaries.Canary:
    def check(ctx):
        if ctx.phase != "verify" or not os.path.exists(_flag("keycloak")):
            return True, "not injected"
        cid = kc_client("e2e-before")
        if cid:
            kcadm("delete", f"clients/{cid}", "-r", "devbox")
        kcadm("create", "clients", "-r", "devbox", "-s", "clientId=e2e-after")
        return False, "FORCED: deleted client e2e-before, made e2e-after, then failed"
    return canaries.Canary("e2e: an injected failure (keycloak)", check, retry=False)


def test_canaries() -> dict:
    return {
        # Grafana's REAL canaries (the container comes from the pin), after the injection.
        "grafana": [inject_grafana(), *canaries.CANARIES["grafana"]],
        # Keycloak's real canaries; the two that look at OTHER containers are
        # pointed at the stand-ins' names.
        "keycloak": [inject_keycloak(), canaries.kc_issuer(), canaries.kc_realm(), canaries.kc_init_ran(KCI),
                     canaries.kc_admin_token(), canaries.oauth2_shell_denied(O2P)],
        "web": [canaries.body_matches("http://127.0.0.1:8080/", r"^web \d+\.\d+\.\d+$",
                                      "the body says `web <version>`")],
        "web2": [canaries.body_matches("http://127.0.0.1:8080/", r"^web2 \d+\.\d+\.\d+$",
                                       "the body says `web2 <version>`")],
    }


def make_cfg(d: dict) -> Config:
    return Config(repo=d["repo"], catalog=d["catalog"], state=d["state"], backups=d["backups"],
                  textfile=d["textfile"], verify_timeout=60, min_free_bytes=1 << 20,
                  canaries=test_canaries())


# ── worker mode: what systemd runs, with the test's Config ────────────────────
if len(sys.argv) == 3 and sys.argv[1] == "--worker":
    with open(sys.argv[2]) as fh:
        wcfg = make_cfg(json.load(fh))
    sys.exit(executor.run_spool(wcfg, log=lambda m: print(m, flush=True)))

import discover_updates as du  # noqa: E402
import updates  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label, flush=True)
    if not cond:
        fails.append(label)


def sh(*argv: str, cwd: str | None = None, check: bool = True, stdin: str | None = None) -> str:
    p = subprocess.run(list(argv), cwd=cwd, capture_output=True, text=True, input=stdin)
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(argv)} -> {p.returncode}: {p.stderr[-800:]}")
    return p.stdout.strip()


def cleanup() -> None:
    for proj in (P1, P2, P3, P4):
        subprocess.run(["docker", "compose", "-p", proj, "down", "-v", "--remove-orphans"],
                       capture_output=True)
    # -v: registry:2, postgres and victoria-metrics declare VOLUMEs, and a plain
    # `rm -f` leaves each one behind as an anonymous volume.
    subprocess.run(["docker", "rm", "-f", "-v", C1, C2, REG, VM, LOKI, GF, GFVM, KC, KCI, KPG, O2P], capture_output=True)
    subprocess.run(["docker", "volume", "rm", "-f", LOKI, VM, f"{P3}_grafana_data"], capture_output=True)
    subprocess.run(["docker", "network", "rm", NET], capture_output=True)


if shutil.which("docker") is None or subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
    print("SKIP: no docker daemon")
    sys.exit(0)
if shutil.which("just") is None:
    print("SKIP: no `just` on PATH")
    sys.exit(0)

cleanup()
TMP = tempfile.mkdtemp(prefix="bothy-updater-e2e-")
os.environ["E2E_TMP"] = TMP      # the workers inherit it: where the injection flags live
built: list[str] = []
pulled: list[str] = []           # images THIS run pulled - removed again at the end
try:
    # ── the registry and the images ─────────────────────────────────────────
    sh("docker", "run", "-d", "--name", REG, "-p", "127.0.0.1::5000", "registry:2")
    port = sh("docker", "port", REG, "5000/tcp").splitlines()[0].rsplit(":", 1)[1]
    REGHOST = f"127.0.0.1:{port}"
    for _ in range(50):
        if subprocess.run(["docker", "exec", REG, "wget", "-qO-", "http://127.0.0.1:5000/v2/"],
                          capture_output=True).returncode == 0:
            break
        time.sleep(0.2)
    DOCKERFILE = """FROM busybox:1.36.1
ARG BODY
RUN mkdir /www && echo "$BODY" > /www/index.html
HEALTHCHECK --interval=2s --timeout=2s --retries=20 CMD wget -qO /dev/null http://127.0.0.1:8080/ || exit 1
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
"""
    env = {**os.environ, "BUILDX_NO_DEFAULT_ATTESTATIONS": "1"}
    for name, ver, body in (("web", "1.0.0", "web 1.0.0"), ("web", "1.0.1", "web 1.0.1"),
                            ("web", "1.0.2", "BROKEN but healthy"), ("web", "1.0.3", "web 1.0.3"),
                            ("web2", "2.0.0", "web2 2.0.0"), ("web2", "2.0.1", "web2 2.0.1")):
        ref = f"{REGHOST}/{P1}/{name}:{ver}"
        p = subprocess.run(["docker", "build", "-q", "-t", ref, "--build-arg", f"BODY={body}", "-"],
                           input=DOCKERFILE, capture_output=True, text=True, env=env)
        if p.returncode != 0:
            raise RuntimeError(f"build {ref}: {p.stderr[-500:]}")
        sh("docker", "push", "-q", ref)
        built.append(ref)

    # ── the repo, as main would carry it ────────────────────────────────────
    ORIGIN, REPO = os.path.join(TMP, "origin.git"), os.path.join(TMP, "repo")
    GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]
    sh("git", "init", "-q", "--bare", "-b", "main", ORIGIN)
    sh("git", "clone", "-q", ORIGIN, REPO)
    sh(*GIT, "checkout", "-q", "-b", "main", cwd=REPO)

    def compose(web: str, web2: str) -> None:
        with open(os.path.join(REPO, "compose.yml"), "w") as fh:
            fh.write(f"name: {P1}\nservices:\n  web:\n    image: {REGHOST}/{P1}/web:{web}   # the pin\n"
                     f"    container_name: {C1}\n")
        with open(os.path.join(REPO, "compose2.yml"), "w") as fh:
            fh.write(f"name: {P2}\nservices:\n  web2:\n    image: {REGHOST}/{P1}/web2:{web2}\n"
                     f"    container_name: {C2}\n")

    def merge(msg: str) -> None:
        """A PR merged on main: commit, push. The box's checkout has it."""
        sh(*GIT, "add", "-A", cwd=REPO)
        sh(*GIT, "commit", "-q", "-m", msg, cwd=REPO)
        sh(*GIT, "push", "-q", "origin", "main", cwd=REPO)

    compose("1.0.0", "2.0.0")
    with open(os.path.join(REPO, "justfile"), "w") as fh:
        fh.write("up-web:\n    docker compose -f compose.yml up -d --wait --wait-timeout 60\n\n"
                 "up-web2:\n    docker compose -f compose2.yml up -d --wait --wait-timeout 60\n")
    comp_tpl = """
[components.{id}]
title = "{id}"
class = "stateless"
source = "image"
pins = ["{file}:{id}"]
apply = "just up-{id}"
dependants = []
changelog = "https://example.invalid/{id}/v{{version}}"
channel = "auto"
one_way = false
verify = ["the body names the version"]
"""
    with open(os.path.join(REPO, "updates.toml"), "w") as fh:
        fh.write('[policy]\nwindow_start = "03:30"\nwindow_end = "05:00"\nrequire_backup = "stacks-backup.service"\n'
                 "require_doctor = true\nmax_auto_per_night = 1\npause_on_failure = true\ndiscover_every_hours = 6\n"
                 + comp_tpl.format(id="web", file="compose.yml") + comp_tpl.format(id="web2", file="compose2.yml"))
    merge("the stack")

    D = {"repo": REPO, "catalog": os.path.join(REPO, "updates.toml"), "state": os.path.join(TMP, "state"),
         "backups": os.path.join(TMP, "backups"), "textfile": os.path.join(TMP, "textfile")}
    CFGFILE = os.path.join(TMP, "cfg.json")
    json.dump(D, open(CFGFILE, "w"))
    cfg = make_cfg(D)
    os.makedirs(cfg.spool, mode=0o700)
    os.makedirs(os.path.join(cfg.backups, "postgres"))
    BK = os.path.join(cfg.backups, "postgres", "pg-test.sql.gz")
    open(BK, "w").write("a backup")

    sh("just", "up-web", cwd=REPO)
    sh("just", "up-web2", cwd=REPO)
    catalog = updates.load(cfg.catalog)

    def discover() -> None:
        net = du.Net({}, registries={REGHOST: f"http://{REGHOST}"}, hub=None, use_cache=False)
        doc = du.Discoverer(catalog, net, repo=REPO).run()
        du.write(doc, cfg.state, None)
        plans.write_all(cfg, catalog, doc)

    # bothy-ops' own request code, pointed at this state dir.
    updates.CATALOG = catalog
    updates.AVAILABLE_FILE = cfg.available
    updates.UPDATES_DIR = cfg.state
    updates.SPOOL_DIR = cfg.spool

    class H:
        def __init__(self, body: dict) -> None:
            self.body = body

        def read_json_object(self, _max: int) -> dict:
            return self.body

    def request(cid: str, confirm: object = True) -> str:
        doc = plans.read_plan(cfg, cid)
        assert doc and doc["ok"], f"no plan for {cid}: {doc}"
        out, _ = updates.request_update(H({"component": cid, "plan_id": doc["plan"]["id"], "confirm": confirm}),
                                        "operator@example.com")
        return out["jobId"]

    def worker() -> subprocess.Popen:
        return subprocess.Popen([sys.executable, os.path.abspath(__file__), "--worker", CFGFILE],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def job(jid: str) -> dict:
        return next((h for h in record.history(cfg, 100) if h["id"] == jid), {})

    def running_image(c: str) -> str:
        return (hostio.container(c) or {}).get("image") or ""

    def body(c: str) -> str:
        st, b = canaries.probe(canaries.Ctx(cfg, c), "http://127.0.0.1:8080/")
        return b.strip()

    # ── 1. pre-flight refusal ───────────────────────────────────────────────
    print("── 1. pre-flight refusal: the backup is two days old ────────────", flush=True)
    compose("1.0.1", "2.0.0")
    merge("bump web to 1.0.1 (a Dependabot PR)")
    discover()
    p = plans.read_plan(cfg, "web")
    ok(p["ok"] and p["plan"]["from"]["image"].endswith(":1.0.0") and p["plan"]["to"]["image"].endswith(":1.0.1")
       and p["plan"]["to"]["digest"], "discovery pre-computed a plan 1.0.0 -> 1.0.1 with the registry's digest")
    ok(not plans.read_plan(cfg, "web2")["ok"] and "nothing to deploy" in plans.read_plan(cfg, "web2")["reason"],
       "web2 runs what main pins: no plan, and the reason says so")
    old = time.time() - 2 * 86400
    os.utime(BK, (old, old))
    j1 = request("web")
    ok(os.path.exists(os.path.join(cfg.spool, f"{j1}.json")), "bothy-ops wrote exactly one spool file")
    w = worker()
    out = w.communicate(timeout=300)[0]
    r = job(j1)
    ok(r.get("state") == "refused" and "backup" in (r.get("error") or ""), f"refused at pre-flight: {r.get('error')}")
    ok(running_image(C1).endswith(":1.0.0"), "nothing was touched: still 1.0.0")
    ok(not os.path.isdir(cfg.snapshots) or not os.listdir(cfg.snapshots), "no snapshot was taken")
    ok(os.listdir(cfg.spool) == [], "the request was claimed")

    # ── 2. success ──────────────────────────────────────────────────────────
    print("── 2. success: 1.0.0 -> 1.0.1 ───────────────────────────────────", flush=True)
    os.utime(BK, None)
    j2 = request("web")
    out = worker().communicate(timeout=300)[0]
    r = job(j2)
    ok(r.get("state") == "succeeded", f"succeeded ({r.get('state')}: {r.get('error')}) {out[-300:]}")
    ok(running_image(C1).endswith(":1.0.1") and body(C1) == "web 1.0.1", f"it runs 1.0.1 and says so: {body(C1)!r}")
    ok(sh("git", "status", "--porcelain", cwd=REPO) == "", "the tree is clean - main already pinned it")
    snaps = sorted(os.listdir(cfg.snapshots))
    sd = os.path.join(cfg.snapshots, snaps[-1]) if snaps else ""
    ok(len(snaps) == 1 and re.fullmatch(r"\d{8}T\d{6}Z-web", snaps[0]) and
       oct(os.stat(sd).st_mode & 0o777) == "0o700" and
       {"plan.json", "pin.json", "compose.yml"} <= set(os.listdir(sd)), f"a 700 snapshot with the pin: {snaps}")
    pin = json.load(open(os.path.join(sd, "pin.json")))
    ok(pin["oldImage"].endswith(":1.0.0") and pin["oldImageId"].startswith("sha256:"), "the snapshot names the old image")
    st = hostio.read_json(cfg.status_file)["job"]
    ok([s["name"] for s in st["steps"] if s["state"] == "ok"] ==
       ["validate", "preflight", "snapshot", "pull", "apply", "verify", "record"], "status.json: every step ok, in order")
    prom = open(os.path.join(cfg.textfile, "bothy_updater.prom")).read()
    ok('bothy_update_last_result{component="web",result="succeeded"} 1' in prom, "the metric says succeeded")

    # ── 3. verify fails on the body -> rollback ─────────────────────────────
    print("── 3. rollback: 1.0.2 is healthy, but its body is wrong ─────────", flush=True)
    compose("1.0.2", "2.0.0")
    merge("bump web to 1.0.2")
    discover()
    j3 = request("web")
    out = worker().communicate(timeout=400)[0]
    r = job(j3)
    ok(r.get("state") == "rolled_back" and r.get("failedStep") == "verify",
       f"rolled back after verify failed: {r.get('state')} / {r.get('failedStep')}: {r.get('error')}")
    ok("body says" in (r.get("error") or "") and "BROKEN" in (r.get("error") or ""),
       "the canary read the BODY (the container was healthy)")
    ok(running_image(C1).endswith(":1.0.1") and body(C1) == "web 1.0.1", "1.0.1 runs again, and says so")
    diff = sh("git", "diff", "-U0", "compose.yml", cwd=REPO)
    ok(sh("git", "diff", "--numstat", cwd=REPO).startswith("1\t1\tcompose.yml") and "-    image:" in diff
       and ":1.0.1   # the pin" in diff, "exactly the pin line went back to 1.0.1, comment kept, uncommitted")
    ok("now pins" in (r.get("note") or "") and "git checkout -- compose.yml" in (r.get("note") or ""),
       "the note says what was left and how to undo it")
    discover()
    ok("local changes" in (plans.read_plan(cfg, "web")["reason"] or ""), "the plan now refuses until a person decides")
    sh("git", "checkout", "-q", "--", "compose.yml", cwd=REPO)

    # ── 4. concurrency ──────────────────────────────────────────────────────
    print("── 4. concurrency: two requests, two executors ──────────────────", flush=True)
    compose("1.0.3", "2.0.1")
    merge("bump web to 1.0.3 and web2 to 2.0.1")
    discover()
    ja, jb = request("web"), request("web2")
    wa, wb = worker(), worker()
    oa, ob = wa.communicate(timeout=600)[0], wb.communicate(timeout=600)[0]
    ra, rb = job(ja), job(jb)
    ok(ra.get("state") == "succeeded" and rb.get("state") == "succeeded",
       f"both succeeded: {ra.get('state')} {ra.get('error')} / {rb.get('state')} {rb.get('error')}")
    ok(("holds the lock" in oa) != ("holds the lock" in ob), f"exactly one executor found the lock held: {oa!r} {ob!r}")
    first, second = sorted((ra, rb), key=lambda x: x["startedAt"])
    ok(second["startedAt"] >= first["endedAt"], f"one at a time: {first['endedAt']} <= {second['startedAt']}")
    audit = [ln.split("\t") for ln in open(cfg.audit_file).read().splitlines()]
    seq = [f[1] for f in audit if f[1] in (ja, jb)]
    ok(seq == sorted(seq, key=lambda x: seq.index(x)) and len({x for x in seq}) == 2 and
       seq.index(second["id"]) > len(seq) - 1 - seq[::-1].index(first["id"]),
       "the audit log never interleaves the two jobs")
    ok(body(C1) == "web 1.0.3" and body(C2) == "web2 2.0.1", "both run what main pins")

    # ── 5. the time-series class: its snapshot and its restore ──────────────
    print("── 5. time-series snapshot and restore, on throwaway VM and Loki ─", flush=True)
    from updater import classes
    ts = classes.CLASSES["timeseries"]
    # Named volumes, like the live services: a restore unpacks into the volume
    # through --volumes-from, which sees nothing of a container's own rootfs.
    sh("docker", "run", "-d", "--name", VM, "-v", f"{VM}:/victoria-metrics-data",
       "victoriametrics/victoria-metrics:v1.152.0",
       "-storageDataPath=/victoria-metrics-data", "-selfScrapeInterval=1s")
    sh("docker", "run", "-d", "--name", LOKI, "-v", f"{LOKI}:/loki", "grafana/loki:3.7.7")
    time.sleep(8)
    sdir = tempfile.mkdtemp(prefix="snap-", dir=TMP)
    art, detail = ts.take_snapshot(cfg, "victoriametrics", VM, sdir)
    ok(art and art.endswith("vm.tar") and os.path.getsize(art) > 1000,
       f"bk_snapshot_vm (via scripts/snapshot.sh) wrote a tar: {detail}")
    rok, rdetail = ts.restore(cfg, "victoriametrics", VM, art) if art else (False, "no artefact")
    ok(rok and "holds" in rdetail, f"scripts/restore.sh put it back and verified series: {rdetail[-160:]}")
    for _ in range(60):
        if canaries.probe(canaries.Ctx(cfg, LOKI), "http://127.0.0.1:3100/ready")[1].strip() == "ready":
            break
        time.sleep(1)
    push = ('import json,time,urllib.request; b=json.dumps({"streams":[{"stream":{"container":"t"},'
            '"values":[[str(time.time_ns()),"a line from the updater test"]]}]}).encode(); '
            'urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:3100/loki/api/v1/push",'
            'data=b,headers={"Content-Type":"application/json"}))')
    sh("docker", "run", "--rm", "--network", f"container:{LOKI}", cfg.helper_image, "python3", "-c", push)
    art, detail = ts.take_snapshot(cfg, "loki", LOKI, sdir)
    ok(art and art.endswith("loki.tar.gz") and os.path.getsize(art) > 1000,
       f"bk_snapshot_loki (flush, stop, tar, start) wrote a tar: {detail}")
    ok((hostio.container(LOKI) or {}).get("state") == "running", "Loki was started again after the tar")
    rok, rdetail = ts.restore(cfg, "loki", LOKI, art) if art else (False, "no artefact")
    ok(rok and "answers labels" in rdetail, f"scripts/restore.sh put Loki back and read its labels: {rdetail[-160:]}")
    ok(ts.take_snapshot(cfg, "loki", LOKI, sdir)[0] is None, "a snapshot never overwrites an existing file")
    # ══ 6-7: the ONE-WAY class (app-db), on throwaway Grafana and Keycloak ══════
    import yaml

    from updater import classes

    def have_image(ref: str) -> bool:
        return subprocess.run(["docker", "image", "inspect", ref], capture_output=True).returncode == 0

    PG_IMG = next(ln.split("image:", 1)[1].strip() for ln in open(os.path.join(updater.config.REPO, "data",
                  "postgres", "compose.yml")) if ln.strip().startswith("image: postgres:"))
    for ref in (GF_OLD, GF_NEW, KC_OLD, KC_NEW, O2P_IMG, PG_IMG, VM_IMG):
        if not have_image(ref):
            sh("docker", "pull", "-q", ref)
            pulled.append(ref)
    sh("docker", "network", "create", NET)

    def add_available(cid: str, ref: str) -> None:
        """What discovery would record for `ref` - from the image the test pulled,
        so the plan's digest is the one `docker pull` will find (the executor checks)."""
        s = du.split_image(ref)
        doc = hostio.read_json(cfg.available)
        doc["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        doc["components"][cid] = {"image": s["ref"], "current": {
            "tag": s["tag"], "float": False, "resolved": hostio.repo_digest(hostio.image(ref), s["ref"])}}
        hostio.write_json(cfg.available, doc)
        plans.write_all(cfg, catalog, doc)

    def steps_of(jid: str) -> dict:
        st = hostio.read_json(cfg.status_file)["job"]
        return {s["name"]: s["state"] for s in st["steps"]} if st["id"] == jid else {}

    APPDB_TPL = """
[components.{id}]
title = "{id}"
class = "app-db"
source = "image"
pins = [{pins}]
apply = "just {recipe}"
dependants = []
changelog = "https://example.invalid/{id}/{{version}}"
channel = "{channel}"
one_way = true
one_way_why = "its database migrates on first start and the old version cannot read it"
verify = ["the canaries"]
"""
    with open(os.path.join(REPO, "updates.toml"), "a") as fh:
        fh.write(APPDB_TPL.format(id="grafana", pins='"mon.yml:grafana"', recipe="up-mon", channel="notify"))
        fh.write(APPDB_TPL.format(id="keycloak", pins='"auth.yml:keycloak", "auth.yml:keycloak-init"',
                                  recipe="up-auth", channel="manual"))
    with open(os.path.join(REPO, ".env"), "w") as fh:
        fh.write(f"GRAFANA_USER=admin\nGRAFANA_PASSWORD={GF_PASS}\nPOSTGRES_USER=dev\nPOSTGRES_PASSWORD={PG_PASS}\n"
                 f"DEV_LOGIN_USER={LOGIN_USER}\nDEV_LOGIN_PASSWORD={LOGIN_PASS}\n")
    with open(os.path.join(REPO, ".gitignore"), "w") as fh:
        fh.write(".env\napps/\n")
    with open(os.path.join(REPO, "justfile"), "a") as fh:
        fh.write("\nup-mon:\n    docker compose -f mon.yml up -d --wait --wait-timeout 240\n\n"
                 "up-auth:\n    #!/usr/bin/env bash\n    set -euo pipefail\n"
                 "    svcs=$(docker compose -f auth.yml config --services | grep -vx keycloak-init)\n"
                 "    docker compose -f auth.yml up -d --wait --wait-timeout 400 $svcs\n"
                 "    docker compose -f auth.yml up -d --no-deps keycloak-init\n"
                 f"    rc=$(docker wait {KCI})\n"
                 "    [ \"$rc\" = 0 ] || { echo \"keycloak-init exited $rc\" >&2; exit 1; }\n")
    os.makedirs(os.path.join(cfg.backups, "grafana"))
    open(os.path.join(cfg.backups, "grafana", "grafana-test.db"), "w").write("a backup")
    os.utime(BK, None)

    # ── 6. Grafana ──────────────────────────────────────────────────────────
    print("── 6. app-db: Grafana - snapshot, forced failure, restore, update ─", flush=True)
    sh("docker", "run", "-d", "--name", GFVM, "--network", NET, VM_IMG, "-selfScrapeInterval=5s")
    os.makedirs(os.path.join(REPO, "gf-provisioning", "datasources"))
    with open(os.path.join(REPO, "gf-provisioning", "datasources", "ds.yml"), "w") as fh:
        fh.write(f"apiVersion: 1\ndatasources:\n  - name: Prometheus\n    type: prometheus\n    uid: prometheus\n"
                 f"    access: proxy\n    url: http://{GFVM}:8428\n")

    def mon(image: str) -> None:
        with open(os.path.join(REPO, "mon.yml"), "w") as fh:
            fh.write(f"""name: {P3}
services:
  grafana:
    image: {image}   # the pin
    container_name: {GF}
    environment:
      GF_SECURITY_ADMIN_USER: ${{GRAFANA_USER}}
      GF_SECURITY_ADMIN_PASSWORD: ${{GRAFANA_PASSWORD}}
      GF_ANALYTICS_REPORTING_ENABLED: "false"
      GF_ANALYTICS_CHECK_FOR_UPDATES: "false"
      GF_PLUGINS_PREINSTALL_DISABLED: "true"
    volumes:
      - ./gf-provisioning:/etc/grafana/provisioning:ro
      - grafana_data:/var/lib/grafana
    healthcheck:
      test: ["CMD", "wget", "-qO", "/dev/null", "-T", "3", "http://127.0.0.1:3000/api/health"]
      interval: 2s
      timeout: 3s
      retries: 90
    networks: [testnet]
volumes:
  grafana_data:
networks:
  testnet:
    external: true
    name: {NET}
""")

    mon(GF_OLD)
    merge("the app-db stand-ins: grafana on 13.1.4")
    catalog = updates.load(cfg.catalog)
    updates.CATALOG = catalog
    sh("just", "up-mon", cwd=REPO)
    gctx = canaries.Ctx(cfg, GF)
    for uid in ("e2e-before-a", "e2e-before-b"):
        st, _ = _gf_api(gctx, "POST", "/api/dashboards/db", _gf_dashboard(uid))
        ok(st == 200, f"made dashboard {uid} in the UI's way (the API) before the update ({st})")

    def gf_uids() -> set:
        st, b = _gf_api(gctx, "GET", "/api/search?type=dash-db")
        try:
            return {d["uid"] for d in json.loads(b)} if st == 200 else set()
        except ValueError:
            return set()

    def gf_version() -> str:
        st, b = canaries.probe(gctx, "http://127.0.0.1:3000/api/health")
        return (json.loads(b).get("version") if st == 200 else "") or ""

    mon(GF_NEW)
    merge("bump grafana to 13.2.2 (a Dependabot PR)")
    add_available("grafana", GF_NEW)
    gp = plans.read_plan(cfg, "grafana")
    ok(gp["ok"] and gp["plan"]["confirm"] == "type-name" and gp["plan"]["oneWay"] and
       gp["plan"]["snapshot"]["kind"] == "grafana", f"a one-way plan 13.1.4 -> 13.2.2: {gp.get('reason')}")
    try:
        request("grafana", True)
        ok(False, "bothy-ops refuses a click on a one-way plan (ACCEPTED)")
    except Exception as e:  # noqa: BLE001
        ok("type the component's id" in str(e) and os.listdir(cfg.spool) == [],
           f"bothy-ops refuses a click on a one-way plan, no spool file ({e})")

    open(_flag("grafana"), "w").close()
    jg1 = request("grafana", "grafana")
    out = worker().communicate(timeout=900)[0]
    r = job(jg1)
    ok(r.get("state") == "rolled_back" and r.get("failedStep") == "verify" and "FORCED" in (r.get("error") or ""),
       f"the forced failure rolled back: {r.get('state')} / {r.get('failedStep')}: {r.get('error')} {out[-300:]}")
    stp = steps_of(jg1)
    ok(stp.get("snapshot") == "ok" and stp.get("restore") == "ok" and stp.get("rollback") == "ok",
       f"snapshot, restore AND rollback ran: {stp}")
    snaps = [n for n in sorted(os.listdir(cfg.snapshots)) if n.endswith("-grafana")]
    sd = os.path.join(cfg.snapshots, snaps[-1]) if snaps else ""
    ok(sd and {"grafana-data.tar.gz", "app-db.json", "pin.json"} <= set(os.listdir(sd)),
       f"the snapshot holds the volume tar: {os.listdir(sd) if sd else None}")
    ok(running_image(GF) == GF_OLD and gf_version() == "13.1.4", f"13.1.4 runs again: {gf_version()}")
    uids = gf_uids()
    ok({"e2e-before-a", "e2e-before-b"} <= uids and "e2e-after" not in uids,
       f"the dashboards made before the update are back, the one made after is gone: {sorted(uids)}")
    ok(sh("git", "diff", "--numstat", cwd=REPO).startswith("1\t1\tmon.yml"), "the pin line went back (uncommitted)")
    sh("git", "checkout", "-q", "--", "mon.yml", cwd=REPO)
    os.unlink(_flag("grafana"))

    add_available("grafana", GF_NEW)
    jg2 = request("grafana", "grafana")
    out = worker().communicate(timeout=900)[0]
    r = job(jg2)
    ok(r.get("state") == "succeeded", f"then the update succeeds: {r.get('state')}: {r.get('error')} {out[-300:]}")
    ok(running_image(GF) == GF_NEW and gf_version() == "13.2.2", f"13.2.2 runs, and says so: {gf_version()}")
    ok({"e2e-before-a", "e2e-before-b"} <= gf_uids(), "the dashboards survived the migration")

    # ── 7. Keycloak ─────────────────────────────────────────────────────────
    print("── 7. app-db: Keycloak - pg_dump, two pins, forced failure, restore ─", flush=True)
    sh("docker", "run", "-d", "--name", KPG, "--network", NET, "-e", "POSTGRES_USER=dev", "-e",
       f"POSTGRES_PASSWORD={PG_PASS}", "-e", "POSTGRES_DB=dev", PG_IMG)
    for _ in range(60):
        if subprocess.run(["docker", "exec", KPG, "pg_isready", "-q", "-U", "dev"]).returncode == 0:
            break
        time.sleep(1)
    time.sleep(2)
    sh("docker", "exec", KPG, "psql", "-U", "dev", "-d", "dev", "-v", "ON_ERROR_STOP=1",
       "-c", "CREATE ROLE keycloak LOGIN PASSWORD 'e2e-kcdb'", "-c", "CREATE DATABASE keycloak OWNER keycloak")

    live = yaml.safe_load(open(os.path.join(updater.config.REPO, "auth", "compose.yml")))["services"]

    def auth(image: str) -> None:
        doc = {"name": P4, "services": {
            "keycloak": {
                "image": image, "container_name": KC, "command": ["start-dev", "--import-realm"],
                "environment": {
                    "KC_DB": "postgres", "KC_DB_URL": f"jdbc:postgresql://{KPG}:5432/keycloak",
                    "KC_DB_USERNAME": "keycloak", "KC_DB_PASSWORD": "e2e-kcdb",
                    "KC_HOSTNAME": f"http://{KC}:8080", "KC_HTTP_ENABLED": "true", "KC_HEALTH_ENABLED": "true",
                    "KC_BOOTSTRAP_ADMIN_USERNAME": "admin", "KC_BOOTSTRAP_ADMIN_PASSWORD": "${DEV_LOGIN_PASSWORD}",
                    "DEVBOX_OAUTH2_CLIENT_SECRET": "e2e-oauth2-client-secret",
                    "DEVBOX_OAUTH2_REDIRECT_URI": "http://127.0.0.1:4180/oauth2/callback",
                    "DEVBOX_HEADLAMP_REDIRECT_URI": "http://127.0.0.1:8110/oauth2/callback"},
                # The LIVE realm, imported - so the canaries meet the real clients and role mappers.
                "volumes": [os.path.join(updater.config.REPO, "auth", "realm-devbox.json")
                            + ":/opt/keycloak/data/import/realm-devbox.json:ro"],
                "healthcheck": {**live["keycloak"]["healthcheck"], "interval": "3s", "start_period": "120s",
                                "retries": 100},
                "networks": {"testnet": {"aliases": ["keycloak"]}}},
            # The LIVE keycloak-init script, verbatim: it logs in to http://keycloak:8080 (the
            # alias above) and seeds DEV_LOGIN_USER with viewer, editor and operator.
            "keycloak-init": {
                "image": image, "container_name": KCI, "restart": "no",
                "depends_on": {"keycloak": {"condition": "service_healthy"}},
                "environment": {"KC_ADMIN_USER": "admin", "KC_ADMIN_PASSWORD": "${DEV_LOGIN_PASSWORD}",
                                "DEV_LOGIN_USER": "${DEV_LOGIN_USER}", "DEV_LOGIN_PASSWORD": "${DEV_LOGIN_PASSWORD}"},
                "entrypoint": live["keycloak-init"]["entrypoint"], "command": live["keycloak-init"]["command"],
                "networks": ["testnet"]},
            "oauth2-proxy": {
                "image": O2P_IMG, "container_name": O2P, "restart": "unless-stopped",
                "depends_on": {"keycloak": {"condition": "service_healthy"}},
                "command": ["--provider=oidc", f"--oidc-issuer-url=http://{KC}:8080/realms/devbox",
                            "--client-id=oauth2-proxy", "--http-address=0.0.0.0:4180", "--email-domain=*",
                            "--code-challenge-method=S256", "--scope=openid email profile",
                            "--insecure-oidc-allow-unverified-email=true",
                            "--redirect-url=http://127.0.0.1:4180/oauth2/callback", "--cookie-secure=false",
                            "--cookie-samesite=lax", "--upstream=static://202", "--set-xauthrequest=true"],
                # Throwaway values for a throwaway proxy. The client secret MUST equal
                # DEVBOX_OAUTH2_CLIENT_SECRET above (the realm's), or the callback 500s.
                # The cookie secret is built, not a literal, so gitleaks has nothing to flag.
                "environment": {"OAUTH2_PROXY_CLIENT_SECRET": "e2e-oauth2-client-secret",
                                "OAUTH2_PROXY_COOKIE_SECRET": bytes(range(16)).hex()},
                "networks": ["testnet"]}},
            "networks": {"testnet": {"external": True, "name": NET}}}
        with open(os.path.join(REPO, "auth.yml"), "w") as fh:
            yaml.safe_dump(doc, fh, sort_keys=False, width=400)

    auth(KC_OLD)
    merge("the keycloak stand-in on 26.7.3-0")
    catalog = updates.load(cfg.catalog)
    updates.CATALOG = catalog
    t0 = time.monotonic()
    sh("just", "up-auth", cwd=REPO)
    print(f"  (keycloak stand-in up in {int(time.monotonic() - t0)}s)", flush=True)
    secret = "e2e-admin-client-" + "5" * 20
    rc, o = kcadm("create", "clients", "-r", "devbox", "-s", "clientId=bothy-admin", "-s", "publicClient=false",
                  "-s", "serviceAccountsEnabled=true", "-s", "standardFlowEnabled=false", "-s", f"secret={secret}")
    os.makedirs(os.path.join(REPO, "apps", "bothy-ops", "secrets"), mode=0o700)
    with open(os.path.join(REPO, canaries.ADMIN_SECRET), "w") as fh:
        fh.write(secret)
    rc2, o2 = kcadm("create", "clients", "-r", "devbox", "-s", "clientId=e2e-before")
    ok(rc == 0 and rc2 == 0 and kc_client("e2e-before"), f"bothy-admin and a client e2e-before exist before the update {o2}")

    auth(KC_NEW)
    merge("bump keycloak AND keycloak-init to 26.7.4-0")
    add_available("keycloak", KC_NEW)
    kp = plans.read_plan(cfg, "keycloak")
    ok(kp["ok"] and [q["service"] for q in kp["plan"]["pins"]] == ["keycloak", "keycloak-init"]
       and kp["plan"]["confirm"] == "type-name", f"a one-way plan over BOTH pins: {kp.get('reason')}")

    open(_flag("keycloak"), "w").close()
    jk1 = request("keycloak", "keycloak")
    out = worker().communicate(timeout=1200)[0]
    r = job(jk1)
    ok(r.get("state") == "rolled_back" and r.get("failedStep") == "verify" and "FORCED" in (r.get("error") or ""),
       f"the forced failure rolled back: {r.get('state')} / {r.get('failedStep')}: {r.get('error')} {out[-300:]}")
    stp = steps_of(jk1)
    ok(stp.get("preflight") == "ok" and stp.get("snapshot") == "ok" and stp.get("restore") == "ok"
       and stp.get("rollback") == "ok", f"pre-flight (all canaries green), dump, restore, rollback: {stp}")
    snaps = [n for n in sorted(os.listdir(cfg.snapshots)) if n.endswith("-keycloak")]
    sd = os.path.join(cfg.snapshots, snaps[-1]) if snaps else ""
    ok(sd and "keycloak.dump" in os.listdir(sd) and os.path.getsize(os.path.join(sd, "keycloak.dump")) > 10000,
       f"the snapshot holds the pg_dump -Fc: {os.listdir(sd) if sd else None}")
    ok(running_image(KC) == KC_OLD and running_image(KCI) == KC_OLD, "keycloak AND keycloak-init are on 26.7.3-0 again")
    ok(kc_client("e2e-before") and not kc_client("e2e-after"),
       "the client made before the update is back, the one made after is gone (the dump was restored)")
    ok(sh("git", "diff", "--numstat", cwd=REPO).startswith("2\t2\tauth.yml"),
       "BOTH pin lines went back (two lines, uncommitted)")
    sh("git", "checkout", "-q", "--", "auth.yml", cwd=REPO)
    os.unlink(_flag("keycloak"))

    add_available("keycloak", KC_NEW)
    jk2 = request("keycloak", "keycloak")
    out = worker().communicate(timeout=1200)[0]
    r = job(jk2)
    ok(r.get("state") == "succeeded", f"then the update succeeds: {r.get('state')}: {r.get('error')} {out[-300:]}")
    ok(running_image(KC) == KC_NEW and running_image(KCI) == KC_NEW and kc_client("e2e-before"),
       "26.7.4-0 runs in both, and the realm's clients survived the migration")
    vd = [s for s in hostio.read_json(cfg.status_file)["job"]["steps"] if s["name"] == "verify"][0]["detail"] or ""
    ok("canaries green" in vd, f"verify: {vd}")
finally:
    cleanup()
    for ref in built:
        subprocess.run(["docker", "rmi", "-f", ref], capture_output=True)
    for ref in pulled:
        subprocess.run(["docker", "rmi", ref], capture_output=True)
    shutil.rmtree(TMP, ignore_errors=True)

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("updater end to end: all passed")
