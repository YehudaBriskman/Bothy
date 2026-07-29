// Data layer. Two same-origin, read-only APIs under /-/api/* (Traefik serves
// them, not this SPA), so there is no CORS and no keys.
//
//   GET /-/api/traefik/http/routers    — the SKELETON
//   GET /-/api/traefik/http/services   — server targets for the join
//   GET /-/api/docker/containers/json  — ENRICHMENT (ports, health, labels)
//
// Either API can fail and the page must still render: Traefik is the skeleton,
// Docker is enrichment. allSettled, never all — partial results are first-class.

import { useEffect, useRef, useState } from 'react';
import { allPorts, merge, type Container, type PortRow, type Router, type PortalNode, type Service } from './discover';

// /system/df — per-image / per-container / per-volume disk usage. Read-only,
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
  df: SystemDf | null;
  errors: LoadError[];
  at: number;
  fails: number;
  // Rolling "services up" samples, one per successful poll, newest last. This is
  // the ONLY time series the portal has — nothing here is persisted or fetched
  // from a TSDB, so it starts empty and fills as the page stays open. Capped so
  // a tab left open for days can't grow without bound.
  history: number[];
}

export const HISTORY_MAX = 60;

const EMPTY: PortalData = {
  routers: [], nodes: [], ports: [], df: null, errors: [], at: 0, fails: 0, history: [],
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
  df: SystemDf | null;
  errors: LoadError[];
}

export async function loadAll(): Promise<LoadResult> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
  try {
    // allSettled, not all: partial results are first-class. Traefik is the
    // skeleton, docker is enrichment — either can die alone. df is the LEAST
    // critical: a pure size overlay, its failure never removes a service.
    const [routers, services, containers, df] = await Promise.allSettled([
      getJSON<Router[]>('/-/api/traefik/http/routers', ac.signal),
      getJSON<Service[]>('/-/api/traefik/http/services', ac.signal),
      getJSON<Container[]>('/-/api/docker/containers/json', ac.signal),
      getJSON<SystemDf>('/-/api/docker/system/df', ac.signal),
    ]);
    const errors: LoadError[] = [];
    const R = routers.status === 'fulfilled' ? routers.value : (errors.push({ src: 'traefik', e: routers.reason }), []);
    // A services failure is not fatal — merge() falls back to the label join —
    // but it silently turns the Routes tab's targets into guesses, so record it.
    const S = services.status === 'fulfilled' ? services.value : (errors.push({ src: 'traefik services', e: services.reason }), []);
    const C = containers.status === 'fulfilled' ? containers.value : (errors.push({ src: 'docker', e: containers.reason }), []);
    // df failing is intentionally silent-ish: record it, but never let it fail
    // the load. Sizes just don't render.
    const D = df.status === 'fulfilled' ? df.value : (errors.push({ src: 'docker df', e: df.reason }), null);
    if (!R.length && !C.length) throw new Error('both APIs unreachable');
    return { routers: R, nodes: merge(R, S, C), ports: allPorts(C), df: D, errors };
  } finally {
    clearTimeout(t);
  }
}

// ── polling hook ────────────────────────────────────────────────────────────
// Poll every 10s; pause when document.hidden; refresh immediately on focus/
// visibility; back off to 60s after 3 consecutive failures. Never clears data
// on failure — a stale page with working links beats a blank one.
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
        const up = d.nodes.filter((n) => n.status === 'up').length;
        setData((prev) => ({
          ...d,
          at: Date.now(),
          fails: 0,
          history: [...prev.history, up].slice(-HISTORY_MAX),
        }));
      } catch {
        if (cancelled) return;
        failsRef.current += 1;
        // Keep the last good data — only bump the failure counter.
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
