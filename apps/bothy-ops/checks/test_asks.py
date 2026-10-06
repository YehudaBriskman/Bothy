#!/usr/bin/env python3
"""The HOST half of the two asks (2026-10-06), as units: no network, no systemd.

Run: python3 checks/test_asks.py

`discover_updates.py` is replaced by a table that records every argv; the night
job's clock, backup and doctor are the fakes checks/test_auto.py uses. What it
pins down:

  SURVIVES  spool.entries() files neither `discover-<id>.json` nor
            `autorun-<id>.json` as junk - the one failure that would make a new
            ask kind silently never happen, because the update loop removes
            anything it does not recognise. An unknown kind IS still removed.
  DISCOVER  a valid ask is claimed (unlinked) BEFORE it runs, at most once; the
            argv is fixed, built from Config, and carries nothing from the ask; a
            non-zero exit is recorded as `failed`, not as success; a second ask
            inside the rate limit is refused with the seconds, by the HOST, with
            available.json's own mtime as the clock - the asking process cannot
            touch it; the record lands in asks.json, 600.
  AUTORUN   a dry run writes NO request and records what tonight would do; a real
            run writes exactly one request, whose actor is `auto` - the night job
            chose it - while asks.json records the PERSON who asked early; every
            gate still applies (the window closed is a `skipped`, not a failure).
  HOSTILE   an ask with the wrong keys, the wrong kind, an id that is not its file
            name, a symlink, a 5 KiB file, or `requestedBy: auto` is removed,
            audited and run for nothing. Each case is proved by the argv table
            staying empty and the spool ending up clean.
  SOFT      a drain that raises does not stop the executor's loop (_hook audits it).
"""
import datetime as dt
import json
import os
import shutil
import stat
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)
os.environ.setdefault("ADMIN_AUDIT_LOG", os.devnull)

import updater  # noqa: E402,F401
import updates  # noqa: E402
from updater import asks, auto, executor, hostio, spool  # noqa: E402
from updater.config import Config  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


TMP = tempfile.mkdtemp(prefix="bothy-asks-unit-")
CATALOG = """
[policy]
window_start = "03:30"
window_end = "05:00"
require_backup = "stacks-backup.service"
require_doctor = true
max_auto_per_night = 1
pause_on_failure = true
discover_every_hours = 6

[components.web]
title = "web"
class = "stateless"
source = "image"
pins = ["compose.yml:web"]
apply = "just up-web"
dependants = []
changelog = "https://example.invalid/web/{version}"
channel = "auto"
one_way = false
verify = ["x"]
"""
os.makedirs(os.path.join(TMP, "repo"))
CAT = os.path.join(TMP, "repo", "updates.toml")
open(CAT, "w").write(CATALOG)
cfg = Config(repo=os.path.join(TMP, "repo"), catalog=CAT, state=os.path.join(TMP, "state"),
             backups=os.path.join(TMP, "backups"), textfile=os.path.join(TMP, "textfile"))
os.makedirs(cfg.spool, mode=0o700)
os.makedirs(cfg.plans, mode=0o700)
os.makedirs(os.path.join(cfg.backups, "postgres"))
DUMP = os.path.join(cfg.backups, "postgres", "pg-tonight.sql.gz")
open(DUMP, "w").write("a dump")

# ── the fakes ─────────────────────────────────────────────────────────────────
CALLS: list[list[str]] = []
RC = [0]
ERR = ["discovery: 1 with a newer version -> available.json"]


def fake_run(argv, **kw):
    CALLS.append(list(argv))
    return RC[0], "", ERR[0]


asks.run = fake_run


class Clock:
    def __init__(self) -> None:
        self.t = dt.datetime(2026, 10, 6, 3, 31).astimezone()

    def __call__(self) -> dt.datetime:
        return self.t

    def at(self, h: int, m: int, day: int = 6) -> None:
        self.t = self.t.replace(day=day, hour=h, minute=m)


clock = Clock()


def cutoff() -> float:
    return clock().replace(hour=3, minute=0, second=0, microsecond=0).timestamp()


def good_backup(_unit: str) -> dict:
    os.utime(DUMP, (cutoff() + 180, cutoff() + 180))
    return {"LoadState": "loaded", "ActiveState": "inactive", "Result": "success", "ExecMainStatus": "0",
            "ExecMainExitTimestamp": f"@{int(cutoff()) + 240}"}


PLAN = {"version": 1, "component": "web", "ok": True, "plan": {
    "id": "a" * 24, "component": "web", "level": "patch", "confirm": "click",
    "from": {"image": "web:1.0.0", "version": "1.0.0"}, "to": {"image": "web:1.0.1", "version": "1.0.1"}}}


