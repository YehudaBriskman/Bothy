// ── what /files opens on ─────────────────────────────────────────────────────
//
// The data behind the Start surface (issue #94). Two questions, and they are the
// only two somebody arrives at Files with:
//
//   "how does this thing work?"  → the shelf. Bothy's own documentation, named
//                                  and blurbed, one click from the landing.
//   "where was I?"               → the recents. The documents THIS BROWSER has
//                                  opened, newest first.
//
// ── WHY RECENTS AND NOT FAVOURITES ──────────────────────────────────────────
//
// The issue asks for a first screen that is *yours*. The obvious spelling is
// favourites, and it is the one thing here that cannot be built: favourites are
// a per-user preference, a per-user preference needs a store, and the store is
// declined by design (docs/plans/control-and-settings.md §6b, and Settings.tsx
// says so on the page). A recents list needs no store - it is a fact about the
// browser you are sitting at, exactly like the theme and the pane widths, and
// localStorage is where Settings already says that kind of fact honestly lives.
//
// It is also the better answer. A favourite has to be curated before it is worth
// anything; a recents list is worth something on the second visit and costs the
// reader nothing.
//
// ── THIS MODULE IMPORTS NOTHING ─────────────────────────────────────────────
//
// Same property, and for the same reason, as routes.ts and titles.ts: it lets
// checks/run.sh compile it with a bare `tsc` and run a truth table over it with
// no bundler and no test runner. `localStorage` and `JSON` are platform globals
// rather than imports, so the two accessors below do not break that - and the
// logic they wrap is pure and exported separately, which is the half worth
// asserting.

/** The root Bothy's own repository is mounted as (apps/portal-files/policy.toml,
 *  `[roots.stacks]`). A constant rather than a guess: the shelf below names
 *  paths INSIDE this repository, so if this root is not mounted the shelf is
 *  about a place that is not there. Start checks for it and draws nothing
 *  rather than seven cards that all open a 404. */
export const DOCS_ROOT = 'stacks';

/** A doc is opened; a folder narrows the index to itself.
 *
 *  The issue asks for a quick view that "knows the difference between the README
 *  and a plan document", and this is that difference made mechanical. A README
 *  is a thing you read - there is one file and it is the answer. `docs/plans/` is
 *  a shelf of six arguments with no index file and no single entry point, so
 *  sending someone to one of them would be picking for them. It gets `?in=`
 *  instead, which is the folder scope the index already implements. */
export type ShelfKind = 'doc' | 'folder';

export interface ShelfItem {
  /** Stable, and also the icon key - Start.tsx maps it to a lucide component.
   *  The icon lives THERE and not here because an import of lucide would end
   *  this module's import-free property, and with it the truth table. */
  id: string;
  kind: ShelfKind;
  /** Root-relative, inside DOCS_ROOT. For a folder, no trailing slash. */
  path: string;
  label: string;
  /** One sentence. What is in it, not that it exists. */
  blurb: string;
}

/**
 * Bothy's own documentation, in the order somebody meets it.
 *
 * CURATED AND NOT DERIVED, which is the whole point. `docs/` holds 36 topic
 * documents plus the brand system plus the diagrams; listing them is what the
 * index beside this page already does, and doing it again on the landing would
 * be the chooser the issue is complaining about with better typography. Seven
 * entries is a shelf. A person can read all of it.
 *
 * NO COUNTS IN THE BLURBS. "Seven pages", "six plans" - this repository has
 * twice shipped documentation describing things that had already been deleted
 * (docs/guide/index.md says so itself), and a number is the fastest-rotting
 * sentence there is. Every path here is asserted to exist by
 * checks/start-table.mjs, which is a guarantee a blurb cannot give.
 */
export const DOC_SHELF: readonly ShelfItem[] = [
  {
    id: 'guide',
    kind: 'doc',
    path: 'docs/guide/index.md',
    label: 'The guide',
    blurb: 'Installing it, the files you will actually edit, operating it, and making it look like yours - written for somebody who has not read the source.',
  },
  {
    id: 'readme',
    kind: 'doc',
    path: 'README.md',
    label: 'README',
    blurb: 'What Bothy is, the map of the repository, and how to get it running.',
  },
  {
    id: 'architecture',
    kind: 'doc',
    path: 'docs/ARCHITECTURE.md',
    label: 'Architecture',
    blurb: 'The tiers this box is built from, how a request reaches one, and why each layer is allowed to exist.',
  },
  {
    id: 'kb',
    kind: 'doc',
    path: 'docs/kb/README.md',
    label: 'Knowledge base',
    blurb: 'The machines around this one, the incidents that have already happened, and the runbook for when the box will not answer at all.',
  },
  {
    id: 'plans',
    kind: 'folder',
    path: 'docs/plans',
    label: 'The plans',
    blurb: 'Design documents, each one arguing for a change before it was made. Narrows the index to the folder rather than picking one for you.',
  },
  {
    id: 'security',
    kind: 'doc',
    path: 'SECURITY.md',
    label: 'Security',
    blurb: 'What "safe on a tailnet" does and does not mean here, and where to send a finding.',
  },
  {
    id: 'contributing',
    kind: 'doc',
    path: 'CONTRIBUTING.md',
    label: 'Contributing',
    blurb: 'How a change gets from a branch to main, and which checks will refuse it on the way.',
  },
];

// ── a root's front page ──────────────────────────────────────────────────────

/** The names a root's own front page can have, in the order they win. Only ever
 *  matched at the TOP LEVEL: `docs/README.md` is a section's introduction, not
 *  the root's, and titling the whole of `stacks` after it would be wrong. */
const FRONT_PAGES = ['README.md', 'readme.md', 'index.md', 'README.markdown'];

