// Data layer. Two same-origin, read-only APIs under /-/api/* (Traefik serves
// them, not this SPA), so there is no CORS and no keys.
//
//   GET /-/api/traefik/http/routers    - the SKELETON
//   GET /-/api/traefik/http/services   - server targets for the join
//   GET /-/api/docker/containers/json  - ENRICHMENT (ports, health, labels)
//
// Either API can fail and the page must still render: Traefik is the skeleton,
// Docker is enrichment. allSettled, never all - partial results are first-class.

import { useEffect, useRef, useState } from 'react';
import { allPorts, configRootsOf, merge, placeOf, type Container, type PortRow, type Router, type PortalNode, type Service } from './discover';
import { withDeclared, type CollectorPayload, type CollectorProject } from './projects';
import type { RootPaths } from './config';
import { readData } from './prefs';

// /system/df - per-image / per-container / per-volume disk usage. Read-only,
// carries no Env (see edge/dynamic/bothy-api.yml). Purely additive enrichment:
// if it fails, the "Data & disk" card falls back to volume names without sizes.
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

export const POLL_OK = 10_000;
export const POLL_FAIL = 60_000;
export const MAX_BACKOFF = 3;
const FETCH_TIMEOUT = 5000;
// /system/df GETS ITS OWN, LONGER BUDGET, and it is the only call that needs
// one. Measured on this box: containers/json answers in 85ms, /system/df in
// 1.7s - twenty times slower, because it walks every image layer, container and
// volume rather than reading a list. That cost grows with the box and spikes
// while an image is building, and all five requests used to share one 5s
// AbortController - so the most expensive call was policed by a budget sized
// for the cheap ones, and lost the race first.
//
// Its failure is nearly silent by design (see loadAll), which is what let this
// go unnoticed: the page kept working and the disk panel just stopped knowing
// anything.
//
// 8s, NOT something generous. allSettled waits for all five, and `data` starts
// empty, so this call gates FIRST PAINT - a long budget here would mean the
// whole page waits on the one request the comment below calls least critical.
// 8s is ~4.7x the measured cost and still under POLL_OK, so a slow df can never
// become the thing you are waiting for. If it does time out the panel now says
// so in words instead of claiming the box has no volumes.
const DF_TIMEOUT = 8000;

// AND IT IS NOT ON THE TEN-SECOND LOOP AT ALL (2026-10-07).
//
// The budget above was sized against a measured 1.7s. On 2026-10-07 the same
// call took **2.0-10.2s**, because the cost it warned about - "grows with the
// box" - did exactly that: 93 images, 28 containers, 19 volumes, every layer of
// every one of them walked on every request.
//
// At a 10s poll and a ~10s answer, the next request left before the last one
// landed. dockerd was never idle, and that is not a portal problem: EVERY
// container's healthcheck runs through `docker exec`, which needs the same busy
// daemon. Traefik's healthcheck (a 3s timeout on a ping that answers in
// milliseconds) went unhealthy four times in a row while Traefik itself was
// routing perfectly - measured: the ping returns OK in 0.0s run directly, and
// `docker exec` into the same container took 1.4-1.7s. One page's disk panel
// was making the whole box look sick.
//
// So df gets its own cadence, and a slow one. Disk usage changes when something
// is built, pulled or deleted - events on the scale of minutes, not of a poll
// loop. Between refreshes the last answer is reused, which is why the panel does
// not flicker; `force` skips the cache so the Refresh button still means "now".
//
// The other four calls stay on POLL_OK. They are lists, they answer in ~85ms,
// and the whole point of this split is that the expensive one stopped setting
// the pace for them.
const DF_EVERY = 120_000;
let dfCache: { at: number; value: SystemDf } | null = null;

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
  df: SystemDf | null;
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
  routers: [], nodes: [], ports: [], configRoots: {}, df: null, projects: [],
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
  df: SystemDf | null;
  projects: CollectorProject[];
  projectsAt: number | null;
  errors: LoadError[];
}

export async function loadAll(force = false): Promise<LoadResult> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
  const dfAc = new AbortController();
  const dfT = setTimeout(() => dfAc.abort(), DF_TIMEOUT);
  // The cached df is reused until it ages out (DF_EVERY). `Promise.resolve` so
  // the allSettled shape below is identical either way - a cached read must not
  // become a second code path through the join.
  const dfFresh = force || !dfCache || Date.now() - dfCache.at >= DF_EVERY;
  const dfReq = dfFresh
    ? getJSON<SystemDf>('/-/api/docker/system/df', dfAc.signal)
    : Promise.resolve(dfCache!.value);
  try {
    // allSettled, not all: partial results are first-class. Traefik is the
    // skeleton, docker is enrichment - either can die alone. df is the LEAST
    // critical: a pure size overlay, its failure never removes a service.
    const [routers, services, containers, df, projects] = await Promise.allSettled([
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
      dfReq,
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
    // df failing is intentionally silent-ish: record it, but never let it fail
    // the load. Sizes just don't render.
    const D = df.status === 'fulfilled' ? df.value : (errors.push({ src: 'docker df', e: df.reason }), null);
    // Cache only a FRESH success. Re-stamping `at` on a cache hit would hold a
    // stale answer forever, since every poll would renew the thing it just read.
    if (dfFresh && D) dfCache = { at: Date.now(), value: D };
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
      df: D,
      projects: P?.projects ?? [],
      projectsAt: P?.generatedAt ?? null,
      errors,
    };
  } finally {
    clearTimeout(t);
    clearTimeout(dfT);
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

    // `force` reaches loadAll's df cache: a scheduled poll reuses it, an
    // explicit Refresh does not. Pressing Refresh and being handed a
    // two-minute-old number is the one case the cache must not cover.
    const run = async (force = false) => {
      try {
        const d = await loadAll(force);
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
    refreshRef.current = () => (cancelled ? Promise.resolve() : run(true));

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
