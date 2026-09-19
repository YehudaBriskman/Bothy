#!/usr/bin/env python3
"""The automatic channel (step 7) is wired the way updater/auto.py says.

Run: python3 checks/wiring_auto.py      (needs PyYAML - the system python3 has it)

Static. What a runtime test cannot see, because each half lives in a different
file and would pass alone:

  TIMES    bothy-updater-auto.timer fires at [policy] window_start, and that is
           after stacks-backup.timer (auto.BACKUP_AT) and before window_end;
           Persistent=false (a missed night is skipped, never caught up at noon)
           and the backup timer it waits on is the unit [policy] names
  UNIT     the service runs `python3 -m updater auto` once, as the owner, from
           apps/bothy-ops, ordered After= the backup, NoNewPrivileges; the
           executor's path unit still exists (the night job only WRITES a request)
  STATE    auto.json sits in the updates state dir that bothy-ops mounts
           READ-ONLY - not in the spool, its one writable mount there
  ACTOR    bothy-ops reserves the same actor name the night job writes
  ALERTS   rules.yml carries update_failed / update_auto_paused / update_stale on
           exactly the metric names record.py, auto.py and discover_updates.py
           write; every rule's condition names one of its own refIds; uids are
           unique; severity=info is routed once a day
  JUST     update-auto, update-pauses and update-unpause run the host program
  DOCS     host/README.md lists the two units
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(SVC))
sys.path.insert(0, SVC)
os.environ.setdefault("ADMIN_AUDIT_LOG", os.devnull)

try:
    import yaml
except ImportError:
    print("  FAIL  PyYAML is not importable - run with the system python3 (python3-yaml)")
    sys.exit(1)

import updater  # noqa: E402,F401
import updates  # noqa: E402
from updater import auto  # noqa: E402
from updater.config import Config  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def read(rel: str) -> str:
    return open(os.path.join(REPO, rel), encoding="utf-8").read()


def unit(rel: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for ln in read(rel).splitlines():
        if "=" in ln and not ln.lstrip().startswith(("#", ";", "[")):
            k, v = ln.split("=", 1)
            out.setdefault(k.strip(), []).append(v.strip())
    return out


pol = updates.load().policy
print("── TIMES: the window, the timer and the backup agree ────────────")
t = unit("host/systemd/bothy-updater-auto.timer")
m = re.fullmatch(r"\*-\*-\* (\d\d):(\d\d):00", (t.get("OnCalendar") or [""])[0])
ok(m is not None and f"{m.group(1)}:{m.group(2)}" == pol.window_start,
   f"the timer fires at window_start ({t.get('OnCalendar')} vs {pol.window_start})")
ok(t.get("Persistent") == ["false"], "Persistent=false: a missed night is skipped, never caught up")
ok(t.get("Unit") == ["bothy-updater-auto.service"], "the timer starts the auto service")
bk = unit("host/systemd/stacks-backup.timer")
mb = re.fullmatch(r"\*-\*-\* (\d\d):(\d\d):00", (bk.get("OnCalendar") or [""])[0])
ok(mb is not None and (int(mb.group(1)), int(mb.group(2))) == auto.BACKUP_AT,
   f"auto.BACKUP_AT is stacks-backup.timer's time ({bk.get('OnCalendar')} vs {auto.BACKUP_AT})")
ok("%02d:%02d" % auto.BACKUP_AT < pol.window_start < pol.window_end,
   f"the backup ({auto.BACKUP_AT}) runs before the window opens ({pol.window_start}-{pol.window_end})")
ok(pol.require_backup == "stacks-backup.service" and os.path.exists(os.path.join(REPO, "host/systemd", pol.require_backup)),
   f"[policy] require_backup names a unit this repo ships ({pol.require_backup})")

print()
print("── UNIT: the night job, and what it relies on ───────────────────")
s = unit("host/systemd/bothy-updater-auto.service")
ok(s.get("Type") == ["oneshot"] and s.get("User") == ["devssh"] and s.get("NoNewPrivileges") == ["yes"],
   "oneshot, as the owner, no new privileges")
ok(s.get("ExecStart") == ["/usr/bin/python3 -m updater auto"], "runs `python3 -m updater auto`")
ok(bool(re.fullmatch(r"/\S+/apps/bothy-ops", (s.get("WorkingDirectory") or [""])[0])), "from apps/bothy-ops")
ok("stacks-backup.service" in " ".join(s.get("After", [])),
   "ordered After=stacks-backup.service: a backup still running at 03:30 is waited for")
ok(os.path.exists(os.path.join(REPO, "host/systemd/bothy-updater.path")),
   "the executor's path unit exists - the night job only writes a request")

print()
print("── STATE and ACTOR ──────────────────────────────────────────────")
c = Config(repo=REPO, state="/S/bothy/updates", backups="/B", textfile=None)
ok(auto.state_file(c) == "/S/bothy/updates/auto.json" and not auto.state_file(c).startswith(c.spool + "/"),
   "auto.json is in the updates dir (bothy-ops: read-only), not in the spool (bothy-ops: writable)")
ok(updates.AUTO_ACTOR == auto.ACTOR == "auto", "bothy-ops reserves the actor the night job writes")

print()
print("── ALERTS: rules.yml names what the updater writes ─────────────")
doc = yaml.safe_load(read("monitoring/provisioning/alerting/rules.yml"))
rules = [r for g in doc["groups"] for r in g["rules"]]
uids = [r["uid"] for r in rules]
ok(len(uids) == len(set(uids)), f"every uid is unique: {uids}")
by = {r["uid"]: r for r in rules}
want = {"update_failed": "bothy_update_last_result", "update_auto_paused": "bothy_update_paused",
        "update_stale": "bothy_update_available"}
writers = {"bothy_update_last_result": read("apps/bothy-ops/updater/record.py"),
           "bothy_update_paused": read("apps/bothy-ops/updater/auto.py"),
           "bothy_update_available": read("apps/bothy-ops/discover_updates.py")}
for uid, metric in want.items():
    r = by.get(uid, {})
    expr = " ".join(d["model"].get("expr", "") for d in r.get("data", []))
    ok(metric in expr and metric in writers[metric], f"{uid}: queries {metric}, which the updater writes")
for r in rules:
    refs = {d["refId"] for d in r["data"]}
    ok(r["condition"] in refs and all(d["datasourceUid"] in ("prometheus", "__expr__") for d in r["data"]),
       f"{r['uid']}: its condition is one of its refIds; datasources by the live uid")
ok('result=~"rolled_back|failed"' in by["update_failed"]["data"][0]["model"]["expr"],
   "update_failed: rolled_back and failed, nothing else")
pol_doc = yaml.safe_load(read("monitoring/provisioning/alerting/policies.yml"))
routes = pol_doc["policies"][0].get("routes") or []
ok(any(["severity", "=", "info"] in r.get("object_matchers", []) and r.get("repeat_interval") == "24h" for r in routes)
   and by["update_stale"]["labels"]["severity"] == "info", "update_stale is a severity=info notice, once a day")

print()
print("── JUST and DOCS ────────────────────────────────────────────────")
just = read("justfile")
for recipe, cmd in (("update-auto *args", "python3 -m updater auto {{args}}"),
                    ("update-pauses", "python3 -m updater pauses"),
                    ("update-unpause component", "python3 -m updater unpause {{quote(component)}}")):
    ok(re.search(rf"^{re.escape(recipe)}:\n    cd apps/bothy-ops && {re.escape(cmd)}$", just, re.M) is not None,
       f"`just {recipe.split()[0]}` runs the host program")
hr = read("host/README.md")
ok("bothy-updater-auto.{timer,service}" in hr, "host/README.md lists the auto units")

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("wiring_auto: all passed")
