// ONE poll for the whole app. usePortalData() opens a single 10s polling loop;
// lifting it into context means every route/page shares that one loop instead of
// each mounting its own (which would multiply the socket-proxy load and desync
// the freshness pill between pages).
//
// TWO CADENCES SINCE 2026-10-11, and that is the point of this file now. The
// discovery poll is four list calls at ~0.2s, every 10s, and the page's first
// paint waits on it. The disk measurement is ONE call at ~4.6s, at most every
// 120s, and NOTHING waits on it - it arrives seconds after the page is usable
// and the panel that draws it says how old it is. They are deliberately not one
// object: while they were, the slow one set the budget for the fast ones and the
// Overview told the owner "Volume sizes could not be read" because a 41.6 GB
// volume had pushed one request a fraction past 8s (see lib/df.ts).

import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePortalData, loadDf, type PortalData } from './api';
import {
  DF_EVERY, dfDueIn, dfFailed, dfFailureOf, dfInitial, dfMeasured, dfStarted, type DfState,
} from './df';

interface PortalCtx {
  data: PortalData;
  /** Re-poll now; settles when that poll has answered or failed. */
  refresh: () => Promise<void>;
  /** The disk measurement and which of its four states it is in. */
  df: DfState;
  /** Ask for a measurement now. Returns immediately - NOTHING waits on this,
   *  which is the whole fix; the panel shows `measuring` while it runs. A call
   *  while one is already in flight is a no-op. */
  measureDf: () => void;
}

const Ctx = createContext<PortalCtx | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const { data, refresh } = usePortalData();
  const { df, measureDf } = useDiskUsage();
  // Refresh means "now" for everything on the page, so it asks for a
  // measurement too - and does not await it. The old code awaited it, which is
  // how pressing Refresh came to hold the button's Loader for the length of the
  // slowest call in the app; and it skipped the 120s cache on every press,
  // which on a daemon that is already slow is the one input you do not want
  // under a repeatable click. measureDf() ignores a press while one is running.
  const both = useCallback(async () => { measureDf(); await refresh(); }, [measureDf, refresh]);
  return <Ctx.Provider value={{ data, refresh: both, df, measureDf }}>{children}</Ctx.Provider>;
}

// ── the disk measurement's own loop ─────────────────────────────────────────
//
// Why not components/control-home/usePolled.ts, which is the same four states:
// it re-runs the moment the tab becomes visible, by design, and for THIS call
// that is a new poll by the back door - every alt-tab back to the page would
// walk every image layer on the box. Here, becoming visible only asks whether a
// measurement is DUE (dfDueIn), which is the rule the whole design turns on.
// The other difference is the budget: this is the one call in the app with its
// own, and 30s inside a hook that aborts on re-run would be 30s of a signal
// nobody is watching.
function useDiskUsage(): { df: DfState; measureDf: () => void } {
  const [df, setDf] = useState<DfState>(dfInitial);
  // The state as the timers see it. `df` in a closure would be the value from
  // the render that armed the timer, and the cadence would be computed off a
  // measurement two minutes out of date.
  const ref = useRef<DfState>(df);
  const set = (next: DfState) => { ref.current = next; setDf(next); };
  const inFlight = useRef<AbortController | null>(null);
  const runRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(pulse, Math.max(0, ms));
    };

    // Asks the question rather than acting: is one due? A pulse while the tab is
    // hidden does nothing at all and re-arms nothing - the visibility listener
    // is what starts it again, so a backgrounded tab costs the daemon zero.
    const pulse = () => {
      if (cancelled || document.hidden) return;
      const due = dfDueIn(ref.current, Date.now());
      if (due > 0) { arm(due); return; }
      run();
    };

    const run = () => {
      if (cancelled || inFlight.current) return;
      const ac = new AbortController();
      inFlight.current = ac;
      set(dfStarted(ref.current));
      loadDf(ac.signal).then(
        (value) => { if (!cancelled && !ac.signal.aborted) set(dfMeasured(ref.current, value, Date.now())); },
        (e) => { if (!cancelled && !ac.signal.aborted) set(dfFailed(ref.current, dfFailureOf(e), Date.now())); },
      ).finally(() => {
        if (inFlight.current === ac) inFlight.current = null;
        // A failure waits exactly as long as a success. The old cache was
        // written only on success, so a failing daemon was re-asked on the next
        // 10s poll - hardest, at the moment it was least able to answer.
        if (!cancelled) arm(DF_EVERY);
      });
    };

    runRef.current = run;
    const onVisible = () => { if (!document.hidden) pulse(); };
    document.addEventListener('visibilitychange', onVisible);
    pulse();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      inFlight.current?.abort();
      inFlight.current = null;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // A press is honoured whatever the cadence says - the person asking is looking
  // at the age on screen and has decided it is too old. It is bounded by the one
  // thing that actually protects the daemon: never two at once.
  const measureDf = useCallback(() => { runRef.current(); }, []);
  return { df, measureDf };
}

