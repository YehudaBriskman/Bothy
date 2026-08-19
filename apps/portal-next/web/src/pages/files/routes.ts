// ── the two Files URLs, in one place ─────────────────────────────────────────
//
// Files is one nav entry and two destinations (docs/plans/reading-first.md §2):
//
//   /files        READ  the default. A document, and how to find one.
//   /files/edit   WORK  the IDE, unchanged, at a route.
//
// Both carry the SAME `?root=&path=`, which is the whole reason every deep link
// written before the split still resolves - and the reason this file exists.
// Three places now build one of those URLs (the reader's Edit button, the
// editor's way back, and the router itself), and a builder that drops `path` is
// the same defect the redirect table was written to prevent: a link that answers
// 200, renders a plausible page, and quietly goes somewhere else. Nobody reports
// that. So the builder and the parser are ONE module with a truth table over it
// (checks/redirect-table.mjs).
//
// This module imports NOTHING, on purpose - the same property that lets
// lib/discover.ts and pages/control/redirects.ts be compiled and run by the
// checks with no bundler and no test runner. `URLSearchParams` is a platform
// global in both the browser and node, not an import, so it does not break that.

export const READ_PATH = '/files';
export const EDIT_PATH = '/files/edit';

/** Which of the two the reader is in. */
export type FilesMode = 'read' | 'edit';

/** `null` for a path that is not one of ours at all. Note that `/files/edit` has
 *  to be tested BEFORE `/files`, which is why this is a function rather than a
 *  map: `/files` is a prefix of `/files/edit`. */
export function filesMode(pathname: string): FilesMode | null {
  // A trailing slash is the same page; a pasted link often carries one. Same
  // normalisation as pages/control/redirects.ts, for the same reason.
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === EDIT_PATH) return 'edit';
  if (p === READ_PATH) return 'read';
  return null;
}

/**
 * The URL for one file in one mode. `path` may be empty - that is the reader
 * with nothing open yet, and the root still belongs in the URL so a reload lands
 * on the same index.
 *
 * Percent-encoding is left to URLSearchParams, which encodes `/` in a value as
 * `%2F`. That matches what Files.tsx has always written (it builds its URL the
 * same way), so a link from here and a link the editor wrote are the same
 * string, and the browser's Back button cannot tell them apart.
 */
export function filesHref(mode: FilesMode, root: string, path = ''): string {
  const q = new URLSearchParams();
  if (root) q.set('root', root);
  if (path) q.set('path', path);
  const s = q.toString();
  const base = mode === 'edit' ? EDIT_PATH : READ_PATH;
  return s ? `${base}?${s}` : base;
}

/** What a Files URL asks for, or null if it is not a Files URL.
 *
 *  `search` is the raw query string (`location.search`), leading `?` optional -
 *  the same shape `legacyTarget` takes, so callers do not have to remember which
 *  of the two wants which. */
export function filesTarget(
  pathname: string, search = '',
): { mode: FilesMode; root: string; path: string } | null {
  const mode = filesMode(pathname);
  if (!mode) return null;
  const q = new URLSearchParams(search.replace(/^\?/, ''));
  return { mode, root: q.get('root') ?? '', path: q.get('path') ?? '' };
}

/** The minimum a root has to look like to be chosen between. Written out here
 *  rather than imported from lib/files.ts because THIS MODULE IMPORTS NOTHING
 *  (see the header): that is what lets checks/run.sh compile it with a bare
 *  `npx tsc` and run a truth table over it with no bundler and no test runner.
 *  `FileRoot` carries more fields, and every one of them is irrelevant here. */
export interface RootChoice {
  key: string;
  readOnly?: boolean;
}

/**
 * Which root a Files URL with no usable `?root=` should land on. It sets
 * `?root=`, so it is a URL decision, so it lives beside the other two.
 *
 * NOT roots[0]. The service returns them alphabetically, which put `home`
 * first - the one root that is read-only, holds ~4,000 entries, and ALIASES
 * every other root (`aliases = true` in apps/portal-files/policy.toml), so
 * everything worth reading appeared twice under a name that cannot be written
 * to. Landing there was an accident of sort order, and it opened the reader -
 * and, until this function existed, the IDE - on the worst possible listing.
 *
 * A writable root is the one somebody keeps documents in; `readOnly` already
 * travels with each root, so this needs nothing new from the service.
 *
 * ABSENT `readOnly` MEANS WRITABLE. The field is optional in the type and the
 * service sends it on every root today, so the two agree - but the gap is real
 * (`label` and `writableSuffixes` are declared and never sent), and the inverse
 * spelling, `roots.find((x) => x.writable)`, would read a field the service
 * stopped sending as "read-only everywhere" and send every visitor back to
 * `home`. `!x.readOnly` fails the safe way round.
 *
 * Falls back to the first root when every root is read-only - a listing of
 * something beats an empty page - and to `''` when the list is empty, which
 * `filesHref` already renders as a bare `/files`. It never throws and never
 * returns undefined: both callers run it inside a `.then()` whose rejection
 * path is the sign-in-required branch, so a throw here would tell somebody
 * already signed in to sign in.
 */
export function defaultRoot(roots: RootChoice[]): string {
  if (!roots.length) return '';
  const best = roots.find((x) => !x.readOnly) ?? roots[0];
  return best.key;
}
