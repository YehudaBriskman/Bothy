#!/usr/bin/env bash
# proof-release.sh - runs INSIDE a lab guest, never on the live box. The install lifecycle against a
# REAL release: the binary is the release's own linux/amd64 binary, the images are pulled anonymously
# from the registry the manifest names (ghcr.io), by digest. Nothing is built or faked here.
#
#   proof-release.sh <version e.g. 2026.11.1> <dir holding release-manifest.json + checksums.txt> <repaired 0|1>
#
# <repaired>=1: the two files are LOCAL workarounds of two release defects (see run-lab-release.sh) and are
# passed with --manifest/--checksums. =0: the binary reads the release over https (the default path).
# Expects the binary at ~/bin/bothy. Exits non-zero at the first broken assertion.
# shellcheck disable=SC2015,SC2046,SC2012,SC2013,SC2086  # `ok` cannot fail; R output is meant to word-split
set -uo pipefail
ver="${1:?version}"; rel="${2:?dir}"; repaired="${3:-0}"
D="$HOME/.local/share/bothy"; C="$HOME/.config/bothy"; S="$D/stack"; B="$HOME/bin/bothy"
n=0; fail() { echo "FAIL: $*"; exit 1; }; ok() { n=$((n+1)); echo "ok $n: $*"; }
now() { date +%s.%N; }
sha() { sha256sum | cut -d' ' -f1; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", b-a}'; }
R() { if [ "$repaired" = 1 ]; then echo "--manifest $1/release-manifest.json --checksums $1/checksums.txt"; fi; }
web=bothy-bothy-web-1; files=bothy-bothy-files-1; edge=bothy-traefik-1
rev() { curl -fsS http://127.0.0.1/version.json; }
commit=$(grep -o '"commit": *"[0-9a-f]*"' "$rel/release-manifest.json" | cut -d'"' -f4)
ref() { grep -o "\"ref\": *\"[^\"]*$1@sha256:[0-9a-f]*\"" "$rel/release-manifest.json" | head -1 | cut -d'"' -f4; }
webref=$(ref bothy-web); filesref=$(ref bothy-files); edgeref=$(grep -o '"ref": *"traefik@sha256:[0-9a-f]*"' "$rel/release-manifest.json" | cut -d'"' -f4)
[ -n "$webref" ] && [ -n "$filesref" ] && [ -n "$edgeref" ] || fail "cannot read the three refs from the manifest"
# a status code proves nothing (the catch-all answers 200 to anything): compare bytes.
# The reference copy comes from the image BY DIGEST (docker create + cp), not from the running container.
img_index() { local c; c=$(docker create "$webref" 2>/dev/null) || return 1; docker cp "$c:/usr/share/nginx/html/index.html" - 2>/dev/null | tar -xO; docker rm "$c" >/dev/null; }
served_eq_image() { [ "$(curl -fsS http://127.0.0.1/ | sha)" = "$(img_index | sha)" ]; }
# a derived release: same real digests, one edit, its own checksum line. name sed-expr
derive() { local d="$rel/$1"; rm -rf "$d"; mkdir -p "$d"; sed -e "$2" "$rel/release-manifest.json" > "$d/release-manifest.json"
  { grep -v ' release-manifest.json$' "$rel/checksums.txt"; printf '%s  release-manifest.json\n' "$(sha256sum "$d/release-manifest.json" | cut -d' ' -f1)"; } > "$d/checksums.txt"; }
DR() { echo "--manifest $rel/$1/release-manifest.json --checksums $rel/$1/checksums.txt"; }   # derived releases are always local

{ [ ! -e "$D" ] && [ ! -e "$C" ]; } || fail "guest is not clean"
[ ! -e "$HOME/.docker/config.json" ] && ok "guest has no docker credentials: every pull is anonymous" || fail "docker config exists"
command -v gh >/dev/null && echo "NOTE: gh is installed in the guest" || echo "NOTE: gh is not installed in the guest"

# ---------------------------------------------------------------- version
vo=$("$B" version 2>&1 | head -1); echo "$vo"
[[ $vo == "bothy $ver (commit ${commit:0:12}"* ]] && ok "bothy version: $vo" || fail "version line: $vo"

# ---------------------------------------------------------------- default (https) source, informational when repaired
if [ "$repaired" = 1 ]; then
  "$B" install --dry-run >/tmp/dry-default.txt 2>&1; rcd=$?
  echo "DEFAULT-SOURCE dry-run rc=$rcd: $(tail -2 /tmp/dry-default.txt | tr '\n' '|')"
  [ -e "$D" ] && fail "default-source dry run created files"
fi

# ---------------------------------------------------------------- dry run, then install
"$B" install --dry-run --bind 0.0.0.0 $(R "$rel") >/tmp/dry.txt 2>&1 || { cat /tmp/dry.txt; fail "dry-run rc"; }
if grep -q "dry run: nothing was changed" /tmp/dry.txt && [ ! -e "$D" ] && [ ! -e "$C" ]; then ok "dry run printed the plan and created nothing"; else fail "dry run"; fi
grep -c '^  do ' /tmp/dry.txt | sed 's/^/dry-run plan lines: /'
grep -q "960 MiB needed" /tmp/dry.txt && ok "RAM gate: 960 MiB needed" || fail "RAM gate line: $(grep memory /tmp/dry.txt)"

echo "--- guest memory before install"; free -m | sed -n 1,2p
t0=$(now); "$B" install --bind 0.0.0.0 $(R "$rel") >/tmp/i1.txt 2>&1 || { cat /tmp/i1.txt; fail "install rc"; }
t1=$(now); echo "install took $(secs "$t0" "$t1")s"; grep -A1 '^-> docker' /tmp/i1.txt | grep -v '^--' | paste - - | sed 's/^-> //' | cut -c1-200
grep -q "byte-identical" /tmp/i1.txt && grep -q "Bivvy is up" /tmp/i1.txt && ok "install ran and verified bytes" || { cat /tmp/i1.txt; fail "install output"; }
grep -q "attestation: " /tmp/i1.txt && echo "$(grep 'attestation: ' /tmp/i1.txt | head -1 | cut -c1-150)"
served_eq_image && ok "portal: served / is byte-identical to index.html of the image $webref (read from the image, not the container)" || fail "portal bytes differ"
[ "$(rev)" = "{\"revision\":\"$commit\"}" ] || [ "$(rev | tr -d ' \n')" = "{\"revision\":\"$commit\"}" ] && ok "/version.json = $(rev) = the release commit" || fail "version.json $(rev) vs $commit"
for r in "$webref" "$filesref" "$edgeref"; do [ "$(docker image inspect "$r" --format '{{index .RepoDigests 0}}' 2>/dev/null | sed 's/.*@//')" = "${r##*@}" ] || fail "image $r not present at its digest"; done; ok "the three running images carry exactly the manifest's digests"
for c in $web $files $edge; do [ "$(docker inspect $c --format '{{.Image}}' | cut -c1-19)" != "" ]; done
[ "$(docker inspect $web --format '{{.Config.Image}}')" = "$webref" ] && ok "bothy-web container was created from the manifest digest ref" || fail "web ref differs: $(docker inspect $web --format '{{.Config.Image}}')"
key1=$(cat "$C/secrets/master.key")
{ [ "$(stat -c %a "$C/secrets/master.key")" = 600 ] && [ "$(stat -c %a "$C/secrets")" = 700 ]; } && ok "secret modes 0600 / 0700" || fail "modes"
docker images --format 'image {{.Repository}} {{.Size}}'; docker system df | sed -n 1,2p
echo "--- memory after install"; docker stats --no-stream --format "mem {{.Name}} {{.MemUsage}}" $edge $web $files; free -m | sed -n 1,2p

# ---------------------------------------------------------------- files module
printf 'hello from the notes root\nline two\n' > "$S/bothy-files/notes/hello.md"
printf 'TOKEN=should-be-labelled-sensitive\n' > "$S/bothy-files/notes/.env"
sleep 1
roots=$(curl -fsS http://127.0.0.1/-/api/files/roots); echo "roots: $roots"
{ [[ $roots == *'"notes"'* ]] && [[ $roots != *'"stacks"'* ]] && [[ $roots != *'"home"'* ]] && [[ $roots == *'"readOnly": true'* || $roots == *'"readOnly":true'* ]]; } && ok "files: exactly one root, notes, read-only" || fail "roots: $roots"
got=$(curl -fsS "http://127.0.0.1/-/api/files/read?root=notes&path=hello.md")
[[ $got == *"hello from the notes root"* ]] && [[ $got == *"line two"* ]] && ok "files: /read returned the file's bytes through the edge" || fail "files read: $got"
env_got=$(curl -sS "http://127.0.0.1/-/api/files/read?root=notes&path=.env")
[[ $env_got != *"should-be-labelled-sensitive"* || $env_got == *sensitive* ]] && ok "files: a .env in the root is labelled sensitive: $(echo "$env_got" | cut -c1-90)" || fail "env read"
before=$(ls -A "$S/bothy-files/notes" | sort | tr '\n' ' ')
code=$(curl -s -o /tmp/w.out -w '%{http_code}' -X POST "http://127.0.0.1/-/api/files/write" -H 'content-type: application/json' -d '{"root":"notes","path":"pwn.md","content":"x"}')
after=$(ls -A "$S/bothy-files/notes" | sort | tr '\n' ' ')
{ [ "$before" = "$after" ] && [ ! -e "$S/bothy-files/notes/pwn.md" ]; } && ok "files: POST /write created nothing (edge answered $code: $(head -c 20 /tmp/w.out | tr -d '\n'))" || fail "write created a file"
grep -qi 'not allowed' /tmp/w.out && ok "files: /write is not routed (the portal catch-all answered)" || fail "write answer: $(head -c 80 /tmp/w.out)"
docker exec $files sh -c 'touch /repos/notes/x' 2>/dev/null && fail "the notes mount is writable inside the container" || ok "files: the notes mount is read-only inside the container (kernel refuses)"
head -c 15 <(curl -s "http://127.0.0.1/-/api/files/raw?root=notes&path=hello.md") | grep -qi '<!doctype html' && ok "files: /raw is not served on :80" || fail "raw served on :80"

# ---------------------------------------------------------------- the edge
mounts=$(docker inspect $edge --format '{{json .Mounts}} {{json .HostConfig.Binds}}'); echo "traefik mounts: $mounts"
[[ $mounts != *docker.sock* ]] && ok "edge: NO docker.sock mount on traefik" || fail "docker.sock mounted: $mounts"
cmd=$(docker inspect $edge --format '{{json .Config.Cmd}}')
[[ $cmd != *providers.docker* ]] && [[ $cmd == *providers.file.directory* ]] && [[ $cmd != *api.dashboard* ]] && [[ $cmd == *'--api=true'* ]] && ok "edge: file provider only, API on, dashboard off" || fail "traefik cmd $cmd"
for c in $web $files $edge; do docker inspect "$c" --format '{{.HostConfig.Binds}} {{.HostConfig.Privileged}} {{.HostConfig.NetworkMode}} {{.HostConfig.PidMode}}' | tee /tmp/hc.txt | grep -q 'docker.sock' && fail "$c mounts the docker socket"; grep -q 'true\| host' /tmp/hc.txt && fail "$c is privileged or on the host network/pid: $(cat /tmp/hc.txt)"; done; ok "no container is privileged, host-networked or mounts docker.sock"
ports=$(docker ps --format '{{.Names}} {{.Ports}}' | grep '^bothy-'); echo "$ports"
published=$(docker ps --filter label=com.docker.compose.project=bothy --format '{{.Ports}}' | tr ',' '\n' | grep -c -- '->' || true)
[ "$published" -le 1 ] && echo "$ports" | grep -q '0.0.0.0:80->80/tcp' && ok "docker publishes exactly one port: 0.0.0.0:80->80 (traefik)" || fail "published ports: $ports"
echo "listening: $(ss -H -ltn | awk '{print $4}' | sort -u | tr '\n' ' ')"
for p in 8100 8899 8099 8080 5000; do ss -H -ltn | awk '{print $4}' | grep -qE "[:.]$p$" && fail "host listens on $p"; done
ss -H -ltn | awk '{print $4}' | grep -qE '^(0\.0\.0\.0|\*|\[::\]):80$' && ok "ss: host listens on :80 and not on 8100, 8899, 8099, 8080" || fail "ss: no :80 listener"
docker exec $edge wget -qO- -T3 http://127.0.0.1:8899/ping >/dev/null 2>&1 && ok "edge: the ping entrypoint answers on loopback INSIDE traefik" || fail "traefik ping on loopback"
docker exec $web wget -qO- -T3 http://traefik:8899/ping >/dev/null 2>&1 && fail "traefik:8899 reachable from another container" || ok "edge: another container cannot reach traefik:8899 (loopback-bound)"
docker logs $edge 2>&1 | grep -iE 'level=(error|fatal)|cannot|unable' >/tmp/edge-errs.txt; [ ! -s /tmp/edge-errs.txt ] && ok "edge: no errors in traefik's log" || { cat /tmp/edge-errs.txt; fail "traefik logged errors"; }
tv=$(docker exec $edge traefik version 2>/dev/null | sed -n 's/^Version: *//p'); echo "traefik version: $tv"

# ---------------------------------------------------------------- re-run is a no-op
t0=$(now); "$B" install --bind 0.0.0.0 $(R "$rel") >/tmp/i2.txt 2>&1 || fail "re-run rc"; t1=$(now)
if grep -q "nothing to do" /tmp/i2.txt && ! grep -q '^-> ' /tmp/i2.txt; then ok "re-run is a no-op ($(secs "$t0" "$t1")s)"; else cat /tmp/i2.txt; fail "re-run changed things"; fi
[ "$key1" = "$(cat "$C/secrets/master.key")" ] && ok "re-run kept the master key" || fail "key rotated"

# ---------------------------------------------------------------- update: refusals checkable with ONE real release
cp "$S/.env" /tmp/env.A; cp "$D/receipt.json" /tmp/receipt.A; idw=$(docker inspect $web --format '{{.Id}}')
unchanged() { cmp -s /tmp/env.A "$S/.env" && cmp -s /tmp/receipt.A "$D/receipt.json" && [ ! -e "$D/previous" ] && [ "$(docker inspect $web --format '{{.Id}}')" = "$idw" ]; }
"$B" update --check $(R "$rel") >/tmp/uc.txt 2>&1 || { cat /tmp/uc.txt; fail "update --check rc"; }
grep -q "Nothing was changed\|up to date" /tmp/uc.txt && unchanged && ok "update --check on the same release: $(grep -m1 'up to date\|Nothing was changed' /tmp/uc.txt)" || { cat /tmp/uc.txt; fail "update --check"; }
t0=$(now); "$B" update $(R "$rel") >/tmp/u1.txt 2>&1; rcu=$?; t1=$(now)
{ [ $rcu = 0 ] && grep -q "up to date" /tmp/u1.txt && unchanged; } && ok "update to the SAME release is a no-op: $(grep -m1 'up to date' /tmp/u1.txt) ($(secs "$t0" "$t1")s)" || { cat /tmp/u1.txt; fail "same-version update"; }

derive old "s/\"version\": \"$ver\"/\"version\": \"2026.11.0\"/"
if "$B" update $(DR old) >/tmp/uo.txt 2>&1; then fail "a manifest of another version was accepted"; fi
grep -q "bothy installs exactly the release it belongs to" /tmp/uo.txt && unchanged && ok "update with a manifest for 2026.11.0 refused by the 2026.11.1 binary, nothing changed: $(tail -1 /tmp/uo.txt | cut -c1-140)" || { cat /tmp/uo.txt; fail "version-mismatch refusal"; }
mkdir -p "$rel/tamper"; sed 's/"schema": 1/"schema": 1 /' "$rel/release-manifest.json" > "$rel/tamper/release-manifest.json"; cp "$rel/checksums.txt" "$rel/tamper/checksums.txt"
if "$B" update --manifest "$rel/tamper/release-manifest.json" --checksums "$rel/tamper/checksums.txt" >/tmp/ut.txt 2>&1; then fail "a tampered manifest was accepted"; fi
grep -q "does not match checksums.txt" /tmp/ut.txt && unchanged && ok "update with a tampered manifest (one byte) refused: does not match checksums.txt" || { cat /tmp/ut.txt; fail "tamper refusal"; }
echo "downgrade refusal: NOT checkable with one real release (the version-mismatch check fires first; a downgrade needs an older real binary)"

# ---------------------------------------------------------------- forced failures with the REAL images: roll back
absent="ghcr.io/yehudabriskman/bothy-web@sha256:$(printf 'e%.0s' $(seq 1 64))"
expect_rolled_back() { # label  derived-dir  extra-args
  local label="$1" d="$2"; shift 2
  t0=$(now); "$B" update $(DR "$d") "$@" >/tmp/uf.txt 2>&1 && fail "$label: update unexpectedly succeeded"; t1=$(now)
  echo "--- $label ($(secs "$t0" "$t1")s)"; sed -n '/^-> /,$p' /tmp/uf.txt | cut -c1-260
  grep -q "rolled back" /tmp/uf.txt || fail "$label: no rollback line"
  [ "$(rev | tr -d ' \n')" = "{\"revision\":\"$commit\"}" ] && ok "$label: after rollback /version.json = $(rev)" || fail "$label: version.json $(rev)"
  served_eq_image && ok "$label: after rollback the served bytes are the real web image's" || fail "$label: index bytes"
  cmp -s /tmp/env.A "$S/.env" && ok "$label: the previous .env (digests) restored byte for byte" || fail "$label: .env differs"
  grep -q '"status": "complete"' "$D/receipt.json" && grep -q last_update_error "$D/receipt.json" && ok "$label: receipt complete, last_update_error recorded" || fail "$label: receipt"
  [ "$(docker ps -q --filter label=com.docker.compose.project=bothy | wc -l)" = 3 ] && ok "$label: all three containers running" || fail "$label: containers"
  [ "$(docker inspect $web --format '{{.Config.Image}}')" = "$webref" ] && ok "$label: web container is back on the real digest" || fail "$label: web image $(docker inspect $web --format '{{.Config.Image}}')"
  curl -fsS "http://127.0.0.1/-/api/files/read?root=notes&path=hello.md" | grep -q "hello from the notes root" && ok "$label: files still serve" || fail "$label: files"
}
derive absent "s|$webref|$absent|"
expect_rolled_back "forced failure 1 (web digest ghcr.io does not have)" absent
# unhealthy: the REAL bothy-files image in the web slot: it starts, and nothing answers the web healthcheck on 8080
derive sick "s|$webref|$filesref|"
expect_rolled_back "forced failure 2 (real files image in the web slot, never healthy; --wait-timeout 25)" sick --wait-timeout 25

# ---------------------------------------------------------------- uninstall keeps data
printf 'my data\n' > "$S/bothy-files/notes/keep-me.md"
"$B" uninstall >/tmp/u2.txt 2>&1 || fail "uninstall rc"
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=bothy)" ] && ok "uninstall removed the containers" || fail "containers remain"
[ -z "$(docker network ls -q --filter name=bothy-)" ] && ok "uninstall removed the networks" || fail "network remains"
{ [ -f "$C/secrets/master.key" ] && [ ! -e "$D/receipt.json" ] && [ ! -e "$S/compose.yml" ] && [ ! -e "$D/previous" ]; } && ok "uninstall kept the secret; removed receipt, generated files and the rollback point" || fail "uninstall state"
{ [ -f "$S/bothy-files/notes/keep-me.md" ] && [ -f "$S/bothy-files/notes/hello.md" ]; } && ok "uninstall KEPT the user's notes (data)" || fail "notes deleted by uninstall"
t0=$(now); "$B" install --bind 0.0.0.0 $(R "$rel") >/tmp/i3.txt 2>&1 || { cat /tmp/i3.txt; fail "reinstall rc"; }; t1=$(now)
{ grep -q "skip  secrets" /tmp/i3.txt && [ "$key1" = "$(cat "$C/secrets/master.key")" ] && [ "$(rev | tr -d ' \n')" = "{\"revision\":\"$commit\"}" ]; } && ok "reinstall reused the secret and the notes, images already local ($(secs "$t0" "$t1")s)" || fail "reinstall"
[ -f "$S/bothy-files/notes/keep-me.md" ] && ok "notes survived the reinstall" || fail "notes lost"

# ---------------------------------------------------------------- purge needs the typed phrase
if echo yes | "$B" uninstall --purge >/dev/null 2>&1; then fail "purge accepted a wrong phrase"; fi
{ [ -f "$D/receipt.json" ] && [ -f "$C/secrets/master.key" ] && [ -f "$S/bothy-files/notes/keep-me.md" ] && [ -n "$(docker ps -q --filter label=com.docker.compose.project=bothy)" ]; } && ok "a wrong confirmation deleted nothing and left the stack running" || fail "wrong phrase deleted data"
echo "delete bothy data" | "$B" uninstall --purge >/tmp/p.txt 2>&1 || fail "purge rc"
{ [ ! -e "$D" ] && [ ! -e "$C" ]; } && ok "typed purge removed the install root (with the notes) and the secrets" || fail "purge left data"
for r in "$webref" "$filesref" "$edgeref"; do docker image inspect "$r" >/dev/null 2>&1 && fail "purge left the image $r"; done
ok "purge removed the release's pulled images (web, files, traefik)"
echo "images still on the guest: $(docker images -q | wc -l)"
echo "PROOF PASSED ($n checks)"
