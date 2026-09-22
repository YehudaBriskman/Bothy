// The Control landing's pure logic: what goes in "Needs attention" and in what
// order, which operator-only sources a session may ask for, and the small
// summaries the health strip and the cards print.
//
// IMPORTS NOTHING, on the rule checks/run.sh is built around: it compiles this
// file with a bare tsc and runs checks/control-home.mjs against it. The page
// (ControlHome.tsx) adapts the live shapes - PortalNode, UpdatesStatus,
// BackupsResult - into the plain inputs below, so the rules that decide what a
// person is told to look at first can be tested without React or a network.

// ── role gating ──────────────────────────────────────────────────────────────

/** Which sources the page may REQUEST for this session. The edge decides what is
 *  permitted; this decides what is asked for, so a viewer's tab never sends an
 *  operator-only read (and never writes a refused line into admin.log). */
export interface Gates {
  /** GET /-/api/updates/status - sso-viewer at the edge. */
  updates: boolean;
  /** GET /-/api/admin/backups - sso-operator. */
  backups: boolean;
  /** GET /-/api/admin/audit - sso-operator. */
  audit: boolean;
  /** Whether the row verbs are drawn enabled (the dialog re-checks). */
  act: boolean;
}

export const NO_GATES: Gates = { updates: false, backups: false, audit: false, act: false };

/**
 * `roles` is null while the session has not answered, and for a signed-out
 * browser. Nothing is requested until it has answered: asking first and
 * discarding the answer would still be a request the role never allowed.
 */
export function gatesFor(roles: readonly string[] | null, loading: boolean): Gates {
  if (loading || !roles) return NO_GATES;
  const operator = roles.includes('operator');
  const viewer = roles.includes('viewer') || operator;
  return { updates: viewer, backups: operator, audit: operator, act: operator };
}

// ── the attention list ───────────────────────────────────────────────────────

export type Severity = 'critical' | 'warning' | 'notice';

export type AttentionKind =
  | 'service-down'
  | 'cluster-node'
  | 'router-disabled'
  | 'port-collision'
  | 'backup-stale'
  | 'route-orphan'
  | 'namespace-empty'
  | 'update-paused'
  | 'route-unverified'
  | 'update-waiting';

/** Rank inside a severity: what you would fix first. A service that is down
 *  outranks a route that points at it; a stale backup outranks a paused update
 *  because it is what every update's pre-flight waits on. */
export const KIND_ORDER: readonly AttentionKind[] = [
  'service-down', 'cluster-node', 'router-disabled', 'port-collision',
  'backup-stale', 'route-orphan', 'namespace-empty', 'update-paused',
  'route-unverified', 'update-waiting',
];

export const SEVERITY_OF: Record<AttentionKind, Severity> = {
  'service-down': 'critical',
  'cluster-node': 'critical',
  'router-disabled': 'critical',
  'port-collision': 'critical',
  'backup-stale': 'warning',
  'route-orphan': 'warning',
  'namespace-empty': 'warning',
  'update-paused': 'warning',
  'route-unverified': 'notice',
  'update-waiting': 'notice',
};

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'warning', 'notice'];

export interface AttentionItem {
  key: string;
  kind: AttentionKind;
  severity: Severity;
  /** The thing: a service, a router, a port, a namespace, a component. */
  subject: string;
  /** What is wrong with it, in a few words. */
  what: string;
  /** Where the fix lives - an in-app route. */
  to: string;
  /** The page that owns it, named so the row says where it goes. */
  where: string;
  /** Set on a service row: the node the page draws Open and restart for. */
  nodeId?: string;
}

export interface DownService { id: string; name: string; groupTitle: string }
export interface RouteProblem { router: string; state: 'disabled' | 'no-container' | 'unknown'; status?: string }
export interface PortCollision { port: string; containers: string[] }
export interface ClusterFacts {
  /** kube-state-metrics answered at all. False: the cluster is off or unscraped. */
  reporting: boolean;
  /** The node's Ready condition; null when nothing reported it. */
  nodeReady: boolean | null;
  node: string | null;
  /** In-scope namespaces (the ones bothy-ops acts on) with no pods at all. */
  emptyNamespaces: string[];
}
export interface UpdateFacts {
  /** Components with a newer version on a channel that waits for a person. */
  waiting: { id: string; title: string; level: string }[];
  /** Components the night job has stopped touching. */
  paused: { id: string; title: string; reason: string }[];
}
export interface BackupFacts {
  /** Managed sets whose newest copy is older than the stale threshold. */
  stale: { name: string; ageSeconds: number | null }[];
  /** ~/backups does not exist: nothing has ever run. */
  missing: boolean;
}

