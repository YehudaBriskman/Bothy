#!/usr/bin/env python3
"""The automatic channel's decisions (step 7), as units: a fake clock, a fake backup.

Run: python3 checks/test_auto.py

No docker, no systemd, no git: `systemctl show` is a dict, the clock is a
function, doctor is a table and the plans are files written here in the host's
shape. What it pins down:

  GATES    the window (closed at noon, and at 05:00 exactly); the backup (never
           ran tonight, FAILED, still running, succeeded with no fresh dump,
           unit not installed); doctor red (skipped with its reason, the next
           candidate tried); nothing eligible (a minor, no plan, paused); busy
           (a person's request waiting, a job running)
  PICK     at most one; oldest-waiting first, then by id; the request is the
           executor's exact schema (spool.validate_shape accepts it) with the
           actor `auto`, 600, atomic; the decision is audited as `auto`
  NIGHT    one per night; tonight's job unfinished -> wait; tonight's job failed
           -> nothing more tonight; the next night runs again
  PAUSE    a rolled_back or failed history line pauses an auto component (not a
           notify one), once: an unpause is not undone by the same old line; the
           next night skips it; bothy_update_paused says so
  UNPAUSE  through the spool: an `unpause-<id>.json` survives the update loop's
           junk sweep, the executor's loop claims it, clears the pause and audits
           who; a malformed one (extra key, the system actor, a symlink) is
           removed, audited, and clears nothing; `just update-unpause` clears
           directly; unpausing what is not paused says so
  DRY RUN  says what tonight would do and writes nothing
"""
import datetime as dt
import json
import os
import shutil
import stat
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)
os.environ.setdefault("ADMIN_AUDIT_LOG", os.devnull)

import updater  # noqa: E402,F401
from updater import auto, executor, hostio, record, spool  # noqa: E402
from updater.config import Config  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


TMP = tempfile.mkdtemp(prefix="bothy-auto-unit-")
CATALOG = """
[policy]
window_start = "03:30"
window_end = "05:00"
require_backup = "stacks-backup.service"
require_doctor = true
max_auto_per_night = 1
pause_on_failure = true
discover_every_hours = 6
""" + "".join(f"""
[components.{cid}]
title = "{cid}"
class = "{cls}"
source = "image"
pins = ["compose.yml:{cid}"]
apply = "just up-{cid}"
dependants = []
changelog = "https://example.invalid/{cid}/{{version}}"
channel = "{ch}"
one_way = false
verify = ["x"]
""" for cid, cls, ch in (("web", "stateless", "auto"), ("web2", "stateless", "auto"),
                         ("loki", "timeseries", "auto"), ("graf", "stateless", "notify")))
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


# ── the fakes ──────────────────────────────────────────────────────────────────
class Clock:
    def __init__(self) -> None:
        self.t = dt.datetime(2026, 9, 19, 3, 31).astimezone()

    def __call__(self) -> dt.datetime:
        return self.t

    def at(self, day: int, h: int, m: int) -> None:
        self.t = dt.datetime(2026, 9, day, h, m).astimezone()


clock = Clock()


def cutoff() -> float:
    return clock().replace(hour=3, minute=0, second=0, microsecond=0).timestamp()


BACKUP: dict = {}


def good_backup() -> None:
    """Tonight's stacks-backup.service: succeeded at 03:04, and its dump is 03:03."""
    BACKUP.clear()
    BACKUP.update({"LoadState": "loaded", "ActiveState": "inactive", "Result": "success", "ExecMainStatus": "0",
                   "ExecMainExitTimestamp": f"@{int(cutoff()) + 240}"})
    os.utime(DUMP, (cutoff() + 180, cutoff() + 180))


DOCTOR: dict[str, tuple[bool, str]] = {}
env = auto.Env(now=clock, backup_props=lambda unit: dict(BACKUP),
               doctor=lambda c, cid, p: DOCTOR.get(cid, (True, "green")),
               refresh_plans=lambda c, cat: None)


def plan(cid: str, frm: str = "1.0.0", to: str = "1.0.1", level: str = "patch") -> None:
    pid = (cid.encode().hex() + frm.replace(".", "") + to.replace(".", "") + "0" * 24)[:24]
    hostio.write_json(os.path.join(cfg.plans, f"{cid}.json"), {"version": 1, "component": cid, "ok": True, "plan": {
        "id": pid, "component": cid, "level": level, "confirm": "click", "container": f"t-{cid}",
        "from": {"image": f"example.invalid/{cid}:{frm}", "version": frm},
        "to": {"image": f"example.invalid/{cid}:{to}", "version": to}}})


def no_plan(cid: str) -> None:
    hostio.write_json(os.path.join(cfg.plans, f"{cid}.json"),
                      {"version": 1, "component": cid, "ok": False, "reason": "nothing to deploy"})


