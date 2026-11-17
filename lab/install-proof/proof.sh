#!/usr/bin/env bash
# proof.sh - runs INSIDE a lab guest after fake-release.sh. The whole `bothy install`
# lifecycle with assertions; exits non-zero at the first broken one.
#   proof.sh <release-dir>
set -uo pipefail
# shellcheck disable=SC2015  # `ok` cannot fail, so `A && ok || fail` is an if-then-else here
rel="${1:?release dir}"; B="$HOME/.local/bin/bothy"; R=(--manifest "$rel/release-manifest.json" --checksums "$rel/checksums.txt")
D="$HOME/.local/share/bothy"; C="$HOME/.config/bothy"
n=0; fail() { echo "FAIL: $*"; exit 1; }; ok() { n=$((n+1)); echo "ok $n: $*"; }
now() { date +%s.%N; }
sha() { sha256sum | cut -d' ' -f1; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", b-a}'; }

{ [ ! -e "$D" ] && [ ! -e "$C" ]; } || fail "guest is not clean"
"$B" install --dry-run --bind 0.0.0.0 "${R[@]}" >/tmp/dry.txt || fail "dry-run rc"
if grep -q "dry run: nothing was changed" /tmp/dry.txt && [ ! -e "$D" ] && [ ! -e "$C" ]; then ok "dry run printed the plan and created nothing"; else fail "dry run"; fi

t0=$(now); "$B" install --bind 0.0.0.0 "${R[@]}" >/tmp/i1.txt 2>&1 || { cat /tmp/i1.txt; fail "install rc"; }
t1=$(now); echo "install took $(secs "$t0" "$t1")s"
if grep -q "byte-identical" /tmp/i1.txt && grep -q "Bivvy is up" /tmp/i1.txt; then ok "install ran and verified bytes"; else fail "install output"; fi
served=$(curl -fsS http://127.0.0.1/ | sha); inside=$(docker exec bothy-bothy-web-1 cat /usr/share/nginx/html/index.html | sha)
[ "$served" = "$inside" ] && ok "served / sha256 ${served:0:16}... equals the file inside the container" || fail "bytes differ"
rev=$(curl -fsS http://127.0.0.1/version.json); commit=$(grep -o '"commit":"[0-9a-f]*"' "$rel/release-manifest.json" | cut -d'"' -f4)
[[ $rev == *"$commit"* ]] && ok "/version.json = $rev" || fail "version.json $rev"
{ [ "$(stat -c %a "$C/secrets/master.key")" = 600 ] && [ "$(stat -c %a "$C/secrets")" = 700 ]; } && ok "secret modes 0600 / 0700" || fail "modes"
key1=$(cat "$C/secrets/master.key")
docker stats --no-stream --format "mem {{.Name}} {{.MemUsage}}" bothy-traefik-1 bothy-bothy-web-1

t0=$(now); "$B" install --bind 0.0.0.0 "${R[@]}" >/tmp/i2.txt 2>&1 || fail "re-run rc"; t1=$(now)
if grep -q "nothing to do" /tmp/i2.txt && ! grep -q '^-> ' /tmp/i2.txt; then ok "re-run is a no-op ($(secs "$t0" "$t1")s)"; else cat /tmp/i2.txt; fail "re-run changed things"; fi
[ "$key1" = "$(cat "$C/secrets/master.key")" ] && ok "re-run kept the master key" || fail "key rotated"

"$B" uninstall >/tmp/u1.txt 2>&1 || fail "uninstall rc"
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=bothy)" ] && ok "uninstall removed the containers" || fail "containers remain"
[ -z "$(docker network ls -q --filter name=bothy-devnet)" ] && ok "uninstall removed the network" || fail "network remains"
{ [ -f "$C/secrets/master.key" ] && [ ! -e "$D/receipt.json" ] && [ ! -e "$D/stack/compose.yml" ]; } && ok "uninstall kept the secret, removed the receipt and generated files" || fail "uninstall state"

"$B" install --bind 0.0.0.0 "${R[@]}" >/tmp/i3.txt 2>&1 || { cat /tmp/i3.txt; fail "reinstall rc"; }
{ grep -q "skip  secrets" /tmp/i3.txt && [ "$key1" = "$(cat "$C/secrets/master.key")" ]; } && ok "reinstall after uninstall reused the secret" || fail "reinstall"

if echo yes | "$B" uninstall --purge >/dev/null 2>&1; then fail "purge accepted a wrong phrase"; fi
{ [ -f "$D/receipt.json" ] && [ -f "$C/secrets/master.key" ]; } && ok "a wrong confirmation deleted nothing" || fail "wrong phrase deleted data"
echo "delete bothy data" | "$B" uninstall --purge >/tmp/p.txt 2>&1 || fail "purge rc"
{ [ ! -e "$D" ] && [ ! -e "$C" ]; } && ok "typed purge removed data and secrets" || fail "purge left data"
[ -z "$(docker images -q traefik)" ] && ok "purge removed the pulled images" || fail "images remain"
echo "PROOF PASSED ($n checks)"
