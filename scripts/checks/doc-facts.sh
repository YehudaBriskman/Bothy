#!/usr/bin/env bash
# Facts the documents state about the tree must be the tree's facts.
#
# Three kinds so far, all of which shipped wrong: a COUNT of something that only
# ever grows, a LIST of containers offered as an example to copy, and the PORT
# TABLE that every document defers to as the authority.
#
# ── the failure, and why it is not cosmetic ──────────────────────────────────
#
# SECURITY.md's power table said `bothy-ops` could do "five cluster actions".
# That was true in 2026-08. By 2026-09-23 `apps/bothy-ops/catalog.toml` declared
# TWENTY-NINE, including `delete-pod`, `delete-job`, `set-image`,
# `rollback-to-revision`, `run-template` and two ConfigMap patches. README.md,
# docs/ARCHITECTURE.md and the diagram source said five as well - four copies of
# a number whose source of truth is one TOML file that none of them reads.
#
# Nobody wrote "five" wrongly. Every one of those sentences was correct on the
# day it was written, and each new action landed in catalog.toml, which is
# exactly where it belongs. The drift is structural, and it runs in ONE
# direction: a document that counts a growing thing always ends up UNDERSTATING
# it. For a router count that understates the SSO boundary
# (scripts/checks/router-gates.sh) and for an action count that understates what
# an `operator` can do to the cluster, understating is the dangerous direction -
# a reader deciding "how much damage can this tier do" gets a reassuring answer.
#
# ── why a check and not a generator ──────────────────────────────────────────
#
# The right treatment for a fact is usually to GENERATE it, and this repo does
# that wherever the fact has a natural home in a file nobody reads as prose:
# catalog.toml renders the routers, the Role and the probes; reads.toml renders
# the collector's ClusterRole; gen-tokens-doc.mjs renders the token reference.
# A sentence in the middle of a security argument is not that. It has to read as
# English, in a paragraph a person wrote, so the copy stays and the check holds
# it. `scripts/checks/router-gates.sh` is the same trade for the same reason.
#
# ── the rule for adding to this file ─────────────────────────────────────────
#
# A row here costs nothing to run and is worth having only if somebody would ACT
# on the fact being wrong. "How many cluster actions can an operator take" and
# "how many router files does Traefik watch" both qualify - the first sizes a
# blast radius, the second is how you find out whether a tier has a file at all.
# So does "which containers should join devnet", which is a recipe people copy.
# A fact nobody acts on should be DELETED from the prose instead of checked;
# a check that guards a fact nobody reads is cost with no benefit.
#
# Each row is anchored on the real sentence, never on a comment. A check whose
# anchor lives in a comment can be "mutated" by an edit it never sees, which is
# the no-op scripts/checks/mutants.sh exists to refuse. A row whose sentence has
# been reworded away is a FAILURE, not a skip: otherwise a document could turn
# this check green by deleting the claim rather than correcting it.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

python3 - "$@" <<'PY'
import pathlib
import re
import subprocess
import sys
import tomllib

fails = 0


def fail(msg):
    global fails
    print('FAIL  %s' % msg)
    fails += 1


# ── the truths, read from where they live ───────────────────────────────────
catalog = tomllib.loads(pathlib.Path('apps/bothy-ops/catalog.toml')
                        .read_text(encoding='utf-8'))

# Every *.yml Traefik's file provider loads from the directory, as committed.
# bothy-prom.yml is generated and gitignored (it carries a credential), so the
# tree cannot count it and neither may the sentence that states this number.
#
# THE COMMENT ABOVE WAS RIGHT AND THE CODE BELOW WAS A GLOB, which counted the
# generated file anyway. Net effect: this check PASSED IN CI, where a fresh
# clone has never generated it, and failed on every box that had - reading as
# drift in README.md rather than as a bug here. `git ls-files` is the only
# spelling of "committed" that cannot drift from the word.
_ls = subprocess.run(['git', 'ls-files', '-z', 'edge/dynamic/*.yml'],
                     capture_output=True, text=True, check=True).stdout
