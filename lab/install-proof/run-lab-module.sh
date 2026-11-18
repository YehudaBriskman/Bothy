#!/usr/bin/env bash
# run-lab-module.sh - the host side of the module proof. Drives ONE lab VM through lab.sh
# (which enforces the memory gate); runs nothing on this machine's Docker. FAKE-RELEASE
# path: see fake-node.sh for why (no published release carries node-exporter yet).
#
#   lab/install-proof/run-lab-module.sh [profile]        (default lab-mid)
#
# Builds the CLI for 2026.11.0, .1 and .4, boots the VM if it is not already running (it
# never stops or resets one), copies in the scripts, runs fake-release.sh, fake-node.sh,
# then module-proof.sh. The VM is left running: stop YOUR VM with lab/lab.sh down <profile>.
set -euo pipefail
prof="${1:-lab-mid}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
LAB="$REPO/lab/lab.sh"
GO="${GO:-$HOME/.local/share/mise/installs/go/latest/bin/go}"
out="$(mktemp -d)"; trap 'rm -rf "$out"' EXIT
head="$(git -C "$REPO" rev-parse HEAD)"; prev="$(git -C "$REPO" rev-parse HEAD~1)"
for v in 2026.11.0 2026.11.1 2026.11.4; do
  ( cd "$REPO/cli" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOFLAGS=-mod=mod "$GO" build -trimpath \
      -ldflags "-s -w -X main.version=$v -X main.commit=$head" -o "$out/bothy-$v" ./cmd/bothy )
done
git -C "$REPO" archive --format=tar HEAD > "$out/src.tar"
traefik="$(sed -n 's/^ *image: *\(traefik:[^ ]*@sha256:[0-9a-f]\{64\}\).*/\1/p' "$REPO/edge/compose.yml" | head -1)"
node="$(sed -n 's/^ *image: *\(prom\/node-exporter:[^ ]*@sha256:[0-9a-f]\{64\}\).*/\1/p' "$REPO/monitoring/compose.yml" | head -1)"
[[ -n $traefik && -n $node ]] || { echo "run-lab-module: cannot read the pinned refs" >&2; exit 1; }

st="$("$LAB" status 2>&1 || true)"; [[ $st == *"$prof: running"* ]] || "$LAB" up "$prof"
for _ in $(seq 1 90); do "$LAB" ssh "$prof" true 2>/dev/null && break; sleep 2; done
g() { "$LAB" ssh "$prof" "$@"; }
g true || { echo "run-lab-module: guest did not come up" >&2; exit 1; }
if ! g 'command -v docker >/dev/null'; then
  g 'sudo cloud-init status --wait >/dev/null 2>&1; sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 docker-buildx >/dev/null && sudo usermod -aG docker lab' >&2
fi
g 'mkdir -p ~/bin ~/proof; docker ps -aq --filter label=com.docker.compose.project=bothy | xargs -r docker rm -f >/dev/null; rm -rf ~/.local/share/bothy ~/.config/bothy'
for v in 2026.11.0 2026.11.1 2026.11.4; do g "cat > ~/bin/bothy-$v && chmod +x ~/bin/bothy-$v" < "$out/bothy-$v"; done
g 'cat > ~/proof/src.tar' < "$out/src.tar"
for f in fake-release.sh fake-node.sh module-proof.sh; do g "cat > ~/proof/$f && chmod +x ~/proof/$f" < "$HERE/$f"; done
echo "run-lab-module: guest memory before:"; g 'free -m | sed -n 1,2p'
# shellcheck disable=SC2088
g "~/proof/fake-release.sh ~/proof/src.tar $head $prev $traefik ~/proof/rel"
# shellcheck disable=SC2088
g "~/proof/fake-node.sh $node ~/proof/rel"
rc=0
# shellcheck disable=SC2088
g '~/proof/module-proof.sh ~/proof/rel' || rc=$?
echo "run-lab-module: guest memory after:"; g 'free -m | sed -n 1,2p'
exit $rc
