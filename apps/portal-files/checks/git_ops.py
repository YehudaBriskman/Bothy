#!/usr/bin/env python3
"""The git area: stage, unstage, diff, commit, discard, and the sync refusals.

Two things here are worth more than the rest.

`discard` is the only irreversible action this service has. `git restore
--worktree` throws away working-tree content, and for an UNSTAGED change that
content was never in the object store - so nothing can recover it. That got
sharper when save stopped committing, because the working tree is now often the
only copy of an edit. The refusals around it are therefore tested first and
tested hardest.

`push` is the only thing that leaves the box, and it is gated a tier higher than
everything else. Here we can only prove the REFUSALS (no credential, SSH remote),
because proving a successful push would mean publishing to a real remote.
"""
import os
import re
import subprocess
import sys

import requests

BASE = "http://100.117.176.85"
API = f"{BASE}/-/api/files"
REPO = "/home/devssh/claude-notes"
F = "_git-ops-probe.md"

fails = 0


def check(label, ok, detail=""):
    global fails
    if not ok:
        fails += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label:<56} {detail}")


def g(*args):
    return subprocess.run(["git", "-C", REPO, *args],
                          capture_output=True, text=True).stdout.strip()


dirty = [l for l in g("status", "--porcelain").splitlines() if l]
if dirty:
    sys.exit("REFUSING TO RUN: ~/claude-notes has uncommitted changes.\n  "
             + "\n  ".join(dirty))

s = requests.Session()
r = s.get(f"{BASE}/oauth2/start", params={"rd": "/"}, allow_redirects=True, timeout=10)
m = re.search(r'action="([^"]+)"', r.text)
s.post(m.group(1).replace("&amp;", "&"),
       data={"username": os.environ["DEV_LOGIN_USER"],
             "password": os.environ["DEV_LOGIN_PASSWORD"]},
       allow_redirects=True, timeout=10)

before_head = g("rev-parse", "HEAD")
P = {"root": "notes", "path": F}

print("── stage / unstage ─────────────────────────────────────────────────")
s.post(f"{API}/write", json={**P, "content": "# one\n"}, timeout=20)
check("a saved file starts UNSTAGED", g("status", "--porcelain", "--", F).startswith("??"),
      g("status", "--porcelain", "--", F))

r = s.post(f"{API}/git/stage", json=P, timeout=20)
check("stage succeeds", r.status_code == 200, f"got {r.status_code}")
check("and git agrees it is staged", g("status", "--porcelain", "--", F).startswith("A"),
      g("status", "--porcelain", "--", F))

r = s.post(f"{API}/git/unstage", json=P, timeout=20)
check("unstage succeeds", r.status_code == 200, f"got {r.status_code}")
check("and it is untracked again", g("status", "--porcelain", "--", F).startswith("??"),
      g("status", "--porcelain", "--", F))

print("\n── diff ────────────────────────────────────────────────────────────")
s.post(f"{API}/git/stage", json=P, timeout=20)
s.post(f"{API}/git/commit", json={**P, "message": "test(probe): add"}, timeout=30)
s.post(f"{API}/write", json={**P, "content": "# one\n# two\n"}, timeout=20)
d = s.get(f"{API}/git/diff", params=P, timeout=20).json()
check("an unstaged edit produces a diff", not d.get("empty"), f"{len(d.get('diff') or '')} chars")
check("and the diff contains the new line", "+# two" in (d.get("diff") or ""))

print("\n── commit ──────────────────────────────────────────────────────────")
r = s.post(f"{API}/git/commit", json={**P, "message": "no staging"}, timeout=30)
check("commit with nothing staged is refused, and says so",
      r.status_code == 400 and "staged" in r.text, f"got {r.status_code}")
r = s.post(f"{API}/git/commit", json={**P, "message": ""}, timeout=30)
check("commit with no message is refused", r.status_code == 400, f"got {r.status_code}")

s.post(f"{API}/git/stage", json=P, timeout=20)
r = s.post(f"{API}/git/commit", json={**P, "message": "test(probe): second"}, timeout=30)
check("a staged commit succeeds", r.status_code == 200, f"got {r.status_code}")
check("it is attributed to the signed-in user",
      g("log", "-1", "--format=%an") == os.environ["DEV_LOGIN_USER"],
      g("log", "-1", "--format=%an"))
check("and touched exactly the one file",
      g("show", "--name-only", "--format=", "HEAD").split() == [F])

print("\n── discard: the irreversible one ───────────────────────────────────")
s.post(f"{API}/write", json={**P, "content": "# one\n# two\n# UNSAVED WORK\n"}, timeout=20)

r = s.post(f"{API}/git/discard", json=P, timeout=20)
check("discard WITHOUT confirm is refused", r.status_code == 400, f"got {r.status_code}")
check("and it explains why, rather than just failing",
      "irreversible" in r.text.lower(), r.json().get("error", "")[:60])
check("the file is untouched", "# UNSAVED WORK" in open(f"{REPO}/{F}").read())

r = s.post(f"{API}/git/discard", json={"root": "notes", "confirm": True}, timeout=20)
check("discard of a WHOLE REPO is refused even with confirm",
      r.status_code == 400, f"got {r.status_code}")
check("...because one mis-click should not cost everything",
      "whole repo" in r.text.lower() or "specific file" in r.text.lower())
check("the file is still untouched", "# UNSAVED WORK" in open(f"{REPO}/{F}").read())

r = s.post(f"{API}/git/discard", json={**P, "confirm": True}, timeout=20)
check("discard WITH confirm and a path succeeds", r.status_code == 200, f"got {r.status_code}")
check("and the working-tree edit is gone",
      "# UNSAVED WORK" not in open(f"{REPO}/{F}").read())
check("it was recorded as irreversible in the audit log",
      "DISCARDED" in subprocess.run(
          ["docker", "exec", "portal-files", "cat", "/audit/writes.log"],
          capture_output=True, text=True).stdout)

print("\n── sync: refusals we can prove ─────────────────────────────────────")
r = s.post(f"{API}/git/push", json={"root": "notes"}, timeout=30)
check("push on a repo with NO remote is refused",
      r.status_code == 400 and "remote" in r.text, f"got {r.status_code}")

# Tals is a real SSH remote. Read-only root, so this checks the SSH refusal
# lands before anything else could go wrong.
r = s.post(f"{API}/git/push",
           json={"root": "projects", "path": "army/Tals/frontend"}, timeout=30)
check("push on a read-only root is refused", r.status_code == 403, f"got {r.status_code}")

print("\n── cleanup ─────────────────────────────────────────────────────────")
if os.path.exists(f"{REPO}/{F}"):
    os.remove(f"{REPO}/{F}")
subprocess.run(["git", "-C", REPO, "reset", "--hard", before_head],
               capture_output=True, text=True)
check("repo restored to where it started",
      g("rev-parse", "HEAD") == before_head and not os.path.exists(f"{REPO}/{F}"),
      g("rev-parse", "--short", "HEAD"))
check("and the tree is clean", not g("status", "--porcelain"))

print(f"\n{fails} FAILED" if fails else "\nall pass")
sys.exit(1 if fails else 0)
