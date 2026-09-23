// Truth table for statusOf() - run with ./checks/run.sh
//
// This exists because the status classifier is the one piece of portal logic
// where being subtly wrong is invisible: every case still renders a coloured
// dot, so a misclassification looks like a working page reporting bad news. Two
// real bugs came out of exactly that:
//
//   1. every non-running container collapsed to 'down', so five deliberately
//      stopped containers rendered as five alerts, and
//   2. health was read BEFORE state, and a stopped container keeps a stale
//      `Health.Status: "unhealthy"` - so stopped containers WITH a healthcheck
//      (postgres, redis, garage) stayed "down" while a stopped nginx correctly
//      went "stopped". Half-fixed looks exactly like fixed on a screenshot.
//
// The narrowing of 'down' must never weaken it: the crash cases below are the
// ones that must keep alarming.
//
// A THIRD BUG, and the reason for the second half of this file (2026-09-23):
// `stopped` had in turn become a bag holding three unrelated facts - a service
// parked on purpose, a one-shot reporting success, and a container from a
// project nobody had run in six weeks. `done` and `dormant` split the last two
// out. Every boundary of the dormancy rule is pinned below, in both directions,
// because the failure mode of a threshold is not that it is wrong once: it is
// that it silences something and nobody notices for a fortnight.

import {
  statusOf, merge, exitedAgoSecs, livingProjects, projectKeyOf, DORMANT_AFTER_SECONDS,
} from './discover.mjs';

// merge() builds an open-this URL from `location.hostname` for any container
// with a published port. Browser global, node runtime - and none of the
// containers below publishes one, so without this stub the file would keep
// passing right up until somebody added a port to a fixture.
globalThis.location ??= { hostname: 'box.example' };

const DAY = 86_400;

// Shorthands for the two whole-list facts statusOf() cannot read off one
// container. `undefined` for either is NOT the same as `false` - see the
// "absence of evidence" rows.
const ONESHOT = { oneShot: true };
const ALIVE = { projectAlive: true };
const ABANDONED = { projectAlive: false };
const ONESHOT_ABANDONED = { oneShot: true, projectAlive: false };