dynamic_files = sorted(pathlib.PurePosixPath(p).name for p in _ls.split('\0') if p)

# The foot-gun warnings: the SELF map in apps/bothy-web/web/src/lib/actions.ts,
# whose KEYS are live Docker container names and whose values are the sentence the
# console says before the act. Counting it was pointless until 2026-10-06, because
# nine of its seventeen keys were migration aliases of containers that no longer
# exist - so the guide's "Eight" was right about the box and could not be held to
# the map. With the aliases gone the two agree, and the count is worth holding for
# the reason the map's own comment gives: a lookup MISS fails open, so a key that
# stops matching deletes a warning silently, and the number in the guide is the
# only place a reader is told how many of these sentences the console has.
_self_src = pathlib.Path('apps/bothy-web/web/src/lib/actions.ts').read_text(encoding='utf-8')
_self = re.search(r'^const SELF: Record<string, string> = \{\n(.*?)^\};', _self_src,
                  re.M | re.S)
self_keys = []
if not _self:
    fail('apps/bothy-web/web/src/lib/actions.ts no longer declares `const SELF: '
         'Record<string, string>` - the map this check counts was renamed or moved, '
         'so nothing holds the guide to it')
else:
    self_keys = re.findall(r"^  '?([A-Za-z0-9][\w.-]*)'?:", _self.group(1), re.M)
    if not self_keys:
        fail('the SELF map in apps/bothy-web/web/src/lib/actions.ts parsed as EMPTY - '
             'its entries are not one-per-line any more, and a count of nothing would '
             'pass this check by never matching a key')

TRUTH = {
    'cluster actions': len(catalog['actions']),
    'edge/dynamic files': len(dynamic_files),
    'foot-gun warnings': len(self_keys),
    # 3 until 2026-10-07, then 22. This one does NOT only grow - the whole point
    # of the widening was that the number is a product decision and reversible -
    # so it is held in both directions, and understating it is still the
    # dangerous direction for a cell a reader sizes a blast radius with.
    'allowlisted ConfigMap keys': len(catalog['configmap_keys']),
}

# the-console.md spells its number as a word, because the paragraph it sits in is
# an argument about two kinds of refusal and "8 containers carry a sentence" reads
# like a changelog. Every other document here uses a digit. Both are accepted:
# editing English to suit a regex is how a held sentence becomes a worse sentence.
WORDS = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7,
         'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11, 'twelve': 12}

# (document, key into TRUTH, regex with exactly one capture group)
STATEMENTS = (
    ('docs/guide/the-console.md', 'foot-gun warnings',
     r'\*\*Foot-gun warnings\.\*\* (\w+) containers carry a sentence'),
    ('SECURITY.md', 'cluster actions',
     r'\*\*(\d+) cluster actions\*\* with a namespaced token'),
    ('README.md', 'cluster actions',
     r'the \*\*(\d+) cluster actions\*\* declared in `catalog\.toml`'),
    ('docs/ARCHITECTURE.md', 'cluster actions',
     r'the (\d+) cluster actions in `catalog\.toml`'),
    ('docs/guide/roles.md', 'cluster actions',
     r'the (\d+) actions in `apps/bothy-ops/catalog\.toml`'),
    ('README.md', 'edge/dynamic files',
     r'\| `edge/dynamic/` \| (\d+) committed files, all watched'),
    ('SECURITY.md', 'allowlisted ConfigMap keys',
     r'change only the \*\*(\d+) allowlisted keys\*\*'),
)

