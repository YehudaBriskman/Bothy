#!/usr/bin/env python3
"""End-to-end test of the editor tier: log in, write, verify it hit DISK.

Checks the things a status code cannot:
  - an anonymous write is refused AND leaves no file
  - an authenticated write actually lands on disk
  - it lands on disk and does NOT commit (save and commit were decoupled;
    committing is a deliberate act in the git area now)
  - the write is recorded in the audit log, which replaced the commit as the
    thing that says who changed what
  - the path guards still hold THROUGH the HTTP layer, not just in the unit test
  - and the guards that were REMOVED on 2026-08-17 are gone in the direction
    intended: a risky suffix writes, and the service says what it costs
"""
import os
import re
import subprocess
import sys
import requests

# One resolver for the whole suite - checks/env.py. These were literals in
# twelve files, which put this node's tailnet address in a public repo and
# made the suite unrunnable by anyone but its author.
from env import BASE, STACKS

API = f"{BASE}/-/api/files"
REPO = STACKS
TESTFILE = "docs/kb/_editor-tier-e2e.md"   # cleaned up at the end

# This test writes a real file into a real repo and cleans up after itself. It no
# longer creates a commit - save stopped doing that - but it still refuses to run
# against a dirty tree, because its cleanup path uses `git reset --hard` as a
# backstop and that would discard someone's uncommitted work.
_dirty = subprocess.run(["git", "-C", REPO, "status", "--porcelain"],
                        capture_output=True, text=True).stdout
_dirty = [l for l in _dirty.splitlines() if not l.startswith("??")]
if _dirty:
    sys.exit("REFUSING TO RUN: the working tree has uncommitted changes.\n"
             "This test ends in `git reset --hard`, which would discard them:\n  "
             + "\n  ".join(_dirty))

fails = 0
def check(label, ok, detail=""):
    global fails
    if not ok:
        fails += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label:<52} {detail}")

s = requests.Session()

print("── anonymous ───────────────────────────────────────────────────────")
r = s.post(f"{API}/write", json={"root": "stacks", "path": TESTFILE, "content": "x"}, timeout=10)
check("anonymous write is refused", r.status_code in (401, 403), f"got {r.status_code}")
check("and left no file on disk", not os.path.exists(f"{REPO}/{TESTFILE}"))

# Read was OPEN when this test was written, and asserting that was correct then:
# the roots were two markdown trees serving what the docs site already served
# unauthenticated. Widening the roots to the whole box killed that reasoning -
# ~/stacks/.env and a real TLS key came into scope - so read moved behind
# `viewer` and this assertion inverted.
r = s.get(f"{API}/tree", params={"root": "stacks"}, timeout=10)
check("anonymous READ is refused too, since the roots widened",
      r.status_code == 401, f"got {r.status_code}")

print("\n── log in ──────────────────────────────────────────────────────────")
r = s.get(f"{BASE}/oauth2/start", params={"rd": "/"}, allow_redirects=True, timeout=10)
m = re.search(r'action="([^"]+)"', r.text)
if not m:
    sys.exit("FAIL: no Keycloak login form")
s.post(m.group(1).replace("&amp;", "&"),
       data={"username": os.environ["DEV_LOGIN_USER"],
             "password": os.environ["DEV_LOGIN_PASSWORD"]},
       allow_redirects=True, timeout=10)
check("session established",
      any(c.name.startswith("_oauth2_proxy") for c in s.cookies))

print("\n── authenticated write ─────────────────────────────────────────────")
before = subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"],
                        capture_output=True, text=True).stdout.strip()

body = "# editor tier e2e\n\nWritten by the portal through the write API.\n"
r = s.post(f"{API}/write", json={
    "root": "stacks", "path": TESTFILE, "content": body,
    "message": "test(portal-files): editor tier end-to-end probe",
}, timeout=20)
check("authenticated write accepted", r.status_code == 200, f"got {r.status_code}")
data = r.json() if r.status_code == 200 else {}

on_disk = os.path.exists(f"{REPO}/{TESTFILE}")
check("file exists on disk", on_disk)
if on_disk:
    check("content matches exactly",
          open(f"{REPO}/{TESTFILE}").read() == body)

after = subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"],
                       capture_output=True, text=True).stdout.strip()
# THE inversion. This assertion used to be "a new commit was created" and was
# correct then; save WAS a commit. Decoupling them means a save must leave the
# history alone - if HEAD moves here, saving is committing again and the whole
# point of the change is gone.
check("NO commit was created - save writes to disk only",
      before == after, f"HEAD {before[:9]} unchanged")
