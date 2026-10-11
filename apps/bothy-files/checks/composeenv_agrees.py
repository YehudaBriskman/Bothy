#!/usr/bin/env python3
"""The host's compose-env locator and ruamel point at exactly the same bytes.

Run with an interpreter that has ruamel.yaml:  python checks/composeenv_agrees.py
(run.sh's `bothy_yaml_python` finds or builds one)

── why this check lives HERE, in the wrong service ──────────────────────────

`apps/bothy-ops/updater/composeenv.py` finds a compose `environment:` value and
splices one character span, and it does so with NO YAML LIBRARY. That is not an
economy: the host `python3` has no `ruamel`, and the updater - devssh, in the
`docker` group, writing the checkout - is the last process on this box that
should hold a third-party parser. `pins.py` states the same reason for the pin
line it has edited since the updater existed.

The cost is two readers of "where does this value start and end", and this repo's
rule when two readers must exist is to prove they agree rather than to hope. It
cannot be proved in bothy-ops' own suite, which runs on the system python3 by
design ("no third-party dependency: the system python3 runs all of it"). It can
be proved HERE, where ruamel.yaml is the service's one declared dependency and
the pinned version is the one that ships.

So: for every compose file in the repository, and every environment value in it
that the host locator will touch, assert that ruamel's `lc.value()` reports the
SAME line, the SAME value and the SAME character span - and that a splice through
the host's code produces byte-for-byte what a splice through ruamel's offsets
would. A single character of disagreement fails, because a single character of
disagreement is a corrupted file rather than a refused one.

It also asserts the other direction: every value the host locator REFUSES is one
ruamel reads as something other than a plain literal scalar (quoted, folded, or
carrying an interpolation). A refusal that was merely a gap in the scanner would
be a silently un-editable row; a refusal that is a real shape is the design.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(SVC))
OPS = os.path.join(os.path.dirname(SVC), "bothy-ops")
sys.path.insert(0, OPS)

from ruamel.yaml import YAML  # noqa: E402
from ruamel.yaml.comments import CommentedMap  # noqa: E402
from ruamel.yaml.scalarstring import ScalarString  # noqa: E402

import updater  # noqa: E402,F401
from updater import composeenv  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def reader() -> YAML:
    y = YAML(typ="rt")
    y.preserve_quotes = True
    y.width = 1 << 30
    return y


def line_starts(text: str) -> list[int]:
    out, pos = [], 0
    for ln in text.splitlines(keepends=True):
        out.append(pos)
        pos += len(ln)
    out.append(pos)
    return out


COMPOSE = re.compile(r"compose(\.[a-z0-9-]+)?\.yml")


def compose_files() -> list[str]:
    out = []
    for root, _dirs, files in os.walk(REPO):
        rel = os.path.relpath(root, REPO)
        if rel.startswith((".git", ".claude")) or "node_modules" in rel:
            continue
        for fn in files:
            if COMPOSE.fullmatch(fn):
                out.append(os.path.relpath(os.path.join(root, fn), REPO))
    return sorted(out)


files = compose_files()
ok(len(files) >= 10, f"{len(files)} compose files found to compare: {files}")

compared = refused = 0
for rel in files:
    text = open(os.path.join(REPO, rel), encoding="utf-8").read()
    lines = line_starts(text)
    doc = reader().load(text)
    services = doc.get("services") if isinstance(doc, CommentedMap) else None
    if not isinstance(services, CommentedMap):
        continue
    for svc, body in services.items():
        env = body.get("environment") if isinstance(body, CommentedMap) else None
        if not isinstance(env, CommentedMap):
            continue
        for key in env:
            if not composeenv.KEY.fullmatch(str(key)):
                continue
            try:
                site = composeenv.locate(text, str(svc), str(key), rel)
            except composeenv.Refused as e:
                # The other direction: what the host refuses must be a real shape,
                # not a gap in the scanner. ruamel has to agree that this value is
                # not a plain literal that could be spliced.
                val = env[key]
                plain = (isinstance(val, str) and not isinstance(val, ScalarString)
                         and "${" not in val and "$(" not in val and val != "")
                ok(not plain,
                   f"{rel} {svc}.{key}: refused by the host, and ruamel agrees it is not a plain "
                   f"literal scalar ({str(e)[-60:]})")
                refused += 1
                continue
            # ruamel's own answer for the same value.
            lc = env.lc.value(key)
            raw = env[key]
            start = lines[lc[0]] + lc[1]
            ok(lc[0] + 1 == site.line,
               f"{rel} {svc}.{key}: same LINE ({lc[0] + 1} vs {site.line})")
            ok(str(raw) == site.value,
               f"{rel} {svc}.{key}: same VALUE ({str(raw)!r} vs {site.value!r})")
            ok((start, start + len(str(raw))) == (site.start, site.end),
               f"{rel} {svc}.{key}: same SPAN ({(start, start + len(str(raw)))} vs "
               f"{(site.start, site.end)})")
            # And the splice: the host's write, against a splice at ruamel's own
            # offsets. Byte-for-byte, with a value the pattern of the key does not
            # have to accept - this is about the arithmetic, not the allowlist.
            new = "zz" if str(raw) != "zz" else "yy"
            theirs = text[:start] + new + text[start + len(str(raw)):]
            ok(composeenv.splice(text, site, new) == theirs,
               f"{rel} {svc}.{key}: the host's splice is byte-identical to one at ruamel's offsets")
            ok(composeenv.splice(text, site, site.value) == text,
               f"{rel} {svc}.{key}: and a no-op changes no bytes at all")
            compared += 1

ok(compared >= 20, f"{compared} values compared span-for-span, {refused} refusals corroborated")

print()
print(f"composeenv agreement: {'all passed' if not fails else str(len(fails)) + ' FAILED'}")
sys.exit(1 if fails else 0)
