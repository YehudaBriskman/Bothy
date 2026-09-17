// What a cluster workload can be acted on - run with ./checks/run.sh
//
// lib/projects.ts decides whether a collector service carries a cluster identity,
// and lib/kube-actions.ts decides whether that identity is in scope and which
// confirm step each action needs. Both fail silently: a lost `kube` field is a
// row with no control, and a widened scope is a control for a namespace the
// service will refuse. apps/bothy-kube/checks/wiring.py asserts the catalog copy
// matches catalog.toml; this asserts the behaviour built on it.

import { withDeclared } from './projects-mod.mjs';
import {
  KUBE_CATALOG, KUBE_NAMESPACES, kubeTargetOf, confirmSatisfied, allowedFor, kubeRefusalOf,
  followUrl, specOf,
} from './kube-actions-mod.mjs';

globalThis.location ??= { hostname: 'box.example' };

let bad = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)}${ok ? '' : ` want=${JSON.stringify(want)} got=${JSON.stringify(got)}`}`);
};

// ── the catalog copy ──────────────────────────────────────────────────────────
check('five actions', KUBE_CATALOG.map((a) => a.id).sort(),
  ['delete-completed-pods', 'events', 'logs', 'rollout-restart', 'scale']);
check('no operator action confirms with none',
  KUBE_CATALOG.filter((a) => a.role === 'operator' && a.confirm === 'none').map((a) => a.id), []);
check('scale is type-name', specOf('scale').confirm, 'type-name');
check('only logs streams', KUBE_CATALOG.filter((a) => a.stream).map((a) => a.id), ['logs']);
check('two namespaces', KUBE_NAMESPACES, ['thales-dev', 'thales-pre-prod']);

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

// ── roles (drawing only) ─────────────────────────────────────────────────────
check('viewer reads', allowedFor(['viewer'], specOf('logs')), true);
check('viewer cannot scale', allowedFor(['viewer'], specOf('scale')), false);
check('operator scales', allowedFor(['operator'], specOf('scale')), true);
check('editor cannot restart', allowedFor(['editor'], specOf('rollout-restart')), false);
check('nobody reads nothing', allowedFor([], specOf('events')), false);

// ── refusals ─────────────────────────────────────────────────────────────────
const err = (status, message) => Object.assign(new Error(message), { status });
check('edge 403 is the role', kubeRefusalOf(err(403, 'scale refused (403)'), specOf('scale'), 'x').needsRole, true);
check('service 403 is the scope, not the role',
  kubeRefusalOf(err(403, "namespace 'kube-system' is out of scope"), specOf('logs'), 'x').needsRole, false);
check('5xx is a fault', kubeRefusalOf(err(502, 'the cluster refused'), specOf('scale'), 'x').title.startsWith('Could not'), true);
check('status 0 is silence', kubeRefusalOf(err(0, 'x'), specOf('events'), 'x').title, 'The cluster tier did not answer.');

// ── the follow URL stays in bounds ───────────────────────────────────────────
const q = (u) => Object.fromEntries(new URL(u, 'http://x').searchParams);
const t = { namespace: 'thales-dev', deployment: 'frontend' };
check('follow URL path', followUrl(t, 50, 120).split('?')[0], '/-/api/kube/logs');
check('seconds capped at 300', q(followUrl(t, 50, 9999)).seconds, '300');
check('seconds floored at 5', q(followUrl(t, 50, 1)).seconds, '5');
check('tail capped at 500', q(followUrl(t, 9999, 60)).tail, '500');

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
