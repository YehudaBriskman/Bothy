// The stand-in for bothy-ops' admin reads, used by `vite dev` and by nothing else.
//
// lib/admin.ts routes here behind `import.meta.env.DEV`, a literal `false` after a
// build. The shapes are the service's allow-lists, and the data is invented but
// shaped like this box - five users would be a lie about a one-person box, so
// there are two, and one of them is the kind of account worth noticing.
//
// Not a happy path. Force a refusal from the console:
//
//   localStorage['bothy-dev-admin-outcome'] = 'signed-out' | 'no-operator'
//                                           | 'unavailable' | 'fault' | 'silence'
//                                           | 'stale'
//
// `unavailable` is the 503 the service sends when Keycloak's client secret or the
// host inventory is missing - the state a fresh deploy is in.

import type {
  AuditEntry, AuditQuery, AuditResult, BackupsResult, CredentialsResult, UsersResult,
} from './admin';

const OUTCOME_KEY = 'bothy-dev-admin-outcome';

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

const wait = (ms = 240) => new Promise((r) => setTimeout(r, ms));

async function gate(what: string): Promise<boolean> {
  await wait();
  const forced = read(OUTCOME_KEY);
  if (forced === 'signed-out') refuse(401, 'Unauthorized', false);
  if (forced === 'no-operator') refuse(403, 'Forbidden', false);
  if (forced === 'fault') refuse(500, 'internal error', true);
  if (forced === 'silence') refuse(0, 'no answer', false);
  if (forced === 'unavailable') {
    refuse(503, what === 'users'
      ? 'users unavailable - no Keycloak admin client secret on this box; run `just admin-client`'
      : 'inventory not generated yet - run `just admin-inventory` on the host (host/systemd/bothy-inventory.timer keeps it fresh)', true);
  }
  return forced === 'stale';
}

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

export async function usersMock(): Promise<UsersResult> {
  await gate('users');
  return {
    realm: 'devbox',
    client: 'bothy-admin',
    fetchedAt: ago(0),
    truncated: false,
    users: [
      {
        id: '5f0c1a52-8d7e-4c1b-9a53-2d7e0b6f4a11', username: 'devssh', email: 'dev@example.com',
        enabled: true, emailVerified: true, createdAt: ago(86400 * 36), requiredActions: [],
        roles: ['viewer', 'editor', 'operator'], otherRoles: ['default-roles-devbox'],
        credentials: ['password'], passwordSetAt: ago(86400 * 36), otp: false, sessions: 2,
        lastSeenAt: ago(420),
      },
      {
        id: '9b2e44f0-1c3d-4e5f-8a7b-6c5d4e3f2a10', username: 'service-account-bothy-admin', email: null,
        enabled: true, emailVerified: false, createdAt: ago(3600), requiredActions: [],
        roles: [], otherRoles: ['default-roles-devbox'], credentials: [], passwordSetAt: null,
        otp: false, sessions: 0, lastSeenAt: null,
      },
    ],
  };
}

