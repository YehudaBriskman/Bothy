#!/usr/bin/env bash
# Every document that counts role-gated routers must agree with edge/dynamic/.
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
# IT HOLDS THREE DOCUMENTS, NOT ONE (2026-09-23). Fixing the number in
# SECURITY.md fixed one copy of it. README.md still said "Fourteen routers
# require a role, across three files" and enumerated fourteen by name;
# docs/guide/roles.md said "Nine routers carry a role requirement, across three
# files" and enumerated nine; docs/ARCHITECTURE.md said "Nineteen committed
# routers exist in total (fourteen of them role-gated)". Each had been correct
# when written, and a check that guards one document is a check that quietly
# certifies the other three. So every document that states the number now
# carries the SAME two tables, and every sentence that states it is listed in
# STATEMENTS below - spelled-out numbers included, because SECURITY.md's own
# prose said "forty-eight" two lines above a table this check already held, and
# nothing would have noticed if only one of the two ever moved.
#
# ADDING A STATEMENT IS THE POINT, NOT AN OVERHEAD. If you write a new sentence
# with this number in it, add its anchor here. A missing anchor is a FAILURE,
# not a skip: a document that quietly stopped stating the count would otherwise
# turn this check green by deleting the very thing it checks.
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

# Every document that carries the two counts tables. All of them must, and all
# of them must agree - see the header for what happened when only one did.
DOCS = tuple(pathlib.Path(p) for p in (
    'SECURITY.md',
    'README.md',
    'docs/guide/roles.md',
))

# (file, regex, what each capture group counts). Anchored on the real sentence
# in the document, never on a comment: an anchor in prose nobody reads would
# make this check pass a mutation it never saw.
STATEMENTS = (
    ('SECURITY.md',
     r'([a-z-]+) routers across ([a-z]+) files carry a role\s+requirement',
     ('gated', 'files')),
    ('SECURITY.md',
     r'\*\*Status: ENFORCED, narrowly\.\*\* ([A-Za-z-]+) role-gated routers, in ([a-z]+) files\.',
     ('gated', 'files')),
    ('README.md',
     r'\*\*(\d+) routers require a role\*\*, across (\d+) files',
     ('gated', 'files')),
    ('docs/guide/roles.md',
     r'(\d+) routers carry a role requirement, across (\d+) files',
     ('gated', 'files')),
    ('docs/ARCHITECTURE.md',
     r'(\d+) committed routers exist in total, (\d+) of them role-gated',
     ('routers', 'gated')),
    # "how many tiers are behind SSO" is the same number as "how many files hold
    # a gated router", and it is the sentence a reader stops at when deciding
    # whether the thing in front of them is protected. Both of these said
    # *three* for two tiers longer than it was true.
    ('docs/guide/index.md',
     r'Only (\d+) tiers are behind single sign-on',
     ('files',)),
    ('docs/guide/monitoring.md',
     r'Only (\d+) tiers are behind single sign-on',
     ('files',)),
    # A per-file count, in the one document that explains the directory file by
    # file. It said eight while the file held thirty-three, because the file is
    # GENERATED from apps/bothy-ops/catalog.toml and grows without anyone
    # opening it.
    ('docs/guide/configuring.md',
     r'\*\*generated\.\*\* (\d+) role-gated routers on `bothy-ops`',
     ('gated:bothy-ops.yml',)),
)

# Enough English to read the numbers these documents actually spell out. A word
# this cannot read is a FAILURE, not a skip - see number()'s caller.
WORDS = {
    'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7,
    'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11, 'twelve': 12,
    'thirteen': 13, 'fourteen': 14, 'fifteen': 15, 'sixteen': 16,
    'seventeen': 17, 'eighteen': 18, 'nineteen': 19,
}
TENS = {'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60,
        'seventy': 70, 'eighty': 80, 'ninety': 90}


def number(token):
    # '48', 'Forty-eight' and 'five' -> 48, 48, 5.  Anything else -> None.
    token = token.strip().lower()
    if token.isdigit():
        return int(token)
    if token in WORDS:
        return WORDS[token]
    if token in TENS:
        return TENS[token]
    if '-' in token:
        tens, _, unit = token.partition('-')
        if tens in TENS and unit in WORDS and WORDS[unit] < 10:
            return TENS[tens] + WORDS[unit]
    return None


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

