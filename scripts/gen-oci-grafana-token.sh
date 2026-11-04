#!/usr/bin/env bash
# Write monitoring/oci-auth.env: what Grafana needs to query the OCI cluster's
# Prometheus, Loki and Tempo (the "OCI *" datasources in
# monitoring/provisioning/datasources/datasources.yml).
#
#   OCI_K8S_SERVER  https://<node tailnet IP>:6443
#   OCI_K8S_TOKEN   the bothy-grafana ServiceAccount token: `get` on
#                   services/proxy for those three Services only
#                   (oci-free k8s/bothy-grafana-reader.yaml)
#   OCI_K8S_CA      the cluster CA, to verify :6443
#
# WHY A GENERATOR AND NOT A CHECKED-IN FILE: the token is a credential, and this
# repository is public. Same reasoning as gen-kube-prom-token.sh.
#
# WHY AN ENV FILE AND NOT $__file{}: Grafana refuses to START when a $__file{}
# target is missing (tested 2026-11-04), so a fresh box without this file would
# lose Grafana entirely. An env file compose treats as optional costs only
# these three datasources.
#
# The token is read over Tailscale SSH and goes ssh -> pipe -> python -> file.
# It is never in argv, never printed. File mode 600: compose reads it as devssh
# and hands the values to the container's environment.
#
# Needs a Grafana restart to take effect (env + provisioning are read at start):
#   docker compose -f monitoring/compose.yml up -d grafana
# Rotate: on the node, delete Secret monitoring/bothy-grafana-token and re-apply
# bothy-grafana-reader.yaml, then re-run this.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node="${OCI_NODE:-100.79.242.82}"
ssh_target="${OCI_SSH:-ubuntu@$node}"
out="$root/monitoring/oci-auth.env"

tmp="$(mktemp "$root/monitoring/.oci-auth.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
chmod 600 "$tmp"

ssh -T "$ssh_target" \
  "sudo k3s kubectl -n monitoring get secret bothy-grafana-token -o json" \
| python3 -I -c '
import base64, json, sys
server, out = sys.argv[1], sys.argv[2]
d = json.load(sys.stdin).get("data") or {}
tok = base64.b64decode(d.get("token", "")).decode()
ca = base64.b64decode(d.get("ca.crt", "")).decode().strip()
if len(tok) < 100 or "BEGIN CERTIFICATE" not in ca:
    sys.exit("no token or CA in monitoring/bothy-grafana-token yet: apply "
             "oci-free k8s/bothy-grafana-reader.yaml on the node first")
with open(out, "w") as f:
    f.write("OCI_K8S_SERVER=https://%s:6443\n" % server)
    f.write("OCI_K8S_TOKEN=%s\n" % tok)
    f.write("OCI_K8S_CA=\"%s\"\n" % ca.replace("\n", "\\n"))
' "$node" "$tmp"

mv -f "$tmp" "$out"
trap - EXIT
echo "wrote $out (mode 600, gitignored)"
echo "apply it: docker compose -f $root/monitoring/compose.yml up -d grafana"
