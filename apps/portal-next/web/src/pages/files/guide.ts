// ── the guide, as an ordered thing ───────────────────────────────────────────
//
// docs/guide/ is a MANUAL, and a manual has an order. The service lists it in
// path order, which reads configuring -> files -> index -> installing -> roles
// -> the-console -> themes: alphabetical, and backwards for a set of pages that
// end in `## Next`.
//
// THE ORDER LIVED IN THREE PLACES BEFORE THIS FILE, and they already disagreed:
// the "Where to start" table in docs/guide/index.md, the table in README.md
// (which also hard-codes a COUNT - "Seven pages" - the exact rotting sentence
// start.ts warns about), and the `## Next` footer of each page. The reader's
// index is the fourth. One list, and checks/start-table.mjs asserts it against
// the folder on disk in both directions, so a page added without a line here is
// a red check rather than a page nobody can find.
//
// IMPORTS NOTHING, for the same reason routes.ts, titles.ts and start.ts do
// not: it is compiled and run by checks/run.sh with a bare `tsc`, no bundler and
// no test runner.

/** Basenames of docs/guide/*.md in READING order, index first.
 *
 *  Basenames rather than paths: the folder is GUIDE_DIR (routes.ts) and writing
 *  it out seven times would be seven copies of one fact. */
export const GUIDE_ORDER: readonly string[] = [
  'index.md',
  'installing.md',
  'configuring.md',
  'the-console.md',
  'roles.md',
  'files.md',
  'themes.md',
];

/** Where `path` sits in the reading order. `Infinity` for anything the list does
 *  not name, which sorts it to the end ALPHABETICALLY rather than dropping it -
 *  a page that exists and is not in the manifest must still be reachable, or the
 *  manifest becomes a way to hide documents. The check is what stops it staying
 *  that way. */
export function guideRank(path: string): number {
  const at = GUIDE_ORDER.indexOf(path.slice(path.lastIndexOf('/') + 1));
  return at === -1 ? Infinity : at;
}

/** The guide's own order, then alphabetical for anything unranked.
 *
 *  A COPY is sorted, never the argument: the listing this is called with is the
 *  same array the index renders from, and sorting it in place would reorder a
 *  caller's state behind its back. */
export function sortGuide<T>(items: readonly T[], pathOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ra = guideRank(pathOf(a));
    const rb = guideRank(pathOf(b));
    if (ra !== rb) return ra - rb;
    return pathOf(a).localeCompare(pathOf(b), undefined, { numeric: true });
  });
}
