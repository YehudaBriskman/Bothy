// ── loading the tree one folder at a time ────────────────────────────────────
//
// The listing used to be one request per root: every file under it, recursively,
// capped by the service at 4,000 entries and flagged `truncated`. Measured in the
// container, that meant `projects` (19,273 files) and `home` (20,612) each handed
// back 4,000 of them in ~1.2 MB of JSON, and the other ~15,000 had no path the
// browser had ever seen - so they could not be opened, found or linked at all.
//
// And it was paying for that to draw almost nothing: the MEDIAN directory on this
// box holds ONE entry, p95 is 10-11, and only two directories anywhere exceed 300.
//
// So: one request per folder, when the folder is opened. One code path for every
// root, with no threshold and no "small roots stay eager" branch - `stacks` (84ms,
// 272 KB) and `notes` got faster too, and a threshold is a second behaviour to
// reason about that nobody would ever exercise.
//
// WHY THIS IS A HOOK AND NOT TWO COPIES. Both Files surfaces need it and they need
// it differently: the IDE browses ONE root at a time, the reader can have several
// open sections at once. Keying the state by root from the start is what lets one
// implementation serve both, and the alternative - a per-root copy in each page -
// is how the two come to disagree about a folder they both list.

import { useCallback, useEffect, useRef, useState } from 'react';
import { isAuthError, listTree } from '../../lib/files';
import type { Loaded } from './tree';

export interface RootDirs {
  /** Folder -> its direct children, root-relative, '' for the root itself. A
   *  missing key means "never asked for", which is NOT the same as an empty
   *  array: an empty array is a folder that was listed and is genuinely empty,
   *  and the two render differently. */
  loaded: Loaded;
  /** Folders with a request in flight. The root's own listing being here is what
   *  the skeleton is drawn from. */
  pending: ReadonlySet<string>;
  /** The first failure for this root. One message, not one per folder: a rail
   *  with eleven identical error rows in it is unreadable, and the retry is the
   *  same retry. */
  err: string | null;
}

const EMPTY: RootDirs = { loaded: new Map(), pending: new Set(), err: null };

export function emptyDirs(): RootDirs {
  return EMPTY;
}

/**
 * @param onAuthError called the first time a listing comes back 401. Signing out
 *   is a page-level fact, not a per-folder error, so it leaves this hook entirely
 *   rather than being rendered eleven times down the tree.
 */
export function useLazyDirs(onAuthError?: () => void): {
  dirs: Readonly<Record<string, RootDirs | undefined>>;
  /** Ask for a folder's listing unless it is already loaded or in flight.
   *  Idempotent, because it is called from render-adjacent effects as well as
   *  from the click that expands a row. */
  ensure: (root: string, dir: string) => void;
  /** Forget a root's listings, so the next `ensure` refetches. Called by Retry
   *  and by the page's reload. Forgetting ALL of them is `reset()`. */
  reset: (root?: string) => void;
} {
  const [dirs, setDirs] = useState<Record<string, RootDirs | undefined>>({});

  // THE CONTROLLERS LIVE IN A REF AND THIS HOOK HAS NO CLEANUP THAT ABORTS THEM,
  // which is the same decision Reader.tsx's listing effect records at length and
  // for the same reason: `ensure` is called from effects that depend on the state
  // it writes, so an abort-on-change would cancel the request it had just made and
  // leave the rail on its skeleton forever, with a net::ERR_ABORTED in the log and
  // nothing on screen. The only abort that is correct is the one on unmount.
  const inflight = useRef(new Map<string, AbortController>());
  useEffect(() => () => { for (const ac of inflight.current.values()) ac.abort(); }, []);

  // `ensure` is called from effects, so it must not change identity on every
  // listing that arrives - otherwise every arrival re-runs every effect that
  // depends on it. The state it needs to consult is read through a ref instead.
  const latest = useRef(dirs);
  latest.current = dirs;

  const ensure = useCallback((root: string, dir: string) => {
    if (!root) return;
    const key = `${root}\u0000${dir}`;
    const at = latest.current[root];
    if (at?.loaded.has(dir) || inflight.current.has(key)) return;

    const ac = new AbortController();
    inflight.current.set(key, ac);
    setDirs((prev) => {
      const cur = prev[root] ?? EMPTY;
      const pending = new Set(cur.pending);
      pending.add(dir);
      return { ...prev, [root]: { ...cur, pending } };
    });

    const settle = (fn: (cur: RootDirs) => RootDirs) => {
      inflight.current.delete(key);
      setDirs((prev) => {
        const cur = prev[root] ?? EMPTY;
        const pending = new Set(cur.pending);
        pending.delete(dir);
        return { ...prev, [root]: fn({ ...cur, pending }) };
      });
    };

    listTree(root, ac.signal, dir)
      .then((r) => {
        if (ac.signal.aborted) return;
        settle((cur) => {
          const loaded = new Map(cur.loaded);
          // FILED UNDER THE FOLDER THE SERVICE ECHOED, not under the one that was
          // asked for. They are the same string today, and keying on the response
          // is what keeps a listing from landing under the wrong parent if the
          // service ever normalises a path - which is the one failure here that
          // would look like missing files rather than like an error.
          loaded.set(r.path ?? dir, r.files);
          return { loaded, pending: cur.pending, err: null };
        });
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        if (isAuthError(e)) {
          inflight.current.delete(key);
          setDirs((prev) => {
            const cur = prev[root] ?? EMPTY;
            const pending = new Set(cur.pending);
            pending.delete(dir);
            return { ...prev, [root]: { ...cur, pending } };
          });
          onAuthError?.();
          return;
        }
        settle((cur) => ({
          ...cur,
          err: cur.err ?? (e instanceof Error ? e.message : String(e)),
        }));
      });
  }, [onAuthError]);

  const reset = useCallback((root?: string) => {
    for (const [key, ac] of inflight.current) {
      if (root === undefined || key.startsWith(`${root}\u0000`)) {
        ac.abort();
        inflight.current.delete(key);
      }
    }
    setDirs((prev) => (root === undefined ? {} : { ...prev, [root]: undefined }));
  }, []);

  return { dirs, ensure, reset };
}

/** Every folder on the way down to `path`, shallowest first, including the root.
 *
 *  A deep link lands on `a/b/c/d.md` with nothing loaded, and the rail has to show
 *  where you are rather than a closed root - so each folder on the path is asked
 *  for. Shallowest first only to keep the requests in a readable order in the API
 *  log; buildTree copes with them arriving in any order at all. */
export function dirsDownTo(path: string): string[] {
  const out = [''];
  let at = path.indexOf('/');
  while (at !== -1) { out.push(path.slice(0, at)); at = path.indexOf('/', at + 1); }
  return out;
}
