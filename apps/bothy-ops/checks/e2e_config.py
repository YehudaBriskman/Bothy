#!/usr/bin/env python3
"""A config value changed, and a real REVERT, END TO END. Needs docker.

Run: python3 checks/e2e_config.py            (about two minutes)

NEVER THE LIVE STACK. Everything here is its own: a compose project
`-p bothy-config-e2e` holding one busybox container built here, a bare "origin"
and a clone on main with their own compose file, justfile and updates.toml, and
temporary state, backup and textfile directories. All of it is removed in a
finally block.

THIS IS THE CHECK THAT PROVES THE DESIGN. Everything else about a config value is
a decision or a refusal, and a decision can be asserted statically. "The host
puts the value back by itself when the service does not come back healthy" cannot
be: it is a job, on a real container, with a real recipe and real canaries.

The container's body is its MODE, so a canary on the body (rule 7: bodies, never
status codes) sees the value that is actually in effect:

    MODE=fast|slow   the body says `mode <MODE>`, and the canary passes
    MODE=wrong       the body says something else - the container is HEALTHY and
                     only the canary catches it
    MODE=crash       the entrypoint exits 1, so the container never comes up

`wrong` and `crash` are both legal to the pattern on purpose. That is the real
case this exists for: a value nobody can refuse on sight, which the service turns
out not to accept. Each of them must end with the OLD value back in the file, the
tree clean, and the container healthy on it.

  1  THE ROWS         the editable key with its value and its bounded pattern,
                      and a locked key with its sentence and NO VALUE
  2  REFUSED EARLY    bothy-ops will not write a spool file for a value outside
                      the pattern, and the HOST refuses one anyway - including
                      the `auto` actor and a stale plan id
  3  SUCCESS          fast -> slow: exactly one line of the compose file changed,
                      every comment byte-identical, left UNCOMMITTED, the
                      container running it, and the note saying to commit it -
                      after which the image plan for that file refuses until
                      somebody does, which is the cost stated out loud
  4  REVERT (canary)  fast -> wrong: the container is healthy, the canary is not.
                      The old value is back, `git status` is CLEAN, and the
                      container is healthy on it. No data was restored.
  5  REVERT (health)  fast -> crash: the container never comes up. Same ending.
  6  PRE-FLIGHT       a dirty file and a stopped container each refuse before
                      anything is written
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
from updater import canaries, configvalue, executor, hostio, record  # noqa: E402
from updater.config import Config  # noqa: E402

P = "bothy-config-e2e"
C = f"{P}-web"
KEY = "MODE"


def test_canaries() -> dict:
    # The value that is in EFFECT, read off the body from inside the container's
    # network namespace. `wrong` is healthy and fails here, which is the whole
    # reason a canary reads bytes rather than a status code.
    return {"web": [canaries.body_matches("http://127.0.0.1:8080/", r"^mode (fast|slow)$",
                                          "the body says `mode fast` or `mode slow`")]}


def make_cfg(d: dict) -> Config:
    return Config(repo=d["repo"], catalog=d["catalog"], state=d["state"], backups=d["backups"],
                  textfile=d["textfile"], verify_timeout=25, min_free_bytes=1 << 20,
                  canaries=test_canaries())


# ── worker mode: what systemd runs, with this test's Config ───────────────────
if len(sys.argv) == 3 and sys.argv[1] == "--worker":
    with open(sys.argv[2]) as fh:
        wcfg = make_cfg(json.load(fh))
    # rediscover=False for e2e_updater.py's reason: the end-of-drain re-check runs
    # the real discovery program against this throwaway catalog, whose registry
    # does not exist. What it does is held by checks/test_updater.py.
    sys.exit(executor.run_spool(wcfg, log=lambda m: print(m, flush=True), rediscover=False))

import updates  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label, flush=True)
    if not cond:
        fails.append(label)


def sh(*argv: str, cwd: str | None = None, check: bool = True) -> str:
    p = subprocess.run(list(argv), cwd=cwd, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(argv)} -> {p.returncode}: {p.stderr[-800:]}")
    return p.stdout.strip()


def cleanup() -> None:
    subprocess.run(["docker", "compose", "-p", P, "down", "-v", "--remove-orphans"], capture_output=True)
    subprocess.run(["docker", "rm", "-f", "-v", C], capture_output=True)


if shutil.which("docker") is None or subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
    print("SKIP: no docker daemon")
    sys.exit(0)
if shutil.which("just") is None:
    print("SKIP: no `just` on PATH")
    sys.exit(0)

cleanup()
TMP = tempfile.mkdtemp(prefix="bothy-config-e2e-")
IMAGE = f"{P}/web:1.0.0"
try:
    # ── the image: its body is its MODE ─────────────────────────────────────
    DOCKERFILE = """FROM busybox:1.36.1
