#!/usr/bin/env python3
"""Does /links describe the document graph that is actually there?

The endpoint answers one question for the reader - "3 documents link here" - and
every way it can be wrong is quiet. A missed edge reads as an orphan page. An
invented edge sends someone to a document that never mentioned theirs. And an
index built from its own os.walk would happily hold a file the explorer refuses
to open, which is the failure checks/search_denied.py exists for, one endpoint
along.

So this plants a small corpus with one instance of every case that matters and
asserts the exact graph:

    a.md               inline [b](b.md), wiki [[deep/c]], an http link, an
                       unresolvable target, a bare #anchor, and a link inside a
                       FENCED BLOCK - only the first two may become edges
    b.md               no links; receives two
    deep/c.md          [[b]] - a wikilink that must match on BASENAME from a
                       subdirectory, the shape claude-notes is written in
    fenced-only.md     linked ONLY from inside a code fence - must be an orphan
    no-heading.md      no `# heading`; its title comes from the filename
    .env               a credential store, and linked to from a.md
    node_modules/x.md  markdown, inside a DENIED directory

WHERE IT PLANTS THEM, and this is deliberate: a probe directory in $HOME, read
through the `home` root, NOT inside ~/stacks or ~/claude-notes. Those two are git
repositories that this same service holds writable handles on, and a check that
leaves a stray file in one of them dirties a tree somebody is working in - a
previous agent's probe destroyed ~/stacks/.env doing exactly this. Nothing here
writes inside a repo, and the directory is removed in a `finally`.
"""
import json
import os
import re
import shutil
import sys
import time

import requests

BASE = "http://100.117.176.85"
API = f"{BASE}/-/api/files"
# Under $HOME rather than under either repo - see the module docstring. Named so
# that a leftover from a crashed run is unmistakable and greppable.
PROBE_REL = "_bothy-links-probe-4c81de"
PROBE_DIR = f"/home/devssh/{PROBE_REL}"

fails = 0


def check(label, ok, detail=""):
    global fails
    if not ok:
        fails += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label:<56} {detail}")


def write(rel, body):
    path = f"{PROBE_DIR}/{rel}"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(body)


if os.path.exists(PROBE_DIR):
    sys.exit(f"REFUSING TO RUN: {PROBE_DIR} already exists - a previous run did "
             f"not clean up. Inspect it, then remove it.")

FILES = {
    "a.md": (
        "# Alpha\n\n"
        "An inline link to [Beta](b.md) and a wikilink to [[deep/c]].\n"
        "A web link to [example](https://example.com/x.md) and a protocol-relative\n"
        "one to [cdn](//example.net/y.md), plus a bare [anchor](#alpha).\n"
        "A link to a file that is not there: [gone](nowhere.md).\n"
        "And to a credential store: [env](.env).\n"
        "An inline code span is not a link: `[code](fenced-only.md)`\n\n"
        "```sh\n"
        "# a code SAMPLE, not a link: [fenced](fenced-only.md) and [[fenced-only]]\n"
        "```\n"
    ),
    "b.md": "# Beta\n\nNothing links out of here.\n",
    "deep/c.md": "# Gamma\n\nA basename wikilink back to [[b]].\n",
    "fenced-only.md": "# Fenced only\n\nOnly ever linked from inside a fence.\n",
    "no-heading.md": "just prose, no heading at all\n",
    ".env": "PROBE_API_TOKEN=zzq-links-probe-not-a-real-secret-0001\n",
    "node_modules/x.md": "# Hidden\n\nLinks to [Alpha](../a.md).\n",
}