def history(cid: str, state: str, jid: str, by: str = "auto", error: str = "the canary said no") -> None:
    hostio.append_line(cfg.history_file, json.dumps({
        "id": jid, "component": cid, "state": state, "requestedBy": by, "endedAt": record.iso(),
        "error": error if state != "succeeded" else None}))


def spool_files() -> list[str]:
    return sorted(os.listdir(cfg.spool))


def clear_spool() -> None:
    for n in os.listdir(cfg.spool):
        spool.remove(cfg.spool, n)


def decide(**kw) -> auto.Decision:
    return auto.decide(cfg, env, __import__("updates").load(cfg.catalog), **kw)


def audit_lines() -> list[list[str]]:
    try:
        return [ln.split("\t") for ln in open(cfg.audit_file).read().splitlines()]
    except FileNotFoundError:
        return []


def prom() -> str:
    try:
        return open(os.path.join(cfg.textfile, "bothy_updater_auto.prom")).read()
    except FileNotFoundError:
        return ""


good_backup()
for c in ("web", "web2", "loki", "graf"):
    no_plan(c)

print("── GATES: the window ────────────────────────────────────────────")
clock.at(19, 12, 0)
d = decide()
ok(d.outcome == "skipped" and "outside the window" in d.reason and "never caught up" in d.reason,
   f"noon: skipped, the window is closed ({d.reason[:60]})")
ok(spool_files() == [] and auto.load_state(cfg)["nights"] == {}, "…nothing written, and the night is not spent")
clock.at(19, 5, 0)
ok("outside the window" in decide().reason, "05:00 exactly is outside (the window is half-open)")
clock.at(19, 3, 29)
ok("outside the window" in decide().reason, "03:29 is outside")

print()
print("── GATES: tonight's backup ──────────────────────────────────────")
clock.at(19, 3, 31)
good_backup()
BACKUP["ExecMainExitTimestamp"] = f"@{int(cutoff()) - 86400 + 240}"
d = decide()
ok(d.outcome == "skipped" and "has not run since 03:00 today" in d.reason, f"missing: last night's run only ({d.reason})")
BACKUP["ExecMainExitTimestamp"] = ""
ok("has not run since" in decide().reason and "never" in decide().reason, "missing: never ran")
good_backup()
BACKUP.update(Result="exit-code", ExecMainStatus="1")
d = decide()
ok(d.outcome == "skipped" and "FAILED" in d.reason and "exit 1" in d.reason, f"failed: Result=exit-code ({d.reason})")
good_backup()
BACKUP.update(ActiveState="activating")
ok("still activating" in decide().reason, "still running")
good_backup()
BACKUP.update(LoadState="not-found")
ok("is it installed" in decide().reason, "the backup unit is not installed")
good_backup()
BACKUP.clear()
BACKUP["error"] = "Failed to connect to bus"
ok("systemctl show" in decide().reason, "systemctl itself failed")
good_backup()
os.utime(DUMP, (cutoff() - 3600, cutoff() - 3600))
d = decide()
ok("newest file" in d.reason and "older than 03:00" in d.reason, f"the unit succeeded but the dump is yesterday's ({d.reason})")
good_backup()
ok(spool_files() == [], "no refusal above wrote a request")
last = auto.load_state(cfg)["last"]
ok(last and last["outcome"] == "skipped" and last["reason"].startswith("backup:"), "each refusal is recorded as tonight's last decision")
ok(any(f[3] == "auto" and f[4] == "auto" and f[5] == "skipped" and "backup" in f[6] for f in audit_lines()),
   "…and audited with the actor `auto`")

print()
print("── GATES: nothing eligible ──────────────────────────────────────")
d = decide()
ok(d.outcome == "skipped" and "nothing eligible" in d.reason, f"no plan anywhere ({d.reason[:50]})")
plan("web", "1.0.0", "1.1.0", level="minor")
plan("graf")
d = decide()
ok(d.outcome == "skipped" and "nothing eligible" in d.reason and ("web", "minor - only patches are automatic") in d.skipped,
   "a MINOR of an auto component is passed over; a notify component's patch is never a candidate")
no_plan("web")
no_plan("graf")

print()
print("── GATES: doctor ────────────────────────────────────────────────")
plan("web")
DOCTOR["web"] = (False, "t-web is unhealthy")
d = decide()
ok(d.outcome == "skipped" and "red" in d.reason and "unhealthy" in d.reason and spool_files() == [],
   f"doctor red: no request, and why ({d.reason[:70]})")
plan("web2")
d = decide(dry_run=True)
ok(d.outcome == "requested" and d.component == "web2" and ("web", "doctor red: t-web is unhealthy") in d.skipped,
   "a red candidate is passed over and the next one tried")
no_plan("web2")
DOCTOR.clear()

