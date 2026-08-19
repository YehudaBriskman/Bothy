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

PORTAL_CHECKS=(bash apps/portal-next/checks/run.sh --offline)

echo "── the derivation that replaced a hardcoded home directory ─────────"
# The prefix trap: without the trailing slash a sibling checkout whose path
# merely STARTS with this one is filed as part of it.
mutant "asDir loses its trailing slash" \
  apps/portal-next/web/src/lib/discover.ts \
  'const asDir = (p: string): string => (p.endsWith('"'"'/'"'"') ? p : `${p}/`);' \
  'const asDir = (p: string): string => p;' \
  -- "${PORTAL_CHECKS[@]}"

echo
echo "── identity is not display grouping ────────────────────────────────"
# A system's derived `system` and its displayed `group` are two fields precisely
# so that `dev.portal.group` cannot move a bookmarked URL or an accent colour.
# Collapse them back into one and every symptom is silent: the Overview looks
# right, and only the person who opens an old /control/systems/ link finds out.
mutant "a display label moves the identity too" \
  apps/portal-next/web/src/lib/discover.ts \
  '  const decide = (system: string, kind: string): Classification => ({
    system,' \
  '  const decide = (system: string, kind: string): Classification => ({
    system: labels['"'"'dev.portal.group'"'"'] ?? system,' \
  -- "${PORTAL_CHECKS[@]}"

# The other half: makeNode() honoured dev.portal.group and allPorts() ignored it,
# so a system assembled with that label listed its services and none of its
# ports. Both read one classify() now; make the ports table read past it again.
mutant "the ports table stops honouring the label" \
  apps/portal-next/web/src/lib/discover.ts \
  '        system: cls.system,
        group: cls.group,' \
  '        system: cls.system,
        group: cls.system,' \
  -- "${PORTAL_CHECKS[@]}"

echo
echo "── the palette contract ────────────────────────────────────────────"
# Every colour must come from a token. A literal in a component is invisible in
# one theme and wrong in the other four.
mutant "a raw hex lands in a component" \
  apps/portal-next/web/src/components/SystemName.tsx \
  'export function SystemName({' \
  'const MUTANT_TINT = '"'"'#ff00ff'"'"';

export function SystemName({' \
  -- "${PORTAL_CHECKS[@]}"

# A theme that omits a required token does not fall back to something sensible -
# the rule renders with an empty value and the syntax highlighting disappears.
mutant "a theme drops a required syntax token" \
  apps/portal-next/web/src/themes/tokyo-night.css \
  '  --hl-kw:' \
  '  --mutant-removed-hl-kw:' \
  -- "${PORTAL_CHECKS[@]}"

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
  apps/portal-next/web/src/lib/config.ts \
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
echo "── the path boundary ───────────────────────────────────────────────"
# THE containment check. Resolve first, compare after. Deleting it is the whole
# directory-traversal class in one line, and 30 unit cases exist to catch it.
mutant "resolve() stops containing paths" \
  apps/portal-files/safepath.py \
  'if candidate != real_root and not candidate.startswith(real_root + os.sep):' \
  'if False:' \
  -- bash apps/portal-files/checks/run.sh --offline

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
