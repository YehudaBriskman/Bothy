#!/usr/bin/env bash
# Checks for the cluster tier. NONE of them needs a cluster, docker or a token.
#
#   test_guard.py   THE BOUNDARY as a pure unit: catalog format, catalog/handler
#                   parity, the namespace enum, the name rule, params and bounds,
#                   type-name confirmation.
#   wiring.py       The four copies of the catalog agree (toml, edge routers, the
#                   UI's copy, the RBAC Role), and compose/edge say what they claim.
#   api.py          The whole HTTP surface against a stand-in apiserver over real
#                   TLS that COUNTS what reaches it, so a refusal is a positive
#                   assertion. Includes a 5-second SSE follow deadline.
#
# The live proof - a real apiserver, the real ServiceAccount, a real rollout - is
# not scripted here, because it restarts real pods. It is in the commit that
# introduced this tier, and SECURITY.md says how to repeat it.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.." || exit 1

PY="${PYTHON:-python3}"
echo "python: $($PY -V)"
fail=0

echo
echo "── THE BOUNDARY: catalog, scope, names, params ─────────────────"
if ! "$PY" checks/test_guard.py; then
  echo
  echo "STOPPING. Everything below assumes the boundary holds."
  exit 1
fi

echo
echo "── the four copies of the catalog agree ────────────────────────"
"$PY" checks/wiring.py || fail=1

echo
echo "── the HTTP surface, and what never reaches the cluster ────────"
"$PY" checks/api.py 2>/dev/null || fail=1

echo
if [ "$fail" = 0 ]; then
  echo "all checks passed"
else
  echo "FAILURES above"
fi
exit $fail
