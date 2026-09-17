// ── the redirect table ───────────────────────────────────────────────────────
//
// Services, Access and Topology moved under /control (docs/plans/
// control-and-settings.md §3). Every URL they had before still resolves, because
// this is a dashboard people paste into notes and chat, and
// brand/patterns/navigation.md is unambiguous about it: "if a URL has ever been
// shared, breaking it is worse than carrying a redirect forever". /ports and
// /routes have been carrying exactly this since they were merged into Access,
// which is the precedent rather than an exception.
//
// It is a FUNCTION and not a `from -> to` map for one reason: /access holds its
// view in `?tab=`, so half the mapping lives in the query string. A redirect that
// drops the parameter is a broken link that answers 200 - it lands somewhere
// plausible, so nobody reports it and nobody notices it was the wrong somewhere.
//
// This module imports NOTHING, which is what lets checks/redirects.mjs compile
// and run it on its own - the same trick that makes lib/discover.ts testable
// without a test runner. App.tsx builds its legacy routes FROM `LEGACY_PATHS`
// rather than listing them again, so the router and this table cannot disagree
// about which URLs are covered; the check covers the half that can still drift,
// namely where each one lands.

/** Every path that used to be a page here, spelled the way App.tsx registers a
 *  child route (no leading slash, React Router params). */
export const LEGACY_PATHS = [
  'services',
  'services/:id',
  'systems/:name',
  'access',
  'ports',
  'routes',
  'topology',
] as const;

/** Every path the app serves now. A redirect target that is not in here is a
 *  redirect into the not-found page, which is the one failure mode a redirect
 *  table has that nobody sees until a user reports it. */
export const LIVE_PATHS = [
  '/',
  '/control',
  '/control/services',
  '/control/services/:id',
  '/control/systems/:name',
  '/control/ports',
  '/control/routes',
  '/control/topology',
  '/settings',
  // Files is one nav entry and two routes since reading-first.md §2: `/files`
  // reads, `/files/edit` is the IDE. Both are listed because this array is what
  // the check tests redirect targets against - and because the moment a page
  // exists and is not in here, a redirect pointed at it would be reported as
  // broken by a check that was right about everything except this list.
  '/files',
  '/files/edit',
] as const;

/**
 * Where a retired URL goes now, or null when the path was never one of ours.
 *
 * `search` is the raw query string (`location.search`), leading `?` optional.
 */
export function legacyTarget(pathname: string, search = ''): string | null {
  // A trailing slash is the same page, and a pasted link often carries one.
  const p = pathname.replace(/\/+$/, '') || '/';

  if (p === '/access') {
    // Mirrors Access's own `isTab(raw) ? raw : 'routes'`: an absent or
    // unrecognised tab landed on Routes, so a bare /access bookmark must still
    // land on Routes.
    //
    // THE PLAN SAYS PORTS, AND THE PLAN IS WRONG about this. Both
    // docs/plans/control-and-settings.md §3 and the brief built on it map
    // /access to Ports "its default tab today"; the code has said
    // `isTab(raw) ? raw : 'routes'` since the two pages were merged. What a
    // bookmark DID is the only thing a redirect owes its user, so this follows
    // the code. Changing where a saved link lands is the same defect as dropping
    // its query parameter, just harder to notice.
    const tab = new URLSearchParams(search.replace(/^\?/, '')).get('tab');
    return tab === 'ports' ? '/control/ports' : '/control/routes';
  }
  if (p === '/ports') return '/control/ports';
  if (p === '/routes') return '/control/routes';
  if (p === '/services' || p === '/topology') return `/control${p}`;
  // The parameterised ones. Whatever follows is passed through untouched: the
  // id and the group are already percent-encoded by lib/links.ts, and decoding
  // them here to re-encode them there is how a service whose name contains a
  // slash stops resolving.
  if (p.startsWith('/services/') || p.startsWith('/systems/')) return `/control${p}`;

  return null;
}
