#!/usr/bin/env bash
# release-decision.sh - may this commit be released, from the evidence about it?
#
# Reads one line per REQUIRED workflow on stdin:
#
#     <workflow file> <status> <conclusion>
#
# where status/conclusion are what the GitHub API reports for the newest push
# run of that workflow on the candidate SHA, or `missing -` when there is none.
# Prints exactly one line and exits 0:
#
#     release                  every required workflow completed with success
#     wait: <why>              something has not finished (or not started) yet
#     block: <why>             something finished and was not a success
#
# Exit 2 on input it cannot judge - a release step must treat that as a block.
#
# ── why a separate file ─────────────────────────────────────────────────────
#
# release.yml used to tag whatever CI passed on. Install and Upgrade ran beside
# it on the same push and were never consulted, so a commit could be tagged
# while its install was failing. The rule that replaces that is small, but the
# failure mode of getting it wrong is a release nobody can see was unproven -
# so it lives where scripts/checks/release-decision.sh can table-test it and
# mutants.sh can prove that test bites.
#
# ── the rule, and why each half ──────────────────────────────────────────────
#
# FAIL CLOSED. Only `completed`+`success` counts. `skipped`, `cancelled`,
# `neutral`, `timed_out`, `stale`, `action_required`, `startup_failure` and any
# conclusion GitHub invents later are a block: a skipped or cancelled run is
# evidence of nothing, which is the whole reason this file exists.
#
# BLOCK BEATS WAIT. If one workflow failed while another is still running, the
# answer is already no; saying "wait" would hide the failure until the other
# finished, and then only if somebody read that run.
#
# MISSING IS WAIT, not block. Each required workflow's completion re-runs the
# release, so a workflow that has not been created yet will arrive and decide.
# One that never runs leaves the commit untagged - which is the safe failure,
# and is visible as a VERSION with no tag (scripts/checks/version.sh).
#
# Every required workflow must appear exactly once. A line for a workflow that
# is not required, or a required one with no line, is an input error - a caller
# that forgot to ask about Upgrade must not read as "everything I asked about
# passed".
set -uo pipefail

REQUIRED="ci.yml install.yml upgrade.yml"

seen=" "
blocks=""
waits=""

while read -r wf status conclusion extra; do
  [ -z "${wf:-}" ] && continue
  if [ -n "${extra:-}" ] || [ -z "${status:-}" ] || [ -z "${conclusion:-}" ]; then
    echo "release-decision: malformed line: $wf $status $conclusion $extra" >&2
    exit 2
  fi
  case " $REQUIRED " in
    *" $wf "*) ;;
    *) echo "release-decision: $wf is not a required workflow" >&2; exit 2 ;;
  esac
  case "$seen" in
    *" $wf "*) echo "release-decision: $wf appears twice" >&2; exit 2 ;;
  esac
  seen="$seen$wf "

  case "$status" in
    completed)
      if [ "$conclusion" != success ]; then
        blocks="$blocks $wf=$conclusion"
      fi
      ;;
    missing)
      waits="$waits $wf=not-started"
      ;;
    queued|in_progress|waiting|requested|pending)
      waits="$waits $wf=$status"
      ;;
    *)
      # A status this file has never seen. Not "probably fine".
      blocks="$blocks $wf=status:$status"
      ;;
  esac
done

for wf in $REQUIRED; do
  case "$seen" in
    *" $wf "*) ;;
    *) echo "release-decision: no evidence line for $wf" >&2; exit 2 ;;
  esac
done

if [ -n "$blocks" ]; then
  echo "block:$blocks"
elif [ -n "$waits" ]; then
  echo "wait:$waits"
else
  echo "release"
fi
