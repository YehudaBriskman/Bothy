// Discovery engine - a FAITHFUL TypeScript port of the pure section of the
// original portal.js (lines ~15-323). No DOM, no fetch, no globals: this is the
// join, and the join is the part with real bugs in it. Behaviour is identical to
// the original; only types were added.
//
//   Traefik  -> every route, including host processes (@file). The SKELETON.
//   Docker   -> ports, health, images, compose labels.        ENRICHMENT.
//
// Either can die and the page still renders.

export const BASE = 'dev.test';

// ── Pure-IP navigation (2026-08-08) ─────────────────────────────────────────
// The *.dev.test names are dormant (custom DNS retired), so browsable URLs
// navigate by PUBLISHED PORT on whichever host the portal was opened from -
// tailnet IP, MagicDNS name, or localhost all work. A host with no entry here
// has no published port and is not reachable (url: null). Keep in sync with
// `just urls` and docs/kb/access.md.
export const HOST_PORTS: Record<string, number> = {
  [BASE]: 80,
  [`grafana.${BASE}`]: 3000, [`prometheus.${BASE}`]: 9090,
  [`dozzle.${BASE}`]: 8080, [`kafka.${BASE}`]: 8081,
  [`portainer.${BASE}`]: 9000,
  [`wiki.${BASE}`]: 3001,
  [`tilt.${BASE}`]: 10350, [`tilt.cvops.${BASE}`]: 10350,
  [`tals.${BASE}`]: 5173, [`api.tals.${BASE}`]: 3003,
  [`auth.tals.${BASE}`]: 3002, [`algo.tals.${BASE}`]: 8000,
};

export function hostUrl(host: string, path = ''): string | null {
  const port = HOST_PORTS[host];
  if (port == null) return null;
  return `http://${location.hostname}${port === 80 ? '' : `:${port}`}${path}`;
}
const STACK_ROOT = '/home/devssh/stacks/';
// 'bothy' is this app itself - web tier, editor tier and socket-proxy, all one
// compose project since 2026-08-16. It was three ('portal', 'portal-next',
// 'portal-files'), which made Bothy render as three separate cards in its own
// Overview, since a system IS a compose project.
//
// Bothy is infra, not stack: leaving it out files the thing you are looking at
// under "Stack", next to the services it is meant to be describing.
//
// The old names stay listed. A container from a previous deployment keeps its
// compose labels until it is recreated, and misfiling it for one poll is a
// worse outcome than three dead strings.
const INFRA_PROJECTS = new Set(['edge', 'bothy', 'portal', 'portal-next', 'portal-files']);

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

// /containers/json includes a Mounts array (the socket-proxy exposes it). Named
// volumes carry a Name; bind mounts carry a host Source. We surface volumes as
// a service's persistent "data", and pair them with /system/df for sizes.
export interface DockerMount {
  Type?: string; // 'volume' | 'bind' | 'tmpfs'
  Name?: string; // volume name (volumes only)
  Source?: string; // host path
  Destination?: string;
  RW?: boolean;
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
  Mounts?: DockerMount[];
  NetworkSettings?: { Networks?: Record<string, DockerNetwork> };
}

// ── Derived types (what the join produces) ──────────────────────────────────

// `stopped` is deliberately NOT a flavour of `down`. Every non-running container
// used to collapse into `down`, so five projects switched off on purpose rendered
// as five alerts and "needs a look" could never reach zero on a box where
// anything was idle. `down` now means "this is meant to be up and isn't" -
// non-zero exit, restart loop, failing healthcheck. `stopped` means somebody
// turned it off: a state, not a problem, and never an alert.
export type Status = 'up' | 'down' | 'starting' | 'stopped' | 'unknown';
export type Kind = 'routed' | 'orphan-route' | 'unrouted' | 'host';