export async function credentialsMock(): Promise<CredentialsResult> {
  const stale = await gate('credentials');
  const f = (
    id: string, path: string, purpose: string, usedBy: string[], rotate: string,
    expectMode: string, actualMode: string | null, changedAgo: number | null,
  ) => ({
    id, path, purpose, usedBy, rotate, expectMode, actualMode,
    present: actualMode !== null, changed: changedAgo === null ? null : ago(changedAgo),
  });
  return {
    generatedAt: ago(stale ? 5400 : 95), ageSeconds: stale ? 5400 : 95, stale,
    env: {
      path: '.env', present: true, mode: '600', expectMode: '600', changed: ago(86400 * 2),
      keys: [
        { key: 'POSTGRES_USER', set: true, credential: false, placeholder: false, usedBy: ['auth/compose.yml', 'data/postgres/compose.yml'] },
        { key: 'POSTGRES_PASSWORD', set: true, credential: true, placeholder: false, usedBy: ['auth/compose.yml', 'data/postgres/compose.yml', 'monitoring/compose.yml'], purpose: 'The shared Postgres superuser (postgres, postgres-exporter, keycloak-db-init).', rotate: 'No recipe. ALTER ROLE in postgres and edit .env together, then `just up` to recreate what reads it.' },
        { key: 'DEV_LOGIN_PASSWORD', set: true, credential: true, placeholder: false, usedBy: ['auth/compose.yml', 'monitoring/compose.yml', 'scripts/gen-bothy-prom-route.sh'], purpose: 'The unified dev login: Grafana, VictoriaMetrics basic auth, the Keycloak master admin, the seeded realm user.', rotate: 'No recipe - each service keeps its own copy. Change it in Keycloak and Grafana, edit .env, then `just bootstrap --force` and `just bothy-prom-route`.' },
        { key: 'OAUTH2_COOKIE_SECRET', set: true, credential: true, placeholder: false, usedBy: ['auth/compose.yml'], purpose: 'Signs every Bothy session cookie. Anyone holding it can mint a session for any role.', rotate: "Set a new value (`openssl rand -base64 32 | tr -- '+/' '-_'`) in .env, then `just up-auth`. Signs everybody out." },
        { key: 'KEYCLOAK_DB_PASSWORD', set: true, credential: true, placeholder: true, usedBy: ['auth/compose.yml'], purpose: "Keycloak's own database role.", rotate: 'Edit .env, then `just up-auth` - keycloak-db-init re-asserts it on every run.' },
        { key: 'GF_SMTP_PASSWORD', set: false, credential: true, placeholder: false, usedBy: ['monitoring/compose.yml'], purpose: "Grafana's SMTP login, for alert email.", rotate: 'Edit .env, then `just up-monitoring`.' },
        { key: 'WIKI_DB_PASSWORD', set: true, credential: true, placeholder: false, usedBy: ['scripts/bootstrap.sh'], purpose: null, rotate: null },
        { key: 'BOX_IP', set: true, credential: false, placeholder: false, usedBy: ['auth/compose.yml', 'apps/headlamp/compose.yml'] },
      ],
    },
    files: [
      f('kube-token', 'apps/bothy-ops/secrets/token', "bothy-ops' ServiceAccount token (bothy/bothy-kube): restart, scale, logs in two namespaces.", ['bothy-ops'], '`just kube-token --rotate`', '600', '600', 3600 * 5),
      f('keycloak-admin', 'apps/bothy-ops/secrets/keycloak-admin-client-secret', 'Client `bothy-admin` (realm-management view-users only) - the Users & roles page.', ['bothy-ops'], '`just admin-client --rotate`', '600', '600', 3600),
      f('headlamp-kubeconfig', 'apps/headlamp/secrets/kubeconfig', "Headlamp's read-only cluster identity (bothy/bothy-browse).", ['headlamp'], '`just headlamp-token --rotate`', '600', null, null),
      f('prom-route', 'edge/dynamic/bothy-prom.yml', "The basic-auth header Traefik injects on the portal's metrics queries.", ['traefik'], '`just bothy-prom-route` (after changing DEV_LOGIN_*).', '600', '644', 86400 * 9),
      f('prom-password', 'monitoring/prom-password.txt', "VictoriaMetrics' basic-auth password (644 on purpose: read by another uid).", ['victoriametrics'], '`just bootstrap --force` regenerates it from the dev login.', '644', '644', 86400 * 40),
    ],
    clients: [
      { id: 'oauth2-proxy', purpose: 'forwardAuth for every role gate at the edge.', realm: 'devbox', where: '.env KEYCLOAK_OAUTH2_CLIENT_SECRET', set: true, changed: ago(86400 * 2), changedScope: 'file' },
      { id: 'bothy-admin', purpose: 'bothy-ops reading users and their roles (view-users only).', realm: 'devbox', where: 'apps/bothy-ops/secrets/keycloak-admin-client-secret', set: true, changed: ago(3600), changedScope: 'file' },
    ],
  };
}

