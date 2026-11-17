#!/usr/bin/env bash
# fake-release.sh - runs INSIDE a lab guest, never on the live box.
#
# Stands in for the release pipeline (the D34 agent's GHCR publish) until real
# images exist: starts a throwaway registry on localhost:5000, builds the two own
# images (bothy-web, bothy-files) from a source tarball, pushes them, and writes
# the files a release carries next to the binary: release-manifest.json and
# checksums.txt. After it runs, the guest has NO local copy of the images (they
# are removed), so `bothy install` must really pull them by digest.
#
# It writes FOUR releases under <outdir>/<version>/ so `bothy update` can be
# proven, including its failure paths:
#   2026.11.0  the base release (web revision = commit A)
#   2026.11.1  a good second release: a web image that differs in index.html AND
#              /version.json (commit B); files and traefik are unchanged
#   2026.11.2  a FORCED FAILURE: web names a digest the registry does not have
#   2026.11.3  a FORCED FAILURE: web is a container that starts and never becomes
#              healthy (its command is `sleep`; nothing listens on 8080)
#
#   fake-release.sh <src.tar> <commitA-40hex> <commitB-40hex> <traefik-ref-with-digest> <outdir>
set -euo pipefail
src="${1:?source tar (git archive)}"; ca="${2:?commit A}"; cb="${3:?commit B}"; traefik="${4:?traefik@sha256:...}"; out="${5:?outdir}"
for c in "$ca" "$cb"; do [[ $c =~ ^[0-9a-f]{40}$ ]] || { echo "commit must be 40 hex" >&2; exit 64; }; done
[[ $traefik =~ @sha256:[0-9a-f]{64}$ ]] || { echo "traefik ref needs a digest" >&2; exit 64; }
work="$(mktemp -d)"; mkdir -p "$out"
tar -xf "$src" -C "$work"
R=localhost:5000

docker rm -f fake-ghcr >/dev/null 2>&1 || true
docker run -d --name fake-ghcr --restart unless-stopped -p 127.0.0.1:5000:5000 registry:2 >/dev/null
for _ in $(seq 1 20); do curl -fsS http://127.0.0.1:5000/v2/ >/dev/null 2>&1 && break; sleep 1; done

digest_of() { docker inspect --format '{{index .RepoDigests 0}}' "$1"; }
push() { docker push -q "$1" >/dev/null; digest_of "$1"; }   # -> localhost:5000/name@sha256:...

# --- release A: the two own images, built from the source tarball
docker build -q --build-arg "REVISION=$ca" -t $R/bothy-web:a "$work/apps/bothy-web" >/dev/null
webA="$(push $R/bothy-web:a)"
docker build -q --build-arg "REVISION=$ca" -f "$work/apps/bothy-files/Dockerfile" -t $R/bothy-files:a "$work/apps" >/dev/null
files="$(push $R/bothy-files:a)"

# --- release B: web = A plus a changed index.html and a new revision
ctx="$work/ctx-b"; mkdir -p "$ctx"
cat > "$ctx/Dockerfile" <<EOF
FROM $webA
USER root
RUN printf '{"revision":"$cb"}\n' > /usr/share/nginx/html/version.json \
 && printf '\n<!-- release 2026.11.1 -->\n' >> /usr/share/nginx/html/index.html
USER 101
EOF
docker build -q -t $R/bothy-web:b "$ctx" >/dev/null
webB="$(push $R/bothy-web:b)"

# --- release D: web that never becomes healthy (starts, listens on nothing)
ctx="$work/ctx-d"; mkdir -p "$ctx"
printf 'FROM %s\nCMD ["sleep","3600"]\n' "$webA" > "$ctx/Dockerfile"
docker build -q -t $R/bothy-web:d "$ctx" >/dev/null
webD="$(push $R/bothy-web:d)"

# nothing may be cached locally: install must really pull
for t in $R/bothy-web:a $R/bothy-web:b $R/bothy-web:d $R/bothy-files:a; do docker rmi "$t" >/dev/null 2>&1 || true; done
for r in "$webA" "$webB" "$webD" "$files"; do docker rmi "$r" >/dev/null 2>&1 || true; done
docker image prune -f >/dev/null
rm -rf "$work"

absent="$R/bothy-web@sha256:$(printf 'e%.0s' $(seq 1 64))"   # well-formed, not in the registry
manifest() { # dir version commit web
  mkdir -p "$out/$1"
  cat > "$out/$1/release-manifest.json" <<EOF
{"schema":1,"version":"$1","commit":"$2",
 "images":{"bothy-web":{"ref":"$3","platforms":["linux/amd64"]},
           "bothy-files":{"ref":"$files","platforms":["linux/amd64"]}},
 "third_party":{"traefik":{"ref":"$traefik"}},
 "assets":{"cli":"checksums.txt"}}
EOF
  ( cd "$out/$1" && sha256sum release-manifest.json > checksums.txt )
}
manifest 2026.11.0 "$ca" "$webA"
manifest 2026.11.1 "$cb" "$webB"
manifest 2026.11.2 "$cb" "$absent"
manifest 2026.11.3 "$cb" "$webD"
echo "fake releases written to $out:"; for v in 2026.11.0 2026.11.1 2026.11.2 2026.11.3; do echo "  $v: $(cut -c1-16 "$out/$v/checksums.txt")..."; done
