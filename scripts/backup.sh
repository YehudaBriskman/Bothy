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

mkdir -p "$BK"/{postgres,redis,grafana,portainer,env}

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
    docker exec postgres pg_dumpall -U "${POSTGRES_USER:-dev}" 2>/dev/null | gzip > "$BK/postgres/pg-$ts.sql.gz"
    keep_if_real "$BK/postgres/pg-$ts.sql.gz" 1000 postgres
  else
    fail "postgres not ready after 60s — skipped"
  fi
else
  fail "postgres not running — skipped"
fi

if running redis; then
  docker exec redis redis-cli SAVE >/dev/null 2>&1 \
    && docker cp redis:/data/dump.rdb "$BK/redis/dump-$ts.rdb" 2>/dev/null
  keep_if_real "$BK/redis/dump-$ts.rdb" 1 redis
else
  fail "redis not running — skipped"
fi

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

for d in postgres redis grafana portainer env; do
  ls -1t "$BK/$d"/* 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
done

if [ "$fails" -gt 0 ]; then
  log "done WITH $fails FAILURE(S). retained newest $KEEP per service under $BK"
  exit 1
fi
log "done. retained newest $KEEP per service under $BK"