for path, key, pattern in STATEMENTS:
    text = pathlib.Path(path).read_text(encoding='utf-8')
    matches = re.findall(pattern, text)
    if not matches:
        fail('%-22s no longer contains the sentence this check holds (/%s/) - '
             'it was reworded or deleted, so its number is unguarded again'
             % (path, pattern))
        continue
    if len(matches) > 1:
        fail('%-22s states "%s" %d times; the anchor must match exactly one '
             'sentence or a stale second copy hides behind a correct first'
             % (path, key, len(matches)))
        continue
    said = matches[0]
    n = int(said) if said.isdigit() else WORDS.get(said.lower())
    if n is None:
        fail('%-22s states "%s" as "%s", which is neither a digit nor a word this '
             'check can read as a number - use a digit, or add the word to WORDS'
             % (path, key, said))
    elif n != TRUTH[key]:
        fail('%-22s says %s %s; the tree has %d'
             % (path, said, key, TRUTH[key]))
    else:
        print('PASS  %-22s %-20s %d' % (path, key, TRUTH[key]))


# ── the devnet recipe names only containers that are actually on devnet ─────
#
# "A container nothing browses: publish nothing, join `devnet`" is a RECIPE, and
# it ends with the containers to copy. Until 2026-09-23 those were
# `bothy-socket-read`, `bothy-socket-write`, `oauth2-proxy`, `bothy-files`,
# `bothy-ops` and every `*-exporter` - and four of the five named containers had
# been moved OFF devnet precisely because being on it is the danger. `devnet`
# holds every third-party image on the box (Keycloak, Grafana, project
# containers); a docker-socket proxy has no authentication of any kind, so
# reachability IS its authorisation (SECURITY.md § 2). The recipe was telling a
# reader to undo the boundary, in the document that explains the boundary.
#
# apps/bothy-ops/checks/grants.py already asserts the compose side - that those
# four are each on exactly their private network. Nothing held the prose to it,
# which is the whole shape of this file.
TOPLEVEL_RE = re.compile(r'^([A-Za-z0-9][\w.-]*):')
SERVICE_RE = re.compile(r'^  ([A-Za-z0-9][\w.-]*):\s*$')
INLINE_NETS_RE = re.compile(r'^    networks:\s*\[([^\]]*)\]')
NAME_RE = re.compile(r'^    container_name:\s*(\S+)')

on_devnet = {}
declared_names = set()
for path in sorted(pathlib.Path('.').glob('**/compose*.yml')):
    if any(part in ('node_modules', '.git') for part in path.parts):
        continue
    service = None
    names = []
    nets = set()

    def flush():
        declared_names.update(names)
        for n in names or ([service] if service else []):
            on_devnet[n] = on_devnet.get(n, False) or ('devnet' in nets)

    in_nets = False
    section = None
    for line in path.read_text(encoding='utf-8').splitlines():
        m = TOPLEVEL_RE.match(line)
        if m:
            # The file's own top-level `networks:` block also has two-space keys,
            # and `devnet:` under it would otherwise read as a service called
            # devnet - which then fails its own check for not being on itself.
            flush()
            section, service, names, nets, in_nets = m.group(1), None, [], set(), False
            continue
        if section != 'services':
            continue
        m = SERVICE_RE.match(line)
        if m:
            flush()
            service, names, nets, in_nets = m.group(1), [], set(), False
            continue
        if service is None:
            continue
        m = NAME_RE.match(line)
        if m:
            names.append(m.group(1))
        m = INLINE_NETS_RE.match(line)
        if m:
            nets.update(n.strip() for n in m.group(1).split(','))
            continue
        if line.startswith('    networks:'):
            in_nets = True
            continue
        if in_nets:
            m = re.match(r'^      - (\S+)', line)
            if m:
                nets.add(m.group(1))
            elif line.strip() and not line.lstrip().startswith('#'):
                in_nets = False
    flush()