/**
 * The document that speaks for a root, or `''` when it has none.
 *
 * This rule used to live inline in Reader.tsx, where it drove an automatic
 * redirect: arriving at `/files` bounced you straight into the default root's
 * README. Start replaced that navigation, and the rule survived it - a root's
 * README is still the best single thing to offer somebody with no history, it
 * is just an offer now instead of an ambush. Moving it here is what let it get
 * a truth table; the precedence order was never asserted while it was four
 * lines inside an effect.
 *
 * @param paths root-relative paths from one root's listing. Directory entries
 *              are harmless: none of them can equal a name in FRONT_PAGES.
 */
export function frontPageOf(paths: readonly string[]): string {
  const top = new Set(paths.filter((p) => !p.includes('/')));
  return FRONT_PAGES.find((n) => top.has(n)) ?? '';
}

/** Basenames that name a POSITION rather than a subject. Every one of them is a
 *  file called "the front of this folder", so the folder is the title. */
const ANONYMOUS = new Set(['index', 'readme']);

/**
 * The path whose basename should be titled - usually the path itself.
 *
 * `titleOf('docs/guide/index.md')` is "Index", which is true and useless. That
 * is not a bug in titles.ts: the document index prints the folder as a heading
 * directly above the row, so "Index" under `docs/guide` reads correctly. A
 * recents list has no such heading - the rows come from four roots and a dozen
 * folders in the order you happened to read them - so the same title arrives
 * with nothing to lean on, and three different `index.md`s become three rows all
 * called "Index".
 *
 * So the rule is applied where the context is missing rather than changed where
 * it is present: the caller titles THIS path, and for an anonymous basename this
 * hands back the folder instead. Returned as a path rather than a title so that
 * titles.ts stays the only thing that knows how to make one - two functions
 * turning a name into a title is exactly how the index and this list would come
 * to disagree about a document they both list.
 *
 * A top-level README keeps its own name: there is no folder above it but the
 * root, "README" is a title everybody already reads correctly, and the root is
 * printed beside it anyway.
 */
export function titlePathOf(path: string): string {
  const cut = path.lastIndexOf('/');
  if (cut === -1) return path;
  const name = path.slice(cut + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return ANONYMOUS.has(stem.toLowerCase()) ? path.slice(0, cut) : path;
}

// ── recents ──────────────────────────────────────────────────────────────────

/** Versioned, so a shape change here is an empty list rather than a crash on
 *  somebody's three-week-old localStorage. Same convention as
 *  `bothy-files-panes-v1` in panes.ts. */
export const RECENTS_KEY = 'bothy-read-recent-v1';

/** Enough to answer "where was I", short enough to read without scrolling. A
 *  longer list stops being a memory and becomes a second index, and there is
 *  already an index beside it. */
export const RECENTS_MAX = 8;

export interface Recent {
  root: string;
  path: string;
  /** Epoch milliseconds, from `Date.now()`. Stored rather than derived because
   *  the point of the row is *when you were there*, which nothing else knows. */
  at: number;
}

/**
 * The list with `next` on the front, deduplicated and capped.
 *
 * DEDUPLICATED BY root+path, NOT BY PATH. `home` aliases every other root
 * (policy.toml), so the same file is reachable as `stacks/README.md` and
 * `home/stacks/README.md`; those are two rows because they are two places, and
 * only one of them can be edited. Keying on the path alone would silently merge
 * them and show whichever was written last.
 *
 * A ROW WITH NO PATH IS DROPPED. Start itself is `/files` with no `?path=`, and
 * without this guard the surface that lists your recent documents would list
 * itself, at the top, forever - the first thing a new reader would see is a row
 * pointing at the page they are already on.
 */
export function mergeRecent(list: readonly Recent[], next: Recent, max = RECENTS_MAX): Recent[] {
  if (!next.root || !next.path) return list.slice(0, max);
  const rest = list.filter((r) => !(r.root === next.root && r.path === next.path));
  return [next, ...rest].slice(0, max);
}

/**
 * Whatever is in localStorage, made safe.
 *
 * Every field is re-checked rather than trusted. This value is hand-editable, it
 * survives across deploys, and it is fed straight into `root`/`path` of a URL -
 * so a stored `{path: null}` would render "null" as a filename and fetch it. The
 * cheap defence is to keep only rows that are two non-empty strings and a
 * number, and `at` is coerced to 0 rather than dropping the row: a missing
 * timestamp costs a relative date, and losing the document is the worse of the
 * two failures.
 */
export function parseRecents(raw: string | null, max = RECENTS_MAX): Recent[] {
  if (!raw) return [];
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(j)) return [];
  const out: Recent[] = [];
  for (const row of j) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.root !== 'string' || !r.root) continue;
    if (typeof r.path !== 'string' || !r.path) continue;
    out.push({ root: r.root, path: r.path, at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0 });
    if (out.length === max) break;
  }
  return out;
}

/** Read the list. Never throws: private mode, a disabled store and a quota error
 *  all mean "no history", which is a state this page already draws. */
export function readRecents(): Recent[] {
  try { return parseRecents(localStorage.getItem(RECENTS_KEY)); } catch { return []; }
}

/** Record one opened document and return the new list, so the caller can render
 *  it without a second read. Writing is best-effort for the reason above.
 *
 *  THIS IS NOT A WRITE PATH. reading-first.md §7 is about writing to the BOX -
 *  no draft, no dirty flag, no save. This writes eight strings to the browser
 *  the reader is sitting at, reaches no server, and is the same store the theme
 *  picker and the pane widths already use. */
export function noteRecent(root: string, path: string, now = Date.now()): Recent[] {
  const next = mergeRecent(readRecents(), { root, path, at: now });
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* not fatal */ }
  return next;
}
