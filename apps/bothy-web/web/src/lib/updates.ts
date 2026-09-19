// Settings > Updates - bothy-ops updates.py, behind `viewer`.
//
//   GET /-/api/updates/status   the update catalog merged with what the host's
//                               discovery timer last found (available.json)
//
// apps/bothy-ops/checks/wiring_updates.py asserts this file names exactly that
// one path. It is a READ: build step 3 of docs/plans/updates.md is discovery and
// this page; nothing here, or behind it, applies anything.
//
// The shapes below are the service's ALLOW-LIST, restated: updates.py copies the
// host's file field by field, and drops anything that is not one of these.
//
// In `vite dev` every call goes to lib/updates.dev.ts, for the reason every other
// *.dev.ts exists: the dev server proxies /-/api/* at the live box and holds no
// session cookie for it.

import { apiFetch } from './http';

export type Level = 'patch' | 'minor' | 'major';
export type Channel = 'auto' | 'notify' | 'manual';
export const LEVELS: readonly Level[] = ['patch', 'minor', 'major'];

export interface VersionRef {
  tag: string;
  version: string | null;
  digest: string | null;
  level?: Level;
  publishedAt?: string;
  /** The pin's own floating tag (`v3.7`, `17`), moved upstream to a newer image. */
  floating?: boolean;
}

export interface RunningRef {
  name: string;
  image: string | null;
  digest: string | null;
  state: string | null;
}

export interface Discovered {
  checkedAt: string | null;
  error: string | null;
  image: string | null;
  current: {
    tag: string | null;
    version: string | null;
    digest: string | null;
    float: boolean;
    /** For a floating pin: the release the tag names upstream now (`v3.7.13`). */
    floatTarget: string | null;
    /** For a digest-only pin: the release tag that digest turned out to be. */
    identifiedAs: string | null;
  };
  running: RunningRef[];
  runningVersion: string | null;
  drift: string | null;
  /** Facts, not faults: "the cluster did not answer - running version unknown". */
  notes: string[];
  floatMoved: boolean | null;
  latest: VersionRef | null;
  candidates: Partial<Record<Level, VersionRef>>;
}

export interface UpdateRow {
  id: string;
  title: string;
  class: string;
  source: 'image' | 'manifest' | 'helm' | 'github';
  pins: string[];
  apply: string;
  dependants: string[];
  channel: Channel;
  oneWay: boolean;
  oneWayWhy: string | null;
  verify: string[];
  changelog: string;
  /** The largest step on offer, or null when nothing newer was found. */
  level: Level | null;
  /** What that step would get under the policy: auto is patch-only, any major is manual. */
  effectiveChannel: Channel | null;
  /** A minor or more behind - what the Settings nav counts. */
  behind: boolean;
  discovered: Discovered | null;
}

export interface UpdatesStatus {
  discovery: {
    present: boolean;
    generatedAt: string | null;
    ageSeconds: number | null;
    stale: boolean;
    hint: string | null;
  };
  summary: { components: number; updates: number; behind: number; drift: number; errors: number };
  policy: {
    windowStart: string;
    windowEnd: string;
    requireBackup: string;
    requireDoctor: boolean;
    maxAutoPerNight: number;
    pauseOnFailure: boolean;
    discoverEveryHours: number;
  };
  /** Always false in step 3: nothing applies updates yet. */
  applying: boolean;
  components: UpdateRow[];
}

const WIRE = {
  refused: (status: number) => `refused with ${status}`,
  notService: 'answered by something that is not bothy-ops - the updates route may not be deployed yet',
};

export async function fetchUpdates(signal?: AbortSignal): Promise<UpdatesStatus> {
  if (import.meta.env.DEV) return (await import('./updates.dev')).updatesMock();
  return apiFetch<UpdatesStatus>('/-/api/updates/status', { signal, ...WIRE });
}

/** The file a pin lives in, without the service: `monitoring/compose.yml`. */
export const pinFile = (pin: string): string => pin.split(':')[0];

// ── the count on the Settings nav ────────────────────────────────────────────
//
// How many components are a minor or more behind. Fetched at most once per
// quarter hour per tab, and shared: the Settings sidebar and the person menu both
// show it, and the Updates page itself refreshes it when it loads. One request per
// open, not per render - every read of the route is an audit line.

const TTL_MS = 15 * 60_000;
let cached: { at: number; n: number | null } | null = null;
let inflight: Promise<number | null> | null = null;
const listeners = new Set<(n: number | null) => void>();

export function publishBehind(n: number | null): void {
  cached = { at: Date.now(), n };
  listeners.forEach((f) => f(n));
}

/** The cached count, or null when unknown (not signed in, not deployed, failed). */
export function behindNow(): number | null {
  return cached ? cached.n : null;
}

export function loadBehind(): Promise<number | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.n);
  inflight ??= fetchUpdates()
    .then((s) => s.summary.behind)
    // A refusal is not a count. The badge simply does not draw.
    .catch(() => null)
    .then((n) => { publishBehind(n); inflight = null; return n; });
  return inflight;
}

export function onBehind(f: (n: number | null) => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}
