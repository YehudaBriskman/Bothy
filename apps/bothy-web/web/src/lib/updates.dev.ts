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
// Step 4 - plans, a request, a job. Two rows are deployable (Loki 3.7.6 -> 3.7.7,
// time-series; Alloy, stateless); every other row carries the reason the host
// would give. A requested job advances by WALL CLOCK from its requestedAt (kept in
// localStorage), so a reload mid-run resumes where it was - the property the real
// panel needs. It ends `succeeded` unless forced:
//
//   localStorage['bothy-dev-updates-job'] = 'rolled_back' | 'aborted' | 'failed' | 'refused'
//   localStorage['bothy-dev-updates-request'] = 'stale' | 'busy' | 'no-operator'

import type {
  Channel, Discovered, HistoryEntry, Job, JobState, JobStep, Level, Plan, PlanAnswer, PlanSummary,
  RequestAnswer, StepName, UpdateRow, UpdatesStatus, VersionRef,
} from './updates';

const OUTCOME_KEY = 'bothy-dev-updates-outcome';
const JOB_OUTCOME_KEY = 'bothy-dev-updates-job';
const REQUEST_KEY = 'bothy-dev-updates-request';
const JOBS_KEY = 'bothy-dev-updates-jobs';

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
    tag: '26.7.4-0', version: '26.7.4', running: 'quay.io/keycloak/keycloak:26.7.1',
    drift: 'keycloak runs quay.io/keycloak/keycloak:26.7.1, auth/compose.yml pins quay.io/keycloak/keycloak:26.7.4-0' },
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
  };
}

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
    components: rows,
  };
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
};

const REASONS: Record<string, string> = {
  cadvisor: 'nothing to deploy: cadvisor runs what main pins',
  'node-exporter': 'nothing to deploy: node-exporter runs what main pins',
  'postgres-exporter': 'nothing to deploy: postgres-exporter runs what main pins',
  headlamp: 'nothing to deploy: headlamp is not running (start it with `just up-headlamp`)',
  victoriametrics: 'nothing to deploy: victoriametrics runs what main pins. v1.153.0 is newer upstream - merge its Dependabot PR, pull the checkout, then `just updates-discover`',
  grafana: 'class app-db is not handled by the updater yet (one-way, step 5) - `just backup`, then `just up-monitoring` by hand',
  traefik: 'class edge is not handled by the updater yet; floating pin v3.7',
  bothy: 'class own-code is not handled by the updater yet (step 6)',
  'kube-state-metrics': 'class cluster is not handled by the updater (manual, host kubeconfig)',
  'alloy-cluster': 'class cluster is not handled by the updater (manual, host kubeconfig)',
  keycloak: 'class app-db is not handled by the updater yet (one-way, step 5)',
  'oauth2-proxy': 'class boundary is manual: `just up-auth` by hand, then the boundary probes',
  'oauth2-proxy-headlamp': 'class boundary is manual: `just up-headlamp` by hand',
  'socket-proxy': 'class boundary is manual: `just up-apps` by hand, then `just ops-check`',
  postgres: 'a major (17 -> 18) is a manual procedure; floating pin 17',
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

const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function busyWith(component: string): boolean {
  const now = Date.now();
  return jobs().some((j) => j.component === component && now - j.requestedAt < END * 1000);
}

export async function requestMock(body: { component: string; plan_id: string; confirm: true | string }): Promise<RequestAnswer> {
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

function render(j: DevJob, now = Date.now()): Job {
  const p = PLANS[j.component];
  const t = (now - j.requestedAt) / 1000;
  const at = (s: number) => iso(j.requestedAt + s * 1000);
  const failAt = FAIL_AT[j.outcome] ?? null;
  const table = failAt === 'verify' ? STEPS_ROLLBACK : STEPS_OK;
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
  return d[n] ?? null;
}

const FAIL_DETAIL: Partial<Record<JobState, string>> = {
  refused: 'the newest backup is 31 h old (limit 24 h) - run `just backup`, then ask again',
  aborted: 'the tag now names a different image than the plan - rediscover; nothing running was changed',
  rolled_back: 'a canary did not hold within 120 s: the body never said ready',
  failed: 'after the rollback the container is still not healthy on the old image',
};

const NOTE: Partial<Record<JobState, (p: Plan) => string>> = {
  succeeded: (p) => `${p.from.container} runs ${p.to.image}. The checkout is unchanged - main already pinned this.`,
  rolled_back: (p) => `${p.pin.file} now pins ${p.from.image} LOCALLY (uncommitted), so the next \`${p.recipe}\` keeps the working version; main still pins ${p.to.image}. To try again: fix the cause, then \`git checkout -- ${p.pin.file}\` and \`just updates-discover\`.`,
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
    requestedBy: 'devssh@example.com', requestedAt: ago(86400 * 3), startedAt: ago(86400 * 3 - 2), endedAt: ago(86400 * 3 - 41),
    durationMs: 39_000,
    from: { image: 'prom/node-exporter:v1.12.0', version: '1.12.0' }, to: { image: 'prom/node-exporter:v1.12.1', version: '1.12.1' },
    error: null, snapshot: '~/backups/pre-update/20260916T101204Z-node-exporter/', note: null,
  },
  {
    id: 'e'.repeat(32), component: 'victoriametrics', planId: 'beefbeefbeefbeefbeefbeef', state: 'rolled_back',
    requestedBy: 'devssh@example.com', requestedAt: ago(86400 * 5), startedAt: ago(86400 * 5 - 2), endedAt: ago(86400 * 5 - 184),
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