// What a service *is*, so the domain page can split services into meaningful
// sections ("Web UIs", "Databases", …) and filter by them. Derived from the
// image first, then name/host for @file host processes. Order-sensitive, exactly
// like the icon table: a specific product must precede a generic substring.
export type ServiceType =
  | 'web'
  | 'database'
  | 'cache'
  | 'queue'
  | 'storage'
  | 'observability'
  | 'edge'
  | 'runtime'
  | 'other';

const TYPE_RULES: [string, ServiceType][] = [
  ['traefik', 'edge'],
  ['loki', 'observability'], ['promtail', 'observability'], ['dozzle', 'observability'],
  ['grafana', 'observability'], ['prometheus', 'observability'],
  ['cadvisor', 'observability'], ['node-exporter', 'observability'], ['exporter', 'observability'],
  ['postgres', 'database'], ['mysql', 'database'], ['mariadb', 'database'], ['mongo', 'database'],
  ['redis', 'cache'], ['memcached', 'cache'],
  // a broker's WEB UI is a web UI - must precede the broker rule it contains
  ['kafka-ui', 'web'], ['kafdrop', 'web'],
  ['kafka', 'queue'], ['rabbitmq', 'queue'], ['nats', 'queue'], ['zookeeper', 'queue'],
  ['garage', 'storage'], ['minio', 'storage'], ['s3', 'storage'],
  ['portainer', 'runtime'], ['socket-proxy', 'runtime'], ['tilt', 'runtime'],
  ['minikube', 'runtime'], ['kube', 'runtime'], ['k8s', 'runtime'],
  ['nginx', 'web'], ['wiki', 'web'], ['node', 'web'], ['vite', 'web'], ['caddy', 'web'],
];

// Display order + label for each type - the domain page renders sections in this
// order, and the chip filter reads its labels from here. Kept next to the rules
// so a new type can't be added in one place and forgotten in the other.
export const TYPE_META: Record<ServiceType, { label: string; order: number }> = {
  web: { label: 'Web UIs', order: 1 },
  database: { label: 'Databases', order: 2 },
  cache: { label: 'Caches', order: 3 },
  queue: { label: 'Messaging', order: 4 },
  storage: { label: 'Storage', order: 5 },
  observability: { label: 'Observability', order: 6 },
  runtime: { label: 'Runtimes & tooling', order: 7 },
  edge: { label: 'Edge', order: 8 },
  other: { label: 'Other', order: 9 },
};

export function serviceTypeOf(node: {
  name?: string;
  host?: string | null;
  browsable?: boolean;
  container?: { image?: string } | null;
}): ServiceType {
  const img = String(node.container?.image || '').toLowerCase();
  if (img) for (const [k, v] of TYPE_RULES) if (img.includes(k)) return v;
  const hay = `${node.name || ''} ${node.host || ''}`.toLowerCase();
  for (const [k, v] of TYPE_RULES) if (hay.includes(k)) return v;
  return node.browsable ? 'web' : 'other';
}

// A named volume a container persists data to (bind mounts are host config, not
// the service's own data, so they're not counted here).
export interface VolumeRef {
  name: string;
  destination?: string;
}

/** One edge of the wiring diagram, as the compose author declared it. */
export interface Dependency {
  /** The compose SERVICE name depended on - scoped to the same project. */
  service: string;
  /** `service_started` | `service_healthy` | `service_completed_successfully`. */
  condition: string;
}

/**
 * Parse `com.docker.compose.depends_on`.
 *
 * Format is comma-separated `name:condition:restart`, e.g.
 *   `loki:service_started:false,prometheus:service_started:false`
 *
 * The third field is compose's `restart:` flag, not a state - deliberately
 * dropped. Anything that does not have at least name:condition is skipped
 * rather than half-parsed into a dependency on a service called `""`.
 */
