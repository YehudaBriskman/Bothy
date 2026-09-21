#!/usr/bin/env python3
"""The automatic channel END TO END, against a THROWAWAY compose project. Needs docker.

Run: python3 checks/e2e_auto.py              (about two minutes)

NEVER the live stack. Like e2e_updater.py, everything is its own: a registry
(`bothy-auto-test-registry`, 127.0.0.1, random port) holding busybox images whose
BODY names their version, two projects (`-p bothy-auto-test`, `-p bothy-auto-test2`),
a git repo with a bare origin, and temporary state, backups and textfile dirs.

It drives the REAL pieces: auto.decide() with only the clock and `systemctl show`
replaced (a fake night, a fake successful stacks-backup.service), the real
plans.write_all() and the real narrow doctor (docker inspect + body canaries); the
spool file it writes is run by the executor as a separate process, exactly as
bothy-updater.path would; unpause goes through bothy-ops' own request_unpause().

  NIGHT 1  web 1.0.0 runs, main pins 1.0.1: the night job picks it (web2 runs
           what main pins), the executor applies it -> succeeded, recorded with
           the actor `auto`; a second run that night does nothing more
  NIGHT 2  main pins 1.0.2 - healthy but the WRONG BODY: the night job picks it,
           the canary fails, the executor rolls back -> rolled_back, and web is
           PAUSED (auto.json, bothy_update_paused 1); a rerun that night stops
           ("first failure")
  NIGHT 3  the rollback's pin line is resolved (git checkout), so web has a
           deployable plan again - and it is SKIPPED because it is paused; web2's
           new patch is picked and applied instead
  UNPAUSE  bothy-ops' request_unpause() writes the spool file, the executor's loop
           clears the pause; the next night web is a candidate again
"""
import datetime as dt
import json
import os
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
from updater import auto, canaries, executor, hostio, record  # noqa: E402
from updater.config import Config  # noqa: E402

P1, P2 = "bothy-auto-test", "bothy-auto-test2"
C1, C2 = f"{P1}-web", f"{P2}-web2"
REG = f"{P1}-registry"


def test_canaries() -> dict:
    return {
        "web": [canaries.body_matches("http://127.0.0.1:8080/", r"^web \d+\.\d+\.\d+$", "the body says `web <version>`")],
        "web2": [canaries.body_matches("http://127.0.0.1:8080/", r"^web2 \d+\.\d+\.\d+$", "the body says `web2 <version>`")],
    }


def make_cfg(d: dict) -> Config:
    return Config(repo=d["repo"], catalog=d["catalog"], state=d["state"], backups=d["backups"],
                  textfile=d["textfile"], verify_timeout=60, min_free_bytes=1 << 20, canaries=test_canaries())


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
    for proj in (P1, P2):
        subprocess.run(["docker", "compose", "-p", proj, "down", "-v", "--remove-orphans"], capture_output=True)
    subprocess.run(["docker", "rm", "-f", C1, C2, REG], capture_output=True)


if shutil.which("docker") is None or subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
    print("SKIP: no docker daemon")
    sys.exit(0)
if shutil.which("just") is None:
    print("SKIP: no `just` on PATH")
    sys.exit(0)

