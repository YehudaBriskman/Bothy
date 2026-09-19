// Settings > Updates - bothy-ops updates.py.
//
//   GET  /-/api/updates/status    viewer    the catalog merged with what the host's
//                                           discovery timer found, the current job
//                                           and the history
//   GET  /-/api/updates/plan      viewer    the plan the HOST pre-computed for one
//                                           component (?component=)
//   POST /-/api/updates/request   operator  {component, plan_id, confirm} - writes
//                                           ONE spool file and answers 202 with a job id
//   GET  /-/api/updates/job       viewer    one job's steps (?id=)
//
// apps/bothy-ops/checks/wiring_updates.py asserts this file names exactly those
// four paths. Build step 4 of docs/plans/updates.md: the browser approves a PLAN
// ID the host wrote, never a version. The updater deploys only what the checked-
// out `main` already pins - there is no version picker to send, on purpose.
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
  /** What the host pre-computed for this component (step 4). Absent from an older service. */
  plan?: PlanSummary | null;
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
  /** True while a job is queued or running. */
  applying: boolean;
  /** The current or most recent job (the host's status.json). */
  job?: Job | null;
  /** Finished jobs, newest first, at most 20 (history.jsonl). */
  history?: HistoryEntry[];
  components: UpdateRow[];
}

// ── plans, requests, jobs (step 4) ───────────────────────────────────────────

export type PlanSummary =
  | { id: string; deployable: true; from: string; to: string; level: 'patch' | 'minor'; createdAt: string }
  | { id: null; deployable: false; reason: string; createdAt: string | null };

export interface Plan {
  id: string;
  component: string;
  title: string;
  class: 'stateless' | 'timeseries';
  createdAt: string;
  level: 'patch' | 'minor';
  /** Step 4 is always 'click'; 'type-name' means confirm must equal the component id. */
  confirm: 'click' | 'type-name';
  from: { image: string; tag: string | null; version: string | null; digest: string | null; container: string };
  to: { image: string; tag: string | null; version: string | null; digest: string | null };
  pin: { file: string; service: string; line: number; commit: string };
  changelog: string | null;
  oneWay: boolean;
  oneWayWhy: string | null;
  restarts: string[];
  recipe: string;
  downtime: string;
  signedOut: string;
  snapshot: { kind: 'image' | 'victoriametrics' | 'loki'; what: string; dir: string; estimateBytes: number | null };
  preflight: string[];
  verify: string[];
  rollback: string;
}

export interface PlanAnswer {
  ok: true;
  component: string;
  plan: Plan | null;
  reason: string | null;
  ageSeconds: number | null;
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'rolled_back' | 'aborted' | 'failed' | 'refused';
export type StepName = 'validate' | 'preflight' | 'snapshot' | 'pull' | 'apply' | 'verify' | 'rollback' | 'restore' | 'record';
export type StepState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface JobStep {
  name: StepName;
  state: StepState;
  startedAt: string | null;
  endedAt: string | null;
  detail: string | null;
}

interface JobBase {
  id: string;
  component: string;
  planId: string;
  state: JobState;
  requestedBy: string;
  requestedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  from: { image: string; version: string | null } | null;
  to: { image: string; version: string | null } | null;
  error: string | null;
  /** The pre-update snapshot directory on the host. */
  snapshot: string | null;
  note: string | null;
}

export interface Job extends JobBase { steps: JobStep[] }
export interface HistoryEntry extends JobBase { durationMs: number | null }

export const TERMINAL: readonly JobState[] = ['succeeded', 'rolled_back', 'aborted', 'failed', 'refused'];
export const isTerminal = (s: JobState): boolean => TERMINAL.includes(s);

export interface RequestAnswer { ok: true; jobId: string; component: string; planId: string }


const WIRE = {
  refused: (status: number) => `refused with ${status}`,
  notService: 'answered by something that is not bothy-ops - the updates route may not be deployed yet',
};

export async function fetchUpdates(signal?: AbortSignal): Promise<UpdatesStatus> {
  if (import.meta.env.DEV) return (await import('./updates.dev')).updatesMock();
  return apiFetch<UpdatesStatus>('/-/api/updates/status', { signal, ...WIRE });
}

export async function fetchPlan(component: string, signal?: AbortSignal): Promise<PlanAnswer> {
  if (import.meta.env.DEV) return (await import('./updates.dev')).planMock(component);
  return apiFetch<PlanAnswer>(`/-/api/updates/plan?component=${encodeURIComponent(component)}`, { signal, ...WIRE });
}

/** Ask the host to run a plan. The browser sends the plan's ID - the host wrote the
 *  plan, re-derives it before it acts, and refuses one that is no longer current. */
export async function requestUpdate(body: { component: string; plan_id: string; confirm: true | string }): Promise<RequestAnswer> {
  if (import.meta.env.DEV) return (await import('./updates.dev')).requestMock(body);
  return apiFetch<RequestAnswer>('/-/api/updates/request', { method: 'POST', body, ...WIRE });
}

export async function fetchJob(id: string, signal?: AbortSignal): Promise<Job> {
  if (import.meta.env.DEV) return (await import('./updates.dev')).jobMock(id);
  const r = await apiFetch<{ ok: true; job: Job }>(`/-/api/updates/job?id=${encodeURIComponent(id)}`, { signal, ...WIRE });
  return r.job;
}

// The job this tab is following, remembered so a reload - or bothy-web itself
// being recreated by the update it is watching - lands back on the same panel.
const JOB_KEY = 'bothy-update-job';
export function rememberedJob(): string | null {
  try { const v = localStorage.getItem(JOB_KEY); return v && /^[0-9a-f]{32}$/.test(v) ? v : null; } catch { return null; }
}
export function rememberJob(id: string | null): void {
  try { if (id) localStorage.setItem(JOB_KEY, id); else localStorage.removeItem(JOB_KEY); } catch { /* per-tab only then */ }
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
