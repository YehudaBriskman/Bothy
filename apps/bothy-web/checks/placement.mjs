// Section / subgroup placement - who decides where a group is SHOWN.
//
// Three sources, one order: the central placement file (placement.yml, shipped
// in projects.json) beats a container's `dev.portal.section`/`.subgroup` labels,
// which beat the default derived from groupKind. Every failure here is silent -
// a card simply lands under the wrong heading - so the order is a truth table
// rather than a sentence in a comment.
//
// And the promise that makes the feature safe to ship: with NO file, nothing
// that existed before moves. Asserted below, not assumed.
//
// Run from checks/run.sh, which compiles discover.ts and projects.ts next door.
import {
  classify, merge, allPorts, placeOf, resolvePlacement, defaultPlacement, findPlacementRule,
} from './discover.mjs';
import { withDeclared } from './projects-mod.mjs';

globalThis.location ??= { hostname: 'checks.invalid' };

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} ${ok ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const ROOT = '/srv/box/stacks/';
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
  Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 9000, Type: 'tcp' }],
});
const pick = ({ section, subgroup, placedBy }) => [section, subgroup, placedBy];

// ── the precedence, as a truth table ────────────────────────────────────────
console.log('── file > label > default, per field ────────────────────────────────');

const D = { section: 'projects', subgroup: null };
const DI = { section: 'bothy', subgroup: 'core' };
const T = [
  // label                                  file            label             default  -> section, subgroup, by
  ['nothing set: the default',               null,           null,             DI,  ['bothy', 'core', 'default']],
  ['label section beats default',            null,           { section: 'x' }, DI,  ['x', null, 'label']],
  ['...and drops the default\'s subgroup',   null,           { section: 'x' }, DI,  ['x', null, 'label']],
  ['label section + subgroup',               null,           { section: 'x', subgroup: 'y' }, DI, ['x', 'y', 'label']],
  ['label subgroup only: default section',   null,           { subgroup: 'y' }, DI, ['bothy', 'y', 'label']],
  ['file beats label',                       { section: 'f' }, { section: 'x', subgroup: 'y' }, DI, ['f', null, 'file']],
  ['file beats default',                     { section: 'f', subgroup: 'g' }, null, DI, ['f', 'g', 'file']],
  ['file subgroup, label section',           { subgroup: 'g' }, { section: 'x' }, DI, ['x', 'g', 'file']],
  ['file section = label section: label sub kept', { section: 'x' }, { section: 'x', subgroup: 'y' }, D, ['x', 'y', 'file']],
  ['file section = default section: default sub kept', { section: 'bothy' }, null, DI, ['bothy', 'core', 'file']],
  ['file moves to projects: default sub dropped', { section: 'projects' }, null, DI, ['projects', null, 'file']],
  ['empty strings count as unset',           { section: '', subgroup: '' }, { section: '' }, DI, ['bothy', 'core', 'default']],
];
for (const [label, file, lab, def, want] of T) eq(label, pick(resolvePlacement(file, lab, def)), want);

console.log('\n── the default is derived from the kind ─────────────────────────────');
eq('infra -> bothy/core',            defaultPlacement('infra', 'edge'), { section: 'bothy', subgroup: 'core' });
eq('stack -> bothy/helpers',         defaultPlacement('stack', 'monitoring'), { section: 'bothy', subgroup: 'helpers' });
eq('project -> projects',            defaultPlacement('project', 'tals'), { section: 'projects', subgroup: null });
eq('a kind nobody knows -> projects', defaultPlacement('cluster', 'x'), { section: 'projects', subgroup: null });
// classify() calls a container with no compose labels `unmanaged`/infra. It is
// the remainder, not Bothy - `docker run` leftovers and minikube.
eq('residue `unmanaged` is NOT Bothy', defaultPlacement('infra', 'unmanaged'), { section: 'projects', subgroup: null });
eq('residue `host` is NOT Bothy',      defaultPlacement('project', 'host'), { section: 'projects', subgroup: null });

