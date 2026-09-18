// What a cluster workload can be acted on - run with ./checks/run.sh
//
// lib/projects.ts decides whether a collector service carries a cluster identity,
// and lib/kube-actions.ts decides whether that identity is in scope and which
// confirm step each action needs. Both fail silently: a lost `kube` field is a
// row with no control, and a widened scope is a control for a namespace the
// service will refuse.
//
// THE CATALOG IS NOT IN THE CLIENT ANY MORE (2026-09): the page fetches it from
// GET /-/api/kube/catalog. The fixture here is web/src/lib/kube-catalog.dev.json,
// which scripts/gen-ops-wiring.py GENERATES from apps/bothy-ops/catalog.toml and
// apps/bothy-ops/checks/wiring.py holds to it - so these truth tables run
// against the real catalog, not a copy somebody typed.

import { readFileSync } from 'node:fs';
import { withDeclared } from './projects-mod.mjs';
import {
  KUBE_NAMESPACES, kubeTargetOf, confirmSatisfied, confirmNameOf, allowedFor, kubeRefusalOf,
  followUrl, specOf, findSpec, boundsOf, targetField, queryOf,
} from './kube-actions-mod.mjs';

globalThis.location ??= { hostname: 'box.example' };

const CATALOG = JSON.parse(readFileSync(process.argv[2], 'utf8'));

