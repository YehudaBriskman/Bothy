#!/usr/bin/env bash
# Put one backup artefact back. The other half of scripts/backup.sh.
#
#   scripts/restore.sh <postgres|grafana|env|victoriametrics|loki> <file> [--yes]
#   (normally through `just restore-<kind> <file> [--yes]`)
#
# THE RULES, the same for every kind:
#   1. No default file, ever. "The newest backup" is a guess, and a restore is
#      the one command where guessing wrong destroys the thing you still had.
#   2. It says what it is about to OVERWRITE - what is live now, and what the
#      file holds - and asks, unless --yes. With no terminal and no --yes it
#      refuses rather than assume.
#   3. It stops only the service it replaces (plus, for postgres, the one
#      service whose database it drops), and starts it again whatever happens.
#   4. It verifies afterwards, on the data rather than on a status code, and
#      exits non-zero if the verification did not hold.
#
# Every container name comes from scripts/lib/backup-lib.sh and can be
# overridden (BK_PG=..., BK_GRAFANA=...). That is how these recipes are tested:
# against throwaway containers, never the live ones. BK_ENV_TARGET does the
# same for the .env path.
#
# `grep -c ... >/dev/null`, never `grep -q`, after a pipe: under pipefail,
# grep -q exits on the first match, the writer dies of SIGPIPE, and the pipeline
# reports failure BECAUSE it matched (doctor.sh's backup section has the same
# note). The first version of this file refused a perfectly good vm-*.tar that way.
set -uo pipefail

# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/env.sh"
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/backup-lib.sh"
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
umask 077

say()  { printf '[restore] %s\n' "$*"; }
die()  { printf '[restore] REFUSED: %s\n' "$*" >&2; exit 2; }
bad()  { printf '[restore] FAILED: %s\n' "$*" >&2; failed=1; }
failed=0

yes=0; args=()
for a in "$@"; do
  case "$a" in
    --yes|-y) yes=1 ;;
    -*) die "unknown flag $a" ;;
    *) args+=("$a") ;;
  esac
done
kind=${args[0]:-}
src=${args[1]:-}
[ -n "$kind" ] || die "usage: restore.sh <postgres|grafana|env|victoriametrics|loki> <file> [--yes]"
[ -n "$src" ] || die "no file given. There is no default on purpose - pick one from $BACKUP_ROOT/$kind/"
[ -e "$src" ] || die "$src does not exist"
src=$(realpath "$src")

confirm() {  # <what>
  if [ "$yes" = 1 ]; then say "--yes given: proceeding"; return 0; fi
  if ! { : </dev/tty; } 2>/dev/null; then
    die "no terminal to ask on - re-run with --yes if you mean it"
  fi
  local ans
  printf '[restore] %s\nType "yes" to continue: ' "$1" >/dev/tty
  read -r ans </dev/tty
  [ "$ans" = yes ] || die "not confirmed - nothing was changed"
}

need_container() { bk_exists "$1" || die "container '$1' does not exist - bring its stack up first (just up-...)"; }

# Every stop in here is undone on the way out, even on failure: a restore that
# leaves Grafana stopped because verification failed would hide the evidence.
stopped=""
on_exit() { for c in $stopped; do docker start "$c" >/dev/null 2>&1; done; }
trap on_exit EXIT
stop_c() { docker stop -t 60 "$1" >/dev/null && stopped="$stopped $1"; }
start_c() { docker start "$1" >/dev/null; stopped=$(printf '%s' "$stopped" | tr ' ' '\n' | grep -vx -- "$1" | tr '\n' ' '); }
wait_healthy() {  # <container> <seconds>
  local c=$1 n=$2 st
  for _ in $(seq 1 "$n"); do
    st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null)
    case "$st" in healthy|running) return 0 ;; esac
    sleep 1
  done
  return 1
}

