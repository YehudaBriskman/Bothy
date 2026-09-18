#!/usr/bin/env bash
# Back up the dev stacks' stateful bits with simple rotation.
#
# WHAT, and how each is taken (docs/guide/backups.md has the table with sizes):
#   postgres/         pg_dumpall, gzipped                         keep BK_KEEP (14)
#   grafana/          SQLite online-backup API, integrity-checked keep 14
#   env/              .env, verbatim                              keep 14
#   victoriametrics/  /snapshot/create, tar of the snapshot       keep BK_KEEP_BIG (3)
#   loki/             /flush, stop, tar of /loki, start           keep 3
#   alloy/            tar of the positions volume                 keep 14
#   state/            the audit logs and the two trash dirs       keep 14
#   notes/            git bundle of $NOTES_ROOT (+ uncommitted)   keep 14
# Restoring: scripts/restore.sh, through `just restore-<kind> <file>`.
#
# Runs both from `just backup` and from stacks-backup.timer. systemd does not
# load ~/stacks/.env the way just does (set dotenv-load), so source it here.
#
# Deliberately NOT `set -e`. The old script aborted the moment one service
# failed, which is why a single bad postgres dump left redis, grafana and
# portainer un-backed-up for six days without anything looking wrong.
set -uo pipefail

# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/env.sh"
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/backup-lib.sh"
# $1 still wins, because the systemd unit and a person at a prompt both pass one
# sometimes; BACKUP_ROOT is the default and comes from .env or from $HOME.
BK="${1:-$BACKUP_ROOT}"
ts=$(date +%Y%m%d-%H%M%S)
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[ -f "$root/.env" ] && { set -a; . "$root/.env"; set +a; }

# EVERY artifact here is a credential store, so none of them may be world- or
# group-readable. The postgres dump is the sharp one: pg_dumpall includes the
# keycloak database, so it carries the identity provider's user table - password
# hashes for every account on the box - and it was being written 0644 by the
# default umask. The .env copies were already 600; the dumps were not, which is
# the wrong way round from how they were being thought about.
umask 077

