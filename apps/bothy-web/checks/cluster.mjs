// The Cluster page's pure logic - run with ./checks/run.sh
//
// lib/cluster.ts decides what /control/cluster DRAWS: which service hangs off
// which deployment, what colour a node is, which buttons a role gets, and
// whether a ConfigMap value or an image would be refused before it is sent.
// Every one of those is wrong silently - a service attached to the wrong
// deployment still renders a tidy graph - so they get truth tables.
//
// Run against the generated catalog fixture (web/src/lib/kube-catalog.dev.json),
// so the gating and the allowlist mirrors are checked against what the service
// actually declares.

import { readFileSync } from 'node:fs';
import {
  buildTopology, deploymentStatus, gate, gateOf, imageAllowed, jobStatus, podStatus, selectorMatches,
  shortImage, valueAllowed, worst, ago, envProvenance,
} from './cluster-mod.mjs';
import { allowedFor } from './kube-actions-mod.mjs';

const CATALOG = JSON.parse(readFileSync(process.argv[2], 'utf8'));

let bad = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)}${ok ? '' : ` want=${JSON.stringify(want)} got=${JSON.stringify(got)}`}`);
};

// ── status ──────────────────────────────────────────────────────────────────
const d = (o) => ({ replicas: 1, readyReplicas: 1, updatedReplicas: 1, paused: false, ...o });
check('all ready is up', deploymentStatus(d({})), 'up');
check('scaled to 0 is off, not down', deploymentStatus(d({ replicas: 0, readyReplicas: 0, updatedReplicas: 0 })), 'off');
check('wants pods, none ready is down', deploymentStatus(d({ readyReplicas: 0 })), 'down');
check('some ready is warn', deploymentStatus(d({ replicas: 3, readyReplicas: 2, updatedReplicas: 3 })), 'warn');
check('rollout in progress is warn', deploymentStatus(d({ replicas: 2, readyReplicas: 2, updatedReplicas: 1 })), 'warn');
check('paused is warn', deploymentStatus(d({ paused: true })), 'warn');
check('worst of up, off, warn', worst(['up', 'off', 'warn']), 'warn');
check('worst of nothing is unknown', worst([]), 'unknown');
const p = (status, ready = 1, total = 1) => ({ status, phase: 'Running', readyContainers: ready, totalContainers: total });
check('pod Running all ready', podStatus(p('Running')), 'up');
check('pod Running not ready', podStatus(p('Running', 0)), 'warn');
check('pod CrashLoopBackOff', podStatus(p('CrashLoopBackOff', 0)), 'down');
check('pod ImagePullBackOff', podStatus(p('ImagePullBackOff', 0)), 'down');
check('pod Completed is off', podStatus(p('Completed', 0)), 'off');
check('pod Pending is warn', podStatus(p('Pending', 0)), 'warn');
check('job statuses', ['Complete', 'Failed', 'Running', '?'].map(jobStatus), ['up', 'down', 'warn', 'unknown']);

// ── selectors ───────────────────────────────────────────────────────────────
check('subset matches', selectorMatches({ app: 'backend' }, { app: 'backend', tier: 'api' }), true);
check('different value does not', selectorMatches({ app: 'backend' }, { app: 'backend2' }), false);
check('missing key does not', selectorMatches({ app: 'backend', tier: 'api' }, { app: 'backend' }), false);
check('an EMPTY selector matches nothing', selectorMatches({}, { app: 'backend' }), false);
check('no selector matches nothing', selectorMatches(null, { app: 'backend' }), false);

// ── topology ────────────────────────────────────────────────────────────────
const dep = (name, o = {}) => ({ name, replicas: 1, readyReplicas: 1, updatedReplicas: 1, paused: false, templateLabels: { app: name }, ...o });
const svc = (name, selector) => ({ name, type: 'ClusterIP', clusterIP: '10.0.0.1', ports: [{ port: 80, targetPort: 80, protocol: 'TCP' }], selector });
const topo = buildTopology(
  [dep('frontend'), dep('backend', { readyReplicas: 0 }), dep('frontend-canary', { templateLabels: { app: 'frontend', track: 'canary' } })],
  [svc('frontend', { app: 'frontend' }), svc('backend', { app: 'backend' }), svc('orphan', { app: 'gone' }), svc('manual', {})],
  [{ name: 'thales', host: 'thales.example', service: 'frontend', tls: 'edge', admitted: null },
   { name: 'dangling', host: 'x.example', service: 'nope', tls: null, admitted: null }],
  [{ name: 'api', rules: [{ host: 'api.example', path: '/', service: 'backend' }, { host: 'api.example', path: '/x', service: 'missing' }], tlsHosts: [] }],
);
const edges = topo.edges.map((e) => `${e.from}>${e.to}`).sort();
check('service -> every deployment its selector matches (template labels)', edges.filter((e) => e.endsWith('>service/frontend')),
  ['deployment/frontend-canary>service/frontend', 'deployment/frontend>service/frontend']);
check('route -> the service it names', edges.includes('service/frontend>route/thales'), true);
check('ingress -> each known service', edges.filter((e) => e.endsWith('>ingress/api')), ['service/backend>ingress/api']);
check('no edge to a service that does not exist', edges.some((e) => e.includes('nope') || e.includes('missing')), false);
const st = Object.fromEntries([...topo.deployments, ...topo.services, ...topo.entries].map((n) => [n.id, n.status]));
check('a service backed by a down deployment is down', st['service/backend'], 'down');
check('a service with no deployment is down', st['service/orphan'], 'down');
check('a selector-less service is down, not attached to everything', st['service/manual'], 'down');
check('a route inherits its service', st['route/thales'], 'up');
check('a route to a missing service is down, and shown', st['route/dangling'], 'down');
check('an ingress naming a missing service is warn', st['ingress/api'], 'warn');
check('columns are sorted by name', topo.deployments.map((n) => n.name), ['backend', 'frontend', 'frontend-canary']);

// ── roles ───────────────────────────────────────────────────────────────────
const roleSets = [[], ['viewer'], ['operator'], ['viewer', 'operator'], ['editor'], ['shell']];
let agree = true;
for (const roles of roleSets) {
  for (const a of CATALOG.actions) {
    if ((gate(roles, a) === 'enabled') !== allowedFor(roles, a)) agree = false;
  }
}
check('gate() and allowedFor() agree on every action and role set', agree, true);
check('viewer: reads enabled', gateOf(['viewer'], CATALOG, 'pods'), 'enabled');
check('viewer: changes drawn disabled (the verb exists, not theirs)', gateOf(['viewer'], CATALOG, 'delete-pod'), 'disabled');
check('operator: changes enabled', gateOf(['operator'], CATALOG, 'run-template'), 'enabled');
check('no role: reads hidden', gateOf([], CATALOG, 'pods'), 'hidden');
check('no role: changes hidden', gateOf([], CATALOG, 'set-image'), 'hidden');
check('editor alone is no cluster role', gateOf(['editor'], CATALOG, 'rollback-to-revision'), 'hidden');
check('an action the catalog does not declare is hidden, even for operator', gateOf(['operator'], CATALOG, 'exec'), 'hidden');
check('no catalog yet: hidden', gateOf(['operator'], null, 'pods'), 'hidden');

// ── ConfigMap values, with fullmatch semantics ──────────────────────────────
check('the catalog has editable keys', Object.keys(CATALOG.configmapKeys).length > 0, true);
if (CATALOG.configmapKeys.LOG_LEVEL) {
  for (const v of ['debug', 'info', 'warn', 'error']) check(`LOG_LEVEL=${v}`, valueAllowed(CATALOG, 'LOG_LEVEL', v), true);
  for (const v of ['', 'INFO', 'trace', 'info ', ' info', 'info\n', 'infox', 'xinfo', 'info|debug', 'debug\ninfo']) {
    check(`LOG_LEVEL refuses ${JSON.stringify(v)}`, valueAllowed(CATALOG, 'LOG_LEVEL', v), false);
  }
}
if (CATALOG.configmapKeys.DB_POOL_MAX) {
  check('DB_POOL_MAX 1, 10, 20', ['1', '10', '20'].map((v) => valueAllowed(CATALOG, 'DB_POOL_MAX', v)), [true, true, true]);
  check('DB_POOL_MAX 0, 21, 010, 5.0', ['0', '21', '010', '5.0'].map((v) => valueAllowed(CATALOG, 'DB_POOL_MAX', v)), [false, false, false, false]);
}
check('a key not in the allowlist is never valid', valueAllowed(CATALOG, 'AUTH_MODE', 'both'), false);
check('a key named like a prototype property is not valid', valueAllowed(CATALOG, 'constructor', 'x'), false);

// The 19 keys the allowlist gained on 2026-10-07. Each pattern was read off its
// consumer in ~/projects/army/Tals and then tightened; these rows ARE the
// derivations, so a pattern loosened later has to argue with the evidence. The
// order-of-magnitude cases come first, because that is what the bounds exist
// for: a non-number was never the dangerous input here.
const V = (k, v) => valueAllowed(CATALOG, k, v);
// 571 is past the 30 s margin Tals' verify-config.py holds against
// SYNC_OPTIMIZE_TIMEOUT_MS - a registry-level check that would not see a
// hand-edit here. 5400 is the typo that makes the solve answer long after the
// gateway 504'd the caller, which reads to everyone as "the optimiser hangs".
check('CPSAT_TIME_LIMIT 1, 540, 570', ['1', '540', '570'].map((v) => V('CPSAT_TIME_LIMIT', v)), [true, true, true]);
check('CPSAT_TIME_LIMIT 0, 571, 5400, 540.0, 0540, +540',
  ['0', '571', '5400', '540.0', '0540', '+540'].map((v) => V('CPSAT_TIME_LIMIT', v)),
  [false, false, false, false, false, false]);
// 0 is legal here and reserves nothing - a pinned boundary in the Tals tests.
// Above half of CPSAT_TIME_LIMIT's own ceiling the reserve is silently clamped,
// so a larger number states a budget that is never taken.
check('CPSAT_PHASE2_TIME_LIMIT 0, 120, 285', ['0', '120', '285'].map((v) => V('CPSAT_PHASE2_TIME_LIMIT', v)), [true, true, true]);
check('CPSAT_PHASE2_TIME_LIMIT 286, -1, 1200', ['286', '-1', '1200'].map((v) => V('CPSAT_PHASE2_TIME_LIMIT', v)), [false, false, false]);
// 8 threads x JOB_MAX_WORKERS against the algorithm pod's 2-CPU limit is already
// the live state, so the live value is the ceiling: this key turns DOWN.
check('CPSAT_SEARCH_WORKERS 1 and 8 yes; 0, 9, 16 no',
  ['1', '8', '0', '9', '16'].map((v) => V('CPSAT_SEARCH_WORKERS', v)), [true, true, false, false, false]);
// config.py bounds it not at all; OR-Tools does, as a protobuf int32, and it
// fails at SOLVE time - a 500 per request rather than a crash-loop, which is the
// harder fault to read.
check('CPSAT_RANDOM_SEED 0, 42, 999999999 yes; 1000000000 and -1 no',
  ['0', '42', '999999999', '1000000000', '-1'].map((v) => V('CPSAT_RANDOM_SEED', v)), [true, true, true, false, false]);
// A RELATIVE gap of 1 is 100%: it accepts the first feasible answer found. The
// code does not refuse it; the pattern keeps it under 1. 0 means prove it exactly.
check('CPSAT_RELATIVE_GAP_LIMIT 0, 0.001, 0.999999 yes; 1, .5, 1e-3 no',
  ['0', '0.001', '0.999999', '1', '.5', '1e-3'].map((v) => V('CPSAT_RELATIVE_GAP_LIMIT', v)),
  [true, true, true, false, false, false]);
// _boolean, NOT an int: `2` is a ConfigError at import, so a numeric pattern
// would have been wrong rather than merely loose.
check('CPSAT_LEX_MERGE 0 and 1 only',
  ['0', '1', '2', 'true', 'TRUE', 'on'].map((v) => V('CPSAT_LEX_MERGE', v)), [true, true, false, false, false, false]);
check('MILP_TIME_LIMIT 540 yes; 571 and 5400 no',
  ['540', '571', '5400'].map((v) => V('MILP_TIME_LIMIT', v)), [true, false, false]);
// ABSOLUTE, in objective units, not a fraction. Above about 1 it can trade away
// a real decision, and nothing in the code bounds it.
check('MILP_GAP_ABS 0, 0.5, 9.999 yes; 10 and 0.0001 no',
  ['0', '0.5', '9.999', '10', '0.0001'].map((v) => V('MILP_GAP_ABS', v)), [true, true, true, false, false]);

// The timeouts. 0 is refused for all of them, and for every one but
// SHUTDOWN_GRACE_MS that is the code's own rule - pg reads 0 as "wait forever"
// and as "no limit", and the Python float keys are positive=True.
check('DB_CONNECTION_TIMEOUT_MS 1000, 10000, 60000 yes; 0, 999, 60001 no',
  ['1000', '10000', '60000', '0', '999', '60001'].map((v) => V('DB_CONNECTION_TIMEOUT_MS', v)),
  [true, true, true, false, false, false]);
check('DB_STATEMENT_TIMEOUT_MS 60000 yes; 0 and 6000000 no',
  ['60000', '0', '6000000'].map((v) => V('DB_STATEMENT_TIMEOUT_MS', v)), [true, false, false]);
// The one key read only by a shell. POSIX $(( )) is base-prefix-aware, so 060 is
// OCTAL 48 - the leading zero this pattern refuses is load-bearing, not tidy.
check('DB_WAIT_TIMEOUT_S 60 and 600 yes; 060 and 601 no',
  ['60', '600', '060', '601'].map((v) => V('DB_WAIT_TIMEOUT_S', v)), [true, true, false, false]);
// Must stay STRICTLY under GATEWAY_TIMEOUT_S x 1000 = 660000, and
// GATEWAY_TIMEOUT_S is not editable - so 600000 keeps that true for every value
// this pattern can produce.
check('JOB_CONTROL_TIMEOUT_MS 30000 and 600000 yes; 660000 no',
  ['30000', '600000', '660000'].map((v) => V('JOB_CONTROL_TIMEOUT_MS', v)), [true, true, false]);
// Python float, so the code would take 9e2 and .5. Integer seconds is tighter
// and is what every ConfigMap emits.
check('JOB_TTL_SECONDS 900 and 86400 yes; 0, 86401, 9e2 no',
  ['900', '86400', '0', '86401', '9e2'].map((v) => V('JOB_TTL_SECONDS', v)), [true, true, false, false, false]);
// 0 is legal to the CODE (min: 0, and a pinned good value in the Tals tests) and
// refused HERE: it abandons the drain, the incident flush and the pool close at
// once, which is a data-loss setting with no room in a table cell to say so.
// Above 30000 the pod is SIGKILLed mid-sequence, because no Tals manifest sets
// terminationGracePeriodSeconds and Kubernetes' default is 30 s.
check('SHUTDOWN_GRACE_MS 1000, 10000, 30000 yes; 0 and 30001 no',
  ['1000', '10000', '30000', '0', '30001'].map((v) => V('SHUTDOWN_GRACE_MS', v)),
  [true, true, true, false, false]);
// Pinned between two inequalities verify-config.py enforces: at or below
// GATEWAY_TIMEOUT_S x 1000, and at least 30 s above the largest solver limit -
// which is itself editable up to 570, so the floor that holds for EVERY
// combination this table allows is 600000 and not the 570000 the live 540 permits.
check('SYNC_OPTIMIZE_TIMEOUT_MS 600000 and 660000 yes; 570000 and 660001 no',
  ['600000', '660000', '570000', '660001'].map((v) => V('SYNC_OPTIMIZE_TIMEOUT_MS', v)),
  [true, true, false, false]);
check('MIGRATION_LOCK_TIMEOUT_MS 120000 yes; 0 no',
  ['120000', '0'].map((v) => V('MIGRATION_LOCK_TIMEOUT_MS', v)), [true, false]);
// The backend refuses to START below 7056044 - the base64 cost of one 5 MiB
// attachment - and that floor appears nowhere in the ConfigMap.
check('MAX_REQUEST_BODY_BYTES 10485760 yes; 7056043, 1048576, 700000000 no',
  ['10485760', '7056043', '1048576', '700000000'].map((v) => V('MAX_REQUEST_BODY_BYTES', v)),
  [true, false, false, false]);
// Its declared minimum is DEAD in production: nothing calls requireInt for it,
// and the live parser would accept 1 - a 1 ms descriptor poll against AD-FS
// behind a 5 s per-fetch timeout, with nothing clamping the overlap. This
// pattern is the only guard that exists.
check('SSO_IDP_REFRESH_MS 30000 and 60000 yes; 1, 5000, 29999 no',
  ['30000', '60000', '1', '5000', '29999'].map((v) => V('SSO_IDP_REFRESH_MS', v)),
  [true, true, false, false, false]);

// ENABLED_ALGORITHMS - the one non-numeric key, and the one where every
// malformed value is a CrashLoopBackOff of the backend rather than a rejected
// form. An unknown member, a repeat and an empty list are each a raw throw from
// module scope at import, and the parser never lowercases - so `MILP`, which is
// how the UI spells it on screen, would take the deployment down. Exhaustive
// over all 15 legal lists, because a whitelist that misses a legal value is a
// row the operator cannot set back.
const ALGS = ['heuristic', 'milp', 'cpsat'];
const LEGAL = [];
for (const a of ALGS) {
  LEGAL.push(a);
  for (const b of ALGS) {
    if (b === a) continue;
    LEGAL.push(`${a},${b}`);
    for (const c of ALGS) if (c !== a && c !== b) LEGAL.push(`${a},${b},${c}`);
  }
}
check('ENABLED_ALGORITHMS accepts all 15 ordered, repeat-free lists',
  [LEGAL.length, LEGAL.filter((v) => !V('ENABLED_ALGORITHMS', v))], [15, []]);
check('ENABLED_ALGORITHMS refuses empty, unknown, repeated, cased and spaced',
  ['', 'greedy', 'heuristic,greedy', 'milp,milp', 'MILP', 'Heuristic', 'heuristic, milp',
    'heuristic,', ',milp', 'heuristic,,milp', 'heuristic,milp,cpsat,milp', 'milpcpsat',
  ].filter((v) => V('ENABLED_ALGORITHMS', v)), []);
// Excluded on purpose: GATEWAY_TIMEOUT_S is one stated number for the Route, the
// frontend nginx and the registry both are checked against; ENABLE_OTLP_EXPORT's
// legal values depend on OTLP_ENDPOINT's, and this edits one key at a time.
check('GATEWAY_TIMEOUT_S is not editable from here', V('GATEWAY_TIMEOUT_S', '660'), false);
check('ENABLE_OTLP_EXPORT is not editable from here', V('ENABLE_OTLP_EXPORT', 'true'), false);

// ── the reason categories behind the per-row sentence ───────────────────────
// The UI holds NO list of which keys are addresses and which are identity
// settings - the service resolves that from the catalog. What the UI relies on
// is the SHAPE, so that is what is checked here.
check('the catalog publishes reason categories', CATALOG.configmapReasons.length > 1, true);
check('the catch-all is declared last, and matches everything',
  CATALOG.configmapReasons.at(-1).keys.length, 0);
check('every category states a label and a sentence',
  CATALOG.configmapReasons.filter((r) => !r.label || !r.meaning).map((r) => r.name), []);
// A row cannot both offer an Edit button and explain why it has none. guard.py
// refuses that catalog; this asserts it on what the UI is actually served.
check('no category claims a key that is editable',
  CATALOG.configmapReasons.flatMap((r) => r.keys.filter(
    (k) => Object.keys(CATALOG.configmapKeys).some((e) => new RegExp(`^(?:${k})$`).test(e)))), []);

// ── provenance: which workloads a change would actually reach ──────────────
// `configmaps` has been on the wire per deployment since 2026-09 and nothing
// read it until 2026-10-07. postgres is the live case that makes it worth
// drawing: it runs in the namespace and reads no ConfigMap, so a change here
// leaves it alone - which is not visible anywhere in a ConfigMap listing.
const pdep = (name, configmaps) => ({ name, configmaps });
check('readers and non-readers, both sorted',
  envProvenance('thales', [pdep('frontend', ['thales']), pdep('postgres', []), pdep('algorithm', ['thales']), pdep('backend', ['thales'])]),
  { readers: ['algorithm', 'backend', 'frontend'], others: ['postgres'] });
check('a ConfigMap nothing reads', envProvenance('thales', [pdep('postgres', [])]), { readers: [], others: ['postgres'] });
check('an empty namespace is not an error', envProvenance('thales', []), { readers: [], others: [] });
check('a deployment with no configmaps field at all is a non-reader',
  envProvenance('thales', [{ name: 'x' }]), { readers: [], others: ['x'] });
check('another ConfigMap of the same deployment does not count',
  envProvenance('thales', [pdep('x', ['other'])]), { readers: [], others: ['x'] });

// ── images ──────────────────────────────────────────────────────────────────
const img = (s) => imageAllowed(CATALOG, s);
check('thales/backend:0.1.7', img('thales/backend:0.1.7'), true);
check('localhost:5000/thales/backend:0.1.8', img('localhost:5000/thales/backend:0.1.8'), true);
check('digest', img(`thales/backend@sha256:${'a'.repeat(64)}`), true);
for (const s of [
  'nginx:latest', 'docker.io/thales/backend:1', 'ghcr.io/thales/backend:1', 'thales/backend',
  'thales.evil.com/backend:1', 'thales/../x:1', 'Thales/backend:1', 'thales/backend:1 ', 'thales/backend:1\n',
  'localhost:5001/thales/backend:1', 'thalesx/backend:1', '', `thales/${'a'.repeat(260)}:1`,
]) {
  check(`image refused: ${JSON.stringify(s.slice(0, 40))}`, img(s), false);
}

// ── formatting ──────────────────────────────────────────────────────────────
check('shortImage', [shortImage('thales/backend:0.1.7'), shortImage('postgres:16-alpine'), shortImage('localhost:5000/thales/x:1')],
  ['backend:0.1.7', 'postgres:16-alpine', 'x:1']);
const now = Date.parse('2026-09-17T12:00:00Z');
check('ago', ['2026-09-17T11:59:30Z', '2026-09-17T11:30:00Z', '2026-09-17T06:00:00Z', '2026-09-14T12:00:00Z', null].map((x) => ago(x, now)),
  ['30s ago', '30m ago', '6h ago', '3d ago', '-']);

if (bad) { console.log(`\n${bad} FAILED`); process.exit(1); }
