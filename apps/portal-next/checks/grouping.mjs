// Identity vs display grouping.
//
// `group` used to be one field doing three jobs: the URL a person bookmarks
// (`/control/systems/:name`), the seed the accent colour is hashed from, and the
// panel a service is shown in. So the first user-facing regroup would have
// 404'd every bookmark into the systems it touched and reshuffled the colours of
// the ones it did not. This file is the guard on the split that fixes it:
//
//   * `system` is derived and no label can move it;
//   * `group` is `system` unless `dev.portal.group` says otherwise;
//   * with no label set, the two are equal - which is what makes this whole
//     change invisible on a box nobody has configured, and is asserted here
//     rather than asserted in a comment.
//
// It also pins the two rules whose failure is SILENT. A wrong accent seed is
// only noticed when somebody cannot find a card by its colour any more, and a
// wrong bookmark lookup is only noticed by whoever opens the bookmark.
//
// And it covers the disagreement this work was found through: makeNode() honoured
// `dev.portal.group` and allPorts() did not, so the Ports section of a system
// assembled with that label came back empty.
//
// Run from checks/run.sh, which compiles discover.ts next door.
import { classify, merge, allPorts, primaryIdentity, findSystem } from './discover.mjs';

// merge() builds a browsable node's URL from `location.hostname` - deliberately,
// so a link works from whichever address the reader typed. Node has no
// `location`, and this is the first check to call merge() rather than a leaf
// function, so it supplies one. Grouping does not read it; without it the whole
// section below dies on a ReferenceError before the first assertion.
globalThis.location ??= { hostname: 'checks.invalid' };

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} ${ok ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

// Not under /home. These are fixtures, not facts about anybody's machine, and
// portability.sh flags a `/home/<name>/` path in a tracked file - correctly:
// the one place this repo is allowed to spell one out is repo-roots.mjs, whose
// subject IS the home directory that used to be hardcoded in discover.ts.
const ROOT = '/srv/box/stacks/';
// A container as /containers/json reports one, with only the labels that matter
// here. `extra` is where a dev.portal.* override goes.
const ctr = (proj, cfg, extra = {}, name = proj) => ({
  Id: `id-${name}`,
  Names: [`/${name}`],
  Image: 'demo:latest',
  State: 'running',
  Status: 'Up 3 minutes',
  Labels: {
    'com.docker.compose.project': proj,
    'com.docker.compose.project.config_files': cfg,
    'com.docker.compose.service': name,
    ...extra,
  },
  Ports: [{ IP: '0.0.0.0', PrivatePort: 5432, PublicPort: 5432, Type: 'tcp' }],
});

// ── identity is derived; only display grouping can be chosen ────────────────
console.log('── a label moves where it is SHOWN, never what it IS ────────────────');

const plain = classify(ctr('postgres', `${ROOT}data/postgres/compose.yml`), ROOT);
eq('no label: identity and group are the same string',
  [plain.system, plain.group], ['postgres', 'postgres']);

const moved = classify(
  ctr('postgres', `${ROOT}data/postgres/compose.yml`, { 'dev.portal.group': 'data' }),
  ROOT,
);
eq('dev.portal.group moves the display group',   moved.group, 'data');
eq('...and does NOT move the identity',          moved.system, 'postgres');
eq('...and leaves the kind alone',               moved.groupKind, 'stack');

const rekinded = classify(
  ctr('postgres', `${ROOT}data/postgres/compose.yml`, { 'dev.portal.groupKind': 'project' }),
  ROOT,
);
eq('dev.portal.groupKind still forces the panel', rekinded.groupKind, 'project');
eq('...without touching identity either',        rekinded.system, 'postgres');

// A route's hostname is a CLAIM ABOUT WHAT SOMETHING IS, made by whoever wrote
// the route, so it beats config_files and lands in `system` - not merely in
// `group`, which would make it a preference somebody could be talked out of.
const nested = classify(ctr('monitoring', `${ROOT}monitoring/compose.yml`), ROOT, {
  depth: 2, parent: 'cvops', leaf: 'grafana',
});
eq('nesting beats config_files, as identity',    [nested.system, nested.groupKind], ['cvops', 'project']);

// The @file host process with no container at all. Its hostname's leaf IS its
// system: falling through to the 'host' sentinel filed a project's own front-end
// under a fabricated group, away from the api/auth routes beside it.
eq('a depth-1 host process is its own system',
  classify(null, ROOT, { depth: 1, parent: null, leaf: 'tals' }).system, 'tals');
eq('a hostname that told us nothing -> host',
  classify(null, ROOT, { depth: null, parent: null, leaf: null }).system, 'host');
eq('a container with no compose labels',         classify({ Labels: {} }, ROOT).system, 'unmanaged');

// ── infra is a place on disk, not a list of names ───────────────────────────
//
// It WAS a list of five names and the list had already gone stale: bothy-control
// and bothy-config are Bothy, were split out of the `bothy` project after the set
// was written, and rendered as two more "Stack" systems beside monitoring.
//
// A name list is also the wrong shape for the question. Compose project names are
// global to the docker daemon and belong to whoever claimed them first, and this
// box runs four unrelated projects out of ~/projects.
console.log('\n── Bothy is what lives under <root>apps/, not what is named ─────────');

const kindOf = (proj, cfg, root = ROOT) => classify(ctr(proj, cfg), root).groupKind;

eq('bothy itself',            kindOf('bothy', `${ROOT}apps/bothy/compose.yml`), 'infra');
eq('the action tier, unnamed anywhere',
  kindOf('bothy-control', `${ROOT}apps/bothy-control/compose.yml`), 'infra');
eq('the config tier, unnamed anywhere',
  kindOf('bothy-config', `${ROOT}apps/bothy-config/compose.yml`), 'infra');
eq('a tier that does not exist yet is covered too',
  kindOf('bothy-tomorrow', `${ROOT}apps/bothy-tomorrow/compose.yml`), 'infra');
eq('edge is infra by name - it is not under apps/',
  kindOf('edge', `${ROOT}edge/compose.yml`), 'infra');
eq('a shared stack service is stack, not infra',
  kindOf('monitoring', `${ROOT}monitoring/compose.yml`), 'stack');

// THE TRAP, and it is the reason the path test exists. `docker compose` project
// names are unique per daemon but unqualified: they are simply the directory the
// compose file sat in. A project checked out at ~/projects/portal is somebody
// else's `portal`, and the old name set declared it part of Bothy.
eq('a FOREIGN project named `portal` is not Bothy',
  kindOf('portal', '/srv/box/projects/portal/compose.yml'), 'project');
eq('a foreign project named `bothy` is not Bothy either',
  kindOf('bothy', '/srv/box/projects/bothy/compose.yml'), 'project');
eq('a sibling checkout of the repo is not the repo',
  kindOf('bothy', '/srv/box/stacks-old/apps/bothy/compose.yml'), 'project');

// With NO root known the path test has nothing to run against, so the name set
// is all there is - and it must still fire, or the portal misfiles the page you
// are reading under "Stack" while its own file tier is down. This is the case the
// dead deployment names are kept for.
eq('no root known: Bothy is still recognised',
  kindOf('bothy', '/anywhere/apps/bothy/compose.yml', null), 'infra');
eq('no root known: a retired tier name still lands right',
  kindOf('portal-next', '/anywhere/apps/portal-next/compose.yml', null), 'infra');
eq('no root known: everything else is stack, not project',
  kindOf('cvops', '/srv/box/projects/cvops/compose.yml', null), 'stack');

// ── one rule, applied in one place ──────────────────────────────────────────
//
// The bug this replaces: makeNode() re-applied `dev.portal.group` on top of
// classify()'s answer and allPorts() printed the answer raw, so a service moved
// into a system by label showed up in that system's service list and its ports
// did not. `/control/systems/:name` filters ports on the group, so the Ports
// section of the very page the label exists to build came back empty.
console.log('\n── the node list and the ports table cannot disagree ────────────────');

const BOX = [
  ctr('postgres', `${ROOT}data/postgres/compose.yml`, { 'dev.portal.group': 'data' }, 'postgres'),
  ctr('redis', `${ROOT}data/redis/compose.yml`, { 'dev.portal.group': 'data' }, 'redis'),
];
const nodes = merge([], [], BOX);
const ports = allPorts(BOX);

eq('both nodes are displayed under the label',
  nodes.map((n) => n.group).sort(), ['data', 'data']);
eq('both PORT ROWS are too',
  ports.map((p) => p.group).sort(), ['data', 'data']);
eq('and the port rows still know what they are',
  ports.map((p) => p.system).sort(), ['postgres', 'redis']);
eq('a node and its port row agree on the group',
  nodes.every((n) => ports.some((p) => p.container === n.container.name && p.group === n.group)), true);

// Same list with the labels taken off: nothing about it changes except the two
// strings somebody chose. This is the zero-config promise, measured.
const BARE = BOX.map((c) => ({ ...c, Labels: { ...c.Labels, 'dev.portal.group': undefined } }));
eq('with no labels, group is identity everywhere',
  merge([], [], BARE).every((n) => n.group === n.system), true);
eq('...and the ports table says the same',
  allPorts(BARE).every((p) => p.group === p.system), true);

// ── the accent, and the bookmark ────────────────────────────────────────────
//
// Both are keyed off identity so that regrouping costs neither. Silent failures:
// a card that changes colour is only noticed by someone hunting for it, and a
// bookmark is only noticed by whoever opens it.
console.log('\n── regrouping moves neither the colour nor the bookmark ─────────────');

eq('unregrouped: the accent seed is the key itself',
  primaryIdentity('postgres', ['postgres']), 'postgres');
eq('merged: it keeps a MEMBER\'s seed, not the new name',
  primaryIdentity('data', ['postgres', 'redis']), 'postgres');
eq('...chosen by sort, so a reshuffled poll cannot repaint it',
  primaryIdentity('data', ['redis', 'postgres']), 'redis');
eq('a group whose key is also a member keeps its own',
  primaryIdentity('postgres', ['postgres', 'redis']), 'postgres');
eq('no identities at all -> the key, never undefined',
  primaryIdentity('data', []), 'data');

const GROUPS = [
  { key: 'data', identities: ['postgres', 'redis'] },
  { key: 'monitoring', identities: ['monitoring'] },
];
eq('an untouched system resolves by key',
  findSystem(GROUPS, 'monitoring')?.key, 'monitoring');
eq('A BOOKMARK FROM BEFORE THE REGROUP still opens',
  findSystem(GROUPS, 'postgres')?.key, 'data');
eq('the other member of the merge does too',
  findSystem(GROUPS, 'redis')?.key, 'data');
eq('a name nobody has ever used is still null',
  findSystem(GROUPS, 'nonesuch'), null);

// The ambiguous case, decided rather than left to array order: if a display group
// is deliberately NAMED `postgres` while another still carries `postgres` as an
// identity, the name somebody chose wins.
eq('a deliberate name beats a leftover identity',
  findSystem(
    [{ key: 'x', identities: ['postgres'] }, { key: 'postgres', identities: ['pg'] }],
    'postgres',
  )?.key,
  'postgres',
);

console.log();
console.log(fails ? `${fails} check(s) FAILED` : 'all pass');
process.exit(fails ? 1 : 0);
