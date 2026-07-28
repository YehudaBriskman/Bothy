// Discovery engine — a FAITHFUL TypeScript port of the pure section of the
// original portal.js (lines ~15-323). No DOM, no fetch, no globals: this is the
// join, and the join is the part with real bugs in it. Behaviour is identical to
// the original; only types were added.
//
//   Traefik  -> every route, including host processes (@file). The SKELETON.
//   Docker   -> ports, health, images, compose labels.        ENRICHMENT.
//
// Either can die and the page still renders.

export const BASE = 'dev.test';
const STACK_ROOT = '/home/devssh/stacks/';
const INFRA_PROJECTS = new Set(['edge', 'portal']);

// ── Wire types (the raw API shapes) ─────────────────────────────────────────

export interface Router {
  name: string;
  rule?: string;
  service?: string;
  provider?: string;
  priority?: number;
  entryPoints?: string[];
  status?: string;
}

export interface LoadBalancerServer {
  url?: string;
}

export interface Service {
  name: string;
  loadBalancer?: { servers?: LoadBalancerServer[] };
}

export interface DockerPort {
  IP?: string;
  PrivatePort?: number;
  PublicPort?: number;
  Type?: string;
}

export interface DockerHealth {
  Status?: string;
  FailingStreak?: number;
}

// State is a plain string on /containers/json, but the original keeps a shape
// guard for the inspect-style {Health} object, so the type allows both.
export type ContainerState = string | { Health?: DockerHealth };

export interface DockerNetwork {
  IPAddress?: string;
}

export interface Container {
  Id: string;
  Names?: string[];
  Image?: string;
  State?: ContainerState;
  Status?: string;
  Health?: DockerHealth;
  Ports?: DockerPort[];
  Labels?: Record<string, string>;
  NetworkSettings?: { Networks?: Record<string, DockerNetwork> };
}

// ── Derived types (what the join produces) ──────────────────────────────────

export type Status = 'up' | 'down' | 'starting' | 'unknown';
export type Kind = 'routed' | 'orphan-route' | 'unrouted' | 'host';

export interface Nesting {
  depth: number | null;
  parent: string | null;
  leaf: string | null;
}

export interface Classification {
  group: string;
  groupKind: string;
}

export interface Port {
  hostIp: string;
  hostPort: number;
  containerPort?: number;
  proto?: string;
  scope: 'loopback' | 'public';
}

export interface PortRow extends Port {
  container: string;
  image?: string;
  group: string;
  groupKind: string;
}

export interface NodeRoute {
  router: string;
  provider?: string;
  rule?: string;
  priority?: number;
  entryPoints?: string[];
  status?: string;
  serverUrls: string[];
}

export interface NodeContainer {
  id: string;
  name: string;
  image?: string;
  state?: ContainerState;
  statusText?: string;
  health: DockerHealth | null;
  labels: Record<string, string>;
}

export interface PortalNode {
  id: string;
  kind: Kind;
  name: string;
  host: string | null;
  path: string;
  url: string | null;
  browsable: boolean;
  group: string;
  groupKind: string;
  parent: string | null;
  depth: number | null;
  order: number;
  hidden: boolean;
  route: NodeRoute | null;
  container: NodeContainer | null;
  ports: Port[];
  status: Status;
  icon: string;
  desc: string;
}

// ── Pure: hostname handling ─────────────────────────────────────────────────

// Extract the Host() value from a Traefik rule.
//
// Returns null for ANYTHING it doesn't fully understand — `PathPrefix(`/`)`
// (portal-fallback has no Host at all), HostRegexp, multi-host Host(`a`,`b`).
// Guessing here silently files cards under the wrong project, which is worse
// than not showing them: a null falls through to the Routes tab, visibly.
export function extractHost(rule: unknown): string | null {
  if (typeof rule !== 'string') return null;
  if (/HostRegexp/i.test(rule)) return null;
  const m = rule.match(/Host\(`([^`]+)`\)/);
  if (!m) return null;
  // Host(`a`,`b`) — more than one host in a single call. Don't pick one.
  if (/Host\(`[^`]+`\s*,/.test(rule)) return null;
  return m[1];
}

// Where does a hostname sit in the dev.test hierarchy?
//   dev.test            -> depth 0, the portal itself
//   grafana.dev.test    -> depth 1, leaf 'grafana',  parent null
//   s3.cvops.dev.test   -> depth 2, leaf 's3',       parent 'cvops'
export function nest(host: string | null): Nesting {
  if (!host) return { depth: null, parent: null, leaf: null };
  if (host === BASE) return { depth: 0, parent: null, leaf: null };
  if (!host.endsWith('.' + BASE)) return { depth: null, parent: null, leaf: host };
  const labels = host.slice(0, -(BASE.length + 1)).split('.');
  return {
    depth: labels.length,
    leaf: labels[0],
    parent: labels.length > 1 ? labels[labels.length - 1] : null,
  };
}

