#!/usr/bin/env bash
# Back up the dev stacks' stateful bits with simple rotation.
set -euo pipefail
BK="${1:-/home/devssh/backups}"
KEEP=14
ts=$(date +%Y%m%d-%H%M%S)
log() { printf '[backup %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
running() { docker ps --format '{{.Names}}' | grep -qx "$1"; }

mkdir -p "$BK"/{postgres,redis,grafana,portainer}

# Postgres — logical dump of all databases (consistent).
if running postgres; then
  docker exec postgres pg_dumpall -U "${POSTGRES_USER:-dev}" | gzip > "$BK/postgres/pg-$ts.sql.gz"
  log "postgres -> pg-$ts.sql.gz ($(du -h "$BK/postgres/pg-$ts.sql.gz" | cut -f1))"
fi

# Redis — force a save, then copy the rdb snapshot.
if running redis; then
  docker exec redis redis-cli SAVE >/dev/null
  docker cp redis:/data/dump.rdb "$BK/redis/dump-$ts.rdb"
  log "redis -> dump-$ts.rdb"
fi

# Grafana — sqlite holds dashboards, users, alert rules.
if running grafana; then
  docker cp grafana:/var/lib/grafana/grafana.db "$BK/grafana/grafana-$ts.db"
  log "grafana -> grafana-$ts.db"
fi

# Portainer — boltdb holds users, endpoints, settings.
if running portainer; then
  docker cp portainer:/data/portainer.db "$BK/portainer/portainer-$ts.db" 2>/dev/null || true
  log "portainer -> portainer-$ts.db"
fi

# Rotation — keep only the newest $KEEP files per service.
for d in postgres redis grafana portainer; do
  ls -1t "$BK/$d"/* 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
done
log "done. retained newest $KEEP per service under $BK"