export function dependsOnOf(container?: Container | null): Dependency[] {
  const raw = container?.Labels?.['com.docker.compose.depends_on'];
  if (!raw) return [];
  const out: Dependency[] = [];
  for (const part of raw.split(',')) {
    const [service, condition] = part.split(':');
    if (service && condition) out.push({ service, condition });
  }
  return out;
}

/**
 * Which services are DECLARED to run to completion, keyed `project/service`.
 *
 * Read from the far end of every dependency edge: a container that another
 * container waits on with `service_completed_successfully` has finishing as its
 * job. Scoped by project because service names are only unique within one -
 * two projects may each have an `init`, and they are not the same thing.
 */
export function declaredOneShots(containers: Container[]): Set<string> {
  const out = new Set<string>();
  for (const c of containers) {
    const project = c.Labels?.['com.docker.compose.project'];
    if (!project) continue;
    for (const d of dependsOnOf(c)) {
      if (d.condition === 'service_completed_successfully') out.add(`${project}/${d.service}`);
    }
  }
  return out;
}

export function volumesOf(container?: Container | null): VolumeRef[] {
  if (!container?.Mounts) return [];
  const out: VolumeRef[] = [];
  const seen = new Set<string>();
  for (const m of container.Mounts) {
    if (m.Type !== 'volume' || !m.Name || seen.has(m.Name)) continue;
    seen.add(m.Name);
    out.push({ name: m.Name, destination: m.Destination });
  }
  return out;
}

// Parse docker's Status string ("Up 48 minutes", "Up 2 hours", "Up 3 days",
// "Up About an hour", "Up 5 seconds") into seconds of uptime. Anything that
// isn't an "Up …" line (Exited, Created, Restarting) returns null - the node is
// not currently running, so it has no uptime to show.
const UNIT_SECS: Record<string, number> = {
  second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000,
};
export function parseUptime(status?: string): number | null {
  if (!status) return null;
  const m = /^Up\s+(.*)$/.exec(status.trim());
  if (!m) return null;
  const rest = m[1].toLowerCase();
  // "Up 21 minutes (Paused)" is not running, whatever the elapsed time says.
  if (/\(paused\)/.test(rest)) return null;
  if (/less than a second|about a second/.test(rest)) return 1;
  const num = /about (an?|one)\s/.test(rest) ? 1 : parseInt(rest, 10);
  const n = Number.isFinite(num) ? num : 1;
  const unit = Object.keys(UNIT_SECS).find((u) => rest.includes(u));
  // No recognised unit means we did not understand the string - null, not 0.
  // Returning 0 put the node at the top of "recently started" as "0s ago".
  return unit ? n * UNIT_SECS[unit] : null;
}

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

/**
 * A dependency edge with both ends resolved against the discovered nodes.
 *
 * `to` is null when the declared target is not among them. That is not an error
 * to swallow - it is the single most useful thing this data can tell you. A
 * broken edge means something the author said was required is not there, which
 * is exactly the shape of "grafana is up but its datasource never started".
 */
export interface ResolvedEdge {
  from: PortalNode;
  to: PortalNode | null;
  /** The declared compose service name, kept so a broken edge can still name it. */
  toService: string;
  condition: string;
}

/**
 * Resolve `depends_on` declarations into edges between discovered nodes.
 *
 * Matching is `project` + `service`, never name similarity: compose service
 * names are unique only WITHIN a project, and this box has proved twice over
 * that matching across that boundary invents relationships. Pass the whole node
 * list, not one system's - an edge that leaves the system is worth seeing, and
 * scoping the input would silently hide it.
 */
export function resolveEdges(nodes: PortalNode[]): ResolvedEdge[] {
  const byKey = new Map<string, PortalNode>();
  for (const n of nodes) {
    const L = n.container?.labels;
    const project = L?.['com.docker.compose.project'];
    const service = L?.['com.docker.compose.service'];
    if (project && service) byKey.set(`${project}/${service}`, n);
  }
  const out: ResolvedEdge[] = [];
  for (const from of nodes) {
    const project = from.container?.labels?.['com.docker.compose.project'];
    if (!project) continue;
    for (const d of from.dependsOn) {
      out.push({
        from,
        to: byKey.get(`${project}/${d.service}`) ?? null,
        toService: d.service,
        condition: d.condition,
      });
    }
  }
  return out;
}

