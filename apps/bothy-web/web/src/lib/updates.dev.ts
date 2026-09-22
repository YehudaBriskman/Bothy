// The stand-in for GET /-/api/updates/status, used by `vite dev` and nothing else.
//
// lib/updates.ts routes here behind `import.meta.env.DEV`, a literal `false` after
// a build. The shape is the service's allow-list, and the data is shaped like this
// box's first real discovery run (2026-09-19): Grafana, Loki and Keycloak merged
// but never applied (drift), Traefik's and Postgres' floating tags moved under
// them, a Postgres major on offer and our own v2026.9.0 - plus, invented, one
// registry that rate-limited the run and a cluster that did not answer.
//
// Not a happy path. Force a state from the console:
//
//   localStorage['bothy-dev-updates-outcome'] = 'signed-out' | 'no-viewer' | 'fault'
//                                             | 'silence' | 'undiscovered' | 'stale'
//                                             | 'current'
//
// `undiscovered` is a fresh deploy before the timer's first run; `current` is a box
// with nothing to do.
//
// Step 4 - plans, a request, a job. Four rows are deployable (Loki 3.7.6 -> 3.7.7,
// time-series; Alloy, stateless; Grafana 13.1.4 -> 13.2.2 and Keycloak 26.7.3-0 ->
// 26.7.4-0, the one-way app-db class: type the name, two pins for Keycloak);
// every other row carries the reason the host
// would give. A requested job advances by WALL CLOCK from its requestedAt (kept in
// localStorage), so a reload mid-run resumes where it was - the property the real
// panel needs. It ends `succeeded` unless forced:
//
//   localStorage['bothy-dev-updates-job'] = 'rolled_back' | 'aborted' | 'failed' | 'refused'
//   localStorage['bothy-dev-updates-request'] = 'stale' | 'busy' | 'no-operator'
//
// Step 7 - the automatic channel. The seed history has a night job's success
// (node-exporter) and its rollback (VictoriaMetrics), so VictoriaMetrics is PAUSED
// until Unpause; the "host" clears it a few seconds after the request, the way the
// real spool round trip does. Reset with localStorage.removeItem('bothy-dev-updates-unpaused').
// Step 6 - Bothy itself. Its row is deployable too: v2026.8.1 -> the green release
// v2026.9.0, a plan whose diff touches another stack (so it is type-the-name) and
// the updater (so a new updater copy is staged, not switched). Its job runs the
// own-code steps (build, arm, switch, stage). The installed updater:
//
//   localStorage['bothy-dev-updates-updater'] = 'staged' | 'none'

import type {
  AutoDecision, Channel, Discovered, HistoryEntry, Job, JobState, JobStep, Level, Pause, Plan, PlanAnswer, PlanSummary,
  RequestAnswer, StepName, UnpauseAnswer, UpdateRow, UpdaterInfo, UpdatesStatus, VersionRef,
} from './updates';

const OUTCOME_KEY = 'bothy-dev-updates-outcome';
const JOB_OUTCOME_KEY = 'bothy-dev-updates-job';
const REQUEST_KEY = 'bothy-dev-updates-request';
const JOBS_KEY = 'bothy-dev-updates-jobs';
const UNPAUSED_KEY = 'bothy-dev-updates-unpaused';
const UPDATER_KEY = 'bothy-dev-updates-updater';

const read = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};

function refuse(status: number, message: string, fromService: boolean): never {
  const e = new Error(message) as Error & { status: number; fromService: boolean; body: object };
  e.name = 'ApiRefused';
  e.status = status;
  e.fromService = fromService;
  e.body = fromService ? { error: message } : {};
  throw e;
}

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const dg = (c: string) => `sha256:${c.repeat(64)}`;

// The policy table, as updates.effective_channel() states it.
function effective(channel: Channel, level: Level | null): Channel | null {
  if (!level) return null;
  if (level === 'major' || channel === 'manual') return 'manual';
  if (channel === 'auto') return level === 'patch' ? 'auto' : 'notify';
  return 'notify';
}

interface Spec {
  id: string; title: string; cls: string; source?: UpdateRow['source']; pins: string[]; apply: string;
  channel: Channel; oneWayWhy?: string; changelog: string; dependants?: string[];
  tag: string | null; version?: string | null; float?: boolean; running?: string | null; runningDigest?: string;
  runningVersion?: string; drift?: string; floatMoved?: boolean; floatTarget?: string; error?: string;
  identifiedAs?: string; notes?: string[];
  cands?: Partial<Record<Level, string>>;
}

