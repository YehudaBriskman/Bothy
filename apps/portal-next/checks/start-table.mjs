// What /files opens on - run with ./checks/run.sh
//
// Three rules, and every one of them fails silently in the browser.
//
// 1. THE SHELF NAMES FILES THAT EXIST. `DOC_SHELF` is a hand-written list of
//    seven paths into Bothy's own repository, and this check is the only thing
//    standing between a rename and a landing page whose cards all open "No such
//    file". Nothing errors when that happens: the page renders, the card looks
//    fine, and the failure is one click later. The paths are checked against
//    THIS REPOSITORY on disk, which is legitimate precisely because the shelf is
//    about this repository - the `stacks` root the reader browses is this
//    checkout, so the two cannot disagree without one of them being wrong.
//
//    This is also why the shelf does not filter itself at runtime against the
//    root's listing. That would be a second, weaker copy of a guarantee already
//    held here, and it would cost a 4,000-entry listing to render seven cards.
//
// 2. A ROOT'S FRONT PAGE IS FOUND IN THE RIGHT ORDER. `frontPageOf` used to be
//    four lines inside a Reader effect that drove an automatic redirect, where
//    its precedence was never asserted. It now drives an OFFER instead, so a
//    wrong answer is quieter still - a link nobody clicks twice.
//
// 3. THE RECENTS LIST SURVIVES ITS OWN STORE. Its contents are hand-editable,
//    outlive deploys, and are fed straight into `?root=&path=`. A stored `null`
//    that reaches the URL builder is a fetch for a file called "null".

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DOCS_ROOT, DOC_SHELF, frontPageOf, mergeRecent, parseRecents, RECENTS_MAX, titlePathOf } from './start-mod.mjs';
import { titleOf } from './titles.mjs';
import { GUIDE_DIR, GUIDE_ROOT } from './files-routes.mjs';
import { GUIDE_ORDER, guideRank, sortGuide } from './guide-mod.mjs';

// TOLD where the repository is, not inferred from this file's own location.
// run.sh copies the checks into a temp directory beside the compiled modules, so
// `new URL('.', import.meta.url)` here points at /tmp and every path below would
// be missing - the check would fail for a reason that has nothing to do with the
// shelf. Same argument, and the same fix, as theme-contract.mjs.
const REPO = process.argv[2];
if (!REPO || !existsSync(join(REPO, 'apps'))) {
  console.error(`  FAIL: argv[1] must be the repository root, got ${JSON.stringify(REPO)}`);
  process.exit(1);
}