print()
print("── GATES: busy ──────────────────────────────────────────────────")
open(os.path.join(cfg.spool, "f" * 32 + ".json"), "w").write("{}")
d = decide()
ok(d.outcome == "skipped" and "waiting in the spool" in d.reason, "a person's request is waiting")
clear_spool()
hostio.write_json(cfg.status_file, {"version": 1, "job": {"id": "e" * 32, "component": "loki", "state": "running"}})
ok("is running" in decide().reason, "a job is running")
os.unlink(cfg.status_file)

print()
print("── DRY RUN ──────────────────────────────────────────────────────")
before = open(auto.state_file(cfg)).read()
d = decide(dry_run=True)
ok(d.outcome == "requested" and "would request web" in d.reason, f"says what it would do ({d.reason[:50]})")
ok(spool_files() == [] and open(auto.state_file(cfg)).read() == before, "…and writes nothing")

print()
print("── PICK: one, the oldest waiting, in the executor's schema ─────")
plan("web2")
plan("loki")
# web2 has waited since an earlier night; web and loki are seen for the first time now.
st = auto.load_state(cfg)
st["pending"]["web2"] = {"to": "example.invalid/web2:1.0.1", "since": "2026-09-10T01:00:00Z"}
auto.save_state(cfg, st)
d = decide()
files = spool_files()
ok(d.outcome == "requested" and d.component == "web2" and len(files) == 1, f"ONE request, the oldest waiting: {d.component} {files}")
name = files[0] if files else ""
req = spool.validate_shape(spool.read(cfg.spool, name), name) if name else {}
ok(req and req["requestedBy"] == "auto" and req["confirm"] is True and req["component"] == "web2"
   and req["planId"] == json.load(open(os.path.join(cfg.plans, "web2.json")))["plan"]["id"],
   "the executor's own shape check accepts it: the plan id, confirm, actor `auto`")
ok(name and stat.S_IMODE(os.stat(os.path.join(cfg.spool, name)).st_mode) == 0o600, "600, like bothy-ops' files")
ok(not [n for n in files if n.startswith(".")], "no temp file left behind (atomic rename)")
st = auto.load_state(cfg)
ok(st["nights"]["2026-09-19"]["jobs"][0]["jobId"] == req.get("jobId"), "tonight's job is recorded")
ok(set(st["pending"]) == {"web", "web2", "loki"} and st["pending"]["web2"]["since"] == "2026-09-10T01:00:00Z",
   "…and every waiting target keeps the night it was first seen")
ok(any(f[1] == req.get("jobId") and f[3] == "auto" and f[5] == "requested" for f in audit_lines()),
   "audit.log: `requested`, by `auto`, with the job id")
J1 = req.get("jobId", "")
clear_spool()

print()
print("── NIGHT: one per night, stop at the first failure ──────────────")
d = decide()
ok(d.outcome == "skipped" and "has not finished" in d.reason and spool_files() == [], "tonight's job not finished: nothing more")
history("web2", "succeeded", J1)
no_plan("web2")  # it runs what main pins now
d = decide()
ok(d.outcome == "skipped" and "already 1 automatic update tonight" in d.reason, f"succeeded: the limit is one ({d.reason[:50]})")
clock.at(20, 3, 31)
good_backup()
d = decide()
ok(d.outcome == "requested" and d.component == "loki", f"the next night runs again: the oldest by id among equals ({d.component})")
J2 = d.job
clear_spool()
history("loki", "refused", J2, error="pre-flight: the newest backup is 2 days old")
d = decide()
ok(d.outcome == "skipped" and "ended refused" in d.reason and "first failure" in d.reason,
   f"tonight's job failed: nothing more tonight ({d.reason[:60]})")
ok("loki" not in auto.load_state(cfg)["paused"], "a REFUSED job does not pause (nothing was touched)")

print()
print("── PAUSE: a rollback pauses auto for that component ─────────────")
J3 = "3" * 32
history("web", "rolled_back", J3, by="op@example.com", error="verify: the body says BROKEN")
history("graf", "failed", "4" * 32, by="op@example.com")
newly = auto.sync_pauses(cfg)
st = auto.load_state(cfg)
ok(newly == ["web"] and st["paused"]["web"]["jobId"] == J3 and "rolled back" in st["paused"]["web"]["reason"]
   and "BROKEN" in st["paused"]["web"]["reason"], f"web is paused by a PERSON's rolled-back job, with the reason: {newly}")
ok("graf" not in st["paused"], "a notify component's failure pauses nothing (it is never automatic)")
ok('bothy_update_paused{component="web"} 1' in prom() and 'bothy_update_paused{component="loki"} 0' in prom()
   and "graf" not in prom(), "bothy_update_paused: 1 for web, 0 for the other auto components")
