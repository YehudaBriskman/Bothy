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
import { EDIT_PATH, READ_PATH, defaultRoot, filesHref, filesMode, filesTarget } from './files-routes.mjs';

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

console.log('\n── Files: one nav entry, two destinations ──────────────');

// WHY THIS IS IN THE SAME FILE as the redirects. It is the same defect with a
// different cause: a URL that resolves, answers 200, renders a plausible page,
// and is not the page the link meant. `/files` used to be the IDE and is now the
// reader, `/files/edit` is the IDE, and BOTH carry `?root=&path=` so that every
// deep link written before the split opens the same document in either. There is
// nothing on screen that distinguishes "your link opened your document" from
// "your link opened the reader's empty state", which is exactly the property
// that makes this worth a truth table rather than a glance.
//
// The expectations are written longhand and NOT derived from the module: a check
// that computes its answer the same way the code does asserts nothing.

check('/files is the reader', filesMode('/files'), 'read');
check('/files/edit is the editor', filesMode('/files/edit'), 'edit');
// `/files` is a PREFIX of `/files/edit`, so an order-sensitive implementation
// gets this wrong in a way that sends every Edit click to the reader.
check('/files/edit is not matched as /files', filesMode('/files/edit') !== 'read', true);
// A pasted link often carries a trailing slash. Same page.
check('/files/ resolves', filesMode('/files/'), 'read');
check('/files/edit/ resolves', filesMode('/files/edit/'), 'edit');
// A near miss must be nothing at all rather than the reader, or a typo renders
// a document index instead of the not-found page that says the link is broken.
for (const p of ['/', '/filesx', '/files/editx', '/files/edit/x', '/control', '/settings']) {
  check(`${p} is not a Files route`, filesMode(p), null);
}

console.log('\n── ?root= and ?path= survive both modes ────────────────');

// The pair that has to hold in both directions: a URL built for one mode, parsed
// back, is the same document. A builder that drops `path` passes every test that
// only looks at the pathname.
const DOCS = [
  ['stacks', 'docs/plans/reading-first.md'],
  ['notes', 'network/dns.md'],
  // A space and a hash in a filename - both are legal on disk, and both break a
  // hand-rolled query string. The hash matters twice over here: main.tsx mounts
  // a HashRouter, so a raw `#` in a value would truncate the whole route.
  ['projects', 'a folder/a file #2.md'],
  ['home', 'x.md'],
];
for (const mode of ['read', 'edit']) {
  for (const [root, path] of DOCS) {
    const href = filesHref(mode, root, path);
    const [p, s] = href.split('?');
    check(`${mode}: ${root}/${path} round-trips`,
      filesTarget(p, s), { mode, root, path });
    check(`${mode}: ${path} carries no bare #`, href.includes('#'), false);
  }
}
// The reader with nothing open still names its root, so a reload lands on the
// same index rather than on the first root in the list.
check('a root with no path keeps the root',
  filesTarget(...filesHref('read', 'notes').split('?')), { mode: 'read', root: 'notes', path: '' });
// A bare /files is legal - it is what the nav entry links to.
check('a bare /files parses', filesTarget('/files'), { mode: 'read', root: '', path: '' });
// The two modes must produce DIFFERENT urls for the same document, or the Edit
// button is a link to the page it is already on.
check('the two modes differ',
  filesHref('read', 'stacks', 'a.md') !== filesHref('edit', 'stacks', 'a.md'), true);

console.log('\n── a link with no root lands somewhere worth reading ───');

// THE SAME DEFECT ONE MORE TIME: a page that answers 200 and renders a
// plausible listing that is not the one anybody wanted. `/files` and
// `/files/edit` both have to choose a root when the URL names none (or names one
// that no longer exists), and for a year the IDE chose `r.roots[0]`.
//
// That is not a neutral choice. The service returns roots ALPHABETICALLY, and on
// this box `/roots` answers home, notes, projects, stacks - so roots[0] is
// `home`, the one root that is read-only, holds ~4,000 entries, and carries
// `aliases = true` in apps/portal-files/policy.toml. Opening the IDE meant
// seeing every document twice, and the second copy under a root that refuses
// writes. Nothing on screen says "you are in the aliasing root".
//
// Expectations are written longhand and NOT derived from the module.