const SPECS: Spec[] = [
  { id: 'cadvisor', title: 'cAdvisor', cls: 'stateless', pins: ['monitoring/compose.yml:cadvisor'], apply: 'just up-monitoring', channel: 'auto',
    changelog: 'https://github.com/google/cadvisor/releases/tag/v{v}', tag: 'v0.55.1', running: 'gcr.io/cadvisor/cadvisor:v0.55.1',
    error: 'RateLimited: gcr.io answered 429 (rate limit); no more calls to it this run' },
  { id: 'node-exporter', title: 'node-exporter', cls: 'stateless', pins: ['monitoring/compose.yml:node-exporter'], apply: 'just up-monitoring',
    channel: 'auto', changelog: 'https://github.com/prometheus/node_exporter/releases/tag/v{v}', tag: 'v1.12.1', running: 'prom/node-exporter:v1.12.1' },
  { id: 'postgres-exporter', title: 'postgres-exporter', cls: 'stateless', pins: ['data/postgres/compose.yml:postgres-exporter'],
    apply: 'just up-data', channel: 'auto', changelog: 'https://github.com/prometheus-community/postgres_exporter/releases/tag/v{v}',
    tag: null, version: '0.20.1', identifiedAs: 'v0.20.1', runningVersion: '0.20.1',
    running: 'quay.io/prometheuscommunity/postgres-exporter@sha256:…' },
  { id: 'alloy', title: 'Alloy', cls: 'stateless', pins: ['monitoring/compose.yml:alloy'], apply: 'just up-monitoring', channel: 'auto',
    changelog: 'https://github.com/grafana/alloy/releases/tag/v{v}', tag: 'v1.19.2', running: 'grafana/alloy:v1.19.2', cands: { patch: 'v1.19.3' } },
  { id: 'headlamp', title: 'Headlamp', cls: 'stateless', pins: ['apps/headlamp/compose.yml:headlamp'], apply: 'just up-headlamp', channel: 'auto',
    changelog: 'https://github.com/headlamp-k8s/headlamp/releases/tag/v{v}', dependants: ['oauth2-proxy-headlamp'], tag: 'v0.45.0',
    running: null, cands: { minor: 'v0.46.0' } },
  { id: 'victoriametrics', title: 'VictoriaMetrics', cls: 'timeseries', pins: ['monitoring/compose.yml:victoriametrics'], apply: 'just up-monitoring',
    channel: 'auto', changelog: 'https://docs.victoriametrics.com/victoriametrics/changelog/', dependants: ['grafana', "the portal's vitals"],
    tag: 'v1.152.0', running: 'victoriametrics/victoria-metrics:v1.152.0', cands: { minor: 'v1.153.0' } },
  { id: 'loki', title: 'Loki', cls: 'timeseries', pins: ['monitoring/compose.yml:loki'], apply: 'just up-monitoring', channel: 'auto',
    changelog: 'https://github.com/grafana/loki/releases/tag/v{v}', dependants: ['alloy', 'grafana'], tag: '3.7.7', running: 'grafana/loki:3.7.6',
    drift: 'loki runs grafana/loki:3.7.6, monitoring/compose.yml pins grafana/loki:3.7.7', cands: { patch: '3.7.8' } },
  { id: 'grafana', title: 'Grafana', cls: 'app-db', pins: ['monitoring/compose.yml:grafana'], apply: 'just up-monitoring', channel: 'notify',
    oneWayWhy: "grafana.db's schema migrates on first start and cannot be downgraded. Stop Grafana and copy the volume first.",
    changelog: 'https://github.com/grafana/grafana/releases/tag/v{v}', tag: '13.2.2', running: 'grafana/grafana:13.1.4',
    drift: 'grafana runs grafana/grafana:13.1.4, monitoring/compose.yml pins grafana/grafana:13.2.2', cands: { minor: '13.3.0' } },
  { id: 'traefik', title: 'Traefik', cls: 'edge', pins: ['edge/compose.yml:traefik'], apply: 'just up-edge', channel: 'notify',
    changelog: 'https://github.com/traefik/traefik/releases/tag/v{v}', dependants: ['every route on :80', 'this page'], tag: 'v3.7', float: true,
    running: 'traefik:v3.7', runningVersion: '3.7.9', floatMoved: true, floatTarget: 'v3.7.13', cands: { patch: 'v3.7', minor: 'v3.8' } },
  { id: 'bothy', title: 'Bothy (web, files, ops)', cls: 'own-code', source: 'github', pins: ['VERSION'], apply: 'just up-apps', channel: 'notify',
    changelog: 'https://github.com/YehudaBriskman/Bothy/releases/tag/v{v}', dependants: ['bothy-web', 'bothy-files', 'bothy-ops'],
    tag: 'v2026.8.1', cands: { minor: 'v2026.9.0' } },
  { id: 'kube-state-metrics', title: 'kube-state-metrics (chart)', cls: 'cluster', source: 'helm', pins: ['k8s/monitoring/Chart.yaml:kube-state-metrics'],
    apply: 'just k8s-monitoring', channel: 'notify', changelog: 'https://github.com/prometheus-community/helm-charts/releases/tag/kube-state-metrics-{v}',
    tag: '8.5.0', running: null, notes: ['the cluster did not answer - installed chart unknown'],
    cands: { patch: '8.5.2', minor: '8.6.0' } },
  { id: 'alloy-cluster', title: 'Alloy (cluster DaemonSet)', cls: 'cluster', source: 'manifest', pins: ['k8s/monitoring/alloy.yaml:alloy'],
    apply: 'just k8s-monitoring', channel: 'notify', changelog: 'https://github.com/grafana/alloy/releases/tag/v{v}', tag: 'v1.19.2', running: null,
    cands: { patch: 'v1.19.3' } },
  { id: 'keycloak', title: 'Keycloak', cls: 'app-db', pins: ['auth/compose.yml:keycloak', 'auth/compose.yml:keycloak-init'], apply: 'just up-auth',
    channel: 'manual', oneWayWhy: 'Keycloak migrates its database on first start; the only way back is the pre-update pg_dump of the keycloak database.',
    changelog: 'https://github.com/keycloak/keycloak/releases/tag/{v}', dependants: ['oauth2-proxy', 'every gated route (fails closed while it is down)'],
    tag: '26.7.4-0', version: '26.7.4', running: 'quay.io/keycloak/keycloak:26.7.3-0',
    drift: 'keycloak runs quay.io/keycloak/keycloak:26.7.3-0, auth/compose.yml pins quay.io/keycloak/keycloak:26.7.4-0' },
  { id: 'oauth2-proxy', title: 'oauth2-proxy', cls: 'boundary', pins: ['auth/compose.yml:oauth2-proxy'], apply: 'just up-auth', channel: 'manual',
    changelog: 'https://github.com/oauth2-proxy/oauth2-proxy/releases/tag/v{v}', dependants: ['every gated route'], tag: 'v7.15.4',
    running: 'quay.io/oauth2-proxy/oauth2-proxy:v7.15.4' },
  { id: 'oauth2-proxy-headlamp', title: 'oauth2-proxy (Headlamp)', cls: 'boundary', pins: ['apps/headlamp/compose.yml:oauth2-proxy-headlamp'],
    apply: 'just up-headlamp', channel: 'manual', changelog: 'https://github.com/oauth2-proxy/oauth2-proxy/releases/tag/v{v}', dependants: ['headlamp'],
    tag: 'v7.15.4', running: null },
  { id: 'socket-proxy', title: 'Docker socket proxies (read, write)', cls: 'boundary',
    pins: ['apps/bothy/compose.socket-proxy.yml:socket-read', 'apps/bothy/compose.socket-proxy.yml:socket-write'], apply: 'just up-apps', channel: 'manual',
    changelog: 'https://github.com/Tecnativa/docker-socket-proxy/releases/tag/v{v}', dependants: ['bothy-ops', "the portal's Docker reads"],
    tag: '0.3.0', running: 'tecnativa/docker-socket-proxy:0.3.0' },
  { id: 'postgres', title: 'Postgres', cls: 'database', pins: ['data/postgres/compose.yml:postgres', 'auth/compose.yml:keycloak-db-init'],
    apply: 'just up-data', channel: 'manual',
    oneWayWhy: "A major version cannot open the previous major's data directory; it is a dump, a new volume and a restore (docs/plans/updates.md §5).",
    changelog: 'https://www.postgresql.org/docs/release/', dependants: ['keycloak', 'postgres-exporter'], tag: '17', float: true,
    running: 'postgres:17', floatMoved: true, floatTarget: '17.11', cands: { minor: '17', major: '18' } },
];

const bare = (t: string) => t.replace(/^v/, '').replace(/-\d+$/, '');
const ORDER: Level[] = ['major', 'minor', 'patch'];

