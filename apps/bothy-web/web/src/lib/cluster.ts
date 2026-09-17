// The Cluster page's logic, as a pure unit: topology, status, role gating and
// the client-side checks that mirror the catalog's allowlists.
//
// IMPORT-FREE ON PURPOSE (type-only imports are erased), so checks/run.sh can
// compile it with a bare tsc and run truth tables against it in node - the
// same reason lib/discover.ts and lib/kube-actions.ts are written the way they
// are. Everything here fails silently when wrong: a service drawn attached to
// the wrong deployment, a delete button drawn for a viewer, a value the
// service will refuse shown as valid.
//
// NOTHING HERE IS A BOUNDARY. The service re-checks every allowlist and the edge
// every role; these only decide what is drawn and what is explained in advance.

import type {
  DeploymentRow, IngressRow, KubeActionSpec, KubeCatalog, PodRow, RouteRow, ServiceRow,
} from './kube-actions';

export type ClusterStatus = 'up' | 'warn' | 'down' | 'off' | 'unknown';

// ── status ──────────────────────────────────────────────────────────────────

/**
 * A deployment's status from its replica counts.
 *
 *   off   scaled to 0 on purpose - not a fault
 *   down  wants pods and has none ready
 *   warn  some but not all ready, or a rollout still in progress, or paused
 *   up    every wanted pod ready and the newest template rolled out
 */
export function deploymentStatus(d: Pick<DeploymentRow, 'replicas' | 'readyReplicas' | 'updatedReplicas' | 'paused'>): ClusterStatus {
  const want = d.replicas ?? 0;
  const ready = d.readyReplicas ?? 0;
  if (want === 0) return 'off';
  if (ready === 0) return 'down';
  if (ready < want || (d.updatedReplicas ?? want) < want || d.paused) return 'warn';
  return 'up';
}

const RANK: Record<ClusterStatus, number> = { down: 4, warn: 3, unknown: 2, off: 1, up: 0 };

/** The worst of several statuses; `unknown` for none. */
export function worst(list: ClusterStatus[]): ClusterStatus {
  if (!list.length) return 'unknown';
  return list.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

/** A pod's status word to a status class. */
export function podStatus(p: Pick<PodRow, 'status' | 'phase' | 'readyContainers' | 'totalContainers'>): ClusterStatus {
  const s = (p.status || p.phase || '').toLowerCase();
  if (s === 'completed' || s === 'succeeded') return 'off';
  if (/(crashloop|error|failed|imagepull|errimage|oomkilled|invalid)/.test(s)) return 'down';
  if (s === 'running') return p.readyContainers >= p.totalContainers ? 'up' : 'warn';
  if (s === 'pending' || s === 'containercreating' || s === 'terminating' || s === 'podinitializing') return 'warn';
  return 'unknown';
}

export function jobStatus(status: string): ClusterStatus {
  if (status === 'Complete') return 'up';
  if (status === 'Failed') return 'down';
  if (status === 'Running') return 'warn';
  return 'unknown';
}

// ── topology ────────────────────────────────────────────────────────────────

/** Every key of the selector is on the labels with the same value. An EMPTY
 *  selector selects nothing here: a Service with no selector is managed by
 *  hand (endpoints written directly), and drawing it attached to every
 *  deployment would be a lie. */
export function selectorMatches(selector: Record<string, string> | null | undefined, labels: Record<string, string> | null | undefined): boolean {
  const keys = Object.keys(selector ?? {});
  if (!keys.length) return false;
  return keys.every((k) => (labels ?? {})[k] === (selector as Record<string, string>)[k]);
}

export type TopoKind = 'deployment' | 'service' | 'route' | 'ingress';

export interface TopoNode {
  id: string;
  kind: TopoKind;
  name: string;
  status: ClusterStatus;
  /** One short line under the name. */
  detail: string;
}

export interface TopoEdge { from: string; to: string }

export interface Topology {
  deployments: TopoNode[];
  services: TopoNode[];
  /** Routes and ingresses share the third column: both are "how you reach it". */
  entries: TopoNode[];
  edges: TopoEdge[];
}

const idOf = (kind: TopoKind, name: string) => `${kind}/${name}`;

/**
 * Deployment -> Service -> Route/Ingress, from the live lists.
 *
 *   a Service points at a deployment when its selector is a subset of the
 *     deployment's POD TEMPLATE labels (what the Service actually matches -
 *     never the deployment's own metadata labels);
 *   a Route points at the Service named in spec.to;
 *   an Ingress points at every Service its rules name.
 *
 * A service with no deployment behind it is `down` ("no pods to send to"); a
 * route or ingress naming a service that does not exist is `down` too. Neither
 * is hidden: a dangling route is what this page should shout about.
 */
export function buildTopology(
  deployments: DeploymentRow[], services: ServiceRow[], routes: RouteRow[], ingresses: IngressRow[],
): Topology {
  const edges: TopoEdge[] = [];
  const depNodes: TopoNode[] = [...deployments]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({
      id: idOf('deployment', d.name), kind: 'deployment', name: d.name, status: deploymentStatus(d),
      detail: `${d.readyReplicas ?? 0}/${d.replicas ?? 0} ready${d.paused ? ' · paused' : ''}`,
    }));
  const depStatus = new Map(depNodes.map((n) => [n.name, n.status]));

  const svcStatus = new Map<string, ClusterStatus>();
  const svcNodes: TopoNode[] = [...services]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => {
      const backing = deployments.filter((d) => selectorMatches(s.selector, d.templateLabels));
      for (const d of backing) edges.push({ from: idOf('deployment', d.name), to: idOf('service', s.name) });
      const status: ClusterStatus = backing.length ? worst(backing.map((d) => depStatus.get(d.name) ?? 'unknown')) : 'down';
      svcStatus.set(s.name, status);
      const ports = s.ports.map((p) => p.port).join(', ');
      return {
        id: idOf('service', s.name), kind: 'service', name: s.name, status,
        detail: backing.length ? `${s.type}${ports ? ` · ${ports}` : ''}` : 'selects no deployment',
      } satisfies TopoNode;
    });

  const entryNodes: TopoNode[] = [];
  for (const r of [...routes].sort((a, b) => a.name.localeCompare(b.name))) {
    const target = svcStatus.get(r.service);
    if (target !== undefined) edges.push({ from: idOf('service', r.service), to: idOf('route', r.name) });
    let status: ClusterStatus = target === undefined ? 'down' : target;
    if (status === 'up' && r.admitted === false) status = 'warn';
    entryNodes.push({
      id: idOf('route', r.name), kind: 'route', name: r.name, status,
      detail: target === undefined ? `no service ${r.service}` : (r.host || r.service),
    });
  }
  for (const ing of [...ingresses].sort((a, b) => a.name.localeCompare(b.name))) {
    const names = [...new Set(ing.rules.map((x) => x.service).filter(Boolean))];
    const known = names.filter((n) => svcStatus.has(n));
    for (const n of known) edges.push({ from: idOf('service', n), to: idOf('ingress', ing.name) });
    const status: ClusterStatus = !known.length ? 'down'
      : known.length < names.length ? 'warn'
      : worst(known.map((n) => svcStatus.get(n) ?? 'unknown'));
    const host = ing.rules.find((x) => x.host)?.host;
    entryNodes.push({
      id: idOf('ingress', ing.name), kind: 'ingress', name: ing.name, status,
      detail: !known.length ? 'no known service' : (host || known.join(', ')),
    });
  }

  return { deployments: depNodes, services: svcNodes, entries: entryNodes, edges };
}

