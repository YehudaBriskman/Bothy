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
# The confirm level, in the direction that reads as a guard rail existing when it
# does not. This is one of the five that were actually wrong on 2026-10-07 - the
# table said `set-image` needed the deployment's name typed, and the catalog has
# said `click` since design decision 7. Anchored on the table row, which is an
# executable line of the document in the only sense that matters here: the check
# parses it, so an edit that reworded it away would fail rather than go quiet.
mutant "SECURITY.md overstates a confirm level" \
  SECURITY.md \
  '`set-image` (click), `rollback-to-revision` (click)' \
  '`set-image` (type-name), `rollback-to-revision` (type-name)' \
  -- bash scripts/checks/doc-facts.sh

# And the other direction, which is the one a runbook trips over: the table
# promising one click where the service will stop and ask for the name.
mutant "SECURITY.md understates a confirm level" \
  SECURITY.md \
  '`delete-job` (type-name)' \
  '`delete-job` (click)' \
  -- bash scripts/checks/doc-facts.sh

# `scale` is the only action with an `escalate`, and the escalation is the half
# that matters: scaling to 1..3 is undone by scaling back, scaling to 0 stops the
# workload and only the manifest decides whether anything restarts it. A table
# that states the base level and omits the escalation understates it, so dropping
# the clause has to fail - a level that is "click" is not wrong enough on its own.
mutant "the table drops \`scale\`'s escalation at 0" \
  SECURITY.md \
  '`scale` 0..3 (click; the name typed to scale to 0)' \
  '`scale` 0..3 (click)' \
  -- bash scripts/checks/doc-facts.sh

# The completeness half. An action lands in catalog.toml, nobody adds it to the
# table, and the only thing that used to notice was the action COUNT - which is
# exactly how "five cluster actions" survived to twenty-nine. Deleting a row's id
# from the Changes cell is that omission, with the count left correct.
mutant "an operator action vanishes from the rule 6 table" \
  SECURITY.md \
  ', `run-template` (type-name) |' \
  ' |' \
  -- bash scripts/checks/doc-facts.sh

# The ConfigMap key count, which unlike the others does NOT only grow: the
# widening from 3 to 22 was a product decision and a reversible one, so the
# document can now be wrong in either direction.
mutant "SECURITY.md miscounts the allowlisted ConfigMap keys" \
  SECURITY.md \
  'change only the **22 allowlisted keys**' \
  'change only the **3 allowlisted keys**' \
  -- bash scripts/checks/doc-facts.sh

echo
echo "── the key allowlist and the Role it needs ─────────────────────────"
# Lock 2 (the key allowlist) and lock 3 (the generated Role) have to agree on
# whether a key can be changed at all, and nothing held them together until
# 2026-10-07. The widening showed why it matters: the Role ALREADY granted
# `configmaps: patch`, so all 67 refusals came from the allowlist and none from
# the cluster. Emptying the table leaves a patch verb nothing can reach - the
# kind of grant a reader of SECURITY.md counts against this tier and nobody can
# account for. Anchored on the first key's table header, an executable line.
mutant "the key allowlist empties and the Role keeps patch" \
  apps/bothy-ops/catalog.toml \
  '[configmap_keys.LOG_LEVEL]' \
  '[configmap_keys_disabled.LOG_LEVEL]' \
  -- python3 apps/bothy-ops/checks/wiring.py

# And the half that would draw 22 Edit buttons whose every save is a 502 naming
# the Role: a pattern that is "a number" rather than a bounded range. 5400 is as
# much an outage as "abc" - the pod starts, and the solve answers long after the
# gateway 504'd the caller.
mutant "a pattern stops being a bounded range" \
  apps/bothy-ops/catalog.toml \
  'pattern = "[1-9]|[1-9][0-9]|[1-4][0-9]{2}|5[0-6][0-9]|570"' \
  'pattern = "[0-9]+"' \
  -- python3 apps/bothy-ops/checks/wiring.py

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

# `plant` replaces the FIRST occurrence, and this line appears in all five write
# handlers, so each anchor carries enough of its own handler to be unique. It was
# NOT, until 2026-10-07: the group writer was added above request_update() and
# silently took the mutation, leaving request_update's check intact and this row
# passing with nothing broken - the decorative-check failure this file exists for.
mutant "bothy-ops may write as the night job" \
  apps/bothy-ops/updates.py \
  'if flat(who) == AUTO_ACTOR:
        # The night job'"'"'s name (updater/auto.py).' \
  'if False:
        # The night job'"'"'s name (updater/auto.py).' \
  -- python3 apps/bothy-ops/checks/api_updates_apply.py

mutant "bothy-ops may ask for a GROUP as the night job" \
  apps/bothy-ops/updates.py \
  'if flat(who) == AUTO_ACTOR:
        raise Refused(f"{AUTO_ACTOR!r} is the automatic channel'"'"'s name, not a person'"'"'s", status=403)
    doc = _read_group(gid)' \
  'if False:
        raise Refused(f"{AUTO_ACTOR!r} is the automatic channel'"'"'s name, not a person'"'"'s", status=403)
    doc = _read_group(gid)' \
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
echo "── applying a whole recipe at once, without loosening the rule ─────"
# The group exists because `just up-monitoring` is ONE `docker compose up`, so a
# project with two merged pins waiting can never be applied one component at a
# time - the scope check, rightly, refuses both. Every row here is a way the group
# could become a hole in that check instead of the action it is missing.