const cases = [
  ['running + healthy',       { State: 'running', Status: 'Up 3 hours (healthy)', Health: { Status: 'healthy' } },      'up'],
  ['running + UNHEALTHY',     { State: 'running', Status: 'Up 3 hours (unhealthy)', Health: { Status: 'unhealthy' } },  'down'],
  ['running + starting',      { State: 'running', Status: 'Up 3s (health: starting)', Health: { Status: 'starting' } }, 'starting'],
  ['running, no healthcheck', { State: 'running', Status: 'Up 2 days' },                                               'up'],
  ['OOM-killed (137)',        { State: 'exited',  Status: 'Exited (137) 2 minutes ago' },                               'down'],
  ['crashed (1)',             { State: 'exited',  Status: 'Exited (1) 5 seconds ago' },                                 'down'],
  ['crash loop',              { State: 'restarting', Status: 'Restarting (1) 3 seconds ago' },                          'down'],
  ['dead',                    { State: 'dead',    Status: 'Dead' },                                                     'down'],
  ['stopped cleanly',         { State: 'exited',  Status: 'Exited (0) 34 minutes ago' },                                'stopped'],
  // 143 = 128+SIGTERM: `docker stop` on anything that dies from the signal
  // rather than handling it (any JVM - Keycloak is the live example). A clean
  // stop, and the reason a stopped project used to read as broken.
  ['stopped by SIGTERM (143)', { State: 'exited', Status: 'Exited (143) 4 minutes ago' },                               'stopped'],
  // 137 stays `down` here on purpose: it is also the OOM-kill code, and
  // /containers/json has no OOMKilled field to separate the two (see case above).
  ['stopped w/ stale health', { State: 'exited',  Status: 'Exited (0) 1 hour ago', Health: { Status: 'unhealthy' } },    'stopped'],
  ['never started',           { State: 'created', Status: 'Created' },                                                  'stopped'],
  ['paused by hand',          { State: 'paused',  Status: 'Up 2 hours (Paused)' },                                      'stopped'],
  ['unreadable exit',         { State: 'exited',  Status: 'weird' },                                                    'unknown'],

  // ── done: a one-shot that ran to completion ───────────────────────────────
  //
  // `oneShot` is the compose `service_completed_successfully` idiom read off a
  // SIBLING's depends_on. It is the only declaration of "this finishes" that
  // reaches the browser: /containers/json's whole HostConfig is {NetworkMode},
  // so `restart: "no"` is invisible, and `Created` is creation rather than
  // start, so there is no lifetime to measure either. See StatusContext.
  ['one-shot, exited 0 an hour ago',   { State: 'exited', Status: 'Exited (0) About an hour ago' }, 'done',    ONESHOT],
  ['one-shot, exited 0 4 days ago',    { State: 'exited', Status: 'Exited (0) 4 days ago' },        'done',    ONESHOT],
  // AGE DOES NOT MAKE `done` LESS TRUE, and that is the ordering decision.
  // `dormant` is a claim about something that was supposed to keep running;
  // applying it to a task that was never supposed to keep running is a category
  // error, so `done` is tested first and wins even when both would match.
  ['one-shot, exited 0 SIX WEEKS ago, project dead',
    { State: 'exited', Status: 'Exited (0) 6 weeks ago' },                                          'done',    ONESHOT_ABANDONED],
  // The one-shot did NOT complete - somebody stopped it mid-run. `done` would be
  // a lie, and the hand-written "completed" chip this replaced told exactly that
  // lie for two years.
  ['one-shot KILLED by SIGTERM (143)', { State: 'exited', Status: 'Exited (143) 4 minutes ago' },   'stopped', ONESHOT],
  ['one-shot that FAILED (1)',         { State: 'exited', Status: 'Exited (1) 4 minutes ago' },     'down',    ONESHOT],
  // Nothing declared it, so nothing claims it finished. This is `keycloak-init`
  // on the live box: an init container in every other respect, and
  // indistinguishable from a hand-stopped service in everything the API returns.
  ['exited 0, NOT declared a one-shot', { State: 'exited', Status: 'Exited (0) 5 hours ago' },      'stopped', ALIVE],

  // ── dormant: old AND abandoned, never one without the other ───────────────
  ['exited 0 six weeks ago, project dead',
    { State: 'exited', Status: 'Exited (0) 6 weeks ago' },                                          'dormant', ABANDONED],
  ['exited 0 four weeks ago, project dead (cvops)',
    { State: 'exited', Status: 'Exited (0) 4 weeks ago' },                                          'dormant', ABANDONED],
  // THE RULE THAT MUST NOT WEAKEN. A non-zero exit is dormant only because of
  // its AGE and its dead project, never because "it failed a while ago so it
  // probably does not matter". These two differ in nothing but when.
  ['crash (255) six weeks ago, project dead',
    { State: 'exited', Status: 'Exited (255) 6 weeks ago' },                                        'dormant', ABANDONED],
  ['crash (255) FIVE MINUTES ago, project dead - still an alarm',
    { State: 'exited', Status: 'Exited (255) 5 minutes ago' },                                      'down',    ABANDONED],
  ['crash (1) five minutes ago, project alive',
    { State: 'exited', Status: 'Exited (1) 5 minutes ago' },                                        'down',    ALIVE],
  // A sibling is up, so nothing has been put away: prometheus and promtail, the
  // monitoring rollback profiles, are this row.
  ['exited 0 six days ago, siblings RUNNING (prometheus)',
    { State: 'exited', Status: 'Exited (0) 6 days ago' },                                           'stopped', ALIVE],
  ['exited 0 SIX WEEKS ago, siblings RUNNING - age alone is not enough',
    { State: 'exited', Status: 'Exited (0) 6 weeks ago' },                                          'stopped', ALIVE],
  // Absence of evidence is not evidence of abandonment: a caller that did not
  // resolve the whole-list fact must never get `dormant` by default.
  ['exited 0 six weeks ago, project liveness UNKNOWN',
    { State: 'exited', Status: 'Exited (0) 6 weeks ago' },                                          'stopped'],
  ['crash (255) six weeks ago, project liveness UNKNOWN',
    { State: 'exited', Status: 'Exited (255) 6 weeks ago' },                                        'down'],
  // The threshold itself, from both sides. 14 days exactly is dormant; one day
  // under is not.
  ['exited 0 exactly 14 days ago, project dead',
    { State: 'exited', Status: 'Exited (0) 14 days ago' },                                          'dormant', ABANDONED],
  ['exited 0 13 days ago, project dead',
    { State: 'exited', Status: 'Exited (0) 13 days ago' },                                          'stopped', ABANDONED],
  ['exited 0 2 weeks ago, project dead',
    { State: 'exited', Status: 'Exited (0) 2 weeks ago' },                                          'dormant', ABANDONED],
  // No elapsed time in the string means no evidence of age, so no dormancy -
  // whatever the project is doing.
  ['created, never started, project dead',   { State: 'created', Status: 'Created' },               'stopped', ABANDONED],
  ['paused by hand, project dead',           { State: 'paused',  Status: 'Up 2 hours (Paused)' },   'stopped', ABANDONED],
  // A crash loop is happening NOW by definition, and livingProjects() counts
  // `restarting` as alive precisely so its siblings are not hushed either.
  ['crash loop in a dead project',           { State: 'restarting', Status: 'Restarting (1) 3 seconds ago' }, 'down', ABANDONED],
  ['unreadable exit, old and abandoned',     { State: 'exited', Status: 'weird' },                  'unknown', ABANDONED],
];

