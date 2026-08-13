#!/usr/bin/env bash
# Checks for the editor tier.  `just files-check`
#
# Three layers, deliberately, because each catches what the others cannot:
#
#   test_safepath.py  the security boundary as a PURE unit - 30 cases including
#                     real planted symlinks. Runs anywhere, needs nothing up.
#   authz_probe.py    does oauth2-proxy actually enforce a per-route role? Asks
#                     for a role the user does NOT hold and requires a 403.
#   e2e.py            the whole path: anonymous refused, login, write, commit,
#                     and the guards re-checked THROUGH http rather than in-process.
#
# The unit tests alone would pass with the edge wide open; the probe alone would
# pass with the path guards removed. Both have to run.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.."

fail=0
echo "── path safety (unit) ──────────────────────────────────────"
python3 checks/test_safepath.py || fail=1

if [ "${1:-}" = "--offline" ]; then
  echo; echo "(--offline: skipping the probes that need the stack up)"
  exit $fail
fi

# The two below need a running edge AND credentials, so they are skipped rather
# than failed when those are absent - a missing .env is not a broken boundary.
set -a; . "$HERE/../../../.env" 2>/dev/null || true; set +a
if [ -z "${DEV_LOGIN_PASSWORD:-}" ]; then
  echo; echo "SKIP: no DEV_LOGIN_PASSWORD in .env - cannot run the authenticated probes"
  exit $fail
fi

echo; echo "── per-route role enforcement ──────────────────────────────"
python3 checks/authz_probe.py || fail=1

echo; echo "── end to end ──────────────────────────────────────────────"
python3 checks/e2e.py || fail=1

exit $fail
