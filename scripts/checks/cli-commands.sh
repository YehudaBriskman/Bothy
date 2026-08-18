#!/usr/bin/env bash
# Every `bothy` subcommand must resolve to something that exists.
#
# THE FAILURE THIS PREVENTS. scripts/bothy is a dispatcher: most subcommands are
# one line naming a `just` recipe. Rename or delete a recipe and nothing
# complains - the justfile is fine, the CLI is fine, and `bothy verify` says
# "Justfile does not contain recipe" to whoever runs it next. The break happens
# in one file and surfaces in another, which is exactly the kind nobody catches
# in review.
#
# So: read the dispatch table out of the CLI, read the recipe list out of `just`,
# and require every target to exist. It runs with the stack down and takes a
# second.
#
# IT ALSO CHECKS THE OTHER DIRECTION - every documented subcommand is really
# dispatchable. A command in `usage` that resolve() does not know is a lie in the
# help text, and help text is the only documentation a CLI has.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

CLI=scripts/bothy
fails=0

[ -f "$CLI" ] || { echo "FAIL  $CLI is missing"; exit 1; }
command -v just >/dev/null 2>&1 || { echo "SKIP  just is not installed - cannot resolve recipes"; exit 0; }

# The recipe names `just` actually knows, one per line.
recipes=$(just --list 2>/dev/null | tail -n +2 | sed -E 's/^[[:space:]]*([a-z0-9-]+).*/\1/')

# ── every dispatch target exists ────────────────────────────────────────────
#
# resolve() prints `just:<recipe>`. Pulling the targets out of the source rather
# than calling resolve() for a guessed list of names is deliberate: this way a
# subcommand ADDED to the table is checked without anyone remembering to add it
# here too.
targets=$(sed -n "s/.*printf 'just:\([a-z0-9-]*\)\\\\n'.*/\1/p" "$CLI" | sort -u)
# The `printf 'just:%s\n' "$1"` line resolves to whatever matched its case arm,
# so those names come from the arm itself rather than the printf.
arm=$(sed -n "s/^[[:space:]]*\(up|down[^)]*\))[[:space:]]*printf 'just:%s.*/\1/p" "$CLI" | tr '|' '\n')
targets=$(printf '%s\n%s\n' "$targets" "$arm" | sed '/^$/d' | sort -u)

[ -n "$targets" ] || { echo "FAIL  found no dispatch targets in $CLI - has resolve() changed shape?"; exit 1; }

for t in $targets; do
  if printf '%s\n' "$recipes" | grep -qx "$t"; then
    printf 'PASS  %-16s -> just %s\n' "$t" "$t"
  else
    printf 'FAIL  %-16s -> just %s   NO SUCH RECIPE\n' "$t" "$t"
    fails=$((fails + 1))
  fi
done

# ── everything the help text promises is dispatchable ───────────────────────
echo
documented=$(sed -n '/^  bothy up | down/,/^  bothy files-check/p' "$CLI" \
  | tr '|' '\n' | sed -E 's/^[[:space:]]*(bothy)?[[:space:]]*//; s/[[:space:]]*<.*//; s/[[:space:]]*$//' \
  | sed '/^$/d')
for d in $documented; do
  if printf '%s\n' "$targets" | grep -qx "$d"; then
    printf 'PASS  %-16s is documented and dispatchable\n' "$d"
  else
    printf 'FAIL  %-16s appears in the help text but resolve() does not know it\n' "$d"
    fails=$((fails + 1))
  fi
done

echo
if [ "$fails" -eq 0 ]; then
  echo "ok - the CLI and the justfile agree"
else
  echo "$fails mismatch(es). scripts/bothy names a recipe that does not exist, or"
  echo "promises a command it cannot run."
fi
exit $((fails > 0 ? 1 : 0))
