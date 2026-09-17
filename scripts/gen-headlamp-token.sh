#!/usr/bin/env bash
# Issue Headlamp's cluster credential: apps/headlamp/secrets/kubeconfig.
#
#   just headlamp-token            apply the RBAC, create the token if absent, write the kubeconfig
#   just headlamp-token --rotate   delete the token Secret first (revokes the old one)
#   just headlamp-token --revoke   delete the token Secret and the local kubeconfig, and stop
#
# The same shape as scripts/gen-kube-token.sh, deliberately - read that file's
# header for why this is a LONG-LIVED ServiceAccount token Secret rather than a
# bound `kubectl create token --duration` token (an unattended box, exact and
# immediate revocation). The difference is the account: `bothy/bothy-browse`,
# bound to the built-in `view` ClusterRole (k8s/rbac/bothy-browse.yaml). It can
# read the cluster and change nothing, and it cannot read a Secret - including
# its own (checked below).
#
# ── the kubeconfig ──────────────────────────────────────────────────────────
#
# Headlamp runs with -in-cluster=false and reads ONE kubeconfig. It carries:
#   server  https://192.168.49.2:8443 - the apiserver as seen from the docker
#           network `thales-scc`, NOT the 127.0.0.1:<random> host port in
#           ~/.kube/config (that one changes on every `minikube start` and is
#           loopback on the HOST, which a container cannot reach). Override with
#           HEADLAMP_KUBE_API if the cluster is ever rebuilt on another address.
#   CA      the cluster CA, embedded - TLS verification stays ON. The serving
#           cert carries 192.168.49.2 as a SAN (verified 2026-09-17).
#   token   the ServiceAccount token.
#
# Mode 600 inside a mode 700 gitignored directory, owned by whoever runs this.
# apps/headlamp/compose.yml runs the container as ${PUID:-1000}:${PGID:-1000},
# i.e. as that same user, so no chown to the image's own uid (100) is needed and
# rotation never needs root.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ctx="${KUBE_CONTEXT:-thales-scc}"
api="${HEADLAMP_KUBE_API:-https://192.168.49.2:8443}"
out="$root/apps/headlamp/secrets"
sa="system:serviceaccount:bothy:bothy-browse"
kc=(kubectl --context "$ctx")

command -v kubectl >/dev/null || { echo "kubectl not found" >&2; exit 1; }
"${kc[@]}" get --raw /readyz >/dev/null 2>&1 || {
  echo "cluster context '$ctx' is not reachable - is minikube -p $ctx running?" >&2; exit 1; }

if [ "${1:-}" = "--revoke" ]; then
  "${kc[@]}" -n bothy delete secret bothy-browse-token --ignore-not-found
  rm -f "$out/kubeconfig"
  echo "revoked: the Secret is deleted and the local kubeconfig removed. Headlamp now shows no cluster."
  exit 0
fi

# Additive and idempotent. A token for an account with no binding would
# authenticate and then see nothing - which in Headlamp looks like an empty
# cluster, not like a permissions problem.
"${kc[@]}" apply -f "$root/k8s/rbac/bothy-browse.yaml"

if [ "${1:-}" = "--rotate" ]; then
  "${kc[@]}" -n bothy delete secret bothy-browse-token --ignore-not-found
fi

"${kc[@]}" apply -f - <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: bothy-browse-token
  namespace: bothy
  labels:
    app.kubernetes.io/part-of: bothy
    app.kubernetes.io/name: headlamp
  annotations:
    kubernetes.io/service-account.name: bothy-browse
type: kubernetes.io/service-account-token
YAML

# The token controller fills .data.token asynchronously.
tok=""
for _ in $(seq 1 40); do
  tok="$("${kc[@]}" -n bothy get secret bothy-browse-token -o jsonpath='{.data.token}' 2>/dev/null || true)"
  [ -n "$tok" ] && break
  sleep 0.5
done
[ -n "$tok" ] || { echo "the token controller never populated bothy/bothy-browse-token" >&2; exit 1; }
ca_b64="$("${kc[@]}" -n bothy get secret bothy-browse-token -o jsonpath='{.data.ca\.crt}')"

umask 077
mkdir -p "$out"
chmod 700 "$out"
# The token goes in through the environment and printf, never onto a command
# line where `ps` would show it.
TOKEN="$(printf '%s' "$tok" | base64 -d)" CA="$ca_b64" API="$api" CTX="$ctx" \
  bash -c 'cat > "$1" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: $CTX
    cluster:
      server: $API
      certificate-authority-data: $CA
users:
  - name: bothy-browse
    user:
      token: $TOKEN
contexts:
  - name: $CTX
    context:
      cluster: $CTX
      user: bothy-browse
current-context: $CTX
EOF' _ "$out/kubeconfig.tmp"
chmod 600 "$out/kubeconfig.tmp"
mv -f "$out/kubeconfig.tmp" "$out/kubeconfig"

echo
echo "wrote $out/kubeconfig (mode 600, server $api)"

# The server address must be reachable from where Headlamp sits - on the docker
# network, not the host. A TCP connect is enough here; that the token itself
# authenticates is what the can-i table below and Headlamp's own namespace list
# prove. Only checkable while the network exists, which it does whenever the
# cluster answered above.
hostport="${api#https://}"
if docker network inspect thales-scc >/dev/null 2>&1; then
  if docker run --rm --network thales-scc alpine:3.20 nc -z -w 3 "${hostport%:*}" "${hostport##*:}" >/dev/null 2>&1; then
    echo "  $hostport answers from docker network thales-scc"
  else
    echo "$api is not reachable from docker network thales-scc - set HEADLAMP_KUBE_API" >&2; exit 1
  fi
fi

echo
echo "what $sa may do (must match k8s/rbac/bothy-browse.yaml):"
fail=0
probe() { # expect verb resource namespace(-A for all)
  local got ns=(-n "$4")
  [ "$4" = "-A" ] && ns=(-A)
  got="$("${kc[@]}" auth can-i "$2" "$3" "${ns[@]}" --as="$sa" 2>/dev/null || true)"
  printf '  %-4s %-8s %-22s %-16s %s\n' "$got" "$2" "$3" "$4" "$([ "$got" = "$1" ] && echo ok || echo 'UNEXPECTED')"
  [ "$got" = "$1" ] || fail=1
}
probe yes list   pods                    -A
probe yes get    deployments.apps        kube-system
probe yes list   events                  thales-dev
probe yes get    pods/log                thales-dev
probe no  get    secrets                 thales-dev
probe no  list   secrets                 -A
probe no  get    secrets                 bothy
probe no  create pods/exec               thales-dev
probe no  create pods/attach             thales-dev
probe no  create pods/portforward        thales-dev
probe no  patch  deployments.apps        thales-dev
probe no  delete pods                    thales-dev
probe no  create pods                    thales-dev
probe no  list   roles.rbac.authorization.k8s.io -A
exit $fail