function row(s: Spec, checkedAt: string, discovered: boolean): UpdateRow {
  const cands: Partial<Record<Level, VersionRef>> = {};
  for (const [lv, t] of Object.entries(s.cands ?? {}) as [Level, string][]) {
    const moved = s.float && t === s.tag;
    cands[lv] = { tag: t, version: moved ? (s.floatTarget ? bare(s.floatTarget) : null) : bare(t),
      digest: dg(lv[0] === 'p' ? 'a' : lv[0] === 'm' ? 'b' : 'c'), level: lv,
      ...(moved ? { floating: true } : { publishedAt: ago(86400 * (lv === 'patch' ? 2 : lv === 'minor' ? 9 : 40)) }) };
  }
  const top = ORDER.find((l) => cands[l]);
  const latest = top ? cands[top]! : null;
  const d: Discovered | null = !discovered ? null : {
    checkedAt, error: s.error ?? null, image: null,
    current: { tag: s.tag, version: s.version ?? (s.tag && !s.float ? bare(s.tag) : null), digest: s.tag ? null : dg('e'), float: !!s.float,
      floatTarget: s.floatTarget ?? null, identifiedAs: s.identifiedAs ?? null },
    running: s.running ? [{ name: s.id, image: s.running, digest: s.runningDigest ?? dg('d'), state: 'running' }] : [],
    runningVersion: s.runningVersion ?? null, drift: s.drift ?? null, notes: s.notes ?? [], floatMoved: s.floatMoved ?? null,
    latest: s.error ? null : latest, candidates: s.error ? {} : cands,
  };
  const level = d?.latest?.level ?? null;
  const ver = d?.latest?.version ?? d?.current.version;
  return {
    id: s.id, title: s.title, class: s.cls, source: s.source ?? 'image', pins: s.pins, apply: s.apply,
    dependants: s.dependants ?? [], channel: s.channel, oneWay: !!s.oneWayWhy, oneWayWhy: s.oneWayWhy ?? null,
    verify: ['container healthy'],
    changelog: s.changelog.includes('{v}') && ver ? s.changelog.replace('{v}', ver) : s.changelog.split('{v}')[0].replace(/tag\/v?$/, ''),
    level, effectiveChannel: effective(s.channel, level), behind: level === 'minor' || level === 'major', discovered: d,
    plan: discovered ? summaryOf(s.id) : null,
    ...pauseOf(s.id),
  };
}

// ── step 7: the pause the seed's automatic rollback left, and its unpause ────

const PAUSED_SEED: Record<string, Pause> = {
  victoriametrics: {
    since: ago(86400 * 5 - 184), result: 'rolled_back', jobId: 'e'.repeat(32), requestedBy: 'auto',
    reason: 'rolled back: `up` returned no series within 120 s',
  },
};

/** {at} of an unpause asked for in this browser, per component. */
function unpaused(): Record<string, number> {
  try { return JSON.parse(read(UNPAUSED_KEY) ?? '{}') as Record<string, number>; } catch { return {}; }
}

function pauseOf(id: string): { paused: Pause | null; unpauseQueued: boolean } {
  const p = PAUSED_SEED[id];
  const at = unpaused()[id];
  if (!p) return { paused: null, unpauseQueued: false };
  if (at && Date.now() - at > 4000) return { paused: null, unpauseQueued: false };
  return { paused: p, unpauseQueued: !!at };
}

export async function unpauseMock(component: string): Promise<UnpauseAnswer> {
  await new Promise((r) => setTimeout(r, 300));
  if (read(REQUEST_KEY) === 'no-operator') refuse(403, 'Forbidden', false);
  const st = pauseOf(component);
  if (!st.paused) refuse(409, `automatic updates are not paused for ${component}`, true);
  if (st.unpauseQueued) refuse(409, `an unpause of ${component} is already waiting for the host`, true);
  try { localStorage.setItem(UNPAUSED_KEY, JSON.stringify({ ...unpaused(), [component]: Date.now() })); } catch { /* per-tab */ }
  return { ok: true, id: 'a'.repeat(32), component };
}

const LAST_NIGHT: AutoDecision = {
  at: ago(3600 * 6), outcome: 'skipped', component: null, jobId: null,
  reason: 'nothing eligible: no auto component has a deployable patch plan that is not paused',
};

export async function updatesMock(): Promise<UpdatesStatus> {
  await new Promise((r) => setTimeout(r, 240));
  const forced = read(OUTCOME_KEY);
  if (forced === 'signed-out') refuse(401, 'Unauthorized', false);
  if (forced === 'no-viewer') refuse(403, 'Forbidden', false);
  if (forced === 'fault') refuse(502, 'available.json could not be read (JSONDecodeError)', true);
  if (forced === 'silence') refuse(0, 'no answer', false);
  const discovered = forced !== 'undiscovered';
  const stale = forced === 'stale';
  const age = stale ? 86400 + 3600 : 3600 * 2 + 780;
  const at = ago(age);
  let rows = SPECS.map((s) => row(s, at, discovered));
  if (forced === 'current') {
    rows = SPECS.map((s) => row({ ...s, cands: {}, drift: undefined, floatMoved: false, error: undefined }, at, true));
  }
  const d = rows.map((r) => r.discovered);
  return {
    discovery: discovered
      ? { present: true, generatedAt: at, ageSeconds: age, stale, hint: null }
      : { present: false, generatedAt: null, ageSeconds: null, stale: true,
        hint: 'Nothing discovered yet - run `just updates-discover` on the host (host/systemd/bothy-updates-discover.timer keeps it fresh).' },
    summary: {
      components: rows.length,
      updates: rows.filter((r) => r.level).length,
      behind: rows.filter((r) => r.behind).length,
      drift: d.filter((x) => x?.drift).length,
      errors: d.filter((x) => x?.error).length,
    },
    policy: { windowStart: '03:30', windowEnd: '05:00', requireBackup: 'stacks-backup.service', requireDoctor: true,
      maxAutoPerNight: 1, pauseOnFailure: true, discoverEveryHours: 6 },
    applying: (() => { const j = current(); return !!j && !TERMINAL_STATES.includes(j.state); })(),
    job: current(),
    history: history(),
    auto: { enabled: true, actor: 'auto', paused: rows.filter((r) => r.paused).map((r) => r.id), last: LAST_NIGHT },
    updater: updaterInfo(),
    components: rows,
  };
}

const INSTALLED = '4f1c2a9e7d3b5c8a0e6f1d2b3c4a5e6f7a8b9c0d';
const TARGET = '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d';

function updaterInfo(): UpdaterInfo | null {
  const u = read(UPDATER_KEY);
  if (u === 'none') return null;
  return { current: INSTALLED, installedAt: ago(86400 * 12),
    staged: u === 'staged' ? TARGET : null, stagedAt: u === 'staged' ? ago(600) : null };
}

// ── step 4: plans ────────────────────────────────────────────────────────────

const HEAD = '5c1e0a9d2b7f4e3a8c6d1f0b9e2a7c4d3f5b6e8a';

