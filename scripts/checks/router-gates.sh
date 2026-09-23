#!/usr/bin/env bash
# SECURITY.md's count of role-gated routers must be the count in edge/dynamic/.
#
# THE FAILURE THIS PREVENTS, which has already happened twice, in writing.
# Section 1 of SECURITY.md exists to say exactly how far the SSO boundary
# reaches, because "SSO is running" is not the same claim as "this is behind
# SSO". It has stated that reach as a NUMBER three times now:
#
#   · "nine routers across three files"  - went stale the day the cluster tier
#     added five more, in a fourth file. The document says so itself.
#   · "fourteen routers across three files" - the replacement. By 2026-09-23 the
#     truth was FORTY-EIGHT across FIVE files: the cluster tier grew to 33 gated
#     routers of its own, and the admin and updates tiers arrived with theirs.
#   · the table below this comment's fix, which is what this check holds.
#
# Neither drift was a mistake anybody made. Adding a gated router is the CORRECT
# thing to do, it is done in a different file from the one that counts them, and
# a stale number in a security document reads exactly like a current one. The
# count only ever moves in the direction that makes the document understate the
# boundary - which is the safe direction for the box and the WRONG direction for
# a reader deciding whether something is protected.
#
# WHY A COUNT AND NOT A PROSE CHECK. The number is the only part a reader uses
# to decide "is this list the whole list". If it matches, the enumeration beside
# it can be trusted; if it does not, nothing in that section can be. So the
# check asserts the per-file and per-role tables, not a total - a total can stay
# right while two files swap five routers between them.
#
# IT ALSO HOLDS TWO INVARIANTS THE INDEX PROMISES, for the same reason: they are
# stated in prose somewhere a new router does not touch.
#   · Zero Host() rules. A Host rule registers happily and then matches nothing,
#     forever, because the name layer was deleted in 2026-08-12.
#   · The three gates are DEFINED once, in bothy-gates.yml, and nowhere else. A
#     second definition of `sso-editor` in one provider is a collision whose
#     winner no single file can decide, and both routers would still answer -
#     one of them against the wrong role.
#
# Run it after adding, removing or re-gating any router in edge/dynamic/.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

python3 - "$@" <<'PY'
import collections
import pathlib
import re
import sys

GATES = ('sso-viewer', 'sso-editor', 'sso-operator')
DYNAMIC = pathlib.Path('edge/dynamic')
SECURITY = pathlib.Path('SECURITY.md')

fails = 0


def fail(msg):
    global fails
    print('FAIL  %s' % msg)
    fails += 1


# ── what the router files actually say ──────────────────────────────────────
# A router is a key two levels under `http.routers`; its gate is whichever of
# the three appears in its body. Comments are stripped first, because every one
# of these files discusses the gates at length in prose above the rules.
def routers_of(text):
    parts = re.split(r'^\s{2}routers:\s*$', text, flags=re.M)
    if len(parts) < 2:
        return []
    rest = re.split(r'^\s{2}(?:services|middlewares):\s*$', parts[1], flags=re.M)[0]
    return re.split(r'^\s{4}(?=[a-zA-Z])', rest, flags=re.M)[1:]


live = collections.defaultdict(collections.Counter)
host_rules = []
defines = []
for path in sorted(DYNAMIC.glob('*.yml')):
    if path.name.endswith('.example.yml'):
        continue  # a template is not a route; it ships commented out on purpose
    text = path.read_text(encoding='utf-8')
    bare = re.sub(r'#.*', '', text)
    if re.search(r'^\s{4}(%s):' % '|'.join(GATES), bare, flags=re.M):
        defines.append(path.name)
    for router in routers_of(bare):
        if 'Host(' in router:
            host_rules.append(path.name)
        for gate in GATES:
            if re.search(r'\b%s\b' % gate, router):
                live[path.name][gate] += 1
                break

if host_rules:
    fail('a Host() rule is back, in %s - it will match nothing, forever '
         '(the name layer was deleted 2026-08-12)' % ', '.join(sorted(set(host_rules))))
if defines != ['bothy-gates.yml']:
    fail('the gates must be defined once, in bothy-gates.yml; found in %s'
         % (', '.join(defines) or '(nowhere)'))

# ── what SECURITY.md says ───────────────────────────────────────────────────
# The table is the machine-readable copy of the sentence beside it. Its rows are
# `| edge/dynamic/<file> | <n> | <roles…> |`, and the roles column is prose for a
# reader - only the file and the count are compared. The tables live inside the
# section's Status blockquote, so every row may be prefixed with `> `.
doc = SECURITY.read_text(encoding='utf-8')
QUOTE = r'^(?:>\s*)?'
stated = {}
for m in re.finditer(QUOTE + r'\|\s*`edge/dynamic/([a-z-]+\.yml)`\s*\|\s*(\d+)\s*\|', doc, flags=re.M):
    stated[m.group(1)] = int(m.group(2))

actual = {name: sum(c.values()) for name, c in live.items()}
if not stated:
    fail('SECURITY.md has no router table to check - restore it, or this check '
         'is guarding nothing')
for name in sorted(set(stated) | set(actual)):
    want, got = stated.get(name), actual.get(name)
    if want is None:
        fail('%-22s %d gated router(s), and SECURITY.md does not list the file'
             % (name, got))
    elif got is None:
        fail('%-22s SECURITY.md claims %d gated router(s); the file has none '
             '(or is gone)' % (name, want))
    elif want != got:
        fail('%-22s SECURITY.md says %d gated router(s), the file has %d'
             % (name, want, got))
    else:
        print('PASS  %-22s %d gated router(s)' % (name, got))

# Per role, the same argument: the totals a reader uses to judge the boundary.
by_role = collections.Counter()
for counter in live.values():
    by_role.update(counter)
for gate in GATES:
    role = gate.removeprefix('sso-')
    m = re.search(QUOTE + r'\|\s*`%s`\s*\|\s*(\d+)\s*\|' % role, doc, flags=re.M)
    if not m:
        fail('SECURITY.md does not state how many routers require `%s`' % role)
    elif int(m.group(1)) != by_role[gate]:
        fail('SECURITY.md says %s routers require `%s`; %d do'
             % (m.group(1), role, by_role[gate]))
    else:
        print('PASS  %-22s %d router(s) require it' % (role, by_role[gate]))

print()
if fails:
    print('%d mismatch(es). A router was added, removed or re-gated and the' % fails)
    print('security document that counts them was not updated - so it now')
    print('understates (or overstates) where the SSO boundary actually is.')
    sys.exit(1)
print('ok - SECURITY.md counts %d role-gated routers across %d files, and so does '
      'edge/dynamic/' % (sum(by_role.values()), len(live)))
PY