HEALTHCHECK --interval=2s --timeout=2s --retries=10 CMD wget -qO /dev/null http://127.0.0.1:8080/ || exit 1
RUN mkdir /www
ENTRYPOINT ["/bin/sh", "-c", "if [ \\"$MODE\\" = crash ]; then echo refusing >&2; exit 1; fi; \
if [ \\"$MODE\\" = wrong ]; then echo 'something else entirely' > /www/index.html; \
else echo \\"mode $MODE\\" > /www/index.html; fi; exec httpd -f -p 8080 -h /www"]
"""
    env = {**os.environ, "BUILDX_NO_DEFAULT_ATTESTATIONS": "1"}
    p = subprocess.run(["docker", "build", "-q", "-t", IMAGE, "-"], input=DOCKERFILE,
                       capture_output=True, text=True, env=env)
    if p.returncode != 0:
        raise RuntimeError(f"build: {p.stderr[-500:]}")

    # ── the repo, as main would carry it ────────────────────────────────────
    ORIGIN, REPO = os.path.join(TMP, "origin.git"), os.path.join(TMP, "repo")
    GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]
    sh("git", "init", "-q", "--bare", "-b", "main", ORIGIN)
    sh("git", "clone", "-q", ORIGIN, REPO)
    sh(*GIT, "checkout", "-q", "-b", "main", cwd=REPO)

    # Half of this file is comments, like half of this repository's compose files.
    # If a write loses one of them, section 3 says so.
    COMPOSE = f"""name: {P}
services:

  # The service whose one value this test changes. Everything in this block is a
  # comment that must survive a write byte for byte.
  web:
    image: {IMAGE}
    container_name: {C}
    environment:
      # WHY MODE IS WHAT IT IS. This is the most valuable line in the block, and
      # the whole reason the host splices a span instead of re-serialising.
      MODE: fast
      SHOUT:    quiet      # a hand-aligned trailing comment, in a column
      PGPASSWORD: ${{NOT_SET:-sentinel}}
    ports: []
"""
    with open(os.path.join(REPO, "compose.yml"), "w") as fh:
        fh.write(COMPOSE)
    with open(os.path.join(REPO, "justfile"), "w") as fh:
        fh.write("up-web:\n    docker compose -f compose.yml up -d --wait --wait-timeout 30\n")
    with open(os.path.join(REPO, "updates.toml"), "w") as fh:
        fh.write(f"""[policy]
window_start = "03:30"
window_end = "05:00"
require_backup = "stacks-backup.service"
require_doctor = true
max_auto_per_night = 1
pause_on_failure = true
discover_every_hours = 6

[components.web]
title = "Web"
class = "stateless"
source = "image"
pins = ["compose.yml:web"]
apply = "just up-web"
dependants = []
changelog = "https://example.invalid/web/v{{version}}"
channel = "auto"
one_way = false
verify = ["the body says `mode <MODE>`"]

[config_keys.web.MODE]
service = "web"
# `wrong` and `crash` are legal HERE on purpose: the point of this test is a
# value nobody could refuse on sight that the service turns out not to accept.
pattern = "fast|slow|wrong|crash"
meaning = "How the web service behaves, which nothing outside it depends on."

[config_reasons.secret]
label = "A credential"
keys = [".*PASSWORD.*"]
meaning = "It is a credential, and this interface does not become a way to one."