# The paragraph is the recipe: from its opening sentence to the first blank line.
RECIPE = re.compile(r'Publish nothing\. Join `devnet`.*?(?:\n\n|\Z)', re.S)
for doc in ('docs/ARCHITECTURE.md', 'docs/guide/services.md'):
    text = pathlib.Path(doc).read_text(encoding='utf-8')
    m = RECIPE.search(text)
    if not m:
        fail('%-22s has no "Publish nothing. Join `devnet`" recipe any more - '
             'it was reworded, and its example list is unguarded again' % doc)
        continue
    named = [n for n in re.findall(r'`([a-z][a-z0-9-]*)`', m.group(0))
             if n in on_devnet]
    if not named:
        fail('%-22s devnet recipe names no container this check can verify - '
             'an example list nothing holds is how the last one went wrong' % doc)
    for name in named:
        if on_devnet[name]:
            print('PASS  %-22s devnet recipe names %s, which is on devnet'
                  % (doc, name))
        else:
            fail('%-22s devnet recipe offers `%s` as an example to copy, and it '
                 'is deliberately NOT on devnet - see SECURITY.md section 2'
                 % (doc, name))

# ── and the number counted above counts containers that exist ───────────────
#
# The count held against the-console.md is only a fact about the box if every key
# in SELF names a container something here declares. Until 2026-10-06 nine of the
# seventeen did not - the pre-2026-09 container names, kept deliberately through
# three renames and then kept past their own stated drop condition - and that is
# precisely why the number could not be checked: the map counted ghosts.
#
# This is the other direction of the same failure, and the dangerous one.
# `consequenceOf` is an exact-match lookup and a miss returns
# {selfAffecting: false}: no warning, no error, just a missing sentence before an
# action that can take the page away. A rename that moves `container_name:` and
# forgets this map does not break anything loudly; it deletes a guard. Nothing
# held it before - grants.py holds guard.SEVERING's four names to compose, and
# four of these eight are not in that list at all.
#
# It belongs in this file because the keys and the count are one fact: a number in
# a document, and the thing it counts. Compose is already parsed above for devnet.
if self_keys:
    dead = [n for n in self_keys if n not in declared_names]
    for name in dead:
        fail('actions.ts\'s SELF warns about `%s` and no compose file in this tree '
             'declares a container by that name - an exact-match lookup that can '
             'never match is a warning deleted, and the count above counted it'
             % name)
    if not dead:
        print('PASS  %-22s %-20s %s' % ('actions.ts (SELF)', 'all keys declared',
                                        ' '.join(sorted(self_keys))))

# ── the confirm level a document states is the level the service asks for ───
#
# SECURITY.md rule 6's action table is the one place a reader is told how hard it
# is to take each cluster action, and on 2026-10-07 it disagreed with
# catalog.toml about FIVE of the twelve: `scale`, `set-image` and
# `rollback-to-revision` were written `type-name` and are `click`;
# `delete-completed-pods` and `delete-job` were written `click` and are
# `type-name`. Every one of those sentences was correct while design decision 7
# was still being argued; the catalog then moved to "the level follows
# REVERSIBILITY, not loudness" (2026-09-21) and the table did not move with it.
#
# Unlike the counts above, this drift runs in BOTH directions and both hurt:
#   · stated harder than it is - a reviewer believes a guard rail exists that
#     does not, and reads a change as though a careless click were impossible;
#   · stated softer than it is - an operator writes a runbook step that will
#     stop and ask for a name to be typed, and learns that mid-incident.
#
# It stays a CHECK rather than a generator for this file's stated reason: the
# cell has to read as English inside a security argument. But the COMPLETENESS
# half is mechanical, so it is asserted too - every action in the catalog must
# appear in the table, in the column its `role` puts it in. An action added to
# catalog.toml and left out of the table fails here; the action COUNT above could
# only ever notice that as a number, which is how it went unnoticed before.
#
# Parsing: a Changes cell is `id`(, `id`)* (level) entries separated by "), ", so
# a grouped entry (`pause`/`resume`; `patch-key`, `patch-key-and-restart`) is
# read as the one level its ids share. An action with `escalate` must state that
# after a semicolon, naming the value and the word "name" - a base level alone
# understates `scale`, which is the half of CL-4 that matters.
LEVEL_WORDS = {
    'click': 'click',
    'type-name': 'type-name',
    'type the name': 'type-name',
    # patch-key is confirmed with the KEY, not the ConfigMap's name
    # (guard.confirm_name) - a distinction the table is right to keep in words.
    'type the key': 'type-name',
}