const PLANS: Record<string, Plan> = {
  loki: {
    id: 'a3f19c20e7b84d15c6a2f0b9', component: 'loki', title: 'Loki', class: 'timeseries', createdAt: ago(3600 * 2 + 700),
    level: 'patch', confirm: 'click',
    from: { image: 'grafana/loki:3.7.6', tag: '3.7.6', version: '3.7.6', digest: dg('d'), container: 'loki' },
    to: { image: 'grafana/loki:3.7.7', tag: '3.7.7', version: '3.7.7', digest: dg('a') },
    pin: { file: 'monitoring/compose.yml', service: 'loki', line: 228, commit: HEAD },
    changelog: 'https://github.com/grafana/loki/releases/tag/v3.7.7', oneWay: false, oneWayWhy: null,
    restarts: ['loki', 'alloy (its pushes retry while Loki is away)', 'grafana (log panels)'],
    recipe: 'just up-monitoring',
    downtime: 'About 30 s: Loki stops for the snapshot (a few seconds), is recreated, then needs ~15 s of ring delay before /ready.',
    signedOut: 'nobody',
    snapshot: {
      kind: 'loki',
      what: 'Loki flushed and stopped, /loki tarred, then started again - plus the old pin line, the compose file and the image digest.',
      dir: '~/backups/pre-update/<ts>-loki/', estimateBytes: 27_400_000,
    },
    preflight: ['free disk at least twice the image plus the snapshot', 'loki is running and its canaries pass now',
      '`just up-monitoring` would recreate nothing but loki (every other service runs its own pin)', 'the newest backup is under 24 h old',
      'no other update holds the lock'],
    verify: ['loki runs the planned digest', '/ready says ready', 'query_range returns fresh lines',
      'the lines logged before the update are still readable (the history probe)'],
    rollback: 'On any failure the old pin line is put back and `just up-monitoring` runs again. The snapshot is restored only if the history probe still fails under the OLD image - restoring discards everything written since.',
  },
  alloy: {
    id: '7be2d04f91ac3e58b0d6a1c4', component: 'alloy', title: 'Alloy', class: 'stateless', createdAt: ago(3600 * 2 + 700),
    level: 'patch', confirm: 'click',
    from: { image: 'grafana/alloy:v1.19.2', tag: 'v1.19.2', version: '1.19.2', digest: dg('d'), container: 'alloy' },
    to: { image: 'grafana/alloy:v1.19.3', tag: 'v1.19.3', version: '1.19.3', digest: dg('b') },
    pin: { file: 'monitoring/compose.yml', service: 'alloy', line: 257, commit: HEAD },
    changelog: 'https://github.com/grafana/alloy/releases/tag/v1.19.3', oneWay: false, oneWayWhy: null,
    restarts: ['alloy'], recipe: 'just up-monitoring',
    downtime: 'About 10 s: Alloy is recreated; it resumes from its positions file, so no log line is lost.',
    signedOut: 'nobody',
    snapshot: {
      kind: 'image',
      what: 'The old pin line, the compose file and the running image digest - Alloy keeps no data worth a copy.',
      dir: '~/backups/pre-update/<ts>-alloy/', estimateBytes: null,
    },
    preflight: ['free disk at least twice the image', 'alloy is healthy and /-/ready says ready now',
      '`just up-monitoring` would recreate nothing but alloy', 'the newest backup is under 24 h old', 'no other update holds the lock'],
    verify: ['alloy runs the planned digest', 'container healthy', '/-/ready says ready'],
    rollback: 'On any failure the old pin line is put back and `just up-monitoring` runs again.',
  },
  // Step 5: the one-way class. Type-the-name, a data snapshot, a rollback that ALWAYS restores.
  grafana: {
    id: '5d0e6f1a2b3c4d5e6f708192', component: 'grafana', title: 'Grafana', class: 'app-db', createdAt: ago(3600 * 2 + 700),
    level: 'minor', confirm: 'type-name',
    from: { image: 'grafana/grafana:13.1.4', tag: '13.1.4', version: '13.1.4', digest: dg('c'), container: 'grafana' },
    to: { image: 'grafana/grafana:13.2.2', tag: '13.2.2', version: '13.2.2', digest: dg('e') },
    pin: { file: 'monitoring/compose.yml', service: 'grafana', line: 167, commit: HEAD },
    pins: [{ file: 'monitoring/compose.yml', service: 'grafana', line: 167 }],
    changelog: 'https://github.com/grafana/grafana/releases/tag/v13.2.2', oneWay: true,
    oneWayWhy: "grafana.db's schema migrates on first start and cannot be downgraded. Stop Grafana and copy the volume first.",
    restarts: ['grafana'], recipe: 'just up-monitoring',
    downtime: '~30-90 s in two pieces: Grafana is STOPPED while its volume is tarred (seconds; longer with many plugins), started again, then recreated on the new image, whose first start migrates grafana.db before it answers. Dashboards on :3000 and alert evaluation pause meanwhile',
    signedOut: "nobody - Grafana's sessions live in grafana.db, which the update keeps. A rollback restores the snapshot, which ends any session started after it",
    snapshot: {
      kind: 'grafana',
      what: 'Grafana STOPPED and its whole volume (grafana.db and plugins) tarred, grafana.db integrity-checked, then started again; plus every pin line, the compose file, this plan and the old image\'s id and digest',
      dir: '~/backups/pre-update/<time>-grafana/', estimateBytes: 9_800_000,
    },
    preflight: ['the plan is still current', 'free disk: at least twice (the image + the snapshot)',
      'grafana is running and healthy, and its canaries pass NOW', '`just up-monitoring` would recreate grafana and nothing else in its compose project',
      'the newest backup in ~/backups/{postgres,grafana} is under 24 h old', 'no other update is running (one global lock)'],
    verify: ['grafana runs the pulled image and is healthy', 'Grafana: /api/health says database ok and names the expected version',
      'Grafana: at least as many dashboards (API search) as before the update', 'Grafana: datasource uid=prometheus answers its /health with OK'],
    rollback: 'ONE-WAY: on any failure after the pull, the pre-update snapshot is restored FIRST - always, because the new version may already have migrated the data and the old one cannot read it - with the new container stopped. Then the previous image goes back on every pin line (left uncommitted) and the recipe runs again, and the old image must pass the same canaries. Anything written between the snapshot and the rollback is lost.',
  },
  keycloak: {
    id: '9a8b7c6d5e4f30211203f4e5', component: 'keycloak', title: 'Keycloak', class: 'app-db', createdAt: ago(3600 * 2 + 700),
    level: 'patch', confirm: 'type-name',
    from: { image: 'quay.io/keycloak/keycloak:26.7.3-0', tag: '26.7.3-0', version: '26.7.3', digest: dg('b'), container: 'keycloak' },
    to: { image: 'quay.io/keycloak/keycloak:26.7.4-0', tag: '26.7.4-0', version: '26.7.4', digest: dg('f') },
    pin: { file: 'auth/compose.yml', service: 'keycloak', line: 89, commit: HEAD },
    pins: [{ file: 'auth/compose.yml', service: 'keycloak', line: 89 }, { file: 'auth/compose.yml', service: 'keycloak-init', line: 153 }],
    changelog: 'https://github.com/keycloak/keycloak/releases/tag/26.7.4', oneWay: true,
    oneWayWhy: 'Keycloak migrates its database on first start; the only way back is the pre-update pg_dump of the keycloak database.',
    restarts: ['keycloak', 'keycloak-init', 'oauth2-proxy', 'every gated route (fails closed while it is down)'], recipe: 'just up-auth',
    downtime: '~1-2 min: logins are unavailable while Keycloak is recreated, migrates its database and passes its health check, and keycloak-init re-runs. Every gated route (sso-viewer, sso-editor, sso-operator, Headlamp) FAILS CLOSED meanwhile - refused, never open',
    signedOut: "nobody: Keycloak 26 persists user sessions in its database by default (persistent user sessions, on since 26.0.0 - keycloak.org release notes), so they survive the restart, and oauth2-proxy's cookies are untouched. A rollback restores the pre-update dump, which ends any session started after it",
    snapshot: {
      kind: 'keycloak',
      what: "`pg_dump -Fc` of Keycloak's database (no downtime), proven readable with `pg_restore -l` before anything changes; plus every pin line, the compose file, this plan and the old image's id and digest",
      dir: '~/backups/pre-update/<time>-keycloak/', estimateBytes: 1_400_000,
    },
    preflight: ['the plan is still current', 'free disk: at least twice (the image + the snapshot)',
      'keycloak is running and healthy, and its canaries pass NOW', '`just up-auth` would recreate keycloak and keycloak-init and nothing else in its compose project',
      'the newest backup in ~/backups/{postgres} is under 24 h old', 'no other update is running (one global lock)'],
    verify: ['keycloak runs the pulled image and is healthy', "Keycloak: the discovery document's issuer is unchanged (realm devbox)",
      'Keycloak: realm devbox exists and publishes its key', 'Keycloak: keycloak-init ran after it and exited 0',
      'Keycloak: the admin token endpoint issues bothy-admin a token (client credentials)',
      'oauth2-proxy: a signed-in user gets 202 for allowed_groups=viewer and 403 for allowed_groups=shell'],
    rollback: 'ONE-WAY: on any failure after the pull, the pre-update snapshot is restored FIRST - always, because the new version may already have migrated the data and the old one cannot read it - with the new container stopped. Then the previous image goes back on every pin line (left uncommitted) and the recipe runs again, and the old image must pass the same canaries. Anything written between the snapshot and the rollback is lost.',
  },
  bothy: {
    id: 'e41b77a0c2d95f36180ab4c7', component: 'bothy', title: 'Bothy (web, files, ops)', class: 'own-code',
    createdAt: ago(3600 * 2 + 700), level: 'minor', confirm: 'type-name',
    from: { image: `bothy@${INSTALLED.slice(0, 12)}`, tag: 'v2026.8.1', version: '2026.8.1', digest: null, container: 'bothy-web' },
    to: { image: `bothy@${TARGET.slice(0, 12)}`, tag: 'v2026.9.0', version: '2026.9.0', digest: null },
    pin: { file: 'VERSION', service: null, line: 1, commit: INSTALLED },
    changelog: 'https://github.com/YehudaBriskman/Bothy/releases/tag/v2026.9.0', oneWay: false, oneWayWhy: null,
    restarts: ['bothy-files', 'bothy-ops', 'bothy-web'], recipe: 'just up-apps',
    downtime: '~10-40 s per container, one at a time: bothy-files, then bothy-ops, then bothy-web. The file editor, then container actions and Settings, then the page itself are away while each is recreated; this page reconnects on its own',
    signedOut: 'nobody - sessions live in oauth2-proxy, which is not touched',
    snapshot: {
      kind: 'git',
      what: `the current commit (${INSTALLED.slice(0, 12)}) and the three running images, kept as <image>:${INSTALLED.slice(0, 12)}… - the rollback runs them again without a build`,
      dir: '~/backups/pre-update/<time>-bothy/', estimateBytes: null,
    },
    preflight: [
      'the plan is still current: recomputed after a `git fetch`, it has this id',
      'the checkout is on main, clean (nothing modified or untracked) and not ahead of origin/main',
      'v2026.9.0 is on origin/main, strictly ahead of HEAD, its VERSION says 2026.9.0, and every check run on its commit passed (asked via gh (authenticated))',
      "bothy-files, bothy-ops, bothy-web run HEAD's images and are healthy",
      'a systemd user manager is running (the rollback timer lives there), and no earlier rollback is armed',
      'no other update is running (one global lock)',
    ],
    verify: [
      `each container runs the image built from ${TARGET.slice(0, 12)}, and its revision label says so`,
      `bothy-web's /version.json names ${TARGET.slice(0, 12)}`,
      "bothy-files' and bothy-ops' /healthz answer `\"ok\": true`",
      'the catch-all serves index.html for an unrouted path - in bothy-web, and through the edge',
    ],
    rollback: `A rollback unit is armed before the checkout moves and fires 10 min after the containers are up unless verify passes; a failed verify fires it at once. It runs \`git reset --hard ${INSTALLED.slice(0, 12)}\` (safe: pre-flight proved the tree clean and the move is a fast-forward) and \`just up-apps\` on the previous images, without a build. The release is then not offered again.`,
    own: {
      fromSha: INSTALLED, toSha: TARGET, tag: 'v2026.9.0',
      releaseUrl: 'https://github.com/YehudaBriskman/Bothy/releases/tag/v2026.9.0',
      commits: 98, diffstat: '214 files changed, 9120 insertions(+), 2311 deletions(-)',
      apps: ['bothy-files', 'bothy-ops', 'bothy-web'], compose: ['apps/bothy-ops/compose.yml'],
      edge: ['edge/dynamic/bothy-updates.yml'],
      elsewhere: ['monitoring/compose.yml', 'auth/compose.yml', 'scripts/backup.sh', 'justfile'], elsewhereCount: 4,
      updater: true, updaterFiles: ['apps/bothy-ops/updater', 'apps/bothy-ops/updates.py'],
      ci: { via: 'gh (authenticated)', detail: 'all 23 check runs passed', runs: 23 },
      rollbackAfter: 600, order: ['bothy-files', 'bothy-ops', 'bothy-web'],
    },
  },
  // Step 8: a cluster add-on (helm) and the Postgres major (manual: typed AND noted).
  'kube-state-metrics': {
    id: '5f0a06d6ef2d7edbcb4e150a', component: 'kube-state-metrics', title: 'kube-state-metrics (chart)', class: 'cluster',
    kind: 'cluster', createdAt: ago(3600 * 2 + 700), level: 'minor', confirm: 'click',
    from: { image: 'kube-state-metrics-8.4.2', tag: '8.4.2', version: '8.4.2', digest: null, container: 'kube-state-metrics' },
    to: { image: 'kube-state-metrics-8.5.0', tag: '8.5.0', version: '8.5.0', digest: null },
    pin: { file: 'k8s/monitoring/Chart.yaml', service: 'kube-state-metrics', line: 20, commit: HEAD },
    changelog: 'https://github.com/prometheus-community/helm-charts/releases/tag/kube-state-metrics-8.5.0',
    oneWay: false, oneWayWhy: null, restarts: ['monitoring/kube-state-metrics in thales-scc', 'the cluster panels in Grafana'],
    recipe: 'just k8s-monitoring ksm',
    downtime: "~10-60 s: kube-state-metrics' pod is replaced (helm --wait); the cluster panels in Grafana miss a scrape or two. Nothing else in the cluster is touched",
    signedOut: 'nobody - nothing that signs anyone in is touched',
    snapshot: { kind: 'helm', what: '`helm get values` of kube-state-metrics and its revision 4 (plus `helm get manifest`), and the pin line',
      dir: '~/backups/pre-update/<time>-kube-state-metrics/', estimateBytes: 0 },
    preflight: ['the plan is still current: recomputed from main, the cluster and discovery, it has this id',
      "the cluster is reached as minikube-user with --context thales-scc - the operator's kubeconfig, never a ServiceAccount token (bothy-ops' included)",
      'kube-state-metrics is what the plan saw (revision 4), and its checks pass NOW',
      '`just k8s-monitoring ksm` touches this add-on only', 'no other update is running (one global lock)'],
    verify: ['helm says kube-state-metrics is deployed at chart 8.5.0, a newer revision than 4',
      "kube-state-metrics' /metrics, through its NodePort, carries kube_node_info",
      'VictoriaMetrics: up{job="kube-state-metrics",cluster="thales-scc"} is 1, from a scrape after the upgrade'],
    rollback: '`helm rollback kube-state-metrics 4` (--wait), then the same checks on the old chart; k8s/monitoring/Chart.yaml:20 goes back to 8.4.2 (uncommitted, on purpose)',
    cluster: { kind: 'helm', context: 'thales-scc', identity: 'minikube-user', namespace: 'monitoring', release: 'kube-state-metrics',
      name: null, revision: 4, part: 'ksm', configMaps: [] },
  },
  postgres: {
    id: 'c0ffee00c0ffee00c0ffee00', component: 'postgres', title: 'Postgres', class: 'database', kind: 'postgres-major',
    requiresNote: true, createdAt: ago(3600 * 2 + 700), level: 'major', confirm: 'type-name',
    from: { image: `postgres:17.10@${dg('7')}`, tag: '17.10', version: '17.10', digest: dg('7'), container: 'postgres' },
    to: { image: `postgres:18.6@${dg('8')}`, tag: '18.6', version: '18.6', digest: dg('8') },
    pin: { file: 'data/postgres/compose.yml', service: 'postgres', line: 8, commit: HEAD },
    pins: [{ file: 'data/postgres/compose.yml', service: 'postgres', line: 8 }, { file: 'auth/compose.yml', service: 'keycloak-db-init', line: 69 }],
    changelog: 'https://www.postgresql.org/docs/release/', oneWay: true,
    oneWayWhy: "A major version cannot open the previous major's data directory; it is a dump, a new volume and a restore (docs/plans/updates.md §5).",
    restarts: ['postgres', 'keycloak', 'oauth2-proxy', 'postgres-exporter', 'keycloak-db-init'], recipe: 'just up-data',
    downtime: 'the whole move, start to finish: keycloak, oauth2-proxy, postgres-exporter stop FIRST and the database is unavailable until the switch. Every gated route FAILS CLOSED meanwhile. Roughly 2-4 min plus the dump and restore of 48 MiB data',
    signedOut: 'nobody by the move itself - but nobody can sign in during it',
    snapshot: { kind: 'pg-dumpall', what: "a pg_dumpall of every database with Postgres 18's client, taken after the writers stop, plus every table's row count read from it; and the OLD volume itself, never touched and never deleted",
      dir: '~/backups/pre-update/<time>-postgres/', estimateBytes: 50_331_648 },
    preflight: ['the plan is still current', "the request carries the component's id typed AND a maintenance note, and was made by a person",
      'the nightly pg_dumpall in ~/backups/postgres is under 24 h old', 'free disk: at least 3x the data (48 MiB) for Docker, and twice it for the dump',
      "keycloak is healthy and Keycloak's canaries pass NOW"],
    procedure: ['pre-flight (above)', 'pull postgres:18.6@…', 'stop the writers: keycloak, oauth2-proxy, postgres-exporter',
      "pg_dumpall into pre-update/ with Postgres 18's client; count every table's rows; stop the old Postgres",
      'create postgres_postgres18_data and a temporary Postgres 18 on it (no network)', 'restore the dump into it',
      "compare: every database, every table's row count, Keycloak's users - equal to the dump's",
      'switch: `just up-data` recreates postgres from main - Postgres 18 on postgres_postgres18_data',
      'start: `just up-auth`', "verify with Keycloak's canaries"],
    verify: ["every database of the dump exists in the new cluster, and every table's row count equals the dump's",
      "Keycloak's user count (keycloak.public.user_entity) equals the dump's", 'both pins run 18.6 (the keycloak-db-init major rule)'],
    rollback: 'The OLD volume is never touched and never deleted. Before the switch, a failure starts the old container again; after it, the old image and volume go back on their lines (uncommitted) and `just up-data` puts Postgres back on them.',
    pgMajor: { fromMajor: 17, toMajor: 18, oldVolume: 'postgres_postgres_data', newVolume: 'postgres_postgres18_data',
      oldMount: '/var/lib/postgresql/data', newMount: '/var/lib/postgresql', dataBytes: 50_331_648, databases: ['dev', 'keycloak', 'postgres'],
      keycloakDb: 'keycloak', stops: ['keycloak', 'oauth2-proxy', 'postgres-exporter'], deleteOld: 'docker volume rm postgres_postgres_data' },
  },
};

