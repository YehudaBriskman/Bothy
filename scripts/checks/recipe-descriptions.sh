#!/usr/bin/env bash
# Every `just` recipe must describe itself in one readable line.
#
# WHY THIS EXISTS. `just` takes the LAST comment line before a recipe as its
# description. This repo's comment blocks run to paragraphs and end mid-thought,
# so `just --list` - the first thing anyone runs, and the only discovery surface
# there is - printed sentence fragments for 10 of 22 recipes:
#
#   up      # other, because fixing the first revealed the second.
#   urls    # table. A new service publishes a port; it does not declare a name.
#   nuke    # lines below are now no-ops on this box.)
#
# The last one is why this is a check and not a tidy-up. `nuke` deletes every
# data volume, and its listing described it as a no-op.
#
# THE RULE IS "STARTS WITH A CAPITAL", and that is chosen rather than obvious.
# Terminal punctuation is not a signal - "Show running containers" is a perfect
# description and ends with none. A fragment is a CONTINUATION, and continuations
# start lowercase. The one exception that ever slipped through started with a
# backtick (`bootstrap`'s old line began "`up` depends on it, because…"), so a
# leading backtick is not accepted either: write the sentence, then quote things
# inside it.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

MIN=12   # shorter than this is a stub, not a description
fails=0

# `just --list` renders "    name args   # description". Recipes with no comment
# have no `#` at all, which is its own failure.
while IFS= read -r line; do
  case "$line" in Available*|'') continue ;; esac
  name=$(printf '%s' "$line" | sed -E 's/^[[:space:]]*([a-z0-9-]+).*/\1/')
  case "$line" in
    *'#'*) desc=$(printf '%s' "$line" | sed -E 's/^[^#]*#[[:space:]]*//') ;;
    *)     printf 'FAIL  %-20s has no description at all\n' "$name"; fails=$((fails+1)); continue ;;
  esac

  if [ "${#desc}" -lt "$MIN" ]; then
    printf 'FAIL  %-20s description is %s chars, too short to say anything: %s\n' \
      "$name" "${#desc}" "$desc"; fails=$((fails+1)); continue
  fi
  case "$desc" in
    [A-Z]*) ;;
    *) printf 'FAIL  %-20s reads as a sentence fragment (must start with a capital):\n      %s\n' \
         "$name" "$desc"; fails=$((fails+1)) ;;
  esac
done < <(just --list 2>/dev/null)

if [ "$fails" -eq 0 ]; then
  echo "ok - every recipe describes itself"
else
  echo
  echo "$fails recipe(s) above. \`just\` uses the LAST comment line before a recipe,"
  echo "so add a one-line summary there and keep the reasoning above it."
fi
exit $((fails > 0 ? 1 : 0))