let bad = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)}${ok ? '' : ` want=${JSON.stringify(want)} got=${JSON.stringify(got)}`}`);
};

console.log('── every card on the shelf opens something real ────────');

// `stacks` is the root name in apps/portal-files/policy.toml. Asserted rather
// than assumed: the shelf is unreachable if the root it names is not the one
// that is mounted, and the failure is an empty section nobody notices.
check('the shelf points at the stacks root', DOCS_ROOT, 'stacks');

for (const item of DOC_SHELF) {
  const abs = join(REPO, item.path);
  if (item.kind === 'folder') {
    // A folder entry narrows the index rather than opening a file, so "exists"
    // means a directory with something in it. An empty one scopes the reader to
    // a listing with no rows, which looks exactly like a broken filter.
    const ok = existsSync(abs) && statSync(abs).isDirectory() && readdirSync(abs).length > 0;
    check(`${item.path}/ is a non-empty directory`, ok, true);
  } else {
    const ok = existsSync(abs) && statSync(abs).isFile();
    check(`${item.path} is a file`, ok, true);
  }
}

// A card with no words on it is a card nobody presses. Cheap to assert and it
// is the field most likely to be left empty when one is added in a hurry.
for (const item of DOC_SHELF) {
  check(`${item.id} has a label and a blurb`, !!item.label && item.blurb.length > 20, true);
}

// Ids are the icon lookup in Start.tsx. A duplicate silently gives two cards the
// same glyph and, worse, the same React key.
check('ids are unique', new Set(DOC_SHELF.map((i) => i.id)).size, DOC_SHELF.length);

console.log('\n── a root speaks for itself, in the right order ────────');

// The order is README.md, readme.md, index.md, README.markdown - and TOP LEVEL
// ONLY. The cases below are the ones where more than one answer exists.
check('plain README wins', frontPageOf(['README.md', 'index.md']), 'README.md');
check('case matters, uppercase first', frontPageOf(['readme.md', 'README.md']), 'README.md');
check('lowercase readme is still a front page', frontPageOf(['readme.md', 'a.md']), 'readme.md');
check('index.md when there is no readme', frontPageOf(['index.md', 'a.md']), 'index.md');
check('the .markdown spelling is last', frontPageOf(['README.markdown', 'a.md']), 'README.markdown');
// THE ONE THAT MATTERS. Every root here has a docs/README.md or a docs/kb/
// README.md, and titling the whole root after a section's introduction would
// land the reader inside a subdirectory they did not ask for.
check('a nested README is not the root\'s', frontPageOf(['docs/README.md', 'kb/index.md']), '');
check('no front page at all', frontPageOf(['a.md', 'b/c.md']), '');
check('an empty root', frontPageOf([]), '');
// Listing order is the service's, not ours, so the answer must not depend on it.
check('order in the listing does not decide', frontPageOf(['index.md', 'README.md']), 'README.md');

console.log('\n── a row with no folder heading over it ───────────────');

// The recents list has no folder headings, so `index.md` and `README.md` - which
// name a POSITION rather than a subject - have to borrow the folder's name or
// three unrelated rows all read "Index". Asserted THROUGH titleOf, because the
// pair is what the reader sees and testing the path alone would pass while the
// two of them together produced nonsense.
const shown = (p) => titleOf(titlePathOf(p));
check('an index.md is titled after its folder', shown('docs/guide/index.md'), 'Guide');
check('so is a nested README', shown('docs/kb/README.md'), 'KB');
check('case does not save it', shown('docs/guide/Index.MD'), 'Guide');
check('a top-level README keeps its own name', shown('README.md'), 'README');
check('a top-level index has no folder to borrow', shown('index.md'), 'Index');
// The ordinary case, which must be left completely alone.
check('an ordinary document is untouched', shown('docs/kb/runbook-cant-reach.md'), 'Runbook cant reach');
check('a file merely CONTAINING index is untouched', shown('docs/indexing.md'), 'Indexing');
check('the path, not the title, is what is returned', titlePathOf('a/b/index.md'), 'a/b');
check('no folder means no change', titlePathOf('index.md'), 'index.md');

console.log('\n── the recents list ───────────────────────────────────');

const r = (root, path, at) => ({ root, path, at });

check('first entry', mergeRecent([], r('notes', 'a.md', 1)), [r('notes', 'a.md', 1)]);
check(
  'newest first',
  mergeRecent([r('notes', 'a.md', 1)], r('notes', 'b.md', 2)),
  [r('notes', 'b.md', 2), r('notes', 'a.md', 1)],
);
// Re-reading a document MOVES it rather than adding it again. Without this the
// list of eight is one document eight times after a morning of re-reading it.
check(
  're-opening moves rather than duplicates',
  mergeRecent([r('notes', 'b.md', 2), r('notes', 'a.md', 1)], r('notes', 'a.md', 3)),
  [r('notes', 'a.md', 3), r('notes', 'b.md', 2)],
);
// `home` aliases every other root, so the same file genuinely is two places -
// and only one of them can be written to. Keying on the path alone would merge
// them and keep whichever was opened last.
check(
  'the same path in two roots is two rows',
  mergeRecent([r('stacks', 'README.md', 1)], r('home', 'README.md', 2)),
  [r('home', 'README.md', 2), r('stacks', 'README.md', 1)],
);
// Start itself is `/files` with no `?path=`. Without this guard the surface that
// lists your recent documents lists itself, at the top, forever.
check(
  'a row with no path is refused',
  mergeRecent([r('notes', 'a.md', 1)], r('notes', '', 2)),
  [r('notes', 'a.md', 1)],
);
check(
  'a row with no root is refused',
  mergeRecent([r('notes', 'a.md', 1)], r('', 'a.md', 2)),
  [r('notes', 'a.md', 1)],
);
check(
  'the cap holds, and drops the oldest',
  mergeRecent(
    Array.from({ length: RECENTS_MAX }, (_, i) => r('notes', `${i}.md`, i)),
    r('notes', 'new.md', 99),
  ).map((x) => x.path),
  ['new.md', ...Array.from({ length: RECENTS_MAX - 1 }, (_, i) => `${i}.md`)],
);
// An over-long list already in the store - written by an older cap - is trimmed
// even when the new entry is refused, so the list cannot stay over the cap.
check(
  'an over-long stored list is trimmed even on a refusal',
  mergeRecent(Array.from({ length: 20 }, (_, i) => r('notes', `${i}.md`, i)), r('', '', 0)).length,
  RECENTS_MAX,
);

console.log('\n── whatever is in localStorage, made safe ─────────────');

check('nothing stored', parseRecents(null), []);
check('empty string', parseRecents(''), []);
check('not JSON', parseRecents('{oh no'), []);
check('JSON, but not a list', parseRecents('{"root":"notes"}'), []);
check('a list of nothing useful', parseRecents('[1,"x",null,true]'), []);
check(
  'a good row survives',
  parseRecents('[{"root":"notes","path":"a.md","at":5}]'),
  [r('notes', 'a.md', 5)],
);
// The one that would reach a URL. `?path=null` is a fetch for a file called
// "null", and the 404 reads as the reader being broken.
check('a null path is dropped', parseRecents('[{"root":"notes","path":null,"at":5}]'), []);
check('a non-string root is dropped', parseRecents('[{"root":7,"path":"a.md","at":5}]'), []);
check('an empty path is dropped', parseRecents('[{"root":"notes","path":"","at":5}]'), []);
// A missing timestamp costs a relative date; dropping the row would cost the
// document. Start renders no date for `at: 0` rather than "Invalid Date".
check(
  'a missing timestamp keeps the row',
  parseRecents('[{"root":"notes","path":"a.md"}]'),
  [r('notes', 'a.md', 0)],
);
check(
  'NaN and Infinity are not timestamps',
  parseRecents('[{"root":"notes","path":"a.md","at":1e999}]'),
  [r('notes', 'a.md', 0)],
);
check(
  'a good row survives beside a broken one',
  parseRecents('[{"bad":1},{"root":"notes","path":"a.md","at":5}]'),
  [r('notes', 'a.md', 5)],
);
check(
  'a hand-grown list is capped on the way in',
  parseRecents(JSON.stringify(Array.from({ length: 50 }, (_, i) => r('notes', `${i}.md`, i)))).length,
  RECENTS_MAX,
);

console.log(bad ? `\n${bad} FAILED` : '\nall good');

// ── 4. THE GUIDE'S ORDER AND THE GUIDE'S FOLDER DESCRIBE EACH OTHER ─────────
//
// GUIDE_ORDER is the reading order of docs/guide - the fourth copy of a list
// that already existed in docs/guide/index.md, README.md and each page's
// `## Next` footer, and the only one a program can check. It has two failure
// modes and both are silent in the browser:
//
//   · a page NAMED here that is not on disk       - a row that opens "No such
//                                                   file", exactly like §1
//   · a page ON DISK that is not named here       - it still renders, at the
//                                                   BOTTOM, alphabetically,
//                                                   after everything ordered.
//                                                   Nothing is missing, so
//                                                   nobody notices it is last.
//
// So the check runs in BOTH directions. The second is the one worth having: it
// is what turns "somebody added a guide page and forgot the manifest" into a
// red line rather than a page quietly filed at the end.
console.log('');
console.log('── the guide, ordered ──────────────────────────────────');