/**
 * OpenTelemetry resource attributes for a node - the vocabulary the rest of the
 * box already speaks.
 *
 * semconv defines `service.namespace` as "an entire system of components", which
 * is precisely what a compose project is, and `service.name` as the logical
 * component. This is not tidiness for its own sake: cAdvisor already exports
 * `container_label_com_docker_compose_project` and `_service` on EVERY series,
 * and promtail already ships the project as Loki's `stack` label. The join key
 * has existed on both backends the whole time, unused, while the portal joined
 * by container name instead.
 *
 * Returns null when the node has no compose identity (a `docker run` orphan, or
 * a declared host process). Callers must fall back rather than query for an
 * empty namespace, which would match everything.
 */
export function resourceAttrs(node: PortalNode): {
  'service.namespace': string;
  'service.name': string;
  'service.instance.id'?: string;
} | null {
  const L = node.container?.labels;
  const ns = L?.['com.docker.compose.project'];
  const name = L?.['com.docker.compose.service'];
  if (!ns || !name) return null;
  return {
    'service.namespace': ns,
    'service.name': name,
    ...(node.container?.id ? { 'service.instance.id': node.container.id } : {}),
  };
}

/**
 * The compose project shared by a set of nodes, or null if they disagree.
 *
 * Used to decide whether a whole system can be queried by ONE namespace label
 * instead of an alternation of container names. Disagreement is normal and not
 * an error - the `unmanaged` group is a bag of unrelated `docker run` containers
 * by definition, and a group holding declared host processes has no compose
 * project at all. Both must fall back to naming things individually.
 */
export function sharedNamespace(nodes: PortalNode[]): string | null {
  let ns: string | null = null;
  for (const n of nodes) {
    const a = resourceAttrs(n);
    // A node with no compose identity cannot vouch for the group: if any node
    // would be MISSED by a namespace query, the query is not equivalent to the
    // list and must not be substituted for it.
    if (!a) return null;
    if (ns === null) ns = a['service.namespace'];
    else if (ns !== a['service.namespace']) return null;
  }
  return ns;
}

/** Human wording for a compose `depends_on` condition. */
export function conditionLabel(condition: string): string {
  if (condition === 'service_healthy') return 'to be healthy';
  if (condition === 'service_completed_successfully') return 'to finish';
  if (condition === 'service_started') return 'to start';
  return condition;
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
  // Extra hostnames that resolve to this same backend. tilt.dev.test and
  // tilt.cvops.dev.test are one `tilt up` on one port, not two services.
  aliases: string[];
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
  serviceType: ServiceType;
  volumes: VolumeRef[];
  uptimeSecs: number | null;
  /**
   * What this service waits for, straight from `com.docker.compose.depends_on`.
   *
   * Compose has recorded this on every container it created since the stack was
   * written, and nothing has ever read it. Nine edges exist on this box -
   * `oauth2-proxy` waits for `keycloak` to be healthy, `keycloak` waits for
   * `keycloak-db-init` to COMPLETE, `grafana` waits for loki and prometheus.
   * That is the real wiring diagram, declared by the author rather than guessed
   * from network traffic or naming.
   */
  dependsOn: Dependency[];
  /**
   * Declared to run once and exit, rather than to keep running.
   *
   * There is no direct signal for this. `/containers/json` returns only
   * `HostConfig.NetworkMode`, so the restart policy is not visible, and
   * `com.docker.compose.oneoff` is `False` even for genuine init containers -
   * it means "started by `compose run`", not "runs once".
   *
   * What IS available is the author's intent, stated from the other side: if any
   * sibling declares `depends_on: <this>: service_completed_successfully`, then
   * finishing is this container's job. Coverage is therefore partial BY DESIGN -
   * if nothing depends on it completing, nobody has declared that it should, and
   * guessing from "exited 0" would be inventing intent the compose file never
   * expressed.
   */
  completesOnPurpose: boolean;
  icon: string;
  desc: string;
  // Where this service's logs live in Loki. Set for DECLARED services (the
  // collector knows whether a project tees to a host log file); left undefined
  // for discovered ones, where logSourceOf() derives it from the container name.
  logs?: { kind: 'container' | 'host'; selector: string; filter?: string | null } | null;
}