const REASONS: Record<string, string> = {
  cadvisor: 'nothing to deploy: cadvisor runs what main pins',
  'node-exporter': 'nothing to deploy: node-exporter runs what main pins',
  'postgres-exporter': 'nothing to deploy: postgres-exporter runs what main pins',
  headlamp: 'nothing to deploy: headlamp is not running (start it with `just up-headlamp`)',
  victoriametrics: 'nothing to deploy: victoriametrics runs what main pins. v1.153.0 is newer upstream - merge its Dependabot PR, pull the checkout, then `just updates-discover`',
  traefik: 'class edge is not handled by the updater yet; floating pin v3.7',
  'alloy-cluster': 'nothing to deploy: monitoring/daemonset/alloy runs what main pins (grafana/alloy:v1.19.2)',
  'oauth2-proxy': 'class boundary is manual: `just up-auth` by hand, then the boundary probes',
  'oauth2-proxy-headlamp': 'class boundary is manual: `just up-headlamp` by hand',
  'socket-proxy': 'class boundary is manual: `just up-apps` by hand, then `just ops-check`',
};

const NO_PLAN = 'no plan yet - run `just updates-discover`';

function summaryOf(id: string): PlanSummary {
  const p = PLANS[id];
  if (p && !busyWith(id)) {
    return {
      id: p.id, deployable: true, from: p.from.version ?? p.from.tag ?? '?', to: p.to.version ?? p.to.tag ?? '?',
      level: p.level, createdAt: p.createdAt,
    };
  }
  return {
    id: null, deployable: false,
    reason: p ? `a job for ${id} is already queued or running` : (REASONS[id] ?? NO_PLAN),
    createdAt: ago(3600 * 2 + 700),
  };
}

