#!/usr/bin/env bash
# Checks for the editor tier.  `just files-check`
#
# Three layers, deliberately, because each catches what the others cannot:
#
#   test_safepath.py  the security boundary as a PURE unit - 30 cases including
#                     real planted symlinks. Runs anywhere, needs nothing up.
#   authz_probe.py    does oauth2-proxy actually enforce a per-route role? Asks
#                     for a role the user does NOT hold and requires a 403 - then
#                     reads Traefik's runtime router table to check which gate
#                     each route is actually wired to.
#   e2e.py            the whole path: anonymous refused, login, write, and the
#                     guards re-checked THROUGH http rather than in-process.
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

echo; echo "── save semantics: disk, not commit, and the conflict ──────"
python3 checks/save_semantics.py || fail=1

echo; echo "── git is VIEW-ONLY: the mutating verbs must be gone ────────"
python3 checks/git_ops.py || fail=1

echo; echo "── the undo net: an overwrite keeps what it destroyed ───────"
python3 checks/snapshots.py || fail=1

echo; echo "── delete: and the net is a PRECONDITION for it ─────────────"
# Runs after snapshots.py on purpose. Delete is only defensible because the undo
# net works, so the check that the net works should have gone green first - a
# delete suite passing while the trash is broken would be reporting the wrong
# thing as healthy.
python3 checks/delete_semantics.py || fail=1

echo; echo "── search must not see what the explorer refuses to open ────"
# The endpoint reads FILE CONTENT, so a deny-list miss here shows a secret's
# LINE rather than merely its filename. Plants a token in three kinds of denied
# file and requires that only the served one comes back.
python3 checks/search_denied.py || fail=1

echo; echo "── backlinks: the graph, and what must not be in it ─────────"
# Runs after search_denied.py for the same reason it exists: /links walks with
# safepath.collect() too, and an index is a place a denied file would sit
# permanently rather than only appearing in one answer. Plants its corpus in
# $HOME - never inside either repo - and removes it in a finally.
python3 checks/links_index.py || fail=1

echo
echo "── /tree?path= scopes, and cannot leave the root ────────────"
# `path` was accepted and silently ignored: a client asking for a subtree got
# the whole root and no way to tell. It names a DIRECTORY, which resolve() does
# not answer for, so listing() does its own containment check - and that is the
# half worth asserting.
python3 checks/tree_scope.py || fail=1

echo; echo "── does anything SERVED look like a credential? ─────────────"
# Baseline diff, not "fail on any hit" - the detector flags 40 files and the top
# hits are .env.example and READMEs, so an absolute check would be noise nobody
# reads. This fails on something NEW.
python3 checks/served_secrets.py || fail=1

echo; echo "── the sandbox must actually contain a hostile document ────"
# Needs a browser: the claim is about browser enforcement, so nothing else can
# test it. Skipped rather than failed if playwright-core is absent - the SKIP now
# lives INSIDE the check, which is the only place that can tell the difference
# between "no browser here" and "the browser is somewhere else". The guard this
# replaced stat'd one literal path in one person's npx cache, so it printed SKIP
# on every other machine and on this one the moment npx rehashed the directory.
#
# In a SUBSHELL, and that is the point of the parentheses: env.py is the suite's
# one resolver and this is the one check that cannot import it, so the values are
# handed over as exported variables. Scoping them here keeps the rest of the run
# on the ordinary resolution path rather than on a $BOTHY_BASE this script set.
( eval "$(python3 checks/env.py --sh)"; node checks/sandbox_escape.mjs ) || fail=1

echo; echo "── raw bytes + archives (the sandbox origin) ───────────────"
python3 checks/bytes_e2e.py || fail=1

exit $fail