let bad = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)}${ok ? '' : ` want=${JSON.stringify(want)} got=${JSON.stringify(got)}`}`);
};

// ── the catalog the service serves ────────────────────────────────────────────
const ids = CATALOG.actions.map((a) => a.id);
check('the original five are still there',
  ['delete-completed-pods', 'events', 'logs', 'rollout-restart', 'scale'].every((i) => ids.includes(i)), true);
check('no operator action confirms with none',
  CATALOG.actions.filter((a) => a.role === 'operator' && a.confirm === 'none').map((a) => a.id), []);
check('every operator action is a POST', CATALOG.actions.filter((a) => a.role === 'operator' && a.method !== 'POST').map((a) => a.id), []);
check('every viewer action is a GET', CATALOG.actions.filter((a) => a.role === 'viewer' && a.method !== 'GET').map((a) => a.id), []);
check('scale is type-name', specOf(CATALOG, 'scale').confirm, 'type-name');
for (const id of ['rollback-to-revision', 'set-image', 'run-template', 'patch-key', 'patch-key-and-restart']) {
  check(`${id} is operator + type-name`, [specOf(CATALOG, id).role, specOf(CATALOG, id).confirm], ['operator', 'type-name']);
}
for (const id of ['pause', 'resume', 'delete-pod', 'delete-job']) {
  check(`${id} is operator + click`, [specOf(CATALOG, id).role, specOf(CATALOG, id).confirm], ['operator', 'click']);
}
check('only logs streams', CATALOG.actions.filter((a) => a.stream).map((a) => a.id), ['logs']);
check('nothing that reads a secret, execs or tunnels',
  ids.filter((i) => /secret|exec|attach|port-?forward|shell|impersonate/.test(i)), []);
check('two namespaces, and the row scope agrees', [CATALOG.namespaces, KUBE_NAMESPACES], [['thales-dev', 'thales-pre-prod'], ['thales-dev', 'thales-pre-prod']]);
check('scale bounds come from the catalog', boundsOf(specOf(CATALOG, 'scale'), 'replicas'), { min: 0, max: 3 });
check('unknown id is null, not a throw', findSpec(CATALOG, 'exec'), null);
check('logs takes previous and container', ['previous', 'container'].every((p) => p in specOf(CATALOG, 'logs').params), true);
check('target fields', ['namespace', 'deployment', 'pod', 'job', 'template', 'configmap'].map(targetField),
  [null, 'deployment', 'pod', 'job', 'template', 'configmap']);

// ── what type-name asks for (the service checks the same string) ─────────────
check('deployment action confirms with the deployment',
  confirmNameOf(specOf(CATALOG, 'set-image'), { namespace: 'thales-dev', deployment: 'backend', image: 'x' }), 'backend');
check('run-template confirms with the template',
  confirmNameOf(specOf(CATALOG, 'run-template'), { namespace: 'thales-dev', template: 'migrate' }), 'migrate');
check('patch-key confirms with the KEY, not the configmap',
  confirmNameOf(specOf(CATALOG, 'patch-key'), { namespace: 'thales-dev', configmap: 'thales', key: 'LOG_LEVEL' }), 'LOG_LEVEL');
check('delete-completed-pods confirms with the namespace',
  confirmNameOf(specOf(CATALOG, 'delete-completed-pods'), { namespace: 'thales-dev' }), 'thales-dev');

// ── scope ─────────────────────────────────────────────────────────────────────
check('in scope', kubeTargetOf({ kube: { namespace: 'thales-dev', deployment: 'frontend' } }),
  { namespace: 'thales-dev', deployment: 'frontend' });
for (const ns of ['kube-system', 'thales', 'monitoring', 'default', 'THALES-DEV', '']) {
  check(`out of scope: ${JSON.stringify(ns)}`, kubeTargetOf({ kube: { namespace: ns, deployment: 'x' } }), null);
}
check('no kube field', kubeTargetOf({}), null);
check('no deployment', kubeTargetOf({ kube: { namespace: 'thales-dev', deployment: null } }), null);

// ── confirm levels ───────────────────────────────────────────────────────────
check('click needs nothing typed', confirmSatisfied('click', '', 'frontend'), true);
check('type-name exact', confirmSatisfied('type-name', 'algorithm', 'algorithm'), true);
for (const t of ['', 'algorith', 'Algorithm', 'algorithm ', ' algorithm']) {
  check(`type-name refuses ${JSON.stringify(t)}`, confirmSatisfied('type-name', t, 'algorithm'), false);
}
check('type-name with nothing to type is never satisfied', confirmSatisfied('type-name', '', ''), false);

// ── roles (drawing only) ─────────────────────────────────────────────────────
check('viewer reads', allowedFor(['viewer'], specOf(CATALOG, 'logs')), true);
check('viewer cannot scale', allowedFor(['viewer'], specOf(CATALOG, 'scale')), false);
check('operator scales', allowedFor(['operator'], specOf(CATALOG, 'scale')), true);
check('editor cannot restart', allowedFor(['editor'], specOf(CATALOG, 'rollout-restart')), false);
check('nobody reads nothing', allowedFor([], specOf(CATALOG, 'events')), false);

// ── refusals ─────────────────────────────────────────────────────────────────
const err = (status, message) => Object.assign(new Error(message), { status });
const s = (id) => specOf(CATALOG, id);
check('edge 403 is the role', kubeRefusalOf(err(403, 'scale refused (403)'), s('scale'), 'x').needsRole, true);
check('service 403 is the scope, not the role',
  kubeRefusalOf(err(403, "namespace 'kube-system' is out of scope"), s('logs'), 'x').needsRole, false);
check('5xx is a fault', kubeRefusalOf(err(502, 'the cluster refused'), s('scale'), 'x').title.startsWith('Could not'), true);
check('503 is the cluster, not a fault', kubeRefusalOf(err(503, 'cluster unavailable - cannot reach the apiserver (ConnectionRefusedError)'), s('events'), 'x').title, 'The cluster is not available.');
check('503 says container actions still work', /Container actions still work/.test(kubeRefusalOf(err(503, 'cluster unavailable'), s('scale'), 'x').detail), true);
check('status 0 is silence', kubeRefusalOf(err(0, 'x'), s('events'), 'x').title, 'The cluster tier did not answer.');

// ── the follow URL and query strings stay in bounds ──────────────────────────
const q = (u) => Object.fromEntries(new URL(u, 'http://x').searchParams);
const t = { namespace: 'thales-dev', deployment: 'frontend' };
check('follow URL path', followUrl(t, 50, 120).split('?')[0], '/-/api/kube/logs');
check('seconds capped at 300', q(followUrl(t, 50, 9999)).seconds, '300');
check('seconds floored at 5', q(followUrl(t, 50, 1)).seconds, '5');
check('tail capped at 500', q(followUrl(t, 9999, 60)).tail, '500');
check('follow carries pod and container', [q(followUrl(t, 5, 60, 'frontend-a', 'nginx')).pod, q(followUrl(t, 5, 60, 'frontend-a', 'nginx')).container], ['frontend-a', 'nginx']);
check('query drops undefined/empty, keeps false-y numbers',
  queryOf({ namespace: 'thales-dev', pod: undefined, container: '', tail: 0, previous: null }), 'namespace=thales-dev&tail=0');

// ── the collector's identity survives into the node ──────────────────────────
const projects = [{
  key: 'k8s-thales-scc-thales-dev', name: 'thales-dev (thales-scc)', kind: 'cluster', state: 'live',
  services: [
    { name: 'frontend', state: 'up', port: null, container: null, namespace: 'thales-dev', deployment: 'frontend' },
    { name: 'api', state: 'up', port: 8000, container: null },
  ],
}];
const nodes = withDeclared([], projects);
check('a cluster service carries kube', nodes.find((n) => n.name === 'frontend').kube,
  { namespace: 'thales-dev', deployment: 'frontend' });
check('a declared host service does not', nodes.find((n) => n.name === 'api').kube, null);
check('and has no container (so ActionCell hands it to KubeActionCell)',
  nodes.find((n) => n.name === 'frontend').container, null);

if (bad) { console.log(`\n${bad} FAILED`); process.exit(1); }