def env(doctor_ok: bool = True):
    return auto.Env(now=clock, backup_props=good_backup,
                    doctor=lambda c, cid, p: (doctor_ok, "healthy" if doctor_ok else "red"),
                    refresh_plans=lambda c, cat: None)


hostio.write_json(os.path.join(cfg.plans, "web.json"), PLAN)


def ask(_kind: str, _rid: str, **over) -> str:
    """One ask file, exactly as bothy-ops writes it. `over` tampers with the
    CONTENTS only - the file name always says what it claims to be, which is how a
    `kind` or `id` that disagrees with its name becomes a case below."""
    doc = {"v": 1, "kind": _kind, "id": _rid, "requestedBy": "a@example.com",
           "requestedAt": "2026-10-06T03:30:00Z"}
    if _kind == "autorun":
        doc["dryRun"] = True
    doc.update(over)
    name = f"{_kind}-{_rid}.json"
    with open(os.path.join(cfg.spool, name), "w") as fh:
        json.dump(doc, fh)
    return name


def aged(seconds: int) -> None:
    hostio.write_json(cfg.available, {"version": 1, "generatedAt": "2026-10-06T03:00:00Z", "components": {}})
    os.utime(cfg.available, (time.time() - seconds, time.time() - seconds))


def clean() -> None:
    for n in os.listdir(cfg.spool):
        p = os.path.join(cfg.spool, n)
        shutil.rmtree(p, True) if os.path.isdir(p) else os.unlink(p)
    CALLS.clear()


def state(kind: str) -> dict:
    return asks.load_state(cfg).get(kind) or {}


MIN = updates.DISCOVER_MIN_SECONDS

print("── SURVIVES: the update loop's junk sweep leaves an ask alone ────")
ask("discover", "1" * 32)
ask("autorun", "2" * 32)
ask("unpause", "3" * 32)
open(os.path.join(cfg.spool, "something-else.json"), "w").write("{}")
reqs, junk = spool.entries(cfg.spool)
ok(reqs == [], f"none of them is an update request: {reqs}")
ok(junk == ["something-else.json"],
   f"the three known kinds survive; an unknown one is junk: {junk}")
clean()

print()
print("── DISCOVER: claimed once, a fixed argv, recorded ───────────────")
aged(MIN + 60)
name = ask("discover", "4" * 32)
n = asks.drain_discover(cfg)
ok(n == 1 and not os.path.exists(os.path.join(cfg.spool, name)),
   "the ask is claimed - unlinked - so a crash mid-run never re-runs it")
ok(len(CALLS) == 1 and CALLS[0][1].endswith("discover_updates.py") and "--quiet" in CALLS[0]
   and CALLS[0][CALLS[0].index("--state-dir") + 1] == cfg.state,
   f"one fixed argv, the host's own program and state dir: {CALLS[0][1:] if CALLS else '(none)'}")
ok("4" * 32 not in " ".join(CALLS[0]) and "a@example.com" not in " ".join(CALLS[0]),
   "nothing from the ask - not the id, not the actor - is in the argv")
ok(CALLS[0][CALLS[0].index("--textfile-dir") + 1] == cfg.textfile,
   "the textfile directory is passed, so the metrics follow a browser's check too")
d = state("discover")
ok(d.get("outcome") == "ok" and d.get("askedBy") == "a@example.com" and isinstance(d.get("tookMs"), int)
   and "newer version" in (d.get("reason") or ""),
   f"asks.json records who asked, the outcome and discovery's own last line: {d}")
ok(stat.S_IMODE(os.stat(asks.state_file(cfg)).st_mode) == 0o600, "asks.json is 600")
clean()

RC[0] = 2
ERR[0] = "updates.toml is invalid - nothing discovered"
aged(MIN + 60)
ask("discover", "5" * 32)
asks.drain_discover(cfg)
ok(state("discover")["outcome"] == "failed" and "invalid" in state("discover")["reason"],
   f"a non-zero exit is `failed`, with the reason - never a silent success: {state('discover')}")
RC[0] = 0
ERR[0] = "discovery: 1 with a newer version -> available.json"
clean()

aged(5)
ask("discover", "6" * 32)
asks.drain_discover(cfg)
ok(not CALLS and state("discover")["outcome"] == "refused" and f"{MIN}s" in state("discover")["reason"],
   f"inside the rate limit: refused by the HOST, nothing run ({state('discover')['reason'][:70]})")
ok(not os.listdir(cfg.spool), "…and the ask is still claimed, so it cannot retry forever")
aged(MIN + 60)
clean()

