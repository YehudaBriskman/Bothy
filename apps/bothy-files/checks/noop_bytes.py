#!/usr/bin/env python3
"""THE GATE. A patch that changes nothing must change no bytes.

Run: python3 checks/noop_bytes.py

This is the first check written and the one every other property depends on. If
it does not pass across the whole repository, no field is safe to edit and the
service should not ship - so it runs first in run.sh and it fails hard.

── what it actually asserts, and why that is not the obvious thing ─────────

The naive version of this test - "load it, dump it, diff it" - would be testing
the round-tripper. This service does not have a round-tripper; it has a locator
and a splice, and the failure mode that matters is a locator reporting the wrong
SPAN. A span one character short leaves a stray quote; a span one character long
eats the following character. Both produce a file that still parses, and neither
shows up as an exception.

So the assertion is: for every patchable value in every YAML file in the repo,
splice the value back over itself and require the result to be byte-identical to
the original. That exercises locate() and splice() together over real content,
and a wrong span cannot survive it.

The corpus is the repository, not a fixture. A fixture would be written by the
same person who wrote the locator and would agree with it.

── it also asserts that reading everything is harmless ─────────────────────

Every YAML file under the root is opened and parsed, including the ones policy
refuses to patch. A parse failure on one of them is reported rather than ignored:
this service must be able to answer "what is patchable here" for any file the UI
might ask about, and "it crashed" is not an answer.
"""
import difflib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))  # checks -> svc -> apps -> repo

import yamlpatch  # noqa: E402

# The policy's field table is loaded via safepath, which needs its roots to
# exist as container paths - they do not on the host. This check is about the
# LOCATOR and the SPLICE, not about access control, so it brings its own field
# table. Keep it in step with policy.toml by hand; checks/api.py exercises the
# real one.
FIELDS = {
    "dev.portal.project": {"kind": "compose-label"},
    "dev.portal.name": {"kind": "compose-label"},
    "dev.portal.desc": {"kind": "compose-label"},
}


def yaml_files() -> list[str]:
    out = []
    for dirpath, dirnames, filenames in os.walk(REPO):
        dirnames[:] = [d for d in dirnames
                       if d not in (".git", "node_modules", ".venv", "dist",
                                    "build", ".next", "__pycache__")]
        for fn in filenames:
            if fn.endswith((".yml", ".yaml")):
                out.append(os.path.join(dirpath, fn))
    return sorted(out)


def main() -> int:
    bad = 0
    files = yaml_files()
    composes = [f for f in files if os.path.basename(f).startswith("compose")]
    sites_total = 0

    for path in files:
        rel = os.path.relpath(path, REPO)
        raw = open(path, "rb").read()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            print(f"FAIL  {rel}: not UTF-8")
            bad += 1
            continue

        try:
            sites = yamlpatch.locate(text, FIELDS)
        except yamlpatch.RewriteRefused as e:
            # A refusal is a legitimate answer for a file this service will not
            # touch - but it must be a REFUSAL, with a message, not a traceback.
            print(f"skip  {rel}: {e}")
            continue
        except Exception as e:  # noqa: BLE001
            print(f"FAIL  {rel}: {type(e).__name__}: {e}")
            bad += 1
            continue

        sites_total += len(sites)
        for s in sites:
            try:
                out = yamlpatch.splice(text, s, s.value)
            except yamlpatch.RewriteRefused as e:
                print(f"FAIL  {rel}: splicing {s.field} back over itself was "
                      f"refused: {e}")
                bad += 1
                continue
            if out.encode("utf-8") != raw:
                bad += 1
                print(f"FAIL  {rel}: a no-op patch of {s.field} on "
                      f"{s.service} changed the bytes")
                d = difflib.unified_diff(text.splitlines(True),
                                         out.splitlines(True),
                                         "before", "after", n=1)
                sys.stdout.write("".join(list(d)[:20]))

    print()
    print(f"{len(files)} YAML files, {len(composes)} of them compose files, "
          f"{sites_total} patchable values")
    if bad:
        print(f"FAIL: {bad} problem(s). No field is safe to edit until this passes.")
    else:
        print("PASS: every no-op patch left the file byte-identical")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
