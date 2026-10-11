// Data layer. Two same-origin, read-only APIs under /-/api/* (Traefik serves
// them, not this SPA), so there is no CORS and no keys.
//
//   GET /-/api/traefik/http/routers    - the SKELETON
//   GET /-/api/traefik/http/services   - server targets for the join
//   GET /-/api/docker/containers/json  - ENRICHMENT (ports, health, labels)
//
// Either API can fail and the page must still render: Traefik is the skeleton,
// Docker is enrichment. allSettled, never all - partial results are first-class.
//
// FOUR CALLS, NOT FIVE (2026-10-11). /-/api/docker/system/df used to be the
// fifth, and that is what made its budget a first-paint budget: `data` starts
// empty, allSettled waits for the slowest, and the slowest was the one call this
// file calls least critical - 4.6s measured against the four lists' 0.18s. It
// now has its own module, its own generous budget and its own cadence
// (lib/df.ts), and the only thing left of it here is loadDf() - the fetch, kept
// beside its siblings so the route documentation stays in one place, and
// deliberately NOT called from loadAll().

import { useEffect, useRef, useState } from 'react';
import { allPorts, configRootsOf, merge, placeOf, type Container, type PortRow, type Router, type PortalNode, type Service } from './discover';
import { withDeclared, type CollectorPayload, type CollectorProject } from './projects';
import type { RootPaths } from './config';
import { readData } from './prefs';

// The Df types, the budget, the cadence and the state machine live in lib/df.ts
// (which imports nothing, so checks/loading-states.mjs holds a truth table
// against it). Imported here only for loadDf's return type.
import { DF_TIMEOUT, type SystemDf } from './df';

export const POLL_OK = 10_000;
export const POLL_FAIL = 60_000;
export const MAX_BACKOFF = 3;
const FETCH_TIMEOUT = 5000;
// The old /system/df budget and cadence comments are GONE from this file, with
// the call. They are not deleted: lib/df.ts carries the argument, the numbers
// re-measured on 2026-10-11, and the reason the cadence must not quicken (every
// container healthcheck on this box runs through `docker exec`, and a df every
// 10s made Traefik look unhealthy four times in a row while it was routing
// perfectly). What was wrong with them was never the reasoning - it was that
// they were reasoning about a request inside the first-paint gate.

export interface LoadError {
  src: string;
  e: unknown;
}

export interface PortalData {
  routers: Router[];
  nodes: PortalNode[];
  ports: PortRow[];
  /** The config forms' roots, root name -> host path, read off bothy-files' bind
   *  mounts and narrowed to [config].roots (configRootsOf in discover.ts).
   *  A whole-poll fact like `nodes` and `ports`: it comes from ONE container and
   *  is then the answer for every system the page renders, so it is resolved
   *  where the container list already is rather than re-derived per card. The
   *  card that needs it (SystemName) only ever sees ITS OWN system's nodes, and
   *  bothy-files is usually not one of them. */
  configRoots: RootPaths;
  // `df` IS NOT HERE any more (2026-10-11). Disk sizes are not a whole-poll
  // fact: they arrive on their own cadence, seconds after the page has painted,
  // and they carry their own age. Keeping them in this object is what put them
  // in the first-paint gate. lib/data.tsx exposes them beside `data` instead.
  // Projects that declared themselves via project.dev.yml, resolved against
  // host state by the collector. The only source that can report a project
  // which is switched off, or one running as plain host processes.
  projects: CollectorProject[];
  projectsAt: number | null;
  errors: LoadError[];
  at: number;
  fails: number;
  // `history` is GONE (2026-08-10). It was a 60-sample ring buffer of "services
  // up", appended once per successful poll and held only in the tab - the
  // portal's only time series before there was a real one. It fed a sparkline
  // that therefore read "collecting…" on every fresh load and could not answer
  // any question about a moment when the tab was closed. lib/metrics.ts now
  // queries Prometheus, which has actual history, so both were deleted rather
  // than left as a second, worse source of the same kind of answer.
}

const EMPTY: PortalData = {
  routers: [], nodes: [], ports: [], configRoots: {}, projects: [],
  projectsAt: null, errors: [], at: 0, fails: 0,
};

class HttpError extends Error {
  status: number;
  path: string;
  constructor(status: number, path: string) {
    super(String(status));
    this.status = status;
    this.path = path;
  }
}

async function getJSON<T>(path: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(path, { signal, cache: 'no-store' });
  if (!r.ok) throw new HttpError(r.status, path);
  return r.json() as Promise<T>;
}

export interface LoadResult {
  routers: Router[];
  nodes: PortalNode[];
  ports: PortRow[];
  configRoots: RootPaths;
  projects: CollectorProject[];
  projectsAt: number | null;
  errors: LoadError[];
}