# ── postgres ────────────────────────────────────────────────────────────────
# A pg_dumpall file has no DROP statements (backup.sh does not pass --clean),
# so replaying it over a live server would collide with every existing table.
# Instead: every database the DUMP creates is dropped first (WITH (FORCE), which
# ends its connections) and recreated by the dump itself. Databases the dump
# does not know about are left alone. Roles already present raise "already
# exists", which is expected and ignored; any other error fails the restore.
restore_postgres() {
  gzip -t "$src" 2>/dev/null || die "$src is not a readable gzip"
  local u=${POSTGRES_USER:-dev}
  need_container "$BK_PG"
  bk_running "$BK_PG" || die "$BK_PG is not running - a dump is replayed INTO a running server"
  # database -> CREATE TABLE count, straight from the dump.
  local plan
  plan=$(zcat "$src" | awk '
    /^CREATE DATABASE / { dbs[$3]=0; order[++n]=$3 }
    /^\\connect / { cur=$2 }
    /^CREATE (UNLOGGED )?TABLE / { if (cur in dbs) dbs[cur]++ }
    END { for (i=1;i<=n;i++) print order[i], dbs[order[i]] }')
  [ -n "$plan" ] || die "$src contains no CREATE DATABASE - is it a pg_dumpall file?"
  say "file:   $src ($(du -h "$src" | cut -f1), $(date -r "$src" '+%F %T'))"
  say "it WILL DROP AND RECREATE these databases (tables in the dump):"
  printf '%s\n' "$plan" | while read -r db t; do
    live=$(docker exec "$BK_PG" psql -U "$u" -d postgres -tAc \
      "SELECT pg_size_pretty(pg_database_size('$db'))" 2>/dev/null)
    printf '           %-12s %4s tables in dump   live now: %s\n' "$db" "$t" "${live:-absent}"
  done
  local deps=()
  for c in $BK_PG_DEPENDENTS; do bk_running "$c" && deps+=("$c"); done
  say "it stops ${deps[*]:-nothing} while it runs, and starts it again after"
  confirm "Overwrite those databases in '$BK_PG' from this dump?"

  for c in "${deps[@]}"; do stop_c "$c"; say "stopped $c"; done
  local db
  for db in $(printf '%s\n' "$plan" | cut -d' ' -f1); do
    case "$db" in postgres|template0|template1) continue ;; esac
    docker exec "$BK_PG" psql -X -q -U "$u" -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null \
      || { bad "could not drop $db - nothing replayed"; return; }
  done
  local errs
  errs=$(zcat "$src" | docker exec -i "$BK_PG" psql -X -q -U "$u" -d postgres 2>&1 >/dev/null \
         | grep 'ERROR:' | grep -v 'role ".*" already exists')
  [ -z "$errs" ] || bad "replay reported errors:"$'\n'"$errs"
  for c in "${deps[@]}"; do
    start_c "$c"
    wait_healthy "$c" 180 && say "started $c ($(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c"))" \
      || bad "$c did not come back healthy within 180s"
  done

  # VERIFY: every database is back, with as many tables as the dump creates.
  # Collected, then printed - not `| tee /dev/stderr`: when stderr is a file,
  # tee REOPENS it with O_TRUNC and wipes everything logged before this point.
  local report
  report=$(printf '%s\n' "$plan" | while read -r db t; do
    got=$(docker exec "$BK_PG" psql -U "$u" -d "$db" -tAc \
      "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')" 2>/dev/null)
    if [ "$got" = "$t" ]; then say "verified $db: $got tables"
    else echo "[restore] FAIL $db: expected $t tables, found ${got:-none}"; fi
  done)
  printf '%s\n' "$report"
  case "$report" in *"] FAIL "*) bad "table counts do not match the dump" ;; esac
}