// The one place that answers "can I read this service's logs, and how".
//
// A declared source wins: only the project itself knows that its host processes
// tee into a shared log file and which prefix belongs to which service. Anything
// with a container falls back to the container stream, which promtail ships for
// every container on the box without per-service setup - and which Loki keeps
// after the container is gone, unlike `docker logs`.
export function logSourceOf(
  node: Pick<PortalNode, 'logs' | 'container'>,
): { kind: 'container' | 'host'; selector: string; filter?: string | null } | null {
  if (node.logs) return node.logs;
  const name = node.container?.name;
  return name ? { kind: 'container', selector: `{container="${name}"}` } : null;
}

// ── Pure: hostname handling ─────────────────────────────────────────────────

// Extract the Host() value from a Traefik rule.
//
// Returns null for ANYTHING it doesn't fully understand - `PathPrefix(`/`)`
// (portal-fallback has no Host at all), HostRegexp, multi-host Host(`a`,`b`).
// Guessing here silently files cards under the wrong project, which is worse
// than not showing them: a null falls through to the Routes tab, visibly.
export function extractHost(rule: unknown): string | null {
  if (typeof rule !== 'string') return null;
  if (/HostRegexp/i.test(rule)) return null;
  const m = rule.match(/Host\(`([^`]+)`\)/);
  if (!m) return null;
  // Host(`a`,`b`) - more than one host in a single call. Don't pick one.
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
  // No container = an @file host process. It has no compose labels to classify,
  // so the caller substitutes the hostname's own leaf as the group (see
  // makeNode). 'host' survives only as the last resort for a route whose
  // hostname told us nothing - it must never become a bucket of real services.
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

// ORDER MATTERS - first substring match wins. Vendor-prefixed images mean the
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
// (container.Image) - the two differ in case and mixing them silently drops
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
// title and unrouted card - titleCase can't know that "cvops" is "CVOps".
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

// Name with zero labels required. Labels only add polish - if this needs labels
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
  if (!base) {
    const raw = (container?.Names?.[0] || '').replace(/^\//, '');
    // A DOCKER-GENERATED name is not a name. With no `--name`, docker invents
    // `adjective_surname` - and title-cased into the service column,
    // `inspiring_dhawan` reads as something this box owns and somebody chose.
    // The image is the honest answer: it says what the container actually is,
    // which is the question the column is asking. Matched on the exact shape
    // docker generates (two lowercase words, one underscore) so a real name that
    // merely contains an underscore is untouched.
    base = /^[a-z]+_[a-z]+$/.test(raw) && (container?.Image || '')
      ? String(container?.Image).split('/').pop()!.split(':')[0]
      : raw;
  }
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

// Non-HTTP things are listed but not linked - clicking an S3 or postgres
// endpoint in a browser is never what you wanted.
// Images with no browsable UI. Two different reasons are mixed here, both
// meaning "do not offer a link":
//   · it does not speak HTTP at all (postgres, redis, kafka, the socket proxy);
//   · it speaks HTTP but has no interface for a human.
//
// `traefik` is the second kind, as of 2026-08-12. Its only UI was the dashboard,
// and that router was deleted the same day because it served the Traefik API
// unauthenticated and `/api/rawdata` exposed an injected credential. The
// container still publishes :80 - that is the edge listener every other service
// is reached THROUGH - so without this entry the portal cheerfully offered a
// "Traefik" link that just re-opened the portal.
const NON_HTTP = ['garage', 'postgres', 'redis', 'kafka:', 'apache/kafka', 'socket-proxy', 'traefik'];

/**
 * The port a browser can actually reach this container on, or null.
 *
 * Published on 0.0.0.0 only: a `127.0.0.1:` binding is reachable from this box
 * and from nothing else, so offering it as a link to someone on a phone is a
 * link that cannot work. Lowest port wins when several are published, purely so
 * the choice is deterministic - the Access page lists all of them.
 */
export function browsablePort(container?: Container | null): number | null {
  const p = portsOf(container).find((x) => x.scope === 'public' && (x.proto ?? 'tcp') === 'tcp');
  return p ? p.hostPort : null;
}

/**
 * Where a browser should go for this container.
 *
 * Built from `location.hostname`, so it is correct from whichever address the
 * portal itself was opened on - tailnet IP, MagicDNS name or localhost - without
 * the page ever knowing what that address is. That is the same trick the brand
 * line uses, and it is why nothing here hardcodes an address.
 */
export function containerUrl(container?: Container | null, path = ''): string | null {
  const port = browsablePort(container);
  if (port == null) return null;
  return `http://${location.hostname}${port === 80 ? '' : `:${port}`}${path}`;
}

