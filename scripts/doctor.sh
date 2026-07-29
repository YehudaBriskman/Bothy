#!/usr/bin/env bash
# One-glance health check of the whole dev environment.
set -uo pipefail
green() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
red()   { printf '  \033[31m✗\033[0m %s\n' "$*"; }

echo "== containers =="
# traefik, oauth2-proxy and portal-socket-proxy are the front door and the login
# for everything else, and were missing from this list entirely.
#
# `wiki` was retired and replaced by the mkdocs stack in apps/docs (`docs` serves
# the site, `docs-sync` rsyncs ~/claude-notes into it) - it sat here reporting a
# permanent red ✗ that had to be explained away every single sweep, which is how
# a health check teaches you to ignore it. `portal-next` is the LIVE portal;
# `portal` is the retired nginx one, kept only because its compose file also owns
# portal-socket-proxy. Both run, so both are expected.
expected="traefik oauth2-proxy portal-socket-proxy prometheus grafana loki promtail cadvisor node-exporter postgres postgres-exporter redis redis-exporter kafka kafka-ui kafka-exporter portainer dozzle docs docs-sync portal portal-next"
for c in $expected; do
  st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
  [ "$st" = running ] && green "$c" || red "$c ($st)"
done

echo "== prometheus targets =="
# Without this guard a missing jq piped its failure into a loop that never
# iterated, so an absent dependency read exactly like a clean bill of health.
if ! command -v jq >/dev/null 2>&1; then
  red "jq is not installed - cannot read prometheus targets"
else
  targets=$(curl -s --max-time 5 'http://localhost:9090/api/v1/targets?state=active' 2>/dev/null \
    | jq -r '.data.activeTargets[] | "\(.labels.job) \(.health)"' 2>/dev/null | sort -u)
  if [ -z "$targets" ]; then
    red "prometheus returned no targets - is it up?"
  else
    echo "$targets" | while read -r j h; do
      [ "$h" = up ] && green "$j" || red "$j ($h)"
    done
  fi
fi

echo "== kubernetes =="
# The old form attached || to a while loop, whose exit status is zero even when
# kubectl fails, so an unreachable cluster could never actually be reported.
if ! command -v kubectl >/dev/null 2>&1; then
  red "kubectl is not installed"
else
  nodes=$(kubectl get nodes --no-headers 2>/dev/null || true)
  if [ -z "$nodes" ]; then
    red "minikube unreachable"
  else
    echo "$nodes" | awk '{print $1, $2}' | while read -r n st; do
      [ "$st" = Ready ] && green "node $n" || red "node $n ($st)"
    done
  fi
fi

echo "== disk / memory =="
df -h / | awk 'NR==2{printf "  / used %s (%s free)\n", $5, $4}'
free -h | awk '/Mem:/{printf "  mem used %s / %s\n", $3, $2}'

echo "== backups =="
# Existence alone is not health. Six days of 20-byte empty dumps passed the old
# check unnoticed, because a failed pg_dumpall still leaves behind a perfectly
# valid gzip of nothing. Age and size are what separate a backup from a file
# that is merely named like one.
latest=$(ls -1t /home/devssh/backups/postgres/*.sql.gz 2>/dev/null | head -1)
if [ -z "$latest" ]; then
  red "no postgres backups yet"
else
  size=$(wc -c < "$latest")
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$latest") ) / 3600 ))
  if [ "$size" -lt 1000 ]; then
    red "latest pg dump is ${size}B - almost certainly empty: $(basename "$latest")"
  elif [ "$age_h" -gt 48 ]; then
    red "latest pg dump is ${age_h}h old: $(basename "$latest")"
  else
    green "latest pg dump: $(basename "$latest") (${size}B, ${age_h}h old)"
  fi
fi
