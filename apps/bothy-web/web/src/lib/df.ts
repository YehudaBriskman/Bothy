// /-/api/docker/system/df - the disk measurement, and the four states it can be
// in. IMPORTS NOTHING, like every module the checks hold a truth table against
// (checks/loading-states.mjs § D compiles this file and asserts the table).
//
// ── why this is its own module (2026-10-11) ─────────────────────────────────
//
// It used to be the fifth member of loadAll()'s Promise.allSettled, which made
// its budget a first-paint budget. The comment in api.ts said so in capitals and
// then drew the only conclusion that shape allows:
//
//   "8s, NOT something generous. allSettled waits for all five, and `data`
//    starts empty, so this call gates FIRST PAINT - a long budget here would
//    mean the whole page waits on the one request the comment below calls least
//    critical."
//
// That was right about the trade and wrong about having to make it. The budget
// was sized against a measured 1.7s; by 2026-10-07 the call took 2.0-10.2s, and
// on 2026-10-11 the owner's Overview said "Volume sizes could not be read" for a
// 41.6 GB minikube volume holding 31 GB of dead build cache. The call had
// outgrown 8s - which is exactly what the comment predicted ("that cost grows
// with the box") - and the cost is a property of the BOX, so it will outgrow any
// number written here.
//
// Measured on this box, 2026-10-11, AFTER that volume was pruned:
//
//   GET /system/df              4.35s, 4.59s, 4.79s   (three calls, idle daemon)
//   GET /containers/json?all=1  0.18s, 0.20s
//
// So even with nothing wrong, the call sits at a bit over HALF the 8s budget it
// is policed by, and twenty-five times the cost of the list calls it was racing.
// (`docker system df` on the CLI answers in 2.27s - a different number for a
// different code path. The browser lives with the API's.)
//
// The fix is not a bigger number inside the gate. It is taking the measurement
// out of the gate: the page paints on the four list calls, this one lands when
// it lands, and the panel says which state it is in. Then the budget can be
// generous without anybody waiting on it.
//
// ── the cadence is deliberately UNCHANGED ───────────────────────────────────
//
// Not more often, for the reason api.ts records at length: every container
// healthcheck on this box runs through `docker exec`, which needs the same
// daemon, and a /system/df every 10s made Traefik go unhealthy four times in a
// row while it was routing perfectly. One page's disk panel made the whole box
// look sick.
//
// So: still at most one measurement per DF_EVERY (120s), still paused while the
// tab is hidden. Two things got QUIETER on the way through:
//
//   · a FAILED attempt used to retry on the next 10s poll, because the cache was
//     only written on success - so the one state where the daemon is already
//     struggling was the state that asked it hardest. A failure now waits the
//     full DF_EVERY like a success does.
//   · the global Refresh button used to `force` a measurement AND await it, so
//     the button stayed in its loading state for the length of the slowest call
//     on the page. It still asks for one; it no longer waits (lib/data.tsx).

export interface DfVolume {
  Name?: string;
  UsageData?: { Size?: number; RefCount?: number };
}
export interface DfContainer {
  Id?: string;
  Names?: string[];
  SizeRw?: number;
  SizeRootFs?: number;
}
export interface DfImage {
  RepoTags?: string[];
  Size?: number;
  SharedSize?: number;
}
export interface SystemDf {
  LayersSize?: number;
  Images?: DfImage[];
  Containers?: DfContainer[];
  Volumes?: DfVolume[];
}

// GENEROUS, and it is allowed to be: nothing paints behind this. 30s is ~6x the
// 4.6s measured above and ~3x the worst ever seen (10.2s on 2026-10-07, mid
// build), so the budget stops being the thing that decides whether the panel has
// an answer. It is also a QUARTER of DF_EVERY, which is the property that keeps
// one measurement from ever meeting the next: an attempt is always settled, one
// way or the other, long before another is due.
export const DF_TIMEOUT = 30_000;

// Unchanged from when df was inside the poll. Disk usage changes when something
// is built, pulled or deleted - events on the scale of minutes.
export const DF_EVERY = 120_000;

/** Why an attempt failed, kept in a shape that can be said out loud. A bare
 *  boolean here is how "could not be read - the daemon did not answer in time"
 *  came to be printed for an HTTP 500 as well as for a timeout. */
export type DfFailure =
  | { kind: 'timeout'; afterMs: number }
  | { kind: 'status'; status: number }
  | { kind: 'unreachable' };

/** What loadDf() rejected with, turned into something that can be said out loud.
 *
 *  Duck-typed on purpose: it reads `name` (loadDf aborts with a TimeoutError so
 *  its own budget is distinguishable from an unmount) and `status` (api.ts's
 *  HttpError), and classes everything else as never having reached the daemon.
 *  Keeping it here, with no imports, is what lets the truth table assert that an
 *  HTTP 500 is not reported as "did not answer in time" - which is what the old
 *  single sentence did. */
export function dfFailureOf(e: unknown, budgetMs: number = DF_TIMEOUT): DfFailure {
  const o = (e ?? {}) as { name?: unknown; status?: unknown };
  if (o.name === 'TimeoutError') return { kind: 'timeout', afterMs: budgetMs };
  if (typeof o.status === 'number') return { kind: 'status', status: o.status };
  return { kind: 'unreachable' };
}

/** Never measured · measuring now · measured (at a known time) · failed.
 *
 *  The four are exactly what the panel has to be able to say. `value` and `at`
 *  are orthogonal to the phase on purpose: a measurement that is being redone,
 *  and a measurement whose successor failed, both still have real numbers and a
 *  real age, and showing them with their age beats showing nothing. */