// ── roles ───────────────────────────────────────────────────────────────────

export type Gate = 'enabled' | 'disabled' | 'hidden';

/**
 * How to draw a control for an action, given the session's roles.
 *
 *   enabled   the role the action needs is held
 *   disabled  an operator action for a session that can read - drawn, so the
 *             reader learns the verb exists and why it is not theirs
 *   hidden    anything for a session that holds neither role; and any action
 *             the catalog does not declare at all (the service would 404 it)
 *
 * The same rule as allowedFor() in lib/kube-actions.ts; the check asserts they
 * agree for every action in the catalog.
 */
export function gate(roles: readonly string[], spec: Pick<KubeActionSpec, 'role'> | null | undefined): Gate {
  if (!spec) return 'hidden';
  const reads = roles.includes('viewer') || roles.includes('operator');
  if (spec.role === 'viewer') return reads ? 'enabled' : 'hidden';
  if (roles.includes('operator')) return 'enabled';
  return reads ? 'disabled' : 'hidden';
}

/** The gate for an action id in a catalog. */
export function gateOf(roles: readonly string[], catalog: KubeCatalog | null | undefined, id: string): Gate {
  return gate(roles, catalog?.actions.find((a) => a.id === id));
}

// ── what the service will accept, checked before the click ──────────────────

/** Whether a ConfigMap value matches the key's catalog pattern, the way the
 *  service checks it: the WHOLE value (Python fullmatch), never a prefix. */
export function valueAllowed(catalog: Pick<KubeCatalog, 'configmapKeys'>, key: string, value: string): boolean {
  const rule = catalog.configmapKeys[key];
  if (!rule) return false;
  if (/[\r\n]/.test(value)) return false;
  try {
    return new RegExp(`^(?:${rule.pattern})$`).test(value);
  } catch {
    return false;
  }
}

// An OCI image reference: [registry[:port]/]path[:tag][@sha256:digest], all
// lowercase path components, and a tag or a digest required - `latest` by
// omission is a moving target a rollback cannot return to.
const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const IMAGE_RE = new RegExp(
  `^(?:[a-z0-9.-]+(?::[0-9]{1,5})?/)?${COMPONENT}(?:/${COMPONENT})*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$`,
);

/** Whether an image reference is well-formed AND from an allowlisted registry. */
export function imageAllowed(catalog: Pick<KubeCatalog, 'imageRegistries'>, image: string): boolean {
  if (!image || image.length > 255) return false;
  if (!IMAGE_RE.test(image)) return false;
  if (!/:[A-Za-z0-9_][A-Za-z0-9_.-]*$|@sha256:[a-f0-9]{64}$/.test(image)) return false;
  return catalog.imageRegistries.some((p) => image.startsWith(p));
}

// ── small formatting shared by the tabs ─────────────────────────────────────

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '-';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** `thales/backend:0.1.7` -> `backend:0.1.7`, for a narrow cell. */
export function shortImage(image: string): string {
  const at = image.lastIndexOf('/');
  return at >= 0 ? image.slice(at + 1) : image;
}
