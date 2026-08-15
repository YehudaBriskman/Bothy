#!/usr/bin/env python3
"""Git is VIEW-ONLY. The mutating endpoints must be gone, not merely unused.

Stage, unstage, discard, commit, pull and push were removed on 2026-08-15. Git
actions move to an in-browser command surface, and keeping a second narrower
path to them here would be a duplicate to secure and to keep in sync.

This file used to exercise those verbs. It now asserts they are UNREACHABLE,
which is a different and more useful claim: a UI that stops calling an endpoint
leaves the endpoint standing, and an endpoint nobody calls is one nobody watches.

The reads it still checks - /repos, /status, /git/diff - are the whole remaining
surface.
"""
import os
import re
import subprocess
import sys

import requests

BASE = "http://100.117.176.85"
API = f"{BASE}/-/api/files"
REPO = "/home/devssh/claude-notes"
F = "_git-view-probe.md"

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

print("── the mutating verbs must be GONE ─────────────────────────────────")
# Each of these was a working endpoint. Removing the UI's buttons would leave
# them reachable by anyone who knew the path, so the assertion is on the SERVICE.
for verb in ("stage", "unstage", "discard", "commit", "pull", "push"):
    r = s.post(f"{API}/git/{verb}",
               json={"root": "notes", "path": F, "message": "x", "confirm": True},
               timeout=20)
    # 404 from the service, or a Traefik-level refusal - either means unroutable.
    # NOT 200, and NOT the SPA's catch-all 200 either, which is why the body is
    # checked too.
    gone = r.status_code in (404, 405) or (
        r.status_code == 200 and "<title>Bothy" in r.text)
    check(f"/git/{verb} is unreachable", gone, f"got {r.status_code}")

check("and nothing was written by trying",
      not os.path.exists(f"{REPO}/{F}") and g("rev-parse", "HEAD") == before_head)

print("\n── what remains is reading, and it still works ─────────────────────")
open(f"{REPO}/{F}", "w").write("# probe\n")

r = s.get(f"{API}/status", params={"root": "notes"}, timeout=20)
check("/status lists the change", r.status_code == 200
      and any(f and F in (f.get("path") or "") for f in r.json().get("files", [])),
      f"got {r.status_code}")

r = s.get(f"{API}/repos", params={"root": "notes"}, timeout=20)
check("/repos still reports the repo", r.status_code == 200
      and len(r.json().get("repos", [])) >= 1, f"got {r.status_code}")

# A diff needs a TRACKED change - an untracked file has nothing to diff against.
subprocess.run(["git", "-C", REPO, "add", F], capture_output=True)
subprocess.run(["git", "-C", REPO, "-c", "user.name=probe",
                "-c", "user.email=probe@local", "commit", "-m", "probe"],
               capture_output=True)
open(f"{REPO}/{F}", "w").write("# probe\n# changed\n")
r = s.get(f"{API}/git/diff", params={"root": "notes", "path": F}, timeout=20)
check("/git/diff still returns a diff",
      r.status_code == 200 and "+# changed" in (r.json().get("diff") or ""),
      f"got {r.status_code}")

print("\n── cleanup ─────────────────────────────────────────────────────────")
if os.path.exists(f"{REPO}/{F}"):
    os.remove(f"{REPO}/{F}")
subprocess.run(["git", "-C", REPO, "reset", "--hard", before_head], capture_output=True)
check("repo restored", g("rev-parse", "HEAD") == before_head and not g("status", "--porcelain"),
      g("rev-parse", "--short", "HEAD"))

print(f"\n{fails} FAILED" if fails else "\nall pass")
sys.exit(1 if fails else 0)