fails=0
log()  { printf '[backup %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf '[backup %s] FAIL: %s\n' "$(date +%H:%M:%S)" "$*" >&2; fails=$((fails + 1)); }
running() { bk_running "$1"; }

# An empty artifact is worse than no artifact: rotation counts it and would
# eventually evict a good backup with a worthless one.
keep_if_real() {  # <file> <min-bytes> <label>
  local f=$1 min=$2 label=$3 size
  size=$([ -f "$f" ] && wc -c < "$f" || echo 0)
  if [ "$size" -ge "$min" ]; then
    log "$label -> $(basename "$f") ($(du -h "$f" | cut -f1))"
  else
    fail "$label produced ${size} bytes - discarding"
    rm -f "$f"
  fi
}

KINDS="postgres grafana env victoriametrics loki alloy state notes"
for d in $KINDS; do mkdir -p "$BK/$d"; done
# The directories too, and on every run: `mkdir -p` leaves an existing directory
# alone, so the umask above would never reach ones already created 0755.
chmod 700 "$BK" 2>/dev/null
for d in $KINDS; do chmod 700 "$BK/$d" 2>/dev/null; done

# A service this script STOPS must be started again even if the script dies
# half-way through - a backup that leaves Loki down is worse than no backup.
restart_on_exit=""
on_exit() { for c in $restart_on_exit; do docker start "$c" >/dev/null 2>&1; done; }
trap on_exit EXIT

# The timer is Persistent=true, so a schedule missed while the box was off
# fires at the next boot - exactly when postgres is still initialising. Without
# this wait the dump comes back empty and the backup silently reports success.
if running "$BK_PG"; then
  ready=0
  for _ in $(seq 1 30); do
    if docker exec "$BK_PG" pg_isready -q -U "${POSTGRES_USER:-dev}" 2>/dev/null; then ready=1; break; fi
    sleep 2
  done
  if [ "$ready" = 1 ]; then
    # pg_dumpall, NOT `pg_dump <named list>` - deliberately, and load-bearing
    # since 2026-08-12: Keycloak's data (users, realms, clients) now lives in a
    # `keycloak` database inside this same server, created by auth/compose.yml's
    # keycloak-db-init against the running instance. A named-database list would
    # not have grown a `keycloak` entry on its own, and the identity provider
    # for the whole box would have been silently unbacked-up. `pg_dumpall` picks
    # up any new database with no edit here. Verified: the dump contains
    # `CREATE DATABASE keycloak` and its 132 public tables (realm, client,
    # user_entity). Do not narrow this to a list.
    docker exec "$BK_PG" pg_dumpall -U "${POSTGRES_USER:-dev}" 2>/dev/null | gzip > "$BK/postgres/pg-$ts.sql.gz"
    keep_if_real "$BK/postgres/pg-$ts.sql.gz" 1000 postgres
  else
    fail "postgres not ready after 60s - skipped"
  fi
else
  fail "postgres not running - skipped"
fi

# A redis step lived here until 2026-08-12: `redis-cli SAVE` then
# `docker cp redis:/data/dump.rdb`. Redis was retired that day (zero keys) and
# its volume deleted, so the step could only ever take the else branch and print
# "redis not running - skipped" - a FAIL, every night, for ever. That is the
# expensive kind of wrong: a warning that fires unconditionally is one nobody
# reads, and the next line of the report is the postgres dump that actually
# matters. It also made the script exit 1 nightly, so the timer's own success
# signal was useless too.
# (Its old artifacts under $BK/redis are left on disk untouched - all 88 bytes
# each, an empty RDB, which is what "zero keys" looks like. Nothing writes there
# now, so they are no longer rotated; delete them by hand whenever.)

# GRAFANA - a CONSISTENT copy, with Grafana left running.
#
# Until 2026-09 this was `docker cp grafana:/var/lib/grafana/grafana.db`: a
# plain byte copy of a live SQLite file. If Grafana wrote during the copy (it
# writes alert state on every evaluation) the result could be torn - pages from
# before and after the write - and nothing checked.
#
# The grafana image has no sqlite3 binary (checked 13.1.4) and Grafana has no
# HTTP API that backs up its own database. So a borrowed python:alpine
# container mounts the volume READ-ONLY and uses SQLite's online-backup API
# (sqlite3.Connection.backup, all pages in one step). That holds a shared lock
# through the same fcntl locks Grafana's SQLite uses - same kernel, same inode -
# so it copies one consistent state, and Grafana at worst waits milliseconds
# for a write. No stop, no downtime. `mode=ro` plus the :ro mount mean the
# helper cannot leave a root-owned -journal or -shm in Grafana's volume.
#
# The copy is integrity-checked BEFORE it is kept. One that fails the check is
# discarded, like an empty one.
if running "$BK_GRAFANA"; then
  out="$BK/grafana/grafana-$ts.db"
  if docker run --rm --volumes-from "$BK_GRAFANA:ro" "$BK_HELPER_IMAGE" python3 -c '
import shutil, sqlite3, sys
def dashboards(c):
    # Grafana 12+ keeps dashboards in unified storage (the `resource` table);
    # older ones, and some dual-write modes, in `dashboard`. Count both.
    n = c.execute("SELECT count(*) FROM dashboard").fetchone()[0]
    try:
        n = max(n, c.execute("SELECT count(*) FROM resource WHERE \"group\" = \x27dashboard.grafana.app\x27 AND resource = \x27dashboards\x27").fetchone()[0])
    except sqlite3.OperationalError:
        pass
    return n
src = sqlite3.connect("file:/var/lib/grafana/grafana.db?mode=ro", uri=True, timeout=60)
dst = sqlite3.connect("/tmp/grafana.db")
src.backup(dst)
src.close()
ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
n = dashboards(dst)
dst.close()
if ok != "ok":
    sys.exit("integrity_check: " + ok)
print("integrity_check ok, %d dashboards" % n, file=sys.stderr)
with open("/tmp/grafana.db", "rb") as f:
    shutil.copyfileobj(f, sys.stdout.buffer)
' > "$out" 2> "$out.log"; then
    log "grafana: $(cat "$out.log")"
    keep_if_real "$out" 1000 grafana
  else
    fail "grafana online backup failed: $(tr '\n' ' ' < "$out.log")"
    rm -f "$out"
  fi
  rm -f "$out.log"
else
  fail "grafana not running - skipped"
fi

# A portainer step lived here until 2026-08-18, and it went the same way as the
# redis one above and for the same reason. Portainer was retired on 2026-08-17
# and deleted the next day, so this could only take the else branch: "portainer
# not running - skipped", a FAIL, every night, for ever - and it made the whole
# script exit 1, so the timer's success signal was worthless and `just backup`
# looked broken to anyone who ran it.
#
# THAT IS THE SECOND TIME. The comment above records the identical bug with
# redis and this repo still shipped it again, which is worth stating plainly:
# deleting a service means deleting its backup step in the same change, or the
# nightly report starts lying the following morning.
#
# Its old artifacts under $BK/portainer are left on disk untouched. Nothing
# writes there now, so they are no longer rotated; delete them by hand whenever.

# .env is gitignored and exists nowhere else on earth. Losing it loses every
# credential on the box, so it belongs in the backup more than anything here.
if [ -f "$root/.env" ]; then
  install -m 600 "$root/.env" "$BK/env/env-$ts"
  keep_if_real "$BK/env/env-$ts" 1 env
else
  fail ".env not found at $root/.env"
fi

# VICTORIAMETRICS - its own snapshot API, then a tar of the snapshot.
#
# /snapshot/create flushes in-memory rows and hard-links the current parts into
# snapshots/<name>: instant, no extra disk until the live parts are merged
# away, and VM keeps scraping throughout. The snapshot is a directory of
# RELATIVE SYMLINKS into data/{small,big,indexdb}/snapshots/<name>, so the tar
# is taken with -h (follow them). What lands in the archive is data/ and
# metadata/ laid out exactly like -storageDataPath, which is what restore needs.
#
# vmbackup (the official tool) was evaluated and not used. What it adds is
# incremental uploads and object-storage targets, and this box has neither: a
# local fs:// target keeping three full copies is what a tar already is, minus
# a second image to pin and vmrestore to restore with. Revisit it if backups
# ever leave the box. Not gzipped: VM parts are already zstd-compressed.
#
# The snapshot is deleted afterwards, whatever happened. One left behind pins
# every part it links and quietly doubles the volume over the following days.
if running "$BK_VM"; then
  out="$BK/victoriametrics/vm-$ts.tar"
  # Room for it? The newest previous copy is the best estimate there is; 1 GiB
  # before there is one. Twice that, so the disk is never filled to the brim.
  prev=$(ls -1t "$BK"/victoriametrics/vm-*.tar 2>/dev/null | head -1)
  need=1073741824
  [ -n "$prev" ] && need=$(wc -c < "$prev")
  need=$(( need * 2 ))
  avail=$(df -P -B1 "$BK" | awk 'NR==2{print $4}')
  if [ "${avail:-0}" -lt "$need" ]; then
    fail "victoriametrics skipped - $(bk_human "${avail:-0}") free under $BK, want $(bk_human "$need")"
  else
    resp=$(bk_vm_api "$BK_VM" POST /snapshot/create 2>&1)
    vm_snap=$(printf '%s' "$resp" | sed -n 's/.*"snapshot":"\([^"]*\)".*/\1/p')
    if [ -z "$vm_snap" ]; then
      fail "victoriametrics /snapshot/create failed: $resp"
    else
      docker exec "$BK_VM" tar -chf - -C "/victoria-metrics-data/snapshots/$vm_snap" . > "$out" 2>/dev/null
      if tar -tf "$out" 2>/dev/null | grep -c '^\./data/' >/dev/null; then
        keep_if_real "$out" 1000 "victoriametrics (snapshot $vm_snap)"
      else
        fail "victoriametrics tar of $vm_snap is unreadable or has no data/"
        rm -f "$out"
      fi
      bk_vm_api "$BK_VM" POST "/snapshot/delete?snapshot=$vm_snap" >/dev/null 2>&1 \
        || fail "victoriametrics snapshot $vm_snap NOT deleted - POST /snapshot/delete?snapshot=$vm_snap"
    fi
  fi
else
  fail "victoriametrics not running - skipped"
fi

# LOKI - flush, stop, tar, start. A few seconds of Loki downtime, on purpose.
#
# Loki has no snapshot API. Its filesystem store is several things that change
# independently while it runs: the WAL, the active TSDB index (built locally,
# then shipped into the store every few minutes), the compactor's state and the
# chunks. A tar of that while it runs is not a point-in-time copy - each file is
# read at a different moment, so the index can name chunks the tar never got.
# For filesystem storage the docs offer POST /flush (write every in-memory chunk
# out) and nothing stronger.
#
# So: /flush, then STOP it, which closes the WAL and index cleanly, then tar,
# then start. Measured on this box (~25 MB): a few seconds from stop to start.
# Nothing is lost across the gap - Alloy's loki.write retries with backoff and
# does not drop a batch Loki refused - and nothing alerts on Loki (it is not a
# scrape target). /ready then takes ~15s, which is Loki's own ring delay.
if running "$BK_LOKI"; then
  out="$BK/loki/loki-$ts.tar.gz"
  bk_http "$BK_LOKI" POST http://127.0.0.1:3100/flush </dev/null >/dev/null 2>&1 \
    || log "loki: /flush did not answer 2xx - continuing; the stop below closes the WAL anyway"
  restart_on_exit="$restart_on_exit $BK_LOKI"
  t0=$(date +%s)
  if docker stop -t 60 "$BK_LOKI" >/dev/null; then
    docker run --rm --volumes-from "$BK_LOKI:ro" "$BK_HELPER_IMAGE" tar -czf - -C /loki . > "$out" 2>/dev/null
    docker start "$BK_LOKI" >/dev/null
    restart_on_exit=""
    log "loki: stopped for $(( $(date +%s) - t0 ))s"
    keep_if_real "$out" 1000 loki
    bk_wait 90 bk_http "$BK_LOKI" GET http://127.0.0.1:3100/ready </dev/null \
      || fail "loki restarted but /ready did not answer within 90s"
  else
    fail "loki would not stop - skipped"
  fi
else
  fail "loki not running - skipped"
fi

# ALLOY'S POSITIONS - how far into every log Alloy has shipped. Tiny, and a
# live tar is fine: Alloy rewrites the file whole. Restoring it is optional
# (docs/guide/backups.md); without it, the first start after a rebuild re-reads
# what json-file still holds and Loki drops the duplicates.
if running "$BK_ALLOY"; then
  out="$BK/alloy/alloy-$ts.tar.gz"
  docker run --rm --volumes-from "$BK_ALLOY:ro" "$BK_HELPER_IMAGE" tar -czf - -C /var/lib/alloy/data . > "$out" 2>/dev/null
  keep_if_real "$out" 100 "alloy positions"
else
  fail "alloy not running - skipped"
fi

# STATE - the audit logs and the two trash directories. Host directories, so a
# plain tar. The audit logs are the only record of who changed what through
# Bothy; the trash directories are the undo for the file editor and the config
# forms. Members are stored relative to their roots - apps/... under the repo,
# bothy/... under $STATE_ROOT - so a restore can put them back anywhere.
state_args=()
repo_parts=(); for p in apps/bothy-ops/audit apps/bothy-files/audit; do
  [ -d "$root/$p" ] && repo_parts+=("$p"); done
state_parts=(); for p in bothy/trash bothy/config-trash; do
  [ -d "$STATE_ROOT/$p" ] && state_parts+=("$p"); done
[ ${#repo_parts[@]} -gt 0 ] && state_args+=(-C "$root" "${repo_parts[@]}")
[ ${#state_parts[@]} -gt 0 ] && state_args+=(-C "$STATE_ROOT" "${state_parts[@]}")
if [ ${#state_args[@]} -gt 0 ]; then
  out="$BK/state/state-$ts.tar.gz"
  tar -czf "$out" "${state_args[@]}" 2>/dev/null
  keep_if_real "$out" 100 "state (audit + trash)"
else
  log "state: no audit or trash directories yet - nothing to save"
fi

# NOTES - $NOTES_ROOT is a git repo whose edits arrive from the bothy-files
# editor as well as from commits, so a bundle alone would miss exactly the
# newest work. Two artefacts: a `git bundle --all` (every branch, verified,
# restored with `git clone`), plus a tar of whatever is modified or untracked
# right now, only when there is any. Absent notes are not a fault: a fresh
# install has none.
if [ -d "$NOTES_ROOT/.git" ]; then
  out="$BK/notes/notes-$ts.bundle"
  if git -C "$NOTES_ROOT" bundle create "$out" --all >/dev/null 2>&1 \
     && git -C "$NOTES_ROOT" bundle verify -q "$out" >/dev/null 2>&1; then
    keep_if_real "$out" 100 notes
  else
    fail "notes: git bundle failed for $NOTES_ROOT"
    rm -f "$out"
  fi
  dirty=$(git -C "$NOTES_ROOT" ls-files --modified --others --exclude-standard 2>/dev/null | sort -u)
  if [ -n "$dirty" ]; then
    out="$BK/notes/notes-$ts-worktree.tar.gz"
    printf '%s\n' "$dirty" | tar -czf "$out" -C "$NOTES_ROOT" --ignore-failed-read -T - 2>/dev/null
    keep_if_real "$out" 20 "notes, uncommitted ($(printf '%s\n' "$dirty" | wc -l) files)"
  fi
elif [ -d "$NOTES_ROOT" ]; then
  out="$BK/notes/notes-$ts.tar.gz"
  tar -czf "$out" -C "$NOTES_ROOT" . 2>/dev/null
  keep_if_real "$out" 20 "notes (not a git repo - tarred)"
else
  log "notes: $NOTES_ROOT does not exist - nothing to save"
fi

# The generated SECRETS are deliberately NOT here: apps/bothy-ops/secrets,
# apps/headlamp/secrets, monitoring/kube-auth. Every one is re-issued by a
# recipe (docs/guide/backups.md lists which), and three of the four are
# ServiceAccount tokens bound to ONE cluster - after a rebuild a saved copy is a
# credential for something that no longer exists. The fourth, the Keycloak
# admin-client secret, is also inside the postgres dump (Keycloak's client
# table). monitoring/kube-auth/token is uid 65534 mode 600, so this script,
# running as the user, could not read it anyway.

# ── rotation ────────────────────────────────────────────────────────────────
rotate() {  # <dir> <glob> <keep>
  # shellcheck disable=SC2086  # the glob must expand
  ls -1t "$BK/$1"/$2 2>/dev/null | tail -n +$(( $3 + 1 )) | xargs -r rm -f
}
rotate postgres        'pg-*.sql.gz'             "$BK_KEEP"
rotate grafana         'grafana-*.db'            "$BK_KEEP"
rotate env             'env-*'                   "$BK_KEEP"
rotate alloy           'alloy-*.tar.gz'          "$BK_KEEP"
rotate state           'state-*.tar.gz'          "$BK_KEEP"
rotate notes           'notes-*.bundle'          "$BK_KEEP"
rotate notes           'notes-*-worktree.tar.gz' "$BK_KEEP"
rotate notes           'notes-*[0-9].tar.gz'     "$BK_KEEP"
rotate victoriametrics 'vm-*.tar'                "$BK_KEEP_BIG"
rotate loki            'loki-*.tar.gz'           "$BK_KEEP_BIG"

# Files 600, on every run. umask covers what this script writes, but not what an
# older version left behind: `docker cp` kept grafana.db's own 0640, so every
# grafana copy before 2026-09 was group-readable.
for d in $KINDS; do
  find "$BK/$d" -maxdepth 1 -type f ! -perm 600 -exec chmod 600 {} + 2>/dev/null
done

# ── size report ─────────────────────────────────────────────────────────────
log "sizes under $BK:"
for d in $KINDS; do
  n=$(find "$BK/$d" -maxdepth 1 -type f 2>/dev/null | wc -l)
  newest=$(ls -1t "$BK/$d" 2>/dev/null | head -1)
  printf '[backup]   %-16s %3s kept %7s   newest %7s  %s\n' "$d" "$n" \
    "$(du -sh "$BK/$d" 2>/dev/null | cut -f1)" \
    "$( [ -n "$newest" ] && du -h "$BK/$d/$newest" | cut -f1)" "$newest"
done
printf '[backup]   %-16s      %7s   (%s free on that disk)\n' "total" \
  "$(du -sh "$BK" 2>/dev/null | cut -f1)" "$(df -h "$BK" | awk 'NR==2{print $4}')"

if [ "$fails" -gt 0 ]; then
  log "done WITH $fails FAILURE(S). retained newest $BK_KEEP ($BK_KEEP_BIG for victoriametrics/loki) under $BK"
  exit 1
fi
log "done. retained newest $BK_KEEP ($BK_KEEP_BIG for victoriametrics/loki) under $BK"