console.log('\n── which rule in the file matches ───────────────────────────────────');
const FILE = {
  rules: [
    { match: ['project:auth'], section: 'bothy', subgroup: 'core' },
    { match: ['container:sonar', 'container:sonar-db'], section: 'bothy', subgroup: 'helpers', group: 'sonarqube', title: 'SonarQube' },
    { match: ['project:manifests'], section: 'elsewhere' },
    { match: ['project:auth'], section: 'second-rule-never-wins' },
    { match: ['k8s:thales-dev'], section: 'projects', subgroup: 'cluster' },
  ],
};
eq('by compose project',            findPlacementRule(FILE, { project: 'auth' })?.section, 'bothy');
eq('first rule of a kind wins',     findPlacementRule(FILE, { project: 'auth' })?.section, 'bothy');
eq('container beats its project',   findPlacementRule(FILE, { container: 'sonar', project: 'manifests' })?.title, 'SonarQube');
eq('...its sibling still gets the project rule',
  findPlacementRule(FILE, { container: 'thales-postgres-local', project: 'manifests' })?.section, 'elsewhere');
eq('by k8s namespace',              findPlacementRule(FILE, { namespace: 'thales-dev' })?.subgroup, 'cluster');
eq('a namespace is not a project',  findPlacementRule(FILE, { project: 'thales-dev' }), null);
eq('no match -> null',              findPlacementRule(FILE, { container: 'grafana', project: 'monitoring' }), null);
eq('no file -> null',               findPlacementRule(null, { project: 'auth' }), null);
eq('a rule with no match list is inert', findPlacementRule({ rules: [{ section: 'x' }] }, { project: 'auth' }), null);

// ── through classify(), the one place it is applied ─────────────────────────
console.log('\n── classify() applies it, and a missing file changes nothing ────────');

const BOX = [
  ctr('edge', `${ROOT}edge/compose.yml`, {}, 'traefik'),
  ctr('bothy', `${ROOT}apps/bothy/compose.yml`, {}, 'portal-next'),
  ctr('bothy-web', `${ROOT}apps/bothy-web/compose.yml`, {}, 'bothy-web'),
  ctr('auth', `${ROOT}auth/compose.yml`, {}, 'keycloak'),
  ctr('monitoring', `${ROOT}monitoring/compose.yml`, {}, 'grafana'),
  ctr('manifests', '/srv/box/projects/Tals/manifests/compose.yml', {}, 'sonar'),
  ctr('manifests', '/srv/box/projects/Tals/manifests/compose.yml', {}, 'thales-postgres-local'),
  ctr('cvops', '/srv/box/projects/cvops/compose.yml', {}, 'cvops-nginx-1'),
  { Id: 'id-orphan', Names: ['/reverent_darwin'], Labels: {} },
];
const cls = (c, p) => classify(c, ROOT, null, p);
const byName = (list, p) => Object.fromEntries(list.map((c) => {
  const k = cls(c, p);
  return [c.Names[0].slice(1), [k.section, k.subgroup, k.placedBy]];
}));

eq('no file: the derived layout', byName(BOX, null), {
  traefik: ['bothy', 'core', 'default'],
  'portal-next': ['bothy', 'core', 'default'],
  'bothy-web': ['bothy', 'core', 'default'],
  keycloak: ['bothy', 'helpers', 'default'],
  grafana: ['bothy', 'helpers', 'default'],
  sonar: ['projects', null, 'default'],
  'thales-postgres-local': ['projects', null, 'default'],
  'cvops-nginx-1': ['projects', null, 'default'],
  reverent_darwin: ['projects', null, 'default'],
});
const FILE2 = { rules: FILE.rules.filter((r) => r.section !== 'elsewhere') };
eq('with the file: auth and SonarQube move, nothing else', byName(BOX, FILE2), {
  traefik: ['bothy', 'core', 'default'],
  'portal-next': ['bothy', 'core', 'default'],
  'bothy-web': ['bothy', 'core', 'default'],
  keycloak: ['bothy', 'core', 'file'],
  grafana: ['bothy', 'helpers', 'default'],
  sonar: ['bothy', 'helpers', 'file'],
  'thales-postgres-local': ['projects', null, 'default'],
  'cvops-nginx-1': ['projects', null, 'default'],
  reverent_darwin: ['projects', null, 'default'],
});

const strip = ({ section, subgroup, placedBy, placedTitle, ...rest }) => rest;
eq('no file: system/group/groupKind are exactly what they were',
  BOX.map((c) => strip(cls(c, null))), BOX.map((c) => strip(classify(c, ROOT))));