ok(auto.sync_pauses(cfg) == [], "syncing again pauses nothing new")
clock.at(21, 3, 40)
good_backup()
plan("web2", "1.0.1", "1.0.2")
plan("loki", "3.7.7", "3.7.8")
st = auto.load_state(cfg)
st["pending"]["web"]["since"] = "2026-01-01T00:00:00Z"  # web has waited longest of all
auto.save_state(cfg, st)
d = decide()
ok(d.outcome == "requested" and d.component != "web" and any(c == "web" and "paused" in w for c, w in d.skipped),
   f"the next night skips the paused component, however long it waited: {d.component}; passed over {d.skipped}")
history(d.component, "succeeded", d.job)
clear_spool()

print()
print("── PAUSE: a failed job pauses too; auto's own rollback ──────────")
J5 = "5" * 32
history("loki", "failed", J5, error="after the rollback: loki is unhealthy")
executor.run_spool(cfg, log=lambda *_: None)  # an empty drain: no job, so no hook ran
ok("loki" not in auto.load_state(cfg)["paused"], "(no job ran, so the executor's hook did not sync)")
open(os.path.join(cfg.spool, "6" * 32 + ".json"), "w").write("{not json")
executor.run_spool(cfg, log=lambda *_: None)
ok("loki" in auto.load_state(cfg)["paused"] and auto.load_state(cfg)["paused"]["loki"]["result"] == "failed",
   "the executor syncs the pauses after every job it runs")

print()
print("── UNPAUSE: through the spool, owned by the host ────────────────")


def unpause_file(rid: str, **kw) -> str:
    doc = {"v": 1, "kind": "unpause", "id": rid, "component": "web", "requestedBy": "op@example.com",
           "requestedAt": "2026-09-21T09:00:00Z"}
    doc.update(kw)
    n = f"unpause-{rid}.json"
    with open(os.path.join(cfg.spool, n), "w") as fh:
        json.dump(doc, fh)
    return n


n = unpause_file("a" * 32)
reqs, junk = spool.entries(cfg.spool)
ok(reqs == [] and junk == [], "the update loop's sweep leaves an unpause file alone (it is not junk)")
bad1 = unpause_file("b" * 32, extra=1)
bad2 = unpause_file("c" * 32, requestedBy="auto")
os.symlink("/etc/passwd", os.path.join(cfg.spool, f"unpause-{'d' * 32}.json"))
executor.run_spool(cfg, log=lambda *_: None)
st = auto.load_state(cfg)
ok("web" not in st["paused"] and st["unpaused"]["web"]["by"] == "op@example.com", "the executor's loop cleared web's pause, as who asked")
ok(spool_files() == [], "every unpause file was claimed - valid or not")
al = audit_lines()
ok(any(f[2] == "web" and f[3] == "op@example.com" and f[4] == "unpause" and f[5] == "ok" for f in al),
   "audit.log: unpause ok, by the operator")
ok(sum(1 for f in al if f[4] == "unpause" and f[5] == "refused" and "invalid" in f[6]) == 3,
   "an extra key, the system actor and a symlink are each refused and audited")
ok("loki" in st["paused"], "…and cleared nothing else")
ok('bothy_update_paused{component="web"} 0' in prom(), "the metric follows")
auto.sync_pauses(cfg)
ok("web" not in auto.load_state(cfg)["paused"], "a later sync does not re-pause from the same old history line")
history("web", "rolled_back", "7" * 32)
ok(auto.sync_pauses(cfg) == ["web"], "…but a NEW rollback pauses it again")

print()
print("── UNPAUSE: from a shell ────────────────────────────────────────")
good, msg = auto.unpause(cfg, "loki", "devssh (shell)", via="just update-unpause")
ok(good and "auto resumes" in msg and "loki" not in auto.load_state(cfg)["paused"], f"just update-unpause loki ({msg[:50]})")
good, msg = auto.unpause(cfg, "loki", "devssh (shell)")
ok(not good and "not paused" in msg, "unpausing what is not paused says so")
good, msg = auto.unpause(cfg, "nope", "devssh (shell)")
ok(not good and "not in updates.toml" in msg, "an unknown component is refused")
ok(stat.S_IMODE(os.stat(auto.state_file(cfg)).st_mode) == 0o600, "auto.json is 600 (bothy-ops reads it through a read-only mount)")

print()
print("── the CLI ──────────────────────────────────────────────────────")
from updater.__main__ import main  # noqa: E402
ok(main(["unpause", "../x"], cfg) == 2, "`unpause` refuses a malformed id before anything")
ok(main(["unpause", "web"], cfg) == 0 and "web" not in auto.load_state(cfg)["paused"], "`unpause web` clears it")
ok(main(["pauses"], cfg) == 0, "`pauses` prints")

shutil.rmtree(TMP, ignore_errors=True)
print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("auto units: all passed")
