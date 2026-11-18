#!/usr/bin/env bash
# robust-proof.sh - runs INSIDE a lab guest after fake-release.sh (run-lab.sh with
# PROOF_SCRIPT=robust-proof.sh). The ways a real person's machine differs from the
# happy path, each made true in the guest, then `bothy install` is run against it and
# must (a) refuse or recover, (b) say the exact fix, (c) leave no partial state, and
# (d) never touch anything that is not Bothy's.   robust-proof.sh <releases-dir>
#
# Needs a clean guest with ~/bin/bothy-2026.11.0, docker + compose, sudo, python3 and
# the fake release (registry:2 image present locally, container fake-ghcr running).
# Changes the guest on purpose (iptables, the clock, mounts, a stopped daemon) and
# puts every one back before the next scenario. Safe ONLY in a throwaway VM.
# shellcheck disable=SC2015,SC2046,SC2012,SC2013,SC2088
set -uo pipefail
rel="${1:?releases dir}"
V=2026.11.0
B="$HOME/bin/bothy-$V"
D="$HOME/.local/share/bothy"; C="$HOME/.config/bothy"
n=0; fail() { echo "FAIL: $*"; exit 1; }; ok() { n=$((n+1)); echo "ok $n: $*"; }
R() { echo "--manifest $rel/$V/release-manifest.json --checksums $rel/$V/checksums.txt"; }
untouched() { [ ! -e "$D" ] && [ ! -e "$C" ]; }
bothy_containers() { docker ps -a --filter label=com.docker.compose.project=bothy -q | wc -l; }
purge() { echo "delete bothy data" | "$B" uninstall --purge "$@" >/dev/null 2>&1; docker rm -f squat >/dev/null 2>&1; true; }
fake_up() { docker start fake-ghcr >/dev/null 2>&1; true; }
needs() { grep -q -- "$1" "$2" || { cat "$2"; fail "$3: output lacks '$1'"; }; }

command -v python3 >/dev/null || fail "python3 missing in the guest"
untouched || fail "guest is not clean"
fake_up

