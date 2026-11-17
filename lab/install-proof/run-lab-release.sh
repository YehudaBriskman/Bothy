#!/usr/bin/env bash
# run-lab-release.sh - host side of the REAL-release install proof. Takes a release tag,
# fetches the real assets with `gh` (authenticated on THIS host), verifies the checksum and
# the attestation here, and drives ONE lab VM through lab.sh. Nothing runs on this machine's
# Docker. No fake registry: the guest pulls the release's images anonymously from ghcr.io.
#
#   lab/install-proof/run-lab-release.sh <tag e.g. v2026.11.1> [profile]   (default lab-mid)
#
# KNOWN DEFECT worked around (REPAIR_CHECKSUMS=1, the default while it exists): a release whose
# checksums.txt has no `release-manifest.json` line is refused by `bothy install`. The proof then
# appends that line (sha256 of the real manifest) to a LOCAL copy of checksums.txt and points
# the binary at the two local files (--manifest/--checksums). Set REPAIR_CHECKSUMS=0 to prove the
# unmodified default path (the binary downloads both files from the release over https).
# SECOND DEFECT (same switch): the real manifest's third_party entries carry `tag` and `pinned_in`,
# and the binary's strict parser refuses unknown fields ("unknown field \"tag\""). The proof then
# uses a LOCAL manifest with only those two keys removed (digests untouched) and its own sha256 line.
# The binary and the images are always the real ones; the real manifest is verified (checksum and
# attestation) on the host before it is altered, and the guest is told which workarounds ran.
#
# For a second, clean pass: lab/lab.sh down <profile>; lab/lab.sh reset <profile>; run again.
set -euo pipefail
tag="${1:?release tag, e.g. v2026.11.1}"; prof="${2:-lab-mid}"
[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "run-lab-release: tag must look like v2026.11.1" >&2; exit 64; }
ver="${tag#v}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB="$HERE/../lab.sh"
REPO_SLUG="${REPO_SLUG:-YehudaBriskman/Bothy}"
REPAIR_CHECKSUMS="${REPAIR_CHECKSUMS:-1}"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
rel="$work/rel"; mkdir -p "$rel"
ts() { date +%s.%N; }
t_start=$(ts)

echo "run-lab-release: downloading $tag from $REPO_SLUG"
gh release download "$tag" -R "$REPO_SLUG" -D "$rel"
( cd "$rel" && sha256sum -c checksums.txt --ignore-missing )
arch=bothy_${ver}_linux_amd64.tar.gz
( cd "$rel" && for f in "$arch" checksums.txt release-manifest.json; do
    gh attestation verify "$f" -R "$REPO_SLUG" --format json >/dev/null && echo "attestation OK: $f"
  done )
mkdir -p "$work/bin" && tar -xzf "$rel/$arch" -C "$work/bin" bothy
mkdir -p "$work/local"; cp "$rel/release-manifest.json" "$rel/checksums.txt" "$work/local/"
repaired=0
if [[ $REPAIR_CHECKSUMS = 1 ]]; then
  # workaround 2: drop the keys the binary's strict parser refuses (only if the manifest has them)
  if jq -e '[.third_party[]|keys[]]|any(.!="ref" and .!="platforms")' "$rel/release-manifest.json" >/dev/null; then
    jq '.third_party |= map_values({ref})' "$rel/release-manifest.json" > "$work/local/release-manifest.json"
    echo "run-lab-release: WORKAROUND 2: LOCAL manifest has third_party tag/pinned_in removed (digests untouched)"; repaired=1
  fi
  msha="$(sha256sum "$work/local/release-manifest.json" | cut -d' ' -f1)"
  if [[ $repaired = 1 ]] || ! grep -q ' release-manifest.json$' "$rel/checksums.txt"; then
    grep -v ' release-manifest.json$' "$rel/checksums.txt" > "$work/local/checksums.txt" || true
    printf '%s  release-manifest.json\n' "$msha" >> "$work/local/checksums.txt"
    echo "run-lab-release: WORKAROUND 1: appended '$msha  release-manifest.json' to a LOCAL checksums.txt"; repaired=1
  fi
else echo "run-lab-release: REPAIR_CHECKSUMS=0: the binary will use the release's own files over https"; fi

st="$("$LAB" status 2>&1 || true)"; [[ $st == *"$prof: running"* ]] || "$LAB" up "$prof"
for _ in $(seq 1 90); do "$LAB" ssh "$prof" true 2>/dev/null && break; sleep 2; done
"$LAB" ssh "$prof" true || { echo "run-lab-release: guest did not come up" >&2; exit 1; }
t_up=$(ts)
g() { "$LAB" ssh "$prof" "$@"; }
if ! g 'command -v docker >/dev/null'; then
  echo "run-lab-release: installing docker.io docker-compose-v2 docker-buildx in the guest"
  g 'sudo cloud-init status --wait >/dev/null 2>&1; sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 docker-buildx >/dev/null && sudo usermod -aG docker lab' >&2
fi
t_docker=$(ts)
g 'mkdir -p ~/bin ~/proof/rel'
g 'cat > ~/bin/bothy && chmod +x ~/bin/bothy' < "$work/bin/bothy"          # the ONLY binary copied in
g 'cat > ~/proof/rel/release-manifest.json' < "$work/local/release-manifest.json"
g 'cat > ~/proof/rel/checksums.txt' < "$work/local/checksums.txt"
g 'cat > ~/proof/proof-release.sh && chmod +x ~/proof/proof-release.sh' < "$HERE/proof-release.sh"
echo "run-lab-release: guest before:"; g 'free -m | sed -n 1,2p; nproc; uname -r; docker --version; docker compose version --short; command -v gh || echo "gh: not installed in the guest"'
t_p0=$(ts); rc=0
# shellcheck disable=SC2088  # the guest shell expands ~
g "~/proof/proof-release.sh $ver ~/proof/rel $repaired" || rc=$?
t_end=$(ts)
awk -v a="$t_start" -v b="$t_up" -v c="$t_docker" -v d="$t_p0" -v e="$t_end" \
  'BEGIN{printf "run-lab-release timings: download+verify+boot %.0fs, docker install %.0fs, proof %.0fs, total %.0fs\n", b-a, c-b, e-d, e-a}'
exit $rc
