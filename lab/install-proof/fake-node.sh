#!/usr/bin/env bash
# fake-node.sh - runs INSIDE a lab guest, never on the live box, after fake-release.sh.
#
# The real releases published so far carry no node-exporter in third_party (the module
# catalogue is newer than them), so the module proof cannot use a real release for
# node-metrics. This script is the FAKE-RELEASE path, labelled as such: it takes the
# repo's pinned node-exporter image (pulled by digest from its real registry), pushes it
# to the guest's throwaway registry, and rewrites the fake manifests to name it.
#
#   2026.11.0, 2026.11.1  third_party gains node-exporter = the real image (re-pushed)
#   2026.11.4             release 2026.11.0 whose node-exporter is a SICK image: it starts
#                         and listens on nothing, so a module add must fail its health
#                         gate and roll back
#
#   fake-node.sh <node-exporter-ref-with-digest> <releases-dir>
set -euo pipefail
node="${1:?prom/node-exporter:tag@sha256:...}"; rel="${2:?releases dir}"
[[ $node =~ @sha256:[0-9a-f]{64}$ ]] || { echo "node-exporter ref needs a digest" >&2; exit 64; }
R=localhost:5000
docker pull -q "$node" >/dev/null
docker tag "$node" $R/node-exporter:good
docker push -q $R/node-exporter:good >/dev/null
good="$(docker inspect --format '{{index .RepoDigests 0}}' $R/node-exporter:good)"
ctx="$(mktemp -d)"
printf 'FROM busybox:1.36\nCMD ["sleep","3600"]\n' > "$ctx/Dockerfile"
docker build -q -t $R/node-exporter:sick "$ctx" >/dev/null
docker push -q $R/node-exporter:sick >/dev/null
sick="$(docker inspect --format '{{index .RepoDigests 0}}' $R/node-exporter:sick)"
rm -rf "$ctx"
for t in $R/node-exporter:good $R/node-exporter:sick "$node" "$good" "$sick"; do docker rmi "$t" >/dev/null 2>&1 || true; done
docker image prune -f >/dev/null

add() { # dir ref
  sed -i "s|\"third_party\":{\"traefik\":{\"ref\":\"\([^\"]*\)\"}}|\"third_party\":{\"traefik\":{\"ref\":\"\1\"},\"node-exporter\":{\"ref\":\"$2\"}}|" "$rel/$1/release-manifest.json"
  grep -q node-exporter "$rel/$1/release-manifest.json" || { echo "manifest $1 not patched" >&2; exit 1; }
  ( cd "$rel/$1" && sha256sum release-manifest.json > checksums.txt )
}
mkdir -p "$rel/2026.11.4"
sed 's/"version":"2026.11.0"/"version":"2026.11.4"/' "$rel/2026.11.0/release-manifest.json" > "$rel/2026.11.4/release-manifest.json"
add 2026.11.0 "$good"
add 2026.11.1 "$good"
add 2026.11.4 "$sick"
echo "node-exporter fake releases: good $good"
echo "                             sick $sick"
