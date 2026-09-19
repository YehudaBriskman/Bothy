#!/usr/bin/env bash
# ONE time-series snapshot, to ONE file. The updater's pre-update step.
#
#   scripts/snapshot.sh <victoriametrics|loki> <out>
#
# Called by apps/bothy-ops/updater (the host executor, docs/plans/updates.md
# step 4) with an argv list, never a shell string. It takes the SAME snapshot the
# nightly backup takes - bk_snapshot_vm / bk_snapshot_loki in
# scripts/lib/backup-lib.sh - so what it writes is exactly what
# `just restore-victoriametrics` / `just restore-loki` put back.
#
# The container comes from BK_VM / BK_LOKI like everything in backup-lib.sh: the
# updater passes the container the pin names, and the tests pass a throwaway one.
#
# Exit codes: 0 good, 1 no artefact, 2 good but the VictoriaMetrics server-side
# snapshot was not deleted, 3 good but Loki did not answer /ready within 90s.
set -uo pipefail

# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/env.sh"
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/backup-lib.sh"
umask 077

kind=${1:-}
out=${2:-}
[ -n "$kind" ] && [ -n "$out" ] || { echo "usage: snapshot.sh <victoriametrics|loki> <out>" >&2; exit 64; }
# A snapshot never overwrites anything: the updater names a fresh directory.
[ -e "$out" ] && { echo "$out already exists - refusing to overwrite it" >&2; exit 64; }

case "$kind" in
  victoriametrics)
    bk_running "$BK_VM" || { echo "$BK_VM is not running" >&2; exit 1; }
    bk_snapshot_vm "$BK_VM" "$out"
    ;;
  loki)
    bk_running "$BK_LOKI" || { echo "$BK_LOKI is not running" >&2; exit 1; }
    # Loki is STOPPED for the tar. Whatever happens after this line, it is
    # started again - a snapshot that leaves Loki down is worse than none.
    trap 'docker start "$BK_LOKI" >/dev/null 2>&1' EXIT
    bk_snapshot_loki "$BK_LOKI" "$out"
    ;;
  *)
    echo "unknown kind $kind (victoriametrics or loki)" >&2
    exit 64
    ;;
esac