# ── what the documents say ──────────────────────────────────────────────────
# Each table is the machine-readable copy of the sentence beside it. Its rows are
# `| edge/dynamic/<file> | <n> | <roles…> |`, and the roles column is prose for a
# reader - only the file and the count are compared. In SECURITY.md the tables
# sit inside the section's Status blockquote, so every row may be prefixed with
# `> `; the other documents set them flush, and one regex covers both.
actual = {name: sum(c.values()) for name, c in live.items()}
by_role = collections.Counter()
for counter in live.values():
    by_role.update(counter)

QUOTE = r'^(?:>\s*)?'
for doc_path in DOCS:
    doc = doc_path.read_text(encoding='utf-8')
    where = str(doc_path)

    stated = {}
    for m in re.finditer(QUOTE + r'\|\s*`edge/dynamic/([a-z-]+\.yml)`\s*\|\s*(\d+)\s*\|', doc, flags=re.M):
        stated[m.group(1)] = int(m.group(2))

    if not stated:
        fail('%s has no router table to check - restore it, or this check is '
             'guarding nothing' % where)
    for name in sorted(set(stated) | set(actual)):
        want, got = stated.get(name), actual.get(name)
        if want is None:
            fail('%s: %s has %d gated router(s) and the document does not list '
                 'the file' % (where, name, got))
        elif got is None:
            fail('%s: claims %d gated router(s) in %s; the file has none (or is '
                 'gone)' % (where, want, name))
        elif want != got:
            fail('%s: says %s has %d gated router(s), the file has %d'
                 % (where, name, want, got))
        else:
            print('PASS  %-20s %-22s %d gated router(s)' % (where, name, got))

    # Per role, the same argument: the totals a reader uses to judge the boundary.
    for gate in GATES:
        role = gate.removeprefix('sso-')
        m = re.search(QUOTE + r'\|\s*`%s`\s*\|\s*(\d+)\s*\|' % role, doc, flags=re.M)
        if not m:
            fail('%s does not state how many routers require `%s`' % (where, role))
        elif int(m.group(1)) != by_role[gate]:
            fail('%s says %s routers require `%s`; %d do'
                 % (where, m.group(1), role, by_role[gate]))
        else:
            print('PASS  %-20s %-22s %d router(s) require it'
                  % (where, role, by_role[gate]))

# ── and the sentences beside the tables ─────────────────────────────────────
# A table can be right while the sentence introducing it is wrong - that is
# exactly how SECURITY.md once carried "nine role-gated routers in three files"
# over a correct table. Numbers written as words are checked the same way: a
# spelled-out number is no less a copy.
totals = {
    'gated': sum(by_role.values()),
    'files': len(live),
    'routers': sum(len(routers_of(re.sub(r'#.*', '', p.read_text(encoding='utf-8'))))
                   for p in sorted(DYNAMIC.glob('*.yml'))
                   if not p.name.endswith('.example.yml')),
}
for path, pattern, kinds in STATEMENTS:
    text = pathlib.Path(path).read_text(encoding='utf-8')
    m = re.search(pattern, text)
    if not m:
        fail('%s no longer contains the sentence this check holds (/%s/) - it '
             'was reworded or deleted, and its number is unguarded again'
             % (path, pattern))
        continue
    for group, kind in enumerate(kinds, start=1):
        # `gated:<file>` asks for one file's count rather than a total.
        if kind.startswith('gated:'):
            totals[kind] = actual.get(kind.split(':', 1)[1], 0)
        got = number(m.group(group))
        if got is None:
            fail('%s: "%s" is not a number this check can read'
                 % (path, m.group(group)))
        elif got != totals[kind]:
            fail('%s says %s (%s); the tree has %d'
                 % (path, m.group(group), kind, totals[kind]))
        else:
            print('PASS  %-20s %-22s %d' % (path, kind, got))

print()
if fails:
    print('%d mismatch(es). A router was added, removed or re-gated and a' % fails)
    print('document that counts them was not updated - so it now understates')
    print('(or overstates) where the SSO boundary actually is.')
    sys.exit(1)
print('ok - %d role-gated routers across %d files (%d committed routers in all), '
      'and %d documents say so' % (sum(by_role.values()), len(live),
                                   totals['routers'], len(DOCS)))
PY
