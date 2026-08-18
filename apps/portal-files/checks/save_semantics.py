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

# One resolver for the whole suite - checks/env.py. These were literals in
# twelve files, which put this node's tailnet address in a public repo and
# made the suite unrunnable by anyone but its author.
from env import BASE, NOTES

API = f"{BASE}/-/api/files"
REPO = NOTES
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

# ── the mode a save leaves behind ───────────────────────────────────────────
#
# tempfile.mkstemp() creates 0600 and os.replace PRESERVES the temp file's mode,
# so the atomic-write path silently made every file it touched owner-only -
# including files that were world-readable a moment before. Editing a file
# changed who could read it, and nothing said so.
#
# IT PASSED EVERY CHECK HERE FOR AS LONG AS IT EXISTED, because this service
# reads back as the same uid it writes as. It only surfaces when ANOTHER process
# has to read the file, which is exactly what a custom theme is: written through
# this API, served by nginx. A theme saved in the editor showed up in the picker
# (the directory is listable) and then 403'd when applied.
#
# So the assertion is about the MODE, not about readability - a check that only
# re-reads through this API is the check that missed it in the first place.
print("\n── a save does not change who can read the file ─────────────────────")
MODE_F = "_mode-probe.md"
mode_path = f"{REPO}/{MODE_F}"
try:
    r = s.post(f"{API}/write", json={"root": "notes", "path": MODE_F,
                                     "content": "probe\n"}, timeout=20)
    got = os.stat(mode_path).st_mode & 0o777 if os.path.exists(mode_path) else 0
    # What a plain open() would have produced, so it matches its neighbours
    # rather than a number written out here - the umask is the machine's to set.
    cur = os.umask(0); os.umask(cur)
    want = 0o666 & ~cur
    check("a NEW file gets the ordinary mode, not mkstemp's 0600",
          got == want, f"got {oct(got)}, want {oct(want)}")

    # The same bug pointing the other way: a deliberately restrictive file must
    # not be flung open to everyone just because somebody edited it.
    os.chmod(mode_path, 0o600)
    mt = int(os.stat(mode_path).st_mtime)
    s.post(f"{API}/write", json={"root": "notes", "path": MODE_F,
                                 "content": "probe 2\n", "baseMtime": mt}, timeout=20)
    got = os.stat(mode_path).st_mode & 0o777
    check("an OVERWRITE keeps the file's own mode (0600 stays 0600)",
          got == 0o600, f"got {oct(got)}")

    os.chmod(mode_path, 0o644)
    mt = int(os.stat(mode_path).st_mtime)
    s.post(f"{API}/write", json={"root": "notes", "path": MODE_F,
                                 "content": "probe 3\n", "baseMtime": mt}, timeout=20)
    got = os.stat(mode_path).st_mode & 0o777
    check("...and 0644 stays 0644", got == 0o644, f"got {oct(got)}")
finally:
    if os.path.exists(mode_path):
        os.remove(mode_path)

print("\n── cleanup ─────────────────────────────────────────────────────────")
os.remove(f"{REPO}/{F}")
check("probe file removed", not os.path.exists(f"{REPO}/{F}"))
check("and the repo is back to where it started", head() == before_head)

print(f"\n{fails} FAILED" if fails else "\nall pass")
sys.exit(1 if fails else 0)