print()
print("── DISCOVER: a hostile ask runs nothing ─────────────────────────")
HOSTILE = [
    ({"extra": 1}, "an extra key"),
    ({"kind": "autorun"}, "the wrong kind"),
    ({"id": "9" * 32}, "an id that is not its file name"),
    ({"requestedBy": updates.AUTO_ACTOR}, f"requestedBy {updates.AUTO_ACTOR!r} - the system actor"),
    ({"requestedBy": ""}, "an empty actor"),
    ({"requestedAt": "yesterday"}, "a requestedAt that is not a timestamp"),
    ({"v": 2}, "an unknown version"),
]
for over, label in HOSTILE:
    rid = "7" * 32
    ask("discover", rid, **over)
    asks.drain_discover(cfg)
    ok(not CALLS and not os.listdir(cfg.spool) and state("discover")["outcome"] == "refused",
       f"{label}: removed, recorded, nothing run")
    clean()

rid = "8" * 32
os.symlink("/etc/passwd", os.path.join(cfg.spool, f"discover-{rid}.json"))
asks.drain_discover(cfg)
ok(not CALLS and not os.listdir(cfg.spool), "a symlink named like an ask: never read through, removed")
clean()

rid = "a" * 32
with open(os.path.join(cfg.spool, f"discover-{rid}.json"), "w") as fh:
    fh.write(" " * (spool.MAX_BYTES + 1))
asks.drain_discover(cfg)
ok(not CALLS and not os.listdir(cfg.spool), "a file over 4 KiB: removed unread")
clean()

print()
print("── AUTORUN: a dry run writes nothing; a real one writes ONE ─────")
ask("autorun", "b" * 32, dryRun=True)
asks.drain_autorun(cfg, env())
a = state("autorun")
ok(not spool.queued(cfg.spool), "a dry run queued no update request")
ok(a["dryRun"] is True and a["outcome"] == "ok" and a["component"] == "web" and "would request" in a["reason"],
   f"…and says what tonight would do, for whom: {a['reason'][:80]}")
ok(a["askedBy"] == "a@example.com", "the person who asked is on the record")
ok(auto.load_state(cfg).get("last") is None, "a dry run left auto.json's own `last` untouched")
clean()

ask("autorun", "c" * 32, dryRun=False)
asks.drain_autorun(cfg, env())
q = spool.queued(cfg.spool)
ok(len(q) == 1, f"a real run queued exactly one update request: {q}")
req = json.load(open(os.path.join(cfg.spool, q[0])))
ok(spool.validate_shape(req, q[0]) and req["component"] == "web" and req["planId"] == "a" * 24,
   "…in the executor's exact schema, for the component the HOST picked")
ok(req["requestedBy"] == updates.AUTO_ACTOR,
   "the actor is `auto`: the night job chose the component, the level and the plan")
a = state("autorun")
ok(a["askedBy"] == "a@example.com" and a["dryRun"] is False and a["jobId"] == req["jobId"],
   "…and asks.json carries who asked it to run early, beside the job id")
ok(auto.load_state(cfg)["last"]["outcome"] == "requested",
   "a real run is also the night job's own record in auto.json, as the timer's would be")
clean()

print()
print("── AUTORUN: every gate still applies ────────────────────────────")
clock.at(12, 0)
ask("autorun", "d" * 32, dryRun=False)
asks.drain_autorun(cfg, env())
a = state("autorun")
ok(not spool.queued(cfg.spool) and a["outcome"] == "skipped" and "outside the window" in a["reason"],
   f"at noon: skipped, nothing queued - the button asks, it does not bypass ({a['reason'][:60]})")
clock.at(3, 31)
clean()

# The next night: tonight's one job is already spent, and "one a night" is a gate
# that fires before the candidates are looked at.
clock.at(3, 31, day=7)
ask("autorun", "e" * 32, dryRun=False)
asks.drain_autorun(cfg, env(doctor_ok=False))
a = state("autorun")
ok(not spool.queued(cfg.spool) and a["outcome"] == "skipped" and a["skipped"]
   and a["skipped"][0]["component"] == "web",
   f"doctor red: skipped, and the row says which component and why ({a['skipped']})")
clean()

ask("autorun", "f" * 32, dryRun=True, requestedBy=updates.AUTO_ACTOR)
asks.drain_autorun(cfg, env())
ok(state("autorun")["outcome"] == "refused" and not spool.queued(cfg.spool),
   "an autorun ask naming the system actor is refused, like an unpause")
clean()

print()
print("── SOFT: a broken drain never stops the executor's loop ─────────")
LINES = []


def boom(_cfg):
    raise RuntimeError("the registry ate it")


real = asks.drain_discover
asks.drain_discover = boom
try:
    executor._hook(cfg, "asks", "drain_discover")
finally:
    asks.drain_discover = real
audit = open(cfg.audit_file).read() if os.path.exists(cfg.audit_file) else ""
ok("drain_discover\tfailed" in audit and "RuntimeError" in audit,
   "the fault is one audit line naming the module, the drain and the exception")

print()
shutil.rmtree(TMP, True)
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("asks units: all passed")
