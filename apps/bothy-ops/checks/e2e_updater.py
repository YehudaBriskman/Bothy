#!/usr/bin/env python3
"""The host updater END TO END, against a THROWAWAY compose project. Needs docker.

Run: python3 checks/e2e_updater.py            (about two minutes)

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


def test_canaries() -> dict:
    return {
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
    for proj in (P1, P2):
        subprocess.run(["docker", "compose", "-p", proj, "down", "-v", "--remove-orphans"],
                       capture_output=True)
    subprocess.run(["docker", "rm", "-f", C1, C2, REG, VM, LOKI], capture_output=True)
    subprocess.run(["docker", "volume", "rm", "-f", LOKI, VM], capture_output=True)


if shutil.which("docker") is None or subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
    print("SKIP: no docker daemon")
    sys.exit(0)
if shutil.which("just") is None:
    print("SKIP: no `just` on PATH")
    sys.exit(0)

cleanup()
TMP = tempfile.mkdtemp(prefix="bothy-updater-e2e-")
built: list[str] = []
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

    def request(cid: str) -> str:
        doc = plans.read_plan(cfg, cid)
        assert doc and doc["ok"], f"no plan for {cid}: {doc}"
        out, _ = updates.request_update(H({"component": cid, "plan_id": doc["plan"]["id"], "confirm": True}),
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
finally:
    cleanup()
    for ref in built:
        subprocess.run(["docker", "rmi", "-f", ref], capture_output=True)
    shutil.rmtree(TMP, ignore_errors=True)

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("updater end to end: all passed")
