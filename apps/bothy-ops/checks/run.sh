#!/usr/bin/env bash
# Checks for bothy-ops - container actions and cluster actions.  `just ops-check`
#
# ALL BUT ONE RUN WITH THE STACK DOWN, and that one needs only a docker daemon -
# never `just up`, never a real service, never a cluster, never a credential.
# The parent integrates and deploys, and a check that cannot run before that is
# a check nobody runs first. No third-party dependency: the system python3 runs
# all of it (wiring.py needs PyYAML, which the system python3 has).
#
# Formerly two harnesses (apps/bothy-control/checks, apps/bothy-kube/checks),
# merged in 2026-09 with every assertion kept:
#
#   test_common.py       bothy_common: names (fullmatch), audit, CSRF, bodies.
#   test_guard_control   THE BOUNDARY, containers: the verb allowlist, the name
#                        rule with traversal shapes enumerated, SEVERING.
#   test_guard_kube      THE BOUNDARY, cluster: catalog format, catalog/handler
#                        parity, the namespace enum, params, type-name confirm.
#   grants.py            the socket-proxy grants are what socket-proxy.yml says,
#                        and no proxy anywhere in the repo holds POST=1 with
#                        CONTAINERS=1. Static: answered BEFORE a POST=1 proxy starts.
#   wiring.py            catalog == edge routers == UI copy == RBAC; compose,
#                        overlay, traefik networks and justfile say what they claim.
#   api_control.py       the container HTTP surface against a stand-in daemon that
#                        COUNTS what reaches it - "refused" is a positive assertion.
#   api_kube.py          the cluster HTTP surface against a stand-in apiserver over
#                        real TLS, including "no cluster" -> 503.
#   transition.py        the only one that needs docker: real proxies from the
#                        shipped grants, a real throwaway container, a real state
#                        change. Skipped with --offline.
#
# Each alone would pass while the design was broken: the guards pass with the
# proxies wide open, grants passes with the guard deleted, the API checks pass
# against a proxy that permits /containers/create. All of them have to run.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../bothy-common/checks/lib.sh
. "$HERE/../../bothy-common/checks/lib.sh"
bothy_init "$HERE/.."

OFFLINE=0
for arg in "$@"; do
  case "$arg" in
    --offline) OFFLINE=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

echo "python: $($PY -V)"

section "the shared library: names, audit, CSRF, bodies"
gate "$PY" "$BOTHY_COMMON/checks/test_common.py"

section "THE BOUNDARY: three verbs, and what a container name is"
gate "$PY" checks/test_guard_control.py

section "THE BOUNDARY: catalog, scope, names, params"
gate "$PY" checks/test_guard_kube.py

section "the socket-proxy grants are what socket-proxy.yml claims"
check "$PY" checks/grants.py

section "the copies of the catalog, the edge and the compose files agree"
check "$PY" checks/wiring.py

section "containers: the HTTP surface, and what never reaches the daemon"
check "$PY" checks/api_control.py

section "cluster: the HTTP surface, and what never reaches the apiserver"
# stderr is the audit echo of ~100 requests; the assertions are on stdout.
check "$PY" checks/api_kube.py 2>/dev/null

if [ "$OFFLINE" = 1 ]; then
  echo
  echo "(--offline: skipping the one check that needs a docker daemon)"
  finish
fi

section "a real container really transitions"
# Builds its own network, its own pair of socket proxies and its own disposable
# alpine container, and removes all of it in a finally block. It never acts on a
# container this box runs - the names carry a random suffix. Roughly 45s: a
# stop or restart on a PID 1 that ignores SIGTERM costs the full StopTimeout.
check "$PY" checks/transition.py

finish