export async function planMock(component: string): Promise<PlanAnswer> {
  await new Promise((r) => setTimeout(r, 200));
  if (!SPECS.some((s) => s.id === component)) refuse(404, `unknown component ${component}`, true);
  const p = PLANS[component];
  return p
    ? { ok: true, component, plan: p, reason: null, ageSeconds: 3600 * 2 + 700 }
    : { ok: true, component, plan: null, reason: REASONS[component] ?? NO_PLAN, ageSeconds: 3600 * 2 + 700 };
}

// ── step 4: requests and jobs, advanced by wall clock ────────────────────────

interface DevJob { id: string; component: string; planId: string; requestedAt: number; outcome: JobState }

const TERMINAL_STATES: JobState[] = ['succeeded', 'rolled_back', 'aborted', 'failed', 'refused'];

function jobs(): DevJob[] {
  try {
    const j: unknown = JSON.parse(read(JOBS_KEY) ?? '[]');
    return Array.isArray(j) ? (j as DevJob[]) : [];
  } catch { return []; }
}
function saveJobs(js: DevJob[]) {
  try { localStorage.setItem(JOBS_KEY, JSON.stringify(js.slice(-10))); } catch { /* dev only */ }
}

// Seconds after the request at which each step starts; the job ends at END.
const STEPS_OK: [StepName, number][] = [
  ['validate', 2], ['preflight', 3], ['snapshot', 6], ['pull', 9], ['apply', 12], ['verify', 16], ['record', 21],
];
const STEPS_ROLLBACK: [StepName, number][] = [
  ['validate', 2], ['preflight', 3], ['snapshot', 6], ['pull', 9], ['apply', 12], ['verify', 15], ['rollback', 18], ['record', 21],
];
const END = 22;
// Bothy itself: built before anything changes, a rollback armed, the checkout moved.
const STEPS_OWN: [StepName, number][] = [
  ['validate', 2], ['preflight', 3], ['build', 5], ['snapshot', 9], ['arm', 10], ['switch', 11], ['apply', 12],
  ['verify', 17], ['stage', 20], ['record', 21],
];
const STEPS_OWN_ROLLBACK: [StepName, number][] = [
  ['validate', 2], ['preflight', 3], ['build', 5], ['snapshot', 9], ['arm', 10], ['switch', 11], ['apply', 12],
  ['verify', 15], ['rollback', 18], ['record', 21],
];