mutant "the group is the LOOSEST of its members, not the strictest" \
  apps/bothy-ops/updater/groups.py \
  'confirm = "type-name" if (one_way or worst == "major") else "click"' \
  'confirm = "click"' \
  -- python3 apps/bothy-ops/checks/test_groups.py

mutant "the group stops checking the scope of its union" \
  apps/bothy-ops/updater/groups.py \
  'others = [s for s in pj["want"] if s not in mine and pj["have"].get(s) != pj["want"][s]]' \
  'others = []' \
  -- python3 apps/bothy-ops/checks/test_groups.py

mutant "one component counts as a group" \
  apps/bothy-ops/updater/groups.py \
  'MIN_MEMBERS = 2' \
  'MIN_MEMBERS = 1' \
  -- python3 apps/bothy-ops/checks/test_groups.py

mutant "the auth boundary joins a compose group" \
  apps/bothy-ops/updater/groups.py \
  'GROUP_CLASSES = frozenset({"stateless", "timeseries", "app-db"})' \
  'GROUP_CLASSES = frozenset({"stateless", "timeseries", "app-db", "boundary"})' \
  -- python3 apps/bothy-ops/checks/test_groups.py

mutant "a helm chart or a manifest joins a compose group" \
  apps/bothy-ops/updater/groups.py \
  'if c.cls in GROUP_CLASSES and c.source == "image":' \
  'if c.cls in GROUP_CLASSES or c.source != "image":' \
  -- python3 apps/bothy-ops/checks/test_groups.py

mutant "the group pulls before it has snapshotted every member" \
  apps/bothy-ops/updater/groups.py \
  '            self.step("snapshot", self.snapshot)
            self.step("pull", lambda: self.pull(pulled))' \
  '            self.step("pull", lambda: self.pull(pulled))
            self.step("snapshot", self.snapshot)' \
  -- python3 apps/bothy-ops/checks/test_groups.py

mutant "a group rollback keeps the members that worked" \
  apps/bothy-ops/updater/groups.py \
  '            for x in self.execs:
                for q in x.pins:' \
  '            for x in self.execs[:1]:
                for q in x.pins:' \
  -- python3 apps/bothy-ops/checks/test_groups.py

mutant "the night job may ask for a group" \
  apps/bothy-ops/updater/spool.py \
  'if doc.get("requestedBy") == updates.AUTO_ACTOR:' \
  'if False:' \
  -- python3 apps/bothy-ops/checks/test_groups.py

mutant "the two request shapes are told apart by a key, not by kind" \
  apps/bothy-ops/updater/spool.py \
  'return isinstance(doc, dict) and doc.get("kind") == GROUP_KIND' \
  'return False' \
  -- python3 apps/bothy-ops/checks/test_groups.py

mutant "a rolled-back group leaves its auto members free for tonight" \
  apps/bothy-ops/updater/auto.py \
  'for cid in ([e.get("component")] + [m for m in ms if isinstance(m, str)]):' \
  'for cid in [e.get("component")]:' \
  -- python3 apps/bothy-ops/checks/test_groups.py

mutant "the scope refusal goes back to naming a shell" \
  apps/bothy-ops/updater/executor.py \
  'instead=groups.instead(self.comp, self.cfg))' \
  'instead=None)' \
  -- python3 apps/bothy-ops/checks/test_groups.py

mutant "bothy-ops queues a group with a click when a member is one-way" \
  apps/bothy-ops/updates.py \
  '        if confirm != gid:' \
  '        if False:' \
  -- python3 apps/bothy-ops/checks/api_updates_apply.py

mutant "a group ask gets a router of its own" \
  edge/dynamic/bothy-updates.yml \
  '    bothy-updates-autorun:' \
  '    bothy-updates-apply-group:
      rule: "Path(`/-/api/updates/apply-group`) && Method(`POST`)"
      entryPoints: [web]
      priority: 110
      service: bothy-updates
      middlewares: [bothy-updates-strip, updates-deidentify, sso-operator, sso-errors]

    bothy-updates-autorun:' \
  -- python3 apps/bothy-ops/checks/wiring_updates.py

echo
echo "── the box saying when it runs config main no longer declares ───────"
# The failure this guards is TWO TRUE SENTENCES that together lie. Grafana ran the
# image `main` pins and a merged compose configuration `main` no longer declares,
# and the product said `drift: None` and `nothing to deploy: grafana runs what
# main pins` - the first because drift classified on image identity alone, the
# second because the image matched. Nothing anywhere said the box was running
# configuration that is not in the repository (2026-10-08).
#
# Every row here is a way that could become quiet again. Note the anchors: the
# config comparison and the drift loop test the same two things one method apart,
# so the condition is a NAMED local - `plant()` replaces the first match, and two
# identical lines in one file make a mutation a hostage to method order.

mutant "discovery stops asking whether the config changed" \
  apps/bothy-ops/discover_updates.py \
  'e["configDrift"] = self.config_drift(c, refs, e)' \
  'e["configDrift"] = None' \
  -- python3 apps/bothy-ops/checks/test_discover_updates.py

mutant "config drift becomes a louder copy of image drift" \
  apps/bothy-ops/discover_updates.py \
  'image_explains_it = bool(r.get("image")) and not same_image(r["image"], ref)' \
  'image_explains_it = False' \
  -- python3 apps/bothy-ops/checks/test_discover_updates.py

