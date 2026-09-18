// Which service groups you have collapsed, remembered per browser.
//
// ── why localStorage, and why that is not a shortcut ─────────────────────────
//
// docs/plans/control-and-settings.md §6b splits "settings" into three, and this
// is the first row: theme, pane widths and collapsed groups belong to the
// BROWSER, and the plan's words for that row are "already correct, leave it".
// The row that needs a server - a default landing page, favourites - is the one
// the plan declines to build, by design and not by omission, and Settings.tsx
// says so on the page. Nothing here is a placeholder for a store that is coming.
//
// ── the shape ────────────────────────────────────────────────────────────────
//
// A list of the groups you COLLAPSED, not a map of every group's state. Two
// consequences, both wanted:
//
//   * the default for a group nobody has touched is EXPANDED, and it is expanded
//     because it is absent rather than because a default was written down. A
//     Services page whose first frame is a stack of closed boxes hides the
//     tables it exists to show, and #93's own requirement is that with nothing
//     configured the page looks exactly as it does today;
//   * the stored value reads as what the person did. Nobody has to diff it
//     against a default to know what it means.
//
// The keys are STABLE IDENTITIES, not display group names - see
// groupStorageKey() in discover.ts for why, and checks/collapsed-groups.mjs for
// the truth table.
//
// This module imports NOTHING, on purpose: checks/run.sh compiles it with a bare
// tsc and runs a truth table against it. `localStorage` is a global rather than
// an import, which is what lets the read/write path live here beside the parse
// and prune rules rather than being scattered into the page.

/**
 * Versioned like `bothy-files-panes-v1`, so a shape change is a reset rather
 * than a crash on somebody's three-week-old value.
 *
 * DELIBERATELY NOT `portal-open-groups`. That key belonged to SystemGroup, the
 * three collapsible Overview cards deleted in favour of SystemMatrix, and it
 * held the INVERSE list - which groups were OPEN. A value left in a browser
 * since then would parse cleanly here and mean the exact opposite of what it
 * says, so it must not be able to collide.
 */
export const COLLAPSED_KEY = 'bothy-collapsed-groups-v1';

/**
 * Parse a stored value into the set of collapsed keys.
 *
 * Everything that is not a JSON array of strings is treated as "nothing is
 * collapsed", including `null`. A hand-edited value, a half-written quota
 * failure or a value from a future shape are all reasons to start from the
 * default layout - never reasons for the page not to render.
 */
export function parseCollapsed(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const j: unknown = JSON.parse(raw);
    if (!Array.isArray(j)) return [];
    // Deduplicated and sorted so the stored value is canonical: without this,
    // collapsing A then B and B then A write two different strings for the same
    // state, and any future comparison of the two is wrong for no reason.
    return [...new Set(j.filter((x): x is string => typeof x === 'string'))].sort();
  } catch {
    return [];
  }
}

/**
 * Drop stored keys for groups the box no longer has.
 *
 * Without this the file grows forever: every renamed compose project, every
 * project deleted from ~/projects and every one-shot that was collapsed once
 * leaves an entry that nothing will ever read again.
 *
 * TWO GUARDS, and both of them are the difference between pruning and data loss.
 *
 * `live` must be EVERY group the box currently has, not the groups currently on
 * screen. The Services page filters - by status, by project, by search text -
 * and a filtered-out panel is not a deleted one. Pruning against the visible
 * list would silently forget everything you collapsed the moment you typed into
 * the search box.
 *
 * And an EMPTY `live` prunes nothing. The portal polls, and a poll that fails
 * renders zero nodes - which is indistinguishable from "the box has no services"
 * to this function, but is emphatically not a reason to erase the layout. A
 * genuinely empty box has nothing to collapse and so nothing to lose either way.
 */
export function pruneCollapsed(stored: readonly string[], live: readonly string[]): string[] {
  if (live.length === 0) return [...stored];
  const alive = new Set(live);
  return stored.filter((k) => alive.has(k));
}

/** Add or remove one key, keeping the canonical order parseCollapsed() produces. */
export function toggleCollapsed(stored: readonly string[], key: string): string[] {
  return stored.includes(key)
    ? stored.filter((k) => k !== key)
    : [...stored, key].sort();
}

/**
 * Everything collapsed, or nothing - the "Collapse all" button's two states.
 *
 * `all` is the VISIBLE groups, unlike prune's argument: collapsing all means
 * collapsing what you are looking at, and it must not reach past a filter to
 * touch groups that are not on screen. Whatever was already stored for those is
 * carried through untouched.
 */
export function setAllCollapsed(
  stored: readonly string[],
  all: readonly string[],
  collapsed: boolean,
): string[] {
  const touched = new Set(all);
  const rest = stored.filter((k) => !touched.has(k));
  return (collapsed ? [...rest, ...all] : rest).filter((k, i, a) => a.indexOf(k) === i).sort();
}

/** Read the stored list. Never throws - private mode denies localStorage outright. */
export function readCollapsed(): string[] {
  try {
    return parseCollapsed(localStorage.getItem(COLLAPSED_KEY));
  } catch {
    return [];
  }
}

/** Write it back. A quota error or a denied store is not a reason to break a click. */
export function writeCollapsed(keys: readonly string[]): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    /* private mode, quota - the page keeps working, it just forgets */
  }
}
