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
import { allPorts, merge, repoRootsOf, type Container, type PortRow, type Router, type PortalNode, type Service } from './discover';
import { withDeclared, type CollectorPayload, type CollectorProject } from './projects';
import type { RootPaths } from './config';

// /system/df - per-image / per-container / per-volume disk usage. Read-only,
// carries no Env (see edge/dynamic/portal-api.yml). Purely additive enrichment:
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

export interface LoadError {
  src: string;
  e: unknown;
}

export interface PortalData {
  routers: Router[];
  nodes: PortalNode[];
  ports: PortRow[];
  /** bothy-config's roots, root name -> host path, read off its bind mounts.
   *  A whole-poll fact like `nodes` and `ports`: it comes from ONE container and
   *  is then the answer for every system the page renders, so it is resolved
   *  where the container list already is rather than re-derived per card. The
   *  card that needs it (SystemName) only ever sees ITS OWN system's nodes, and
   *  bothy-config is usually not one of them. */
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

export async function loadAll(): Promise<LoadResult> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
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
      // Safe against the boundary in edge/dynamic/portal-api.yml: that rule is
      // Path(`/-/api/docker/containers/json`), and Path() matches the PATH, so a
      // query string neither widens nor bypasses it - verified by requesting it
      // and getting 34 back through the same route that returns 21 without it.
      // The socket proxy's CONTAINERS=1 already covers this endpoint, and POST=0
      // still blocks every mutating call.
      getJSON<Container[]>('/-/api/docker/containers/json?all=1', ac.signal),
      getJSON<SystemDf>('/-/api/docker/system/df', ac.signal),
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
    // Deliberately NOT pushed to `errors`: a box with no collector installed is
    // a supported configuration, and flagging it would put a permanent warning
    // on the page for a feature nobody asked for.
    const P = projects.status === 'fulfilled' ? projects.value : null;
    if (!R.length && !C.length) throw new Error('both APIs unreachable');
    return {
      routers: R,
      nodes: withDeclared(merge(R, S, C), P?.projects ?? []),
      ports: allPorts(C),
      // The service key in apps/bothy-config/compose.yml. Named rather than
      // matched loosely on purpose - see the RootPaths comment in config.ts.
      configRoots: repoRootsOf(C, 'bothy-config'),
      df: D,
      projects: P?.projects ?? [],
      projectsAt: P?.generatedAt ?? null,
      errors,
    };
  } finally {
    clearTimeout(t);
  }
}

// ── polling hook ────────────────────────────────────────────────────────────
// Poll every 10s; pause when document.hidden; refresh immediately on focus/
// visibility; back off to 60s after 3 consecutive failures. Never clears data
// on failure - a stale page with working links beats a blank one.
export function usePortalData(): { data: PortalData; refresh: () => void } {
  const [data, setData] = useState<PortalData>(EMPTY);
  const failsRef = useRef(0);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      clearTimeout(timer);
      if (document.hidden) return; // this page lives in a background tab for days
      timer = setTimeout(run, failsRef.current >= MAX_BACKOFF ? POLL_FAIL : POLL_OK);
    };

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

    refreshRef.current = () => {
      if (!cancelled) run();
    };

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
