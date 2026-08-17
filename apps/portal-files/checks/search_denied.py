#!/usr/bin/env python3
"""Can /search reach a file the explorer refuses to open?

This is the check that matters for the search endpoint, and it is the reason the
endpoint walks through safepath.collect() rather than doing its own os.walk.

The failure being tested for is specific and quiet. Every deny rule in
policy.toml stops a file being LISTED and OPENED. A search endpoint that walks
the tree itself would happily read the same file, find the string, and return the
matching LINE - so `.env` would still be excluded from the explorer while its
contents appeared in a result snippet. Nothing would look broken. The deny-list
would still be correct. The secret would still be on screen.

So this plants a unique token inside files that the policy denies for three
different reasons, and requires that searching for it finds only the one file
that is legitimately served:

    _search-probe/found.md          served      -> MUST be found
    _search-probe/secret-probe.txt  *secret*    -> MUST NOT be found
    _search-probe/.env.probe        .env.*      -> MUST NOT be found
    _search-probe/node_modules/x.md component   -> MUST NOT be found

It also checks the things that are behaviour rather than boundary: an anonymous
search is refused, `root=*` does not return the same file twice through the
overlapping `home` root, and a capped result set says so.

It plants its files with plain writes and removes them itself. Unlike e2e.py it
does NOT end in `git reset --hard`, so it is safe to run against a dirty tree.
"""
import os
import re
import shutil
import sys

import requests

BASE = "http://100.117.176.85"
API = f"{BASE}/-/api/files"
REPO = "/home/devssh/stacks"
PROBE_REL = "docs/kb/_search-probe"
PROBE_DIR = f"{REPO}/{PROBE_REL}"

# Long and unmistakable: the search runs over the whole repo, and a token that
# collided with real content would turn a boundary failure into a pass.
TOKEN = "zzq-search-probe-9f2a41c7-do-not-commit"

fails = 0


def check(label, ok, detail=""):
    global fails
    if not ok:
        fails += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label:<56} {detail}")


if os.path.exists(PROBE_DIR):
    sys.exit(f"REFUSING TO RUN: {PROBE_DIR} already exists - a previous run did "
             f"not clean up. Inspect it, then remove it.")

# ── plant ───────────────────────────────────────────────────────────────────
try:
    os.makedirs(f"{PROBE_DIR}/node_modules", exist_ok=False)
    files = {
        "found.md": f"# probe\n\nthis line holds {TOKEN} and is legitimately served\n",
        "secret-probe.txt": f"API_SECRET={TOKEN}\n",
        ".env.probe": f"PASSWORD={TOKEN}\n",
        "node_modules/x.md": f"{TOKEN}\n",
    }
    for rel, body in files.items():
        with open(f"{PROBE_DIR}/{rel}", "w") as fh:
            fh.write(body)

    # ── anonymous ───────────────────────────────────────────────────────────
    print("── anonymous ───────────────────────────────────────────────────────")
    anon = requests.Session()
    r = anon.get(f"{API}/search", params={"root": "stacks", "q": TOKEN}, timeout=20)
    check("anonymous search is refused", r.status_code in (401, 403), f"got {r.status_code}")

    # ── log in ──────────────────────────────────────────────────────────────
    print("\n── log in ──────────────────────────────────────────────────────────")
    s = requests.Session()
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

    # ── the boundary ────────────────────────────────────────────────────────
    #
    # THIS ASSERTION INVERTED ON 2026-08-17. Files matching the credential name
    # patterns are served now and marked instead - see [sensitive] in
    # policy.toml - so search finds them, and the thing being tested is that the
    # walk still agrees with resolve(). It always did; what changed is what
    # resolve() permits.
    #
    # The DIRECTORY rule did not change, and that is the half still worth
    # guarding: `node_modules` is pruned during the walk, so nothing inside it
    # can surface no matter what the content is.
    print("\n── search agrees with what resolve() now permits ────────────────────")
    r = s.get(f"{API}/search",
              params={"root": "stacks", "path": PROBE_REL, "q": TOKEN}, timeout=30)
    check("search answers", r.status_code == 200, f"got {r.status_code}")
    body = r.json() if r.status_code == 200 else {"matches": [], "names": []}
    hit_paths = {m["path"] for m in body.get("matches", [])}

    check("the served file IS found",
          f"{PROBE_REL}/found.md" in hit_paths, f"{sorted(hit_paths)}")
    for now_served, why in (("secret-probe.txt", "*secret* is a label, not a wall"),
                            (".env.probe", ".env.* is a label, not a wall")):
        check(f"now found: {now_served}",
              f"{PROBE_REL}/{now_served}" in hit_paths, why)
    check("NOT found: node_modules/x.md",
          f"{PROBE_REL}/node_modules/x.md" not in hit_paths,
          "denied path component - unchanged")

    # The name half of the response goes through the same walk, so it gets the
    # same assertion: a PRUNED DIRECTORY must not surface by name either.
    name_paths = {m["path"] for m in body.get("names", [])}
    check("no file from a pruned directory surfaces as a NAME hit",
          not any(p.startswith(f"{PROBE_REL}/node_modules/") for p in name_paths),
          f"{sorted(name_paths)}")

    # ── the overlapping root ────────────────────────────────────────────────
    print("\n── root=* must not return the same file twice ──────────────────────")
    r = s.get(f"{API}/search", params={"root": "*", "q": TOKEN}, timeout=60)
    check("search answers", r.status_code == 200, f"got {r.status_code}")
    if r.status_code == 200:
        b = r.json()
        check("`home` is excluded (it aliases the other roots)",
              "home" not in b["roots"], f"searched {b['roots']}")
        # Compared on the FILE, not on (root, path). Those two tuples differ for
        # the same file reached through two roots - `stacks/x.md` and
        # `home/stacks/x.md` - so a tuple-uniqueness test passes while every
        # result is shown twice, which is exactly the bug it was meant to catch.
        probe_hits = [m for m in b["matches"] if m["path"].endswith("_search-probe/found.md")]
        check("the probe file is returned exactly once", len(probe_hits) == 1,
              f"{[(m['root'], m['path']) for m in probe_hits]}")

    # ── honesty about caps ──────────────────────────────────────────────────
    print("\n── a capped result set says so ─────────────────────────────────────")
    # `e` appears in essentially every text file in the repo, so this is certain
    # to exceed any sane limit.
    r = s.get(f"{API}/search",
              params={"root": "stacks", "q": "e", "limit": "5"}, timeout=30)
    if r.status_code == 200:
        b = r.json()
        check("the limit is applied", len(b["matches"]) <= 5, f"{len(b['matches'])}")
        check("and it is REPORTED, not silent", b.get("truncated") is not None,
              f"{b.get('truncated')}")
    else:
        check("search answers", False, f"got {r.status_code}")

    # ── an unknown root is refused ──────────────────────────────────────────
    r = s.get(f"{API}/search", params={"root": "../../etc", "q": TOKEN}, timeout=10)
    check("an unknown root is refused", r.status_code == 400, f"got {r.status_code}")

finally:
    shutil.rmtree(PROBE_DIR, ignore_errors=True)

print()
print("OK - search cannot see what the explorer refuses to open."
      if not fails else f"{fails} check(s) FAILED")
sys.exit(1 if fails else 0)
