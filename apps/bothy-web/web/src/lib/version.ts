// "Bothy updated - reload" (docs/plans/updates.md §6, build step 6).
//
// An open tab keeps running the bundle it loaded. When Bothy updates itself
// underneath it, that bundle is no longer the one being served - and the next
// lazy chunk it asks for has a content hash the new build does not have, which
// the SPA catch-all answers with index.html and a 200 (rule 7, one level down).
// Two defences, both here:
//
//   1. useServedRevision(): the revision this tab loaded is the first
//      /version.json it reads; it asks again every minute and whenever the tab
//      comes back into view. When the answer changes, the banner offers a reload.
//      /version.json is written by the image's last build step and served by
//      nginx with an EXACT location and no-cache - a missing file is a 404, never
//      the catch-all - and anything that is not JSON naming a revision (a 502
//      from Traefik mid-update, the portal's HTML) is "no answer", not a change.
//
//   2. installChunkReload(): a chunk that fails to load reloads the page ONCE.
//      Once per ten minutes, per tab: if the reload did not help (a real outage,
//      not a stale bundle), looping would only make it worse; the banner and the
//      page's own error states take over.
//
// In `vite dev` the revision comes from lib/version.dev.ts (the dev server has no
// /version.json); see there for how to force the banner.

import { useEffect, useState } from 'react';

const REVISION = /^(?:[0-9a-f]{40}|unknown)$/;
export const POLL_MS = import.meta.env.DEV ? 4_000 : 60_000;

export async function fetchRevision(signal?: AbortSignal): Promise<string | null> {
  if (import.meta.env.DEV) return (await import('./version.dev')).revisionMock();
  try {
    const r = await fetch('/version.json', { cache: 'no-store', credentials: 'same-origin', signal });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
    const j: unknown = await r.json();
    const rev = (j as { revision?: unknown } | null)?.revision;
    return typeof rev === 'string' && REVISION.test(rev) ? rev : null;
  } catch {
    return null;
  }
}

export interface Served { loaded: string | null; now: string | null }

/** The revision this tab loaded, and the one being served now. */
export function useServedRevision(): Served {
  const [s, setS] = useState<Served>({ loaded: null, now: null });
  useEffect(() => {
    const ac = new AbortController();
    let loaded: string | null = null;
    const check = async () => {
      const rev = await fetchRevision(ac.signal);
      if (ac.signal.aborted || rev === null) return;
      loaded ??= rev;
      setS({ loaded, now: rev });
    };
    void check();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void check(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      ac.abort();
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);
  return s;
}

// ── a chunk that will not load: reload once ────────────────────────────────

const RELOAD_KEY = 'bothy-chunk-reload';
const RELOAD_WINDOW_MS = 10 * 60_000;
const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|ChunkLoadError|is not a valid JavaScript MIME type/i;

export function isChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : typeof e === 'string' ? e : '';
  return CHUNK_ERROR.test(msg);
}

/** Reload the page once for a stale bundle; false when it already did recently. */
export function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false; // no storage, no way to know it is the first time - do not risk a loop
  }
  location.reload();
  return true;
}

export function installChunkReload(): void {
  // Vite's own signal: a dynamic import (a lazy route, CodeSurface, the 3D
  // scene) whose preload failed. preventDefault stops Vite rethrowing it.
  window.addEventListener('vite:preloadError', (e) => {
    if (reloadOnce()) e.preventDefault();
  });
  // Belt and braces: a bare import() the preload helper did not wrap.
  window.addEventListener('unhandledrejection', (e) => {
    if (isChunkError(e.reason) && reloadOnce()) e.preventDefault();
  });
}
