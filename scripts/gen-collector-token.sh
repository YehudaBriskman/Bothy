#!/usr/bin/env bash
# Issue bothy-collector's cluster credential: apps/bothy-collector/secrets/kubeconfig.
#
#   just collector-token            apply the RBAC, create the token if absent, write the kubeconfig
#   just collector-token --rotate   delete the token Secret first (revokes the old one)
#   just collector-token --revoke   delete the token Secret and the local kubeconfig, and stop
#
# The same shape as scripts/gen-kube-token.sh and scripts/gen-headlamp-token.sh,
# deliberately - read the first of those for why this is a LONG-LIVED
# ServiceAccount token Secret rather than a bound `kubectl create token
# --duration` token (an unattended box; exact, immediate revocation).
#
# ── what this replaced ──────────────────────────────────────────────────────
#
# Nothing. Until 2026-09-23 the collector had no cluster identity: its host timer
# ran collect.py as devssh, which meant ~/.kube/config, which on minikube is the
# admin client certificate - `minikube-user` in group `system:masters`. That
# group is checked BEFORE RBAC and short-circuits it, so the 30-second discovery
# timer could read every Secret in the cluster, exec into any pod and delete the
# cluster. It used none of that: `kubectl get` on five kinds, listed, never by
# name, never written. apps/bothy-collector/reads.toml is that list, and
# k8s/rbac/bothy-collector.yaml is generated from it.
#
# ── the kubeconfig ──────────────────────────────────────────────────────────
#
# collect.py SHELLS OUT to kubectl, so the credential has to be a kubeconfig
# rather than a bare token, and its context has to be named `thales-scc` because
# every call names that context explicitly (collect.py's K8S_CONTEXT - without it
# kubectl follows `current-context`, and a bare `minikube start` steals that).
# It carries:
#   server  https://192.168.49.2:8443 - the node's FIXED address on docker
#           network `thales-scc`, reachable from the host, and the address
#           ~/.kube/config itself uses. Not the 127.0.0.1:<random> form some
#           minikube versions write, which changes on every `minikube start`.
#           Override with BOTHY_COLLECTOR_KUBE_API if the cluster moves.
#   CA      the cluster CA, embedded - TLS verification stays ON.
#   token   the ServiceAccount token.
#
# Mode 600 in a mode 700 gitignored directory, owned by devssh - the same user
# the timer runs as. collect.py reads it from beside itself and falls back to the
# ambient kubeconfig (saying so on stderr) when it is absent, so a fresh clone
# still renders a cluster panel before anybody has run this.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ctx="${KUBE_CONTEXT:-thales-scc}"
api="${BOTHY_COLLECTOR_KUBE_API:-https://192.168.49.2:8443}"
out="$root/apps/bothy-collector/secrets"
sa="system:serviceaccount:bothy:bothy-collector"
kc=(kubectl --context "$ctx")

command -v kubectl >/dev/null || { echo "kubectl not found" >&2; exit 1; }
"${kc[@]}" get --raw /readyz >/dev/null 2>&1 || {
  echo "cluster context '$ctx' is not reachable - is minikube -p $ctx running?" >&2; exit 1; }

if [ "${1:-}" = "--revoke" ]; then
  "${kc[@]}" -n bothy delete secret bothy-collector-token --ignore-not-found
  rm -f "$out/kubeconfig"
  echo "revoked: the Secret is deleted and the local kubeconfig removed."
  echo "NOTE: collect.py then falls back to the ambient kubeconfig, which on this box is"
  echo "an ADMIN certificate. To take the cluster away from the collector instead, delete"
  echo "the ClusterRoleBinding: kubectl --context $ctx delete clusterrolebinding bothy-collector"
  exit 0
fi

# Additive and idempotent. A token for an account with no binding would
# authenticate and then see nothing - which in the portal looks like a box with
# no cluster, not like a permissions problem.
"${kc[@]}" apply -f "$root/k8s/rbac/bothy-collector.yaml"

if [ "${1:-}" = "--rotate" ]; then
  "${kc[@]}" -n bothy delete secret bothy-collector-token --ignore-not-found
fi

"${kc[@]}" apply -f - <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: bothy-collector-token
  namespace: bothy
  labels:
    app.kubernetes.io/part-of: bothy
    app.kubernetes.io/name: bothy-collector
  annotations:
    kubernetes.io/service-account.name: bothy-collector
type: kubernetes.io/service-account-token
YAML

# The token controller fills .data.token asynchronously.
tok=""
for _ in $(seq 1 40); do
  tok="$("${kc[@]}" -n bothy get secret bothy-collector-token -o jsonpath='{.data.token}' 2>/dev/null || true)"
  [ -n "$tok" ] && break
  sleep 0.5
done
[ -n "$tok" ] || { echo "the token controller never populated bothy/bothy-collector-token" >&2; exit 1; }
ca_b64="$("${kc[@]}" -n bothy get secret bothy-collector-token -o jsonpath='{.data.ca\.crt}')"

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
  - name: bothy-collector
    user:
      token: $TOKEN
contexts:
  - name: $CTX
    context:
      cluster: $CTX
      user: bothy-collector
current-context: $CTX
EOF' _ "$out/kubeconfig.tmp"
chmod 600 "$out/kubeconfig.tmp"
mv -f "$out/kubeconfig.tmp" "$out/kubeconfig"

echo
echo "wrote $out/kubeconfig (mode 600, server $api)"

# Prove the credential itself, not just that a port answers: the one call the
# collector makes first, through the file it will actually read, naming the
# context it will actually name. A kubeconfig that parses and cannot list
# namespaces renders as a box with no cluster.
if kubectl --kubeconfig "$out/kubeconfig" --context "$ctx" get namespaces -o name >/dev/null 2>&1; then
  echo "  the collector's own first call (get namespaces) succeeds with it"
else
  echo "$out/kubeconfig cannot list namespaces - is $api reachable from this host?" >&2
  exit 1
fi

echo
echo "what $sa may do (the rows are GENERATED from apps/bothy-collector/reads.toml"
echo "into scripts/lib/bothy-collector-probes.sh - every declared read, then the refusals):"
fail=0
probe() { # expect verb resource[/subresource] namespace | -A | -
  local got res="$3" sub=() scope=()
  case "$4" in
    -A) scope=(-A) ;;
    -)  scope=() ;;
    *)  scope=(-n "$4") ;;
  esac
  case "$3" in */*) res="${3%%/*}"; sub=(--subresource="${3#*/}") ;; esac
  got="$(kubectl --context "$ctx" auth can-i "$2" "$res" ${sub[@]+"${sub[@]}"} ${scope[@]+"${scope[@]}"} --as="$sa" 2>/dev/null || true)"
  printf '  %-4s %-16s %-40s %-16s %s\n' "$got" "$2" "$3" "$4" "$([ "$got" = "$1" ] && echo ok || echo 'UNEXPECTED')"
  [ "$got" = "$1" ] || fail=1
}
# shellcheck source=scripts/lib/bothy-collector-probes.sh
. "$root/scripts/lib/bothy-collector-probes.sh"
exit $fail
