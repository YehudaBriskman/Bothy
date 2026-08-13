#!/usr/bin/env python3
"""End-to-end test of the editor tier: log in, write, verify the commit.

Checks the things a status code cannot:
  - an anonymous write is refused AND leaves no file
  - an authenticated write actually lands on disk
  - it produces a real git commit attributed to the logged-in user
  - the path guards still hold THROUGH the HTTP layer, not just in the unit test
  - a non-writable extension is refused even for an authenticated editor
"""
import os
import re
import subprocess
import sys
import requests

BASE = "http://100.117.176.85"
API = f"{BASE}/-/api/files"
REPO = "/home/devssh/stacks"
TESTFILE = "docs/kb/_editor-tier-e2e.md"   # cleaned up at the end

# This test makes a real commit and undoes it with `git reset --hard`, which
# would also throw away any UNCOMMITTED work in the tree. Refuse to run rather
# than destroy someone's edits to prove a point about file safety.
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
    "root": "docs", "path": TESTFILE, "content": body,
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
check("a new commit was created", before != after, f"{before[:9]} -> {after[:9]}")

author = subprocess.run(["git", "-C", REPO, "log", "-1", "--format=%an"],
                        capture_output=True, text=True).stdout.strip()
check("commit is attributed to the logged-in user",
      author == os.environ["DEV_LOGIN_USER"], f"author={author}")

subject = subprocess.run(["git", "-C", REPO, "log", "-1", "--format=%s"],
                         capture_output=True, text=True).stdout.strip()
check("commit message is the one supplied",
      subject == "test(portal-files): editor tier end-to-end probe", subject)

check("response carries git history", len(data.get("history", [])) >= 1,
      f"{len(data.get('history', []))} entries")

# Only the intended file may be in that commit. `--only <path>` should guarantee
# it, but this is the assertion that would catch it silently staging the tree.
touched = subprocess.run(["git", "-C", REPO, "show", "--name-only", "--format=", "HEAD"],
                         capture_output=True, text=True).stdout.split()
check("the commit touched exactly one file", touched == [TESTFILE], str(touched))

print("\n── guards still hold through HTTP, for an AUTHENTICATED editor ──────")
for label, payload, want in [
    ("traversal out of the root",
     {"root": "stacks", "path": "../../etc/passwd", "content": "x"}, 403),
    ("absolute path",
     {"root": "stacks", "path": "/etc/passwd", "content": "x"}, 403),
    ("a shell script",
     {"root": "stacks", "path": "docs/kb/evil.sh", "content": "x"}, 403),
    ("a compose file",
     {"root": "stacks", "path": "docs/kb/compose.yml", "content": "x"}, 403),
    ("the repo's own .git",
     {"root": "stacks", "path": ".git/config", "content": "x"}, 403),
    ("a denied secret", {"root": "stacks", "path": ".env", "content": "x"}, 403),
    ("the read-only projects root",
     {"root": "projects", "path": "notes.md", "content": "x"}, 403),
    ("an unknown root",
     {"root": "etc", "path": "passwd", "content": "x"}, 403),
]:
    rr = s.post(f"{API}/write", json=payload, timeout=10)
    check(label, rr.status_code == want, f"got {rr.status_code}")

check("no stray files were created",
      not os.path.exists(f"{REPO}/docs/kb/evil.sh")
      and not os.path.exists(f"{REPO}/docs/kb/compose.yml"))

print("\n── cleanup ─────────────────────────────────────────────────────────")
subprocess.run(["git", "-C", REPO, "reset", "--hard", before],
               capture_output=True, text=True)
gone = not os.path.exists(f"{REPO}/{TESTFILE}")
head = subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"],
                      capture_output=True, text=True).stdout.strip()
check("test commit reverted", head == before and gone, f"HEAD={head[:9]}")

print(f"\n{fails} FAILED" if fails else "\nall pass")
sys.exit(1 if fails else 0)