cleanup()
TMP = tempfile.mkdtemp(prefix="bothy-auto-e2e-")
built: list[str] = []
try:
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
                            ("web", "1.0.2", "BROKEN but healthy"),
                            ("web2", "2.0.0", "web2 2.0.0"), ("web2", "2.0.1", "web2 2.0.1")):
        ref = f"{REGHOST}/{P1}/{name}:{ver}"
        p = subprocess.run(["docker", "build", "-q", "-t", ref, "--build-arg", f"BODY={body}", "-"],
                           input=DOCKERFILE, capture_output=True, text=True, env=env)
        if p.returncode != 0:
            raise RuntimeError(f"build {ref}: {p.stderr[-500:]}")
        sh("docker", "push", "-q", ref)
        built.append(ref)

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
    DUMP = os.path.join(cfg.backups, "postgres", "pg-test.sql.gz")
    open(DUMP, "w").write("a backup")

    sh("just", "up-web", cwd=REPO)
    sh("just", "up-web2", cwd=REPO)
    catalog = updates.load(cfg.catalog)

    def discover() -> None:
        net = du.Net({}, registries={REGHOST: f"http://{REGHOST}"}, hub=None, use_cache=False)
        doc = du.Discoverer(catalog, net, repo=REPO).run()
        du.write(doc, cfg.state, None)

    # ── a fake night: the clock and `systemctl show` - nothing else ─────────
    today = dt.date.today()
    night = {"t": None}

    def at_night(n: int) -> None:
        d = today + dt.timedelta(days=n - 1)
        night["t"] = dt.datetime(d.year, d.month, d.day, 3, 31).astimezone()
        cut = night["t"].replace(hour=3, minute=0).timestamp()
        os.utime(DUMP, (cut + 180, cut + 180))  # tonight's dump, 03:03
        night["backup"] = {"LoadState": "loaded", "ActiveState": "inactive", "Result": "success",
                           "ExecMainStatus": "0", "ExecMainExitTimestamp": f"@{int(cut) + 240}"}

    ENV = auto.Env(now=lambda: night["t"], backup_props=lambda unit: dict(night["backup"]))

    def tonight() -> auto.Decision:
        return auto.decide(cfg, ENV, catalog)

    def worker() -> str:
        p = subprocess.run([sys.executable, os.path.abspath(__file__), "--worker", CFGFILE],
                           capture_output=True, text=True, timeout=600)
        return p.stdout + p.stderr

    def job(jid: str) -> dict:
        return next((h for h in record.history(cfg, 100) if h["id"] == jid), {})

    def body(c: str) -> str:
        return canaries.probe(canaries.Ctx(cfg, c), "http://127.0.0.1:8080/")[1].strip()

    def prom() -> str:
        return open(os.path.join(cfg.textfile, "bothy_updater_auto.prom")).read()

    # ── night 1 ─────────────────────────────────────────────────────────────
    print("── NIGHT 1: a patch picked, applied, as `auto` ───────────────────", flush=True)
    compose("1.0.1", "2.0.0")
    merge("bump web to 1.0.1 (a Dependabot PR)")
    discover()
    at_night(1)
    d = tonight()
    ok(d.outcome == "requested" and d.component == "web" and os.listdir(cfg.spool) == [f"{d.job}.json"],
       f"the night job requested web and nothing else: {d.outcome} {d.component} ({d.reason[:80]})")
    out = worker()
    r = job(d.job)
    ok(r.get("state") == "succeeded" and r.get("requestedBy") == "auto",
       f"the unchanged executor ran it -> succeeded, as `auto` ({r.get('state')}: {r.get('error')}) {out[-200:]}")
    ok(body(C1) == "web 1.0.1", f"web says 1.0.1 ({body(C1)!r})")
    st = hostio.read_json(cfg.status_file)["job"]
    ok(st["requestedBy"] == "auto", "status.json carries the actor")
    ok(any(ln.split("\t")[3] == "auto" and ln.split("\t")[1] == d.job for ln in open(cfg.audit_file).read().splitlines()),
       "audit.log: the executor's steps are audited as `auto`")
    d2 = tonight()
    ok(d2.outcome == "skipped" and "already 1" in d2.reason and os.listdir(cfg.spool) == [],
       f"a second run the same night does nothing ({d2.reason[:60]})")

    # ── night 2 ─────────────────────────────────────────────────────────────
    print("── NIGHT 2: a forced rollback pauses web ────────────────────────", flush=True)
    compose("1.0.2", "2.0.0")
    merge("bump web to 1.0.2 (healthy, wrong body)")
    discover()
    at_night(2)
    d = tonight()
    ok(d.outcome == "requested" and d.component == "web", f"the night job requested web 1.0.2 ({d.reason[:70]})")
    out = worker()
    r = job(d.job)
    ok(r.get("state") == "rolled_back" and r.get("failedStep") == "verify",
       f"verify failed on the body -> rolled_back ({r.get('state')}/{r.get('failedStep')})")
    ok(body(C1) == "web 1.0.1", "1.0.1 runs again")
    stt = auto.load_state(cfg)
    ok("web" in stt["paused"] and stt["paused"]["web"]["jobId"] == d.job and stt["paused"]["web"]["result"] == "rolled_back",
       f"web is PAUSED by the executor's own hook, with the job: {stt['paused'].get('web')}")
    ok('bothy_update_paused{component="web"} 1' in prom() and 'bothy_update_paused{component="web2"} 0' in prom(),
       "bothy_update_paused says so")
    prom_last = open(os.path.join(cfg.textfile, "bothy_updater.prom")).read()
    ok('bothy_update_last_result{component="web",result="rolled_back"} 1' in prom_last,
       "bothy_update_last_result says rolled_back (the update_failed alert's series)")
    d2 = tonight()
    ok(d2.outcome == "skipped" and "first failure" in d2.reason, f"a rerun that night stops ({d2.reason[:70]})")

    # ── night 3 ─────────────────────────────────────────────────────────────
    print("── NIGHT 3: the paused component is skipped ─────────────────────", flush=True)
    sh("git", "checkout", "-q", "--", "compose.yml", cwd=REPO)  # a person resolved the rollback's pin line
    compose("1.0.2", "2.0.1")
    merge("bump web2 to 2.0.1")
    discover()
    at_night(3)
    d = tonight()
    plan_web = json.load(open(os.path.join(cfg.plans, "web.json")))
    ok(plan_web.get("ok") is True, "web HAS a deployable plan again (1.0.1 -> 1.0.2)…")
    ok(d.outcome == "requested" and d.component == "web2" and any(c == "web" and "paused" in w for c, w in d.skipped),
       f"…and is skipped because it is paused; web2 is picked instead ({d.component}; {d.skipped})")
    worker()
    ok(job(d.job).get("state") == "succeeded" and body(C2) == "web2 2.0.1", "web2 2.0.1 applied")

    # ── unpause through bothy-ops and the spool ─────────────────────────────
    print("── UNPAUSE: bothy-ops asks, the host clears ─────────────────────", flush=True)
    updates.CATALOG = catalog
    updates.UPDATES_DIR = cfg.state
    updates.SPOOL_DIR = cfg.spool

    class H:
        def read_json_object(self, _max: int) -> dict:
            return {"component": "web"}

    res, _ = updates.request_unpause(H(), "operator@example.com")
    ok(os.listdir(cfg.spool) == [f"unpause-{res['id']}.json"], "bothy-ops wrote one unpause file")
    worker()
    stt = auto.load_state(cfg)
    ok("web" not in stt["paused"] and stt["unpaused"]["web"]["by"] == "operator@example.com" and os.listdir(cfg.spool) == [],
       "the executor's loop cleared the pause, as the operator")
    ok('bothy_update_paused{component="web"} 0' in prom(), "the metric follows")
    at_night(4)
    d = auto.decide(cfg, ENV, catalog, dry_run=True)
    ok(d.outcome == "requested" and d.component == "web", f"the next night web is a candidate again ({d.reason[:60]})")
finally:
    cleanup()
    for ref in built:
        subprocess.run(["docker", "rmi", "-f", ref], capture_output=True)
    shutil.rmtree(TMP, ignore_errors=True)

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("auto end to end: all passed")