mutant "the merged config is rendered once per component, not per project" \
  apps/bothy-ops/discover_updates.py \
  'if name not in self._by_project:' \
  'if True:' \
  -- python3 apps/bothy-ops/checks/test_discover_updates.py

mutant "a project that could not be READ is reported as drift" \
  apps/bothy-ops/discover_updates.py \
  'note(f"the merged compose configuration could not be compared: {err}")' \
  'said.append(f"the merged compose configuration could not be compared: {err}")' \
  -- python3 apps/bothy-ops/checks/test_discover_updates.py

mutant "the config-drift metric is exported as always zero" \
  apps/bothy-ops/discover_updates.py \
  'lines += [f'"'"'bothy_update_config_drift{{component="{cid}"}} {1 if comps[cid].get("configDrift") else 0}'"'"'' \
  'lines += [f'"'"'bothy_update_config_drift{{component="{cid}"}} 0'"'"'' \
  -- python3 apps/bothy-ops/checks/test_discover_updates.py

mutant "bothy-ops drops config drift from what it serves" \
  apps/bothy-ops/updates.py \
  '        "configDrift": _s(d.get("configDrift"), 300),' \
  '        "configDrift": None,' \
  -- python3 apps/bothy-ops/checks/api_updates.py

mutant "the summary stops counting config drift" \
  apps/bothy-ops/updates.py \
  '        "configDrift": sum(1 for r in rows if r["discovered"] and r["discovered"]["configDrift"]),' \
  '        "configDrift": 0,' \
  -- python3 apps/bothy-ops/checks/api_updates.py

mutant "the refusal collapses back into 'nothing to deploy'" \
  apps/bothy-ops/updater/plans.py \
  '            if isinstance(e.get("configDrift"), str) and e["configDrift"]:' \
  '            if False:' \
  -- python3 apps/bothy-ops/checks/test_updater.py

mutant "the config-only refusal grows past the cap that cuts its end off" \
  apps/bothy-ops/updater/plans.py \
  'image pins only, so this one is by hand, after a backup")' \
  'image pins only, so this one is by hand, after a backup. The version it pins, the version it runs and the digest behind both are in the row above this one.")' \
  -- python3 apps/bothy-ops/checks/test_updates_catalog.py

mutant "a dirty pin file stops saying how far it reaches" \
  apps/bothy-ops/updater/plans.py \
  'reach = f", which refuses the plan for all {len(also)} components pinned in it" if len(also) > 1 else ""' \
  'reach = ""' \
  -- python3 apps/bothy-ops/checks/test_updater.py

mutant "a config-only leftover goes back to relaying 'nothing to deploy'" \
  apps/bothy-ops/updater/groups.py \
  "            said.append(f\"{s} ({c.id}: {shorts.get(c.id) or refusals.get(c.id) or 'no deployable plan'})\")" \
  "            said.append(f\"{s} ({c.id}: {refusals.get(c.id) or 'no deployable plan'})\")" \
  -- python3 apps/bothy-ops/checks/test_groups.py

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

# A3. A third hand-rolled `.seg-toggle` appearing somewhere. That is the whole
# regression: the class still exists and still looks fine, so nothing is visibly
# wrong - a screen reader just hears N unrelated toggles again and the arrow keys
# do nothing. The registry's two survivors each have a stated reason; a third has
# to earn one.
mutant "a third hand-rolled .seg-toggle appears" \
  apps/bothy-web/web/src/pages/Overview.tsx \
  '    <div className="ov-ui">' \
  '    <div className="ov-ui seg-toggle">' \
  -- "${WEB_CHECKS[@]}"

# A4. The declaration that made the Control landing ragged, planted back. Every
# card sizes to its own content again: Needs attention ends ~260px down and
# Quick links ~530px beside it, and the row stops reading as a row.
mutant "the Control landing's cards size to their own content again" \
  apps/bothy-web/web/src/pages/control/controlHome.css \
  '  align-items: stretch; grid-auto-rows: var(--tile);' \
  '  align-items: start;' \
  -- "${WEB_CHECKS[@]}"

# The trap the Overview's own comment records: a cap INSIDE a tile fights the
# tile. `.ch-scroll` carried exactly this one before the tile arrived, which is
# why Needs attention was the only card that did not run away.
mutant "a max-height comes back inside a tile" \
  apps/bothy-web/web/src/pages/control/controlHome.css \
  '.ch-scroll { margin: 0 calc(var(--sp-4) * -1); padding: 0 var(--sp-4); }' \
  '.ch-scroll { max-height: calc(var(--sp-16) * 5); margin: 0 calc(var(--sp-4) * -1); padding: 0 var(--sp-4); }' \
  -- "${WEB_CHECKS[@]}"

# A second copy of the tile constant. Nothing looks broken and nothing throws:
# the two dashboards simply stop lining up with each other, which is how the two
# content widths came to disagree.
mutant "the tile unit is declared a second time, per page" \
  apps/bothy-web/web/src/pages/Overview.css \
  '.overview .ov-body {' \
  '.overview { --tile: 20rem; }
