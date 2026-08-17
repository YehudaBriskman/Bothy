#!/usr/bin/env bash
# Checks for the control tier.
#
# THREE OF THE FOUR RUN WITH THE STACK DOWN, and the fourth needs only a docker
# daemon - never `just up`, never a real service, never a credential. The parent
# integrates and deploys, and a check that cannot run before that is a check
# nobody runs first.
#
# Nothing here has a third-party dependency, unlike the config tier's run.sh
# which has to go looking for an interpreter that owns ruamel. The system
# python3 runs all of this, because the service it checks has no dependency
# either.
#
# Four layers, deliberately, because each catches what the others cannot:
#
#   test_guard.py   THE BOUNDARY as a pure unit - the verb allowlist and the
#                   name rule, with the traversal shapes enumerated rather than
#                   sampled. No IO at all, so it runs anywhere in a second.
#   grants.py       Does the compose file actually SAY what it claims? Reads the
#                   shipped socket-proxy grants and asserts EXEC=0, POST=0 on
#                   the read half, CONTAINERS=0 on the write half, and that no
#                   family beyond containers is on anywhere. Static, and it must
#                   be, because you want this answered BEFORE a POST=1 socket
#                   proxy starts.
#   api.py          The whole HTTP surface against a stand-in daemon that COUNTS
#                   what reaches it - so "refused" is a positive assertion
#                   (nothing arrived) rather than an ambiguous 404.
#   transition.py   The only one that needs docker. Real proxies started from
#                   the shipped grants, a real throwaway container, a real state
#                   change, and from/to checked against `docker inspect`.
#
# Each alone would pass while the design was broken. test_guard would pass with
# the socket proxy wide open. grants would pass with the guard deleted. api
# would pass against a proxy that permits /containers/create. transition is the
# only one that proves the proxies behave, and the only one that cannot run on a
# box without a daemon. All four have to run.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.."

PY="${PYTHON:-python3}"
echo "python: $($PY -V)"

fail=0

echo
echo "── THE BOUNDARY: three verbs, and what a container name is ─────"
if ! "$PY" checks/test_guard.py; then
  echo
  echo "STOPPING. Everything below assumes the allowlist and the name rule hold,"
  echo "so running them now would report passes that mean nothing."
  exit 1
fi

echo
echo "── the socket-proxy grants are what compose.yml claims ─────────"
"$PY" checks/grants.py || fail=1

echo
echo "── the HTTP surface, and what never reaches the daemon ─────────"
"$PY" checks/api.py || fail=1

if [ "${1:-}" = "--offline" ]; then
  echo
  echo "(--offline: skipping the one check that needs a docker daemon)"
  exit $fail
fi

echo
echo "── a real container really transitions ─────────────────────────"
# Builds its own network, its own pair of socket proxies and its own disposable
# alpine container, and removes all of it in a finally block. It never acts on a
# container this box actually runs - the target name carries a random suffix
# generated at import time, so there is nothing for it to collide with.
#
# Slow on purpose: a stop or restart on a container whose PID 1 ignores SIGTERM
# costs the full 10s StopTimeout, and this does four of them. Roughly 45s.
"$PY" checks/transition.py || fail=1

echo
if [ "$fail" = 0 ]; then
  echo "all checks passed"
else
  echo "FAILURES above"
fi
exit $fail