_sec = pathlib.Path('SECURITY.md').read_text(encoding='utf-8')
_rule6 = re.search(r'^\| Group \| Reads \(`viewer`\) \| Changes \(`operator`, confirm\) \|\n'
                   r'\|---\|---\|---\|\n((?:\|.*\n)+)', _sec, re.M)
_actions = catalog['actions']
if not _rule6:
    fail('SECURITY.md  rule 6 no longer has its "| Group | Reads (`viewer`) | '
         'Changes (`operator`, confirm) |" table - the confirm levels a reader '
         'sizes this tier with are unguarded again')
else:
    read_ids, said_level = set(), {}
    for row in _rule6.group(1).splitlines():
        cells = [c.strip() for c in row.strip().strip('|').split('|')]
        if len(cells) != 3:
            fail('SECURITY.md  rule 6 row %r does not have three cells' % row[:60])
            continue
        _, reads, changes = cells
        read_ids |= {t for t in re.findall(r'`([a-z][a-z0-9-]*)`', reads) if t in _actions}
        if changes == '-':
            continue
        for entry in changes.split('), '):
            ids = [t for t in re.findall(r'`([a-z][a-z0-9-]*)`', entry) if t in _actions]
            phrase = entry.rsplit('(', 1)[-1].rstrip(')').strip() if '(' in entry else ''
            if not ids:
                fail('SECURITY.md  rule 6 entry %r names no catalog action' % entry[:60])
            elif not phrase:
                fail('SECURITY.md  rule 6 states no confirm level for %s - an '
                     'operator action with no level in the table is the whole gap '
                     'this check exists for' % ', '.join(ids))
            else:
                for i in ids:
                    said_level[i] = phrase

    want_reads = {i for i, a in _actions.items() if a['role'] == 'viewer'}
    want_changes = {i for i, a in _actions.items() if a['role'] == 'operator'}
    for missing in sorted(want_reads - read_ids):
        fail('SECURITY.md  rule 6 does not list the read `%s`, which catalog.toml '
             'declares role = "viewer"' % missing)
    for missing in sorted(want_changes - set(said_level)):
        fail('SECURITY.md  rule 6 does not list the change `%s` with a confirm '
             'level, and catalog.toml declares it role = "operator" - a reader is '
             'told this tier cannot do something it can' % missing)
    for extra in sorted(read_ids & want_changes):
        fail('SECURITY.md  rule 6 lists `%s` as a READ; catalog.toml declares it '
             'role = "operator"' % extra)
    for extra in sorted(set(said_level) & want_reads):
        fail('SECURITY.md  rule 6 lists `%s` as a CHANGE; catalog.toml declares '
             'it role = "viewer"' % extra)

    for i in sorted(set(said_level) & want_changes):
        base, _, esc = said_level[i].partition(';')
        got = LEVEL_WORDS.get(base.strip().lower())
        want = _actions[i]['confirm']
        escalate = _actions[i].get('escalate')
        if got is None:
            fail('SECURITY.md  rule 6 states `%s` as "%s", which is not a confirm '
                 'level this check can read - write click, type-name, type the '
                 'name, or type the KEY' % (i, base.strip()))
        elif got != want:
            fail('SECURITY.md  rule 6 says `%s` confirms with "%s"; catalog.toml '
                 'says %s' % (i, said_level[i], want))
        elif escalate and not (str(escalate['value']) in esc and 'name' in esc.lower()):
            fail('SECURITY.md  rule 6 states `%s` as "%s" and says nothing of its '
                 'escalation; catalog.toml raises it to type-name at %s = %s, so '
                 'the table understates it'
                 % (i, said_level[i], escalate['param'], escalate['value']))
        elif not escalate and esc.strip():
            fail('SECURITY.md  rule 6 states an escalation for `%s` ("%s") and '
                 'catalog.toml declares none' % (i, esc.strip()))
        else:
            print('PASS  %-22s %-20s %s' % ('SECURITY.md (rule 6)', i, said_level[i]))


