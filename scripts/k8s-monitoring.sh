#!/usr/bin/env bash
# (Re)apply the box's observability inside the minikube cluster thales-scc:
# namespace `monitoring`, kube-state-metrics (helm, pinned), the kubelet scrape
# identity, the Alloy DaemonSet, and the metrics-server addon. Then refresh
# the kubelet token file VictoriaMetrics scrapes with. Idempotent; see
# k8s/monitoring/README.md.
#
# Touches ONLY the `monitoring` namespace, three cluster-scoped RBAC objects
# named monitoring-*, and the minikube metrics-server addon (kube-system). Never
# thales-* namespaces, never a Kyverno policy.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ctx="${KUBE_CONTEXT:-thales-scc}"
profile="${MINIKUBE_PROFILE:-thales-scc}"
dir="$root/k8s/monitoring"
# The chart version lives in k8s/monitoring/Chart.yaml, where Dependabot's helm
# ecosystem can see and bump it; a shell variable here was invisible to it.
# Read with awk (no yq dependency): the `version:` that follows
# `- name: kube-state-metrics`. An empty result is fatal - never install unpinned.
KSM_CHART_VERSION="$(awk '
  /^[[:space:]]*-[[:space:]]*name:[[:space:]]*kube-state-metrics[[:space:]]*$/ { hit = 1; next }
  hit && /^[[:space:]]*-/ { exit }
  hit && /^[[:space:]]*version:/ { sub(/^[[:space:]]*version:[[:space:]]*/, ""); sub(/[[:space:]]*(#.*)?$/, ""); gsub(/"/, ""); print; exit }
' "$dir/Chart.yaml")"
[[ "$KSM_CHART_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || { echo "no exact kube-state-metrics version in $dir/Chart.yaml (got '$KSM_CHART_VERSION')" >&2; exit 1; }

kubectl --context "$ctx" get nodes >/dev/null \
  || { echo "cluster $ctx is not reachable - 'minikube start -p $profile'" >&2; exit 1; }

kubectl --context "$ctx" apply -f "$dir/namespace.yaml"
kubectl --context "$ctx" apply -f "$dir/scraper-rbac.yaml"

if ! helm repo list 2>/dev/null | awk '{print $1}' | grep -qx prometheus-community; then
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
fi
helm repo update prometheus-community >/dev/null
helm --kube-context "$ctx" upgrade --install kube-state-metrics \
  prometheus-community/kube-state-metrics --version "$KSM_CHART_VERSION" \
  -n monitoring -f "$dir/kube-state-metrics.values.yaml" --wait --timeout 5m

# promtail was the shipper until 2026-09-17. Remove it on clusters that still
# have it, BEFORE alloy starts: alloy imports promtail's positions file
# (/var/lib/promtail on the node) on its first start, so stopping promtail first
# freezes those offsets and the hand-over neither drops nor re-sends lines.
# --ignore-not-found: a fresh cluster never had it. --wait: the pod must be gone,
# not terminating, when alloy reads the file.
kubectl --context "$ctx" -n monitoring delete daemonset/promtail configmap/promtail serviceaccount/promtail --ignore-not-found --wait
kubectl --context "$ctx" delete clusterrolebinding/monitoring-promtail clusterrole/monitoring-promtail --ignore-not-found

# Stamp the ConfigMap's hash onto the pod template, so a config edit rolls the
# DaemonSet instead of leaving alloy on the old config until it restarts.
sum="$(sha256sum "$dir/alloy.yaml" | cut -c1-16)"
sed "s/checksum\/config: \"set-by-apply\"/checksum\/config: \"$sum\"/" "$dir/alloy.yaml" \
  | kubectl --context "$ctx" apply -f -
kubectl --context "$ctx" -n monitoring rollout status ds/alloy --timeout=180s

# `kubectl top` / k9s' CPU and MEM columns. Not scraped by VictoriaMetrics - the
# kubelet-cadvisor job covers that - it is for the terminal.
minikube -p "$profile" addons enable metrics-server >/dev/null
echo "metrics-server addon enabled"

bash "$root/scripts/gen-kube-prom-token.sh"