export function usePortal(): PortalCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePortal() must be used inside <DataProvider>');
  return v;
}

// Derived helpers shared across pages. Kept here so the health maths is computed
// one way everywhere (Overview tiles, project rollups, the "needs attention"
// list all agree).

export interface HealthCounts {
  total: number;
  up: number;
  down: number;
  starting: number;
  stopped: number;
  /** One-shots that ran to completion. A success, and never a fault. */
  done: number;
  /** Exited a fortnight or more ago with nothing of their project running. */
  dormant: number;
  unknown: number;
}

export function healthOf(nodes: { status: string }[]): HealthCounts {
  const c: HealthCounts = {
    total: nodes.length, up: 0, down: 0, starting: 0, stopped: 0, done: 0, dormant: 0, unknown: 0,
  };
  for (const n of nodes) {
    if (n.status === 'up') c.up++;
    else if (n.status === 'down') c.down++;
    else if (n.status === 'starting') c.starting++;
    else if (n.status === 'stopped') c.stopped++;
    else if (n.status === 'done') c.done++;
    else if (n.status === 'dormant') c.dormant++;
    else c.unknown++;
  }
  return c;
}

// Services that are meant to be up right now. A deliberately-stopped service is
// not part of the denominator: with it in, switching a project off dragged the
// healthy % down and made an idle box look broken.
//
// `done` and `dormant` leave it for the same reason and more strongly. A
// one-shot that finished is not something that failed to be up - counting
// `keycloak-db-init` against the box's health meant the strip reported a fault
// on every single deploy, forever. A container from a project nobody has run in
// six weeks is not a service at all any more.
//
// RESTS ON THE PARTITION, so it cannot silently start subtracting something
// twice: every node has exactly one status, and this subtracts the three that
// are not claims about whether something should be running.
export const expectedUp = (c: HealthCounts) => c.total - c.stopped - c.done - c.dormant;

/** The three statuses that are NOT a claim about whether a thing should be up:
 *  shown, countable, and deliberately outside every health measurement. */
export const notExpected = (c: HealthCounts) => c.stopped + c.done + c.dormant;

// "Needs attention" - anything a human should actually look at.
//
// Two things used to land here that are not problems:
//   1. every stopped container, because statusOf() collapsed exited(0) into
//      'down' (fixed at the source in discover.ts), and
//   2. orphan routes belonging to a system that is entirely switched off - the
//      four `tals.<base-domain>` file-routes point at host processes, so stopping Tals
//      "orphaned" all four at once and each one shouted.
// An orphan route still matters when the rest of its system is up (that IS the
// route-with-no-backend case portal.md wants shouted about), so the rule is
// scoped to the system rather than dropped.
//
//   3. (2026-08-12) A `down` container inside a system where NOTHING is
//      running. The same mistake as 2, reached from the other direction, and it
//      appeared the moment discovery started reporting stopped containers:
//      `monorepo-inherited-channellink-1` exited 255 two days ago while its
//      three siblings exited 0, i.e. somebody switched the project off and one
//      container was untidy on the way out. Shouting about it every day since
//      is not a fault report, it is a fault report's ghost.
//
//      A non-zero exit inside a LIVE system is still a real fault and still
//      shouts - that distinction is the whole rule, and it is why this is scoped
//      by system rather than by "is it old".
//   4. (2026-09-23) Anything `done` or `dormant`. Both are now their own status
//      rather than a flavour of stopped/down, and neither can ever be an alert:
//      `done` is a one-shot reporting success, `dormant` is a container that has
//      not run in a fortnight in a project with nothing running. Stated here as
//      an explicit refusal rather than left to fall out of the filters below,
//      because "it happens not to match any rule today" is not a guarantee.
export function needsAttention(nodes: import('./discover').PortalNode[]): import('./discover').PortalNode[] {
  const liveGroups = new Set(
    nodes.filter((n) => n.status === 'up' || n.status === 'starting').map((n) => n.group),
  );
  return nodes.filter((n) => {
    if (n.status === 'done' || n.status === 'dormant') return false;
    // Both cases now ask the same question: is anything in this system alive?
    // If the whole system is off, its wreckage is not news.
    if (n.status === 'down') return liveGroups.has(n.group);
    if (n.kind !== 'orphan-route') return false;
    return liveGroups.has(n.group);
  });
}