/**
 * Can a browser open this?
 *
 * REWRITTEN 2026-08-12, when the `*.dev.test` name layer was retired. This used
 * to be `if (!host) return false` - browsability was a property of having a
 * Traefik hostname. Deleting the routers therefore made every service on the box
 * unbrowsable at once: the portal still listed them, but every "open" link
 * vanished, because the thing it keyed on no longer existed.
 *
 * Reachability is a property of having a PUBLISHED PORT, and always was. The
 * hostname was only ever a way of spelling one.
 */
export function isBrowsable(host: string | null, container?: Container | null): boolean {
  const img = (container?.Image || '').toLowerCase();
  if (NON_HTTP.some((k) => img.includes(k))) return false;
  // A routed host still counts, so a future host-less Path() route or a
  // re-introduced name layer keeps working without touching this again.
  return host != null || browsablePort(container) != null;
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

  // STATE IS CHECKED FIRST, and that order is load-bearing. A container that has
  // stopped keeps its last Health value, and for anything with a healthcheck
  // that value is `unhealthy` - docker reports a stale verdict, not a failing
  // check, because nothing is running to probe. Reading health first therefore
  // called every stopped postgres/redis/garage "down" while a stopped nginx (no
  // healthcheck, Health.Status "none") correctly came out "stopped": the exact
  // split observed on this box. Health is only meaningful while it is running.
  if (typeof s === 'string' && s !== 'running') return stateToStatus(s, container.Status);

  // Health is an OBJECT here - {Status, FailingStreak} - not a string, so
  // comparing it directly to 'healthy' was always false and every container
  // fell through to the State check below.
  if (h === 'healthy') return 'up';
  if (h === 'unhealthy') return 'down';
  if (h === 'starting') return 'starting';
  // State is the plain string on /containers/json. Comparing `container.State`
  // to 'running' directly was dead whenever the object shape the type permits
  // arrived - every container would have reported 'down'. Narrow first, and say
  // 'unknown' rather than 'down' when there is genuinely nothing to read.
  if (typeof s === 'string') return stateToStatus(s, container.Status);
  return 'unknown';
}

// /containers/json carries no ExitCode field - only the human `Status` string
// ("Exited (0) 34 minutes ago", "Exited (137) …"). That string is therefore the
// ONLY way to tell a clean shutdown from a crash without a per-container
// inspect, so parse it rather than treating every exit as a failure.
const EXIT_CODE = /^Exited \((\d+)\)/;

