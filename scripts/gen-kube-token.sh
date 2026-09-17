#!/usr/bin/env bash
# Issue bothy-ops' cluster credential: apps/bothy-ops/secrets/{token,ca.crt}.
#
# The in-cluster identity is still the ServiceAccount bothy/bothy-kube (and its
# token Secret bothy-kube-token). The CONTAINER was renamed when bothy-kube merged
# into bothy-ops (2026-09); the cluster identity deliberately was not - renaming
# it would revoke the live token and re-issue the same grants under a new name.
#
#   just kube-token            apply the RBAC, create the token if absent, write files
#   just kube-token --rotate   delete the token Secret first (revokes the old one)
#   just kube-token --revoke   delete the token Secret and the local files, and stop
#
# ── which kind of token, and why ────────────────────────────────────────────
#
# A LONG-LIVED ServiceAccount token Secret (type kubernetes.io/service-account-
# token) in namespace `bothy`, rather than `kubectl create token --duration`.
#
#   · This box runs unattended (the Windows keepalive task, cold boots). A bound
#     token expires on a schedule nobody is watching, and the failure is not an
#     alert - it is every button in the cluster panel answering "the cluster
#     refused bothy-ops" some morning months from now. The apiserver may also
#     cap the duration (--service-account-max-token-expiration), so "8760h" is a
#     request, not a promise.
#   · Revocation is exact and immediate: delete the Secret and the token stops
#     authenticating. A bound token cannot be revoked short of deleting the
#     ServiceAccount (which breaks the RoleBindings' subject) or rotating the
#     cluster's signing key.
#   · What it can do is bounded by the Role, not by its lifetime. It cannot exec,
#     port-forward or read a Secret - including its own (checked below).
#
# The trade is that a copy that leaks stays valid until somebody runs --rotate.
# The copy lives mode 600 in a mode 700 gitignored directory, mounted read-only
# into one container that publishes no port.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ctx="${KUBE_CONTEXT:-thales-scc}"
out="$root/apps/bothy-ops/secrets"
sa="system:serviceaccount:bothy:bothy-kube"
kc=(kubectl --context "$ctx")

command -v kubectl >/dev/null || { echo "kubectl not found" >&2; exit 1; }
"${kc[@]}" get --raw /readyz >/dev/null 2>&1 || {
  echo "cluster context '$ctx' is not reachable - is minikube -p $ctx running?" >&2; exit 1; }

if [ "${1:-}" = "--revoke" ]; then
  "${kc[@]}" -n bothy delete secret bothy-kube-token --ignore-not-found
  rm -f "$out/token" "$out/ca.crt"
  echo "revoked: the Secret is deleted and the local copy removed. bothy-ops' kube verbs now answer 503."
  exit 0
fi

# The RBAC is additive and idempotent, and a token for an account whose Role is
# missing would be a credential that authenticates and can do nothing - which
# reads, from the page, exactly like a broken service.
"${kc[@]}" apply -f "$root/k8s/rbac/bothy-kube.yaml"

if [ "${1:-}" = "--rotate" ]; then
  "${kc[@]}" -n bothy delete secret bothy-kube-token --ignore-not-found
fi

"${kc[@]}" apply -f - <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: bothy-kube-token
  namespace: bothy
  labels:
    app.kubernetes.io/part-of: bothy
  annotations:
    kubernetes.io/service-account.name: bothy-kube
type: kubernetes.io/service-account-token
YAML

# The token controller fills .data.token asynchronously.
tok=""
for _ in $(seq 1 40); do
  tok="$("${kc[@]}" -n bothy get secret bothy-kube-token -o jsonpath='{.data.token}' 2>/dev/null || true)"
  [ -n "$tok" ] && break
  sleep 0.5
done
[ -n "$tok" ] || { echo "the token controller never populated bothy/bothy-kube-token" >&2; exit 1; }

umask 077
mkdir -p "$out"
chmod 700 "$out"
printf '%s' "$tok" | base64 -d > "$out/token.tmp"
"${kc[@]}" -n bothy get secret bothy-kube-token -o jsonpath='{.data.ca\.crt}' | base64 -d > "$out/ca.crt.tmp"
chmod 600 "$out/token.tmp" "$out/ca.crt.tmp"
mv -f "$out/token.tmp" "$out/token"
mv -f "$out/ca.crt.tmp" "$out/ca.crt"

echo
echo "wrote $out/token and $out/ca.crt (mode 600)"
echo "bothy-ops re-reads the token on every request. If bothy-ops was started"
echo "without the cluster overlay (no thales-scc then), run: just up-apps"
echo
echo "what $sa may do (the rows are GENERATED from apps/bothy-ops/catalog.toml"
echo "into scripts/lib/bothy-kube-probes.sh - every granted verb, then the refusals):"
fail=0
probe() { # expect verb resource namespace-or-dash
  local got scope sub label
  if [ "$4" = "-" ]; then scope=(); else scope=(-n "$4"); fi
  sub=(); label="$3"
  if [ -n "${5:-}" ]; then sub=(--subresource="${5#--}"); label="$3 ${5}"; fi
  got="$("${kc[@]}" auth can-i "$2" "$3" ${sub[@]+"${sub[@]}"} ${scope[@]+"${scope[@]}"} --as="$sa" 2>/dev/null || true)"
  printf '  %-4s %-16s %-36s %-16s %s\n' "$got" "$2" "$label" "$4" "$([ "$got" = "$1" ] && echo ok || echo 'UNEXPECTED')"
  [ "$got" = "$1" ] || fail=1
}
# shellcheck source=lib/bothy-kube-probes.sh
. "$root/scripts/lib/bothy-kube-probes.sh"
exit $fail
