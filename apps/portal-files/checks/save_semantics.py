#!/usr/bin/env python3
"""Save writes to disk, does NOT commit, and refuses a stale write.

The conflict case is the one that matters. It replaces git as the safety net, so
it has to be watched failing rather than assumed - a check nobody has seen go red
is a check nobody should trust, and this one prevents a SILENT loss.
"""
import os
import re
import subprocess
import sys
import time

import requests

BASE = "http://100.117.176.85"
API = f"{BASE}/-/api/files"
REPO = "/home/devssh/claude-notes"
F = "_save-semantics-probe.md"

fails = 0


def check(label, ok, detail=""):
    global fails
    if not ok:
        fails += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label:<54} {detail}")


def head():
    return subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"],
                          capture_output=True, text=True).stdout.strip()


s = requests.Session()
r = s.get(f"{BASE}/oauth2/start", params={"rd": "/"}, allow_redirects=True, timeout=10)
m = re.search(r'action="([^"]+)"', r.text)
s.post(m.group(1).replace("&amp;", "&"),
       data={"username": os.environ["DEV_LOGIN_USER"],
             "password": os.environ["DEV_LOGIN_PASSWORD"]},
       allow_redirects=True, timeout=10)

before_head = head()

print("── a save writes to disk and does NOT commit ───────────────────────")
r = s.post(f"{API}/write", json={"root": "notes", "path": F,
                                 "content": "# one\n"}, timeout=20)
check("save accepted", r.status_code == 200, f"got {r.status_code}")
d = r.json() if r.status_code == 200 else {}
check("file is on disk", os.path.exists(f"{REPO}/{F}"))
check("content is exactly what was sent",
      open(f"{REPO}/{F}").read() == "# one\n")
check("NO commit was created", head() == before_head,
      f"{before_head[:9]} unchanged")
check("response reports created + mtime",
      d.get("created") is True and isinstance(d.get("mtime"), int),
      f"created={d.get('created')} mtime={d.get('mtime')}")
check("git sees it as an untracked change",
      F in subprocess.run(["git", "-C", REPO, "status", "--porcelain"],
                          capture_output=True, text=True).stdout)

print("\n── the write log replaces the commit as the audit trail ────────────")
log = subprocess.run(["docker", "exec", "portal-files", "cat", "/audit/writes.log"],
                     capture_output=True, text=True).stdout
check("the save is in the audit log", F in log)
check("and it names who did it", os.environ["DEV_LOGIN_USER"] in log)
if F in log:
    print("      " + [l for l in log.splitlines() if F in l][-1])

print("\n── THE CONFLICT: a stale save must be refused, not applied ─────────")
r = s.get(f"{API}/read", params={"root": "notes", "path": F}, timeout=15)
opened_mtime = r.json()["mtime"]

# Someone else changes the file underneath the open tab.
time.sleep(1.1)                      # mtime has 1s resolution
open(f"{REPO}/{F}", "w").write("# THEIRS - written by someone else\n")

r = s.post(f"{API}/write", json={"root": "notes", "path": F,
                                 "content": "# MINE - from a stale tab\n",
                                 "baseMtime": opened_mtime}, timeout=20)
check("a stale write is REFUSED with 409", r.status_code == 409, f"got {r.status_code}")
c = r.json() if r.status_code == 409 else {}
check("and the other version was NOT overwritten",
      open(f"{REPO}/{F}").read() == "# THEIRS - written by someone else\n")
check("the response carries BOTH versions, so the UI can offer a choice",
      c.get("yours", "").startswith("# MINE") and c.get("theirs", "").startswith("# THEIRS"))
check("and both mtimes, so the UI can say what happened",
      c.get("baseMtime") != c.get("currentMtime"))

print("\n── ...but a save with the CURRENT mtime still works ────────────────")
cur = s.get(f"{API}/read", params={"root": "notes", "path": F}, timeout=15).json()["mtime"]
r = s.post(f"{API}/write", json={"root": "notes", "path": F,
                                 "content": "# resolved\n",
                                 "baseMtime": cur}, timeout=20)
check("a fresh write is accepted", r.status_code == 200, f"got {r.status_code}")
check("and it landed", open(f"{REPO}/{F}").read() == "# resolved\n")

print("\n── a client that omits baseMtime is not blocked ────────────────────")
# curl and scripts have no mtime to send. They lose the guarantee, not the
# ability to write - refusing them would make the API unusable outside the UI.
r = s.post(f"{API}/write", json={"root": "notes", "path": F,
                                 "content": "# no basemtime\n"}, timeout=20)
check("write without baseMtime still succeeds", r.status_code == 200, f"got {r.status_code}")

print("\n── cleanup ─────────────────────────────────────────────────────────")
os.remove(f"{REPO}/{F}")
check("probe file removed", not os.path.exists(f"{REPO}/{F}"))
check("and the repo is back to where it started", head() == before_head)

print(f"\n{fails} FAILED" if fails else "\nall pass")
sys.exit(1 if fails else 0)