[config_reasons.rest]
label = "Not measured"
keys = []
files = []
meaning = "Nobody has measured what a wrong value here would do, so it is not offered."
""")
    sh(*GIT, "add", "-A", cwd=REPO)
    sh(*GIT, "commit", "-q", "-m", "the stack", cwd=REPO)
    sh(*GIT, "push", "-q", "origin", "main", cwd=REPO)

    D = {"repo": REPO, "catalog": os.path.join(REPO, "updates.toml"), "state": os.path.join(TMP, "state"),
         "backups": os.path.join(TMP, "backups"), "textfile": os.path.join(TMP, "textfile")}
    CFGFILE = os.path.join(TMP, "cfg.json")
    json.dump(D, open(CFGFILE, "w"))
    cfg = make_cfg(D)
    os.makedirs(cfg.spool, mode=0o700)
    os.makedirs(os.path.join(cfg.backups, "postgres"))
    open(os.path.join(cfg.backups, "postgres", "pg-test.sql.gz"), "w").write("a backup")

    sh("just", "up-web", cwd=REPO)
    catalog = updates.load(cfg.catalog)

    # bothy-ops' own request code, pointed at this state dir - the REAL writer, so
    # the spool file this test runs is the one a browser would produce.
    updates.CATALOG = catalog
    updates.AVAILABLE_FILE = cfg.available
    updates.UPDATES_DIR = cfg.state
    updates.SPOOL_DIR = cfg.spool
    hostio.write_json(cfg.available, {"version": 1, "generatedAt": "2026-10-11T10:00:00Z",
                                      "components": {}})

    class H:
        def __init__(self, body: dict) -> None:
            self.body = body

        def read_json_object(self, _max: int) -> dict:
            return self.body

    def rows() -> list[dict]:
        configvalue.write_all(cfg, catalog, hostio.read_json(cfg.available))
        doc = configvalue.read_config(cfg, "web")
        return (doc or {}).get("rows") or []

    def row(key: str = KEY) -> dict:
        return next(r for r in rows() if r["key"] == key)

    def ask(value: str, who: str = "operator@example.com", plan_id: str | None = None) -> str:
        """bothy-ops' OWN writer, so the spool file this test runs is the one a
        browser would produce - not one this check composed."""
        body = {"component": "web", "key": KEY, "value": value,
                "plan_id": plan_id or row()["planId"], "confirm": True}
        out, _ = updates.request_config(H(body), who, body)
        return out["jobId"]

    def worker() -> subprocess.Popen:
        return subprocess.Popen([sys.executable, os.path.abspath(__file__), "--worker", CFGFILE],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def job(jid: str) -> dict:
        return next((h for h in record.history(cfg, 100) if h["id"] == jid), {})

    def steps_of() -> dict:
        return {s["name"]: s["state"] for s in hostio.read_json(cfg.status_file)["job"]["steps"]}

    def body() -> str:
        st, b = canaries.probe(canaries.Ctx(cfg, C), "http://127.0.0.1:8080/")
        return b.strip()

    def value_in_file() -> str:
        text = open(os.path.join(REPO, "compose.yml"), encoding="utf-8").read()
        return re.search(r"^      MODE: (\S+)$", text, re.M).group(1)

    def dirty() -> str:
        return sh("git", "status", "--porcelain", cwd=REPO, check=False)

    # ── 1. the rows ─────────────────────────────────────────────────────────
    print("── 1. the rows: one editable, and a locked one with no value ────", flush=True)
    rs = {r["key"]: r for r in rows()}
    ok(set(rs) == {"MODE", "SHOUT", "PGPASSWORD"}, f"every environment key is a row: {sorted(rs)}")
    ok(rs["MODE"]["editable"] and rs["MODE"]["value"] == "fast"
       and rs["MODE"]["pattern"] == "fast|slow|wrong|crash" and rs["MODE"]["planId"],
       f"MODE is editable, with its live value, its bounded pattern and a plan id: {rs['MODE'].get('planId')}")
    ok(rs["PGPASSWORD"]["editable"] is False and rs["PGPASSWORD"]["reason"]["name"] == "secret"
       and "value" not in rs["PGPASSWORD"],
       "the credential-shaped key is locked, carries its sentence, and carries NO VALUE")
    ok(rs["SHOUT"]["editable"] is False and rs["SHOUT"]["reason"]["name"] == "rest",
       "a key nobody measured falls to the catch-all, which always has a sentence")
    ok(body() == "mode fast", f"the container's body is its value: {body()!r}")

    # ── 2. refused before anything is written ───────────────────────────────
    print("── 2. refused: by bothy-ops, and by the host anyway ─────────────", flush=True)
    for value, label in [("sideways", "a value the pattern refuses"),
                         ("fast slow", "a value with a space"),
                         ("fast", "the value it already has")]:
        try:
            ask(value)
            ok(False, f"{label} was ACCEPTED")
        except Exception as e:  # noqa: BLE001 - Refused, by status
            ok(os.listdir(cfg.spool) == [], f"{label} -> refused, NO spool file ({str(e)[:70]})")
    try:
        ask("slow", who="auto")
        ok(False, "the `auto` actor was ACCEPTED")
    except Exception as e:  # noqa: BLE001
        ok(os.listdir(cfg.spool) == [], f"the `auto` actor -> refused, no file ({str(e)[:60]})")

    # The HOST's own refusals, on a file written past bothy-ops. A compromised
    # bothy-ops is the case these exist for, so they are exercised by writing the
    # spool file directly rather than through the writer that already refused.
    planted = [0]

    def plant(**kw) -> str:
        # A FRESH job id each time: the executor refuses a job id it has seen
        # before ("that job id was used before"), which would make every row after
        # the first pass for the wrong reason.
        planted[0] += 1
        jid = f"{planted[0]:032x}"
        req = {"v": 1, "jobId": jid, "kind": "config", "component": "web", "key": KEY, "value": "slow",
               "planId": row()["planId"], "confirm": True, "requestedBy": "someone@example.com",
               "requestedAt": "2026-10-11T10:00:00Z", **kw}
        hostio.write_json(os.path.join(cfg.spool, f"{jid}.json"), req)
        worker().communicate(timeout=180)
        return job(jid).get("error") or ""

    ok("not one MODE may take" in plant(value="sideways"),
       "the HOST refuses a value outside the pattern, out of its OWN catalog - the check that holds "
       "when the process that asked is the thing that is wrong")
    ok("never automatic" in plant(requestedBy="auto"), "the HOST refuses the `auto` actor again")
    ok("is not the current plan" in plant(planId="a" * 24), "the HOST refuses a tampered plan id")
    ok("one click" in plant(confirm="web"), "the HOST refuses a typed confirmation this plan never asks for")
    ok(value_in_file() == "fast" and not dirty(),
       "after four planted requests the file is untouched and the tree is clean")

    # ── 3. success: one line, uncommitted, and the cost said out loud ───────
    print("── 3. success: fast -> slow, one line, left uncommitted ─────────", flush=True)
    j = ask("slow")
    ok(sorted(os.listdir(cfg.spool)) == [f"{j}.json"], "bothy-ops wrote exactly one spool file")
    out = worker().communicate(timeout=300)[0]
    r = job(j)
    ok(r.get("state") == "succeeded", f"succeeded ({r.get('state')}: {r.get('error')}) {out[-300:]}")
    ok(value_in_file() == "slow" and body() == "mode slow",
       f"the file says slow and the container says so too: {body()!r}")
    ok(dirty() == "M compose.yml", f"one file is dirty, and it is the compose file: {dirty()!r}")
    ok(sh("git", "diff", "--numstat", cwd=REPO).startswith("1\t1\tcompose.yml"),
       f"EXACTLY one line changed: {sh('git', 'diff', '--numstat', cwd=REPO)!r}")
    diff = sh("git", "diff", "-U0", "compose.yml", cwd=REPO)
    ok("-      MODE: fast" in diff and "+      MODE: slow" in diff and "#" not in diff.split("@@")[-1],
       "…and it is the MODE line, with no comment line anywhere in the diff")
    full = open(os.path.join(REPO, "compose.yml"), encoding="utf-8").read()
    before = COMPOSE.splitlines()
    after = full.splitlines()
    ok(all(a == b for a, b in zip(before, after) if a.lstrip().startswith("#")) and len(before) == len(after),
       "every comment line is byte-identical and the line count is unchanged")
    ok("SHOUT:    quiet      # a hand-aligned trailing comment, in a column" in full,
       "…and the hand-aligned column next to it is exactly as it was")
    ok("COMMIT IT" in (r.get("note") or "") and "git diff compose.yml" in (r.get("note") or ""),
       f"the note says to commit it, and how to read it: {(r.get('note') or '')[:140]!r}")
    st = steps_of()
    ok([n for n, v in st.items() if v == "ok"] == ["validate", "preflight", "snapshot", "edit", "apply",
                                                   "verify", "record"],
       f"every step ok, in order, with `edit` where an image job pulls: {st}")
    snaps = sorted(os.listdir(cfg.snapshots))
    sd = os.path.join(cfg.snapshots, snaps[-1])
    cj = json.load(open(os.path.join(sd, "config.json")))
    ok(cj["oldValue"] == "fast" and cj["newValue"] == "slow" and cj["key"] == KEY,
       f"the snapshot records the value the host would put back: {cj['oldValue']!r} -> {cj['newValue']!r}")
    ok("compose.yml" in os.listdir(sd), "…beside the whole compose file as it was")
    # THE COST, stated out loud: while that file is dirty, the image plan for every
    # component pinned in it refuses, and says which file and how far it reaches.
    from updater import plans as hplans
    hplans.write_all(cfg, catalog, hostio.read_json(cfg.available))
    why = (hplans.read_plan(cfg, "web") or {}).get("reason") or ""
    ok("compose.yml has local changes" in why,
       f"the IMAGE plan now refuses until somebody commits it, naming the file: {why[:120]!r}")
    ok("no longer reads what the plan recorded" in (row().get("reason") or "")
       or "has local changes" in (row().get("reason") or ""),
       f"…and so does the next CONFIG plan: {(row().get('reason') or '')[:120]!r}")
    sh(*GIT, "add", "-A", cwd=REPO)
    sh(*GIT, "commit", "-q", "-m", "set MODE to slow (the commit the note asked for)", cwd=REPO)
    sh(*GIT, "push", "-q", "origin", "main", cwd=REPO)
    ok(not dirty() and row()["planId"], "once it is committed, the rows offer an edit again")

    # ── 4. THE REVERT, on a canary the value broke ──────────────────────────
    print("── 4. REVERT: slow -> wrong is healthy, and the canary is not ───", flush=True)
    j = ask("wrong")
    out = worker().communicate(timeout=400)[0]
    r = job(j)
    ok(r.get("state") == "rolled_back" and r.get("failedStep") == "verify",
       f"rolled back after verify failed: {r.get('state')} / {r.get('failedStep')}: {r.get('error')}")
    ok("the body says" in (r.get("error") or ""),
       f"the CANARY caught it, on the body - the container was healthy: {(r.get('error') or '')[:110]!r}")
    ok(value_in_file() == "slow", f"THE OLD VALUE IS BACK IN THE FILE: MODE: {value_in_file()}")
    ok(not dirty(), f"and the tree is CLEAN - nothing left to commit or revert: {dirty()!r}")
    ok(body() == "mode slow", f"and the container is healthy on it, saying so: {body()!r}")
    c = hostio.container(C) or {}
    ok(c.get("state") == "running" and c.get("health") == "healthy",
       f"docker agrees: {c.get('state')}/{c.get('health')}")
    st = steps_of()
    ok(st.get("rollback") == "ok" and "restore" not in st,
       f"the revert ran and NO DATA WAS RESTORED - there is no restore step to reach: {st}")
    ok("is back to slow" in (r.get("note") or "") and "clean again" in (r.get("note") or ""),
       f"the note says the value is back and the tree is clean: {(r.get('note') or '')[:140]!r}")

    # ── 5. THE REVERT, on a value the container will not start with ─────────
    print("── 5. REVERT: slow -> crash never comes up at all ───────────────", flush=True)
    j = ask("crash")
    out = worker().communicate(timeout=400)[0]
    r = job(j)
    ok(r.get("state") in ("rolled_back", "aborted") and r.get("state") == "rolled_back",
       f"rolled back, not aborted - the file HAD been written: {r.get('state')}: {r.get('error')}")
    ok(value_in_file() == "slow" and not dirty(),
       f"the old value is back and the tree is clean: MODE: {value_in_file()}, {dirty()!r}")
    ok(body() == "mode slow", f"and the container is healthy on it again: {body()!r}")
    ok(steps_of().get("rollback") == "ok", f"the revert ran: {steps_of()}")

    # ── 6. pre-flight: a dirty file, and a stopped container ────────────────
    print("── 6. pre-flight: a dirty file, a stopped container ─────────────", flush=True)
    r0 = row()
    with open(os.path.join(REPO, "compose.yml"), "a") as fh:
        fh.write("# somebody is editing this in Files right now\n")
    ok(row().get("planId") is None and "local changes" in (row().get("reason") or ""),
       f"a dirty file: no plan at all, and the reason says so ({(row().get('reason') or '')[:90]!r})")
    jid = "e" * 32
    hostio.write_json(os.path.join(cfg.spool, f"{jid}.json"),
                      {"v": 1, "jobId": jid, "kind": "config", "component": "web", "key": KEY,
                       "value": "fast", "planId": r0["planId"], "confirm": True,
                       "requestedBy": "someone@example.com", "requestedAt": "2026-10-11T10:00:00Z"})
    worker().communicate(timeout=180)
    ok(job(jid).get("state") == "refused" and value_in_file() == "slow",
       f"…and a planted request for it is refused, writing nothing: {job(jid).get('error', '')[:90]!r}")
    sh("git", "checkout", "-q", "--", "compose.yml", cwd=REPO)
    subprocess.run(["docker", "stop", C], capture_output=True)
    ok(row().get("planId") is None and "not running" in (row().get("reason") or ""),
       f"a stopped container: no plan, and it says what to run ({(row().get('reason') or '')[:90]!r})")
finally:
    cleanup()
    subprocess.run(["docker", "rmi", "-f", IMAGE], capture_output=True)
    shutil.rmtree(TMP, ignore_errors=True)

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("config value end to end: all passed")
