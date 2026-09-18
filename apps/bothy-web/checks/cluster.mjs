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
  shortImage, valueAllowed, worst, ago,
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