check("git sees the file as a pending change instead",
      TESTFILE in subprocess.run(["git", "-C", REPO, "status", "--porcelain"],
                                 capture_output=True, text=True).stdout)
check("the response reports the new mtime, for the conflict check",
      isinstance(data.get("mtime"), int), f"mtime={data.get('mtime')}")

# The audit log is what replaced the commit as the record of who changed what.
alog = subprocess.run(["docker", "exec", "portal-files", "cat", "/audit/writes.log"],
                      capture_output=True, text=True).stdout
check("the write is in the audit log, with an author",
      TESTFILE in alog and os.environ["DEV_LOGIN_USER"] in alog)

print("\n── guards still hold through HTTP, for an AUTHENTICATED editor ──────")
# THIS TABLE SHRANK ON 2026-08-17, and what left it matters as much as what
# stayed. `.sh`, `compose.yml` and `.env` used to sit here expecting 403, because
# [write].suffixes was an allowlist of prose formats. That allowlist is gone -
# policy.toml carries the argument - and these three assertions did not merely go
# stale, they turned DESTRUCTIVE: the `.env` case wrote "x" over ~/stacks/.env on
# every run, and the rest of the suite then failed because `just` could no longer
# parse the file it had just clobbered. It was recovered from the snapshot trash,
# which is the best advertisement the undo net has had.
#
# What remains is the part that is not a preference: containment, the denied
# directories, read-only roots, unknown roots.
for label, payload, want in [
    ("traversal out of the root",
     {"root": "stacks", "path": "../../etc/passwd", "content": "x"}, 403),
    ("absolute path",
     {"root": "stacks", "path": "/etc/passwd", "content": "x"}, 403),
    ("the repo's own .git",
     {"root": "stacks", "path": ".git/config", "content": "x"}, 403),
    ("the read-only projects root",
     {"root": "projects", "path": "notes.md", "content": "x"}, 403),
    ("an unknown root",
     {"root": "etc", "path": "passwd", "content": "x"}, 403),
]:
    rr = s.post(f"{API}/write", json=payload, timeout=10)
    check(label, rr.status_code == want, f"got {rr.status_code}")

print("\n── ...and what is no longer refused SAYS WHAT IT COSTS instead ──────")
# The inversion, asserted rather than assumed. A suffix that used to be blocked
# now writes, and the service warns through /read's `caution` rather than
# refusing. To a PROBE path, never to the real file: the claim is that the
# refusal is gone, not that this test is entitled to rewrite the box.
PROBE_SH = "docs/kb/_e2e-probe.sh"
rr = s.post(f"{API}/write", json={"root": "stacks", "path": PROBE_SH,
                                  "content": "#!/bin/sh\necho probe\n"}, timeout=10)
check("a shell script is now WRITABLE, not refused", rr.status_code == 200,
      f"got {rr.status_code}")
rr = s.get(f"{API}/read", params={"root": "stacks", "path": PROBE_SH}, timeout=10)
check("...and /read says what running it costs",
      (rr.json().get("caution") or {}).get("level") == "critical",
      str((rr.json().get("caution") or {}).get("level")))

# .env is READ here and never written. It holds 19 live secret values, and the
# whole point of the paragraph above is that this endpoint would now happily
# overwrite it - so the assertion is that the service MARKS it, not that it is
# safe to prod.
rr = s.get(f"{API}/read", params={"root": "stacks", "path": ".env"}, timeout=10)
check("the real .env opens - marked, no longer hidden", rr.status_code == 200,
      f"got {rr.status_code}")
d = rr.json() if rr.status_code == 200 else {}
check("...and is flagged both by name and by caution",
      bool(d.get("sensitive")) and (d.get("caution") or {}).get("level") == "critical",
      f"sensitive={str(d.get('sensitive'))[:34]!r}")

print("\n── cleanup ─────────────────────────────────────────────────────────")
# The files are untracked now (no commit), so reset --hard does not remove them.
# Delete them, then reset as a backstop for anything else this touched.
for stray in (TESTFILE, PROBE_SH):
    if os.path.exists(f"{REPO}/{stray}"):
        os.remove(f"{REPO}/{stray}")
subprocess.run(["git", "-C", REPO, "reset", "--hard", before],
               capture_output=True, text=True)
gone = not any(os.path.exists(f"{REPO}/{p}") for p in (TESTFILE, PROBE_SH))
head = subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"],
                      capture_output=True, text=True).stdout.strip()
check("probe files removed, history untouched", head == before and gone, f"HEAD={head[:9]}")

print(f"\n{fails} FAILED" if fails else "\nall pass")
sys.exit(1 if fails else 0)
