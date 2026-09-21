#!/usr/bin/env bash
# minikube-node-ip.sh pre|post — keep the thales-scc node's fixed IP free at boot.
#
# The minikube node container `thales-scc` has a FIXED address on its own docker
# network (IPAMConfig 192.168.49.2). Three compose services also join that
# network (victoriametrics, headlamp, bothy-ops) and get DYNAMIC addresses. At
# boot the compose services come up before minikube.service, and docker hands
# the first of them .2 - the node's address. `minikube start` then dies with
# "failed to set up container networking: Address already in use", exit 80,
# and the cluster stays down with nothing in the journal but that line.
# Seen 2026-09-21: headlamp held .2 after a reboot.
#
#   pre   (ExecStartPre)  disconnect any OTHER container holding the node's IP,
#                         remembering its name
#   post  (ExecStartPost) reconnect those containers; docker gives them a free
#                         dynamic address, and .2 is now the node's
#
# Loud by design: every eviction and reconnection is printed to the journal.
set -Eeuo pipefail

NET=thales-scc
NODE=thales-scc
STATE="${HOME:-/home/devssh}/.cache/minikube-node-ip.evicted"
mkdir -p "$(dirname "$STATE")"

node_ip() {
  docker inspect "$NODE" --format "{{(index .NetworkSettings.Networks \"$NET\").IPAMConfig.IPv4Address}}" 2>/dev/null || true
}

case "${1:-}" in
  pre)
    : > "$STATE"
    docker network inspect "$NET" >/dev/null 2>&1 || { echo "minikube-node-ip: network $NET absent - nothing to free"; exit 0; }
    ip="$(node_ip)"
    [ -n "$ip" ] && [ "$ip" != "<no value>" ] || { echo "minikube-node-ip: $NODE has no fixed IP on $NET - nothing to free"; exit 0; }
    holders="$(docker network inspect "$NET" --format '{{range $k,$v := .Containers}}{{$v.Name}} {{$v.IPv4Address}}{{"\n"}}{{end}}' \
      | awk -v ip="$ip" -v node="$NODE" '$1 != node && $2 ~ "^"ip"/" {print $1}')"
    for c in $holders; do
      echo "minikube-node-ip: $c holds $ip (the $NODE node's address) on $NET - disconnecting it so minikube can start"
      docker network disconnect "$NET" "$c"
      echo "$c" >> "$STATE"
    done
    ;;
  post)
    [ -s "$STATE" ] || exit 0
    while read -r c; do
      [ -n "$c" ] || continue
      if docker network connect "$NET" "$c"; then
        echo "minikube-node-ip: reconnected $c to $NET"
      else
        echo "minikube-node-ip: FAILED to reconnect $c to $NET - run: docker network connect $NET $c" >&2
      fi
    done < "$STATE"
    : > "$STATE"
    ;;
  *)
    echo "usage: minikube-node-ip.sh pre|post" >&2
    exit 2
    ;;
esac
