// The Control landing's two metric-backed sources, the cluster and the edge,
// both read through lib/metrics.ts's queryRange - the same /-/api/prom route the
// Vitals and the Cluster page's Metrics tab already use.
//
// WHY PROMETHEUS FOR THE CLUSTER, NOT /-/api/kube/*. The kube reads are viewer
// routes too, but every one is a line in bothy-ops' audit log, and a landing page
// polling pods and deployments for two namespaces every ten seconds would write
// ~17,000 lines a day for nobody. kube-state-metrics is already scraped, sees
// every namespace (not only the two bothy-ops may touch), and costs nothing to
// ask. The Cluster page keeps the kube reads for what only they can say.
//
// An "instant" value here is the LAST point of a short range query: two samples
// a minute apart, of which the newest is read. That keeps one fetch path for the
// whole app (queryRange checks the content type and the envelope - see the trap
// described at the top of lib/metrics.ts) instead of a second one for /query.

import { queryRange, type Series } from '../../lib/metrics';

const NOW = { seconds: 120, step: 60 };

/** The newest value of every series a query returns, keyed by `labelKey`. */
async function latest(query: string, labelKey: string | null, signal: AbortSignal): Promise<Map<string, number>> {
  const series = await queryRange(query, { ...NOW, labelKeys: labelKey ? [labelKey] : [], signal });
  const out = new Map<string, number>();
  for (const s of series) {
    const last = s.points.at(-1);
    if (last) out.set(s.label, last.v);
  }
  return out;
}

const one = (m: Map<string, number>): number | null => (m.size ? [...m.values()][0] : null);

export interface ClusterMetrics {
  /** kube-state-metrics answered with a node at all. */
  reporting: boolean;
  node: string | null;
  nodeReady: boolean | null;
  namespaces: string[];
  /** Pods of any phase, per namespace - "does it hold any workload". */
  podsByNs: Record<string, number>;
  /** Pods not Succeeded (a finished Job pod is not expected to be ready). */
  livePodsByNs: Record<string, number>;
  readyByNs: Record<string, number>;
  restarts24h: number | null;
}

export async function loadCluster(signal: AbortSignal): Promise<ClusterMetrics> {
  const [ready, ns, pods, live, rdy, restarts] = await Promise.all([
    latest('kube_node_status_condition{condition="Ready",status="true"}', 'node', signal),
    latest('kube_namespace_created', 'namespace', signal),
    latest('count by (namespace) (kube_pod_info)', 'namespace', signal),
    latest('sum by (namespace) (kube_pod_status_phase{phase!="Succeeded"})', 'namespace', signal),
    latest('sum by (namespace) (kube_pod_status_ready{condition="true"})', 'namespace', signal),
    latest('sum(increase(kube_pod_container_status_restarts_total[24h]))', null, signal),
  ]);
  const node = ready.size ? [...ready.keys()][0] : null;
  const obj = (m: Map<string, number>) => Object.fromEntries(m);
  const r = one(restarts);
  return {
    reporting: ready.size > 0,
    node,
    nodeReady: node ? (ready.get(node) ?? 0) >= 1 : null,
    namespaces: [...ns.keys()].sort(),
    podsByNs: obj(pods),
    livePodsByNs: obj(live),
    readyByNs: obj(rdy),
    restarts24h: r == null ? null : Math.round(r),
  };
}

export interface EdgeMetrics {
  /** Requests per second across every router, the last hour. */
  rps: Series | null;
  /** 5xx answers in the last five minutes, all routers. */
  errors5m: number | null;
  /** Busiest routers now, requests per second, highest first. */
  top: { router: string; rps: number }[];
}

export async function loadEdge(signal: AbortSignal): Promise<EdgeMetrics> {
  const [rps, errors, byRouter] = await Promise.all([
    queryRange('sum(rate(traefik_router_requests_total[2m]))', { seconds: 3600, step: 60, signal }),
    latest('sum(increase(traefik_router_requests_total{code=~"5.."}[5m]))', null, signal),
    // Every router, ranked here rather than with topk: topk in a range query is
    // evaluated per timestamp (lib/metrics.ts says why that lies).
    latest('sum by (router) (rate(traefik_router_requests_total[5m]))', 'router', signal),
  ]);
  const e = one(errors);
  return {
    rps: rps[0] ?? null,
    errors5m: e == null ? (rps.length ? 0 : null) : Math.round(e),
    top: [...byRouter].map(([router, v]) => ({ router, rps: v }))
      .filter((r) => r.rps > 0)
      .sort((a, b) => b.rps - a.rps)
      .slice(0, 5),
  };
}
