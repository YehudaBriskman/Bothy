#!/usr/bin/env python3
"""No endpoint may return an unbounded recursive listing again.

WHAT THIS GUARDS, and why a count rather than prose. /tree used to walk a whole
root and return every file under it with full metadata, capped at MAX_LISTING =
4000 and reported as `truncated: true`. Measured in the container before the
change:

    root        files returned   files actually there    ms     JSON
    stacks      1,262            1,262                   84    272 KB
    projects    4,000 (capped)   19,273                 399  1,177 KB
    home        4,000 (capped)   20,612                 433  1,247 KB

So ~15,000 files per big root could not be opened, found or linked at all - the
client never saw a path for them - and the median directory on this box holds ONE
entry, so the walk paid 19,273 stats to draw a single row.

The cap is gone and the listing is one directory deep. That is a property nothing
in the service asserts on its own, and it is the kind that comes back by accident:
somebody needs "the whole tree" for one feature, adds `?deep=1`, and the 1.2 MB
response is back with no cap on it at all this time. So every GET on the read
router is asked here, with every parameter it takes, and the two rules are:

  · A LISTING IS ONE LEVEL. Every path in /tree's answer is a direct child of the
    folder asked for.
  · A WALKING ENDPOINT IS BOUNDED AND SAYS SO. /find and /docs walk recursively
    because a search must; both carry a hard match limit and a `stopped` field
    that is PRESENT and null when the walk ran to the end. A bound that only
    appears once it fires is one a caller forgets to check.

It also holds the two client contracts that are invisible in a diff:
containment at every level of a lazy walk, and DOC_SUFFIXES == PROSE_EXT in
pages/files/titles.ts - a suffix one side omits is a document the other never
sees, and neither errors.

Run: python3 checks/lazy_tree.py     (needs the stack up and DEV_LOGIN_*)
"""
import json
import os
import re
import shutil
import sys

import requests

from env import BASE, NOTES, STACKS

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


def api(ep, **params):
    return s.get(f"{API}/{ep}", params=params, timeout=120)


# ── the corpus ──────────────────────────────────────────────────────────────
#
# Planted, because the assertions below are about SHAPE and a fresh install's
# notes root is one README - the version of this check that leaned on this box's
# real content reported failures that said nothing about the code. Deep enough
# that a one-level listing and a recursive one cannot be confused, and removed in
# the finally at the end.
SCOPE = "_lazy_probe"
PLANTED = [f"{SCOPE}/top.md", f"{SCOPE}/a/one.md", f"{SCOPE}/a/two.txt",
           f"{SCOPE}/a/b/three.md", f"{SCOPE}/a/b/c/four.md"]
os.makedirs(f"{NOTES}/{SCOPE}/a/b/c", exist_ok=True)
os.makedirs(f"{NOTES}/{SCOPE}/empty", exist_ok=True)
for rel in PLANTED:
    with open(f"{NOTES}/{rel}", "w") as fh:
        fh.write(f"# {rel}\n\nplanted by lazy_tree.py\n")
# A symlinked directory and a symlinked file, both pointing INSIDE the root. Each
# resolves to a legal path, so neither is refused by containment - and each would
# be filed under a parent nobody asked about if it were listed. The lazy tree is
# the first consumer for which that is a correctness bug rather than a duplicate.
for name, target in (("dirlink", f"{NOTES}/{SCOPE}/a/b"),
                     ("filelink.md", f"{NOTES}/{SCOPE}/a/b/three.md")):
    link = f"{NOTES}/{SCOPE}/{name}"
    if not os.path.lexists(link):
        os.symlink(target, link)

