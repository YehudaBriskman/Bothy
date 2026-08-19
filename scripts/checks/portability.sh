#!/usr/bin/env bash
# Could anyone but its author run this?
#
# README.md line 151 already promises `cp .env.example .env && just up` works. It
# does not, and this is the check that measures the distance to making that
# sentence true. Two things stand in the way, and both are invisible to every
# other check because they are correct on THIS box:
#
#   · absolute paths under one person's home directory, and
#   · this node's tailnet address, written into files a stranger would clone.
#
# The second is also a small privacy matter: this repository is public.
#
# WHY A BASELINE AND NOT FAIL-ON-ANY-HIT. There are ~107 of them today. A check
# that reports 107 problems is a check nobody reads, and the repo already learned
# this once - checks/served-secrets.baseline exists for exactly this reason and
# its header makes the argument. So the accepted set is recorded, this fails only
# on something NEW, and every step of the portability work DELETES lines from the
# baseline. That makes progress measurable and regressions impossible, which is
# the opposite of what a 107-line wall of red achieves.
#
#   scripts/checks/portability.sh            check
#   scripts/checks/portability.sh --update   accept the current set
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
BASELINE=scripts/checks/portability.baseline

# A home directory belonging to a person. `/home/` alone would match prose about
# home directories in general, which is why the pattern requires a name AND a
# path after it.
HOME_RE='/home/[a-z][a-z0-9_-]*/'

# The CGNAT range tailscale allocates from, 100.64.0.0/10. Written out rather
# than as a CIDR because grep is matching text, not addresses.
TAILNET_RE='\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b'

# Paths that are not this repository's business.
#
#   .cleanup-trash  a quarantine of things already removed; it is a record of the
#                   past and rewriting it would defeat the point of keeping it.
#   .claude         agent worktrees live here and are copies of the repo, so
#                   every hit inside one is a duplicate of a hit outside it.
EXCLUDE=':(exclude).cleanup-trash/**'
EXCLUDE2=':(exclude).claude/**'
# And this file. It CONTAINS the patterns, so it matches itself - the comment
# above naming the CGNAT range is a hit by its own rule. Baselining that would
# be accepting a line of noise forever; excluding it says what is actually true,
# which is that a description of an address is not an address.
EXCLUDE3=':(exclude)scripts/checks/portability.*'

hits() {
  # FILE and COUNT, not file:line, and not the matching text.
  #
  # Line numbers were the obvious key and they were wrong: inserting a comment
  # above a hit shifts every line below it, so a change that touched nothing
  # reported six new problems. A check that cries wolf on an insertion gets
  # ignored, which is the failure this repo has now been bitten by twice.
  #
  # The TEXT is wrong for the opposite reason - it is the thing being removed,
  # so keying on it makes every reword look new.
  #
  # A per-file COUNT survives both: it does not move when lines do, it still
  # catches a genuinely new occurrence (the count goes up), and it shrinks
  # visibly as the work lands.
  {
    git grep -cE "$HOME_RE" -- . "$EXCLUDE" "$EXCLUDE2" "$EXCLUDE3" | sed 's/^\(.*\):\([0-9]*\)$/\1\thome-path\t\2/'
    git grep -cE "$TAILNET_RE" -- . "$EXCLUDE" "$EXCLUDE2" "$EXCLUDE3" | sed 's/^\(.*\):\([0-9]*\)$/\1\ttailnet-ip\t\2/'
  } | sort -u
}

now=$(hits)

if [ "${1:-}" = "--update" ]; then
  # COMMENTS ATTACHED TO AN ENTRY ARE CARRIED OVER, and that is not politeness.
  # This regenerated the file from scratch, and on its second real use it
  # silently ate a seven-line note explaining why repo-roots.mjs holds 18
  # home-path hits ON PURPOSE - every one a fictional machine, because that file
  # exists to test Bothy on a checkout that is NOT this one.
  #
  # That note is the only thing standing between a future reader and "fixing" a
  # portability problem that is really a test fixture. A tool that discards the
  # reasoning for the thing it records is worse than one that refuses to run: the
  # entry survives looking unjustified, and the argument for it is gone.
  #
  # A comment block belongs to the entry it PRECEDES - which is how they are
  # written - so it follows that entry: re-emitted if the entry survives, and
  # dropped with it if it does not.
  NOW="$now" python3 scripts/checks/portability-baseline.py "$BASELINE"
  echo "baseline written: $(printf '%s\n' "$now" | grep -c . ) accepted"
  exit 0
fi

if [ ! -f "$BASELINE" ]; then
  echo "FAIL  no baseline at $BASELINE - run with --update to record the current set"
  exit 1
fi

accepted=$(grep -v '^#' "$BASELINE" | grep -c . || true)
new=$(comm -23 <(printf '%s\n' "$now") <(grep -v '^#' "$BASELINE" | sort -u))

total=$(printf '%s\n' "$now" | awk -F'\t' '{n+=$3} END {print n+0}')
echo "  $total hardcoded reference(s) in $(printf '%s\n' "$now" | grep -c .) file/kind pair(s); $accepted accepted"

if [ -n "$new" ]; then
  echo
  echo "$new" | while IFS=$'\t' read -r f kind n; do
    [ -n "$f" ] && echo "FAIL  $kind  $f  ($n)"
  done
  echo
  echo "  Each of these is a path or an address that only exists on one machine."
  echo "  Parameterise it, or accept it with --update and say why."
  exit 1
fi

# Fixed something? Say so, and make the baseline shrink rather than rot.
gone=$(comm -13 <(printf '%s\n' "$now") <(grep -v '^#' "$BASELINE" | sort -u) | grep -c . || true)
if [ "$gone" -gt 0 ]; then
  echo "  $gone accepted hit(s) are GONE - run --update to shrink the baseline"
fi
echo "PASS  nothing newly tied to this machine"