// NO `force` PARAMETER any more: the only thing it ever did was skip the df
// cache, and df is not in here. Every call is one poll of four lists at ~0.2s,
// so there is nothing left for a caller to want more urgently.
export async function loadAll(): Promise<LoadResult> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
  try {
    // allSettled, not all: partial results are first-class. Traefik is the
    // skeleton, docker is enrichment - either can die alone. FOUR entries: the
    // disk measurement left this list on 2026-10-11 so the page stops waiting
    // on it (lib/df.ts).
    const [routers, services, containers, projects] = await Promise.allSettled([
      getJSON<Router[]>('/-/api/traefik/http/routers', ac.signal),
      getJSON<Service[]>('/-/api/traefik/http/services', ac.signal),
      // `?all=1` - stopped containers too, not just running ones.
      //
      // Without it the Docker API returns running containers only, so the page
      // could not distinguish "this project is switched off" from "this project
      // does not exist". 34 containers on this box, 21 running: without the flag
      // a third of what is here is unrepresentable.
      //
      // Safe against the boundary in edge/dynamic/bothy-api.yml: that rule is
      // Path(`/-/api/docker/containers/json`), and Path() matches the PATH, so a
      // query string neither widens nor bypasses it - verified by requesting it
      // and getting 34 back through the same route that returns 21 without it.
      // The socket proxy's CONTAINERS=1 already covers this endpoint, and POST=0
      // still blocks every mutating call.
      getJSON<Container[]>('/-/api/docker/containers/json?all=1', ac.signal),
      // Static file written by the host-side collector and bind-mounted into
      // this container - NOT an /-/api/* route, so it needs no edge config and
      // its absence (collector not installed yet) is a normal, silent no-op.
      getJSON<CollectorPayload>('/data/projects.json', ac.signal),
    ]);
    const errors: LoadError[] = [];
    const R = routers.status === 'fulfilled' ? routers.value : (errors.push({ src: 'traefik', e: routers.reason }), []);
    // A services failure is not fatal - merge() falls back to the label join -
    // but it silently turns the Routes tab's targets into guesses, so record it.
    const S = services.status === 'fulfilled' ? services.value : (errors.push({ src: 'traefik services', e: services.reason }), []);
    const C = containers.status === 'fulfilled' ? containers.value : (errors.push({ src: 'docker', e: containers.reason }), []);
    // A df failure no longer lands in `errors` either, because it is no longer
    // this poll's business. It used to read "docker df unreachable" in the
    // freshness pill on EVERY page - a whole-app degradation badge for one
    // panel's enrichment - while the panel itself said nothing. That was the
    // wrong way round, and it is now the other way round: the panel states
    // which of its four states it is in, loudly, and the pill stays about
    // whether discovery is working.
    // Deliberately NOT pushed to `errors`: a box with no collector installed is
    // a supported configuration, and flagging it would put a permanent warning
    // on the page for a feature nobody asked for.
    const P = projects.status === 'fulfilled' ? projects.value : null;
    if (!R.length && !C.length) throw new Error('both APIs unreachable');
    return {
      routers: R,
      // The placement file rides in projects.json; null when the collector has
      // none, which leaves every group exactly where the defaults put it.
      nodes: withDeclared(merge(R, S, C, P?.placement ?? null), P?.projects ?? [],
        (subject, kind, system) => placeOf(P?.placement ?? null, subject, {}, kind, system)),
      ports: allPorts(C, P?.placement ?? null),
      // bothy-files' mounts, narrowed to the one root the forms accept. Named
      // rather than matched loosely on purpose - see RootPaths in config.ts.
      configRoots: configRootsOf(C),
      projects: P?.projects ?? [],
      projectsAt: P?.generatedAt ?? null,
      errors,
    };
  } finally {
    clearTimeout(t);
  }
}

// The disk measurement, on its own. One request, its OWN budget (DF_TIMEOUT,
// 30s - generous, because nothing paints behind it), and a rejection a caller
// can tell apart: the abort carries a TimeoutError so the panel can say "the
// daemon did not answer within 30s" rather than guessing which failure it was.
//
// `outer` is the caller's lifetime (the hook unmounting, or asking again). The
// two signals are linked by hand rather than with AbortSignal.any so the reason
// survives - any() reports its own AbortError and loses which one fired.
export async function loadDf(outer: AbortSignal): Promise<SystemDf> {
  const ac = new AbortController();
  const stop = () => ac.abort(outer.reason);
  outer.addEventListener('abort', stop);
  const t = setTimeout(
    () => ac.abort(new DOMException(`/system/df exceeded ${DF_TIMEOUT}ms`, 'TimeoutError')),
    DF_TIMEOUT,
  );
  try {
    return await getJSON<SystemDf>('/-/api/docker/system/df', ac.signal);
  } finally {
    clearTimeout(t);
    outer.removeEventListener('abort', stop);
  }
}

// ── polling hook ────────────────────────────────────────────────────────────
// Poll every 10s; pause when document.hidden; refresh immediately on focus/
// visibility; back off to 60s after 3 consecutive failures. Never clears data
// on failure - a stale page with working links beats a blank one.
export function usePortalData(): { data: PortalData; refresh: () => Promise<void> } {
  const [data, setData] = useState<PortalData>(EMPTY);
  const failsRef = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      clearTimeout(timer);
      if (document.hidden) return; // this page lives in a background tab for days
      // The healthy interval is Settings > Data & refresh, read per schedule so
      // a change applies on the next poll without a reload. POLL_OK stays the
      // documented default (DATA_DEFAULT agrees); the backoff is not configurable.
      timer = setTimeout(run, failsRef.current >= MAX_BACKOFF ? POLL_FAIL : readData().pollSeconds * 1000);
    };

    // No `force` any more. This poll has nothing cached to skip: the four lists
    // are re-read every time, and the one call that WAS cached (/system/df) is
    // asked for separately by lib/data.tsx's Refresh, which does not wait for it.
    const run = async () => {
      try {
        const d = await loadAll();
        if (cancelled) return;
        failsRef.current = 0;
        setData(() => ({
          ...d,
          at: Date.now(),
          fails: 0,
        }));
      } catch {
        if (cancelled) return;
        failsRef.current += 1;
        // Keep the last good data - only bump the failure counter.
        setData((prev) => ({ ...prev, fails: failsRef.current }));
      } finally {
        if (!cancelled) schedule();
      }
    };

    // Returns the poll it started, so a Refresh button can show the Loader
    // until the answer lands (pages/control/ControlHome.tsx) - and no longer.
    refreshRef.current = () => (cancelled ? Promise.resolve() : run());

    const onVisibility = () => {
      if (!document.hidden) run();
    };
    const onFocus = () => run();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    run();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return { data, refresh: () => refreshRef.current() };
}