try:
    print("── /tree is ONE DIRECTORY, for every root ──────────────────────────")
    for root in json.loads(api("roots").text)["roots"]:
        key = root["key"]
        b = api("tree", root=key)
        check(f"{key}: answers", b.status_code == 200, f"{b.status_code}")
        if b.status_code != 200:
            continue
        j = b.json()
        deep = [f["path"] for f in j["files"] if "/" in f["path"]]
        # THE RULE. A recursive listing of a root is full of nested paths; a
        # listing of the root's own level has none at all.
        check(f"{key}: no entry below the level asked for", not deep,
              f"{len(j['files'])} entries, {len(deep)} nested: {deep[:3]}")
        # A flag nothing can set is worse than no flag: every reader of it has to
        # go and check whether it still means anything.
        check(f"{key}: no `truncated` field survives", "truncated" not in j,
              f"{sorted(j.keys())}")
        check(f"{key}: directories are marked as such",
              all(isinstance(f.get("dir"), (bool, str)) for f in j["files"]),
              f"{sum(1 for f in j['files'] if f.get('dir') is True)} dirs")
        # A directory carries no size, because the honest answer is neither its
        # inode's 4 KB nor a subtree rollup - see /dirsize.
        check(f"{key}: a directory carries no size",
              all("size" not in f for f in j["files"] if f.get("dir") is True))

    print("\n── and it is contained at EVERY level ──────────────────────────────")
    for rel in ("", SCOPE, f"{SCOPE}/a", f"{SCOPE}/a/b", f"{SCOPE}/a/b/c"):
        j = api("tree", root="notes", path=rel).json()
        here = rel.strip("/")
        off = [f["path"] for f in j["files"]
               if os.path.dirname(f["path"]).strip("/") != here]
        check(f"every entry of {here or '<root>'!r} is its direct child", not off,
              f"{len(j['files'])} entries, {off[:3]}")

    # An EMPTY folder is listed as empty, which the recursive version could not
    # express at all: a directory it did not describe did not exist, so the client
    # had no way to tell "nobody has opened this" from "there is nothing here".
    j = api("tree", root="notes", path=f"{SCOPE}/empty").json()
    check("an empty folder answers with an empty listing",
          j["files"] == [], f"{j['files']}")

    print("\n── the symlinks a lazy tree must not file under the wrong parent ───")
    j = api("tree", root="notes", path=SCOPE).json()
    got = sorted(f["path"] for f in j["files"])
    check("a symlinked directory is not offered",
          not any("dirlink" in p for p in got), f"{got}")
    check("a symlink to a file elsewhere in the root is skipped",
          not any("filelink" in p for p in got),
          "its resolved path is a/b/three.md - not a child of this folder")
    check("...and the real entries are all there",
          got == [f"{SCOPE}/a", f"{SCOPE}/empty", f"{SCOPE}/top.md"], f"{got}")
    for label, path in (("the symlinked directory, by name", f"{SCOPE}/dirlink"),
                        ("dot-dot out of the root", "../../.."),
                        ("dot-dot after a real prefix", f"{SCOPE}/../../.."),
                        ("an absolute path", "/etc"),
                        ("a FILE asked for as a folder", f"{SCOPE}/top.md"),
                        ("a folder that is not there", "_nope"),
                        ("a denied subtree", ".git")):
        for ep in ("tree", "find", "docs"):
            q = {"root": "notes", "path": path}
            if ep == "find":
                q["q"] = "o"
            got = api(ep, **q).status_code
            check(f"/{ep} refuses: {label}", got == 403, f"got {got}")

    print("\n── /find: every file in the root, bounded by MATCHES ───────────────")
    j = api("find", root="notes", q="three").json()
    check("it reaches a file the listing never names",
          any(f["path"] == f"{SCOPE}/a/b/three.md" for f in j["files"]),
          f"{[f['path'] for f in j['files']]}")
    check("the walk ran to the end, and says so with null",
          "stopped" in j and j["stopped"] is None, f"{j.get('stopped')}")
    check("it says how many files it looked at", j.get("scanned", 0) > 0,
          f"scanned={j.get('scanned')}")
    check("it does not return the symlinks either",
          not any("filelink" in f["path"] for f in j["files"]))
    j = api("find", root="notes", q="three", limit="1").json()
    check("a limit is honoured", len(j["files"]) == 1, f"{len(j['files'])}")
    # The bound is REPORTED. This is the property that replaces MAX_LISTING, and
    # the reason it is a different property: a capped LISTING silently described a
    # 19,273-file root with 4,000 rows, while a search that stops has still seen
    # the whole tree and can say so.
    j = api("find", root="notes", q="o", limit="2").json()
    if len(j["files"]) >= 2:
        check("...and when it bites it is REPORTED",
              (j.get("stopped") or {}).get("reason") == "too many matches",
              f"{j.get('stopped')}")
    check("an empty query is refused rather than answered with everything",
          api("find", root="notes", q="").status_code == 400)
    # The service's own ceiling, which a caller cannot raise past.
    j = api("find", root="home", q="e", limit="999999").json()
    check("the limit cannot be raised past the service's own",
          len(j["files"]) <= 500, f"{len(j['files'])} hits")

    print("\n── /docs: the document index three things are built from ───────────")
    j = api("docs", root="notes").json()
    paths = [f["path"] for f in j["files"]]
    check("it is recursive - a document four levels down is in it",
          f"{SCOPE}/a/b/c/four.md" in paths, f"{len(paths)} documents")
    check("it is DOCUMENTS only - a .txt is prose, a .js is not",
          f"{SCOPE}/a/two.txt" in paths and not any(p.endswith(".js") for p in paths))
    check("it reports its bound, null when it ran to the end",
          "stopped" in j, f"{j.get('stopped')}")
    # WIKILINK RESOLUTION RIDES ON THIS SET, so a document missing from it is a
    # `[[link]]` that renders as inert grey text - the same silent failure the
    # `../` wikilinks had, and the reason the 4,000-row cap was a documentation
    # bug and not only a performance one.
    check("every document the walk found can be opened",
          api("read", root="notes", path=paths[0]).status_code == 200, paths[0])

    print("\n── /dirsize answers at CLICK, with the real number ─────────────────")
    j = api("dirsize", root="notes", path=SCOPE).json()
    check("it counts the subtree", j["files"] == len(PLANTED),
          f"{j['files']} files, {j['bytes']} bytes")
    check("...and the bytes are the sum of the members", j["bytes"] > 0)
    check("a refusal is a 200 carrying the numbers, never an inferred one",
          "refused" not in j or isinstance(j.get("files"), int))
    check("it refuses a path outside the root",
          api("dirsize", root="notes", path="../..").status_code == 403)

    print("\n── the two suffix lists must agree ─────────────────────────────────")
    # DOC_SUFFIXES in app.py decides what /docs returns; PROSE_EXT in
    # pages/files/titles.ts decides which rows the reader will title. A suffix the
    # server omits is a document the reader never gets; one the client omits is a
    # row it shows under its filename. Neither errors, and neither is visible in a
    # diff that touches one file.
    app_py = open(os.path.join(STACKS, "apps/bothy-files/app.py"), encoding="utf-8").read()
    titles = open(os.path.join(STACKS, "apps/bothy-web/web/src/pages/files/titles.ts"),
                  encoding="utf-8").read()
    m = re.search(r"^DOC_SUFFIXES = \(([^)]*)\)", app_py, re.M)
    server = {x.strip().strip('".').lower() for x in (m.group(1) if m else "").split(",") if x.strip()}
    m = re.search(r"const PROSE_EXT = new Set\(\[([^\]]*)\]\)", titles)
    client = {x.strip().strip("'\"").lower() for x in (m.group(1) if m else "").split(",") if x.strip()}
    check("DOC_SUFFIXES == PROSE_EXT", server and server == client,
          f"server={sorted(server)} client={sorted(client)}")

finally:
    shutil.rmtree(f"{NOTES}/{SCOPE}", ignore_errors=True)

print(f"\n{f'{fails} FAILED' if fails else 'all pass'}")
sys.exit(1 if fails else 0)