let bad = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  want=${JSON.stringify(want)} got=${JSON.stringify(got)}`}`);
};

for (const [label, container, want, ctx] of cases) {
  const got = statusOf(container, undefined, ctx);
  if (got !== want) bad++;
  console.log(`${got === want ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} want=${String(want).padEnd(8)} got=${got}`);
}

// ── the clock the dormancy rule reads ────────────────────────────────────────
// docker formats this half of the Status string with the same helper it uses for
// "Up …", so the grammars have to stay in step; these are the forms seen on this
// box plus the two irregular ones go-units emits.
console.log('');
for (const [text, want] of [
  ['Exited (0) 6 weeks ago', 42 * DAY],
  ['Exited (255) 4 weeks ago', 28 * DAY],
  ['Exited (0) 4 days ago', 4 * DAY],
  ['Exited (0) 5 hours ago', 5 * 3600],
  ['Exited (0) About an hour ago', 3600],
  ['Exited (0) About a minute ago', 60],
  ['Exited (143) 34 minutes ago', 34 * 60],
  ['Exited (0) 2 months ago', 2 * 2_592_000],
  // Not an exit line, or not parseable: null, never 0. A 0 would read as "it
  // stopped just now" and keep a six-week-old corpse out of `dormant` forever.
  ['Up 3 days', null],
  ['Created', null],
  ['Restarting (1) 3 seconds ago', null],
  ['Exited (0) ages ago', null],
  [undefined, null],
]) check(`exitedAgoSecs(${JSON.stringify(text)})`, exitedAgoSecs(text), want);

check('DORMANT_AFTER_SECONDS is a fortnight', DORMANT_AFTER_SECONDS, 14 * DAY);

// ── who counts as a sibling ──────────────────────────────────────────────────
console.log('');
const ctr = (id, project, state) => ({
  Id: id, Names: [`/${id}`], State: state,
  Labels: project ? { 'com.docker.compose.project': project } : {},
});