// ── Pure: classification ────────────────────────────────────────────────────

// project vs stack vs infra, from the compose file's location on disk.
// No hand-maintained list: a project is simply a compose file that doesn't
// live under ~/stacks.
export function classify(container?: Container | null): Classification {
  if (!container) return { group: 'host', groupKind: 'project' };
  const labels = container.Labels || {};
  const cfg = labels['com.docker.compose.project.config_files'];
  const proj = labels['com.docker.compose.project'];
  // minikube and anything else started outside compose has neither.
  if (!cfg || !proj) return { group: 'unmanaged', groupKind: 'infra' };
  const first = cfg.split(',')[0];
  if (first.startsWith(STACK_ROOT)) {
    return { group: proj, groupKind: INFRA_PROJECTS.has(proj) ? 'infra' : 'stack' };
  }
  return { group: proj, groupKind: 'project' };
}

const titleCase = (s: string): string =>
  String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

// ORDER MATTERS — first substring match wins. Vendor-prefixed images mean the
// specific product must precede the vendor: grafana/loki would otherwise match
// 'grafana' and show a dashboard icon.
const IMAGE_ICONS: [string, string][] = [
  ['loki', '📜'], ['promtail', '📜'], ['dozzle', '📜'],
  ['grafana', '📊'], ['prometheus', '🎯'],
  ['traefik', '🚦'], ['portainer', '🐳'], ['socket-proxy', '🔌'],
  ['nginx', '🌐'], ['postgres', '🐘'], ['redis', '🧠'], ['kafka', '🌊'],
  ['garage', '🧊'], ['wiki', '📚'], ['minikube', '☸️'],
  ['cadvisor', '📈'], ['node-exporter', '🖥️'], ['exporter', '📈'],
];

// Accepts either a normalized node (container.image) or a raw docker container
// (container.Image) — the two differ in case and mixing them silently drops
// every icon to a letter fallback.
export function iconFor(node: {
  container?: { image?: string; Image?: string } | null;
  name?: string;
}): string {
  const img = String(node.container?.image || node.container?.Image || '').toLowerCase();
  for (const [k, v] of IMAGE_ICONS) if (img.includes(k)) return v;
  return (node.name || '?').replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '•';
}

// Display name for a compose project: `dev.portal.project` on ANY of its
// containers names the whole project. One label fixes every breadcrumb, panel
// title and unrouted card — titleCase can't know that "cvops" is "CVOps".
export function projectNames(containers: Container[] = []): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of containers) {
    const L = c.Labels || {};
    const p = L['com.docker.compose.project'];
    const n = L['dev.portal.project'];
    if (p && n) m.set(p, n);
  }
  return m;
}

