// What a declared project can be ACTED on - run with ./checks/run.sh
//
// WHY THIS EXISTS. Two modules that never import each other decide, between
// them, whether a stopped project can be started from the console:
//
//   lib/projects.ts   folds each declared service into a node, and decides
//                     whether that node carries a container at all
//   lib/actions.ts    turns a node's status and its container's docker state
//                     into the verbs the dialog offers
//
// The failure they combine to produce is silent in both halves. `withDeclared`
// REMOVES the discovered node for every container a project declares, so if the
// declared node that replaces it has no container, the row simply stops offering
// Restart/Stop/Start - no error, no empty state, just a cell that used to have a
// control in it. That is what shipped: declaring a project took the action tier
// away from its own containers, and a stopped one had no way back.
//
// ── the security half, which is the reason the table is written this way ────
//
// The line these two modules must hold is not "offer a button". It is:
//
//     OFFER A VERB ONLY ON A CONTAINER DOCKER HAS ACTUALLY REPORTED.
//
// A declaration is a statement of intent - `project.dev.yml` names the container
// a project WOULD create. Starting a container that exists is
// /containers/<name>/start, which bothy-control performs and guard.VERBS allows.
// Creating one that does not exist is /containers/create, which the write socket
// proxy refuses by holding CONTAINERS=0, because a create with a bind mount of /
// is root on this box (apps/bothy-control/compose.yml). So a declared name that
// docker does not report must resolve to NOTHING, and the cases below assert
// that from three directions: docker silent, name absent, name merely similar.
//
// The dockerReachable case is the one worth stating out loud. When the docker
// call fails, api.ts still renders from the collector's file - and every
// declared node must then carry no container, so the page offers no verb it
// could not perform rather than a row of buttons that would 404.

import { withDeclared } from './projects-mod.mjs';
import { verbsFor } from './actions-mod.mjs';

// nodeOf() builds a URL from `location.hostname` for a declared UI service that
// is up. That is a browser global and this is node, so the one case that
// exercises it needs a stand-in - without which this file would pass by never
// reaching the branch.
globalThis.location ??= { hostname: 'box.example' };