// The shape this box really returns, verified against the live service. `notes`
// is the answer: first root that is not read-only, not first root.
const REAL_ROOTS = [
  { key: 'home', readOnly: true },
  { key: 'notes', readOnly: false },
  { key: 'projects', readOnly: true },
  { key: 'stacks', readOnly: false },
];
check('this box: home,notes,projects,stacks -> notes', defaultRoot(REAL_ROOTS), 'notes');
// Stated separately, because it is the whole bug: the answer must not be the
// alphabetically-first root just because the list arrives sorted.
check('the alphabetically first root is not the answer',
  defaultRoot(REAL_ROOTS) !== REAL_ROOTS[0].key, true);

// ABSENT `readOnly` MEANS WRITABLE. The field is optional in FileRoot and the
// service sends it explicitly on every root today - but the declared type and
// the wire shape have already drifted apart once (`label` and `writableSuffixes`
// are declared and never sent). If a root ever arrives without the field, it has
// to read as writable: the alternative spelling would call every root read-only
// and drop the whole box back on `home`, which is precisely the bug.
check('a root with no readOnly field is writable',
  defaultRoot([{ key: 'home', readOnly: true }, { key: 'notes' }]), 'notes');
check('all fields absent -> the first is fine',
  defaultRoot([{ key: 'notes' }, { key: 'stacks' }]), 'notes');

// Nothing writable anywhere - a viewer-only mount, or policy.toml with every
// `writable = false`. A read-only listing beats an empty page, so it falls back
// to the first root rather than returning undefined and rendering `?root=`
// with the string "undefined" in it.
check('every root read-only -> the first one',
  defaultRoot([{ key: 'home', readOnly: true }, { key: 'projects', readOnly: true }]), 'home');

// One root, and it is writable: no fallback logic gets a say.
check('a single writable root', defaultRoot([{ key: 'notes', readOnly: false }]), 'notes');

// THE CONTRACT FOR NOTHING AT ALL. `/roots` can answer `{"roots":[]}` - a
// misconfigured policy.toml, or a mount that is not there yet - and this runs
// inside a `.then()` whose rejection path is the sign-in card. Throwing would
// tell a signed-in visitor to sign in, so it returns '' and filesHref renders a
// bare `/files`, which is the honest empty state.
check('no roots at all returns the empty string', defaultRoot([]), '');
check('no roots at all does not throw', (() => {
  try { defaultRoot([]); return 'no throw'; } catch { return 'threw'; }
})(), 'no throw');
// And that empty string has to survive the URL builder as "no root named",
// rather than becoming `?root=`.
check('the empty root builds a bare /files', filesHref('read', defaultRoot([])), '/files');

console.log('\n── the router and the redirect table agree ─────────────');

// Both routes have to be in LIVE_PATHS: that list is what every redirect target
// is tested against, so a page missing from it turns a correct redirect into a
// reported failure - and, worse, hides a redirect that really does point at a
// page that no longer exists.
check('/files is a live route', new Set(LIVE_PATHS).has(READ_PATH), true);
check('/files/edit is a live route', new Set(LIVE_PATHS).has(EDIT_PATH), true);
// Neither is a redirect. `/files` in particular: it changed MEANING rather than
// address, and the temptation when that happens is to redirect the old meaning
// somewhere. Every link ever shared to /files was a link to a file, and it still
// opens that file - in the reader.
check('/files is not a redirect', legacyTarget(READ_PATH), null);
check('/files/edit is not a redirect', legacyTarget(EDIT_PATH), null);

console.log(bad ? `\n${bad} FAILED` : '\nall pass');
process.exit(bad ? 1 : 0);
