#!/usr/bin/env python3
"""`/tree?path=` lists exactly that folder - and cannot leave the root.

WHY THIS EXISTS AS ITS OWN FILE. `path` was accepted and silently IGNORED first:
a client asking for a subtree got the whole root back and no way to tell. That is
the worst of the three possible behaviours, and it survived because nothing
asserted either half - not that it worked, and not that it was contained.

ITS MEANING CHANGED IN 2026-10 and the assertions below changed with it. It used
to SCOPE a recursive walk ("everything under this folder", capped at 4,000 rows);
it now names THE ONE FOLDER to list. The containment half is unchanged and is
still the half that matters, so the traversal table at the bottom is untouched -
every shape there is a way the check could be written wrongly and still look right
on the happy path.

What moved out of here: the depth property ("no entry below the level asked for",
for every root), the symlink cases a lazy tree newly depends on, and the bounds on
the walking endpoints that replaced the cap. Those are checks/lazy_tree.py, which
is about the listing being one level deep rather than about `path` working.
"""
import os
import re
import shutil
import sys

import requests

# One resolver for the whole suite - checks/env.py. These were literals in
# twelve files, which put this node's tailnet address in a public repo and
# made the suite unrunnable by anyone but its author.
from env import BASE, NOTES
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


# ── plant the tree this checks against ──────────────────────────────────────
#
# It used to scope into `network/` and require the whole root to hold more than
# ten files - which is a description of THIS box's claude-notes, not of a notes
# root. On a fresh install that directory is a new repo holding one README, so
# the check reported "the whole root still lists everything: 1 files" as a
# failure when nothing was wrong, and then died on a KeyError when the scoped
# listing 403'd for a folder that does not exist.
#
# Planting is the only version that can run anywhere. SCOPE is a directory this
# file owns, deep enough to test scoping and wide enough that the whole root is
# strictly larger, and it is removed in the finally at the end.
SCOPE = "_tree_scope_probe"
PLANTED = [f"{SCOPE}/a.md", f"{SCOPE}/b.md", f"{SCOPE}/deep/c.md",
           "_tree_scope_outside.md"]
os.makedirs(f"{NOTES}/{SCOPE}/deep", exist_ok=True)
for rel in PLANTED:
    with open(f"{NOTES}/{rel}", "w") as fh:
        fh.write(f"# {rel}\n\nplanted by tree_scope.py\n")

try:
    print("── `path` names the folder, and is not ignored ─────────────────────")
    whole = tree("notes").json()
    sub = tree("notes", SCOPE).json()
    # The root's own level holds the probe DIRECTORY plus whatever else is at the
    # top of the notes root; the probe folder holds its own three entries. Both are
    # small now - that is the change - so the assertion is about WHICH entries came
    # back rather than about one list being shorter than the other.
    check("the root's listing names the probe FOLDER, not its files",
          any(f["path"] == SCOPE and f.get("dir") is True for f in whole["files"]),
          f"{sorted(f['path'] for f in whole['files'])[:6]}")
    check("...and does not reach inside it",
          not any(f["path"].startswith(f"{SCOPE}/") for f in whole["files"]))
    # The bug this file was written for: `path` used to be ignored entirely, so a
    # scoped request and an unscoped one answered identically.
    check("a listing of the folder is a DIFFERENT answer",
          sorted(f["path"] for f in sub["files"]) != sorted(f["path"] for f in whole["files"]),
          f"{sorted(f['path'] for f in sub['files'])}")
    check("every entry is inside the folder asked for",
          sub["files"] and all(f["path"].startswith(f"{SCOPE}/") for f in sub["files"]),
          f"{sorted({f['path'].split('/')[0] for f in sub['files']})}")
    # Root-relative, because every other endpoint speaks root-relative paths and a
    # client that opened a folder still has to be able to OPEN what it finds.
    one = next(f["path"] for f in sub["files"] if f.get("dir") is not True)
    check("paths stay ROOT-relative, so they can still be opened",
          s.get(f"{API}/read", params={"root": "notes", "path": one}, timeout=20).status_code == 200,
          one)
    check("the response echoes the folder", sub.get("path") == SCOPE, sub.get("path"))

    print("\n── and cannot leave the root ───────────────────────────────────────")
    for label, path in [
        ("dot-dot out of the root", "../../../etc"),
        ("dot-dot after a real prefix", f"{SCOPE}/../../.."),
        ("an absolute path", "/etc"),
        ("a path that is a FILE, not a folder", "README.md"),
        ("a folder that does not exist", "no-such-folder"),
    ]:
        got = tree("notes", path).status_code
        check(f"refused: {label}", got == 403, f"got {got}")

    # An empty `path` is the root, not an error: it is what the UI sends when you
    # climb back out, and 403 there would break the way back.
    check("an empty path is the root itself",
          sorted(f["path"] for f in tree("notes", "").json()["files"])
          == sorted(f["path"] for f in whole["files"]))

    print("\n── the point of it: no root is expensive to open any more ──────────")
    import time
    # THE ASSERTION USED TO BE A RATIO - "scoping a large root returns four times
    # fewer entries" - and it was skipped on a fresh install because a one-file
    # `home` made the comparison meaningless. There is nothing to compare now: a
    # listing of the root and a listing of a folder inside it are the same shape
    # and the same cost, which is the whole change. So the assertion is the
    # absolute one the ratio was standing in for.
    t0 = time.time(); big = tree("home").json(); t_big = int((time.time() - t0) * 1000)
    t0 = time.time(); small = tree("home", "stacks").json(); t_small = int((time.time() - t0) * 1000)
    # 400ms was the MEASURED cost of opening `home` before this change (20,612
    # files walked, 4,000 returned, 1.25 MB). One directory is now 2ms. The
    # threshold is deliberately loose - this is guarding against the recursive walk
    # coming back, not policing latency on a busy box.
    check("opening the biggest root is cheap", t_big < 200, f"{t_big}ms")
    check("...and so is a folder inside it", t_small < 200, f"{t_small}ms")
    check("neither is a recursive listing",
          not any("/" in f["path"] for f in big["files"]),
          f"root: {len(big['files'])} entries")
    check("...including the folder's own",
          all(f["path"].startswith("stacks/") and f["path"].count("/") == 1
              for f in small["files"]),
          f"stacks: {len(small['files'])} entries")

finally:
    # Planted above. Removed here so a failure part-way through does not leave a
    # probe directory in somebody's notes.
    shutil.rmtree(f"{NOTES}/{SCOPE}", ignore_errors=True)
    try:
        os.remove(f"{NOTES}/_tree_scope_outside.md")
    except OSError:
        pass

print(f"\n{f'{fails} FAILED' if fails else 'all pass'}")
sys.exit(1 if fails else 0)