eq('an EMPTY file is the same as no file',
  BOX.map((c) => cls(c, { rules: [] })), BOX.map((c) => cls(c, null)));
eq('the file never changes groupKind',
  BOX.map((c) => cls(c, FILE2).groupKind), BOX.map((c) => cls(c, null).groupKind));

const labelled = ctr('monitoring', `${ROOT}monitoring/compose.yml`,
  { 'dev.portal.section': 'observability', 'dev.portal.subgroup': 'metrics' }, 'prometheus');
eq('a label moves it when the file is silent', pick(cls(labelled, FILE2)), ['observability', 'metrics', 'label']);
eq('the file beats that label',
  pick(cls(labelled, { rules: [{ match: ['container:prometheus'], section: 'bothy', subgroup: 'helpers' }] })),
  ['bothy', 'helpers', 'file']);
eq('dev.portal.groupKind still feeds the default',
  pick(cls(ctr('monitoring', `${ROOT}monitoring/compose.yml`, { 'dev.portal.groupKind': 'infra' }, 'x'), null)),
  ['bothy', 'core', 'default']);

const sonar = cls(BOX[5], FILE2);
eq('file `group` moves the display group',   sonar.group, 'sonarqube');
eq('...and not the identity',                 sonar.system, 'manifests');
eq('file `group` beats dev.portal.group',
  cls(ctr('manifests', '/p/compose.yml', { 'dev.portal.group': 'labelled' }, 'sonar'), FILE2).group, 'sonarqube');

console.log('\n── nodes, ports and declared projects agree ─────────────────────────');
const nodes = merge([], [], BOX, FILE2);
const sonarNode = nodes.find((n) => n.container?.name === 'sonar');
eq('merge(): the file title names the group',  sonarNode.groupTitle, 'SonarQube');
eq('merge(): the node carries its placement',  pick(sonarNode), ['bothy', 'helpers', 'file']);
const ports = allPorts(BOX, FILE2);
eq('allPorts(): the port row is in the same group',
  ports.find((p) => p.container === 'sonar')?.group, 'sonarqube');
eq('merge() with no file = merge() before placement',
  merge([], [], BOX).map((n) => [n.group, n.groupTitle]), merge([], [], BOX, null).map((n) => [n.group, n.groupTitle]));

const PROJECTS = [
  { key: 'thales', name: 'Thales', kind: 'project', state: 'live',
    services: [{ name: 'postgres', container: 'thales-postgres-local', state: 'up' }] },
  { key: 'k8s-scc-thales-dev', name: 'thales-dev (scc)', kind: 'cluster', namespace: 'thales-dev', state: 'live',
    services: [{ name: 'backend', state: 'up' }] },
  { key: 'mgmt', name: 'Mgmt', kind: 'stack', state: 'live', services: [{ name: 'ui', state: 'up' }] },
  { key: 'gate', name: 'Gate', kind: 'infra', state: 'live', services: [{ name: 'gw', state: 'up' }] },
];
const place = (p) => (subject, kind, system) => placeOf(p, subject, {}, kind, system);
const declared = (p, fn) => Object.fromEntries(
  withDeclared([], PROJECTS, fn).map((n) => [n.system, [n.section, n.subgroup, n.placedBy]]));

// projects.ts cannot import discover.ts at runtime, so it carries its own copy
// of the no-file default. This is the check that the copy has not drifted.
eq('projects.ts fallback = discover.ts default, every kind',
  declared(null, undefined), declared(null, place(null)));
eq('declared, no file', declared(null, place(null)), {
  thales: ['projects', null, 'default'],
  'k8s-scc-thales-dev': ['projects', null, 'default'],
  mgmt: ['bothy', 'helpers', 'default'],
  gate: ['bothy', 'core', 'default'],
});
eq('k8s:<namespace> places a cluster project',
  declared(FILE, place(FILE))['k8s-scc-thales-dev'], ['projects', 'cluster', 'file']);
eq('a declared container matches container: rules',
  declared({ rules: [{ match: ['container:thales-postgres-local'], section: 'data' }] },
    place({ rules: [{ match: ['container:thales-postgres-local'], section: 'data' }] })).thales,
  ['data', null, 'file']);

console.log();
console.log(fails ? `${fails} check(s) FAILED` : 'all pass');
process.exit(fails ? 1 : 0);
