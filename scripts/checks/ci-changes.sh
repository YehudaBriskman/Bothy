#!/usr/bin/env bash
# What a pull request may skip, as a truth table.
#
# scripts/ci-changes.sh decides which mutants.sh rows a PR runs and whether a PR
# is documentation only. Wrong in one direction it costs a PR some minutes;
# wrong in the other it SKIPS A ROW THAT WOULD HAVE FAILED, and the PR goes
# green on a decorative check. main runs everything and would catch it - one
# merge too late. So each row below is a rule the script states, with the one
# answer it must give.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.." || exit 1

# shellcheck source=../ci-changes.sh
. scripts/ci-changes.sh
pass=0
fail=0

say() {
  local label="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    printf 'PASS  %-62s %s\n' "$label" "$got"
    pass=$((pass + 1))
  else
    printf 'FAIL  %-62s want=%s got=%s\n' "$label" "$want" "$got"
    fail=$((fail + 1))
  fi
}

# docs <label> <want: docs|code> <paths, newline-separated>
docs() {
  local got=code
  printf '%s' "$3" | bash scripts/ci-changes.sh docs-only && got=docs
  say "$1" "$2" "$got"
}

# row <label> <want: run|skip> <changed paths> <mutated file> <check cmd...>
row() {
  local label="$1" want="$2" changed="$3" file="$4" got=skip
  shift 4
  row_relevant "$changed" "$file" "$@" && got=run
  say "$label" "$want" "$got"
}

echo "── documentation only: skips the updater's end-to-end suites ───────"
docs "a guide page" docs 'docs/guide/roles.md'
docs "the README and SECURITY.md" docs 'README.md
SECURITY.md'
docs "an image under docs/" docs 'docs/assets/overview.png'
docs "an issue template" docs '.github/ISSUE_TEMPLATE/bug.md'
docs "markdown INSIDE an app may be built or served" code 'apps/bothy-web/README.md'
docs "a doc and a compose file" code 'docs/guide/roles.md
monitoring/compose.yml'
docs "a workflow" code '.github/workflows/install.yml'
docs "VERSION is not a document" code 'VERSION'
docs "nothing at all is not docs-only (fail open)" code ''

echo
echo "── mutants.sh rows: run what the change can reach ──────────────────"
WEB=(bash apps/bothy-web/checks/run.sh --offline)
row "the mutated file changed" run 'README.md' \
  README.md -- bash scripts/checks/doc-facts.sh
row "the check script changed" run 'scripts/checks/doc-facts.sh' \
  README.md -- bash scripts/checks/doc-facts.sh
row "neither changed" skip 'monitoring/compose.yml' \
  README.md -- bash scripts/checks/doc-facts.sh
row "an app's harness: anything in that app" run 'apps/bothy-web/web/package-lock.json' \
  apps/bothy-web/web/src/lib/discover.ts -- "${WEB[@]}"
row "an app's harness: another app changed" skip 'apps/bothy-files/app.py' \
  apps/bothy-web/web/src/lib/discover.ts -- "${WEB[@]}"
row "a sibling whose name merely starts the same" skip 'apps/bothy-web-next/x.ts' \
  apps/bothy-web/web/src/lib/discover.ts -- "${WEB[@]}"
row "a python check under an app" run 'apps/bothy-ops/updater/plans.py' \
  apps/bothy-ops/updates.py -- python3 apps/bothy-ops/checks/test_groups.py
row "mutants.sh itself runs every row" run 'scripts/checks/mutants.sh' \
  README.md -- bash scripts/checks/doc-facts.sh
row "the shared check library runs every row" run 'apps/bothy-common/checks/lib.sh' \
  README.md -- bash scripts/checks/doc-facts.sh
row "ci.yml runs every row" run '.github/workflows/ci.yml' \
  README.md -- bash scripts/checks/doc-facts.sh
row "this rule runs every row" run 'scripts/ci-changes.sh' \
  README.md -- bash scripts/checks/doc-facts.sh
row "an empty list runs every row (fail open)" run '' \
  README.md -- bash scripts/checks/doc-facts.sh
row "the match is on the third path of five" run 'a
b
README.md
c
d' README.md -- bash scripts/checks/doc-facts.sh

echo
echo "── files: the PR's own diff, or 'run everything' ───────────────────"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(
  cd "$tmp" || exit 1
  g() { git -c user.name=t -c user.email=nobody -c commit.gpgsign=false "$@"; }
  g init -q -b main . && echo a > base.txt && g add . && g commit -qm base
  g checkout -q -b pr && echo b > pr.txt && g add . && g commit -qm pr
  g checkout -q main && echo c > later-on-main.txt && g add . && g commit -qm main
  g merge -q --no-ff -m merge pr
) >/dev/null 2>&1
got=$(cd "$tmp" && bash "$OLDPWD/scripts/ci-changes.sh" files 2>/dev/null; echo "rc=$?")
say "a merge commit: the PR's files, not main's" "pr.txt rc=0" "$(echo $got)"
got=$(cd "$tmp" && git checkout -q HEAD^1 2>/dev/null && bash "$OLDPWD/scripts/ci-changes.sh" files >/dev/null 2>&1; echo "rc=$?")
say "not a merge commit: exit 3, run everything" "rc=3" "$got"

echo
echo "$pass pass · $fail fail"
[ "$fail" -eq 0 ]
