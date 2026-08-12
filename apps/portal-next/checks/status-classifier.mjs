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

import { statusOf } from './discover.mjs';

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
];

let bad = 0;
for (const [label, container, want] of cases) {
  const got = statusOf(container);
  if (got !== want) bad++;
  console.log(`${got === want ? 'PASS' : 'FAIL'}  ${label.padEnd(24)} want=${String(want).padEnd(8)} got=${got}`);
}
console.log(bad ? `\n${bad} FAILED` : '\nall pass');
process.exit(bad ? 1 : 0);
