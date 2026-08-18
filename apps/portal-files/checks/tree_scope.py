#!/usr/bin/env python3
"""`/tree?path=` narrows the listing to one folder - and cannot leave it.

WHY THIS EXISTS AS ITS OWN FILE. `path` was accepted and silently IGNORED
before: a client asking for a subtree got the whole root back and no way to tell.
That is the worst of the three possible behaviours, and it survived because
nothing asserted either half - not that scoping works, and not that it is
contained.

The containment half is the one that matters. `path` is client-supplied and it
names a DIRECTORY, which resolve() does not answer for, so listing() does its own
realpath comparison. Every traversal shape below is a way that check could be
written wrongly and still look right on the happy path.
"""
import os
import re
import sys

import requests

# One resolver for the whole suite - checks/env.py. These were literals in
# twelve files, which put this node's tailnet address in a public repo and
# made the suite unrunnable by anyone but its author.
from env import BASE
API = f"{BASE}/-/api/files"

fails = 0


def check(label, ok, detail=""):
    global fails
    if not ok:
        fails += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label:<58} {detail}")


s = requests.Session()
r = s.get(f"{BASE}/oauth2/start", params={"rd": "/"}, allow_redirects=True, timeout=10)
m = re.search(r'action="([^"]+)"', r.text)
if m:
    s.post(m.group(1).replace("&amp;", "&"),
           data={"username": os.environ["DEV_LOGIN_USER"],
                 "password": os.environ["DEV_LOGIN_PASSWORD"]},
           allow_redirects=True, timeout=15)


def tree(root, path=None):
    p = {"root": root}
    if path is not None:
        p["path"] = path
    return s.get(f"{API}/tree", params=p, timeout=90)


print("── scoping actually scopes ─────────────────────────────────────────")
whole = tree("notes").json()
sub = tree("notes", "network").json()
check("the whole root still lists everything", len(whole["files"]) > 10, f"{len(whole['files'])} files")
check("a scoped listing is SMALLER", 0 < len(sub["files"]) < len(whole["files"]),
      f"{len(sub['files'])} files")
# The bug this file was written for: `path` used to be ignored entirely.
check("...and is not just the whole root again",
      len(sub["files"]) != len(whole["files"]))
check("every entry is inside the scope",
      all(f["path"].startswith("network/") for f in sub["files"]),
      f"{sorted({f['path'].split('/')[0] for f in sub['files']})}")
# Root-relative, because every other endpoint speaks root-relative paths and a
# client that scoped in still has to be able to OPEN what it finds.
one = sub["files"][0]["path"]
check("paths stay ROOT-relative, so they can still be opened",
      s.get(f"{API}/read", params={"root": "notes", "path": one}, timeout=20).status_code == 200,
      one)
check("the response echoes the scope", sub.get("path") == "network", sub.get("path"))

print("\n── and cannot leave the root ───────────────────────────────────────")
for label, path in [
    ("dot-dot out of the root", "../../../etc"),
    ("dot-dot after a real prefix", "network/../../.."),
    ("an absolute path", "/etc"),
    ("a path that is a FILE, not a folder", "README.md"),
    ("a folder that does not exist", "no-such-folder"),
]:
    got = tree("notes", path).status_code
    check(f"refused: {label}", got == 403, f"got {got}")

# The empty scope is the whole root, not an error: it is what the UI sends when
# you climb back out, and 403 there would break the way back.
check("an empty scope is the whole root", len(tree("notes", "").json()["files"]) == len(whole["files"]))

print("\n── the point of it: a big root becomes a small one ─────────────────")
import time
t0 = time.time(); big = tree("home").json(); t_big = int((time.time() - t0) * 1000)
t0 = time.time(); small = tree("home", "claude-notes").json(); t_small = int((time.time() - t0) * 1000)
check("scoping a large root returns far fewer entries",
      len(small["files"]) * 4 < len(big["files"]),
      f"{len(big['files'])} -> {len(small['files'])}")
# The walk STARTS at the scope rather than filtering a full listing, which is
# the whole reason this is a server change and not a client one.
check("...and is faster, because the walk starts there",
      t_small * 2 < t_big or t_big < 60, f"{t_big}ms -> {t_small}ms")

print(f"\n{f'{fails} FAILED' if fails else 'all pass'}")
sys.exit(1 if fails else 0)
