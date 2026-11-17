#!/usr/bin/env bash
# run-lab.sh - the host side of the install proof. Drives ONE lab VM through lab.sh
# (which enforces the memory gate); runs nothing on this machine's Docker.
#
#   lab/install-proof/run-lab.sh [profile]        (default lab-mid)
#
# 1. builds the CLI four times (versions 2026.11.0 .. 2026.11.3) for linux/amd64, static;
# 2. boots the VM (refused by lab.sh when the box is short of memory);
# 3. installs Docker in the guest from apt if it is missing (the only thing installed);
# 4. copies in: the four binaries, a `git archive` of HEAD, fake-release.sh, proof.sh;
# 5. runs fake-release.sh (registry, images, four faked releases), then proof.sh.
# The VM is left running; stop it with `lab/lab.sh down <profile>`. For a second,
# clean pass: down, `lab/lab.sh reset <profile>`, run this again.
set -euo pipefail
prof="${1:-lab-mid}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
LAB="$REPO/lab/lab.sh"
GO="${GO:-$HOME/.local/share/mise/installs/go/latest/bin/go}"
out="$(mktemp -d)"; trap 'rm -rf "$out"' EXIT
ts() { date +%s.%N; }
t_start=$(ts)

head="$(git -C "$REPO" rev-parse HEAD)"; prev="$(git -C "$REPO" rev-parse HEAD~1)"
for v in 2026.11.0 2026.11.1 2026.11.2 2026.11.3; do
  ( cd "$REPO/cli" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOFLAGS=-mod=mod "$GO" build -trimpath \
      -ldflags "-s -w -X main.version=$v -X main.commit=$head" -o "$out/bothy-$v" ./cmd/bothy )
done
git -C "$REPO" archive --format=tar HEAD > "$out/src.tar"
traefik="$(sed -n 's/^ *image: *\(traefik:[^ ]*@sha256:[0-9a-f]\{64\}\).*/\1/p' "$REPO/edge/compose.yml" | head -1)"
[[ -n $traefik ]] || { echo "run-lab: cannot read the pinned traefik ref" >&2; exit 1; }
echo "run-lab: head $head, traefik $traefik, binaries $(du -h "$out/bothy-2026.11.0" | cut -f1)"

"$LAB" up "$prof"
for _ in $(seq 1 90); do "$LAB" ssh "$prof" true 2>/dev/null && break; sleep 2; done
"$LAB" ssh "$prof" true || { echo "run-lab: guest did not come up" >&2; exit 1; }
t_up=$(ts)

g() { "$LAB" ssh "$prof" "$@"; }
if ! g 'command -v docker >/dev/null'; then
  echo "run-lab: installing docker.io docker-compose-v2 docker-buildx in the guest"
  g 'sudo cloud-init status --wait >/dev/null 2>&1; sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 docker-buildx >/dev/null && sudo usermod -aG docker lab' >&2
fi
t_docker=$(ts)
g 'mkdir -p ~/bin ~/proof'
for v in 2026.11.0 2026.11.1 2026.11.2 2026.11.3; do g "cat > ~/bin/bothy-$v && chmod +x ~/bin/bothy-$v" < "$out/bothy-$v"; done
g 'cat > ~/proof/src.tar' < "$out/src.tar"
g 'cat > ~/proof/fake-release.sh && chmod +x ~/proof/fake-release.sh' < "$HERE/fake-release.sh"
g 'cat > ~/proof/proof.sh && chmod +x ~/proof/proof.sh' < "$HERE/proof.sh"
echo "run-lab: guest memory before:"; g 'free -m | sed -n 1,2p; nproc; uname -r; docker --version; docker compose version --short'
t_fake0=$(ts)
# shellcheck disable=SC2088  # the guest shell expands ~
g "~/proof/fake-release.sh ~/proof/src.tar $head $prev $traefik ~/proof/rel"
t_fake1=$(ts)
rc=0
# shellcheck disable=SC2088
g '~/proof/proof.sh ~/proof/rel' || rc=$?
t_end=$(ts)
awk -v a="$t_start" -v b="$t_up" -v c="$t_docker" -v d="$t_fake0" -v e="$t_fake1" -v f="$t_end" \
  'BEGIN{printf "run-lab timings: boot+ssh %.0fs, docker install %.0fs, fake release build %.0fs, proof %.0fs, total %.0fs\n", b-a, c-b, e-d, f-e, f-a}'
echo "run-lab: guest memory after:"; g 'free -m | sed -n 1,2p'
exit $rc
