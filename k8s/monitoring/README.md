# k8s/monitoring - the minikube cluster, seen by the box's monitoring

The cluster `thales-scc` (minikube, docker driver; see `~/claude-notes/stack/kubernetes.md`)
is watched by the **compose** monitoring stack in `monitoring/`, not by a second
Prometheus/Loki inside it. Monitoring must outlive what it watches, so the
cluster only gets the small pieces that have to run where the data is.

## Observed by the stack

| Signal | In the cluster (`monitoring` ns) | Reaches the box via | Lands in |
|---|---|---|---|
| Object state (node Ready, pods, restarts) | kube-state-metrics, helm chart `prometheus-community/kube-state-metrics` **8.5.0**, NodePort **30808** | Prometheus joins docker network `thales-scc`, scrapes `192.168.49.2:30808` | Prometheus job `kube-state-metrics` |
| Kubelet health, PVC fullness | - (kubelet itself) | `https://192.168.49.2:10250/metrics`, bearer token | job `kubelet` |
| Pod CPU / memory / network | - (kubelet's cAdvisor) | `https://192.168.49.2:10250/metrics/cadvisor`, bearer token | job `kubelet-cadvisor` |
| Pod logs | promtail DaemonSet (`grafana/promtail:3.6.8`) | pushes to `host.minikube.internal:3100` = the host's Loki | Loki, `{cluster="thales-scc"}` |
| `kubectl top`, k9s CPU/MEM | minikube `metrics-server` addon | - | terminal only |

Every Prometheus series carries `cluster="thales-scc"`, every job matches
`job=~"kube.*"`. Grafana alerts `kube_cluster_down` and `kube_node_not_ready`
(`monitoring/provisioning/alerting/rules.yml`, group `cluster-alerts`) key on those.

### Loki labels

`cluster`, `namespace`, `pod`, **`k8s_container`**, `stream`, `job="kubernetes-pods"`.

Not `container`: the compose promtail already uses `container` for the *docker*
container name, and the portal's log panels query `{container="<name>"}`. Tals runs
pods whose containers are called `postgres`, `keycloak`, `backend` - a shared label
would pour cluster logs into the box's own panels. `stream` is shared on purpose;
it means the same thing on both sides.

```sh
xh --ignore-stdin :3100/loki/api/v1/query_range query=='{cluster="thales-scc",namespace="thales-dev"}' limit==20
```

### Prometheus: things measured, not assumed

- **From devnet, 192.168.49.2 times out** - docker isolates bridge networks. That
  is the whole reason for `monitoring/compose.cluster.yml`.
- `kubelet-cadvisor` is **pod-level only**: `container` is empty on every series
  (cri-dockerd). Aggregate by `namespace, pod`. Its `name` label is dropped so pod
  series never appear in the portal's `name!=""` container lists.
- Cardinality after the keep-lists: ~171 cadvisor + ~40 kubelet + ~2300 KSM series.
- The token's ClusterRole is `get nodes/metrics` and nothing else; `/stats/summary`
  and `/pods` answer 403 with it. `nodes/proxy` is deliberately not granted - see
  `scraper-rbac.yaml`.

## Files

| File | What |
|---|---|
| `namespace.yaml` | `monitoring`, PSA enforce=privileged (promtail needs hostPath), warn/audit=restricted. Outside every Kyverno policy's namespace list; no policy is touched. |
| `kube-state-metrics.values.yaml` | helm values: fixed NodePort 30808, resources |
| `scraper-rbac.yaml` | SA `prometheus-scraper`, ClusterRole `get nodes/metrics`, long-lived token Secret |
| `promtail.yaml` | SA + `get/list/watch pods`, ConfigMap, DaemonSet |
| `../../monitoring/scrape.d/kubernetes.yml` | the three scrape jobs |
| `../../monitoring/compose.cluster.yml` | joins prometheus to `thales-scc`, mounts `scrape.d/` and `kube-auth/` |
| `../../scripts/k8s-monitoring.sh` | applies everything above, idempotent |
| `../../scripts/gen-kube-prom-token.sh` | writes `monitoring/kube-auth/token` (gitignored, 600, uid 65534) |

## Apply / re-apply

```sh
just k8s-monitoring     # cluster side + token; safe to re-run
just up-monitoring      # compose side; adds compose.cluster.yml when the thales-scc network exists
```

**Always start prometheus through `just up-monitoring`** (or pass both `-f` files).
A bare `docker compose -f monitoring/compose.yml up -d prometheus` recreates it
without the network, the kube jobs disappear, and the alerts - `noDataState: OK`
so a box without a cluster does not page forever - go silent rather than red.

After a cluster rebuild: `just k8s-monitoring` (new Secret, new token). The token is
re-read on every scrape; no Prometheus restart.

## Remove

```sh
helm --kube-context thales-scc -n monitoring uninstall kube-state-metrics
kubectl --context thales-scc delete -f k8s/monitoring/promtail.yaml -f k8s/monitoring/scraper-rbac.yaml
kubectl --context thales-scc delete ns monitoring
minikube -p thales-scc addons disable metrics-server
```

Then recreate prometheus with `compose.yml` alone. Do that **before** `minikube delete`,
which cannot remove the `thales-scc` network while prometheus is attached to it.
