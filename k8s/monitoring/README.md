# k8s/monitoring - the minikube cluster, seen by the box's monitoring

The cluster `thales-scc` (minikube, docker driver; see `~/claude-notes/stack/kubernetes.md`)
is watched by the **compose** monitoring stack in `monitoring/`, not by a second
metrics store or Loki inside it. Monitoring must outlive what it watches, so the
cluster only gets the small pieces that have to run where the data is.

Since 2026-09-17 the compose side is **VictoriaMetrics** (was Prometheus) and the
log shipper on both sides is **Grafana Alloy** (was promtail). Labels, job names
and alerts did not change.

## Observed by the stack

| Signal | In the cluster (`monitoring` ns) | Reaches the box via | Lands in |
|---|---|---|---|
| Object state (node Ready, pods, restarts) | kube-state-metrics, helm chart `prometheus-community/kube-state-metrics` **8.5.0** (pinned in `Chart.yaml`), NodePort **30808** | VictoriaMetrics joins docker network `thales-scc`, scrapes `192.168.49.2:30808` | job `kube-state-metrics` |
| Kubelet health, PVC fullness | - (kubelet itself) | `https://192.168.49.2:10250/metrics`, bearer token | job `kubelet` |
| Pod CPU / memory / network | - (kubelet's cAdvisor) | `https://192.168.49.2:10250/metrics/cadvisor`, bearer token | job `kubelet-cadvisor` |
| Pod logs | Alloy DaemonSet (`grafana/alloy:v1.19.2`) | pushes to `host.minikube.internal:3100` = the host's Loki | Loki, `{cluster="thales-scc"}` |
| `kubectl top`, k9s CPU/MEM | minikube `metrics-server` addon | - | terminal only |

Every metric series carries `cluster="thales-scc"`, every job matches
`job=~"kube.*"`. Grafana alerts `kube_cluster_down` and `kube_node_not_ready`
(`monitoring/provisioning/alerting/rules.yml`, group `cluster-alerts`) key on those.

### Loki labels

`cluster`, `namespace`, `pod`, **`k8s_container`**, `stream`, `job="kubernetes-pods"`.
(`service_name` is added by Loki itself.) `filename` is dropped.

Not `container`: the compose shipper already uses `container` for the *docker*
container name, and the portal's log panels query `{container="<name>"}`. Tals runs
pods whose containers are called `postgres`, `keycloak`, `backend` - a shared label
would pour cluster logs into the box's own panels. `stream` is shared on purpose;
it means the same thing on both sides.

```sh
xh --ignore-stdin :3100/loki/api/v1/query_range query=='{cluster="thales-scc",namespace="thales-dev"}' limit==20
```

### Metrics: things measured, not assumed

- **From devnet, 192.168.49.2 times out** - docker isolates bridge networks. That
  is the whole reason for `monitoring/compose.cluster.yml`.
- `kubelet-cadvisor` is **pod-level only**: `container` is empty on every series
  (cri-dockerd). Aggregate by `namespace, pod`. Its `name` label is dropped so pod
  series never appear in the portal's `name!=""` container lists.
- Cardinality after the keep-lists: ~165 cadvisor + ~42 kubelet + ~2360 KSM series.
- The token's ClusterRole is `get nodes/metrics` and nothing else; `/stats/summary`
  and `/pods` answer 403 with it. `nodes/proxy` is deliberately not granted - see
  `scraper-rbac.yaml`.
- **VictoriaMetrics differs from Prometheus in two ways that bit** (both fixed in
  `monitoring/scrape.d/kubernetes.yml`): an included scrape file must be a bare
  *list* (Prometheus wanted `scrape_configs:`), and a relative `credentials_file` is
  resolved against `prometheus.yml`'s directory, not the included file's - so the
  token path is absolute.

### Alloy: things measured, not assumed

- **Storage must be mounted over `/var/lib/alloy`, not `/var/lib/alloy/data`.** The
  image's `/var/lib/alloy` belongs to its own user; uid 0 with every capability
  dropped cannot traverse it, and the first apply crash-looped on
  `mkdir /var/lib/alloy/data: permission denied`.
- **The switch from promtail lost no lines.** `legacy_positions_file` imports
  promtail's `/var/lib/promtail/positions.yaml` on first start ("successfully
  converted legacy positions file"), so the three minutes the shipper was down on
  2026-09-17 were back-filled: Loki's per-minute count stayed at ~175 lines across
  the swap.
- ~50 MiB, 11m CPU steady (promtail was ~41 MiB).

## Files

| File | What |
|---|---|
| `namespace.yaml` | `monitoring`, PSA enforce=privileged (alloy needs hostPath), warn/audit=restricted. Outside every Kyverno policy's namespace list; no policy is touched. |
| `kube-state-metrics.values.yaml` | helm values: fixed NodePort 30808, resources |
| `scraper-rbac.yaml` | SA `prometheus-scraper`, ClusterRole `get nodes/metrics`, long-lived token Secret (names predate VictoriaMetrics) |
| `alloy.yaml` | SA + `get/list/watch pods`, ConfigMap (`config.alloy`), DaemonSet |
| `../../monitoring/scrape.d/kubernetes.yml` | the three scrape jobs (VictoriaMetrics list format) |
| `../../monitoring/compose.cluster.yml` | joins victoriametrics to `thales-scc`, mounts `scrape.d/` and `kube-auth/` |
| `../../scripts/k8s-monitoring.sh` | applies everything above, removes a leftover promtail DaemonSet, idempotent |
| `../../scripts/gen-kube-prom-token.sh` | writes `monitoring/kube-auth/token` (gitignored, 600, uid 65534) |

## Apply / re-apply

```sh
just k8s-monitoring     # cluster side + token; safe to re-run
just up-monitoring      # compose side; adds compose.cluster.yml when the thales-scc network exists
```

**Always start victoriametrics through `just up-monitoring`** (or pass both `-f`
files). A bare `docker compose -f monitoring/compose.yml up -d victoriametrics`
recreates it without the network, the kube jobs disappear, and the alerts -
`noDataState: OK` so a box without a cluster does not page forever - go silent
rather than red.

After a cluster rebuild: `just k8s-monitoring` (new Secret, new token). The token is
re-read on every scrape; no restart.

## metrics-server's 200Mi request - documented, not changed

The addon requests `cpu: 100m, memory: 200Mi`. Lowering it is **not declarative**
on minikube: `minikube start` re-applies the addon's embedded manifest (label
`addonmanager.kubernetes.io/mode: Reconcile`), so a `kubectl patch` lasts until the
next boot, and minikube has no flag or values file for addon resources. The options
that would stick are all outside this directory - a post-start patch in
`minikube.service`, or disabling the addon and installing the upstream chart with
its own values. Neither is worth it for a reservation on a one-node dev cluster.

## Rollback of the shipper

```sh
kubectl --context thales-scc delete -f k8s/monitoring/alloy.yaml
git show 198591e:k8s/monitoring/promtail.yaml | kubectl --context thales-scc apply -f -
```

promtail's own positions on the node are untouched by Alloy (it reads them, it
does not write them), so it resumes from where it stopped, re-sending what Alloy
shipped in between.

## Remove

```sh
helm --kube-context thales-scc -n monitoring uninstall kube-state-metrics
kubectl --context thales-scc delete -f k8s/monitoring/alloy.yaml -f k8s/monitoring/scraper-rbac.yaml
kubectl --context thales-scc delete ns monitoring
minikube -p thales-scc addons disable metrics-server
```

Then recreate victoriametrics with `compose.yml` alone. Do that **before**
`minikube delete`, which cannot remove the `thales-scc` network while
victoriametrics is attached to it.
