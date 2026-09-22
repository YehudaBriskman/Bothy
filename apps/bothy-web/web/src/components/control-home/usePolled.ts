// One source on the Control landing: fetched, re-fetched on a cadence, and
// honest about which of four states it is in.
//
//   off       not requested - the role does not reach it, or nothing asked yet
//   loading   the first answer has not landed
//   ok        the last attempt answered
//   error     the last attempt failed; `data` still holds the last good answer
//
// The same rules as usePortalData and useMetrics, on purpose: pause while the tab
// is hidden (this page lives in a background tab for days), re-run the moment it
// is visible again, and never clear the last good answer on a failure - a stale
// card with working links beats an empty one. `tick` is the page's Refresh
// button: bumping it re-runs every source at once.

import { useEffect, useRef, useState } from 'react';

export type SourceState = 'off' | 'loading' | 'ok' | 'error';

export interface Source<T> {
  data: T | null;
  state: SourceState;
  error: unknown;
  /** When the last successful answer landed (ms), 0 before the first. */
  at: number;
}

const OFF = { data: null, state: 'off' as const, error: null, at: 0 };

export function usePolled<T>(
  load: (signal: AbortSignal) => Promise<T>,
  opts: { enabled: boolean; everyMs: number; tick: number },
): Source<T> {
  const [src, setSrc] = useState<Source<T>>(opts.enabled ? { ...OFF, state: 'loading' } : OFF);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!opts.enabled) { setSrc(OFF); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let ac: AbortController | null = null;

    const schedule = () => {
      clearTimeout(timer);
      if (!document.hidden) timer = setTimeout(run, opts.everyMs);
    };
    const run = async () => {
      ac?.abort();
      ac = new AbortController();
      const mine = ac;
      try {
        const data = await loadRef.current(mine.signal);
        if (cancelled || mine.signal.aborted) return;
        setSrc({ data, state: 'ok', error: null, at: Date.now() });
      } catch (error) {
        if (cancelled || mine.signal.aborted) return;
        setSrc((prev) => ({ ...prev, state: 'error', error }));
      } finally {
        if (!cancelled && !mine.signal.aborted) schedule();
      }
    };
    const onVisible = () => { if (!document.hidden) run(); };

    setSrc((prev) => (prev.state === 'off' ? { ...prev, state: 'loading' } : prev));
    document.addEventListener('visibilitychange', onVisible);
    run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      ac?.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [opts.enabled, opts.everyMs, opts.tick]);

  return src;
}