export type DfPhase = 'never' | 'measuring' | 'ok' | 'failed';

export interface DfState {
  phase: DfPhase;
  /** The last measurement that SUCCEEDED. Never cleared by a failure. */
  value: SystemDf | null;
  /** When that measurement landed (ms), null if there has never been one. */
  at: number | null;
  /** When the last attempt settled, whichever way. This is what the cadence is
   *  measured from, so a failing daemon is asked no more often than a healthy
   *  one - the old cache only recorded successes, and therefore retried a
   *  failure on the very next 10s poll. */
  attemptedAt: number | null;
  failure: DfFailure | null;
}

export const dfInitial = (): DfState => ({
  phase: 'never', value: null, at: null, attemptedAt: null, failure: null,
});

/** An attempt starts. Keeps `value`, `at` and `attemptedAt` - the panel goes on
 *  showing the last numbers with their age while the next ones are measured. */
export const dfStarted = (s: DfState): DfState => ({ ...s, phase: 'measuring' });

export const dfMeasured = (s: DfState, value: SystemDf, now: number): DfState => ({
  ...s, phase: 'ok', value, at: now, attemptedAt: now, failure: null,
});

/** A failure keeps the last good value. THE decision this module exists to hold:
 *  a measurement from four minutes ago, labelled "4m ago", is a better answer
 *  than an empty panel, because disk usage moves on the scale of builds. */
export const dfFailed = (s: DfState, failure: DfFailure, now: number): DfState => ({
  ...s, phase: 'failed', attemptedAt: now, failure,
});

/** How long until another measurement is due, in ms. 0 means now.
 *
 *  While one is in flight the answer is a full DF_EVERY: there is never a second
 *  concurrent /system/df, which is the storm this whole design avoids. */
export function dfDueIn(s: DfState, now: number, every: number = DF_EVERY): number {
  if (s.phase === 'measuring') return every;
  if (s.attemptedAt == null) return 0;
  return Math.max(0, s.attemptedAt + every - now);
}

export const dfDue = (s: DfState, now: number, every: number = DF_EVERY): boolean =>
  dfDueIn(s, now, every) === 0;

/** `47s` / `4m` / `2h` / `3d`. One place, so the panel and the footer agree. */
export function dfAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** The whole sentence, for a panel with no numbers to draw. */
export function dfWhy(f: DfFailure): string {
  if (f.kind === 'timeout') return `the daemon did not answer within ${Math.round(f.afterMs / 1000)}s`;
  if (f.kind === 'status') return `the daemon answered ${f.status}`;
  return 'the request never reached the daemon';
}

/** The same fact in a footer's worth of words. */
export function dfWhyShort(f: DfFailure): string {
  if (f.kind === 'timeout') return 'timed out';
  if (f.kind === 'status') return `answered ${f.status}`;
  return 'did not reach the daemon';
}

export interface DfReport {
  phase: DfPhase;
  /** There are numbers to draw - possibly from an earlier attempt. */
  hasNumbers: boolean;
  /** Those numbers are not from the latest attempt. */
  stale: boolean;
  /** The panel header's chip when there is no size to put there; null means
   *  "the caller has a real total, show that". */
  meta: string | null;
  /** The one sentence for a panel with nothing to draw, and the Loader's label
   *  while it measures. Null when the numbers speak for themselves. */
  message: string | null;
  /** Where the numbers came from and when. NEVER empty and never a guess -
   *  "nearly silent by design" is the half of the bug this replaces. */
  provenance: string;
  /** Offering a re-measure while one is running is a button that does nothing. */
  canMeasure: boolean;
}

/** What the panel says, in every state. Pure, so the words are a truth table
 *  rather than six branches spread through a component. */
export function dfReport(s: DfState, now: number): DfReport {
  const age = s.at == null ? null : dfAge(now - s.at);
  const tried = s.attemptedAt == null ? null : dfAge(now - s.attemptedAt);
  const measured = age == null ? 'never measured' : `measured ${age} ago`;

  if (s.phase === 'measuring') {
    return {
      phase: 'measuring',
      hasNumbers: s.value != null,
      stale: s.value != null,
      meta: s.value == null ? 'measuring' : null,
      message: 'Measuring volume sizes…',
      provenance: s.value == null ? 'measuring now' : `${measured} · measuring again`,
      canMeasure: false,
    };
  }
  if (s.phase === 'failed') {
    const why = s.failure ? dfWhy(s.failure) : 'the attempt failed';
    const short = s.failure ? dfWhyShort(s.failure) : 'failed';
    return {
      phase: 'failed',
      hasNumbers: s.value != null,
      stale: s.value != null,
      meta: s.value == null ? 'no sizes' : null,
      message: `Volume sizes could not be measured - ${why}.`,
      provenance: s.value == null
        ? `never measured · last tried ${tried} ago, ${short}`
        : `${measured} · the attempt ${tried} ago ${short}`,
      canMeasure: true,
    };
  }
  if (s.phase === 'ok') {
    return {
      phase: 'ok', hasNumbers: true, stale: false, meta: null, message: null,
      provenance: measured, canMeasure: true,
    };
  }
  return {
    phase: 'never', hasNumbers: false, stale: false, meta: 'not measured',
    message: 'Volume sizes have not been measured yet.',
    provenance: 'never measured', canMeasure: true,
  };
}