check('GUIDE_ROOT is the root the shelf uses', GUIDE_ROOT, DOCS_ROOT);

const guideDir = join(REPO, GUIDE_DIR);
if (!existsSync(guideDir)) {
  check(`${GUIDE_DIR} exists`, false, true);
} else {
  const onDisk = readdirSync(guideDir).filter((f) => f.endsWith('.md')).sort();
  for (const name of GUIDE_ORDER) {
    check(`GUIDE_ORDER names a file that exists: ${name}`, existsSync(join(guideDir, name)), true);
  }
  const missing = onDisk.filter((f) => !GUIDE_ORDER.includes(f));
  check(`every .md in ${GUIDE_DIR} is in GUIDE_ORDER`, missing, []);
  check('GUIDE_ORDER has no duplicates', GUIDE_ORDER.length, new Set(GUIDE_ORDER).size);
  check('the guide opens on its index', GUIDE_ORDER[0], 'index.md');
}

// An unranked page sorts LAST, not first. `Infinity` is what does that, and the
// spelling matters: -1 from indexOf would have sorted it to the front, ahead of
// the index page.
check('an unlisted page ranks last', guideRank('docs/guide/zzz.md') === Infinity, true);
check('rank is read from the basename, not the path',
  guideRank('anything/at/all/installing.md'), GUIDE_ORDER.indexOf('installing.md'));
// The argument is never sorted in place: the listing handed in is the same array
// the panel renders from, and reordering a caller's state behind its back is the
// kind of bug that only shows up as a list that scrambles on re-render.
const src = [{ p: 'docs/guide/themes.md' }, { p: 'docs/guide/index.md' }];
const sorted = sortGuide(src, (x) => x.p);
check('sortGuide puts the index first', sorted.map((x) => x.p),
  ['docs/guide/index.md', 'docs/guide/themes.md']);
check('sortGuide does not sort its argument', src.map((x) => x.p),
  ['docs/guide/themes.md', 'docs/guide/index.md']);

process.exit(bad ? 1 : 0);