# ── `just urls` is the port authority, so it has to be right ────────────────
#
# README.md, docs/ARCHITECTURE.md, docs/kb/access.md and ~/claude-notes all say
# the same thing: do not keep a second port table, run `just urls`. That makes
# the recipe the one copy - and an authority nothing checks is just the copy
# everybody trusts. It has already been wrong in the other direction: Bothy's own
# Overview linked `prometheus:9090` for months after VictoriaMetrics replaced it.
#
# Two directions, because they fail differently:
#   · a service publishes a port and `just urls` does not know - the port is
#     invisible to the person who went to the authority to find it;
#   · `just urls` prints a port nothing publishes - the reader curls a dead port
#     and starts debugging the box.
#
# Only the LIVE block is compared. The recipe deliberately also lists ports that
# are NOT in this tree - retired services, ports reserved by projects under
# ~/projects, Tilt - and those are the whole point of that half of the output.
# A profile-gated service (`prometheus`, `promtail` - rollback profiles) is not
# published either: it is down, and listing it would be the second failure above.
PORT_RE = re.compile(r'^\s+- "(?:(\d+\.\d+\.\d+\.\d+):)?(\d+):\d+"', re.M)
published = {}
for path in sorted(pathlib.Path('.').glob('**/compose*.yml')):
    if any(part in ('node_modules', '.git') for part in path.parts):
        continue
    section, service, block = None, None, []

    def take():
        if service is None:
            return
        body = '\n'.join(block)
        if re.search(r'^    profiles:', body, re.M):
            return
        for host_ip, port in PORT_RE.findall(body):
            if host_ip.startswith('127.'):
                continue  # loopback is not an address anybody browses
            published[int(port)] = '%s (%s)' % (service, path)

    for line in path.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^([A-Za-z0-9][\w.-]*):', line)
        if m:
            take()
            section, service, block = m.group(1), None, []
            continue
        if section != 'services':
            continue
        m = re.match(r'^  ([A-Za-z0-9][\w.-]*):\s*$', line)
        if m:
            take()
            service, block = m.group(1), []
            continue
        if service is not None:
            block.append(line)
    take()

justfile = pathlib.Path('justfile').read_text(encoding='utf-8')
live = re.search(r'START HERE.*?Deleted 2026-08-18', justfile, re.S)
if not live:
    fail('the `urls` recipe no longer has a live block between "START HERE" and '
         '"Deleted 2026-08-18" - it was restructured, so nothing holds it to the '
         'compose files any more')
else:
    text = live.group(0)
    # `http://$IP/` with no port is the portal on 80, which edge/compose.yml
    # publishes like any other - naming it 80 here keeps both directions honest.
    listed = {80} if re.search(r'http://\$IP/\s', text) else set()
    listed |= {int(n) for n in re.findall(r'http://\$IP:(\d+)', text)}

    for port in sorted(set(published) - listed):
        fail('port %d is published by %s and `just urls` does not list it - the '
             'recipe every document calls the authority cannot find it'
             % (port, published[port]))
    for port in sorted(listed - set(published)):
        fail('`just urls` lists port %d in its live block and no compose file in '
             'this tree publishes it - a reader will curl a dead port and blame '
             'the box' % port)
    if set(published) == listed:
        print('PASS  %-22s %-20s %s' % ('justfile (urls)', 'live ports',
                                        ' '.join(str(p) for p in sorted(listed))))

print()
if fails:
    print('%d mismatch(es). Something moved in the tree and a document that' % fails)
    print('describes it did not - which here means a reader is told the blast')
    print('radius is smaller than it is, or handed a recipe that widens it.')
    sys.exit(1)
print('ok - %d cluster actions, %d edge/dynamic files, %d foot-gun warnings (each '
      'naming a container this tree declares), %d published ports, and every '
      'document that states them agrees'
      % (TRUTH['cluster actions'], TRUTH['edge/dynamic files'],
         TRUTH['foot-gun warnings'], len(published)))
PY
