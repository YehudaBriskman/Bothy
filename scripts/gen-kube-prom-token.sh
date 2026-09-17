#!/usr/bin/env bash
# Generate monitoring/kube-auth/token - the bearer token Prometheus presents to
# the thales-scc kubelet (jobs kubelet + kubelet-cadvisor in
# monitoring/scrape.d/kubernetes.yml).
#
# WHY A GENERATOR AND NOT A CHECKED-IN FILE: same reasoning as
# gen-portal-prom-route.sh. The token is a credential (narrow - get
# nodes/metrics, see k8s/monitoring/scraper-rbac.yaml - but a credential), and it
# only exists once the cluster does. So it is read from the cluster's
# `prometheus-scraper-token` Secret and written to a gitignored path.
#
# MODE 600, OWNED BY uid 65534. Prometheus runs as `nobody` inside its
# container, so a 600 file owned by devssh is unreadable to it and the kubelet
# jobs would just show DOWN - the exact failure bootstrap.sh documents for
# prom-password.txt, which it solved with 644. A token that can read node
# metrics does not need to be world-readable to work: chown it to 65534 through
# a throwaway container (docker access is root-equivalent anyway, and there is
# no setfacl on this box). devssh can still replace or delete it - it owns the
# directory - it just cannot `cat` it, which is fine: the Secret is the source.
#
# THE DIRECTORY IS MOUNTED, NOT THE FILE. The file is replaced by rename, which
# gives it a new inode; a file bind-mount would keep serving the old token
# (monitoring.md's inode gotcha). Prometheus re-reads credentials_file on every
# scrape, so a rotation needs no restart.
#
# Re-run after the cluster is rebuilt, or after deleting the Secret to revoke.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ctx="${KUBE_CONTEXT:-thales-scc}"
dir="$root/monitoring/kube-auth"
out="$dir/token"

token=""
for _ in $(seq 1 30); do
  token="$(kubectl --context "$ctx" -n monitoring get secret prometheus-scraper-token \
    -o go-template='{{if .data.token}}{{.data.token | base64decode}}{{end}}' 2>/dev/null || true)"
  [ -n "$token" ] && break
  sleep 1   # the token controller fills the Secret a moment after it is created
done
[ -n "$token" ] || { echo "no token in monitoring/prometheus-scraper-token on context $ctx - run 'just k8s-monitoring' first" >&2; exit 1; }

mkdir -p "$dir"
chmod 755 "$dir"
tmp="$(mktemp "$dir/.token.XXXXXX")"
( umask 077; printf '%s' "$token" > "$tmp" )
chmod 600 "$tmp"
docker run --rm -v "$dir:/d" alpine:3.20 chown 65534:65534 "/d/$(basename "$tmp")"
mv -f "$tmp" "$out"
echo "wrote $out (mode 600, uid 65534, gitignored)"
