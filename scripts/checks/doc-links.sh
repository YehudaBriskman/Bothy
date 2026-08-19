#!/usr/bin/env bash
# Every relative link and image in a tracked markdown file points at something.
#
# THE FAILURE THIS PREVENTS, which had already happened three times over.
# `docs/assets/portal-overview.png`, `portal-services.png` and
# `portal-topology.png` were deleted in 2500aa0 ("a README is not a changelog")
# and docs/ARCHITECTURE.md kept referencing all three. Nothing noticed: a broken
# image is invisible in a diff, GitHub renders it as a small grey box that reads
# like a slow load, and the in-app reader renders an <img> that never resolves.
# The doc looked fine to everyone who did not scroll to that section.
#
# It is the same shape as the other things this directory exists to catch - a
# statement that stopped being true and had nobody checking it - and it gets
# worse as the docs grow, which they just did.
#
# WHAT IT DELIBERATELY IGNORES, and why each one would otherwise cry wolf:
#
#   · anything with a scheme (http:, mailto:) - not this repo's to resolve.
#   · bare `#anchor` links - a heading, not a path.
#   · CODE. A path inside `backticks` or a fenced block is an EXAMPLE, and
#     examples are written from the perspective of the file being described,
#     not the file doing the describing. docs/plans/all-open-issues.md says
#     `![x](brand/wordmark-dark.svg)` while describing a probe that ran from
#     docs/ - correct prose, and a false positive for any checker that reads it
#     as a link from docs/plans/. Stripping code first is not a convenience, it
#     is the difference between a check people keep and one they switch off.
#   · wikilinks [[name]] - the reader RESOLVES those by search rather than by
#     path (see resolveWikiIn in pages/files/tree.ts), so "does this path exist"
#     is the wrong question to ask about one.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

python3 - <<'PY'
import os, re, subprocess, sys

files = [f for f in subprocess.run(['git', 'ls-files', '*.md'],
                                   capture_output=True, text=True).stdout.split()
         if not f.startswith('.cleanup-trash/')]

# Fenced blocks first, then inline spans - order matters, a fence can contain
# backticks and stripping spans first would leave the fence markers behind.
FENCE = re.compile(r'^```.*?^```', re.S | re.M)
SPAN = re.compile(r'`[^`\n]*`')
LINK = re.compile(r'!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)')

fails = 0
for f in files:
    src = open(f, encoding='utf-8', errors='replace').read()
    src = SPAN.sub(' ', FENCE.sub(' ', src))
    for m in LINK.finditer(src):
        target = m.group(1)
        if re.match(r'^[a-z][a-z0-9+.-]*:', target) or target.startswith(('#', '//')):
            continue
        path = os.path.normpath(os.path.join(os.path.dirname(f), target.split('#')[0]))
        if not os.path.exists(path):
            print('FAIL  %-38s -> %s' % (f, target))
            fails += 1

print()
if fails:
    print('%d broken relative link(s). The target was renamed, moved or deleted' % fails)
    print('and the document that names it was not updated.')
else:
    print('ok - every relative link and image in %d markdown files resolves' % len(files))
sys.exit(1 if fails else 0)
PY
