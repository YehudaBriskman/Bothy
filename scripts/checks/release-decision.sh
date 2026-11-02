#!/usr/bin/env bash
# The release rule, as a truth table.
#
# scripts/release-decision.sh decides whether release.yml may tag a commit. A
# wrong answer there is silent in the worst direction: a release that looks
# exactly like a proven one. So every row below is a situation that has either
# happened on this repo or is one keystroke away from it, with the one answer
# it must get.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.." || exit 1

decide=scripts/release-decision.sh
pass=0
fail=0

# row <label> <want> <stdin>   want: release | wait | block | error
row() {
  local label="$1" want="$2" input="$3" out rc got
  out=$(printf '%s\n' "$input" | bash "$decide" 2>/dev/null); rc=$?
  if [ "$rc" -eq 2 ]; then got=error
  elif [ "$rc" -ne 0 ]; then got="exit$rc"
  else got="${out%%:*}"
  fi
  if [ "$got" = "$want" ]; then
    printf 'PASS  %-58s %s\n' "$label" "$got"
    pass=$((pass + 1))
  else
    printf 'FAIL  %-58s want=%s got=%s (%s)\n' "$label" "$want" "$got" "$out"
    fail=$((fail + 1))
  fi
}

ALL_GREEN='ci.yml completed success
install.yml completed success
upgrade.yml completed success'

row "all three green" release "$ALL_GREEN"
row "order does not matter" release 'upgrade.yml completed success
ci.yml completed success
install.yml completed success'

# The defect this whole change is about: CI green, install red.
row "CI green, install failed" block 'ci.yml completed success
install.yml completed failure
upgrade.yml completed success'

# Finding 1 of docs/ci-optimization-plan.md: main runs were being cancelled.
row "install cancelled" block 'ci.yml completed success
install.yml completed cancelled
upgrade.yml completed success'
row "upgrade skipped" block 'ci.yml completed success
install.yml completed success
upgrade.yml completed skipped'
row "timed out" block 'ci.yml completed timed_out
install.yml completed success
upgrade.yml completed success'
row "neutral is not success" block 'ci.yml completed neutral
install.yml completed success
upgrade.yml completed success'
row "a conclusion GitHub invents later" block 'ci.yml completed something_new
install.yml completed success
upgrade.yml completed success'
row "a status GitHub invents later" block 'ci.yml completed success
install.yml something_new -
upgrade.yml completed success'

row "install still running" wait 'ci.yml completed success
install.yml in_progress -
upgrade.yml completed success'
row "upgrade queued" wait 'ci.yml completed success
install.yml completed success
upgrade.yml queued -'
row "upgrade not created yet" wait 'ci.yml completed success
install.yml completed success
upgrade.yml missing -'

# Block beats wait: a failure must not hide behind a slower workflow.
row "one failed, another still running" block 'ci.yml completed success
install.yml completed failure
upgrade.yml in_progress -'

# A caller that forgot a workflow must not read as "all I asked passed".
row "upgrade not asked about" error 'ci.yml completed success
install.yml completed success'
row "nothing at all" error ''
row "a workflow twice" error "$ALL_GREEN
ci.yml completed success"
row "a workflow that is not required" error "$ALL_GREEN
elsewhere.yml completed success"
row "a malformed line" error 'ci.yml completed
install.yml completed success
upgrade.yml completed success'

echo
echo "$pass pass · $fail fail"
[ "$fail" -eq 0 ]
