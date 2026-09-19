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
#   grants.py            the socket-proxy grants are what compose.socket-proxy.yml says,
#                        and no proxy anywhere in the repo holds POST=1 with
#                        CONTAINERS=1. Static: answered BEFORE a POST=1 proxy starts.
#   wiring.py            catalog == edge routers == UI copy == RBAC; compose,
#                        overlay, traefik networks and justfile say what they claim.
#   api_control.py       the container HTTP surface against a stand-in daemon that
#                        COUNTS what reaches it - "refused" is a positive assertion.
#   api_kube.py          the cluster HTTP surface against a stand-in apiserver over
#                        real TLS, including "no cluster" -> 503.
#   test_inventory.py    the host-side credential inventory: a .env of sentinel
#                        values, and no sentinel byte in anything written or served.
#   wiring_admin.py      the Settings admin reads: four exact GET routers behind
#                        operator, read-only mounts, no secret mounted.
#   api_admin.py         the admin HTTP surface against a stand-in Keycloak that
#                        counts requests; audit parsing, paging, refusals.
#   test_updates_catalog THE UPDATE CATALOG: unknown keys and channels refused,
#                        `auto` refused on one-way and boundary components; the
#                        version shapes and levels; every real pin resolves.
#   test_discover_updates the host discovery against a fake registry: levels,
#                        drift, floats, a 429 fuse, the cache, the file modes.
#   wiring_updates.py    Settings > Updates: one exact GET router behind viewer,
#                        a read-only state mount, the textfile collector.
#   api_updates.py       GET /updates/status through the real handler: merged,
#                        allow-listed, refused, stale, audited.
#   test_updater.py      THE HOST UPDATER's decisions (step 4): plans are "what
#                        runs -> what main pins" and every refusal; the spool
#                        (tampered plan ids, symlinks, junk); the strict pin
#                        edit; the global lock; the result metric.
#   api_updates_apply.py plan / request / job through the real handler: one
#                        spool file per 202 and nothing else; every refusal.
#   test_auto.py         THE AUTOMATIC CHANNEL (step 7), with a fake clock and a
#                        fake backup: the window, tonight's backup, doctor, one a
#                        night, stop at the first failure, pause after a
#                        rollback, unpause through the spool.
#   e2e_updater.py       needs docker: the executor END TO END on a throwaway
#                        compose project and registry - success, a rollback on a
#                        body canary, a pre-flight refusal, two at once, and the
#                        time-series snapshot/restore. Skipped with --offline.
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

section "the socket-proxy grants are what compose.socket-proxy.yml claims"
check "$PY" checks/grants.py

section "the copies of the catalog, the edge and the compose files agree"
check "$PY" checks/wiring.py

section "containers: the HTTP surface, and what never reaches the daemon"
check "$PY" checks/api_control.py

section "cluster: the HTTP surface, and what never reaches the apiserver"
# stderr is the audit echo of ~100 requests; the assertions are on stdout.
check "$PY" checks/api_kube.py 2>/dev/null

section "admin: the credential inventory never carries a value"
gate "$PY" checks/test_inventory.py

section "admin: the Settings reads are wired as claimed"
check "$PY" checks/wiring_admin.py

section "admin: the HTTP surface, and what never reaches Keycloak"
check "$PY" checks/api_admin.py 2>/dev/null

section "updates: the catalog, and the version arithmetic behind every badge"
gate "$PY" checks/test_updates_catalog.py

section "updates: host discovery against a fake registry"
check "$PY" checks/test_discover_updates.py

section "updates: Settings > Updates is wired as claimed"
check "$PY" checks/wiring_updates.py

section "updates: the HTTP surface, merged and allow-listed"
check "$PY" checks/api_updates.py 2>/dev/null

section "updater: plans, the spool, the pin edit and the lock (host side)"
check "$PY" checks/test_updater.py

section "updates: plan, request and job - one spool file, and nothing else"
check "$PY" checks/api_updates_apply.py 2>/dev/null

section "auto: the night window, the backup gate, one a night, pause and unpause"
check "$PY" checks/test_auto.py

if [ "$OFFLINE" = 1 ]; then
  echo
  echo "(--offline: skipping the two checks that need a docker daemon)"
  finish
fi

section "a real container really transitions"
# Builds its own network, its own pair of socket proxies and its own disposable
# alpine container, and removes all of it in a finally block. It never acts on a
# container this box runs - the names carry a random suffix. Roughly 45s: a
# stop or restart on a PID 1 that ignores SIGTERM costs the full StopTimeout.
check "$PY" checks/transition.py

section "the host updater, end to end, on a throwaway project"
# Its own registry, images, compose projects (-p bothy-updater-test*), git repo
# and state dirs, all removed in a finally block. Never the live stack.
check "$PY" checks/e2e_updater.py

finish
