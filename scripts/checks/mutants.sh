#!/usr/bin/env bash
# Every check here must be able to FAIL.
#
# ── why this exists ──────────────────────────────────────────────────────────
#
# This repo's expensive bugs have not been in the product. They have been in the
# checks, and every one of them was silent, because a check that cannot fail
# reads exactly like a check that passes:
#
#   · `curl | grep -q` under `pipefail` failed 2 runs in 3 - a SIGPIPE race, so
#     the suite reported "the sandbox split is broken" when it was not.
#   · The portability baseline keyed on `file:line`, so inserting a line anywhere
#     produced six false positives and the real signal was ignored for a while.
#   · The placeholder check was wrong in BOTH directions at once: it flagged
#     compose's own default as a placeholder, and a retired service's key.
#   · A regex matched the file it was written in, so it could never go quiet.
#   · `checks/run.sh` in three suites did `cd "$HERE/.."` with no `|| exit`, so a
#     failed cd ran every check below against whatever directory the caller was in.
#
# The habit that caught these was proving, by hand, that a new check fails when
# the thing it guards is broken. That habit is not durable - it depends on
# whoever wrote the check remembering. This file makes it mechanical.
#
# ── how it works ─────────────────────────────────────────────────────────────
#
# For each row: apply a mutation that BREAKS something real, run the check that
# claims to guard it, and require a NON-ZERO exit. Then revert. A row that
# passes means the check noticed. A row that FAILS means the check is decorative,
# which is worse than not having it.
#
# The mutations are not arbitrary damage. Each is either a bug this repo actually
# shipped, or the precise inversion of a rule a comment states.
#
# ── safety ───────────────────────────────────────────────────────────────────
#
# It edits tracked files and reverts with `git checkout --`, so it REFUSES to run
# on a dirty tree - otherwise a revert would discard your work. The trap restores
# every file it touched on any exit, including Ctrl-C.
#
# Everything here runs with the stack DOWN. Nothing starts a container, so this
# is a two-minute job rather than a fifteen-minute one, and it can gate a PR.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "REFUSING TO RUN: the working tree is dirty."
  echo "This applies mutations and reverts them with \`git checkout --\`, which"
  echo "would discard your changes. Commit or stash first."
  exit 1
fi