export function exitCodeOf(statusText?: string): number | null {
  const m = EXIT_CODE.exec(statusText?.trim() ?? '');
  return m ? Number(m[1]) : null;
}

export function stateToStatus(state: string, statusText?: string): Status {
  switch (state) {
    case 'running':
      return 'up';
    // Turned off on purpose. `created` never started, `paused` was suspended by
    // hand, and `exited` is judged by its code just below.
    case 'created':
    case 'paused':
      return 'stopped';
    case 'exited': {
      const code = exitCodeOf(statusText);
      // Unreadable status text is the only ambiguous case: don't invent a
      // failure, but don't claim it stopped cleanly either.
      if (code == null) return 'unknown';
      // 143 = 128+SIGTERM, i.e. exactly what `docker stop` sends. Landing on 0
      // vs 143 is a property of the application's shutdown code, not of whether
      // anything went wrong - redis handles SIGTERM and exits 0, the Keycloak
      // JVM dies from the signal and exits 143. Reading the second as a failure
      // made every deliberately-stopped JVM/service light up the dashboard.
      //
      // 137 (128+SIGKILL) is deliberately NOT forgiven here, unlike in the
      // portal-collector: that also means an OOM kill, and /containers/json
      // carries no OOMKilled field to tell the two apart. The collector has the
      // flag and can afford the nuance; from here, calling a possible OOM
      // "stopped" would hide the one crash you most want shouted about.
      return code === 0 || code === 143 ? 'stopped' : 'down';
    }
    // A container that keeps restarting, died, or is stuck mid-removal is the
    // real "needs a look" population.
    case 'restarting':
    case 'dead':
    case 'removing':
      return 'down';
    default:
      return 'unknown';
  }
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
  // Whole-list fact, so it is resolved once here rather than re-derived per node.
  const oneShots = declaredOneShots(containers);

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

  // Pass 1 - everything Traefik routes.
  //
  // Resolve every routable router first, THEN collapse: two routers can name the
  // same backend service (tilt.dev.test and tilt.cvops.dev.test are one `tilt up`
  // holding one fixed port), and that is one service with two names. Emitting it
  // twice double-counts it in the header total, in Needs attention and in the UI
  // lists, and forces a guess about which project owns it - the portal must not
  // guess (see extractHost). Containers are already de-duped by Id; this is the
  // same rule for @file backends, keyed on the resolved service.
  interface Candidate {
    route: Router;
    host: string;
    svcKey: string;
    serverUrls: string[];
    container: Container | null;
  }
  const bySvc = new Map<string, Candidate[]>();

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

    // A router with no service name can't be compared to anything - key it by
    // its own name so it never collapses into an unrelated route.
    const key = r.service ? svcKey : `router:${r.name}`;
    const list = bySvc.get(key);
    if (list) list.push({ route: r, host, svcKey, serverUrls, container });
    else bySvc.set(key, [{ route: r, host, svcKey, serverUrls, container }]);
  }

  for (const group of bySvc.values()) {
    // Canonical = the shallowest hostname, so the flat `tilt.dev.test` wins over
    // the project-scoped alias rather than the other way round. Alphabetical
    // tie-break keeps the choice stable across polls.
    const sorted = group.slice().sort((a, b) => {
      const da = nest(a.host).depth ?? Infinity;
      const db = nest(b.host).depth ?? Infinity;
      return da - db || a.host.localeCompare(b.host);
    });
    const [canonical, ...rest] = sorted;
    nodes.push(
      makeNode({
        route: canonical.route,
        host: canonical.host,
        serverUrls: canonical.serverUrls,
        container: canonical.container,
        names,
        oneShots,
        kind: canonical.container ? 'routed' : 'orphan-route',
        aliases: rest.map((c) => c.host),
      }),
    );
  }

  // Pass 2 - EVERY remaining container, routed or not, published or not.
  //
  // This used to require a published port. The rule was "route OR published
  // port", justified as the correct definition of "a thing a human can reach",
  // and it deliberately dropped promtail and the exporters as plumbing.
  //
  // That reasoning died with the name layer on 2026-08-12. With no routers left,
  // "route OR port" collapsed to "port", and TEN running containers went
  // invisible at once - promtail, postgres-exporter, oauth2-proxy,
  // portal-socket-proxy, and `portal-next` ITSELF. The page could not see the
  // container serving it. It showed 16 services while 21 were running.
  //
  // The deeper mistake is conflating two different questions. "Can I open this?"
  // is a property of having an address, and `isBrowsable`/`url` answer it
  // honestly. "Is this running on my box?" is a property of EXISTING. A control
  // plane has to answer the second one for everything, including the plumbing -
  // an exporter that has died is exactly the kind of thing you need to be told
  // about, and it was precisely the class this filter hid.
  //
  // Cost, accepted: containers belonging to other projects (cvops-*, mpeg-*)
  // and one-shot init containers now appear. They are real things on this box.
  // Grouping files them under their own compose project, and `stopped` recedes
  // visually, so honesty costs less than the blind spot did.
  for (const c of containers) {
    if (claimed.has(c.Id)) continue;
    nodes.push(makeNode({ route: null, host: null, container: c, names, oneShots, kind: 'unrouted' }));
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
  aliases?: string[];
  /**
   * `project/service` keys declared to run to completion. Computed once per
   * merge() and passed down, because it is a fact about the WHOLE container
   * list - a container cannot tell you it is a one-shot, only its dependents
   * can. Defaulted so the existing tests and any other caller stay valid.
   */
  oneShots?: Set<string>;
}