const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function busyWith(component: string): boolean {
  const now = Date.now();
  return jobs().some((j) => j.component === component && now - j.requestedAt < END * 1000);
}

export async function requestMock(body: { component: string; plan_id: string; confirm: true | string; note?: string }): Promise<RequestAnswer> {
  await new Promise((r) => setTimeout(r, 300));
  const forced = read(REQUEST_KEY);
  if (forced === 'no-operator') refuse(403, 'Forbidden', false);
  const p = PLANS[body.component];
  if (!p) refuse(404, `no plan for ${body.component}`, true);
  if (forced === 'stale' || body.plan_id !== p.id) {
    refuse(409, 'the plan is no longer current - the checkout, the running image or discovery changed since it was written. Reload to see the new plan.', true);
  }
  if (forced === 'busy' || busyWith(body.component)) refuse(409, `a job for ${body.component} is already queued or running`, true);
  if (p.confirm === 'type-name' ? body.confirm !== p.component : body.confirm !== true) refuse(400, 'confirm does not match the plan', true);
  if (p.requiresNote && !(body.note && body.note.trim().length >= 10)) refuse(400, 'this plan needs a maintenance note', true);
  const want = read(JOB_OUTCOME_KEY) as JobState | null;
  const j: DevJob = {
    id: hex(32), component: p.component, planId: p.id, requestedAt: Date.now(),
    outcome: want && TERMINAL_STATES.includes(want) ? want : 'succeeded',
  };
  saveJobs([...jobs(), j]);
  return { ok: true, jobId: j.id, component: j.component, planId: j.planId };
}

// Where a forced ending breaks the run: the step that fails.
const FAIL_AT: Partial<Record<JobState, StepName>> = {
  refused: 'preflight', aborted: 'pull', rolled_back: 'verify', failed: 'verify',
};
// Bothy itself has no pull: an abort is a failed build.
const failStep = (j: DevJob): StepName | null => {
  const f = FAIL_AT[j.outcome] ?? null;
  return f === 'pull' && PLANS[j.component]?.class === 'own-code' ? 'build' : f;
};

function render(j: DevJob, now = Date.now()): Job {
  const p = PLANS[j.component];
  const t = (now - j.requestedAt) / 1000;
  const at = (s: number) => iso(j.requestedAt + s * 1000);
  const failAt = failStep(j);
  const own = p.class === 'own-code';
  const table = failAt === 'verify' ? (own ? STEPS_OWN_ROLLBACK : STEPS_ROLLBACK) : (own ? STEPS_OWN : STEPS_OK);
  // An early failure (pre-flight, pull) ends the job one second after that step starts.
  const early = failAt && failAt !== 'verify' ? table.find(([n]) => n === failAt)![1] + 1 : null;
  const end = early ?? END;
  const done = t >= end;
  let broken = false;
  const steps: JobStep[] = table.map(([name, start], i) => {
    const stop = i + 1 < table.length ? table[i + 1][1] : END;
    const stepEnd = early && name === failAt ? early : stop;
    if (broken && name !== 'rollback' && name !== 'record') {
      return { name, state: 'skipped', startedAt: null, endedAt: null, detail: null };
    }
    if (early && start >= early && name !== 'record') return { name, state: done ? 'skipped' : 'pending', startedAt: null, endedAt: null, detail: null };
    if (early && name === 'record') {
      return done ? { name, state: 'ok', startedAt: at(early), endedAt: at(early), detail: DETAIL_OK(p, name) }
        : { name, state: 'pending', startedAt: null, endedAt: null, detail: null };
    }
    if (t < start) return { name, state: 'pending', startedAt: null, endedAt: null, detail: null };
    if (t < stepEnd) return { name, state: 'running', startedAt: at(start), endedAt: null, detail: DETAIL_RUNNING[name] ?? null };
    const bad = name === failAt || (name === 'rollback' && j.outcome === 'failed');
    if (name === failAt) broken = true;
    return {
      name, state: bad ? 'failed' : 'ok', startedAt: at(start), endedAt: at(stepEnd),
      detail: bad ? (FAIL_DETAIL[name === 'rollback' ? 'failed' : j.outcome] ?? 'failed') : DETAIL_OK(p, name),
    };
  });
  const state: JobState = t < 2 ? 'queued' : done ? j.outcome : 'running';
  return {
    id: j.id, component: j.component, planId: j.planId, state,
    requestedBy: 'operator@example.com', requestedAt: iso(j.requestedAt),
    startedAt: t >= 2 ? at(2) : null, endedAt: done ? at(end) : null,
    from: { image: p.from.image, version: p.from.version }, to: { image: p.to.image, version: p.to.version },
    error: done && j.outcome !== 'succeeded' ? FAIL_DETAIL[j.outcome] ?? null : null,
    snapshot: t >= 9 && failAt !== 'preflight'
      ? `~/backups/pre-update/${iso(j.requestedAt).replace(/[-:]/g, '').slice(0, 15)}Z-${j.component}/`
      : null,
    note: done ? NOTE[j.outcome]?.(p) ?? null : null,
    steps,
  };
}

const DETAIL_RUNNING: Partial<Record<StepName, string>> = {
  preflight: 'disk, health, recipe scope, backup age',
  snapshot: 'copying the pin line, the compose file and the data',
  pull: 'docker pull',
  apply: 'waiting for healthy (--wait)',
  verify: 'canaries - bodies, not status codes',
  rollback: 'putting the old pin line back',
  build: 'docker compose build, in a temporary worktree of the release',
  arm: 'systemd-run --user --on-active',
  switch: 'git merge --ff-only',
  stage: 'copying the new updater beside the running one',
};