export async function backupsMock(): Promise<BackupsResult> {
  const stale = await gate('backups');
  const day = 86400;
  return {
    generatedAt: ago(stale ? 5400 : 95), ageSeconds: stale ? 5400 : 95, stale,
    root: '~/backups', present: true, keep: 14, command: 'just backup',
    timer: { unit: 'stacks-backup.timer', active: 'active', last: 'Thu 2026-09-17 03:00:08 IDT', next: 'Fri 2026-09-18 03:00:00 IDT' },
    sets: [
      { name: 'env', managed: true, what: 'Copies of .env - every credential, in plaintext.', readable: true, mode: '700', count: 14, bytes: 25_256, newest: { name: 'env-20260917-030008', at: ago(day * 0.35), bytes: 1804 }, oldest: { name: 'env-20260904-030001', at: ago(day * 13.3), bytes: 1790 } },
      { name: 'grafana', managed: true, what: 'grafana.db - dashboards, users, alert state.', readable: true, mode: '700', count: 14, bytes: 40_886_272, newest: { name: 'grafana-20260917-030008.db', at: ago(day * 0.35), bytes: 2_920_448 }, oldest: { name: 'grafana-20260904-030001.db', at: ago(day * 13.3), bytes: 2_899_968 } },
      { name: 'postgres', managed: true, what: 'pg_dumpall of every database, keycloak included (users and password hashes).', readable: true, mode: '700', count: 14, bytes: 972_763, newest: { name: 'pg-20260917-030008.sql.gz', at: ago(day * 0.35), bytes: 69_491 }, oldest: { name: 'pg-20260904-030001.sql.gz', at: ago(day * 13.3), bytes: 68_100 } },
      { name: 'portainer', managed: false, what: null, readable: true, mode: '700', count: 14, bytes: 14_680_064, newest: { name: 'portainer-20260817-030011.db', at: ago(day * 31), bytes: 1_048_576 }, oldest: { name: 'portainer-20260804-030001.db', at: ago(day * 44), bytes: 1_048_576 } },
    ],
  };
}

const ENTRIES: AuditEntry[] = [
  { log: 'admin', kind: 'admin', at: ago(30), who: 'dev@example.com', outcome: 'READ', action: 'admin-audit', target: '', detail: '', tookMs: 3 },
  { log: 'ops', kind: 'container', at: ago(600), who: 'dev@example.com', outcome: 'ACTED', action: 'restart', target: 'grafana', detail: 'running -> running', tookMs: 381 },
  { log: 'config', at: ago(1800), who: 'dev@example.com', outcome: 'PATCHED', action: 'patch', target: 'stacks/edge/compose.yml', detail: "traefik · dev.portal.project · 'Edge' -> 'Edge · Traefik'", tookMs: null },
  { log: 'files', at: ago(3600), who: 'dev@example.com', outcome: 'WROTE', action: 'write', target: 'notes/stack/portal.md', detail: '31204 bytes', tookMs: null },
  { log: 'ops', kind: 'kube', at: ago(7200), who: 'dev@example.com', outcome: 'ACTED', action: 'scale', target: 'thales-dev/api', detail: '{"replicas":2}', tookMs: 120 },
  { log: 'ops', kind: 'container', at: ago(9000), who: 'dev@example.com', outcome: 'REFUSED', action: 'stop', target: 'traefik', detail: 'the request arrived through Traefik, so stopping it would leave this action with no way to report what it did.', tookMs: null },
  { log: 'files', at: ago(86400), who: 'dev@example.com', outcome: 'DELETED', action: 'delete', target: 'notes/_scratch.md', detail: '53 bytes', tookMs: null },
  { log: 'admin', kind: 'admin', at: ago(90000), who: 'dev@example.com', outcome: 'FAILED', action: 'admin-users', target: '', detail: 'users unavailable - no Keycloak admin client secret on this box; run `just admin-client`', tookMs: 1 },
];

export async function auditMock(q: AuditQuery): Promise<AuditResult> {
  await gate('audit');
  let e = ENTRIES.filter((x) => !q.log || q.log === 'all' || x.log === q.log);
  const facets = {
    who: [...new Set(e.map((x) => x.who))].sort(),
    outcome: [...new Set(e.map((x) => x.outcome))].sort(),
    action: [...new Set(e.map((x) => x.action))].sort(),
  };
  if (q.who) e = e.filter((x) => x.who.toLowerCase().includes(q.who!.toLowerCase()));
  if (q.outcome) e = e.filter((x) => x.outcome.toLowerCase() === q.outcome!.toLowerCase());
  if (q.action) e = e.filter((x) => x.action === q.action);
  const offset = q.offset ?? 0;
  const limit = q.limit ?? 50;
  return {
    total: e.length, offset, limit, skipped: 0,
    logs: { ops: { present: true, truncated: false, lines: 4 }, admin: { present: true, truncated: false, lines: 2 },
      files: { present: true, truncated: false, lines: 2 }, config: { present: true, truncated: false, lines: 1 } },
    facets, entries: e.slice(offset, offset + limit),
  };
}