# ---------------------------------------------------------------- 1. port 80 taken
# 1a. by a host process (stands in for nginx/apache), listening as root on all addresses
sudo python3 -m http.server 80 --bind 0.0.0.0 --directory /tmp >/dev/null 2>&1 &
sleep 1; curl -fsS -o /dev/null http://127.0.0.1:80/ || fail "test listener did not start"
"$B" install $(R) >/tmp/p80.txt 2>&1; rc=$?
{ [ $rc -ne 0 ] && untouched && [ "$(bothy_containers)" = 0 ]; } && ok "1a port 80 held by a host process: install refused (rc $rc), nothing created, no container" || { cat /tmp/p80.txt; fail "1a"; }
needs "80 is already in use" /tmp/p80.txt 1a; needs "bothy install --port 8080" /tmp/p80.txt 1a; needs "Nothing was stopped" /tmp/p80.txt 1a
curl -fsS -o /dev/null http://127.0.0.1:80/ && ok "1a the listener on :80 is still alive (nothing of ours was killed)" || fail "1a the squatter died"
sudo pkill -f 'http.server 80' ; sleep 1
# 1b. by another container
docker run -d --name squat -p 80:5000 registry:2 >/dev/null || fail "1b could not start the squatting container"
sleep 1
"$B" install $(R) >/tmp/p80c.txt 2>&1; rc=$?
{ [ $rc -ne 0 ] && untouched; } && needs "squat" /tmp/p80c.txt 1b && ok "1b port 80 held by another container: refused and the container is NAMED" || { cat /tmp/p80c.txt; fail "1b"; }
docker ps --filter name=squat --filter status=running -q | grep -q . && ok "1b the other container is still running" || fail "1b the other container was disturbed"
# 1c. the suggested --port works end to end
"$B" install --port 8080 $(R) >/tmp/p8080.txt 2>&1 || { cat /tmp/p8080.txt; fail "1c install on 8080"; }
v=$(curl -fsS http://127.0.0.1:8080/version.json); [[ $v == *revision* ]] && ok "1c install on the suggested --port 8080 works, bytes verified: $v" || fail "1c $v"
docker ps --filter name=squat --filter status=running -q | grep -q . && ok "1c ...and the squatter on :80 is still running next to it" || fail "1c squatter gone"
purge

# ---------------------------------------------------------------- 2. docker access
sudo id nodock >/dev/null 2>&1 || sudo useradd -m nodock
NH=$(getent passwd nodock | cut -d: -f6)
sudo cp "$B" /tmp/bothy-nodock && sudo chmod 755 /tmp/bothy-nodock
sudo cp -r "$rel" /tmp/rel-nodock && sudo chmod -R a+rX /tmp/rel-nodock
sudo -u nodock -H /tmp/bothy-nodock install --manifest /tmp/rel-nodock/$V/release-manifest.json --checksums /tmp/rel-nodock/$V/checksums.txt >/tmp/nodock.txt 2>&1; rc=$?
{ [ $rc -ne 0 ] && [ ! -e "$NH/.local/share/bothy" ] && [ ! -e "$NH/.config/bothy" ]; } && ok "2a user outside the docker group: refused (rc $rc), nothing created in their home" || { cat /tmp/nodock.txt; fail "2a"; }
needs "permission denied" /tmp/nodock.txt 2a; needs "usermod -aG docker" /tmp/nodock.txt 2a; needs "newgrp docker" /tmp/nodock.txt 2a
# 2b. compose plugin missing
cp_path=$(ls /usr/libexec/docker/cli-plugins/docker-compose /usr/lib/docker/cli-plugins/docker-compose 2>/dev/null | head -1)
[ -n "$cp_path" ] || fail "2b cannot find the compose plugin"
sudo mv "$cp_path" /tmp/docker-compose.hidden
"$B" install --dry-run $(R) >/tmp/nocompose.txt 2>&1; rc=$?
sudo mv /tmp/docker-compose.hidden "$cp_path"
{ [ $rc -ne 0 ] && untouched; } && needs "docker-compose-v2" /tmp/nocompose.txt 2b && ok "2b compose plugin missing: refused with the apt command" || { cat /tmp/nocompose.txt; fail "2b"; }
# 2c. docker is only a Docker Desktop / WSL stub
mkdir -p /tmp/stubbin && cat > /tmp/stubbin/docker <<'EOF'
#!/bin/sh
echo "The command 'docker' could not be found in this WSL 2 distro." >&2
echo "We recommend to activate the WSL integration in Docker Desktop settings." >&2
exit 1
EOF
chmod +x /tmp/stubbin/docker
PATH=/tmp/stubbin:/usr/bin:/bin "$B" install --dry-run $(R) >/tmp/wsl.txt 2>&1; rc=$?
{ [ $rc -ne 0 ] && untouched; } && needs "WSL integration" /tmp/wsl.txt 2c && ok "2c Docker Desktop WSL stub: says to enable the integration, not 'daemon down'" || { cat /tmp/wsl.txt; fail "2c"; }

# ---------------------------------------------------------------- 3. low RAM
avail=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
hog=$((avail - 550))
rm -f /tmp/hog.log
python3 -c "
import time
b = bytearray(b'\x01') * ($hog * 1024 * 1024)
print('alloc ok', flush=True)
time.sleep(600)" >/tmp/hog.log 2>&1 &
hogpid=$!
for _ in $(seq 1 60); do grep -q 'alloc ok' /tmp/hog.log 2>/dev/null && break; sleep 1; done
grep -q 'alloc ok' /tmp/hog.log || { cat /tmp/hog.log; fail "3 the memory hog did not start"; }
sleep 2
now=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
"$B" install $(R) >/tmp/ram.txt 2>&1; rc=$?
kill $hogpid 2>/dev/null; wait $hogpid 2>/dev/null
{ [ $rc -ne 0 ] && untouched && [ "$(bothy_containers)" = 0 ]; } && ok "3 low RAM (MemAvailable $now MiB): refused before any change" || { cat /tmp/ram.txt; fail "3"; }
needs "MiB available, 960 MiB needed" /tmp/ram.txt 3
sleep 2

# ---------------------------------------------------------------- 4. interrupted, then resumed
wait_for() { for _ in $(seq 1 200); do grep -q -- "$1" "$2" 2>/dev/null && return 0; sleep 0.1; done; return 1; }
# 4a. Ctrl-C while a pull is running
"$B" install $(R) >/tmp/int1.txt 2>&1 &
ip=$!
wait_for "-> docker pull" /tmp/int1.txt || { cat /tmp/int1.txt; fail "4a never reached the pull"; }
kill -INT $ip; wait $ip; rc=$?
{ [ $rc -ne 0 ] && [ "$(bothy_containers)" = 0 ] && grep -q '"status": "in-progress"' "$D/receipt.json" && [ ! -e "$D/.install.lock" ]; } \
  && ok "4a SIGINT during a pull: rc $rc, receipt in-progress, no container, no lock file" || { cat /tmp/int1.txt; fail "4a"; }
needs "INTERRUPTED" /tmp/int1.txt 4a; needs "again to resume" /tmp/int1.txt 4a
grep -q interrupted "$D/receipt.json" && ok "4a receipt records last_error 'interrupted'" || fail "4a last_error"
key1=$(cat "$C/secrets/master.key")
# 4b. Ctrl-C while compose up is waiting: the run must take its own containers down
"$B" install $(R) >/tmp/int2.txt 2>&1 &
ip=$!
wait_for "-> docker compose up" /tmp/int2.txt || { cat /tmp/int2.txt; fail "4b never reached up"; }
sleep 2; kill -INT $ip; wait $ip; rc=$?
sleep 3
{ [ $rc -ne 0 ] && [ "$(docker ps -q --filter label=com.docker.compose.project=bothy | wc -l)" = 0 ]; } && ok "4b SIGINT during up: rc $rc, the cleanup compose down ran (no bothy container left running)" || { cat /tmp/int2.txt; docker ps -a; fail "4b"; }
# 4c. the process is KILLED (no chance to clean up) while its containers are coming up
"$B" install $(R) >/tmp/int3.txt 2>&1 &
ip=$!
wait_for "-> docker compose up" /tmp/int3.txt || { cat /tmp/int3.txt; fail "4c never reached up"; }
sleep 3; kill -9 $ip; wait $ip 2>/dev/null
for _ in $(seq 1 60); do [ "$(docker ps -q --filter label=com.docker.compose.project=bothy | wc -l)" -ge 1 ] && break; sleep 1; done
sleep 5
[ "$(docker ps -q --filter label=com.docker.compose.project=bothy | wc -l)" -ge 1 ] && ok "4c SIGKILL left containers up holding port 80 (the hard case)" || echo "note 4c: no container survived the kill; the port-held resume case was not exercised"
# 4d. resume: finished steps skip, the port is not mistaken for someone else's, the key is unchanged
"$B" install $(R) >/tmp/res.txt 2>&1; rc=$?
{ [ $rc -eq 0 ] && grep -q "Bivvy is up" /tmp/res.txt && grep -q "skip  dirs" /tmp/res.txt && grep -q "skip  secrets" /tmp/res.txt; } && ok "4d resume after interrupts: completes, dirs/secrets skipped" || { cat /tmp/res.txt; fail "4d"; }
[ "$(cat "$C/secrets/master.key")" = "$key1" ] && ok "4d the master key survived all three interruptions unchanged" || fail "4d key changed"
grep -Eq "port +127.0.0.1:80 is" /tmp/res.txt && ok "4d preflight: $(grep -E "port +127.0.0.1:80" /tmp/res.txt | head -1 | sed "s/^ *//")" || fail "4d port line"
{ grep -q '"status": "complete"' "$D/receipt.json" && [ "$(docker ps -q --filter label=com.docker.compose.project=bothy | wc -l)" = 3 ]; } && ok "4d receipt complete, exactly 3 containers" || fail "4d state"
purge

# ---------------------------------------------------------------- 5. offline, blocked registry, wrong clock
# 5a. the registry Traefik comes from (Docker Hub) is unreachable: 443 refused
sudo iptables -I OUTPUT -p tcp --dport 443 -j REJECT --reject-with tcp-reset
"$B" install $(R) >/tmp/off.txt 2>&1; rc=$?
{ [ $rc -ne 0 ] && grep -q '"status": "in-progress"' "$D/receipt.json" && [ "$(bothy_containers)" = 0 ]; } && ok "5a registry blocked mid-install: stopped at the pull (rc $rc), receipt in-progress, no container" || { cat /tmp/off.txt; sudo iptables -D OUTPUT -p tcp --dport 443 -j REJECT --reject-with tcp-reset; fail "5a"; }
needs "hint:" /tmp/off.txt 5a; needs "again to resume" /tmp/off.txt 5a
echo "   hint printed: $(grep 'hint:' /tmp/off.txt | head -1 | cut -c1-160)"
# 5b. the release metadata cannot be fetched at all (default source, no flags)
purge; sudo iptables -L OUTPUT -n | grep -q REJECT || sudo iptables -I OUTPUT -p tcp --dport 443 -j REJECT --reject-with tcp-reset
"$B" install --dry-run >/tmp/off2.txt 2>&1; rc=$?
{ [ $rc -ne 0 ] && untouched; } && needs "fetch release manifest" /tmp/off2.txt 5b && needs "hint:" /tmp/off2.txt 5b && ok "5b GitHub unreachable: 'fetch release manifest' failed with a hint, nothing created" || { cat /tmp/off2.txt; fail "5b"; }
# 5c. back online: the same command now resumes and finishes
while sudo iptables -D OUTPUT -p tcp --dport 443 -j REJECT --reject-with tcp-reset 2>/dev/null; do :; done
"$B" install $(R) >/tmp/on.txt 2>&1 && grep -q "Bivvy is up" /tmp/on.txt && ok "5c network back: install completes from the same command" || { cat /tmp/on.txt; fail "5c"; }
purge
# 5d. wrong clock (+5 years): TLS to github.com must fail with a clock hint, not a bare x509 error
saved=$(date +%s); t0=$SECONDS
sudo timedatectl set-ntp false >/dev/null 2>&1; sudo date -s "@$((saved + 157680000))" >/dev/null
"$B" install --dry-run >/tmp/clock.txt 2>&1; rc=$?
sudo date -s "@$((saved + SECONDS - t0))" >/dev/null; sudo timedatectl set-ntp true >/dev/null 2>&1
{ [ $rc -ne 0 ] && untouched; } && needs "clock" /tmp/clock.txt 5d && ok "5d clock +5y: refused with a 'check the clock' hint, nothing created" || { cat /tmp/clock.txt; fail "5d"; }

# ---------------------------------------------------------------- 6. where it is installed
# 6a. read-only location
sudo mkdir -p /srv/rodir && sudo mount --bind /srv/rodir /srv/rodir && sudo mount -o remount,bind,ro /srv/rodir
"$B" install --dry-run --root /srv/rodir/bothy --config-dir /srv/rodir/cfg/bothy $(R) >/tmp/ro.txt 2>&1; rc=$?
sudo umount /srv/rodir
{ [ $rc -ne 0 ] && untouched; } && needs "cannot create files" /tmp/ro.txt 6a && needs "Nothing was created" /tmp/ro.txt 6a && ok "6a read-only install location: refused in preflight, says where to point --root" || { cat /tmp/ro.txt; fail "6a"; }
# 6b. nearly no disk (a small tmpfs)
sudo mkdir -p /srv/small && sudo mount -t tmpfs -o size=100m,mode=1777 tmpfs /srv/small
"$B" install --root /srv/small/bothy $(R) >/tmp/disk.txt 2>&1; rc=$?
sudo umount /srv/small
{ [ $rc -ne 0 ] && untouched; } && needs "MiB free at" /tmp/disk.txt 6b && ok "6b a 100 MB filesystem: refused ('MiB free at ...'), nothing created" || { cat /tmp/disk.txt; fail "6b"; }
# 6c. spaces and unicode in every path, then the full lifecycle
SD="$HOME/dir with spaces/José"; SD=$(printf "$SD"); SC="$HOME/cfg \xc3\xbc/x"; SC=$(printf "$SC")
"$B" install --root "$SD/bothy" --config-dir "$SC/bothy" $(R) >/tmp/sp.txt 2>&1; rc=$?
if [ $rc -eq 0 ] && grep -q "byte-identical" /tmp/sp.txt; then ok "6c \$HOME-style paths with spaces and non-ASCII: install ran and verified bytes"; else cat /tmp/sp.txt; fail "6c"; fi
[ -f "$SD/bothy/stack/compose.yml" ] && [ "$(stat -c %a "$SC/bothy/secrets/master.key")" = 600 ] && ok "6c files and a 0600 key landed where asked" || fail "6c layout"
echo "delete bothy data" | "$B" uninstall --purge --root "$SD/bothy" --config-dir "$SC/bothy" >/dev/null 2>&1
[ ! -e "$SD/bothy" ] && ok "6c purge removed it again" || fail "6c purge"
rm -rf "$HOME/dir with spaces" "$HOME/cfg "*

# ---------------------------------------------------------------- 7. someone else's "bothy" on this machine
mkdir -p ~/other && cat > ~/other/compose.yml <<'EOF'
services:
  keep:
    image: registry:2
EOF
docker compose -p bothy -f ~/other/compose.yml up -d >/dev/null 2>&1 || fail "7 could not start the foreign bothy project"
before=$(docker ps -q --filter label=com.docker.compose.project=bothy)
"$B" install $(R) >/tmp/proj.txt 2>&1; rc=$?
after=$(docker ps -q --filter label=com.docker.compose.project=bothy)
{ [ $rc -ne 0 ] && untouched && [ "$before" = "$after" ]; } && needs "will not adopt" /tmp/proj.txt 7 && ok "7 a different compose project called bothy exists: refused, its container untouched, nothing created" || { cat /tmp/proj.txt; fail "7"; }
docker compose -p bothy -f ~/other/compose.yml down >/dev/null 2>&1; rm -rf ~/other

# ---------------------------------------------------------------- 8. two installs at once
"$B" install $(R) >/tmp/race1.txt 2>&1 &
p1=$!
"$B" install $(R) >/tmp/race2.txt 2>&1 &
p2=$!
wait $p1; r1=$?; wait $p2; r2=$?
refused=$(grep -l "already running" /tmp/race1.txt /tmp/race2.txt 2>/dev/null | wc -l)
{ [ $((r1 * r2)) -eq 0 ] && [ "$(docker ps -q --filter label=com.docker.compose.project=bothy | wc -l)" = 3 ] && grep -q '"status": "complete"' "$D/receipt.json"; } \
  && ok "8 two simultaneous installs (rc $r1 and $r2, $refused refused by the lock): one finished, exactly 3 containers, receipt complete" || { cat /tmp/race1.txt /tmp/race2.txt; fail "8"; }
[ "$refused" -ge 1 ] && ok "8 the second run was refused by the lock rather than interleaving" || echo "note 8: the runs did not overlap in time (second was a no-op re-run); the lock path is covered by the unit test"
[ ! -e "$D/.install.lock" ] && ok "8 no lock file left" || fail "8 lock file"
purge

# ---------------------------------------------------------------- 9. run under sudo
sudo "$B" install --dry-run $(R) >/tmp/sudo.txt 2>&1; rc=$?
{ [ $rc -eq 0 ] && grep -q "running under sudo" /tmp/sudo.txt && untouched && [ ! -e /root/.local/share/bothy ]; } && ok "9 sudo bothy install --dry-run: warns about sudo and says to run without it" || { cat /tmp/sudo.txt; fail "9"; }

# ---------------------------------------------------------------- 10. docker daemon down (last: it stops the registry)
sudo systemctl stop docker.socket docker >/dev/null 2>&1
"$B" install --dry-run $(R) >/tmp/down.txt 2>&1; rc=$?
sudo systemctl start docker >/dev/null 2>&1; sleep 3; fake_up
{ [ $rc -ne 0 ] && untouched; } && needs "systemctl start docker" /tmp/down.txt 10 && ok "10 daemon stopped: refused with the start command" || { cat /tmp/down.txt; fail "10"; }

echo "ROBUSTNESS PROOF PASSED ($n checks)"