// Name with zero labels required. Labels only add polish — if this needs labels
// to be *correct*, the defaults are wrong.
export function defaultName(
  host: string | null,
  container?: Container | null,
  names: Map<string, string> = new Map(),
): string {
  const n = nest(host);
  const proj = container?.Labels?.['com.docker.compose.project'];
  const nice = (g: string) => names.get(g) || titleCase(g);

  let base = container?.Labels?.['com.docker.compose.service'];
  if (!base) base = n.leaf ?? undefined;
  if (!base) base = (container?.Names?.[0] || '').replace(/^\//, '');
  if (!base) base = 'unknown';
  const title = titleCase(base);

  // Routed under a project: s3.cvops.dev.test -> "CVOps · S3"
  if (n.parent) return `${nice(n.parent)} · ${title}`;
  // Unrouted but owned by a project: cvops-postgres-1 -> "CVOps · Postgres",
  // so it can't be confused with the stack's own Postgres in another panel.
  if (!host && proj && classify(container).groupKind === 'project' && titleCase(proj) !== title) {
    return `${nice(proj)} · ${title}`;
  }
  return title;
}

// Non-HTTP things are listed but not linked — clicking an S3 or postgres
// endpoint in a browser is never what you wanted.
const NON_HTTP = ['garage', 'postgres', 'redis', 'kafka:', 'apache/kafka', 'socket-proxy'];
export function isBrowsable(host: string | null, container?: Container | null): boolean {
  if (!host) return false;
  const img = (container?.Image || '').toLowerCase();
  return !NON_HTTP.some((k) => img.includes(k));
}

// ── Pure: status ────────────────────────────────────────────────────────────

// Health IS a top-level field on /containers/json (docker 29 / API 1.55).
// Strictly better than a no-cors probe, which can't tell a 502 error page from
// success. The probe is kept ONLY for @file routes with no container.
export function statusOf(container?: Container | null, _kind?: string): Status {
  if (!container) return 'unknown'; // resolved by probe if routed
  // Health is an OBJECT here - {Status, FailingStreak} - not a string, so
  // comparing it directly to 'healthy' was always false and every container
  // fell through to the State check below. State is a plain string, so the
  // second branch is only a shape guard.
  const s = container.State;
  const stateHealth = s && typeof s === 'object' ? s.Health?.Status : undefined;
  const h = container.Health?.Status ?? stateHealth;
  if (h === 'healthy') return 'up';
  if (h === 'unhealthy') return 'down';
  if (h === 'starting') return 'starting';
  return container.State === 'running' ? 'up' : 'down';
}

// ── Pure: the join ──────────────────────────────────────────────────────────

// router -> service -> server url -> devnet IP -> container
export function merge(
  routers: Router[] = [],
  services: Service[] = [],
  containers: Container[] = [],
): PortalNode[] {
  const svcByKey = new Map(services.map((s) => [s.name, s] as const));
  const names = projectNames(containers);

  // devnet ONLY. Traefik runs --providers.docker.network=devnet so every
  // docker-provider server URL is a devnet IP. Indexing all networks would
  // collide: 172.18.0.x and 172.19.0.x both exist on this box.
  const ctrByIp = new Map<string, Container>();
  for (const c of containers) {
    const ip = c.NetworkSettings?.Networks?.devnet?.IPAddress;
    if (ip) ctrByIp.set(ip, c);
  }
  // Fallback join: containers carry their own traefik.http.routers.<n>.rule
  // labels, so router->container survives a stale Traefik server IP.
  const ctrByRouter = new Map<string, Container>();
  for (const c of containers) {
    for (const k of Object.keys(c.Labels || {})) {
      const m = k.match(/^traefik\.http\.routers\.([^.]+)\./);
      if (m) ctrByRouter.set(m[1], c);
    }
  }

  const nodes: PortalNode[] = [];
  const claimed = new Set<string>();

  // Pass 1 — everything Traefik routes.
  for (const r of routers) {
    const host = extractHost(r.rule);
    if (!host) continue; // Routes tab only (portal-fallback)

    // router.service has NO @provider suffix, but service.name does.
    // Except dashboard@docker, whose service is already 'api@internal'.
    const svcKey = r.service?.includes('@') ? r.service : `${r.service}@${r.provider}`;
    const svc = svcByKey.get(svcKey);
    const urls = svc?.loadBalancer?.servers?.map((s) => s.url).filter(Boolean) as string[] | undefined;
    const serverUrls = urls || [];

    let container: Container | null = null;
    for (const u of serverUrls) {
      let ip: string;
      try {
        ip = new URL(u).hostname;
      } catch {
        continue;
      }
      if (ctrByIp.has(ip)) {
        container = ctrByIp.get(ip)!;
        break;
      }
    }
    if (!container) container = ctrByRouter.get(String(r.name).split('@')[0]) || null;
    if (container) claimed.add(container.Id);

    nodes.push(
      makeNode({
        route: r,
        host,
        serverUrls,
        container,
        names,
        kind: container ? 'routed' : 'orphan-route',
      }),
    );
  }

  // Pass 2 — containers with no route that still publish a port. "Route OR
  // published port" is the correct definition of "a thing a human can reach".
  // Drops promtail/exporters (no route, no port) — they're plumbing.
  for (const c of containers) {
    if (claimed.has(c.Id)) continue;
    if (!(c.Ports || []).some((p) => p.PublicPort)) continue;
    nodes.push(makeNode({ route: null, host: null, container: c, names, kind: 'unrouted' }));
  }

  return nodes;
}

interface MakeNodeArgs {
  route: Router | null;
  host: string | null;
  serverUrls?: string[];
  container: Container | null;
  kind: Kind;
  names?: Map<string, string>;
}

function makeNode({
  route,
  host,
  serverUrls = [],
  container,
  kind,
  names = new Map(),
}: MakeNodeArgs): PortalNode {
  const n = nest(host);
  const cls = classify(container);
  const L = container?.Labels || {};
  const pick = <T>(key: string, fallback: T): string | T => L[`dev.portal.${key}`] ?? fallback;

  const name = pick('name', defaultName(host, container, names));
  const path = pick('path', '');
  const browsable = isBrowsable(host, container);

  const node: PortalNode = {
    id: route ? route.name : `container:${container?.Id?.slice(0, 12)}`,
    kind,
    name,
    host: host || null,
    path,
    url: host && browsable ? `http://${host}${path}` : null,
    browsable,
    // hostname nesting BEATS config_files: it's what puts cvops-tilt@file (no
    // container at all) in the CVOps panel. Makes the DNS convention load-bearing.
    group: pick('group', n.parent || cls.group),
    groupKind: pick('groupKind', n.parent ? 'project' : cls.groupKind),
    parent: n.parent,
    depth: n.depth,
    order: Number(pick('order', 100)) || 100,
    hidden: pick('hidden', 'false') === 'true',
    route: route
      ? {
          router: route.name,
          provider: route.provider,
          rule: route.rule,
          priority: route.priority,
          entryPoints: route.entryPoints,
          status: route.status,
          serverUrls,
        }
      : null,
    container: container
      ? {
          id: container.Id.slice(0, 12),
          name: (container.Names?.[0] || '').replace(/^\//, ''),
          image: container.Image,
          state: container.State,
          statusText: container.Status,
          health: container.Health || null,
          labels: L,
        }
      : null,
    ports: portsOf(container),
    status: statusOf(container, kind),
    icon: '',
    desc: '',
  };
  node.icon = pick('icon', iconFor(node));
  node.desc = pick('desc', defaultDesc(node));
  return node;
}

function defaultDesc(node: PortalNode): string {
  if (node.kind === 'orphan-route' && node.route?.provider === 'file') {
    return 'Host process reached through the edge. Expect 502 when it is not running.';
  }
  if (node.kind === 'orphan-route') {
    return 'Route registered, but no container found on devnet — it may have stopped.';
  }
  if (node.kind === 'unrouted') {
    return `${node.container?.image || 'Container'} — published port, no edge route.`;
  }
  return `${node.container?.image || ''}`.trim() || 'Routed service.';
}

// Docker lists 0.0.0.0 and :: as separate rows for the same bind — collapse
// them, prefer IPv4, or every port shows twice.
export function portsOf(container?: Container | null): Port[] {
  if (!container?.Ports) return [];
  const seen = new Map<string, Port>();
  for (const p of container.Ports) {
    if (!p.PublicPort) continue; // internal-only, not reachable
    const ip = p.IP === '::' ? '0.0.0.0' : p.IP || '0.0.0.0';
    const key = `${ip}:${p.PublicPort}/${p.Type}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      hostIp: ip,
      hostPort: p.PublicPort,
      containerPort: p.PrivatePort,
      proto: p.Type,
      scope: ip === '127.0.0.1' ? 'loopback' : 'public',
    });
  }
  return [...seen.values()].sort((a, b) => a.hostPort - b.hostPort);
}

// Every published port on the box, flattened — the collision map.
export function allPorts(containers: Container[] = []): PortRow[] {
  const rows: PortRow[] = [];
  for (const c of containers) {
    const cls = classify(c);
    for (const p of portsOf(c)) {
      rows.push({
        ...p,
        container: (c.Names?.[0] || '').replace(/^\//, ''),
        image: c.Image,
        group: cls.group,
        groupKind: cls.groupKind,
      });
    }
  }
  return rows;
}

// ── Consts carried over from the render section ─────────────────────────────

// @file routers have no container to label, so overrides live here. Two entries
// isn't a config system. If this reaches ~8, promote it to a fetched portal.json.
export const HOST_OVERRIDES: Record<string, { icon: string; desc: string }> = {
  'tilt.cvops.dev.test': {
    icon: '🔧',
    desc: 'Build logs, resource status and manual triggers for the CVOps dev loop. Needs `tilt up --host=0.0.0.0`.',
  },
};

// Last-resort floor: shown only if BOTH APIs are unreachable. This is the page
// you open when things are broken, so it must never be blank.
export const KNOWN_HOSTS: [string, string][] = [
  ['dev.test', 'Portal'], ['grafana.dev.test', 'Grafana'], ['prometheus.dev.test', 'Prometheus'],
  ['dozzle.dev.test', 'Dozzle'], ['portainer.dev.test', 'Portainer'], ['kafka.dev.test', 'Kafka UI'],
  ['wiki.dev.test', 'Wiki.js'], ['traefik.dev.test', 'Traefik'], ['cvops.dev.test', 'CVOps'],
];
