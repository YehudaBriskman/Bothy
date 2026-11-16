#!/usr/bin/env bash
# lab.sh - disposable QEMU/KVM VMs for testing Bothy installs without touching the live box.
# Design: docs/plans/thin-bothy/vm-lab-and-connectivity.md (section A).
#
# Safety rules (enforced here, not just documented):
#   * never edits Docker, iptables, .wslconfig, DNS or anything on the Windows side
#   * refuses to start a VM that would leave the live stack under RESERVE_MIB of free memory
#   * every VM runs in a systemd scope with a hard memory cap and no swap
#   * host forwards bind 127.0.0.1 only
#   * all state lives under $LAB_HOME (default ~/lab), never in the repo
#   * no Tailscale code here: the lab key is a later step and never passes through argv
set -euo pipefail

LAB_HOME="${LAB_HOME:-$HOME/lab}"
[[ "$LAB_HOME" == /* && "$LAB_HOME" != / && ${#LAB_HOME} -gt 5 ]] || { echo "lab: LAB_HOME must be an absolute path, not /" >&2; exit 1; }
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
HERE="$(dirname "$SELF")"
ME="$(id -un)"
ORIG_ARGS=("$@")
IMG_URL="https://cloud-images.ubuntu.com/releases/noble/release"
IMG_NAME="ubuntu-24.04-server-cloudimg-amd64.img"
RESERVE_MIB="${RESERVE_MIB:-4096}"   # MemAvailable that must remain for the live stack after the VM starts
(( RESERVE_MIB >= 2048 )) || { echo "lab: RESERVE_MIB below 2048 is refused" >&2; exit 1; }
PSI_MAX="${PSI_MAX:-10}"             # refuse to start while memory pressure (some avg10) is above this

die()  { echo "lab: $*" >&2; exit 1; }
note() { echo "lab: $*"; }

# profile -> vcpu ram_mib qemu_overhead_mib disk ssh_port portal_port
profile() {
  case "$1" in
    lab-mini) PV_CPU=1 PV_RAM=2048 PV_OVH=768  PV_DISK=20G PV_SSH=2222 PV_WEB=18080 ;;
    lab-std)  PV_CPU=4 PV_RAM=6144 PV_OVH=1024 PV_DISK=40G PV_SSH=2223 PV_WEB=18081 ;;
    *) die "unknown profile '$1' (lab-mini | lab-std). lab-oci is deliberately not offered until lab-mini is measured." ;;
  esac
}

# /dev/kvm is root:kvm. A shell started before 'usermod -aG kvm' lacks the group; re-exec under it.
ensure_kvm() {
  [[ -w /dev/kvm ]] && return 0
  if [[ -n "${LAB_REEXEC:-}" ]]; then die "/dev/kvm still not writable after re-exec under group kvm"; fi
  if getent group kvm | tr ',:' '\n' | grep -qx "$ME"; then
    export LAB_REEXEC=1
    exec /usr/bin/sg kvm -c "$(printf '%q ' "$SELF" "${ORIG_ARGS[@]}")"
  fi
  die "/dev/kvm is not writable and $ME is not in group kvm (sudo usermod -aG kvm $ME, then re-login)"
}

mem_available_mib() { awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo; }
port_free() { local out; out="$(ss -H -ltn)" || die "ss failed"; ! grep -qE "[:.]$1[[:space:]]" <<<"$out"; }
mem_psi() { awk '/^some/{split($2,a,"=");print int(a[2])}' /proc/pressure/memory 2>/dev/null || echo 0; }
vmdir() { echo "$LAB_HOME/vms/$1"; }
# A pid only counts if its command line is OUR qemu for this VM; a recycled pid is stale and removed.
is_running() {
  local f p; f="$(vmdir "$1")/qemu.pid"; [[ -f $f ]] || return 1
  p="$(cat "$f")"
  if [[ $p =~ ^[0-9]+$ && -r /proc/$p/cmdline ]] && tr '\0' ' ' < "/proc/$p/cmdline" | grep -q -- "qemu-system-x86_64 -name $1 "; then return 0; fi
  rm -f "$f"; return 1
}

cmd_check() {
  local ok=1
  for t in qemu-system-x86_64 qemu-img cloud-localds ssh-keygen curl sha256sum; do
    command -v "$t" >/dev/null || { note "MISSING tool: $t"; ok=0; }
  done
  [[ -e /usr/share/OVMF/OVMF_CODE_4M.fd ]] || note "note: OVMF absent (not needed: the cloud image boots with SeaBIOS)"
  [[ -w /dev/kvm ]] || note "/dev/kvm not writable in this shell (lab re-execs under group kvm if you are a member)"
  note "MemAvailable: $(mem_available_mib) MiB, reserve kept for the live stack: ${RESERVE_MIB} MiB"
  awk '/^SwapTotal:/{t=$2} /^SwapFree:/{f=$2} END{printf "lab: swap used %d / %d MiB (a nearly full swap means the box is already tight)\n",(t-f)/1024,t/1024}' /proc/meminfo
  systemd-run --user --scope -q -p MemoryMax=64M -p MemoryHigh=48M -p MemorySwapMax=0 -p CPUQuota=100% true 2>/dev/null && note "memory-capped scopes: OK" || { note "memory-capped scopes: NOT available (lab-up will refuse)"; ok=0; }
  note "memory pressure (some avg10): $(mem_psi) (start refused above $PSI_MAX)"
  loginctl show-user "$ME" -p Linger 2>/dev/null | grep -q yes || note "WARNING: linger is off; ending your last session would kill the lab VMs"
  [[ $ok = 1 ]] && note "check passed" || die "check failed"
}

cmd_fetch() {
  local d="$LAB_HOME/base"; mkdir -p "$d"
  [[ -f "$d/$IMG_NAME" ]] && { note "base image already present: $d/$IMG_NAME"; return 0; }
  # Downloaded files are untrusted: fetch into a fresh dir, verify, only then move into place.
  FETCH_TMP="$(mktemp -d "$d/.fetch.XXXXXX")"
  trap 'rm -rf "$FETCH_TMP"' EXIT
  note "downloading $IMG_NAME (about 600 MB) and its checksum list"
  curl -fL --proto '=https' --tlsv1.2 -o "$FETCH_TMP/SHA256SUMS" "$IMG_URL/SHA256SUMS"
  curl -fL --proto '=https' --tlsv1.2 -o "$FETCH_TMP/$IMG_NAME" "$IMG_URL/$IMG_NAME"
  local line; line="$(awk -v n="$IMG_NAME" '$2==n || $2=="*" n {print $1 "  " n}' "$FETCH_TMP/SHA256SUMS")"
  [[ "$(wc -l <<<"$line")" == 1 && -n $line ]] || die "expected exactly one checksum line for $IMG_NAME, image discarded"
  ( cd "$FETCH_TMP" && sha256sum -c - <<<"$line" ) || die "checksum mismatch, image discarded"
  mv "$FETCH_TMP/$IMG_NAME" "$d/$IMG_NAME"; chmod 444 "$d/$IMG_NAME"
  note "verified. (Checksum comes from the same https origin; the GPG signature is not checked.)"
}

ensure_key() {
  local k="$LAB_HOME/keys/lab_ed25519"
  [[ -f $k ]] && return 0
  mkdir -p "$LAB_HOME/keys"; chmod 700 "$LAB_HOME/keys"
  ssh-keygen -q -t ed25519 -N '' -C "bothy-lab" -f "$k"   # lab-only key, no passphrase, never used elsewhere
}

cmd_up() {
  local name="${1:?usage: lab.sh up <profile>}"; profile "$name"
  ensure_kvm up "$name"
  is_running "$name" && die "$name is already running"
  [[ -f "$LAB_HOME/base/$IMG_NAME" ]] || die "no base image; run: lab.sh fetch"
  port_free "$PV_SSH" || die "host port $PV_SSH is in use"
  port_free "$PV_WEB" || die "host port $PV_WEB is in use"

  # The budget gate, used on ourselves: print the arithmetic, refuse if it does not fit.
  local need=$((PV_RAM + PV_OVH)) avail psi; avail="$(mem_available_mib)"; psi="$(mem_psi)"
  note "gate: MemAvailable ${avail} MiB - VM ${need} MiB (${PV_RAM} guest + ${PV_OVH} qemu) = $((avail - need)) MiB left; reserve ${RESERVE_MIB} MiB; pressure ${psi} (max ${PSI_MAX})"
  (( psi <= PSI_MAX )) || die "refused: the box is under memory pressure (some avg10 ${psi} > ${PSI_MAX})"
  (( avail - need >= RESERVE_MIB )) || die "refused: would leave the live stack under ${RESERVE_MIB} MiB. Stop something, or lower RESERVE_MIB knowingly."

  ensure_key
  local d; d="$(vmdir "$name")"; mkdir -p "$d"
  if [[ ! -f $d/disk.qcow2 ]]; then
    qemu-img create -q -f qcow2 -b "$LAB_HOME/base/$IMG_NAME" -F qcow2 "$d/disk.qcow2" "$PV_DISK"
  fi
  # cloud-init seed: user, ssh key, nothing else. The Bothy installer is run over ssh later, by hand.
  local pub; pub="$(awk '{print $1 " " $2}' "$LAB_HOME/keys/lab_ed25519.pub")"
  [[ $pub =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+$ ]] || die "unexpected public key format"   # also makes the sed below safe
  sed -e "s|@@HOSTNAME@@|$name|" -e "s|@@PUBKEY@@|$pub|" "$HERE/cloud-init/user-data.tpl" > "$d/user-data"
  [[ -f $d/instance-id ]] || echo "$name-$(date +%s)" > "$d/instance-id"   # stable: cloud-init does not re-run per boot
  printf 'instance-id: %s\nlocal-hostname: %s\n' "$(cat "$d/instance-id")" "$name" > "$d/meta-data"
  : > "$d/console.log"
  cloud-localds "$d/seed.iso" "$d/user-data" "$d/meta-data"

  # restrict=off is required for apt and image pulls, so the guest can reach host ports via 10.0.2.2.
  # cloud-init drops NEW guest->10.0.2.2 connections at every boot (defence in depth only: guest root can
  # undo it). Real isolation is measured by spike S15 (lab/README.md) before this lab is trusted.
  systemd-run --user --scope -q --unit "lab-$name-$$" \
    -p MemoryMax="${need}M" -p MemoryHigh="$((need * 95 / 100))M" -p MemorySwapMax=0 -p CPUQuota="$((PV_CPU * 100))%" \
    nice -n 10 qemu-system-x86_64 \
      -name "$name" -machine q35,accel=kvm -cpu host -smp "$PV_CPU" -m "$PV_RAM" \
      -nodefaults -device virtio-rng-pci \
      -drive "file=$d/disk.qcow2,if=virtio,format=qcow2,cache=none" \
      -drive "file=$d/seed.iso,if=virtio,format=raw,readonly=on,cache=none" \
      -netdev "user,id=n0,ipv6=off,hostfwd=tcp:127.0.0.1:${PV_SSH}-:22,hostfwd=tcp:127.0.0.1:${PV_WEB}-:80" \
      -device virtio-net-pci,netdev=n0 \
      -display none -serial "file:$d/console.log" -monitor none \
      -pidfile "$d/qemu.pid" -daemonize
  sleep 1
  is_running "$name" || die "qemu did not stay up; see $d/console.log"
  note "$name started. ssh: lab.sh ssh $name   (first boot takes about a minute)"
}

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o IdentitiesOnly=yes -o ConnectTimeout=5)
ssh_run() { local name="$1"; shift; profile "$name"; ssh -i "$LAB_HOME/keys/lab_ed25519" -p "$PV_SSH" "${SSH_OPTS[@]}" lab@127.0.0.1 "$@"; }
cmd_ssh() {
  local name="${1:?usage: lab.sh ssh <profile> [cmd...]}"; shift; profile "$name"
  exec ssh -i "$LAB_HOME/keys/lab_ed25519" -p "$PV_SSH" "${SSH_OPTS[@]}" lab@127.0.0.1 "$@"
}

cmd_status() {
  note "MemAvailable $(mem_available_mib) MiB"
  local any=0 d n
  for d in "$LAB_HOME"/vms/*/; do
    [[ -d $d ]] || continue; n="$(basename "$d")"; any=1
    if is_running "$n"; then note "$n: running (pid $(cat "$d/qemu.pid"), rss $(ps -o rss= -p "$(cat "$d/qemu.pid")" | awk '{print int($1/1024)}') MiB)"
    else note "$n: stopped"; fi
  done
  [[ $any = 1 ]] || note "no VMs"
}

cmd_down() {
  local name="${1:?usage: lab.sh down <profile>}"; profile "$name"
  is_running "$name" || { note "$name not running"; return 0; }
  local pid; pid="$(cat "$(vmdir "$name")/qemu.pid")"
  ssh_run "$name" sudo poweroff >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do is_running "$name" || { note "$name stopped"; return 0; }; sleep 1; done
  is_running "$name" && { kill -TERM "$pid"; note "$name did not power off in 30s; sent SIGTERM to qemu pid $pid"; }
}

cmd_reset() {  # delete the overlay disk only: back to a clean OS, keys and base kept
  local name="${1:?usage: lab.sh reset <profile>}"; profile "$name"
  is_running "$name" && die "stop it first: lab.sh down $name"
  rm -f "$(vmdir "$name")/disk.qcow2"; note "$name disk reset; next 'up' boots a clean OS"
}

cmd_destroy() {  # delete this VM's directory; refuses anything outside $LAB_HOME/vms
  local name="${1:?usage: lab.sh destroy <profile>}"; profile "$name"
  is_running "$name" && die "stop it first: lab.sh down $name"
  local d; d="$(vmdir "$name")"
  [[ -d $d && ! -L $d ]] || die "nothing to destroy"
  [[ "$(realpath -e "$d")" == "$(realpath -m "$LAB_HOME")/vms/$name" ]] || die "refusing: $d resolves outside the lab"
  rm -rf -- "$d"; note "$name destroyed (base image and key kept)"
}

case "${1:-help}" in
  check) cmd_check ;;
  fetch) cmd_fetch ;;
  up) shift; cmd_up "$@" ;;
  ssh) shift; cmd_ssh "$@" ;;
  status) cmd_status ;;
  down) shift; cmd_down "$@" ;;
  reset) shift; cmd_reset "$@" ;;
  destroy) shift; cmd_destroy "$@" ;;
  *) echo "usage: lab.sh check | fetch | up <profile> | ssh <profile> [cmd] | status | down <profile> | reset <profile> | destroy <profile>"; echo "profiles: lab-mini lab-std" ;;
esac
