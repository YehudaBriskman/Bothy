#!/usr/bin/env bash
# proof.sh - runs INSIDE a lab guest after fake-release.sh. The whole `bothy install`
# / `bothy update` / `bothy uninstall` lifecycle with assertions; exits non-zero at the
# first broken one.   proof.sh <releases-dir>
#
# Expects  ~/bin/bothy-<version>  for 2026.11.0 .. 2026.11.3 (the same source, stamped
# with each version: a release's stack travels inside its binary) and
# <releases-dir>/<version>/{release-manifest.json,checksums.txt} from fake-release.sh.
# shellcheck disable=SC2015,SC2046,SC2012,SC2013  # `ok` cannot fail (A && ok || fail is if-then-else); R() output is meant to word-split
set -uo pipefail
rel="${1:?releases dir}"
D="$HOME/.local/share/bothy"; C="$HOME/.config/bothy"; S="$D/stack"
n=0; fail() { echo "FAIL: $*"; exit 1; }; ok() { n=$((n+1)); echo "ok $n: $*"; }
now() { date +%s.%N; }
sha() { sha256sum | cut -d' ' -f1; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", b-a}'; }
bin() { echo "$HOME/bin/bothy-$1"; }
R() { echo "--manifest $rel/$1/release-manifest.json --checksums $rel/$1/checksums.txt"; }
commit_of() { grep -o '"commit":"[0-9a-f]*"' "$rel/$1/release-manifest.json" | cut -d'"' -f4; }
web=bothy-bothy-web-1; files=bothy-bothy-files-1; edge=bothy-traefik-1
rev() { curl -fsS http://127.0.0.1/version.json; }
# a status code proves nothing (the catch-all answers 200 to anything): compare bytes
served_eq_inside() { [ "$(curl -fsS http://127.0.0.1/ | sha)" = "$(docker exec $web cat /usr/share/nginx/html/index.html | sha)" ]; }

{ [ ! -e "$D" ] && [ ! -e "$C" ]; } || fail "guest is not clean"
A=2026.11.0; B=2026.11.1; BAD=2026.11.2; SICK=2026.11.3
ca=$(commit_of $A); cb=$(commit_of $B)

# ---------------------------------------------------------------- install A
"$(bin $A)" install --dry-run --bind 0.0.0.0 $(R $A) >/tmp/dry.txt || fail "dry-run rc"
if grep -q "dry run: nothing was changed" /tmp/dry.txt && [ ! -e "$D" ] && [ ! -e "$C" ]; then ok "dry run printed the plan and created nothing"; else fail "dry run"; fi
grep -q "960 MiB needed" /tmp/dry.txt && ok "RAM gate counts the files module: 960 MiB needed (128+64+256+512 reserve)" || fail "RAM gate line: $(grep memory /tmp/dry.txt)"

t0=$(now); "$(bin $A)" install --bind 0.0.0.0 $(R $A) >/tmp/i1.txt 2>&1 || { cat /tmp/i1.txt; fail "install rc"; }
t1=$(now); echo "install took $(secs "$t0" "$t1")s"
if grep -q "byte-identical" /tmp/i1.txt && grep -q "Bivvy is up" /tmp/i1.txt; then ok "install ran and verified bytes"; else cat /tmp/i1.txt; fail "install output"; fi
grep -q "attestation: SKIPPED" /tmp/i1.txt && ok "install said the attestation check was skipped (local source), never claimed it" || fail "attestation line"
served_eq_inside && ok "portal: served / is byte-identical to index.html inside the container" || fail "portal bytes differ"
[[ $(rev) == *"$ca"* ]] && ok "/version.json = $(rev)" || fail "version.json $(rev)"
key1=$(cat "$C/secrets/master.key")
{ [ "$(stat -c %a "$C/secrets/master.key")" = 600 ] && [ "$(stat -c %a "$C/secrets")" = 700 ]; } && ok "secret modes 0600 / 0700" || fail "modes"

# files module: bytes, and what it must NOT do
printf 'hello from the notes root\nline two\n' > "$S/bothy-files/notes/hello.md"
printf 'TOKEN=should-be-labelled-sensitive\n' > "$S/bothy-files/notes/.env"
sleep 1
roots=$(curl -fsS http://127.0.0.1/-/api/files/roots); echo "roots: $roots"
{ [[ $roots == *'"notes"'* ]] && [[ $roots != *'"stacks"'* ]] && [[ $roots != *'"home"'* ]] && [[ $roots == *'"readOnly": true'* || $roots == *'"readOnly":true'* ]]; } && ok "files: exactly one root, notes, read-only" || fail "roots: $roots"
got=$(curl -fsS "http://127.0.0.1/-/api/files/read?root=notes&path=hello.md")
[[ $got == *"hello from the notes root"* ]] && [[ $got == *"line two"* ]] && ok "files: /read returned the file's bytes through the edge" || fail "files read: $got"
env_got=$(curl -sS "http://127.0.0.1/-/api/files/read?root=notes&path=.env")
[[ $env_got != *"should-be-labelled-sensitive"* || $env_got == *sensitive* ]] && ok "files: a .env in the root is labelled sensitive (policy copied from the shipped one): $(echo "$env_got" | cut -c1-90)" || fail "env read"
before=$(ls -A "$S/bothy-files/notes" | sort | tr '\n' ' ')
code=$(curl -s -o /tmp/w.out -w '%{http_code}' -X POST "http://127.0.0.1/-/api/files/write" -H 'content-type: application/json' -d '{"root":"notes","path":"pwn.md","content":"x"}')
after=$(ls -A "$S/bothy-files/notes" | sort | tr '\n' ' ')
{ [ "$before" = "$after" ] && [ ! -e "$S/bothy-files/notes/pwn.md" ]; } && ok "files: POST /write created nothing (edge answered $code with the catch-all: $(head -c 20 /tmp/w.out | tr -d '\n'))" || fail "write created a file"
grep -qi 'not allowed' /tmp/w.out && ok "files: /write is not routed (the portal catch-all answered, not the files service)" || fail "write answer: $(head -c 80 /tmp/w.out)"
docker exec $files sh -c 'touch /repos/notes/x' 2>/dev/null && fail "the notes mount is writable inside the container" || ok "files: the notes mount is read-only inside the container (kernel refuses)"
head -c 15 <(curl -s "http://127.0.0.1/-/api/files/raw?root=notes&path=hello.md") | grep -qi '<!doctype html' && ok "files: /raw (sandbox origin) is not served on :80" || fail "raw served on :80"

# the edge: no docker socket, only the expected ports, internal entrypoint unreachable
mounts=$(docker inspect $edge --format '{{json .Mounts}} {{json .HostConfig.Binds}}')
echo "traefik mounts: $mounts"
[[ $mounts != *docker.sock* ]] && ok "edge: docker inspect shows NO docker.sock mount on traefik" || fail "docker.sock mounted: $mounts"
cmd=$(docker inspect $edge --format '{{json .Config.Cmd}}')
[[ $cmd != *providers.docker* ]] && [[ $cmd == *providers.file.directory* ]] && [[ $cmd != *api.dashboard* ]] && [[ $cmd == *'--api=true'* ]] && ok "edge: file provider only, API on, dashboard off" || fail "traefik cmd $cmd"
for c in $web $files $edge; do docker inspect "$c" --format '{{.HostConfig.Binds}}' | grep -q docker.sock && fail "$c mounts the docker socket"; done; ok "no container in the project mounts docker.sock"
ports=$(docker ps --format '{{.Names}} {{.Ports}}' | grep '^bothy-'); echo "$ports"
published=$(docker ps --filter label=com.docker.compose.project=bothy --format '{{.Ports}}' | tr ',' '\n' | grep -c -- '->' || true)
[ "$published" -le 1 ] && echo "$ports" | grep -q '0.0.0.0:80->80/tcp' && ok "docker publishes exactly one port: 0.0.0.0:80->80 (traefik)" || fail "published ports: $ports"
listen=$(ss -H -ltn | awk '{print $4}' | sort -u | tr '\n' ' '); echo "listening: $listen"
for p in 8100 8899 8099 8080; do ss -H -ltn | awk '{print $4}' | grep -qE "[:.]$p$" && fail "host listens on $p"; done
ss -H -ltn | awk '{print $4}' | grep -qE '^(0\.0\.0\.0|\*|\[::\]):80$' && ok "ss: host listens on :80 only among ours (no 8100, 8899, 8099, 8080)" || fail "ss: no :80 listener"
docker exec $edge wget -qO- -T3 http://127.0.0.1:8899/ping >/dev/null 2>&1 && ok "edge: the metrics/ping entrypoint answers on loopback INSIDE traefik" || fail "traefik ping on loopback"
docker exec $web wget -qO- -T3 http://traefik:8899/ping >/dev/null 2>&1 && fail "traefik:8899 reachable from another container" || ok "edge: another container on the network cannot reach traefik:8899 (loopback-bound)"
docker logs $edge 2>&1 | grep -iE 'level=(error|fatal)|cannot|unable' >/tmp/edge-errs.txt; [ ! -s /tmp/edge-errs.txt ] && ok "edge: no errors in traefik's log" || { cat /tmp/edge-errs.txt; fail "traefik logged errors"; }
echo "--- memory after install"; docker stats --no-stream --format "mem {{.Name}} {{.MemUsage}}" $edge $web $files; free -m | sed -n 1,2p

# re-run is a no-op
t0=$(now); "$(bin $A)" install --bind 0.0.0.0 $(R $A) >/tmp/i2.txt 2>&1 || fail "re-run rc"; t1=$(now)
if grep -q "nothing to do" /tmp/i2.txt && ! grep -q '^-> ' /tmp/i2.txt; then ok "re-run is a no-op ($(secs "$t0" "$t1")s)"; else cat /tmp/i2.txt; fail "re-run changed things"; fi
[ "$key1" = "$(cat "$C/secrets/master.key")" ] && ok "re-run kept the master key" || fail "key rotated"

# ---------------------------------------------------------------- update A -> B
cp "$S/.env" /tmp/env.A; cp "$D/receipt.json" /tmp/receipt.A
fstart=$(docker inspect $files --format '{{.State.StartedAt}}'); idA=$(docker inspect $web --format '{{.Id}}')
"$(bin $B)" update --check $(R $B) >/tmp/uc.txt 2>&1 || { cat /tmp/uc.txt; fail "update --check rc"; }
cat /tmp/uc.txt | sed -n '/what changes/,$p'
{ grep -q "Nothing was changed" /tmp/uc.txt && grep -q "BOTHY_IMAGE_BOTHY_WEB" /tmp/uc.txt && grep -q "BOTHY_IMAGE_BOTHY_FILES.*unchanged" /tmp/uc.txt \
  && cmp -s /tmp/env.A "$S/.env" && cmp -s /tmp/receipt.A "$D/receipt.json" && [ ! -e "$D/previous" ] && [ "$(docker inspect $web --format '{{.Id}}')" = "$idA" ]; } && ok "update --check printed the change (web changes, files unchanged) and changed nothing" || fail "update --check"
t0=$(now); "$(bin $B)" update $(R $B) >/tmp/u1.txt 2>&1 || { cat /tmp/u1.txt; fail "update rc"; }; t1=$(now)
echo "update A->B took $(secs "$t0" "$t1")s"; sed -n '/^-> /,$p' /tmp/u1.txt
grep -q "updated: release $A -> $B" /tmp/u1.txt && ok "update A -> B reported success" || fail "update output"
[[ $(rev) == *"$cb"* ]] && ok "bytes: /version.json now = $(rev)" || fail "version.json after update: $(rev)"
curl -fsS http://127.0.0.1/ | grep -q 'release 2026.11.1' && served_eq_inside && ok "bytes: served / carries the new release marker and equals the new container's index.html" || fail "index after update"
[ "$(docker inspect $files --format '{{.State.StartedAt}}')" = "$fstart" ] && ok "files container was NOT restarted (its digest did not change)" || fail "files restarted"
grep -q "\"version\": \"$B\"" "$D/receipt.json" && grep -q "\"previous\"" "$D/receipt.json" && grep -q "\"version\": \"$A\"" "$D/receipt.json" && ok "receipt: version $B, previous $A recorded" || fail "receipt"
curl -fsS "http://127.0.0.1/-/api/files/read?root=notes&path=hello.md" | grep -q "hello from the notes root" && ok "files still serve the notes after the update (bytes)" || fail "files after update"
cp "$S/.env" /tmp/env.B; cp "$D/receipt.json" /tmp/receipt.B
if "$(bin $A)" update $(R $A) >/tmp/ud.txt 2>&1; then fail "downgrade accepted"; fi
grep -q "refusing a downgrade" /tmp/ud.txt && cmp -s /tmp/env.B "$S/.env" && ok "downgrade refused, nothing changed" || fail "downgrade output"

# ---------------------------------------------------------------- forced failures: roll back
expect_rolled_back() { # label  binary-version  extra-args
  local label="$1" v="$2"; shift 2
  t0=$(now); "$(bin "$v")" update $(R "$v") "$@" >/tmp/uf.txt 2>&1 && fail "$label: update unexpectedly succeeded"; t1=$(now)
  echo "--- $label ($(secs "$t0" "$t1")s)"; sed -n '/^-> /,$p' /tmp/uf.txt | cut -c1-260
  grep -q "rolled back" /tmp/uf.txt || fail "$label: no rollback line"
  [[ $(rev) == *"$cb"* ]] && ok "$label: after rollback /version.json = $(rev) (release $B)" || fail "$label: version.json $(rev)"
  curl -fsS http://127.0.0.1/ | grep -q 'release 2026.11.1' && served_eq_inside && ok "$label: after rollback the served bytes are release $B's" || fail "$label: index bytes"
  cmp -s /tmp/env.B "$S/.env" && ok "$label: the previous .env (digests) was restored byte for byte" || fail "$label: .env differs"
  grep -q "\"version\": \"$B\"" "$D/receipt.json" && grep -q '"status": "complete"' "$D/receipt.json" && grep -q last_update_error "$D/receipt.json" && ok "$label: receipt is $B, complete, with last_update_error recorded" || fail "$label: receipt"
  [ "$(docker ps -q --filter label=com.docker.compose.project=bothy | wc -l)" = 3 ] && ok "$label: all three containers running" || fail "$label: containers"
  curl -fsS "http://127.0.0.1/-/api/files/read?root=notes&path=hello.md" | grep -q "hello from the notes root" && ok "$label: files still serve" || fail "$label: files"
}
expect_rolled_back "forced failure 1 (digest the registry does not have)" $BAD
expect_rolled_back "forced failure 2 (container never becomes healthy, --wait-timeout 25)" $SICK --wait-timeout 25

# ---------------------------------------------------------------- uninstall keeps data
printf 'my data\n' > "$S/bothy-files/notes/keep-me.md"
"$(bin $B)" uninstall >/tmp/u2.txt 2>&1 || fail "uninstall rc"
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=bothy)" ] && ok "uninstall removed the containers" || fail "containers remain"
[ -z "$(docker network ls -q --filter name=bothy-)" ] && ok "uninstall removed the networks" || fail "network remains"
{ [ -f "$C/secrets/master.key" ] && [ ! -e "$D/receipt.json" ] && [ ! -e "$S/compose.yml" ] && [ ! -e "$D/previous" ]; } && ok "uninstall kept the secret, removed receipt, generated files and the rollback point" || fail "uninstall state"
{ [ -f "$S/bothy-files/notes/keep-me.md" ] && [ -f "$S/bothy-files/notes/hello.md" ]; } && ok "uninstall KEPT the user's notes (data)" || fail "notes deleted by uninstall"
"$(bin $B)" install --bind 0.0.0.0 $(R $B) >/tmp/i3.txt 2>&1 || { cat /tmp/i3.txt; fail "reinstall rc"; }
{ grep -q "skip  secrets" /tmp/i3.txt && [ "$key1" = "$(cat "$C/secrets/master.key")" ] && [[ $(rev) == *"$cb"* ]]; } && ok "reinstall reused the secret and the notes; release $B is up" || fail "reinstall"
[ -f "$S/bothy-files/notes/keep-me.md" ] && ok "notes survived the reinstall" || fail "notes lost"

# ---------------------------------------------------------------- purge needs the typed phrase
if echo yes | "$(bin $B)" uninstall --purge >/dev/null 2>&1; then fail "purge accepted a wrong phrase"; fi
{ [ -f "$D/receipt.json" ] && [ -f "$C/secrets/master.key" ] && [ -f "$S/bothy-files/notes/keep-me.md" ] && [ -n "$(docker ps -q --filter label=com.docker.compose.project=bothy)" ]; } && ok "a wrong confirmation deleted nothing and left the stack running" || fail "wrong phrase deleted data"
echo "delete bothy data" | "$(bin $B)" uninstall --purge >/tmp/p.txt 2>&1 || fail "purge rc"
{ [ ! -e "$D" ] && [ ! -e "$C" ]; } && ok "typed purge removed the install root (with the notes) and the secrets" || fail "purge left data"
for ref in $(grep -o '"ref":"[^"]*"' "$rel/$B/release-manifest.json" | cut -d'"' -f4); do docker image inspect "$ref" >/dev/null 2>&1 && fail "purge left the image $ref"; done
ok "purge removed release $B's pulled images (web, files, traefik)"
echo "images still on the guest (release $A's web image: the receipt that named it went with the plain uninstall): $(docker images --format '{{.Repository}}@{{.ID}}' | grep -v registry | tr '\n' ' ')"
echo "PROOF PASSED ($n checks)"
