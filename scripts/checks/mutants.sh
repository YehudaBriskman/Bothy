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
