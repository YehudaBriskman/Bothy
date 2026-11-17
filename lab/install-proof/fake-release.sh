#!/usr/bin/env bash
# fake-release.sh - runs INSIDE a lab guest, never on the live box.
#
# Stands in for the release pipeline (the D34 agent's GHCR publish) until real
# images exist: starts a throwaway registry on localhost:5000, builds the one own
# image (bothy-web) from a source tarball, pushes it, and writes the two files a
# release carries next to the binary: release-manifest.json and checksums.txt.
# After it runs, the guest has NO local copy of the images (they are removed), so
# `bothy install` must really pull them by digest from the registry.
#
#   fake-release.sh <web-src.tar> <commit-40hex> <traefik-ref-with-digest> <outdir>
set -euo pipefail
src="${1:?web source tar}"; commit="${2:?40-hex commit}"; traefik="${3:?traefik@sha256:...}"; out="${4:?outdir}"
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "commit must be 40 hex" >&2; exit 64; }
[[ $traefik =~ @sha256:[0-9a-f]{64}$ ]] || { echo "traefik ref needs a digest" >&2; exit 64; }
work="$(mktemp -d)"; mkdir -p "$out"
tar -xf "$src" -C "$work"

docker rm -f fake-ghcr >/dev/null 2>&1 || true
docker run -d --name fake-ghcr --restart unless-stopped -p 127.0.0.1:5000:5000 registry:2 >/dev/null
for _ in $(seq 1 20); do curl -fsS http://127.0.0.1:5000/v2/ >/dev/null 2>&1 && break; sleep 1; done

docker build -q --build-arg "REVISION=$commit" -t localhost:5000/bothy-web:build "$work/apps/bothy-web" >/dev/null
docker push -q localhost:5000/bothy-web:build >/dev/null
digest="$(docker inspect --format '{{index .RepoDigests 0}}' localhost:5000/bothy-web:build)"   # localhost:5000/bothy-web@sha256:...
[[ $digest =~ ^localhost:5000/bothy-web@sha256:[0-9a-f]{64}$ ]] || { echo "unexpected digest ref: $digest" >&2; exit 1; }
docker rmi localhost:5000/bothy-web:build >/dev/null
docker rmi "$digest" >/dev/null 2>&1 || true
docker image prune -f >/dev/null
rm -rf "$work"

cat > "$out/release-manifest.json" <<EOF
{"schema":1,"version":"2026.11.0","commit":"$commit",
 "images":{"bothy-web":{"ref":"$digest","platforms":["linux/amd64"]}},
 "third_party":{"traefik":{"ref":"$traefik"}},
 "assets":{"cli":"checksums.txt"}}
EOF
( cd "$out" && sha256sum release-manifest.json > checksums.txt )
echo "fake release written to $out:"; cat "$out/checksums.txt"