.overview .ov-body {' \
  -- "${WEB_CHECKS[@]}"

# A5. The bug exactly as it shipped: a gutter with a width and no height. The
# glyph then overflows it by a pixel each side and this app's two menus align
# their rows differently - nothing errors, nothing is obviously wrong, and it
# survived every design batch so far.
mutant "the menu gutter loses its height again" \
  apps/bothy-web/web/src/components/ui/Menu.css \
  '  width: var(--icon-sm); height: var(--icon-sm); color: var(--fg-subtle); }' \
  '  width: var(--icon-sm); color: var(--fg-subtle); }' \
  -- "${WEB_CHECKS[@]}"

# The other half: a size typed at a menu call site instead of MENU_ICON. This is
# the literal that was there (UserMenu passed "md" into a 14px gutter), planted
# somewhere else so the binding is what is being tested rather than one file.
mutant "a menu item types its own glyph size" \
  apps/bothy-web/web/src/pages/control/ClusterTabs.tsx \
  'icon: <SizedIcon icon={Icon} size={MENU_ICON} />' \
  'icon: <SizedIcon icon={Icon} size="md" />' \
  -- "${WEB_CHECKS[@]}"

# And an `.ico` box rendered by hand, which is how a container and its glyph got
# to be set independently in the first place.
mutant "an .ico container is rendered by hand again" \
  apps/bothy-web/web/src/components/ServiceRow.tsx \
  '          <IconBox size="sm">{(g) => <ServiceIcon node={node} size={g} />}</IconBox>' \
  '          <span className="ico sm"><ServiceIcon node={node} size="md" /></span>' \
  -- "${WEB_CHECKS[@]}"

# A6. An icon-only toggle with no accessible name. On screen it is identical -
# a chevron - and to a screen reader it is "button", which is the whole reason
# the plan said the actions must become icon buttons WITH a real name.
mutant "the row's disclosure toggle loses its name" \
  apps/bothy-web/web/src/pages/settings/Updates.tsx \
  '            aria-label={open ? `Hide the detail for ${r.title}` : `Show the detail for ${r.title}`}
' \
  '' \
  -- "${WEB_CHECKS[@]}"

# ...and the pointer from the toggle to the region. ui/Disclosure keeps its
# region in the DOM while collapsed precisely so this resolves in the state a
# screen reader most needs it; without the attribute that costs nothing and buys
# nothing.
mutant "the toggle stops naming the region it opens" \
  apps/bothy-web/web/src/pages/settings/Updates.tsx \
  '            aria-controls={bodyId}
' \
  '' \
  -- "${WEB_CHECKS[@]}"

echo
echo "── one mark, two declared renderings ───────────────────────────────"
# The mark is drawn twice on purpose - a solid silhouette in public/favicon.svg
# for the 16px tab strip and the OS launcher, a 2px currentColor outline in
# Brand.tsx for a 72px watermark on seven themes - and until 2026-10-07 nothing
# compared them, three comments and the brand document all said there was one
# set of numbers, and a fourth copy of the coordinates sat in a generator that
# would have written the WRONG mark over three shipped icons.
#
# EVERY ANCHOR HERE IS MARKUP OR AN EXECUTABLE LINE, never a comment. The check
# strips comments from every input before it parses anything, deliberately, so a
# comment anchor would apply cleanly, change nothing, and report a decorative
# check as working. That exact mistake has been made in this repo twice; it is
# why the first row below mutates the `d` attribute rather than the paragraph
# above it that states the same number in prose.

# The door's arch radius, which is the single number the two renderings most
# visibly disagree on (3 against 1.85) and therefore the one most likely to be
# "reconciled" by somebody tidying up.
mutant "the mark's arch radius moves in the favicon" \
  apps/bothy-web/web/public/favicon.svg \
  '<path fill="#60a5fa" d="M9 20.2 V17.2 a3 3 0 0 1 6 0 V20.2 Z"/>' \
  '<path fill="#60a5fa" d="M9 20.2 V17.2 a2 2 0 0 1 6 0 V20.2 Z"/>' \
  -- "${WEB_CHECKS[@]}"

# The apex is the one coordinate the two renderings share exactly, and it is what
# makes them recognisably the same hut. Move it in the component and the
# silhouette is untouched, the app looks fine, and the two marks have parted.
mutant "the outline's apex leaves the silhouette's" \
  apps/bothy-web/web/src/components/Brand.tsx \
  '<path d="M2.4 11.6 L12 4.2 L21.6 11.6" />' \
  '<path d="M2.4 11.6 L12 5.2 L21.6 11.6" />' \
  -- "${WEB_CHECKS[@]}"

# A fourth copy of the coordinates, which is how this started: a generator that
# re-declares the geometry is a second source of truth wearing a build step's
# clothes. Planted in the repo-root generator - the one that is CORRECT today
# precisely because it reads the SVGs rather than carrying numbers.
mutant "a generator starts carrying its own coordinates" \
  scripts/gen-icons.py \
  'JOBS = [' \
  'ROOF = [(2.4, 11.6), (12.0, 4.2), (21.6, 11.6)]
BODY = [(5.6, 10.6), (5.6, 20.4), (18.4, 20.4), (18.4, 10.6)]
DOOR_X = (10.15, 13.85)

JOBS = [' \
  -- "${WEB_CHECKS[@]}"

# And the raster half: the SVG changes and the committed PNGs do not, which is
# the failure the brand document claimed to verify by re-running the generator
# and diffing bytes - a step that needs a browser, takes a minute, and had
# therefore never been run, which is how all four PNGs came to disagree with the
# generator that claimed them. Dropping the tile's rounding here leaves
# icon-192/512 with see-through corners the source no longer asks for. Nothing
# renders; the PNGs are decoded.
mutant "the rasters stop matching the SVG they came from" \
  apps/bothy-web/web/public/favicon.svg \
  '<rect width="24" height="24" rx="5.4" fill="#09090b"/>' \
  '<rect width="24" height="24" fill="#09090b"/>' \
  -- "${WEB_CHECKS[@]}"

echo
echo "── the dashboards keep to the data-visualisation standard ──────────"
# Four rules from docs/brand/patterns/dataviz.md, each one a defect this repo
# actually shipped and none of which produces an error, a warning or a visibly
# broken page. Every anchor below is a DATA line in a JSON or YAML file, which
# matters here: scripts/checks/dashboards.sh reads the files whole and strips
# nothing, but the habit this directory enforces is to anchor on something the
# check can actually see, and a comment would not be.
DASH_CHECK=(bash scripts/checks/dashboards.sh)

# What 110 panels of Node Exporter Full did: colour assigned by a series' INDEX,
# so filtering one mount out repaints every mount after it.
mutant "a panel colours series by rank again" \
  monitoring/dashboards/node-exporter-full.json \
  '"mode": "palette-classic-by-name"' \
  '"mode": "palette-classic"' \
  -- "${DASH_CHECK[@]}"

# What the Cadvisor import did to its CPU and both memory panels: a missing
# sample drawn as zero, which is a cliff that never happened, on exactly the
# panels somebody opens when a container is behaving oddly.
mutant "a missing sample is drawn as zero again" \
  monitoring/dashboards/cadvisor.json \
  '"nullPointMode": "null"' \
  '"nullPointMode": "null as zero"' \
  -- "${DASH_CHECK[@]}"

# What traefik.json did for a year: #4d9bff and #9fabbe, neither of them in
# docs/brand/reference/tokens.md. A near-token reads as deliberate and is
# invisible in one of the five themes.
mutant "an off-token hex lands in a dashboard" \
  monitoring/dashboards/traefik.json \
  '"fixedColor": "text"' \
  '"fixedColor": "#4d9bff"' \
  -- "${DASH_CHECK[@]}"

# The landing page, which is the one failure here with NO symptom: Grafana logs
# an unresolvable home-dashboard path and falls back to the stock Home page -
# which is precisely the state the setting was added to fix, so the fallback is
# indistinguishable from the bug.
mutant "the landing page points at nothing" \
  monitoring/compose.yml \
  'GF_USERS_DEFAULT_HOME_DASHBOARD_PATH: /var/lib/grafana/dashboards/box-health.json' \
  'GF_USERS_DEFAULT_HOME_DASHBOARD_PATH: /var/lib/grafana/dashboards/box-healht.json' \
  -- "${DASH_CHECK[@]}"

echo
echo "── D1/D2/D3: the sentence, the hint, and the slot that cannot move ──"
# Anchored on executable lines inside the FUNCTION each one is about, never on a
# comment: every check below strips comments before it reads anything, so a
# mutation planted in prose applies cleanly, changes nothing, and reports a
# healthy check as decorative. `plant()` also replaces only the FIRST occurrence
# of its anchor, so each anchor here is a line that appears once in the tree.

# D1. The defect exactly as the owner met it. The sentence and the per-component
# list were ONE string, every writer of a refusal caps a reason at 300 characters,
# and the cap landed mid-word: Settings > Updates said "...grafana: noth". Glue
# them back together and nothing errors - the page simply truncates a reason the
# host wrote perfectly well, which is the state that had the owner asking twice.
mutant "the group refusal glues its list back onto the sentence" \
  apps/bothy-ops/updater/groups.py \
  '                          f"something to apply; a group is for two or more (one is its own row)."[:300],
                          per=[{"component": cid, "reason": r} for cid, r in sorted(refusals.items())])' \
  '                          f"something to apply; a group is for two or more (one is its own row). "
                          + "; ".join(f"{cid}: {r}" for cid, r in sorted(refusals.items()))[:300])' \
  -- python3 apps/bothy-ops/checks/test_groups.py

