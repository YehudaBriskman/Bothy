// Where does Bothy think it is checked out?
//
// This is the check for the two functions that replaced a hardcoded home
// directory. The failure they exist to prevent is silent in both directions and
// neither one raises: get the stack root wrong and every service in the stack is
// filed under "Projects"; get the config tier's root table wrong and every patch
// comes back "outside-roots" and blames the file.
//
// The cases that matter are the ones a second machine produces, which is exactly
// what could not be tested while the value was a literal:
//
//   * a repo checked out somewhere else entirely
//   * a sibling directory whose path is a PREFIX of this one
//   * no container mounting the repo at all (before the first `just up`)
//   * a service that mounts four roots vs one that mounts one
//
// Run from checks/run.sh, which compiles discover.ts next door.
import { stackRootFrom, repoRootsOf, classify } from './discover.mjs';

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} ${ok ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const bind = (Source, Destination) => ({ Type: 'bind', Source, Destination });
const svc = (service, mounts) => ({
  Labels: { 'com.docker.compose.service': service }, Mounts: mounts,
});

// ── the stack root ──────────────────────────────────────────────────────────
console.log('── the stack root, from whatever docker reports ─────────────────────');

eq('a checkout in someone else\'s home',
  stackRootFrom([svc('portal-files', [bind('/Users/ada/src/bothy', '/repos/stacks')])]),
  '/Users/ada/src/bothy/');

eq('a trailing slash is added, never doubled',
  stackRootFrom([svc('portal-files', [bind('/srv/bothy/', '/repos/stacks')])]),
  '/srv/bothy/');

eq('the config tier is an equally good witness',
  stackRootFrom([svc('bothy-config', [bind('/opt/bothy', '/repos/stacks')])]),
  '/opt/bothy/');

// The whole reason the value is not just "any bind mount": /repos/notes and
// /repos/home are mounted too, and either would be a plausible-looking answer.
eq('the OTHER repo mounts are not mistaken for it',
  stackRootFrom([svc('portal-files', [
    bind('/home/ada/claude-notes', '/repos/notes'),
    bind('/home/ada', '/repos/home'),
    bind('/home/ada/stacks', '/repos/stacks'),
  ])]),
  '/home/ada/stacks/');

eq('a NAMED VOLUME at the same destination is not a host path',
  stackRootFrom([{ Mounts: [{ Type: 'volume', Name: 'x', Source: '/var/lib/docker/volumes/x/_data', Destination: '/repos/stacks' }] }]),
  null);

eq('nothing mounts the repo -> null, not a guess',
  stackRootFrom([svc('traefik', [bind('/var/run/docker.sock', '/var/run/docker.sock')])]),
  null);

eq('no containers at all -> null',        stackRootFrom([]), null);
eq('called with nothing -> null',         stackRootFrom(), null);

// ── the prefix trap ─────────────────────────────────────────────────────────
//
// The single most likely way to get this wrong, and the reason asDir() exists:
// `/home/ada/stacks-old` starts with `/home/ada/stacks`. Without the trailing
// slash a second checkout beside the first is classified as part of it.
console.log('\n── a sibling checkout is not this one ───────────────────────────────');

const ROOT = stackRootFrom([svc('portal-files', [bind('/home/ada/stacks', '/repos/stacks')])]);
const inRepo = (cfg) => classify(
  { Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.project.config_files': cfg } },
  ROOT,
).groupKind;

eq('a file in this repo is stack',        inRepo('/home/ada/stacks/edge/compose.yml'), 'stack');
eq('a file in stacks-old is NOT',         inRepo('/home/ada/stacks-old/edge/compose.yml'), 'project');
eq('a file elsewhere is a project',       inRepo('/home/ada/projects/cvops/compose.yml'), 'project');

// ── what classify() does with null ──────────────────────────────────────────
//
// Asserted rather than left to a comment, because the honest fallback is not
// obvious: with no root, "does this live in the repo" cannot be answered, and
// answering "no" would file the whole stack as third-party. It answers 'stack'
// for everything and keeps recognising Bothy itself by project name, so the
// portal never misfiles the page you are reading while its file tier is down.
console.log('\n── with no root known, nothing is misfiled as third-party ───────────');

const noRoot = (proj, cfg) => classify(
  { Labels: { 'com.docker.compose.project': proj, 'com.docker.compose.project.config_files': cfg } },
  null,
).groupKind;

eq('a stack service stays stack',         noRoot('monitoring', '/anywhere/monitoring/compose.yml'), 'stack');
eq('Bothy is still recognised as infra',  noRoot('bothy', '/anywhere/apps/bothy/compose.yml'), 'infra');
eq('edge is still recognised as infra',   noRoot('edge', '/anywhere/edge/compose.yml'), 'infra');
eq('a container with no compose labels',  classify({ Labels: {} }, null).group, 'unmanaged');
eq('no container at all',                 classify(null, null).group, 'host');

// ── the config tier's root table ────────────────────────────────────────────
console.log('\n── one service\'s roots, and only that service\'s ──────────────────────');

const BOX = [
  svc('portal-files', [
    bind('/home/ada/stacks', '/repos/stacks'),
    bind('/home/ada/claude-notes', '/repos/notes'),
    bind('/home/ada/projects', '/repos/projects'),
    bind('/home/ada', '/repos/home'),
  ]),
  svc('bothy-config', [
    bind('/home/ada/stacks', '/repos/stacks'),
    bind('/home/ada/stacks/apps/bothy-config/audit', '/audit'),
  ]),
];

// THE POINT OF NAMING A SERVICE. bothy-config accepts exactly one root; the file
// tier mounts four. A shared table would offer `notes` and `projects` as patch
// targets and collect a 400 from the service for each.
eq('bothy-config declares only what IT mounts',
  repoRootsOf(BOX, 'bothy-config'), { stacks: '/home/ada/stacks/' });

eq('the file tier declares all four',
  repoRootsOf(BOX, 'portal-files'), {
    stacks: '/home/ada/stacks/',
    notes: '/home/ada/claude-notes/',
    projects: '/home/ada/projects/',
    home: '/home/ada/',
  });

eq('a mount outside /repos is not a root',
  Object.keys(repoRootsOf(BOX, 'bothy-config')).includes('audit'), false);

eq('a NESTED path under /repos is not a root name',
  repoRootsOf([svc('x', [bind('/a', '/repos/stacks/docs')])], 'x'), {});

eq('the service is not running -> empty, and that is handled',
  repoRootsOf(BOX, 'bothy-config-that-is-off'), {});

eq('no containers -> empty',              repoRootsOf([], 'bothy-config'), {});

console.log();
console.log(fails ? `${fails} check(s) FAILED` : 'all pass');
process.exit(fails ? 1 : 0);
