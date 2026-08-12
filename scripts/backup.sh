#!/usr/bin/env bash
# Back up the dev stacks' stateful bits with simple rotation.
#
# Runs both from `just backup` and from stacks-backup.timer. systemd does not
# load ~/stacks/.env the way just does (set dotenv-load), so source it here.
#
# Deliberately NOT `set -e`. The old script aborted the moment one service
# failed, which is why a single bad postgres dump left redis, grafana and
# portainer un-backed-up for six days without anything looking wrong.
set -uo pipefail

BK="${1:-/home/devssh/backups}"
KEEP=14
ts=$(date +%Y%m%d-%H%M%S)
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[ -f "$root/.env" ] && { set -a; . "$root/.env"; set +a; }

fails=0
log()  { printf '[backup %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf '[backup %s] FAIL: %s\n' "$(date +%H:%M:%S)" "$*" >&2; fails=$((fails + 1)); }
running() { docker ps --format '{{.Names}}' | grep -qx "$1"; }

# An empty artifact is worse than no artifact: rotation counts it and would
# eventually evict a good backup with a worthless one.
keep_if_real() {  # <file> <min-bytes> <label>
  local f=$1 min=$2 label=$3 size
  size=$([ -f "$f" ] && wc -c < "$f" || echo 0)
  if [ "$size" -ge "$min" ]; then
    log "$label -> $(basename "$f") ($(du -h "$f" | cut -f1))"
  else
    fail "$label produced ${size} bytes — discarding"
    rm -f "$f"
  fi
}

mkdir -p "$BK"/{postgres,grafana,portainer,env}

# The timer is Persistent=true, so a schedule missed while the box was off
# fires at the next boot — exactly when postgres is still initialising. Without
# this wait the dump comes back empty and the backup silently reports success.
if running postgres; then
  ready=0
  for _ in $(seq 1 30); do
    if docker exec postgres pg_isready -q -U "${POSTGRES_USER:-dev}" 2>/dev/null; then ready=1; break; fi
    sleep 2
  done
  if [ "$ready" = 1 ]; then
    # pg_dumpall, NOT `pg_dump <named list>` — deliberately, and load-bearing
    # since 2026-08-12: Keycloak's data (users, realms, clients) now lives in a
    # `keycloak` database inside this same server, created by auth/compose.yml's
    # keycloak-db-init against the running instance. A named-database list would
    # not have grown a `keycloak` entry on its own, and the identity provider
    # for the whole box would have been silently unbacked-up. `pg_dumpall` picks
    # up any new database with no edit here. Verified: the dump contains
    # `CREATE DATABASE keycloak` and its 132 public tables (realm, client,
    # user_entity). Do not narrow this to a list.
    docker exec postgres pg_dumpall -U "${POSTGRES_USER:-dev}" 2>/dev/null | gzip > "$BK/postgres/pg-$ts.sql.gz"
    keep_if_real "$BK/postgres/pg-$ts.sql.gz" 1000 postgres
  else
    fail "postgres not ready after 60s — skipped"
  fi
else
  fail "postgres not running — skipped"
fi

# A redis step lived here until 2026-08-12: `redis-cli SAVE` then
# `docker cp redis:/data/dump.rdb`. Redis was retired that day (zero keys) and
# its volume deleted, so the step could only ever take the else branch and print
# "redis not running — skipped" — a FAIL, every night, for ever. That is the
# expensive kind of wrong: a warning that fires unconditionally is one nobody
# reads, and the next line of the report is the postgres dump that actually
# matters. It also made the script exit 1 nightly, so the timer's own success
# signal was useless too.
# (Its old artifacts under $BK/redis are left on disk untouched — all 88 bytes
# each, an empty RDB, which is what "zero keys" looks like. Nothing writes there
# now, so they are no longer rotated; delete them by hand whenever.)

if running grafana; then
  docker cp grafana:/var/lib/grafana/grafana.db "$BK/grafana/grafana-$ts.db" 2>/dev/null
  keep_if_real "$BK/grafana/grafana-$ts.db" 1000 grafana
else
  fail "grafana not running — skipped"
fi

if running portainer; then
  docker cp portainer:/data/portainer.db "$BK/portainer/portainer-$ts.db" 2>/dev/null
  keep_if_real "$BK/portainer/portainer-$ts.db" 1000 portainer
else
  fail "portainer not running — skipped"
fi

# .env is gitignored and exists nowhere else on earth. Losing it loses every
# credential on the box, so it belongs in the backup more than anything here.
if [ -f "$root/.env" ]; then
  install -m 600 "$root/.env" "$BK/env/env-$ts"
  keep_if_real "$BK/env/env-$ts" 1 env
else
  fail ".env not found at $root/.env"
fi

for d in postgres grafana portainer env; do
  ls -1t "$BK/$d"/* 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
done

if [ "$fails" -gt 0 ]; then
  log "done WITH $fails FAILURE(S). retained newest $KEEP per service under $BK"
  exit 1
fi
log "done. retained newest $KEEP per service under $BK"