function DETAIL_OK(p: Plan, n: StepName): string | null {
  const d: Partial<Record<StepName, string>> = {
    validate: `plan ${p.id} re-derived on the host and matches`,
    preflight: '812 GiB free · canaries green · newest backup 7 h old',
    snapshot: p.snapshot.kind === 'image' ? 'pin line, compose file, digest' : 'pin line, compose file, digest, 26 MiB data tar',
    pull: `${p.to.image} is ${p.to.digest?.slice(0, 19)}…`,
    apply: `${p.recipe}: ${p.from.container} recreated`,
    verify: `${p.verify.length} canaries passed`,
    rollback: `${p.pin.file} re-pinned to ${p.from.image}; ${p.from.container} healthy again`,
    record: 'history, audit line and bothy_update_last_result written',
  };
  if (p.own) {
    const o = p.own;
    const f = o.fromSha?.slice(0, 12);
    const t = o.toSha?.slice(0, 12);
    Object.assign(d, {
      validate: `plan ${p.id}: ${f} -> ${o.tag} (${t}), fetched and re-derived here`,
      preflight: 'bothy-files healthy; bothy-ops healthy; bothy-web healthy; systemd user manager up',
      build: `built bothy-files, bothy-ops, bothy-web :${t} from a temporary worktree of ${o.tag}`,
      snapshot: `previous sha ${f}, images tagged :${f}…`,
      arm: 'bothy-own-rollback-3fa1c09e2b7d-2.timer fires at 14:32:10 (600 s) unless verify disarms it (re-armed once the containers were up)',
      switch: `main fast-forwarded ${f} -> ${t} (${o.tag})`,
      apply: '`just up-apps` for bothy-files, bothy-ops, bothy-web, in that order, on the images built above',
      verify: `bothy-files, bothy-ops, bothy-web run ${t} and are healthy; /version.json names it; /healthz ok; catch-all serves index.html; the edge serves the same index.html`,
      stage: o.updater
        ? `${o.updaterFiles.slice(0, 2).join(', ')} changed: staged ${t} beside current ${f} - NOT switched; \`just install-updater\` switches`
        : 'the release does not change the updater',
      rollback: `the checkout reset to ${f}; the previous images run and are healthy`,
    });
  }
  return d[n] ?? null;
}

const FAIL_DETAIL: Partial<Record<JobState, string>> = {
  refused: 'the newest backup is 31 h old (limit 24 h) - run `just backup`, then ask again',
  aborted: 'the tag now names a different image than the plan - rediscover; nothing running was changed',
  rolled_back: 'a canary did not hold within 120 s: the body never said ready',
  failed: 'after the rollback the container is still not healthy on the old image',
};

const NOTE: Partial<Record<JobState, (p: Plan) => string>> = {
  succeeded: (p) => (p.own
    ? `Bothy runs ${p.own.tag} (${p.own.toSha?.slice(0, 12)}); the checkout fast-forwarded from ${p.own.fromSha?.slice(0, 12)}.`
      + (p.own.updater ? ` The release changes the updater: its copy is STAGED (${p.own.toSha?.slice(0, 12)}), not running - run \`just install-updater\` on the host to switch to it.` : '')
    : `${p.from.container} runs ${p.to.image}. The checkout is unchanged - main already pinned this.`),
  rolled_back: (p) => p.own
    ? `The checkout is back at ${p.own.fromSha?.slice(0, 12)} and the previous images run again. ${p.own.tag} is not offered again until a newer release, or until ~/.local/state/bothy/updates/own/blocked.json is deleted.`
    : `${p.pin.file} now pins ${p.from.image} LOCALLY (uncommitted), so the next \`${p.recipe}\` keeps the working version; main still pins ${p.to.image}. To try again: fix the cause, then \`git checkout -- ${p.pin.file}\` and \`just updates-discover\`.`,
  failed: (p) => `A person is needed: ${p.from.container} is not healthy on either image. The snapshot is kept.`,
  refused: () => 'Nothing was touched.',
  aborted: () => 'Nothing running was changed.',
};

function current(): Job | null {
  const js = jobs();
  return js.length ? render(js[js.length - 1]) : null;
}

export async function jobMock(id: string): Promise<Job> {
  await new Promise((r) => setTimeout(r, 150));
  if (read(OUTCOME_KEY) === 'silence') refuse(0, 'no answer', false);
  const j = jobs().find((x) => x.id === id);
  if (!j) refuse(404, 'no such job', true);
  return render(j);
}

const SEED: HistoryEntry[] = [
  {
    id: 'f'.repeat(32), component: 'node-exporter', planId: 'c0ffee00c0ffee00c0ffee00', state: 'succeeded',
    requestedBy: 'auto', requestedAt: ago(86400 * 3), startedAt: ago(86400 * 3 - 2), endedAt: ago(86400 * 3 - 41),
    durationMs: 39_000,
    from: { image: 'prom/node-exporter:v1.12.0', version: '1.12.0' }, to: { image: 'prom/node-exporter:v1.12.1', version: '1.12.1' },
    error: null, snapshot: '~/backups/pre-update/20260916T101204Z-node-exporter/', note: null,
  },
  {
    id: 'e'.repeat(32), component: 'victoriametrics', planId: 'beefbeefbeefbeefbeefbeef', state: 'rolled_back',
    requestedBy: 'auto', requestedAt: ago(86400 * 5), startedAt: ago(86400 * 5 - 2), endedAt: ago(86400 * 5 - 184),
    durationMs: 182_000,
    from: { image: 'victoriametrics/victoria-metrics:v1.151.0', version: '1.151.0' },
    to: { image: 'victoriametrics/victoria-metrics:v1.152.0', version: '1.152.0' },
    error: '`up` returned no series within 120 s', snapshot: '~/backups/pre-update/20260914T091530Z-victoriametrics/',
    note: 'The history probe passed under the old image, so the snapshot was NOT restored.',
  },
  {
    id: 'd'.repeat(32), component: 'cadvisor', planId: 'abad1deaabad1deaabad1dea', state: 'refused',
    requestedBy: 'devssh@example.com', requestedAt: ago(86400 * 6), startedAt: ago(86400 * 6 - 1), endedAt: ago(86400 * 6 - 3),
    durationMs: 2_000,
    from: { image: 'gcr.io/cadvisor/cadvisor:v0.55.0', version: '0.55.0' }, to: { image: 'gcr.io/cadvisor/cadvisor:v0.55.1', version: '0.55.1' },
    error: '`just up-monitoring` would also recreate grafana (its pin changed) - update grafana first', snapshot: null,
    note: 'Nothing was touched.',
  },
];

function history(): HistoryEntry[] {
  const now = Date.now();
  const mine: HistoryEntry[] = jobs().map((j) => render(j, now)).filter((j) => TERMINAL_STATES.includes(j.state)).reverse()
    .map(({ steps: _steps, ...rest }) => ({
      ...rest,
      durationMs: rest.startedAt && rest.endedAt ? Date.parse(rest.endedAt) - Date.parse(rest.startedAt) : null,
    }));
  return [...mine, ...SEED].slice(0, 20);
}
