#!/usr/bin/env bash
# One-glance health check of the whole dev environment.
set -uo pipefail
green() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
red()   { printf '  \033[31m✗\033[0m %s\n' "$*"; }

echo "== containers =="
expected="prometheus grafana loki promtail cadvisor node-exporter postgres postgres-exporter redis redis-exporter kafka kafka-ui kafka-exporter portainer dozzle wiki"
for c in $expected; do
  st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
  [ "$st" = running ] && green "$c" || red "$c ($st)"
done

echo "== prometheus targets =="
curl -s 'http://localhost:9090/api/v1/targets?state=active' 2>/dev/null \
  | jq -r '.data.activeTargets[] | "\(.labels.job) \(.health)"' 2>/dev/null | sort -u \
  | while read -r j h; do [ "$h" = up ] && green "$j" || red "$j ($h)"; done

echo "== kubernetes =="
kubectl get nodes --no-headers 2>/dev/null | awk '{print $1, $2}' \
  | while read -r n s; do [ "$s" = Ready ] && green "node $n" || red "node $n ($s)"; done \
  || red "minikube unreachable"

echo "== disk / memory =="
df -h / | awk 'NR==2{printf "  / used %s (%s free)\n", $5, $4}'
free -h | awk '/Mem:/{printf "  mem used %s / %s\n", $3, $2}'

echo "== backups =="
latest=$(ls -1t /home/devssh/backups/postgres/*.sql.gz 2>/dev/null | head -1)
[ -n "$latest" ] && green "latest pg dump: $(basename "$latest")" || red "no postgres backups yet"