export interface AttentionInput {
  down: DownService[];
  routes: RouteProblem[];
  collisions: PortCollision[];
  /** null: the cluster source was not asked or did not answer. */
  cluster: ClusterFacts | null;
  /** null: not requested for this role, or unavailable. */
  updates: UpdateFacts | null;
  /** null: operator-only, or unavailable. */
  backups: BackupFacts | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function fmtAge(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'unknown';
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Everything actionable, in the order it should be read. */
export function attentionList(input: AttentionInput): AttentionItem[] {
  const out: AttentionItem[] = [];
  const push = (i: Omit<AttentionItem, 'severity'>) => out.push({ ...i, severity: SEVERITY_OF[i.kind] });

  for (const d of input.down) {
    push({
      key: `down:${d.id}`, kind: 'service-down', subject: d.name, what: `down · ${d.groupTitle}`,
      to: `/control/services/${encodeURIComponent(d.id)}`, where: 'Services', nodeId: d.id,
    });
  }

  const c = input.cluster;
  if (c && c.reporting && c.nodeReady === false) {
    push({
      key: 'cluster:node', kind: 'cluster-node', subject: c.node ?? 'cluster node',
      what: 'node is not Ready', to: '/control/cluster', where: 'Cluster',
    });
  }
  if (c && c.reporting) {
    for (const ns of c.emptyNamespaces) {
      push({
        key: `ns:${ns}`, kind: 'namespace-empty', subject: ns, what: 'namespace has no workloads',
        to: `/control/cluster?ns=${encodeURIComponent(ns)}`, where: 'Cluster',
      });
    }
  }

  for (const r of input.routes) {
    const name = r.router.split('@')[0];
    if (r.state === 'disabled') {
      push({ key: `router:${r.router}`, kind: 'router-disabled', subject: name, what: `router is ${r.status ?? 'disabled'}`, to: '/control/routes', where: 'Routes' });
    } else if (r.state === 'no-container') {
      push({ key: `router:${r.router}`, kind: 'route-orphan', subject: name, what: 'routed to no container', to: '/control/routes', where: 'Routes' });
    } else {
      push({ key: `router:${r.router}`, kind: 'route-unverified', subject: name, what: 'host process, not verified', to: '/control/routes', where: 'Routes' });
    }
  }

  for (const p of input.collisions) {
    push({ key: `port:${p.port}`, kind: 'port-collision', subject: p.port, what: `claimed by ${p.containers.join(' and ')}`, to: '/control/ports', where: 'Ports' });
  }

  const b = input.backups;
  if (b?.missing) {
    push({ key: 'backup:none', kind: 'backup-stale', subject: 'Backups', what: 'no backup has ever run', to: '/settings/backups', where: 'Backups' });
  } else if (b) {
    for (const s of b.stale) {
      push({ key: `backup:${s.name}`, kind: 'backup-stale', subject: s.name, what: `newest backup is ${fmtAge(s.ageSeconds)} old`, to: '/settings/backups', where: 'Backups' });
    }
  }

  const u = input.updates;
  if (u) {
    for (const p of u.paused) {
      push({ key: `paused:${p.id}`, kind: 'update-paused', subject: p.title, what: `automatic updates paused${p.reason ? ` - ${p.reason}` : ''}`, to: '/settings/updates', where: 'Updates' });
    }
    // One row, not one per component: "4 updates wait for you" is the fact, and
    // the Updates page is where they are told apart.
    if (u.waiting.length) {
      push({
        key: 'updates:waiting', kind: 'update-waiting',
        subject: plural(u.waiting.length, 'update'),
        what: `waiting for approval: ${u.waiting.slice(0, 3).map((w) => w.title).join(', ')}${u.waiting.length > 3 ? ', …' : ''}`,
        to: '/settings/updates', where: 'Updates',
      });
    }
  }

  return sortAttention(out);
}

/** Severity first, then the kind's rank, then the subject - stable across polls,
 *  so a list that has not changed does not reshuffle under the pointer. */
export function sortAttention(items: AttentionItem[]): AttentionItem[] {
  const sev = (s: Severity) => SEVERITY_ORDER.indexOf(s);
  const kind = (k: AttentionKind) => KIND_ORDER.indexOf(k);
  return [...items].sort((a, b) =>
    sev(a.severity) - sev(b.severity) || kind(a.kind) - kind(b.kind) || a.subject.localeCompare(b.subject));
}

/** Count per severity, for the section's heading. */
export function severityCounts(items: AttentionItem[]): Record<Severity, number> {
  const n: Record<Severity, number> = { critical: 0, warning: 0, notice: 0 };
  for (const i of items) n[i.severity] += 1;
  return n;
}

// ── summaries ────────────────────────────────────────────────────────────────

/** Ports claimed by two or more distinct containers - the same rule the previous
 *  landing used: by port AND protocol, across bind addresses, distinct containers. */
export function portCollisions(ports: { hostPort: number | string; proto: string; container: string }[]): PortCollision[] {
  const by = new Map<string, Set<string>>();
  for (const p of ports) {
    const k = `${p.hostPort}/${p.proto}`;
    let s = by.get(k);
    if (!s) by.set(k, (s = new Set()));
    s.add(p.container);
  }
  return [...by].filter(([, s]) => s.size > 1).map(([port, s]) => ({ port, containers: [...s].sort() }));
}

export interface RouteCounts { total: number; enabled: number; problems: number }

export function routeCounts(routers: { name: string; status?: string }[], problems: RouteProblem[]): RouteCounts {
  return {
    total: routers.length,
    enabled: routers.filter((r) => !r.status || r.status === 'enabled').length,
    // Unverified host processes are not counted as problems - they are unknown,
    // and a headline that counted them would never read clean on this box.
    problems: problems.filter((p) => p.state !== 'unknown').length,
  };
}

/** Mirrors pages/settings/Backups.tsx: a managed set is old at two days. */
export const BACKUP_STALE_SECONDS = 2 * 86_400;

export interface BackupSetLike { name: string; managed?: boolean; newest?: { at: string | null } | null }

export interface BackupSummary {
  /** Age of the newest copy across managed sets, seconds; null when none. */
  newestAge: number | null;
  facts: BackupFacts;
}

export function backupSummary(
  d: { present?: boolean; sets: BackupSetLike[] },
  now: number,
): BackupSummary {
  if (d.present === false) return { newestAge: null, facts: { stale: [], missing: true } };
  const managed = d.sets.filter((s) => s.managed);
  const ageOf = (s: BackupSetLike) => {
    const t = s.newest?.at ? Date.parse(s.newest.at) : NaN;
    return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : null;
  };
  const ages = managed.map(ageOf);
  const known = ages.filter((a): a is number => a != null);
  const stale = managed
    .map((s, i) => ({ name: s.name, ageSeconds: ages[i] }))
    .filter((s) => s.ageSeconds == null || s.ageSeconds > BACKUP_STALE_SECONDS);
  return { newestAge: known.length ? Math.min(...known) : null, facts: { stale, missing: false } };
}

export interface UpdateRowLike {
  id: string;
  title: string;
  level: string | null;
  effectiveChannel: string | null;
  paused?: { reason: string } | null;
}

export interface UpdatesSummary {
  available: number;
  /** The largest step on offer across components: major > minor > patch. */
  top: string | null;
  facts: UpdateFacts;
}

const LEVEL_RANK = ['patch', 'minor', 'major'];

export function updatesSummary(rows: UpdateRowLike[]): UpdatesSummary {
  const avail = rows.filter((r) => r.level);
  let top: string | null = null;
  for (const r of avail) if (LEVEL_RANK.indexOf(r.level!) > LEVEL_RANK.indexOf(top ?? '')) top = r.level;
  return {
    available: avail.length,
    top,
    facts: {
      // `auto` updates apply themselves at night; everything else waits for a person.
      waiting: avail.filter((r) => r.effectiveChannel !== 'auto').map((r) => ({ id: r.id, title: r.title, level: r.level! })),
      paused: rows.filter((r) => r.paused).map((r) => ({ id: r.id, title: r.title, reason: r.paused!.reason })),
    },
  };
}

/** In-scope namespaces with no pods, given the pod count per namespace. */
export function emptyNamespaces(scope: readonly string[], podsByNs: Record<string, number>, existing: readonly string[]): string[] {
  // A namespace that does not exist is not "empty" - it is absent, and the
  // cluster page says so. Only one that exists and holds nothing is news.
  return scope.filter((ns) => existing.includes(ns) && !(podsByNs[ns] > 0));
}