try:
    for rel, body in FILES.items():
        write(rel, body)

    # ── anonymous ───────────────────────────────────────────────────────────
    print("── anonymous ───────────────────────────────────────────────────────")
    r = requests.get(f"{API}/links", params={"root": "home", "path": PROBE_REL},
                     timeout=20)
    check("anonymous /links is refused", r.status_code in (401, 403),
          f"got {r.status_code}")

    # ── log in ──────────────────────────────────────────────────────────────
    print("\n── log in ──────────────────────────────────────────────────────────")
    s = requests.Session()
    r = s.get(f"{BASE}/oauth2/start", params={"rd": "/"}, allow_redirects=True,
              timeout=10)
    m = re.search(r'action="([^"]+)"', r.text)
    if not m:
        sys.exit("FAIL: no Keycloak login form")
    s.post(m.group(1).replace("&amp;", "&"),
           data={"username": os.environ["DEV_LOGIN_USER"],
                 "password": os.environ["DEV_LOGIN_PASSWORD"]},
           allow_redirects=True, timeout=10)
    check("session established",
          any(c.name.startswith("_oauth2_proxy") for c in s.cookies))

    def graph(**extra):
        r = s.get(f"{API}/links",
                  params={"root": "home", "path": PROBE_REL, **extra}, timeout=60)
        if r.status_code != 200:
            check("/links answers", False, f"got {r.status_code}: {r.text[:200]}")
            return {"docs": {}, "cached": None}
        b = r.json()
        # Re-key on paths relative to the PROBE, so the assertions below read as
        # the corpus above rather than as $HOME paths. Edge lists are rewritten
        # too - a half-stripped graph is one whose `in` lists no longer name keys
        # of `docs`, which is a bug in this file that would look like one in the
        # endpoint.
        def strip(p):
            return p[len(PROBE_REL) + 1:] if p.startswith(PROBE_REL + "/") else p
        return {**b, "docs": {
            strip(p): {**d,
                       "out": [strip(x) for x in d["out"]],
                       "in": [strip(x) for x in d["in"]]}
            for p, d in b["docs"].items()}}

    print("\n── the graph ───────────────────────────────────────────────────────")
    b = graph()
    docs = b["docs"]
    out_a = docs.get("a.md", {}).get("out", [])

    check("an inline link becomes an edge", "b.md" in out_a, f"a.md -> {out_a}")
    check("a wikilink becomes an edge", "deep/c.md" in out_a, f"a.md -> {out_a}")
    check("a link inside a FENCE is not an edge", "fenced-only.md" not in out_a,
          f"a.md -> {out_a}")
    check("an http:// link is not an edge",
          not any("example" in t for t in out_a), f"a.md -> {out_a}")
    check("a bare #anchor is not an edge", "a.md" not in out_a, f"a.md -> {out_a}")
    check("an unresolvable target is not an edge",
          "nowhere.md" not in out_a and "nowhere.md" not in docs, f"a.md -> {out_a}")
    check("and nothing else got in either", sorted(out_a) == ["b.md", "deep/c.md"],
          f"a.md -> {out_a}")

    # ── the boundary ────────────────────────────────────────────────────────
    #
    # The index is built from safepath.collect(), so a file the walk refuses is
    # not a node - and because link targets are resolved by LOOKUP in that index
    # rather than against the filesystem, it cannot be an edge either. Both halves
    # are asserted: absent as a document, absent as a target.
    print("\n── what must never appear in an index ──────────────────────────────")
    every_target = {t for d in docs.values() for t in d["out"]}
    check("a markdown file in node_modules/ is not indexed",
          "node_modules/x.md" not in docs, f"{sorted(docs)}")
    check("...and cannot be a link target either",
          "node_modules/x.md" not in every_target, f"{sorted(every_target)}")
    check("a credential store is not a document", ".env" not in docs)
    check("...and a link to one is not an edge", ".env" not in every_target,
          f"{sorted(every_target)}")
    check("only markdown is indexed",
          all(p.endswith((".md", ".markdown")) for p in docs), f"{sorted(docs)}")

    # ── inversion ───────────────────────────────────────────────────────────
    print("\n── `in` is the exact inverse of `out` ──────────────────────────────")
    inverse: dict[str, list[str]] = {p: [] for p in docs}
    for src, d in docs.items():
        for dst in d["out"]:
            inverse[dst].append(src)
    mismatch = {p: (sorted(d["in"]), sorted(inverse[p]))
                for p, d in docs.items() if sorted(d["in"]) != sorted(inverse[p])}
    check("every `in` list is exactly the inverted `out`", not mismatch,
          json.dumps(mismatch) if mismatch else f"{len(docs)} documents")
    check("a wikilink matches on BASENAME from a subdirectory",
          docs.get("deep/c.md", {}).get("out") == ["b.md"],
          f"deep/c.md -> {docs.get('deep/c.md', {}).get('out')}")
    check("b.md reports both documents that link to it",
          sorted(docs.get("b.md", {}).get("in", [])) == ["a.md", "deep/c.md"],
          f"{docs.get('b.md', {}).get('in')}")
    check("the fence-only document is an orphan",
          docs.get("fenced-only.md", {}).get("in") == [],
          f"{docs.get('fenced-only.md', {}).get('in')}")

    # ── titles ──────────────────────────────────────────────────────────────
    print("\n── titles ──────────────────────────────────────────────────────────")
    check("the first heading is the title",
          docs.get("b.md", {}).get("title") == "Beta",
          f"{docs.get('b.md', {}).get('title')!r}")
    check("no heading falls back to the prettified filename",
          docs.get("no-heading.md", {}).get("title") == "No heading",
          f"{docs.get('no-heading.md', {}).get('title')!r}")

    # ── the cache ───────────────────────────────────────────────────────────
    #
    # Keyed on (max mtime, file count) over the walk, so the two invalidations
    # worth having are tested separately: an EDIT moves the maximum, a DELETE does
    # not and is caught by the count. The second is the one a mtime-only key
    # would miss, which is why it is not folded into the first.
    print("\n── the cache: same answer twice, different after a change ──────────")
    again = graph()
    check("the second request is served from cache", again.get("cached") is True,
          f"cached={again.get('cached')}")
    check("...and says exactly the same thing",
          again["docs"] == docs and again["scanned"] == b["scanned"])

    # mtime has one-second granularity on some filesystems, and the key is the
    # MAXIMUM mtime - so an edit within the same second as the walk would leave
    # the key unchanged and the assertion below would fail for a reason that is
    # not a bug in the cache.
    time.sleep(1.1)
    with open(f"{PROBE_DIR}/b.md", "a") as fh:
        fh.write("\nNow it links to [Alpha](a.md).\n")
    edited = graph()
    check("an EDIT invalidates it (max mtime moved)",
          edited.get("cached") is False, f"cached={edited.get('cached')}")
    check("...and the new edge is there",
          edited["docs"].get("b.md", {}).get("out") == ["a.md"],
          f"b.md -> {edited['docs'].get('b.md', {}).get('out')}")

    os.unlink(f"{PROBE_DIR}/no-heading.md")
    deleted = graph()
    check("a DELETE invalidates it too (the count fell)",
          deleted.get("cached") is False, f"cached={deleted.get('cached')}")
    check("...and the document is gone from the index",
          "no-heading.md" not in deleted["docs"], f"{sorted(deleted['docs'])}")

    # ── honesty and refusals ────────────────────────────────────────────────
    print("\n── refusals and shape ──────────────────────────────────────────────")
    check("truncation is always reported, null when nothing was cut",
          "truncated" in b and b["truncated"] is None, f"{b.get('truncated')}")
    r = s.get(f"{API}/links", params={"root": "../../etc"}, timeout=10)
    check("an unknown root is refused", r.status_code == 400, f"got {r.status_code}")
    r = s.get(f"{API}/links", params={"root": "home", "path": "../etc"}, timeout=20)
    check("a path escaping the root is refused", r.status_code == 403,
          f"got {r.status_code}")

finally:
    shutil.rmtree(PROBE_DIR, ignore_errors=True)

print()
print("OK - the link graph matches the corpus, and holds nothing the explorer hides."
      if not fails else f"{fails} check(s) FAILED")
sys.exit(1 if fails else 0)