# ...and the other end of the same wire. The host writes the list; bothy-ops has
# to let it through its allowlist, and dropping a field there is the quietest
# possible failure: the page renders, with nothing behind the hint.
mutant "bothy-ops drops the per-component half of a refusal" \
  apps/bothy-ops/updates.py \
  '                        "skipped": [{"component": s["component"], "reason": _s(s.get("reason"), 300) or ""}
                                    for s in (doc.get("skipped") or [])[:16]' \
  '                        "skipped": [{"component": s["component"], "reason": _s(s.get("reason"), 300) or ""}
                                    for s in []' \
  -- python3 apps/bothy-ops/checks/api_updates_apply.py

# ...and the group file itself. write_all is where the two halves are recorded,
# and a group that is NOT deployable is the state this box is in most of the time.
mutant "the group file records the sentence and forgets the list" \
  apps/bothy-ops/updater/groups.py \
  '                   "skipped": [{"component": s["component"], "reason": str(s["reason"])[:300]}
                               for s in getattr(e, "per", [])][:16],' \
  '                   "skipped": [],' \
  -- python3 apps/bothy-ops/checks/test_groups.py

# D2. Hover-only, which is the request misread. It looks identical on a desktop
# with a mouse and is unreachable by keyboard and on the owner's phone - the exact
# failure the brief called out as non-negotiable.
mutant "the hint stops opening on focus" \
  apps/bothy-web/web/src/components/ui/InfoHint.tsx \
  '          onFocus={show}' \
  '          onFocus={() => {}}' \
  -- "${WEB_CHECKS[@]}"

