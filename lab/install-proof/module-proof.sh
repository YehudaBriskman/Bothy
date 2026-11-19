#!/usr/bin/env bash
# module-proof.sh - runs INSIDE a lab guest after fake-release.sh and fake-node.sh. The
# `bothy module` lifecycle with assertions; exits non-zero at the first broken one.
#   module-proof.sh <releases-dir>
# Expects ~/bin/bothy-<version> for 2026.11.0, .1 and .4.
# shellcheck disable=SC2015,SC2046,SC2012,SC2013,SC2086
set -uo pipefail
rel="${1:?releases dir}"
D="$HOME/.local/share/bothy"; C="$HOME/.config/bothy"; S="$D/stack"
n=0; fail() { echo "FAIL: $*"; exit 1; }; ok() { n=$((n+1)); echo "ok $n: $*"; }
sha() { sha256sum | cut -d' ' -f1; }
bin() { echo "$HOME/bin/bothy-$1"; }
R() { echo "--manifest $rel/$1/release-manifest.json --checksums $rel/$1/checksums.txt"; }
A=2026.11.0; B=2026.11.1; SICK=2026.11.4
node=bothy-node-exporter-1
metrics() { curl -fsS http://127.0.0.1/-/api/node/metrics; }
# Never pipe curl into `grep -q` here: grep exits at the first match, curl gets EPIPE on the
# rest of a 61 KB body (exit 23) and pipefail fails the check at random (2026-11-19: "module
# lost in update" with the module up and serving). Buffer to a file, then grep the file.
fetch_has() { curl -fsS "$1" >/tmp/fetch.txt 2>/dev/null && grep -q -- "$2" /tmp/fetch.txt; }
has_metrics() { fetch_has http://127.0.0.1/-/api/node/metrics node_memory_MemAvailable_bytes; }
n_containers() { docker ps -q --filter label=com.docker.compose.project=bothy | wc -l; }
portal_eq() { [ "$(curl -fsS http://127.0.0.1/ | sha)" = "$(docker exec bothy-bothy-web-1 cat /usr/share/nginx/html/index.html | sha)" ]; }
{ [ ! -e "$D" ] && [ ! -e "$C" ]; } || fail "guest is not clean"

"$(bin $A)" install --bind 0.0.0.0 $(R $A) >/tmp/i1.txt 2>&1 || { cat /tmp/i1.txt; fail "install rc"; }
grep -q "Bivvy is up" /tmp/i1.txt && ok "base install up (3 containers: $(n_containers))" || fail "install"
code=$(curl -s -o /tmp/m0.txt -w '%{http_code}' http://127.0.0.1/-/api/node/metrics)
grep -q node_memory_MemAvailable_bytes /tmp/m0.txt && fail "metrics served before the module was added"
ok "before add: /-/api/node/metrics does not carry metrics (edge answered $code with the portal catch-all)"

# list, dry run
"$(bin $A)" module list --local >/tmp/l0.txt 2>&1 || fail "list rc"; cat /tmp/l0.txt
grep -q "node-metrics.*available" /tmp/l0.txt && grep -q "files.*installed" /tmp/l0.txt && ok "list: node-metrics available, files installed, costs shown" || fail "list output"
cp "$S/.env" /tmp/env.0; cp "$S/compose.yml" /tmp/compose.0; cp "$D/receipt.json" /tmp/receipt.0
"$(bin $A)" module add node-metrics --dry-run $(R $A) >/tmp/d.txt 2>&1 || { cat /tmp/d.txt; fail "dry run rc"; }
{ grep -q "dry run: nothing was changed" /tmp/d.txt && cmp -s /tmp/env.0 "$S/.env" && cmp -s /tmp/receipt.0 "$D/receipt.json" && [ ! -e "$D/previous" ] && [ "$(n_containers)" = 3 ]; } && ok "module add --dry-run printed the plan and changed nothing" || fail "dry run changed something"

# the memory gate (MemAvailable is real in the guest: ask for the impossible by a tiny reserve override is not offered, so show the numbers)
grep -q "MiB available" /tmp/d.txt && ok "memory line with numbers: $(grep -m1 'MiB available' /tmp/d.txt | sed 's/^ *//')" || fail "no memory numbers"

# add
"$(bin $A)" module add node-metrics $(R $A) >/tmp/a1.txt 2>&1 || { cat /tmp/a1.txt; fail "add rc"; }
sed -n '/^-> /,$p' /tmp/a1.txt | cut -c1-200
[ "$(n_containers)" = 4 ] && ok "add: four containers running" || fail "containers: $(docker ps --format '{{.Names}}')"
metrics >/tmp/m1.txt && grep -q node_memory_MemAvailable_bytes /tmp/m1.txt && ok "add: /-/api/node/metrics served node_memory_MemAvailable_bytes through the edge (bytes, not a status)" || fail "metrics bytes"
[ -z "$(docker inspect $node --format '{{.HostConfig.Binds}}' | tr -d '[]')" ] && ok "node-exporter has no host mounts (no / bind, no textfile)" || fail "binds: $(docker inspect $node --format '{{.HostConfig.Binds}}')"
mem=$(docker inspect $node --format '{{.HostConfig.Memory}}'); [ "$mem" = 67108864 ] && ok "node-exporter memory limit is 64 MiB" || fail "memory limit $mem"
ss -H -ltn | awk '{print $4}' | grep -qE '[:.]9100$' && fail "host listens on 9100" || ok "no new host port (9100 is not published)"
grep -q '"node-metrics"' "$D/receipt.json" && grep -q '"status": "complete"' "$D/receipt.json" && ok "receipt records the module set (complete, node-metrics present)" || fail "receipt: $(cat $D/receipt.json)"
portal_eq && ok "portal bytes unchanged by the add" || fail "portal bytes"
cmp -s /tmp/compose.0 "$D/previous/stack/compose.yml" && ok "the rollback point is the previous generation's compose.yml" || fail "previous/ is not the old generation"

# idempotent re-run
t=$(docker inspect $node --format '{{.State.StartedAt}}')
"$(bin $A)" module add node-metrics $(R $A) >/tmp/a2.txt 2>&1 || fail "re-run rc"
{ grep -q "nothing to do" /tmp/a2.txt && [ "$(docker inspect $node --format '{{.State.StartedAt}}')" = "$t" ]; } && ok "re-run of add is a no-op (container not restarted)" || { cat /tmp/a2.txt; fail "re-run"; }

# refusals
"$(bin $A)" module remove edge >/tmp/r1.txt 2>&1 && fail "removing a core module succeeded"
grep -q "core module" /tmp/r1.txt && ok "remove edge refused: $(head -c 120 /tmp/r1.txt | tr '\n' ' ')" || fail "core refusal text: $(cat /tmp/r1.txt)"
"$(bin $A)" module add nope >/tmp/r2.txt 2>&1 && fail "unknown module accepted"; ok "unknown module refused: $(head -c 100 /tmp/r2.txt | tr '\n' ' ')"

# update after a module: the module survives, its image follows the release
"$(bin $B)" update $(R $B) >/tmp/u1.txt 2>&1 || { cat /tmp/u1.txt; fail "update rc"; }
grep -q "updated: release $A -> $B" /tmp/u1.txt && ok "update $A -> $B reported success with the module installed" || fail "update output"
[ "$(n_containers)" = 4 ] && has_metrics && ok "after update: node-metrics still installed and serving" || fail "module lost in update: $(docker ps --format '{{.Names}}' | tr '\n' ' '); body: $(head -c 200 /tmp/fetch.txt 2>/dev/null)"
grep -q '"node-metrics"' "$D/receipt.json" && ok "after update: receipt still lists node-metrics" || fail "receipt lost the module"
fetch_has http://127.0.0.1/ 'release 2026.11.1' && portal_eq && ok "after update: portal bytes are release $B's" || fail "portal after update"

# remove
"$(bin $B)" module remove node-metrics $(R $B) >/tmp/rm.txt 2>&1 || { cat /tmp/rm.txt; fail "remove rc"; }
sed -n '/^-> /,$p' /tmp/rm.txt | cut -c1-200
{ [ "$(n_containers)" = 3 ] && [ -z "$(docker ps -aq --filter name=node-exporter)" ]; } && ok "remove: node-exporter container is gone, three remain" || fail "containers after remove: $(docker ps -a --format '{{.Names}}')"
{ curl -s http://127.0.0.1/-/api/node/metrics >/tmp/fetch.txt; grep -q node_memory_MemAvailable_bytes /tmp/fetch.txt; } && fail "route still serves metrics" || ok "remove: the route no longer serves metrics"
grep -q '"node-metrics"' "$D/receipt.json" && fail "receipt still lists the module" || ok "remove: receipt no longer lists node-metrics"
portal_eq && ok "portal bytes intact after remove" || fail "portal bytes after remove"
"$(bin $B)" module remove node-metrics >/tmp/rm2.txt 2>&1 && grep -q "nothing to do" /tmp/rm2.txt && ok "second remove is a no-op" || fail "second remove"

# uninstall, then the forced failure on a release whose node-exporter is sick
"$(bin $B)" uninstall >/dev/null 2>&1 || fail "uninstall rc"
"$(bin $SICK)" install --bind 0.0.0.0 $(R $SICK) >/tmp/i2.txt 2>&1 || { cat /tmp/i2.txt; fail "install of the sick release rc"; }
cp "$S/.env" /tmp/env.s; cp "$S/compose.yml" /tmp/compose.s
"$(bin $SICK)" module add node-metrics --wait-timeout 25 $(R $SICK) >/tmp/f.txt 2>&1 && fail "add of a sick module succeeded"
sed -n '/^-> /,$p' /tmp/f.txt | cut -c1-220
grep -q "rolled back" /tmp/f.txt && ok "forced failure: add reported a rollback" || fail "no rollback line"
{ cmp -s /tmp/env.s "$S/.env" && cmp -s /tmp/compose.s "$S/compose.yml"; } && ok "forced failure: the previous .env and compose.yml are restored byte for byte" || fail "files differ after rollback"
{ [ "$(n_containers)" = 3 ] && [ -z "$(docker ps -aq --filter name=node-exporter)" ]; } && ok "forced failure: the sick container is gone, the three originals run" || fail "containers: $(docker ps -a --format '{{.Names}} {{.Status}}')"
portal_eq && ok "forced failure: portal bytes intact after rollback" || fail "portal bytes"
grep -q '"status": "complete"' "$D/receipt.json" && grep -q last_module_error "$D/receipt.json" && ! grep -q '"pending"' "$D/receipt.json" && ok "receipt: complete, no pending op, last_module_error recorded" || fail "receipt after rollback: $(cat $D/receipt.json)"

# a kill mid-change, then resume
( "$(bin $SICK)" module add node-metrics --wait-timeout 60 $(R $SICK) >/dev/null 2>&1 & p=$!; sleep 6; kill -9 $p 2>/dev/null; wait $p 2>/dev/null ) || true
if grep -q '"pending"' "$D/receipt.json"; then
  ok "kill -9 during add left a pending op in the receipt"
  "$(bin $SICK)" update $(R $SICK) >/tmp/k1.txt 2>&1 && fail "update ran over a pending module change"
  grep -q "module change did not finish" /tmp/k1.txt && ok "update refuses while a module change is pending and says what to do" || fail "pending refusal: $(cat /tmp/k1.txt)"
  "$(bin $SICK)" module rollback $(R $SICK) >/tmp/k2.txt 2>&1 || { cat /tmp/k2.txt; fail "module rollback rc"; }
  { cmp -s /tmp/compose.s "$S/compose.yml" && ! grep -q '"pending"' "$D/receipt.json" && [ "$(n_containers)" = 3 ]; } && ok "module rollback returned to the previous generation (compose byte-identical, 3 containers)" || fail "after module rollback"
else
  echo "NOTE: the kill landed after the change had already settled (receipt has no pending op); resume not exercised in the lab (the Go tests cover it)"
fi
"$(bin $SICK)" uninstall >/dev/null 2>&1 || true
echo "MODULE PROOF PASSED ($n checks)"
