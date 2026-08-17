#!/usr/bin/env python3
"""A patch changes ONE line, and the comments survive it.

Run: python3 checks/patch_one_line.py

noop_bytes.py proves a patch that changes nothing changes nothing. This proves
the other half: a patch that DOES change something changes exactly one thing.

The corpus is every real compose file in the repository that declares a patchable
label, so the assertions are made against files written by people rather than
against a fixture written alongside the code.

Four assertions per patch, and each catches something the others cannot:

  the diff is exactly one line       a whole-file rewrite is the failure mode
  the comment count is unchanged     754 comment lines are the thing at risk
  every comment's TEXT is unchanged  a count survives "# a" becoming "# b"
  the value reads back exactly       the splice landed where the locator said

The third is the one worth spelling out. Counting comments would pass a
round-tripper that kept every comment and re-indented all of them, or one that
moved a trailing comment to its own line - both of which are whole-file diffs
nobody would read. Comparing the text catches that; the count alone does not.
"""
import difflib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))

import yamlpatch  # noqa: E402

from noop_bytes import FIELDS, yaml_files  # noqa: E402

# Values chosen to be awkward rather than convenient.
#
#   the middle dot   every real value on this box uses one (`Edge · Traefik`), so
#                    a byte-offset bug shows up as mojibake or a broken span the
#                    moment the value stops being pure ASCII;
#   the long one     crosses the emitter's default 80-column wrap point, which is
#                    what a re-serialising implementation would reflow;
#   the brackets     YAML flow-sequence indicators, harmless inside a plain
#                    scalar that does not START with one - which is exactly the
#                    kind of thing an over-eager blocklist would refuse.
EXPRESSIBLE = [
    "Renamed · By A Form",
    "Edge · Traefik (v3)",
    "Database · Postgres [primary]",
    "a considerably longer value than anything in this repository today, well "
    "past the point at which an emitter would wrap it",
]

# Values a PLAIN YAML scalar cannot carry, which must be REFUSED rather than
# written as something shorter. This half of the check is the more valuable one:
# §8 of docs/plans/editing-model.md refuses "a form that silently drops what it
# did not understand", and these are the two ways a value silently shrinks.
#
#   " #"   opens a comment, so `a # b` reads back as `a`
#   ": "   opens a mapping, so the label stops being a string at all
#
# The failure being guarded against is not an exception - it is a 200 with a file
# on disk saying something the person did not type.
MUST_REFUSE = [
    "a value with a # hash in it",
    "a value with a: colon in it",
    "a value ending in a colon:",
]


def comments(text: str) -> list[str]:
    """Every comment LINE, stripped, in order.

    Whole-line comments only. A trailing comment on a value line cannot be
    compared this way - the line it sits on is the line a patch is allowed to
    change - and comparing it would make a legitimate patch of a labelled value
    with a trailing comment fail. Every one of the 754 lines this exists to
    protect is a whole-line comment.
    """
    return [ln.strip() for ln in text.splitlines() if ln.lstrip().startswith("#")]


def main() -> int:
    bad = 0
    checked = 0

    for path in yaml_files():
        rel = os.path.relpath(path, REPO)
        text = open(path, encoding="utf-8").read()
        try:
            sites = yamlpatch.locate(text, FIELDS)
        except yamlpatch.RewriteRefused:
            continue
        if not sites:
            continue

        before_comments = comments(text)
        for site in sites:
            # The refusals first, because a silent shrink is the worse failure.
            for value in MUST_REFUSE:
                checked += 1
                label = f"{rel} {site.field} on {site.service} -> {value[:28]!r}"
                try:
                    out = yamlpatch.splice(text, site, value)
                except yamlpatch.RewriteRefused:
                    continue
                back = [s for s in yamlpatch.locate(out, FIELDS)
                        if s.service == site.service and s.field == site.field]
                print(f"FAIL  {label}: written rather than refused, and reads "
                      f"back as {[s.value for s in back]!r}")
                bad += 1

            for value in EXPRESSIBLE:
                checked += 1
                label = f"{rel} {site.field} on {site.service} -> {value[:28]!r}"
                try:
                    out = yamlpatch.splice(text, site, value)
                except yamlpatch.RewriteRefused as e:
                    print(f"FAIL  {label}: refused - {e}")
                    bad += 1
                    continue

                d = [ln for ln in difflib.unified_diff(
                    text.splitlines(True), out.splitlines(True), n=0)
                    if ln.startswith(("+", "-")) and not ln.startswith(("+++", "---"))]
                if len(d) != 2:                      # one removal, one addition
                    print(f"FAIL  {label}: the diff is {len(d) // 2} lines, not 1")
                    bad += 1
                    continue

                after_comments = comments(out)
                if after_comments != before_comments:
                    lost = len(before_comments) - len(after_comments)
                    print(f"FAIL  {label}: comments changed "
                          f"({len(before_comments)} -> {len(after_comments)}, "
                          f"{lost} lost)")
                    bad += 1
                    continue

                back = [s for s in yamlpatch.locate(out, FIELDS)
                        if s.service == site.service and s.field == site.field]
                if len(back) != 1 or back[0].value != value:
                    print(f"FAIL  {label}: reads back as "
                          f"{[s.value for s in back]!r}")
                    bad += 1
                    continue

    print()
    print(f"{checked} patches across the repository's real compose files")
    if bad:
        print(f"FAIL: {bad} of them changed more than the one value")
        return 1
    print("PASS: every patch changed exactly one line and left every comment "
          "byte-identical")
    return 0


if __name__ == "__main__":
    sys.exit(main())