let bad = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)}${ok ? '' : ` want=${JSON.stringify(want)} got=${JSON.stringify(got)}`}`);
};

/** A node as merge() builds one from /containers/json?all=1 - the only shape
 *  this module reads a container out of. */
const discovered = (name, state) => ({
  id: `node:${name}`,
  kind: 'unrouted',
  name,
  host: null,
  aliases: [],
  path: '/',
  url: null,
  browsable: false,
  system: 'unmanaged',
  group: 'unmanaged',
  groupTitle: 'Unmanaged',
  groupKind: 'infra',
  parent: null,
  depth: null,
  order: 0,
  hidden: false,
  route: null,
  container: {
    id: `deadbeef-${name}`,
    name,
    image: 'alpine:3',
    state,
    statusText: state === 'running' ? 'Up 3 hours' : 'Exited (0) 2 days ago',
    health: null,
    labels: { 'com.docker.compose.project': 'cvops' },
  },
  ports: [],
  status: state === 'running' ? 'up' : 'stopped',
  serviceType: 'runtime',
  volumes: [],
  dependsOn: [],
  completesOnPurpose: false,
  uptimeSecs: null,
  icon: 'server',
  desc: '',
  logs: null,
});

const project = (services, over = {}) => ({
  key: 'cvops',
  name: 'CVOps',
  kind: 'project',
  // NOT a path under /home. portability.sh refuses a hardcoded home directory
  // anywhere in the tree, and a fixture is not exempt - the whole point of that
  // check is that this repository runs on somebody else's machine.
  root: '/opt/checkout/cvops',
  start: 'just up',
  state: 'stopped',
  services,
  ...over,
});

const declaredNode = (nodes, name) => nodes.find((n) => n.id === `declared:cvops:${name}`);

console.log('── a declared service that names a live container ──────');

{
  // The container is RUNNING. Before this change the declared node replaced a
  // perfectly actionable discovered node with one carrying `container: null`.
  const nodes = withDeclared(
    [discovered('cvops-api', 'running')],
    [project([{ name: 'api', container: 'cvops-api', state: 'up' }])],
  );
  const n = declaredNode(nodes, 'api');
  check('the declared node carries docker\'s container', n.container?.name, 'cvops-api');
  check('  and docker\'s own state, not the collector\'s word', n.container?.state, 'running');
  check('  and its image, so the row is not a dash', n.container?.image, 'alpine:3');
  check('  so the dialog offers the two live verbs',
    verbsFor(n.status, n.container?.state), ['restart', 'stop']);
  // The whole point of dropping the discovered node is that the thing is not
  // counted twice. That must still hold now that its container survives.
  check('the container appears exactly once',
    nodes.filter((x) => x.container?.name === 'cvops-api').length, 1);
  check('the discovered node itself is gone',
    nodes.some((x) => x.id === 'node:cvops-api'), false);
}

console.log('\n── THE ISSUE (#91): a declared container that is stopped ');

{
  // `docker ps -a` on this box carries containers `just up` does not manage,
  // exited and startable. This is the case the console could not act on, and it
  // needs no grant that does not already exist.
  const nodes = withDeclared(
    [discovered('cvops-worker', 'exited')],
    [project([{ name: 'worker', container: 'cvops-worker', state: 'stopped',
                detail: 'container exited(0)' }])],
  );
  const n = declaredNode(nodes, 'worker');
  check('the stopped container is carried through', n.container?.name, 'cvops-worker');
  check('  docker says exited, not the collector\'s "stopped"', n.container?.state, 'exited');
  check('  so the dialog offers exactly Start',
    verbsFor(n.status, n.container?.state), ['start']);
  // `start` is the one verb guard.severed() never refuses, so this offer is
  // never a button that cannot be pressed.
  check('  and Start is a single verb, not a menu',
    verbsFor(n.status, n.container?.state).length, 1);
}

console.log('\n── a declared container docker has never created ───────');

{
  // The other half of #91, and the half that stays unbuilt on purpose: this
  // container does not exist, so starting it means creating it, and creating it
  // is the call the two-proxy split exists to refuse.
  const nodes = withDeclared(
    [discovered('cvops-api', 'running')],
    [project([{ name: 'db', container: 'cvops-postgres', state: 'stopped',
                detail: 'container does not exist' }])],
  );
  const n = declaredNode(nodes, 'db');
  check('no container is invented for a name docker never reported',
    n.container, null);
  // ActionCell renders nothing at all for a node with no container, which is
  // the assertion behind the assertion: no affordance, rather than one whose
  // only outcome is a refusal.
  check('  the node is still listed, and still says stopped', n.status, 'stopped');
}

{
  // Name SIMILARITY is not identity. Compose numbers its containers
  // (`cvops-api-1`), so a declaration naming `cvops-api` must not resolve to it
  // - the verb would be performed on a container nobody named.
  const nodes = withDeclared(
    [discovered('cvops-api-1', 'running')],
    [project([{ name: 'api', container: 'cvops-api', state: 'unknown' }])],
  );
  check('a near-miss name resolves to nothing',
    declaredNode(nodes, 'api').container, null);
  check('  and the container it nearly matched keeps its own node',
    nodes.find((x) => x.id === 'node:cvops-api-1')?.container?.name, 'cvops-api-1');
}

{
  // Docker unreachable: api.ts passes an empty container list and still renders
  // the collector's file. Every declared service must then carry no container.
  const nodes = withDeclared(
    [],
    [project([{ name: 'api', container: 'cvops-api', state: 'unknown',
                detail: 'docker is unreachable - container state unknown' }])],
  );
  check('docker unreachable offers no verb on anything',
    nodes.every((n) => n.container === null), true);
}

console.log('\n── a declared HOST process has no container to act on ──');

{
  // A `just dev` harness is the reason the collector exists. It is not a
  // container and there is nothing for docker to be asked about.
  const nodes = withDeclared(
    [discovered('cvops-api', 'running')],
    [project([{ name: 'web', port: 3000, ui: true, state: 'up' }])],
  );
  const n = declaredNode(nodes, 'web');
  check('a service declaring no container carries none', n.container, null);
  check('  and is still reachable by its declared port',
    n.url, 'http://box.example:3000');
}

console.log('\n── every state the collector emits has a portal word ───');

// collect.py's docstring lists seven. Two of them - collision and unverified -
// were absent from the union for months and fell through a `?? 'unknown'`
// guard, which is exactly the drift a truth table written from the OTHER file's
// documentation catches.
const STATES = [
  ['up', 'up'],
  ['starting', 'starting'],
  ['stopped', 'stopped'],
  ['stuck', 'down'],
  // Positive evidence the service is not running: the collector identified the
  // listener on its port as something else. collect.py's rollup folds it in
  // with stopped, and the service word has to agree with the project word.
  ['collision', 'stopped'],
  // Something is listening and the collector could not say what. A statement
  // about its own knowledge - never a pass, and never a fault either.
  ['unverified', 'unknown'],
  ['unknown', 'unknown'],
];
for (const [state, want] of STATES) {
  const nodes = withDeclared([], [project([{ name: 's', state }])]);
  check(`collector "${state}" reads as "${want}"`, declaredNode(nodes, 's').status, want);
}

// A state nobody has written down yet must not become a green dot. This is the
// guard that let the two missing states above go unnoticed, and it stays.
{
  const nodes = withDeclared([], [project([{ name: 's', state: 'invented-later' }])]);
  check('an unknown state falls back to unknown, never up',
    declaredNode(nodes, 's').status, 'unknown');
}

console.log('\n── nothing declared changes nothing ────────────────────');

{
  const input = [discovered('grafana', 'running')];
  check('no projects returns the discovered list untouched',
    withDeclared(input, []) === input, true);
}

console.log(bad ? `\n${bad} FAILED` : '\nall pass');
process.exit(bad ? 1 : 0);