# A tap is eaten. pointerenter and click arrive in the same gesture on a touch
# screen, so honouring pointerenter for every pointer type opens the panel and
# then the click toggles it shut again: on a phone the hint does nothing at all,
# and on the desktop it is perfect. This is the defect that disqualified
# components/Tooltip.tsx for this job, planted back.
mutant "the hint honours hover for every pointer, so a tap closes it again" \
  apps/bothy-web/web/src/components/ui/InfoHint.tsx \
  '          onPointerEnter={(e) => { if (e.pointerType === '"'"'mouse'"'"') show(); }}' \
  '          onPointerEnter={() => show()}' \
  -- "${WEB_CHECKS[@]}"

# The accessible name. On screen it is identical - a 12px glyph - and to a screen
# reader it is "button", with no text beside it to recover from.
mutant 'a hint is named "more info" instead of what it reveals' \
  apps/bothy-web/web/src/pages/settings/Updates.tsx \
  'label="Why a recipe is applied as a whole"' \
  'label="more info"' \
  -- "${WEB_CHECKS[@]}"

# Two hints with one name. A page of eight identical "Details" is one name as far
# as somebody tabbing through it is concerned, and it reads fine on screen.
mutant "two hints on one page share a name" \
  apps/bothy-web/web/src/pages/settings/Updates.tsx \
  'label="What Apply does, step by step"' \
  'label="How Update and Apply differ"' \
  -- "${WEB_CHECKS[@]}"

# A control inside a hint. Focus never enters the panel - that is what lets it be
# a description rather than a destination - so a link in there is unreachable by
# keyboard while looking completely normal to a mouse.
mutant "a hint holds a link nothing can reach" \
  apps/bothy-web/web/src/pages/settings/Updates.tsx \
  '            <p>Discovery reads the pins and asks upstream. It pulls nothing and restarts nothing.</p>' \
  '            <p>Discovery reads the pins and asks upstream. <a href="/x">What it asks</a></p>' \
  -- "${WEB_CHECKS[@]}"

# THE D2 FAILURE MODE ITSELF: the hint is added and the paragraph is left where it
# was. Every individual diff looks like an improvement, the page gets busier one
# hint at a time, and the thing the owner actually asked for never happens.
mutant "a paragraph that moved behind a hint is left on the surface too" \
  apps/bothy-web/web/src/pages/settings/Updates.tsx \
  '      <p className="upd-legend">
        <b>Apply</b> makes this box run what <span className="mono">main</span> already pins.' \
  '      <p className="upd-legend">
        <b>Apply</b> makes this box run what <span className="mono">main</span> already pins. <b>Available</b>
        is what is newer <i>upstream</i>; to get that, merge its Dependabot PR first.' \
  -- "${WEB_CHECKS[@]}"

# ── what is happening, down the side of the page and in every corner ────────
#
# Rewritten 2026-10-08 with the thing it guards. The three rows these replace
# pinned `.upd-top`, a two-column grid whose LEFT cell was the Controls block -
# so they asserted "the right side" of a row and the owner had asked for the side
# of the PAGE. The no-shift half is restated unchanged, because it is the half
# that fails invisibly: nothing looks wrong until a job runs, which is the one
# moment nobody is taking screenshots.
#
# Every anchor below is an executable line unique to the function or rule it
# belongs to. `plant()` replaces the FIRST match, so a short recurring anchor is
# a hostage to file order - and a comment is not an anchor at all, because the
# checks strip comments before they look.

# THE JUMP, PUT STRAIGHT BACK. An absolutely positioned child contributes no
# height, which is the whole no-shift guarantee; in normal flow the card grows as
# its steps arrive and pushes every block below it down.
mutant "the activity card goes back into the page flow" \
  apps/bothy-web/web/src/components/UpdateActivity.css \
  '  position: absolute; inset: var(--sp-4) var(--sp-4) var(--sp-6);
  overflow-y: auto; overscroll-behavior: contain;' \
  '  overflow-y: auto; overscroll-behavior: contain;' \
  -- "${WEB_CHECKS[@]}"

# ...and the slot itself disappearing when nothing is running, which is the shape
# the jump had before: no rail, then a rail.
mutant "the activity slot is only drawn once a job exists" \
  apps/bothy-web/web/src/components/UpdateActivity.tsx \
  '          : <RestingJob last={d?.history?.[0] ?? null} />}' \
  '          : null}' \
  -- "${WEB_CHECKS[@]}"

# ...and the narrow case losing its reserved height, so the band grows from one
# line to a panel the moment a job starts - the same jump, on the device the owner
# actually reads this on.
mutant "below 1100px the reserved band sizes to its content" \
  apps/bothy-web/web/src/components/UpdateActivity.css \
  '    width: auto; height: var(--upd-rail-h);' \
  '    width: auto;' \
  -- "${WEB_CHECKS[@]}"

# THE RESERVE IS THE OTHER HALF, and it is on the PAGE rather than on the rail:
# without it the rail is a floating column over the content it was supposed to sit
# beside, and the blocks under it are unreadable exactly while a job runs.
mutant "the page stops reserving the rail's column" \
  apps/bothy-web/web/src/components/settings/settings.css \
  '  padding-right: calc(var(--upd-rail-w) + var(--sp-8));' \
  '  padding-right: var(--sp-8);' \
  -- "${WEB_CHECKS[@]}"

