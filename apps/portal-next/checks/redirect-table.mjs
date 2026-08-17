// The redirect table - run with ./checks/run.sh
//
// WHY THIS EXISTS. Services, Access and Topology moved under /control, and every
// URL they had before is a <Navigate replace>. Those redirects are the only
// thing keeping a year of links in notes, chat and browser bookmarks alive, and
// they have the worst failure mode in the app: a redirect that lands wrong still
// answers 200 and still renders a plausible page, so nobody reports it. Nothing
// on screen distinguishes "your bookmark worked" from "your bookmark quietly
// took you somewhere else".
//
// The half that CANNOT drift is already handled in code: App.tsx builds its
// legacy routes by mapping over LEGACY_PATHS, so the router and the table always
// agree about which URLs are covered. What this asserts is the other half -
// where each one lands, that the query string is carried, and that no target is
// a path the app does not serve. That last one is the check that would have
// caught the whole section being renamed while the redirects still pointed at
// the old name.

import { LEGACY_PATHS, LIVE_PATHS, legacyTarget } from './redirects.mjs';

let bad = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)}${ok ? '' : ` want=${JSON.stringify(want)} got=${JSON.stringify(got)}`}`);
};

console.log('── every retired URL lands on its new one ──────────────');

// The table from docs/plans/control-and-settings.md §3, written out longhand.
// Deliberately NOT derived from the module under test: a check that computes its
// expectation the same way the code does asserts nothing.
const TABLE = [
  ['/services', '', '/control/services'],
  ['/services/portal-next', '', '/control/services/portal-next'],
  ['/systems/monitoring', '', '/control/systems/monitoring'],
  ['/topology', '', '/control/topology'],
  ['/ports', '', '/control/ports'],
  ['/routes', '', '/control/routes'],
  // /access defaulted to Routes in the code (`isTab(raw) ? raw : 'routes'`),
  // whatever the plan document says. A bookmark must land where it landed.
  ['/access', '', '/control/routes'],
  ['/access', '?tab=routes', '/control/routes'],
  ['/access', '?tab=ports', '/control/ports'],
];
for (const [path, search, want] of TABLE) {
  check(`${path}${search}`, legacyTarget(path, search), want);
}

console.log('\n── the query string is not dropped ─────────────────────');

// The one that matters: ?tab=ports and ?tab=routes must not collapse to the same
// place. If they ever do, half the shared /access links are silently wrong.
check('?tab=ports and ?tab=routes differ',
  legacyTarget('/access', '?tab=ports') !== legacyTarget('/access', '?tab=routes'), true);
// A leading '?' is optional - location.search carries one, a hand-written test
// or a URL object's query may not.
check('search works with or without the leading ?',
  legacyTarget('/access', 'tab=ports'), '/control/ports');
// Other parameters ride along without confusing the lookup.
check('an unrelated parameter is ignored',
  legacyTarget('/access', '?q=redis&tab=ports'), '/control/ports');
// An unrecognised tab falls back the way the page itself did, rather than
// resolving to nothing and dumping the reader on the not-found page.
check('an unknown tab falls back to Routes',
  legacyTarget('/access', '?tab=nonsense'), '/control/routes');

console.log('\n── every registered legacy route resolves ──────────────');

// App.tsx maps over LEGACY_PATHS to build the routes. A path in that list with
// no mapping renders <NotFound> at a URL we promised to keep - the exact
// bookmark break this file exists to prevent.
const sample = (p) => '/' + p.replace(':id', 'x').replace(':name', 'y');
for (const p of LEGACY_PATHS) {
  const to = legacyTarget(sample(p));
  check(`${p} -> something`, typeof to === 'string' && to.startsWith('/control'), true);
}

console.log('\n── no redirect points at a page we do not serve ────────');

// Compare against the shapes the router registers, with the params put back.
const shape = (path) =>
  path.replace(/^\/control\/services\/[^/]+$/, '/control/services/:id')
      .replace(/^\/control\/systems\/[^/]+$/, '/control/systems/:name');
const live = new Set(LIVE_PATHS);
for (const [path, search] of TABLE) {
  const to = legacyTarget(path, search);
  check(`${to} is a live route`, live.has(shape(to)), true);
}

console.log('\n── a path that was never ours is left alone ────────────');

// legacyTarget must return null rather than inventing /control/<anything>, or
// every typo'd URL would redirect to a made-up page instead of reaching the
// not-found page that tells the reader the link is broken.
for (const p of ['/', '/files', '/settings', '/control', '/control/ports', '/nonsense', '/servicesss']) {
  check(`${p} is not a redirect`, legacyTarget(p), null);
}
// The trailing slash a pasted link often carries is the same page, not a miss.
check('/services/ resolves like /services', legacyTarget('/services/'), '/control/services');
// Percent-encoding is passed through untouched: lib/links.ts encodes on the way
// out, and decoding here to re-encode there is how a name with a slash in it
// stops resolving.
check('an encoded id survives',
  legacyTarget('/services/edge%2Ftraefik'), '/control/services/edge%2Ftraefik');

console.log(bad ? `\n${bad} FAILED` : '\nall pass');
process.exit(bad ? 1 : 0);