TOUCHED=()
restore() {
  # `git checkout --` on a list that may be empty is an error, so guard it. Runs
  # on EVERY exit path, Ctrl-C included: a mutation left behind is a booby trap
  # for whatever runs next in the same tree.
  if [ ${#TOUCHED[@]} -gt 0 ]; then
    git checkout -- "${TOUCHED[@]}" 2>/dev/null || true
  fi
}
trap restore EXIT INT TERM

pass=0
fail=0

# Replace an exact substring in a file. Python rather than sed because the
# anchors below contain regex metacharacters, backticks and ${...} - escaping all
# of that for sed is how a mutation silently becomes a no-op, and a no-op
# mutation makes the check look like it failed to catch something it was never
# shown.
plant() {
  MUT_FILE="$1" MUT_OLD="$2" MUT_NEW="$3" python3 - <<'PY'
import os, sys
p, old, new = os.environ["MUT_FILE"], os.environ["MUT_OLD"], os.environ["MUT_NEW"]
s = open(p, encoding="utf-8").read()
if old not in s:
    sys.exit(f"anchor not found in {p}: {old[:70]!r}")
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
}

# mutant <label> <file> <old> <new> -- <check command...>
mutant() {
  local label="$1" file="$2" old="$3" new="$4"; shift 5   # shift past the `--`
  TOUCHED+=("$file")

  if ! plant "$file" "$old" "$new"; then
    printf 'ERROR  %-46s could not apply the mutation\n' "$label"
    fail=$((fail + 1))
    return
  fi

  # The check is EXPECTED to fail, so its output is noise on success and the only
  # thing worth reading on failure. Captured either way, printed only when the
  # check did not notice.
  local out rc
  out=$("$@" 2>&1); rc=$?

  git checkout -- "$file"

  if [ "$rc" -ne 0 ]; then
    printf 'PASS   %-46s caught it (exit %d)\n' "$label" "$rc"
    pass=$((pass + 1))
  else
    printf 'FAIL   %-46s DID NOT NOTICE - this check is decorative\n' "$label"
    printf '       the mutation applied cleanly and %s still exited 0\n' "$*"
    echo "$out" | tail -5 | sed 's/^/       | /'
    fail=$((fail + 1))
  fi
}

WEB_CHECKS=(bash apps/bothy-web/checks/run.sh --offline)

echo "── the derivation that replaced a hardcoded home directory ─────────"
# The prefix trap: without the trailing slash a sibling checkout whose path
# merely STARTS with this one is filed as part of it.
mutant "asDir loses its trailing slash" \
  apps/bothy-web/web/src/lib/discover.ts \
  'const asDir = (p: string): string => (p.endsWith('"'"'/'"'"') ? p : `${p}/`);' \
  'const asDir = (p: string): string => p;' \
  -- "${WEB_CHECKS[@]}"

echo
echo "── identity is not display grouping ────────────────────────────────"
# A system's derived `system` and its displayed `group` are two fields precisely
# so that `dev.portal.group` cannot move a bookmarked URL or an accent colour.
# Collapse them back into one and every symptom is silent: the Overview looks
# right, and only the person who opens an old /control/systems/ link finds out.
mutant "a display label moves the identity too" \
  apps/bothy-web/web/src/lib/discover.ts \
  '    return {
      system,
      group: p.group' \
  '    return {
      system: labels['"'"'dev.portal.group'"'"'] ?? system,
      group: p.group' \
  -- "${WEB_CHECKS[@]}"

# The other half: makeNode() honoured dev.portal.group and allPorts() ignored it,
# so a system assembled with that label listed its services and none of its
# ports. Both read one classify() now; make the ports table read past it again.
mutant "the ports table stops honouring the label" \
  apps/bothy-web/web/src/lib/discover.ts \
  '        system: cls.system,
        group: cls.group,' \
  '        system: cls.system,
        group: cls.system,' \
  -- "${WEB_CHECKS[@]}"

# THE THIRD THING KEYED OFF A GROUP, after the accent seed and the bookmarked
# URL: which groups you collapsed, remembered per browser. Key it on the display
# name and the first `dev.portal.group` - or the first renamed compose project -
# silently expands every group somebody had closed and strands a dead entry in
# localStorage under the old name. Nothing errors, and the person it happens to
# has no reason to connect the two.
mutant "collapsed groups are filed under the display name" \
  apps/bothy-web/web/src/lib/discover.ts \
  'primaryIdentity(group, [...identities].sort())' \
  'group' \
  -- "${WEB_CHECKS[@]}"

# The prune that keeps stale keys from accumulating for the life of a browser
# profile, pointed at the wrong moment. The portal polls, and a poll that fails
# renders zero nodes - which reaches pruneCollapsed() as an empty `live` list and
# is indistinguishable from "the box has no services". Without the guard, one
# failed poll erases a layout, and the erase is written straight back to disk.
mutant "a failed poll prunes every collapsed group" \
  apps/bothy-web/web/src/lib/collapse.ts \
  'if (live.length === 0) return [...stored];' \
  'if (live.length < 0) return [...stored];' \
  -- "${WEB_CHECKS[@]}"

echo
echo "── the palette contract ────────────────────────────────────────────"
# Every colour must come from a token. A literal in a component is invisible in
# one theme and wrong in the other four.
mutant "a raw hex lands in a component" \
  apps/bothy-web/web/src/components/SystemName.tsx \
  'export function SystemName({' \
  'const MUTANT_TINT = '"'"'#ff00ff'"'"';

export function SystemName({' \
  -- "${WEB_CHECKS[@]}"

# A theme that omits a required token does not fall back to something sensible -
# the rule renders with an empty value and the syntax highlighting disappears.
mutant "a theme drops a required syntax token" \
  apps/bothy-web/web/src/themes/tokyo-night.css \
  '  --hl-kw:' \
  '  --mutant-removed-hl-kw:' \
  -- "${WEB_CHECKS[@]}"

echo
echo "── could anyone but its author run this ────────────────────────────"
# The baseline must only ever shrink. This is the check that made the SPA
# installable; if it stops noticing a new absolute path, that work rots.
#
# ASSEMBLED, for the same reason as BASH4_SUFFIX below and found the same way:
# written out in full, this payload is itself a hardcoded home path, so
# portability.sh flagged THIS FILE. Accepting it into the baseline was the
# obvious fix and the wrong one - the file whose job is to plant a home path
# would become the one file allowed to contain one for real. HOME_RE needs
# `/home/<name>/` contiguous, so splitting it costs nothing at runtime.
HOME_PREFIX='/home/'
mutant "a home directory is hardcoded again" \
  apps/bothy-web/web/src/lib/config.ts \
  'export const PROJECT_TITLE_FIELD' \
  'const MUTANT_PATH = '"'$HOME_PREFIX"'someone/stacks/'"'"';

export const PROJECT_TITLE_FIELD' \
  -- ./scripts/checks/portability.sh

# The third portability kind, and the one that was added because it had already
# happened. monitoring/prometheus.yml named the maintainer's email as the
# username the Prometheus self-scrape authenticates with, while the users map it
# authenticates against is generated from $DEV_LOGIN_USER - so the self-scrape
# 401'd on every install but one, and reported itself as a target that was
# merely DOWN.
#
# ASSEMBLED for the same reason as HOME_PREFIX above: written out whole, this
# payload is a real address in a tracked file, so portability.sh would flag
# THIS file - and the first draft of this very comment tripped it, by spelling
# out the shape of an address in prose. The pattern needs the local part, the
# at-sign and the domain contiguous, so splitting the payload at the at-sign
# costs nothing at runtime and keeps the check honest about its own source.
AT_SIGN='@'
mutant "a person's email is hardcoded in a config" \
  monitoring/prometheus.yml \
  '      password_file: /etc/prometheus/prom-password.txt' \
  '      username: someone'"$AT_SIGN"'realdomain.io
      password_file: /etc/prometheus/prom-password.txt' \
  -- ./scripts/checks/portability.sh

echo
echo "── the picture and the source it came from ─────────────────────────"
# docs/ARCHITECTURE.md shows six generated SVGs. The mermaid that produced them
# lives beside them in docs/diagrams/*.mmd, and NOBODY LOOKS AT THE SOURCE - so
# the failure mode is editing the .mmd, forgetting `just diagrams`, and shipping
# a document that confidently draws the old architecture. It looks healthy. That
# is exactly the silent kind this file exists for.
#
# THE ANCHOR IS THE DIRECTION KEYWORD, not any of the node text, and that is
# deliberate: `flowchart TB` is the first line of every one of these and will
# still be there after the boxes are all renamed, whereas an anchor quoting a
# label rots the first time somebody rewords it and `plant` then reports "anchor
# not found" - which reads as a broken harness rather than a rotted row.
#
# ASSEMBLED, like BASH4_SUFFIX and HOME_PREFIX above and found the same way: this
# row's whole job is to plant mermaid, and mermaid written out in full here is a
# mermaid graph living in a tracked file that is not a .mmd. diagrams.sh does not
# scan for that today, but the check it would grow to do so is the obvious next
# one ("no stray mermaid outside docs/diagrams"), and the payload that trips it
# would be this line. Splitting the keyword costs nothing at runtime.
FLOW_KW='flowchart'
mutant "a diagram source drifts from its SVG" \
  docs/diagrams/request-path.mmd \
  "$FLOW_KW TB" \
  "$FLOW_KW LR" \
  -- bash scripts/checks/diagrams.sh

# The regression this was written for, replayed: point a doc at a screenshot
# that was deleted two commits ago. `overview.png` exists, `portal-overview.png`
# is one of three that went in 2500aa0 while ARCHITECTURE.md kept naming them.
mutant "a doc points at a file that was deleted" \
  docs/ARCHITECTURE.md \
  'assets/overview.png' \
  'assets/portal-overview.png' \
  -- bash scripts/checks/doc-links.sh

# The regression this was written for is the one that already happened twice: a
# gated router is added in edge/dynamic/ and SECURITY.md's count is not. The
# mutation runs it the other way round - ungate one router - because it is the
# same disagreement and it does not need a router invented to plant it. Either
# direction means the security document no longer describes the boundary.
#
# THE ANCHOR IS THE `middlewares:` LINE, not the bare gate name. Every one of
# these files discusses its gates at length in the prose above the rules, so
# `sso-viewer` alone hits a COMMENT first - and the check strips comments before
# counting, exactly as it should. The mutation then applies cleanly, changes
# nothing the check looks at, and reports the check as decorative. Caught here
# on the first run; it is the no-op this file's own header warns about.
mutant "a gated router stops matching SECURITY.md's count" \
  edge/dynamic/bothy-config.yml \
  'middlewares: [bothy-config-strip, config-deidentify, sso-viewer, sso-errors]' \
  'middlewares: [bothy-config-strip, config-deidentify, sso-errors]' \
  -- bash scripts/checks/router-gates.sh

# THE OTHER THREE DOCUMENTS. Guarding SECURITY.md left README.md, the guide's
# roles page and ARCHITECTURE.md each carrying their own stale copy of the same
# number while this row was green - which is the point of the rows below: they
# mutate the copies, not the original. Each anchor is real prose from the
# document, never a comment; a comment anchor would apply cleanly, change
# nothing the check reads, and report the check as decorative.
#
# THESE THREE ANCHORS CARRY THE COUNT, so they move whenever a gated router is
# added - the same edit as the documents. A stale anchor here does not fail
# quietly: plant() cannot find it, and the row is reported as ERROR rather than
# PASS. That is the right direction to be wrong in, and it is how the two asks
# of 2026-10-06 (48 -> 50) were caught.
mutant "README's router table loses a tier's routers" \
  README.md \
  '| `edge/dynamic/bothy-updates.yml` | 7 |' \
  '| `edge/dynamic/bothy-updates.yml` | 6 |' \
  -- bash scripts/checks/router-gates.sh

mutant "the guide's router sentence goes stale" \
  docs/guide/roles.md \
  '50 routers carry a role requirement, across 5 files' \
  '49 routers carry a role requirement, across 5 files' \
  -- bash scripts/checks/router-gates.sh

# The prose two lines above a table the check already held. Written out in
# words, which is why it was never compared to anything until 2026-09-23.
mutant "SECURITY.md's spelled-out count leaves its own table" \
  SECURITY.md \
  'Fifty role-gated routers, in five files.' \
  'Forty-nine role-gated routers, in five files.' \
  -- bash scripts/checks/router-gates.sh

# The exact sentence that was wrong: "Only three tiers are behind single
# sign-on", in the page a new reader opens first, two tiers after it stopped
# being true.
mutant "the guide undercounts the tiers behind SSO" \
  docs/guide/index.md \
  'Only 5 tiers are behind single sign-on' \
  'Only 3 tiers are behind single sign-on' \
  -- bash scripts/checks/router-gates.sh

echo
echo "── facts a document states about the tree ──────────────────────────"
# The bug this replays verbatim: SECURITY.md's power table said `bothy-ops` could
# take "five cluster actions" while catalog.toml declared twenty-nine, in the
# cell a reader uses to size the blast radius of the `operator` role.
mutant "a document undercounts the cluster actions" \
  SECURITY.md \
  '**29 cluster actions** with a namespaced token' \
  '**5 cluster actions** with a namespaced token' \
  -- bash scripts/checks/doc-facts.sh

# "A container nothing browses: publish nothing, join devnet" ended with five
# containers to copy, four of which had been moved OFF devnet precisely because
# being reachable there IS authorisation for a socket proxy that has no auth of
# any kind. The recipe was telling a reader to undo the boundary.
mutant "the devnet recipe offers an isolated backend to copy" \
  docs/guide/services.md \
  'name. This is the correct default for exporters and sidecars - `oauth2-proxy`' \
  'name. This is the correct default for exporters and sidecars - `bothy-ops`' \
  -- bash scripts/checks/doc-facts.sh

# The foot-gun warnings. `consequenceOf` is an exact-match lookup on the live
# container name and a miss FAILS OPEN - no warning, no error, just a missing
# sentence before an action that takes the page away. This mutation is the rename
# that moves `container_name:` and forgets this map: the key count is unchanged, so
# only the half that holds every key to the compose files can catch it. Anchored on
# the map line, not on the paragraph above it.
mutant "a SELF key stops naming a live container" \
  apps/bothy-web/web/src/lib/actions.ts \
  "  'bothy-socket-read': 'Bothy reads Docker" \
  "  'bothy-control-socket-read': 'Bothy reads Docker" \
  -- bash scripts/checks/doc-facts.sh

# And the count itself, which until 2026-10-06 was uncheckable: the map held nine
# dead migration aliases against eight live keys, so the guide's "Eight" described
# the box correctly and the map not at all.
mutant "the guide miscounts the foot-gun warnings" \
  docs/guide/the-console.md \
  '**Foot-gun warnings.** Eight containers carry a sentence' \
  '**Foot-gun warnings.** Nine containers carry a sentence' \
  -- bash scripts/checks/doc-facts.sh

# `just urls` is the authority four documents defer to instead of keeping their
# own port table. Moving one port there is both failures at once: the published
# port is now unlisted, and the listed port is now published by nothing.
mutant "\`just urls\` names a port nothing publishes" \
  justfile \
  'http://$IP:3000' \
  'http://$IP:3009' \
  -- bash scripts/checks/doc-facts.sh

# The third copy of VERSION, and the one most people read. The anchor carries no
# version number on purpose - a mutant that has to be edited at every release is
# a mutant that breaks the release.
mutant "the README release badge drifts from VERSION" \
  README.md \
  'badge/release-v' \
  'badge/release-v9' \
  -- bash scripts/checks/version.sh

echo
echo "── one log shipper, one version ────────────────────────────────────"
# THE MUTATION IS #232 MERGING ALONE: grafana/alloy moved in monitoring/compose.yml
# and not in k8s/monitoring/alloy.yaml. It is not invented damage - it is the
# half-merge those two PRs make available every time Alloy releases, because a
# group cannot span the `docker-compose` and `docker` ecosystems and never will.
#
# THE ANCHOR IS THE `image:` LINE, which is real content. That version is also
# discussed in the prose above the service in the same file and in comments in
# three others, and alloy-pins.sh strips comments before matching - so anchoring
# on a sentence about v1.19.2 would apply cleanly, change nothing the check
# reads, and report the check as decorative. That is this file's own warning, and
# it is the mistake the router-gates row above was caught making.
# The anchor is the CURRENT pin, and it has to be re-read at every bump - which
# is the one maintenance cost of anchoring on a version string. It said v1.19.2
# for exactly as long as the tree did; after #232/#235 the mutation stopped
# applying at all, and `plant` reports that as ERROR rather than passing it off
# as caught. The substitute version just has to differ from the pin.
mutant "Alloy moves in compose but not in the manifest" \
  monitoring/compose.yml \
  'image: grafana/alloy:v1.20.1' \
  'image: grafana/alloy:v1.21.0' \
  -- bash scripts/checks/alloy-pins.sh

# The cluster e2e's constants, one row per source they are copied from. Each is
# the real Dependabot batch of 2026-10-05 landing without its companion edit.
mutant "VictoriaMetrics moves but the e2e constant does not" \
  monitoring/compose.yml \
  'image: victoriametrics/victoria-metrics:v1.153.0' \
  'image: victoriametrics/victoria-metrics:v1.154.0' \
  -- bash scripts/checks/e2e-pins.sh

mutant "the kube-state-metrics chart moves but the e2e constant does not" \
  k8s/monitoring/Chart.yaml \
  'version: 8.6.0' \
  'version: 8.7.0' \
  -- bash scripts/checks/e2e-pins.sh

# A rollback test whose two versions are equal passes by asserting nothing: it
# "rolls back" to the version it is already on and every assertion holds.
mutant "the e2e rollback target equals the version it upgrades to" \
  apps/bothy-ops/checks/e2e_cluster.py \
  'KSM_OLD, KSM_NEW = "8.5.0", "8.6.0"' \
  'KSM_OLD, KSM_NEW = "8.6.0", "8.6.0"' \
  -- bash scripts/checks/e2e-pins.sh

# The fixture was a literal while the constant moved, so the plan the test built
# named a version the tree had stopped pinning. Writing it out again is the
# regression; deriving it is what makes the fourth copy stop being a copy.
mutant "the e2e fixture writes the version out instead of deriving it" \
  apps/bothy-ops/checks/e2e_cluster.py \
  '"current": {"tag": ALLOY_NEW.split(":")[1],' \
  '"current": {"tag": "v1.19.2",' \
  -- bash scripts/checks/e2e-pins.sh

echo
echo "── the grant that would make a browser root ────────────────────────"
# THE most dangerous single character in this repository. The socket-proxy
# image's granular ALLOW_* lines are `allow` rules with a broad `^/containers`
# rule below them and no deny in between, so POST=1 together with CONTAINERS=1
# permits every POST under /containers - /containers/create included, and a
# create with a bind mount of / is root on this box. Bothy runs two proxies
# (apps/bothy/compose.socket-proxy.yml) precisely so that neither one holds both flags.
#
# This row plants the pair on the WRITE proxy: the exact edit somebody reaching
# for "start a service from a compose file" (#91) would make, because it is the
# one that would appear to work.
mutant "the write socket proxy is granted CONTAINERS" \
  apps/bothy/compose.socket-proxy.yml \
  'CONTAINERS:     0' \
  'CONTAINERS:     1' \
  -- bash apps/bothy-ops/checks/run.sh --offline

# THE SAME PAIR, ON A PROXY THAT DOES NOT EXIST YET - and this is the row the
# one above cannot stand in for. Every named assertion in grants.py asks about
# `socket-read` and `socket-write`; a THIRD proxy added in another file walks
# past all of them, which is why that check now sweeps every compose file in the
# tree by image rather than by service name.
#
# The mutation plants a fourth proxy holding POST=1 and CONTAINERS=1 into the
# portal's socket-proxy file. Revert the sweep to the two named services and this
# row goes red while the row above stays green.
mutant "a fourth socket proxy appears with both flags" \
  apps/bothy/compose.socket-proxy.yml \
  '
services:
' \
  '
services:
  socket-proxy-run:
    image: tecnativa/docker-socket-proxy:0.3.0
    environment:
      POST:       1
      CONTAINERS: 1
      EXEC:       0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [socketnet]
' \
  -- bash apps/bothy-ops/checks/run.sh --offline

# EXEC on the read-only proxy - the one Traefik can reach. An exec into a
# container that holds /var/run/docker.sock is a host root shell, and both
# proxies hold it - so EXEC=0 is written out on each. The first occurrence in
# the file is bothy-socket-read's (the portal's proxy until 2026-09 merged it
# with the control read proxy), which both the named assertions and the
# repo-wide sweep must catch.
mutant "exec creeps on to the read socket proxy" \
  apps/bothy/compose.socket-proxy.yml \
  'EXEC:           0   # container exec == root on this box' \
  'EXEC:           1   # container exec == root on this box' \
  -- bash apps/bothy-ops/checks/run.sh --offline

echo
echo "── a declared project can still be acted on ────────────────────────"
# The regression this shipped with: `withDeclared` drops the discovered node for
# every container a project declares, so a declared node carrying `container:
# null` DELETES the restart/stop/start control from its own containers - and a
# stopped one then has no way back. Nothing errors; the cell is simply empty.
mutant "a declared service loses its container" \
  apps/bothy-web/web/src/lib/projects.ts \
  'container: liveContainer(svc, live),' \
  'container: null,' \
  -- "${WEB_CHECKS[@]}"

# The inverse, and the one with teeth: resolving a declared NAME to whatever
# container looks close enough. Compose numbers its containers (`cvops-api-1`),
# so a loose match would aim a verb at a container nobody named - and a name that
# matches nothing must resolve to nothing, because the only way to start a
# container that does not exist is /containers/create.
mutant "a declared name is matched loosely" \
  apps/bothy-web/web/src/lib/projects.ts \
  'return svc.container ? live.get(svc.container) ?? null : null;' \
  'if (!svc.container) return null;
  const want = svc.container;
  return live.get(want) ?? [...live.entries()].find(([k]) => k.startsWith(want))?.[1] ?? null;' \
  -- "${WEB_CHECKS[@]}"

echo
echo "── the path boundary ───────────────────────────────────────────────"
# THE containment check. Resolve first, compare after. Deleting it is the whole
# directory-traversal class in one line, and 30 unit cases exist to catch it.
mutant "resolve() stops containing paths" \
  apps/bothy-common/bothy_common/safepath.py \
  'if candidate != real_root and not candidate.startswith(real_root + os.sep):' \
  'if False:' \
  -- bash apps/bothy-files/checks/run.sh --offline

# A directory listed as a folder has to BE a folder. resolve() answers for a PATH
# and does not check the type, which is how listing `README.md` as a folder used to
# reach os.walk and come back empty - a folder that renders as empty rather than as
# refused, which reads as a missing file.
mutant "a file can be listed as a folder again" \
  apps/bothy-common/bothy_common/safepath.py \
  '    if not os.path.isdir(res.abspath):' \
  '    if False:' \
  -- bash apps/bothy-files/checks/run.sh --offline

# resolve() per entry, in the one-level listing. prune_dirs only filters
# DIRECTORIES, so a top-level dot FILE walks straight past it - which is exactly how
# .bash_history was being served the first time the `home` root was surveyed. The
# unit corpus plants one for this row.
mutant "the lazy listing stops resolving its entries" \
  apps/bothy-common/bothy_common/safepath.py \
  '            res = resolve(root_key, os.path.relpath(e.path, real))
        except PathRefused:
            continue' \
  '            res = Resolved(root_key=root_key, root_dir=real, abspath=e.path,
                           relpath=os.path.relpath(e.path, real),
                           git_root=None, git_relpath=None)
        except PathRefused:
            continue' \
  -- bash apps/bothy-files/checks/run.sh --offline

# ...and in the name search, where it matters more: find() resolves only the names
# that MATCH, which is what makes it 17x faster than filtering collect(), so the
# property that has to survive is that everything it RETURNS still went through
# resolve(). Same planted .bash_history catches it.
mutant "the name search stops resolving what it returns" \
  apps/bothy-common/bothy_common/safepath.py \
  '                res = resolve(root_key, os.path.relpath(full, real))
            except PathRefused:
                continue' \
  '                res = Resolved(root_key=root_key, root_dir=real, abspath=full,
                               relpath=os.path.relpath(full, real),
                               git_root=None, git_relpath=None)
            except PathRefused:
                continue' \
  -- bash apps/bothy-files/checks/run.sh --offline

# The symlink skip, in the listing. resolve() returns the path a name RESOLVES to,
# so a symlink's row carries the TARGET's path - which a tree builder then files
# under a parent nobody asked about, and which is a duplicate of the row the target
# already has. Dropping it is how a listing of `docs` describes something that is
# not in docs.
mutant "a lazy listing follows a symlink" \
  apps/bothy-common/bothy_common/safepath.py \
  '        if e.is_symlink():
            continue' \
  '        if False:
            continue' \
  -- bash apps/bothy-files/checks/run.sh --offline

# The same skip in the name search, where the symptom is a hit list carrying the
# same file twice under two names.
mutant "the name search follows symlinks" \
  apps/bothy-common/bothy_common/safepath.py \
  '            if os.path.islink(full):
                continue
            try:
                res = resolve(root_key, os.path.relpath(full, real))' \
  '            if False:
                continue
            try:
                res = resolve(root_key, os.path.relpath(full, real))' \
  -- bash apps/bothy-files/checks/run.sh --offline

# The bound that REPLACED MAX_LISTING, and the half that makes it a replacement
# rather than the same mistake: a search that stops has still seen the whole tree
# and says so. Stop silently and "no results" is indistinguishable from "I gave up",
# which is exactly how the 4,000-row listing made 15,000 files look absent.
mutant "a bounded search stops saying it was bounded" \
  apps/bothy-common/bothy_common/safepath.py \
  '                stopped = {"reason": "too many matches", "limit": limit,
                           "scanned": scanned}
                break' \
  '                break' \
  -- bash apps/bothy-files/checks/run.sh --offline

echo
echo "── the tree the browser builds out of those listings ───────────────"
# The listings that have already arrived, dropped on the next rebuild. It looks
# exactly like a collapse - the rows are gone, nothing errors - and it is the
# obvious wrong simplification of "rebuild from the map".
mutant "a rebuild keeps only the newest listing" \
  apps/bothy-web/web/src/pages/files/tree.ts \
  'const dirs = [...loaded.keys()].sort((a, b) => a.split('"'"'/'"'"').length - b.split('"'"'/'"'"').length);' \
  'const dirs = [...loaded.keys()].slice(-1);' \
  -- "${WEB_CHECKS[@]}"

# "Nobody has opened this folder" and "this folder is empty" are the same empty
# children array. Mark everything loaded and the reader is told a directory is
# empty when it has simply not been asked for - the one state the eager tree never
# had to express.
mutant "an unopened folder claims to be empty" \
  apps/bothy-web/web/src/pages/files/tree.ts \
  'return { name, path, dir, entry: null, children: [], loaded: !dir };' \
  'return { name, path, dir, entry: null, children: [], loaded: true };' \
  -- "${WEB_CHECKS[@]}"

echo
echo "── what a browser can make the host updater do ─────────────────────"
# The update request is the one route whose effect lands on the HOST. Its gate is
# `operator`; the executor re-checks the plan id against a plan it recomputes;
# it refuses a component outside the classes it handles; and a rollback edits
# a pin line only when the line still reads exactly what the plan recorded.
# Each row removes one of those, as a well-meaning simplification would.
mutant "the update request is gated on viewer" \
  edge/dynamic/bothy-updates.yml \
  'middlewares: [bothy-updates-strip, updates-deidentify, sso-operator, sso-errors]' \
  'middlewares: [bothy-updates-strip, updates-deidentify, sso-viewer, sso-errors]' \
  -- python3 apps/bothy-ops/checks/wiring_updates.py

mutant "the executor trusts the request's plan id" \
  apps/bothy-ops/updater/spool.py \
  'if p.get("id") != doc["planId"]:' \
  'if False:' \
  -- python3 apps/bothy-ops/checks/test_updater.py

mutant "a request names a class the updater skips" \
  apps/bothy-ops/updater/spool.py \
  'if classes.get(comp.cls, comp.id) is None:' \
  'if False:' \
  -- python3 apps/bothy-ops/checks/test_updater.py

mutant "a rollback edits a line it did not read" \
  apps/bothy-ops/updater/pins.py \
  'lines[pin.line - 1] != pin.text:' \
  'False:' \
  -- python3 apps/bothy-ops/checks/test_updater.py

# Step 7, the automatic channel: the unpause is the second route that asks the
# host for something, and the night job's gates are the only thing between a
# merged patch and an unattended deploy.
mutant "the unpause is gated on viewer" \
  edge/dynamic/bothy-updates.yml \
  'rule: "Path(`/-/api/updates/unpause`) && Method(`POST`)"
      entryPoints: [web]
      priority: 110
      service: bothy-updates
      middlewares: [bothy-updates-strip, updates-deidentify, sso-operator, sso-errors]' \
  'rule: "Path(`/-/api/updates/unpause`) && Method(`POST`)"
      entryPoints: [web]
      priority: 110
      service: bothy-updates
      middlewares: [bothy-updates-strip, updates-deidentify, sso-viewer, sso-errors]' \
  -- python3 apps/bothy-ops/checks/wiring_updates.py

# 2026-10-06, the two asks. The first two rows are the gates. The next two are the
# HOST's copies of a refusal bothy-ops also makes - the copies that hold when the
# asking process is the thing that is wrong. The last two are the wiring, and the
# `entries()` one is the row this set exists for: removing an ask kind from
# OTHER_KINDS reads as tidying up, and the update loop then deletes every ask as
# junk, so both controls go quiet with no error anywhere.
mutant "check-for-updates is gated on viewer" \
  edge/dynamic/bothy-updates.yml \
  'rule: "Path(`/-/api/updates/discover`) && Method(`POST`)"
      entryPoints: [web]
      priority: 110
      service: bothy-updates
      middlewares: [bothy-updates-strip, updates-deidentify, sso-operator, sso-errors]' \
  'rule: "Path(`/-/api/updates/discover`) && Method(`POST`)"
      entryPoints: [web]
      priority: 110
      service: bothy-updates
      middlewares: [bothy-updates-strip, updates-deidentify, sso-viewer, sso-errors]' \
  -- python3 apps/bothy-ops/checks/wiring_updates.py

mutant "the night-job button is gated on viewer" \
  edge/dynamic/bothy-updates.yml \
  'rule: "Path(`/-/api/updates/autorun`) && Method(`POST`)"
      entryPoints: [web]
      priority: 110
      service: bothy-updates
      middlewares: [bothy-updates-strip, updates-deidentify, sso-operator, sso-errors]' \
  'rule: "Path(`/-/api/updates/autorun`) && Method(`POST`)"
      entryPoints: [web]
      priority: 110
      service: bothy-updates
      middlewares: [bothy-updates-strip, updates-deidentify, sso-viewer, sso-errors]' \
  -- python3 apps/bothy-ops/checks/wiring_updates.py

mutant "the host stops rate-limiting discovery" \
  apps/bothy-ops/updater/asks.py \
  'if age is not None and age < updates.DISCOVER_MIN_SECONDS:' \
  'if False:' \
  -- python3 apps/bothy-ops/checks/test_asks.py

mutant "an ask may name the night job as its asker" \
  apps/bothy-ops/updater/asks.py \
  'if not isinstance(who, str) or not 0 < len(who) <= 200 or who == updates.AUTO_ACTOR:' \
  'if not isinstance(who, str) or not 0 < len(who) <= 200:' \
  -- python3 apps/bothy-ops/checks/test_asks.py

mutant "the drain loop stops claiming discoveries" \
  apps/bothy-ops/updater/executor.py \
  '            _hook(cfg, "asks", "drain_discover")' \
  '' \
  -- python3 apps/bothy-ops/checks/wiring_updates.py

mutant "an ask kind is removed as junk by the update loop" \
  apps/bothy-ops/updater/spool.py \
  'OTHER_KINDS = (UNPAUSE_FILE, DISCOVER_FILE, AUTORUN_FILE)' \
  'OTHER_KINDS = (UNPAUSE_FILE,)' \
  -- python3 apps/bothy-ops/checks/test_asks.py

mutant "a missed night is caught up at boot" \
  host/systemd/bothy-updater-auto.timer \
  'Persistent=false' \
  'Persistent=true' \
  -- python3 apps/bothy-ops/checks/wiring_auto.py

mutant "the night job ignores a failed backup" \
  apps/bothy-ops/updater/auto.py \
  'if props.get("Result") != "success" or props.get("ExecMainStatus") != "0":' \
  'if False:' \
  -- python3 apps/bothy-ops/checks/test_auto.py

mutant "the night job ignores a pause" \
  apps/bothy-ops/updater/auto.py \
  'if cid in st["paused"]:' \
  'if False:' \
  -- python3 apps/bothy-ops/checks/test_auto.py

mutant "bothy-ops may write as the night job" \
  apps/bothy-ops/updates.py \
  'if flat(who) == AUTO_ACTOR:' \
  'if False:' \
  -- python3 apps/bothy-ops/checks/api_updates_apply.py

echo
echo "── what Bothy will deploy of itself (step 6) ───────────────────────"
# Bothy updating itself moves the checkout and restarts the UI that asked. What
# keeps it to reviewed code is four refusals in the plan and one fact about where
# the updater runs. Each row removes one, as a "why is it refusing?" fix would.
mutant "Bothy deploys a release CI did not pass" \
  apps/bothy-ops/updater/owncode.py \
  'if not ci.get("green"):' \
  'if False:' \
  -- python3 apps/bothy-ops/checks/test_owncode.py

mutant "Bothy deploys a tag that is not on main" \
  apps/bothy-ops/updater/owncode.py \
  '    rc, _ = git(cfg.repo, "merge-base", "--is-ancestor", sha, "refs/remotes/origin/main")
    if rc != 0:' \
  '    rc, _ = git(cfg.repo, "merge-base", "--is-ancestor", sha, "refs/remotes/origin/main")
    if False:' \
  -- python3 apps/bothy-ops/checks/test_owncode.py

mutant "Bothy moves (and may reset) a dirty checkout" \
  apps/bothy-ops/updater/owncode.py \
  'if rc != 0 or dirty:' \
  'if rc != 0:' \
  -- python3 apps/bothy-ops/checks/test_owncode.py

mutant "the updater runs from the checkout it moves" \
  host/systemd/bothy-updater.service \
  '/.local/lib/bothy-updater/current/apps/bothy-ops' \
  '/stacks/apps/bothy-ops' \
  -- python3 apps/bothy-ops/checks/wiring_updates.py

echo
echo "── the cluster add-ons and the Postgres major (step 8) ─────────────"
# The cluster class acts with the operator's kubeconfig on a NAMED context and
# never as a ServiceAccount (rule 6); the Postgres major is never a click, never
# the night job, and never onto the old or an empty volume. Each row removes one.
mutant "the cluster class acts as a ServiceAccount (bothy-ops' token)" \
  apps/bothy-ops/updater/k8s.py \
  'if user.startswith("system:serviceaccount:"):' \
  'if False:' \
  -- python3 apps/bothy-ops/checks/test_step8.py

mutant "a kubectl argv relies on the current context" \
  apps/bothy-ops/updater/k8s.py \
  'argv = ["kubectl", "--context", _ctx(cfg), f"--request-timeout={REQUEST_TIMEOUT}"]' \
  'argv = ["kubectl", f"--request-timeout={REQUEST_TIMEOUT}"]' \
  -- python3 apps/bothy-ops/checks/test_step8.py

mutant "a Postgres major runs on the OLD volume" \
  apps/bothy-ops/updater/pgmajor.py \
  'if new_key == old_key:' \
  'if False:' \
  -- python3 apps/bothy-ops/checks/test_step8.py

mutant "the executor runs a Postgres major without a note" \
  apps/bothy-ops/updater/spool.py \
  'if p.get("requiresNote") and not (isinstance(doc.get("note"), str) and doc["note"].strip()):' \
  'if False:' \
  -- python3 apps/bothy-ops/checks/test_step8.py

mutant "the night job may run a Postgres major" \
  apps/bothy-ops/updater/pgmajor.py \
  'if doc.get("requestedBy") == "auto":' \
  'if False:' \
  -- python3 apps/bothy-ops/checks/test_step8.py

mutant "bothy-ops queues a Postgres major without a note" \
  apps/bothy-ops/updates.py \
  '    if p["requiresNote"]:' \
  '    if False:' \
  -- python3 apps/bothy-ops/checks/api_updates_apply.py

mutant "up-data starts Postgres on an empty new volume" \
  scripts/pg-volume-guard.sh \
  '[ -z "$others" ] && exit 0' \
  'exit 0' \
  -- python3 apps/bothy-ops/checks/test_step8.py

echo
echo "── the shell layer macOS has to parse ──────────────────────────────"
# bash 4 syntax is a PARSE error on the bash 3.2 macOS ships: the script does not
# run at all, and the error names a line that looks fine.
#
# THE PAYLOAD IS ASSEMBLED, NOT WRITTEN OUT, and that is not fussiness. Spelled
# literally, `${PATH,,}` here is itself bash 4 syntax on a non-comment line, so
# bash32.sh flagged THIS FILE the first time it ran - the same self-matching
# regex this repo has already been bitten by once. The alternative was to exempt
# mutants.sh from the scan, which would mean the one file guaranteed to contain
# bash 4 syntax is the one file never checked for it. Split across a variable,
# the pattern exists at runtime and not in the source.
BASH4_SUFFIX=',,'
mutant "bash 4 syntax creeps back in" \
  scripts/doctor.sh \
  'set -uo pipefail' \
  'set -uo pipefail
mutant_lower="${PATH'"$BASH4_SUFFIX"'}"' \
  -- bash scripts/checks/bash32.sh

# THE SAME RULE, IN THE FILE THAT HAD NO EXTENSION. The row above plants in
# scripts/doctor.sh, which is a *.sh file and was therefore always scanned - so
# it passes whether the finder selects by suffix or by shebang, and it could not
# have caught what was actually wrong: `find ... -name '*.sh'` walked straight
# past scripts/bothy, the CLI, which is bash and is the file where a bash 4
# construct hurts most (macOS ships 3.2, and ${x,,} is a PARSE error there, so
# the script does not run at all and the message names a line that looks fine).
#
# This row is what stops that hole reopening: revert the finder to a suffix glob
# and this goes red while the row above stays green.
mutant "bash 4 syntax creeps into the extensionless CLI" \
  scripts/bothy \
  'set -uo pipefail' \
  'set -uo pipefail
mutant_lower="${PATH'"$BASH4_SUFFIX"'}"' \
  -- bash scripts/checks/bash32.sh

echo
echo "── what \`curl | sh\` would actually install ─────────────────────────"
# scripts/bothy.sh clones a release and refuses to go on unless the tag resolves
# to a commit id written into the installer. That id is a THIRD copy of what
# VERSION and the git tag already say, and the way it goes wrong is a stale or
# mistyped constant that nothing in the tree looks wrong next to: every install
# then fails at the verify step and blames the repository, or - worse - the pin
# is left behind at an old release and every install silently succeeds with the
# wrong code.
#
# ANCHORED ON THE ASSIGNMENT, NOT ON THE VALUE, and that is the whole reason
# this row does not need editing at every release. A mutation whose anchor is
# `…="25d6ef4…"` stops applying the day the pin is bumped, and `plant` then
# reports "anchor not found" - which reads as the harness being broken rather
# than as a row that has rotted. Prefixing a digit models the realistic slip
# (one character in a forty-character constant) and applies to whatever the pin
# happens to be.
mutant "the installer's pinned sha drifts" \
  scripts/bothy.sh \
  'BOTHY_PIN_SHA="' \
  'BOTHY_PIN_SHA="0' \
  -- bash scripts/checks/installer-pin.sh

echo
echo "── what the app shows while it is waiting ──────────────────────────"
# Four rows, one per fault found on 2026-09-23, each anchored on REAL MARKUP
# rather than on a comment. A check that strips comments - and this one does,
# first thing - will happily "pass" a mutation planted in prose, and a no-op
# mutation makes a decorative check look vigilant.

# 1. The plate is what gives the loader a clear area over a skeleton. Make it
#    translucent and the orb is back on the grey bars with a blur over them,
#    which is the original defect wearing the fix's name. Decision 4 also
#    reserves translucent material for the top bar and the palette.
mutant "the loader's plate goes translucent" \
  apps/bothy-web/web/src/components/ui/Loader.css \
  '.ui-loader-plate {
  background: var(--surface-4);' \
  '.ui-loader-plate {
  background: color-mix(in oklab, var(--surface-4) 70%, transparent);
  backdrop-filter: blur(12px);' \
  -- "${WEB_CHECKS[@]}"

# 2. The Skeleton is the one Loader in the app that is laid OVER content, so it
#    is the one call site that must pass `plate`. Dropping the prop restores the
#    exact screenshot this batch started from.
mutant "the skeleton's loader loses its plate" \
  apps/bothy-web/web/src/components/states.tsx \
  'label={label} plate className="skel-orb"' \
  'label={label} className="skel-orb"' \
  -- "${WEB_CHECKS[@]}"

# 3. The defect itself: the Control landing standing under the Overview's
#    skeleton - a status line and chip rows reserved for a page that is a health
#    strip over a card grid. Nothing in the tree related a page to its shape
#    until the register in checks/loading-states.mjs, which is why this went
#    unnoticed through a whole design batch.
mutant "a page is pointed at another page's skeleton" \
  apps/bothy-web/web/src/pages/control/ControlHome.tsx \
  '<Skeleton variant="control"' \
  '<Skeleton variant="overview"' \
  -- "${WEB_CHECKS[@]}"

# 4. The quick-links strip inventing a link to a port nothing listens on. The
#    port index is built from the compose files and skips anything behind a
#    `profiles:` key - `prometheus` is still IN monitoring/compose.yml under
#    `legacy-prometheus`, so a check that merely grepped the repo for 9090 would
#    have called this link fine.
mutant "a fallback link points at a retired service" \
  apps/bothy-web/web/src/pages/Overview.tsx \
  "{ key: 'victoriametrics', label: 'Metrics', port: 8428 }," \
  "{ key: 'prometheus', label: 'Prometheus', port: 9090 }," \
  -- "${WEB_CHECKS[@]}"

echo
echo "── the two statuses that are allowed to be quiet ───────────────────"
# `done` and `dormant` exist to STOP the page shouting, which makes every one of
# them a way to hush something real. Each row below is the precise inversion of a
# rule the classifier states, and each is anchored on the executable line rather
# than on the comment above it - a mutation planted in a comment applies cleanly,
# changes nothing, and reports the check as decorative when the check is fine.
# That no-op has already cost this repo a run.
#
# `done` needs a DECLARATION. Drop it and every clean exit on the box is a
# success story, prometheus and promtail included.
mutant "done is inferred from exit 0 alone" \
  apps/bothy-web/web/src/lib/discover.ts \
  "      if (code === 0 && ctx.oneShot) return 'done';" \
  "      if (code === 0) return 'done';" \
  -- "${WEB_CHECKS[@]}"

# `dormant` needs BOTH halves. Without the sibling test, age alone reaches
# prometheus - parked on purpose six days ago, and parked for good reason.
mutant "dormant forgets to ask about siblings" \
  apps/bothy-web/web/src/lib/discover.ts \
  '      if (ago != null && ago >= DORMANT_AFTER_SECONDS && ctx.projectAlive === false) {' \
  '      if (ago != null && ctx.projectAlive === false) {' \
  -- "${WEB_CHECKS[@]}"

# Without the age test, every container in a switched-off project is history the
# moment the last sibling stops - including the one that crashed on the way out,
# thirty seconds ago.
mutant "dormant forgets to ask how old it is" \
  apps/bothy-web/web/src/lib/discover.ts \
  '      if (ago != null && ago >= DORMANT_AFTER_SECONDS && ctx.projectAlive === false) {' \
  '      if (ago != null && ago >= 0 && ctx.projectAlive === false) {' \
  -- "${WEB_CHECKS[@]}"

# The threshold itself. A day is still "a while ago" to a reader and is nowhere
# near a fortnight, which is the whole argument in the constant's comment.
mutant "the fortnight becomes a day" \
  apps/bothy-web/web/src/lib/discover.ts \
  'export const DORMANT_AFTER_SECONDS = 14 * 86_400;' \
  'export const DORMANT_AFTER_SECONDS = 1 * 86_400;' \
  -- "${WEB_CHECKS[@]}"

# THE RULE THAT MUST NOT WEAKEN, planted as the tempting version of it: "it
# exited non-zero in a project where nothing is running, so it probably does not
# matter". A crash five minutes ago is an alarm whatever owns it.
mutant "a crash in a dead project is quietly filed as history" \
  apps/bothy-web/web/src/lib/discover.ts \
  "      return code === 0 || code === 143 ? 'stopped' : 'down';" \
  "      return code === 0 || code === 143 ? 'stopped' : (ctx.projectAlive === false ? 'dormant' : 'down');" \
  -- "${WEB_CHECKS[@]}"

# Absence of evidence becoming evidence of absence, in one character. `undefined`
# means nobody resolved the fact; `!undefined` is true, so every caller that does
# not pass the whole-list facts would start producing dormant containers.
mutant "not knowing counts as abandoned" \
  apps/bothy-web/web/src/lib/discover.ts \
  '      if (ago != null && ago >= DORMANT_AFTER_SECONDS && ctx.projectAlive === false) {' \
  '      if (ago != null && ago >= DORMANT_AFTER_SECONDS && !ctx.projectAlive) {' \
  -- "${WEB_CHECKS[@]}"

# Every bare `docker run` container filed under one project. `thales-scc` is up
# and `mpeg-redis` has been dead six weeks; put them in the same bucket and the
# live one vouches for the dead one forever.
mutant "unlabelled containers all share one project" \
  apps/bothy-web/web/src/lib/discover.ts \
  "  return container.Labels?.['com.docker.compose.project'] || \`container:\${container.Id}\`;" \
  "  return container.Labels?.['com.docker.compose.project'] || 'unmanaged';" \
  -- "${WEB_CHECKS[@]}"

# A crash loop is a project being run right now, badly. Stop counting it as alive
# and the loop's siblings start going dormant around it.
mutant "a crash loop no longer keeps its project alive" \
  apps/bothy-web/web/src/lib/discover.ts \
  "    if (s === 'running' || s === 'restarting') out.add(projectKeyOf(c));" \
  "    if (s === 'running') out.add(projectKeyOf(c));" \
  -- "${WEB_CHECKS[@]}"

# The wire. statusOf() is pure and takes both facts as arguments, so every truth
# -table row passes whether or not merge() resolves them - which is exactly how
# the live section of run.sh printed a perfectly healthy table while reporting
# every dormant container on the box as `stopped`.
mutant "merge stops handing the classifier its whole-list facts" \
  apps/bothy-web/web/src/lib/discover.ts \
  '    status: statusOf(container, kind, { oneShot: completesOnPurpose, projectAlive }),' \
  '    status: statusOf(container, kind),' \
  -- "${WEB_CHECKS[@]}"

# The clock the threshold reads. A 0 where a null belongs reads as "it stopped
# just now" and keeps a six-week-old corpse out of `dormant` for good - the same
# shape as the parseUptime bug that put unparseable containers at the top of
# "recently started" as "0s ago".
mutant "an unreadable exit time becomes zero instead of null" \
  apps/bothy-web/web/src/lib/discover.ts \
  '  return m ? humanDurationSecs(m[1]) : null;' \
  '  return m ? humanDurationSecs(m[1]) ?? 0 : 0;' \
  -- "${WEB_CHECKS[@]}"

echo
echo "── batch A: the footprint rule, on the pages that had not adopted it ─"
# Every row here is anchored on the DECLARATION, never on the comment above it.
# A mutation planted in prose applies cleanly, changes nothing, and reports a
# healthy check as decorative - a no-op this repo has paid for twice, and both
# of the checks these rows guard strip comments before they read anything.

# A1. The defect as it shipped: the counts are `auto`, so the `1fr` is the BAR,
# and in a 1320px column that is ~1100px of 8px ribbon for one ratio. Nothing
# about the page looks broken afterwards, which is why it survived two batches.
mutant "the health strip's bar spans the page again" \
  apps/bothy-web/web/src/pages/Overview.css \
  '  display: grid; grid-template-columns: auto minmax(7.5rem, 20rem);' \
  '  display: grid; grid-template-columns: auto minmax(7.5rem, 1fr);' \
  -- "${WEB_CHECKS[@]}"

# ...and the half of the cap that is not the cap. A grid stretches `auto` tracks
# and only `auto` tracks, so dropping this leaves the bar 20rem wide and pinned
# to the right edge: the same full-width line, drawn the other way round.
mutant "the capped bar drifts to the right edge" \
  apps/bothy-web/web/src/pages/Overview.css \
  '  justify-content: start;
  align-items: center; gap: var(--sp-4);' \
  '  align-items: center; gap: var(--sp-4);' \
  -- "${WEB_CHECKS[@]}"

# A2. A stored primary is read back as itself instead of being checked against
# the list this build draws. The preference then persists perfectly and reaches
# nothing: a renamed tile leaves a strip with a primary no tile matches, which
# looks exactly like the preference having been lost.
mutant "a stored primary tile is trusted unchecked" \
  apps/bothy-web/web/src/lib/prefs.ts \
  '    (typeof v === '"'"'string'"'"' && (allowed as readonly string[]).includes(v) ? (v as T) : null);' \
  '    (typeof v === '"'"'string'"'"' ? (v as T) : null);' \
  -- "${WEB_CHECKS[@]}"

# ...and the other end of the same wire: the list and the page disagreeing about
# an id. Nothing throws, nothing looks broken, and the pin simply never lights.
mutant "a quick-view tile id drifts from the one the strip renders" \
  apps/bothy-web/web/src/components/QuickView.tsx \
  '        id="net"' \
  '        id="eth"' \
  -- "${WEB_CHECKS[@]}"

# The toggle. Without the clear, "no primary" - the state every browser starts
# in - becomes unreachable the moment anybody presses anything.
mutant "the primary can be moved but never cleared" \
  apps/bothy-web/web/src/lib/prefs.ts \
  '  return current === id ? null : id;' \
  '  return id;' \
  -- "${WEB_CHECKS[@]}"

echo
echo "── the check harness itself ────────────────────────────────────────"
# Three suites shipped `cd "$HERE/.."` with no `|| exit`, so a failed cd ran
# every check below against the caller's directory. shellcheck at -S warning is
# what found it, which is why warnings are fatal there rather than advisory.
#
# SKIPPED OUT LOUD when shellcheck is absent. A row that quietly disappears on a
# box without the tool turns "7 caught" into "6 caught" and nothing says which
# one stopped running - the silent-cap failure this repo has a rule against.
if command -v shellcheck >/dev/null 2>&1; then
  mutant "an unguarded cd returns to the harness" \
    scripts/checks/bash32.sh \
    'cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1' \
    'cd "$(dirname "${BASH_SOURCE[0]}")/../.."' \
    -- bash -c 'shellcheck -x -S warning scripts/checks/bash32.sh'
else
  echo "SKIP   an unguarded cd returns to the harness    shellcheck is not installed"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "$pass mutation(s) planted, every one caught."
else
  echo "$pass caught, $fail NOT CAUGHT - see above. A check that cannot fail is"
  echo "worse than no check: it reads as a clean bill of health."
fi
exit $((fail > 0 ? 1 : 0))
