#!/usr/bin/env bash
# ci-changes.sh - what a pull request changed, and what that lets CI skip.
#
#     ci-changes.sh files                  the PR's changed paths, one per line
#     ci-changes.sh docs-only < paths      exit 0 when every path is documentation
#
# and, sourced by scripts/checks/mutants.sh, row_relevant: whether one mutation
# row (plant in FILE, CMD must catch it) has to run for a list of changed paths.
#
# `files` exits 3 when it cannot say - not a pull-request merge checkout, or a
# git error. Every caller reads 3 as "run everything".
#
# ── why ─────────────────────────────────────────────────────────────────────
#
# Measured on 2026-11-04 over the last 20 runs: a PR waited ~26 minutes, and 20
# of them were the updater's end-to-end suites running one after another inside
# the install job; the mutation table cost four runners ~7 minutes each on every
# PR, whatever it touched. A row whose mutated file and whose check are both
# untouched by a PR re-proves, on that PR, the same thing main proved last time.
#
# ── the rules, and the direction they lean ──────────────────────────────────
#
# PULL REQUESTS ONLY. A push to main always runs everything: release.yml tags a
# commit on the evidence of its push runs, and a run that skipped something is
# not evidence about it. So a rule here that is too eager costs a PR some
# feedback, and main still catches it before anything is tagged.
#
# FAIL OPEN. No merge commit, a git error, an empty diff: everything runs.
#
# DOCS ARE NOT FREE. docs/ is a test input to the tree job (links, counts,
# diagram hashes) and the install suites assert served headings, so "docs-only"
# skips only the updater's end-to-end suites, which read no document. Markdown
# under apps/ is never docs-only: an app may build or serve it.
#
# A ROW RUNS when its mutated file changed, when a path its check names changed,
# or - for a check under apps/<app>/ - when anything in that app changed, since
# those harnesses import the app's own modules. The harness files themselves
# (mutants.sh, this file, the shared check libraries, ci.yml) run every row.
set -uo pipefail

# is_docs <path> - read by nothing that builds, starts or is end-to-end tested.
is_docs() {
  case "$1" in
    apps/*) return 1 ;;
    docs/*|*.md|LICENSE|.github/ISSUE_TEMPLATE/*|.github/CODEOWNERS) return 0 ;;
  esac
  return 1
}

# runs_every_row <path> - a change here can alter how any row behaves.
runs_every_row() {
  case "$1" in
    scripts/checks/mutants.sh|scripts/ci-changes.sh|.github/workflows/ci.yml) return 0 ;;
    scripts/lib/*|apps/bothy-common/*) return 0 ;;
  esac
  return 1
}

# changed_files - the PR's own diff: the merge commit against its first parent,
# which is the base branch as GitHub merged it. That is what will land.
changed_files() {
  git rev-parse -q --verify 'HEAD^2' >/dev/null 2>&1 || return 3
  local out
  out=$(git diff --name-only --no-renames 'HEAD^1' HEAD 2>/dev/null) || return 3
  [ -n "$out" ] || return 3
  printf '%s\n' "$out"
}

# docs_only - stdin is a path list. An empty list is NOT docs-only.
docs_only() {
  local p n=0
  # `|| [ -n "$p" ]`: a list whose last line has no newline still ends in a
  # path, and plain `read` drops it - a docs-only verdict on a list whose
  # last, unread entry was compose.yml.
  while IFS= read -r p || [ -n "$p" ]; do
    [ -n "$p" ] || continue
    n=$((n + 1))
    is_docs "$p" || return 1
  done
  [ "$n" -gt 0 ]
}

# row_relevant <changed list, newline-separated> <mutated file> <check cmd...>
row_relevant() {
  local changed="$1" file="$2" p arg app
  shift 2
  [ -n "$changed" ] || return 0
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    runs_every_row "$p" && return 0
    [ "$p" = "$file" ] && return 0
    for arg in "$@"; do
      [ "$p" = "$arg" ] && return 0
      case "$arg" in
        apps/*/*)
          app="${arg#apps/}"; app="apps/${app%%/*}/"
          case "$p" in "$app"*) return 0 ;; esac ;;
      esac
    done
  done <<EOF
$changed
EOF
  return 1
}

# Run from the repository being asked about: `files` reads git from the current
# directory.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    files) changed_files; exit $? ;;
    docs-only) docs_only; exit $? ;;
    *) echo "usage: $0 files | docs-only" >&2; exit 2 ;;
  esac
fi