# ...and the rail positioned against the BODY instead of the scroller, which is
# the difference between "the side of the page" and "the side of the first
# screenful": it would scroll away as you read down.
mutant "the rail is positioned against the body, not the scroller" \
  apps/bothy-web/web/src/components/settings/settings.css \
  '.set-shell .set-main:has(.upd-rail) { position: relative; }' \
  '.set-shell .set-main:has(.upd-rail) { position: static; }' \
  -- "${WEB_CHECKS[@]}"

# THE DOCK'S MOUNT POINT IS THE WHOLE POINT. RouteFade keeps two <main>s alive for
# ~120ms per navigation, so a live surface inside a page is duplicated and then
# unmounted every time you move - which looks perfect on the page that started the
# job and nowhere else. The shell is the only mount that survives a route change.
mutant "the activity dock is not mounted in the shell" \
  apps/bothy-web/web/src/components/AppShell.tsx \
  '      <UpdateActivityDock />' \
  '' \
  -- "${WEB_CHECKS[@]}"

# ...and the loop armed from the shell, which is a request on every app load for
# a tab that may never open Settings. Every read of the job route writes an audit
# line on the host; that is why the sidebar's behind count is TTL'd to 15 minutes.
mutant "something other than the Updates page arms the poll" \
  apps/bothy-web/web/src/components/AppShell.tsx \
  '      <UpdateActivityDock />' \
  '      <UpdateActivityDock />{adoptJob(rememberedJob())}' \
  -- "${WEB_CHECKS[@]}"

# ...and the loop never stopping, which is an audit line every two seconds for as
# long as the tab is open, on a job that finished hours ago.
mutant "the job poll keeps running after the job is over" \
  apps/bothy-web/web/src/lib/updates.ts \
  '      again = !isTerminal(j.state);' \
  '      again = true;' \
  -- "${WEB_CHECKS[@]}"

# AN IDLE ORB IS A PERPETUAL LOOP FOR AN IDLE THING, which the brand forbids and
# the owner asked against in the same words ("nothing at all when idle").
mutant "the dock is drawn when nothing is running" \
  apps/bothy-web/web/src/components/UpdateActivity.tsx \
  '  if (!feed.id) return null;' \
  '  if (!feed.id && false) return null;' \
  -- "${WEB_CHECKS[@]}"

# ...and drawn on Settings > Updates as well, where the rail already is it: two
# surfaces for one job, and two live regions announcing it.
mutant "the dock is drawn on the page whose rail already is it" \
  apps/bothy-web/web/src/components/UpdateActivity.tsx \
  "  if (loc.pathname.startsWith('/settings/updates')) return null;" \
  '' \
  -- "${WEB_CHECKS[@]}"

# "HOVER ALONE IS NOT AN AFFORDANCE" - both halves of it. Without the focus
# handler a keyboard cannot open it at all; without the pointerType gate a touch
# tap is eaten by a hover that opens and shuts in the same gesture, which is the
# defect that disqualified components/Tooltip.tsx for the detail hint.
mutant "the dock no longer opens on focus" \
  apps/bothy-web/web/src/components/UpdateActivity.tsx \
  '        onFocus={() => setOpen(true)}' \
  '        onFocus={() => {}}' \
  -- "${WEB_CHECKS[@]}"

mutant "hover opens the dock for a finger too" \
  apps/bothy-web/web/src/components/UpdateActivity.tsx \
  "        onPointerEnter={(e) => { if (e.pointerType === 'mouse') setOpen(true); }}" \
  '        onPointerEnter={() => setOpen(true)}' \
  -- "${WEB_CHECKS[@]}"

# ...and Escape, which has to close it AND put focus back where it came from.
mutant "Escape stops closing the dock" \
  apps/bothy-web/web/src/components/UpdateActivity.tsx \
  "    if (e.key !== 'Escape' || !open) return;" \
  '    if (!open) return;' \
  -- "${WEB_CHECKS[@]}"

# IT EXPANDS BY TRANSFORM, NOT BY SIZE. motion.md forbids animating width or
# height, and index.css records the exact bug: the top nav's label used to tween
# `max-width`, which relaid out the whole bar every frame and pushed its
# neighbour ~60px sideways under the pointer.
mutant "the dock's panel tweens its width open" \
  apps/bothy-web/web/src/components/UpdateActivity.css \
  '  transition: opacity var(--dur-fast) var(--ease), scale var(--dur) var(--spring),' \
  '  transition: width var(--dur) var(--ease), opacity var(--dur-fast) var(--ease), scale var(--dur) var(--spring),' \
  -- "${WEB_CHECKS[@]}"

# AND THE ENTRANCE STARTS FROM A VISIBLE RESTING STATE. A panel whose default is
# `opacity: 0` is one that stays invisible forever the first time whatever was
# meant to turn it on does not run - the Reveal component's failure, which
# shipped a near-blank page twice (motion.md's dead ends).
mutant "the dock's panel rests at opacity 0" \
  apps/bothy-web/web/src/components/UpdateActivity.css \
  '  transform-origin: bottom right;' \
  '  opacity: 0; transform-origin: bottom right;' \
  -- "${WEB_CHECKS[@]}"

echo
echo "── 1C: the Settings nav folds, and the default is not a constant ───"
# Thirteen sections in six groups that could not fold. Every failure below is
# silent on screen: a nav that opens everything looks like the nav we had, a nav
# that opens nothing looks like a nav with no current page, and a key that
# collides with SettingBlock's folds blocks on four pages with no error anywhere.

