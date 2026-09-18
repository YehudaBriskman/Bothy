// The stand-in for GET /-/api/updates/status, used by `vite dev` and nothing else.
//
// lib/updates.ts routes here behind `import.meta.env.DEV`, a literal `false` after
// a build. The shape is the service's allow-list, and the data is shaped like this
// box on 2026-09-18: Grafana merged but not running (drift), Traefik's floating
// tag moved under it, a Postgres major on offer, our own first release tag, and
// one registry that rate-limited the run.
//
// Not a happy path. Force a state from the console:
//
//   localStorage['bothy-dev-updates-outcome'] = 'signed-out' | 'no-viewer' | 'fault'
//                                             | 'silence' | 'undiscovered' | 'stale'
//                                             | 'current'
//
// `undiscovered` is a fresh deploy before the timer's first run; `current` is a box
// with nothing to do.

import type { Channel, Discovered, Level, UpdateRow, UpdatesStatus, VersionRef } from './updates';

const OUTCOME_KEY = 'bothy-dev-updates-outcome';

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
  runningVersion?: string; drift?: string; floatMoved?: boolean; error?: string;
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
    tag: null, version: '0.18.1', running: 'quay.io/prometheuscommunity/postgres-exporter@sha256:…' },
  { id: 'alloy', title: 'Alloy', cls: 'stateless', pins: ['monitoring/compose.yml:alloy'], apply: 'just up-monitoring', channel: 'auto',
    changelog: 'https://github.com/grafana/alloy/releases/tag/v{v}', tag: 'v1.19.2', running: 'grafana/alloy:v1.19.2', cands: { patch: 'v1.19.3' } },
  { id: 'headlamp', title: 'Headlamp', cls: 'stateless', pins: ['apps/headlamp/compose.yml:headlamp'], apply: 'just up-headlamp', channel: 'auto',
    changelog: 'https://github.com/headlamp-k8s/headlamp/releases/tag/v{v}', dependants: ['oauth2-proxy-headlamp'], tag: 'v0.45.0',
    running: null, cands: { minor: 'v0.46.0' } },
  { id: 'victoriametrics', title: 'VictoriaMetrics', cls: 'timeseries', pins: ['monitoring/compose.yml:victoriametrics'], apply: 'just up-monitoring',
    channel: 'auto', changelog: 'https://docs.victoriametrics.com/victoriametrics/changelog/', dependants: ['grafana', "the portal's vitals"],
    tag: 'v1.152.0', running: 'victoriametrics/victoria-metrics:v1.152.0', cands: { minor: 'v1.153.0' } },
  { id: 'loki', title: 'Loki', cls: 'timeseries', pins: ['monitoring/compose.yml:loki'], apply: 'just up-monitoring', channel: 'auto',
    changelog: 'https://github.com/grafana/loki/releases/tag/v{v}', dependants: ['alloy', 'grafana'], tag: '3.7.7', running: 'grafana/loki:3.7.7',
    cands: { patch: '3.7.8' } },
  { id: 'grafana', title: 'Grafana', cls: 'app-db', pins: ['monitoring/compose.yml:grafana'], apply: 'just up-monitoring', channel: 'notify',
    oneWayWhy: "grafana.db's schema migrates on first start and cannot be downgraded. Stop Grafana and copy the volume first.",
    changelog: 'https://github.com/grafana/grafana/releases/tag/v{v}', tag: '13.2.2', running: 'grafana/grafana:13.1.4',
    drift: 'grafana runs grafana/grafana:13.1.4, monitoring pins grafana/grafana:13.2.2', cands: { patch: '13.2.3', minor: '13.3.0' } },
  { id: 'traefik', title: 'Traefik', cls: 'edge', pins: ['edge/compose.yml:traefik'], apply: 'just up-edge', channel: 'notify',
    changelog: 'https://github.com/traefik/traefik/releases/tag/v{v}', dependants: ['every route on :80', 'this page'], tag: 'v3.7', float: true,
    running: 'traefik:v3.7', runningVersion: '3.7.1', floatMoved: true, cands: { patch: 'v3.7', minor: 'v3.8' } },
  { id: 'bothy', title: 'Bothy (web, files, ops)', cls: 'own-code', source: 'github', pins: ['VERSION'], apply: 'just up-apps', channel: 'notify',
    changelog: 'https://github.com/YehudaBriskman/Bothy/releases/tag/v{v}', dependants: ['bothy-web', 'bothy-files', 'bothy-ops'],
    tag: 'v2026.8.1', cands: { minor: 'v2026.9.0' } },
  { id: 'kube-state-metrics', title: 'kube-state-metrics (chart)', cls: 'cluster', source: 'helm', pins: ['scripts/k8s-monitoring.sh:KSM_CHART_VERSION'],
    apply: 'just k8s-monitoring', channel: 'notify', changelog: 'https://github.com/prometheus-community/helm-charts/releases/tag/kube-state-metrics-{v}',
    tag: '8.5.0', running: null, cands: { patch: '8.5.2', minor: '8.6.0' } },
  { id: 'alloy-cluster', title: 'Alloy (cluster DaemonSet)', cls: 'cluster', source: 'manifest', pins: ['k8s/monitoring/alloy.yaml:alloy'],
    apply: 'just k8s-monitoring', channel: 'notify', changelog: 'https://github.com/grafana/alloy/releases/tag/v{v}', tag: 'v1.19.2', running: null,
    cands: { patch: 'v1.19.3' } },
  { id: 'keycloak', title: 'Keycloak', cls: 'app-db', pins: ['auth/compose.yml:keycloak', 'auth/compose.yml:keycloak-init'], apply: 'just up-auth',
    channel: 'manual', oneWayWhy: 'Keycloak migrates its database on first start; the only way back is the pre-update pg_dump of the keycloak database.',
    changelog: 'https://github.com/keycloak/keycloak/releases/tag/{v}', dependants: ['oauth2-proxy', 'every gated route (fails closed while it is down)'],
    tag: '26.7.4-0', version: '26.7.4', running: 'quay.io/keycloak/keycloak:26.7.4-0', cands: { patch: '26.7.5-0' } },
  { id: 'oauth2-proxy', title: 'oauth2-proxy', cls: 'boundary', pins: ['auth/compose.yml:oauth2-proxy'], apply: 'just up-auth', channel: 'manual',
    changelog: 'https://github.com/oauth2-proxy/oauth2-proxy/releases/tag/v{v}', dependants: ['every gated route'], tag: 'v7.15.4',
    running: 'quay.io/oauth2-proxy/oauth2-proxy:v7.15.4' },
  { id: 'oauth2-proxy-headlamp', title: 'oauth2-proxy (Headlamp)', cls: 'boundary', pins: ['apps/headlamp/compose.yml:oauth2-proxy-headlamp'],
    apply: 'just up-headlamp', channel: 'manual', changelog: 'https://github.com/oauth2-proxy/oauth2-proxy/releases/tag/v{v}', dependants: ['headlamp'],
    tag: 'v7.15.4', running: null },
  { id: 'socket-proxy', title: 'Docker socket proxies (read, write)', cls: 'boundary',
    pins: ['apps/bothy/socket-proxy.yml:socket-read', 'apps/bothy/socket-proxy.yml:socket-write'], apply: 'just up-apps', channel: 'manual',
    changelog: 'https://github.com/Tecnativa/docker-socket-proxy/releases/tag/v{v}', dependants: ['bothy-ops', "the portal's Docker reads"],
    tag: '0.3.0', running: 'tecnativa/docker-socket-proxy:0.3.0' },
  { id: 'postgres', title: 'Postgres', cls: 'database', pins: ['data/postgres/compose.yml:postgres', 'auth/compose.yml:keycloak-db-init'],
    apply: 'just up-data', channel: 'manual',
    oneWayWhy: "A major version cannot open the previous major's data directory; it is a dump, a new volume and a restore (docs/plans/updates.md §5).",
    changelog: 'https://www.postgresql.org/docs/release/', dependants: ['keycloak', 'postgres-exporter'], tag: '17', float: true,
    running: 'postgres:17', runningVersion: '17.6', floatMoved: true, cands: { minor: '17', major: '18' } },
];