# ── grafana ─────────────────────────────────────────────────────────────────
# grafana.db is SQLite: replace the file with Grafana STOPPED, never under it.
# The file is integrity-checked before anything is touched, and the stale
# -journal/-wal/-shm of the old database are removed with it (a journal left
# beside a different database is how SQLite files get "repaired" into garbage).
#
# What "verified" means here. File-PROVISIONED dashboards (every dashboard on
# this box today - monitoring/dashboards/) are reconciled with the provisioning
# files when Grafana starts: added if the file exists, DELETED if it does not.
# So their count after a restore says more about monitoring/dashboards than
# about the backup, and it is reported, not compared. What IS compared is what
# only the database holds: users, and dashboards made in the UI.
gf_stats() {  # python: "<integrity> <dashboards> <ui-dashboards> <users>" for argv[1]
  printf '%s' '
import sqlite3, sys
c = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro" + sys.argv[2], uri=True, timeout=30)
ok = c.execute("PRAGMA integrity_check").fetchone()[0]
# Grafana 12+ keeps dashboards in unified storage (the `resource` table); older
# ones, and some dual-write modes, in `dashboard`. Whichever holds more.
legacy = c.execute("SELECT count(*), count(*) - count(p.dashboard_id) FROM dashboard d LEFT JOIN dashboard_provisioning p ON p.dashboard_id = d.id").fetchone()
try:
    uni = c.execute("SELECT count(*), sum(CAST(value AS TEXT) NOT LIKE \x27%classic-file-provisioning%\x27) FROM resource WHERE \"group\" = \x27dashboard.grafana.app\x27 AND resource = \x27dashboards\x27").fetchone()
except sqlite3.OperationalError:
    uni = (0, 0)
d, ui = max(legacy, (uni[0], uni[1] or 0))
u = c.execute("SELECT count(*) FROM user").fetchone()[0]
print(ok.replace(" ", "_"), d, ui, u)'
}
gf_healthy() {
  bk_http "$BK_GRAFANA" GET http://127.0.0.1:3000/api/health </dev/null 2>/dev/null \
    | grep -c '"database": *"ok"' >/dev/null
}
restore_grafana() {
  need_container "$BK_GRAFANA"
  local new cur ok nd nui nu
  new=$(docker run --rm -v "$src:/restore.db:ro" "$BK_HELPER_IMAGE" \
        python3 -c "$(gf_stats)" /restore.db '&immutable=1' 2>&1) \
    || die "$src is not a readable SQLite database: $new"
  read -r ok nd nui nu <<<"$new"
  [ "$ok" = ok ] || die "$src fails PRAGMA integrity_check: $ok"
  cur=$(docker run --rm --volumes-from "$BK_GRAFANA:ro" "$BK_HELPER_IMAGE" \
        python3 -c "$(gf_stats)" /var/lib/grafana/grafana.db '' 2>/dev/null) || cur=""
  say "file:     $src ($(du -h "$src" | cut -f1), integrity ok, $nu users, $nd dashboards of which $nui made in the UI)"
  local now=absent c_ok c_nd c_nui c_nu
  read -r c_ok c_nd c_nui c_nu <<<"$cur"
  [ -n "${c_ok:-}" ] && now="$c_nu users, $c_nd dashboards of which $c_nui made in the UI"
  say "replaces: $BK_GRAFANA:/var/lib/grafana/grafana.db (live now: $now)"
  say "it stops $BK_GRAFANA, replaces the file, and starts it again"
  confirm "Replace Grafana's database?"

  stop_c "$BK_GRAFANA" || { bad "could not stop $BK_GRAFANA"; return; }
  say "stopped $BK_GRAFANA"
  docker run --rm --volumes-from "$BK_GRAFANA" -v "$src:/restore.db:ro" "$BK_HELPER_IMAGE" sh -euc '
    d=/var/lib/grafana
    own=$(stat -c %u:%g "$d/grafana.db" 2>/dev/null || stat -c %u:%g "$d")
    cp /restore.db "$d/.grafana.db.restoring"
    chown "$own" "$d/.grafana.db.restoring"
    chmod 640 "$d/.grafana.db.restoring"
    rm -f "$d/grafana.db-journal" "$d/grafana.db-wal" "$d/grafana.db-shm"
    mv -f "$d/.grafana.db.restoring" "$d/grafana.db"' \
    || { bad "copying the file into the volume failed"; return; }
  start_c "$BK_GRAFANA"
  # VERIFY: Grafana says its database is ok (the body, not the status code),
  # and the file it now runs on holds what only the backup could have given it.
  if bk_wait 120 gf_healthy; then
    say "verified: $BK_GRAFANA /api/health reports database ok"
  else
    bad "$BK_GRAFANA /api/health did not report database ok within 120s"
  fi
  cur=$(docker run --rm --volumes-from "$BK_GRAFANA:ro" "$BK_HELPER_IMAGE" \
        python3 -c "$(gf_stats)" /var/lib/grafana/grafana.db '' 2>/dev/null)
  read -r c_ok c_nd c_nui c_nu <<<"$cur"
  if [ "${c_ok:-}" = ok ] && [ "${c_nu:-}" = "$nu" ] && [ "${c_nui:-}" = "$nui" ]; then
    say "verified: live grafana.db integrity ok, $c_nu users and $c_nui UI dashboards - as in the backup"
    say "          ($c_nd dashboards in all; file-provisioned ones follow monitoring/dashboards, backup had $nd)"
  else
    bad "live grafana.db after restore: '$cur' (integrity dashboards ui-dashboards users); backup had: ok $nd $nui $nu"
  fi
}

