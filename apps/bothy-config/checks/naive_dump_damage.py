#!/usr/bin/env python3
"""The evidence for the design: what load-and-dump does to this repository.

Run: python3 checks/naive_dump_damage.py

yamlpatch.py refuses to re-serialise a document, and that refusal costs something
real - it means this service can only change values that already exist, never add
a key or reorder anything. A cost that size needs a measurement behind it rather
than an opinion, and it needs one that stays true: `ruamel.yaml` is a dependency
that gets upgraded, and "we tried that once and it was lossy" is not a thing
anybody can check.

So this runs the round-trip that yamlpatch does NOT do - with the SAME parser
configuration, not a straw man with default settings - and reports the damage.

── it fails when the damage reaches ZERO ───────────────────────────────────

Which looks backwards, so it is worth stating plainly. A green run here means
"the reasoning in yamlpatch.py's header still holds". A ruamel that round-trips
this repository losslessly would be good news and would also mean the header now
argues from a measurement that is no longer true - which is exactly the sort of
stale comment this repo's whole style is against. Failing sends someone to
re-read it and decide, rather than leaving a paragraph of confident prose that
quietly stopped being right.

It does NOT fail when the damage grows, and does not carry a baseline of which
files are damaged. Nothing here depends on WHICH files a round-tripper would
break, because nothing ever round-trips them; a baseline would be a file to keep
in step with no property behind it.
"""
import difflib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))

import yamlpatch  # noqa: E402

from noop_bytes import yaml_files  # noqa: E402


def comment_lines(text: str) -> int:
    return sum(1 for ln in text.splitlines() if ln.lstrip().startswith("#"))


def main() -> int:
    damaged = 0
    lost_comments = 0
    lost_bytes = 0
    worst = []

    for path in yaml_files():
        rel = os.path.relpath(path, REPO)
        text = open(path, encoding="utf-8").read()
        try:
            out = yamlpatch.naive_dump(text)
        except Exception as e:  # noqa: BLE001
            print(f"      {rel}: round-trip raised {type(e).__name__}: {e}")
            damaged += 1
            continue
        if out == text:
            continue
        damaged += 1
        dc = comment_lines(text) - comment_lines(out)
        db = len(text.encode()) - len(out.encode())
        lost_comments += max(dc, 0)
        lost_bytes += max(db, 0)
        changed = sum(1 for ln in difflib.unified_diff(
            text.splitlines(True), out.splitlines(True), n=0)
            if ln.startswith(("+", "-")) and not ln.startswith(("+++", "---")))
        worst.append((dc, db, changed, rel))

    for dc, db, changed, rel in sorted(worst, reverse=True):
        note = (f"{dc} comment lines destroyed" if dc
                else "comments kept, but reformatted")
        print(f"  {rel:<44} {changed:>4} lines rewritten, {db:>6} bytes lost"
              f"  ({note})")

    total = len(yaml_files())
    print()
    print(f"load-and-dump damages {damaged} of {total} YAML files: "
          f"{lost_comments} comment lines and {lost_bytes} bytes destroyed")
    if damaged == 0:
        print("FAIL: the round-tripper is now lossless on this corpus.")
        print("      That is good news and it makes yamlpatch.py's header stale.")
        print("      Re-read it and decide whether the splice is still the right")
        print("      design before deleting this check.")
        return 1
    print("PASS: the naive approach still destroys content, so yamlpatch.py's")
    print("      refusal to re-serialise is still buying something.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