check('a compose container is keyed by its project',
  projectKeyOf(ctr('a', 'cvops', 'exited')), 'cvops');
// The one that matters: `thales-scc` (running) and `mpeg-redis` (dead six weeks)
// are both `docker run`. Keyed together, the live one would vouch for the dead
// one and no bare container could ever be dormant.
check('a bare `docker run` container is its own project of one',
  projectKeyOf(ctr('abc', null, 'exited')), 'container:abc');

check('a project with one container up is alive',
  [...livingProjects([ctr('a', 'p', 'exited'), ctr('b', 'p', 'running')])], ['p']);
check('a project whose every container has exited is not',
  [...livingProjects([ctr('a', 'p', 'exited'), ctr('b', 'p', 'exited')])], []);
check('a crash-looping container keeps its project alive',
  [...livingProjects([ctr('a', 'p', 'restarting')])], ['p']);
check('two unlabelled containers never vouch for each other',
  [...livingProjects([ctr('live', null, 'running'), ctr('old', null, 'exited')])], ['container:live']);

// ── the whole-list facts actually REACH the classifier ───────────────────────
//
// statusOf() is pure and takes the facts as arguments, so every row above passes
// whether or not merge() bothers to resolve them. This is the wire: the same
// three containers, classified the way the app classifies them, from nothing but
// a container list.
console.log('');
const exited = (name, project, service, status, extra = {}) => ({
  Id: name, Names: [`/${name}`], State: 'exited', Status: status,
  Labels: {
    'com.docker.compose.project': project,
    'com.docker.compose.service': service,
    ...extra,
  },
});
const running = (name, project, service, dependsOn) => ({
  Id: name, Names: [`/${name}`], State: 'running', Status: 'Up 2 days',
  Labels: {
    'com.docker.compose.project': project,
    'com.docker.compose.service': service,
    ...(dependsOn ? { 'com.docker.compose.depends_on': dependsOn } : {}),
  },
});

const world = [
  // auth: keycloak is up and waits on db-init having COMPLETED.
  running('keycloak', 'auth', 'keycloak', 'keycloak-db-init:service_completed_successfully:false'),
  exited('keycloak-db-init', 'auth', 'keycloak-db-init', 'Exited (0) 4 days ago'),
  // monitoring: parked on purpose, with live siblings.
  running('grafana', 'monitoring', 'grafana'),
  exited('prometheus', 'monitoring', 'prometheus', 'Exited (0) 6 days ago'),
  // cvops: nothing left running.
  exited('cvops-postgres-1', 'cvops', 'postgres', 'Exited (0) 4 weeks ago'),
  exited('cvops-nginx-1', 'cvops', 'nginx', 'Exited (0) 4 weeks ago'),
  // an untidy exit in the same dead project, and the same exit today.
  exited('old-crash', 'gone', 'x', 'Exited (255) 6 weeks ago'),
  exited('fresh-crash', 'gone', 'y', 'Exited (255) 4 minutes ago'),
];
const byName = Object.fromEntries(
  merge([], [], world).map((n) => [n.container?.name, n.status]),
);
check('merge: a declared one-shot lands on done', byName['keycloak-db-init'], 'done');
check('merge: a parked service with live siblings stays off', byName.prometheus, 'stopped');
check('merge: a four-week-old container in a dead project is dormant', byName['cvops-postgres-1'], 'dormant');
check('merge: and so is its sibling', byName['cvops-nginx-1'], 'dormant');
check('merge: a six-week-old crash is dormant', byName['old-crash'], 'dormant');
check('merge: a four-minute-old crash in the SAME dead project still shouts',
  byName['fresh-crash'], 'down');
check('merge: the running ones are up', [byName.keycloak, byName.grafana], ['up', 'up']);

console.log(bad ? `\n${bad} FAILED` : '\nall pass');
process.exit(bad ? 1 : 0);