# THE RULE ITSELF. groupOpen() is the one place the default lives; make it a
# constant and the owner's complaint is back, with the preference still working
# perfectly underneath.
mutant "every group is open again, whatever page you are on" \
  apps/bothy-web/web/src/lib/prefs.ts \
  '  return typeof said === '"'"'boolean'"'"' ? said : id === active;' \
  '  return typeof said === '"'"'boolean'"'"' ? said : true;' \
  -- "${WEB_CHECKS[@]}"

# The canonicalisation. Writing an opinion that EQUALS the default is how the
# store silently fills up with non-choices - and then, because the default moves
# with the page, those non-choices start meaning something on the next page.
mutant "a group records an opinion that is only the default" \
  apps/bothy-web/web/src/lib/prefs.ts \
  '  if (want === (id === active)) delete next[id];' \
  '  if (false) delete next[id];' \
  -- "${WEB_CHECKS[@]}"

# Arriving clears a FOLD, never an opening. Flip the comparison and a group you
# folded once swallows every later arrival into it: the page changes, the
# breadcrumb changes, and the nav shows no "you are here" at all.
mutant "arriving clears the wrong opinion, so a fold swallows the page" \
  apps/bothy-web/web/src/lib/prefs.ts \
  '  if (active === null || stored[active] !== false) return stored;' \
  '  if (active === null || stored[active] === false) return stored;' \
  -- "${WEB_CHECKS[@]}"

# The hand-editable value, fed straight into aria-expanded and `inert`. A
# non-boolean through the parse is a group that is neither open nor shut.
mutant "a hand-edited group value is trusted unchecked" \
  apps/bothy-web/web/src/lib/prefs.ts \
  "typeof e[1] === 'boolean'" \
  "typeof e[1] !== 'undefined'" \
  -- "${WEB_CHECKS[@]}"

# THE KEY COLLISION, which is the expensive one. bothy-settings-nav-v1 is taken
# and holds BLOCK state despite its name; a nav value lands there as a list of
# collapsed blocks called `you`, `look`, `data`, and folds things on four pages.
mutant "the nav state moves into SettingBlock's key" \
  apps/bothy-web/web/src/lib/prefs.ts \
  "export const SETTINGS_GROUPS_KEY = 'bothy-settings-groups-v1';" \
  "export const SETTINGS_GROUPS_KEY = 'bothy-settings-nav-v1';" \
  -- "${WEB_CHECKS[@]}"

# ...and the key left out of the list of what this browser holds, which is the
# only place it can be seen or cleared.
mutant "a new key stops being listed as something this browser holds" \
  apps/bothy-web/web/src/lib/prefs.ts \
  "  { key: SETTINGS_GROUPS_KEY, what: 'Groups of the Settings menu you folded open or shut', resettable: true }," \
  '' \
  -- "${WEB_CHECKS[@]}"

mutant "the key loses its row and its Reset in Remembered layout" \
  apps/bothy-web/web/src/pages/settings/Layout.tsx \
  '      key: SETTINGS_GROUPS_KEY,' \
  "      key: 'bothy-settings-groups-v1'," \
  -- "${WEB_CHECKS[@]}"

# TWO COPIES, ONE STATE. Nav is rendered in the aside and in the drawer. Give one
# of them its own state and the two diverge the moment somebody uses a phone -
# which is the one width nobody screenshots.
mutant "the drawer's nav gets a copy of the state instead of the state" \
  apps/bothy-web/web/src/components/settings/SettingsShell.tsx \
  '<Nav {...nav} onNavigate={() => setDrawer(false)} />' \
  '<Nav groups={{}} activeGroup={null} onToggle={() => {}} onNavigate={() => setDrawer(false)} />' \
  -- "${WEB_CHECKS[@]}"

# ...and the ids they build. Both navs are in the DOM while the drawer is open,
# so a shared literal prefix makes every aria-controls name whichever region the
# browser finds first - the OTHER nav's.
mutant "both navs build their region ids off one literal prefix" \
  apps/bothy-web/web/src/components/settings/SettingsShell.tsx \
  '  const uid = useId();' \
  "  const uid = 'set-nav';" \
  -- "${WEB_CHECKS[@]}"

# The arrival guard. Without the ref the effect runs on every change of `groups`,
# so folding the group you are standing in is undone in the same frame: the
# toggle flips and springs straight back, and it reads as a broken control.
mutant "the arrival effect runs on every render and undoes the fold" \
  apps/bothy-web/web/src/components/settings/SettingsShell.tsx \
  '    if (arrived.current === activeGroup) return;
    arrived.current = activeGroup;
' \
  '' \
  -- "${WEB_CHECKS[@]}"

# The toggle stops naming the region it opens. ui/Disclosure keeps that region in
# the DOM while shut precisely so this resolves in the state a screen reader most
# needs it; on screen the two are identical.
mutant "the group toggle stops naming the region it opens" \
  apps/bothy-web/web/src/components/settings/SettingsShell.tsx \
  '              aria-expanded={open} aria-controls={panelId}' \
  '              aria-expanded={open}' \
  -- "${WEB_CHECKS[@]}"

# The fold itself, animated in the wrong stylesheet. grid-template-rows is
# permitted in ui/Disclosure.css and nowhere else, because that is the one place
# the browser resolves it without a layout pass per frame per group below it.
mutant "the nav fold animates a layout property in settings.css" \
  apps/bothy-web/web/src/components/settings/settings.css \
  '.set-nav-list .set-nav-items {' \
  '.set-nav-list .set-nav-items { transition: grid-template-rows var(--dur) var(--ease);' \
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