# ── env ─────────────────────────────────────────────────────────────────────
# Key NAMES only are ever printed - never a value. The current file is saved
# beside the other .env backups first, so this is itself undoable. Nothing is
# restarted: nothing reads .env until the next `just up`.
restore_env() {
  local target=${BK_ENV_TARGET:-$root/.env}
  [ -s "$src" ] || die "$src is empty"
  keys() { sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$1" | sort -u; }
  say "file:     $src ($(keys "$src" | wc -l) keys)"
  if [ -f "$target" ]; then
    say "replaces: $target ($(keys "$target" | wc -l) keys)"
    local only_new only_cur changed
    only_new=$(comm -23 <(keys "$src") <(keys "$target") | tr '\n' ' ')
    only_cur=$(comm -13 <(keys "$src") <(keys "$target") | tr '\n' ' ')
    changed=$(comm -12 <(keys "$src") <(keys "$target") | while read -r k; do
      [ "$(grep -m1 "^$k=" "$src")" = "$(grep -m1 "^$k=" "$target")" ] || printf '%s ' "$k"; done)
    say "  keys only in the backup:   ${only_new:-none}"
    say "  keys only in the live file (will be LOST): ${only_cur:-none}"
    say "  keys whose value differs:  ${changed:-none}"
  else
    say "replaces: $target (absent now)"
  fi
  confirm "Replace $target?"
  if [ -f "$target" ]; then
    mkdir -p "$BACKUP_ROOT/env" && chmod 700 "$BACKUP_ROOT/env"
    local keep
    keep="$BACKUP_ROOT/env/env-$(date +%Y%m%d-%H%M%S)-pre-restore"
    install -m 600 "$target" "$keep" && say "saved the current file as $keep"
  fi
  install -m 600 "$src" "$target"
  if cmp -s "$src" "$target"; then
    say "verified: $target is byte-identical to the backup, mode $(stat -c %a "$target")"
    say "nothing reads it until the next 'just up'"
  else
    bad "$target does not match $src after copying"
  fi
}

# ── victoriametrics ─────────────────────────────────────────────────────────
# Accepts the vm-<ts>.tar that backup.sh writes, or a directory holding the
# same layout (data/ and metadata/, e.g. an unpacked tar or a snapshot copied
# with `cp -rL`). The volume is EMPTIED first: a snapshot is the whole
# -storageDataPath, and merging it with newer parts would not be a restore.
restore_victoriametrics() {
  need_container "$BK_VM"
  local mount
  if [ -d "$src" ]; then
    [ -d "$src/data" ] || die "$src has no data/ - not a VictoriaMetrics snapshot"
    mount=(-v "$src:/restore:ro")
  else
    tar -tf "$src" 2>/dev/null | grep -c '^\./data/' >/dev/null || die "$src is not a vm-*.tar (no ./data/ inside)"
    mount=(-v "$src:/restore.tar:ro")
  fi
  local cur="not running"
  bk_running "$BK_VM" && cur="$(bk_vm_api "$BK_VM" GET /api/v1/series/count 2>/dev/null | sed -n 's/.*"data":\[\([0-9]*\)\].*/\1/p') series"
  say "file:     $src ($(du -sh "$src" | cut -f1))"
  say "replaces: EVERYTHING in $BK_VM:/victoria-metrics-data (live now: $cur)"
  say "it stops $BK_VM, empties the volume, unpacks, and starts it again"
  confirm "Replace VictoriaMetrics' data?"

  stop_c "$BK_VM" || { bad "could not stop $BK_VM"; return; }
  say "stopped $BK_VM"
  docker run --rm --volumes-from "$BK_VM" "${mount[@]}" "$BK_HELPER_IMAGE" sh -euc '
    cd /victoria-metrics-data
    find . -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    if [ -f /restore.tar ]; then tar -xf /restore.tar -C .; else cp -a /restore/. .; fi' \
    || { bad "unpacking into the volume failed"; return; }
  start_c "$BK_VM"
  # VERIFY: /health, then that the restored index actually holds series.
  bk_wait 120 bk_http "$BK_VM" GET http://127.0.0.1:8428/health </dev/null \
    || { bad "$BK_VM /health did not answer within 120s"; return; }
  local n
  n=$(bk_vm_api "$BK_VM" GET /api/v1/series/count 2>/dev/null | sed -n 's/.*"data":\[\([0-9]*\)\].*/\1/p')
  if [ "${n:-0}" -gt 0 ]; then say "verified: $BK_VM is up and holds $n series"
  else bad "$BK_VM came back with no series"; fi
}

# ── loki ────────────────────────────────────────────────────────────────────
# The loki-<ts>.tar.gz backup.sh writes: the whole /loki, taken while Loki was
# stopped. Emptied and unpacked with Loki stopped, ownership kept (uid 10001).
# Chunks older than the 168h retention are deleted again by the compactor.
restore_loki() {
  need_container "$BK_LOKI"
  tar -tzf "$src" 2>/dev/null | grep -cE '^\./(chunks|tsdb-shipper-active)' >/dev/null \
    || die "$src is not a loki-*.tar.gz (no ./chunks or ./tsdb-shipper-active inside)"
  local cur
  cur=$(docker run --rm --volumes-from "$BK_LOKI:ro" "$BK_HELPER_IMAGE" du -sh /loki 2>/dev/null | cut -f1)
  say "file:     $src ($(du -h "$src" | cut -f1))"
  say "replaces: EVERYTHING in $BK_LOKI:/loki (live now: ${cur:-?})"
  say "it stops $BK_LOKI, empties the volume, unpacks, and starts it again"
  confirm "Replace Loki's data?"

  stop_c "$BK_LOKI" || { bad "could not stop $BK_LOKI"; return; }
  say "stopped $BK_LOKI"
  docker run --rm --volumes-from "$BK_LOKI" -v "$src:/restore.tar.gz:ro" "$BK_HELPER_IMAGE" sh -euc '
    cd /loki
    find . -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    tar -xzf /restore.tar.gz -C .' \
    || { bad "unpacking into the volume failed"; return; }
  start_c "$BK_LOKI"
  bk_wait 120 bk_http "$BK_LOKI" GET http://127.0.0.1:3100/ready </dev/null \
    || { bad "$BK_LOKI /ready did not answer within 120s"; return; }
  # VERIFY: label names over the last 7 days - empty unless the restored index
  # and chunks are actually readable.
  local since labels
  since=$(( ($(date +%s) - 7*86400) * 1000000000 ))
  labels=$(bk_http "$BK_LOKI" GET "http://127.0.0.1:3100/loki/api/v1/labels?start=$since" </dev/null 2>/dev/null)
  if printf '%s' "$labels" | grep -c '"data":\["' >/dev/null; then
    say "verified: $BK_LOKI is ready and answers labels: $(printf '%s' "$labels" | sed -n 's/.*"data":\[\(.*\)\].*/\1/p' | cut -c1-120)"
  else
    bad "$BK_LOKI is ready but returned no labels for the last 7 days: $labels"
  fi
}

case "$kind" in
  postgres) restore_postgres ;;
  grafana) restore_grafana ;;
  env) restore_env ;;
  victoriametrics|vm) restore_victoriametrics ;;
  loki) restore_loki ;;
  *) die "unknown kind '$kind' - postgres, grafana, env, victoriametrics or loki" ;;
esac

if [ "$failed" = 1 ]; then
  say "restore of $kind did NOT verify - see FAILED above"
  exit 1
fi
say "restore of $kind done and verified"
