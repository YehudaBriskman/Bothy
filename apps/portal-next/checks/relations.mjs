// Truth table for the dependency graph — run with ./checks/run.sh
//
// The portal spent its whole life INFERRING relationships (hostname nesting,
// name similarity, "same port must be the same service"). Every one of those
// inferences produced a wrong answer on this box at least once. These functions
// exist to replace inference with the labels Docker already writes, so what they
// must be tested for is the opposite failure: inventing an edge that no compose
// file declared.
//
// Two properties matter, and neither is visible on screen — a fabricated edge
// renders identically to a real one:
//
//   1. Every edge produced must trace back to a `com.docker.compose.depends_on`
//      entry. No edge may be synthesised from names.
//   2. Matching is scoped by PROJECT. Service names are unique only within a
//      compose project, so two projects that each have an `init` must not be
//      wired to each other. That cross-project bleed is precisely the bug class
//      that reported a stopped `tv-player-web` as running because Keycloak
//      happened to hold its port.

import {
  dependsOnOf, declaredOneShots, resolveEdges, conditionLabel,
  resourceAttrs, sharedNamespace,
} from './discover.mjs';

let bad = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)}${ok ? '' : ` want=${JSON.stringify(want)} got=${JSON.stringify(got)}`}`);
};

const ctr = (project, service, dependsOn) => ({
  Id: `${project}-${service}`,
  Names: [`/${project}-${service}-1`],
  Labels: {
    'com.docker.compose.project': project,
    'com.docker.compose.service': service,
    ...(dependsOn ? { 'com.docker.compose.depends_on': dependsOn } : {}),
  },
});

console.log('── parsing the label ───────────────────────────────────');

// The real value off this box, verbatim.
check('grafana: two edges, third field dropped',
  dependsOnOf(ctr('monitoring', 'grafana', 'loki:service_started:false,prometheus:service_started:false')),
  [{ service: 'loki', condition: 'service_started' }, { service: 'prometheus', condition: 'service_started' }]);

check('no label at all -> no edges', dependsOnOf(ctr('x', 'y')), []);
check('no container at all -> no edges', dependsOnOf(null), []);
check('empty label -> no edges', dependsOnOf(ctr('x', 'y', '')), []);
// A half-parsed entry would become a dependency on a service called "", which
// renders as a broken edge pointing at nothing — a fabricated alarm.
check('malformed entry is skipped, not half-parsed',
  dependsOnOf(ctr('x', 'y', 'justaname')), []);
check('malformed entry does not poison its neighbours',
  dependsOnOf(ctr('x', 'y', 'justaname,real:service_healthy:false')),
  [{ service: 'real', condition: 'service_healthy' }]);

console.log('\n── declared one-shots ──────────────────────────────────');

// The signal is stated from the OTHER side: keycloak waits for keycloak-db-init
// to complete, so db-init is the one-shot. db-init itself says nothing.
const auth = [
  ctr('auth', 'keycloak', 'keycloak-db-init:service_completed_successfully:false'),
  ctr('auth', 'keycloak-db-init'),
  ctr('auth', 'oauth2-proxy', 'keycloak:service_healthy:false'),
];
check('db-init is a declared one-shot', [...declaredOneShots(auth)], ['auth/keycloak-db-init']);
// service_healthy must NOT imply one-shot: oauth2-proxy waits on keycloak being
// healthy, and keycloak is a long-running server. Reading any dependency as a
// completion would mark half the box "completed" and silence real outages.
check('service_healthy does not imply one-shot',
  [...declaredOneShots([ctr('a', 'b', 'c:service_healthy:false')])], []);
check('one-shots are project-scoped',
  [...declaredOneShots([
    ctr('p1', 'app', 'init:service_completed_successfully:false'),
    ctr('p2', 'app', 'init:service_started:false'),
  ])], ['p1/init']);

console.log('\n── resolving edges ─────────────────────────────────────');

const authNodes = auth.map((c) => ({
  id: c.Id, name: c.Labels['com.docker.compose.service'],
  container: { labels: c.Labels }, dependsOn: dependsOnOf(c),
}));
const authEdges = resolveEdges(authNodes);
check('two edges from the auth system', authEdges.length, 2);
check('every edge resolved to a real node', authEdges.every((e) => e.to !== null), true);
check('keycloak -> keycloak-db-init',
  authEdges.filter((e) => e.from.name === 'keycloak').map((e) => [e.to?.name, e.condition]),
  [['keycloak-db-init', 'service_completed_successfully']]);

// THE property test: nothing may appear that a label did not declare.
const declared = new Set();
for (const c of auth) {
  for (const d of dependsOnOf(c)) declared.add(`${c.Labels['com.docker.compose.service']}->${d.service}:${d.condition}`);
}
check('no edge is invented',
  authEdges.every((e) => declared.has(`${e.from.name}->${e.toService}:${e.condition}`)), true);

// The cross-project bleed. Both projects have a service called `db`; only p1
// declares a dependency on it. If matching ignored the project, p1's edge would
// land on p2's db — a wiring diagram that is confidently, invisibly wrong.
const twoProjects = [
  ctr('p1', 'app', 'db:service_healthy:false'),
  ctr('p2', 'db'),
];
const bleed = resolveEdges(twoProjects.map((c) => ({
  id: c.Id, name: `${c.Labels['com.docker.compose.project']}-${c.Labels['com.docker.compose.service']}`,
  container: { labels: c.Labels }, dependsOn: dependsOnOf(c),
})));
check('same service name in another project is NOT matched',
  bleed.map((e) => [e.toService, e.to]), [['db', null]]);

// A dependency on something absent must survive as a broken edge. Dropping it
// would render a system that looks correctly wired while missing a component.
check('missing target survives as a broken edge, still named',
  resolveEdges([{ id: 'a', name: 'app', container: { labels: ctr('p', 'app').Labels }, dependsOn: [{ service: 'ghost', condition: 'service_started' }] }])
    .map((e) => [e.toService, e.to]),
  [['ghost', null]]);

// A node with no compose labels (a `docker run` orphan) has no project, so it
// can neither declare nor receive an edge. It must not crash the resolver.
check('unmanaged container produces no edges',
  resolveEdges([{ id: 'x', name: 'orphan', container: { labels: {} }, dependsOn: [] }]), []);
check('node with no container at all produces no edges',
  resolveEdges([{ id: 'x', name: 'route-only', container: null, dependsOn: [] }]), []);

console.log('\n── semconv identity ────────────────────────────────────');

const node = (project, service, id) => ({
  id: id ?? `${project}-${service}`, name: service,
  container: id === null ? null : { id: id ?? 'abc123', labels: ctr(project, service).Labels },
  dependsOn: [],
});

check('a compose container has a namespace and a name',
  resourceAttrs(node('monitoring', 'grafana', 'deadbeef1234')),
  { 'service.namespace': 'monitoring', 'service.name': 'grafana', 'service.instance.id': 'deadbeef1234' });
// An unmanaged container has no compose identity. Returning a partial object
// here would let a caller build a query for namespace "" — which on this box
// matches a bag of unrelated containers AND misses two of the five it claims to
// cover. null forces the caller to fall back instead.
check('unmanaged container has no semconv identity',
  resourceAttrs({ id: 'x', name: 'orphan', container: { id: 'a', labels: {} }, dependsOn: [] }), null);
check('route-only node has no semconv identity',
  resourceAttrs({ id: 'x', name: 'route', container: null, dependsOn: [] }), null);

check('a uniform system shares one namespace',
  sharedNamespace([node('auth', 'keycloak'), node('auth', 'oauth2-proxy')]), 'auth');
check('a mixed system shares none',
  sharedNamespace([node('auth', 'keycloak'), node('monitoring', 'grafana')]), null);
// The load-bearing one: ONE node without a compose identity poisons the whole
// group, because a namespace query would silently return a different set than
// the rows it sits under. Substituting a query that is merely SIMILAR is the
// same error as identifying a service by its port.
check('one unmanaged node disqualifies the whole group',
  sharedNamespace([node('auth', 'keycloak'), { id: 'x', name: 'orphan', container: { id: 'a', labels: {} }, dependsOn: [] }]),
  null);
check('empty group has no namespace', sharedNamespace([]), null);

console.log('\n── wording ─────────────────────────────────────────────');
check('healthy', conditionLabel('service_healthy'), 'to be healthy');
check('completed', conditionLabel('service_completed_successfully'), 'to finish');
check('started', conditionLabel('service_started'), 'to start');
// An unknown condition is shown raw rather than dropped or guessed at: a future
// compose version adding a condition should surface it, not hide the edge.
check('unknown condition passes through', conditionLabel('service_teleported'), 'service_teleported');

console.log(bad ? `\n${bad} FAILED` : '\nall pass');
process.exit(bad ? 1 : 0);