function makeNode({
  route,
  host,
  serverUrls = [],
  container,
  kind,
  names = new Map(),
  aliases = [],
  oneShots = new Set(),
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
    aliases,
    path,
    // The container's own published port FIRST. `hostUrl` is a lookup keyed by
    // *.dev.test hostname, and those names are retired - it survives only for
    // the handful of host processes that have a known port but no container.
    url: browsable ? (containerUrl(container, path) ?? (host ? hostUrl(host, path) : null)) : null,
    browsable,
    // hostname nesting BEATS config_files: it's what puts cvops-tilt@file (no
    // container at all) in the CVOps panel. Makes the DNS convention load-bearing.
    //
    // A depth-1 host process (tals.dev.test) has no parent, so it used to fall
    // through to classify()'s 'host' sentinel - which filed Tals' own front-end
    // under a fabricated system, separate from api/auth/algo.tals.dev.test. Its
    // leaf IS its system name, so use that.
    group: pick('group', n.parent || (container ? cls.group : n.leaf || cls.group)),
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
    serviceType: 'other',
    volumes: volumesOf(container),
    dependsOn: dependsOnOf(container),
    completesOnPurpose: oneShots.has(
      `${L['com.docker.compose.project']}/${L['com.docker.compose.service']}`,
    ),
    uptimeSecs: parseUptime(container?.Status),
    icon: '',
    desc: '',
  };
  node.serviceType = serviceTypeOf(node);
  node.icon = pick('icon', iconFor(node));
  node.desc = pick('desc', defaultDesc(node));
  return node;
}

function defaultDesc(node: PortalNode): string {
  if (node.kind === 'orphan-route' && node.route?.provider === 'file') {
    return 'Host process reached through the edge. Expect 502 when it is not running.';
  }
  if (node.kind === 'orphan-route') {
    return 'Route registered, but no container found on devnet - it may have stopped.';
  }
  if (node.kind === 'unrouted') {
    return `${node.container?.image || 'Container'} - published port, no edge route.`;
  }
  return `${node.container?.image || ''}`.trim() || 'Routed service.';
}

// Docker lists 0.0.0.0 and :: as separate rows for the same bind - collapse
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

// Every published port on the box, flattened - the collision map.
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