const bare = (t: string) => t.replace(/^v/, '').replace(/-\d+$/, '');
const ORDER: Level[] = ['major', 'minor', 'patch'];

function row(s: Spec, checkedAt: string, discovered: boolean): UpdateRow {
  const cands: Partial<Record<Level, VersionRef>> = {};
  for (const [lv, t] of Object.entries(s.cands ?? {}) as [Level, string][]) {
    const moved = s.float && t === s.tag;
    cands[lv] = { tag: t, version: moved ? null : bare(t), digest: dg(lv[0] === 'p' ? 'a' : lv[0] === 'm' ? 'b' : 'c'), level: lv,
      publishedAt: ago(86400 * (lv === 'patch' ? 2 : lv === 'minor' ? 9 : 40)) };
  }
  const top = ORDER.find((l) => cands[l]);
  const latest = top ? cands[top]! : null;
  const d: Discovered | null = !discovered ? null : {
    checkedAt, error: s.error ?? null, image: null,
    current: { tag: s.tag, version: s.version ?? (s.tag && !s.float ? bare(s.tag) : null), digest: s.tag ? null : dg('e'), float: !!s.float },
    running: s.running ? [{ name: s.id, image: s.running, digest: s.runningDigest ?? dg('d'), state: 'running' }] : [],
    runningVersion: s.runningVersion ?? null, drift: s.drift ?? null, floatMoved: s.floatMoved ?? null,
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
    applying: false,
    components: rows,
  };
}
