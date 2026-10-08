// Settings > Updates - bothy-ops updates.py.
//
//   GET  /-/api/updates/status    viewer    the catalog merged with what the host's
//                                           discovery timer found, the current job
//                                           and the history
//   GET  /-/api/updates/plan      viewer    the plan the HOST pre-computed for one
//                                           component (?component=), or for a whole
//                                           `apply` recipe (?group=, updater/groups.py)
//   POST /-/api/updates/request   operator  {component, plan_id, confirm[, note]} - writes
//                                           ONE spool file and answers 202 with a job id,
//                                           or {group, plan_id, confirm} for a whole recipe
//   GET  /-/api/updates/job       viewer    one job's steps (?id=)
//   POST /-/api/updates/unpause   operator  {component} - asks the HOST to clear an
//                                           automatic-update pause (step 7); 202
//   POST /-/api/updates/discover  operator  {} - asks the HOST to run discovery now
//                                           (read-only, rate-limited there); 202
//   POST /-/api/updates/autorun   operator  {dry_run} - asks the HOST's night job to
//                                           decide now, under all its gates; 202
//
// apps/bothy-web/checks/run.sh and apps/bothy-ops/checks/wiring_updates.py assert
// this file names exactly those
// seven paths. Build step 4 of docs/plans/updates.md: the browser approves a PLAN
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
  /** Step 7: automatic updates are paused for it (the host's auto.json). Absent from an older service. */
  paused?: Pause | null;
  /** An operator's unpause is waiting in the spool for the host. */
  unpauseQueued?: boolean;
  /** The `apply` recipe group this component belongs to, when its recipe has one. */
  group?: string | null;
  /** Applying this ALONE would be refused - the recipe recreates its group-mates
   *  too, and the host's scope check will not let one of them ride along without a
   *  snapshot. Apply the group instead. */
  applyWithGroup?: boolean;
}

// ── groups: everything one `apply` recipe pins, in one compose up ────────────
//
// A compose recipe is one `docker compose up`, so the host refuses to apply ONE
// component while another service of the same project also has a merged pin
// waiting. When two are waiting that refusal is total, and the page used to have
// nothing to offer but a shell. A group is the offer: the union of its members'
// treatments (every class's own snapshot, type-the-name as soon as one member is
// one-way) and an all-or-nothing rollback.

/** One member of a group: a component, and the step the group would take for it. */
export interface GroupMember {
  component: string;
  title: string | null;
  class: string | null;
  container: string | null;
  planId: string | null;
  level: Level | null;
  oneWay: boolean;
  from: { image: string | null; version: string | null; tag: string | null; digest: string | null };
  to: { image: string | null; version: string | null; tag: string | null; digest: string | null };
  pins: { file: string | null; service: string | null; line: number | null }[];
  snapshot: string | null;
  changelog: string | null;
}

export interface GroupPlan {
  group: string;
  kind: 'group';
  id: string;
  title: string | null;
  recipe: string | null;
  project: string | null;
  /** The compose services this one `up` recreates, and nothing else. */
  services: string[];
  createdAt: string | null;
  discoveredAt: string | null;
  /** The largest step any member takes. */
  level: Level;
  /** 'type-name' as soon as ONE member is one-way or one step is a major. */
  confirm: 'click' | 'type-name';
  /** What to type then: the GROUP's name, because the group is what is approved. */
  confirmWord: string | null;
  oneWay: boolean;
  oneWayWhy: string | null;
  members: GroupMember[];
  /** Components of this recipe the group is NOT carrying, and why. */
  skipped: { component: string; reason: string }[];
  restarts: string[];
  downtime: string | null;
  signedOut: string | null;
  snapshot: { kinds: string[]; what: string | null; dir: string | null; estimateBytes: number | null };
  preflight: string[];
  verify: string[];
  rollback: string | null;
  backupKinds: string[];
}

export interface GroupRow {
  group: string;
  deployable: boolean;
  recipe: string | null;
  plan: GroupPlan | null;
  /** ONE SENTENCE, when there is no plan: why this recipe has nothing to apply
   *  together. It is the sentence the page prints on the surface. */
  reason: string | null;
  /** The per-component half of that reason - what each member's own obstacle is.
   *  Only on a NON-deployable row; a deployable one carries the same shape at
   *  `plan.skipped`, and the two are never both filled, so nothing can disagree.
   *  Absent from a bothy-ops older than 2026-10-07. */
  skipped?: { component: string; reason: string }[];
  /** The components of this recipe the updater deploys at all. */
  candidates: string[];
  createdAt: string | null;
}

/** What each member of a group is doing, deployable or not - one shape, read from
 *  whichever half of the row has it. */
export function groupSkipped(g: GroupRow): { component: string; reason: string }[] {
  return g.plan ? g.plan.skipped : (g.skipped ?? []);
}

export interface GroupAnswer {
  ok: true;
  group: string;
  plan: GroupPlan | null;
  reason: string | null;
  ageSeconds: number | null;
}

/** Why the automatic channel stopped touching a component - until an operator clears it. */
export interface Pause {
  since: string | null;
  result: 'rolled_back' | 'failed' | null;
  reason: string;
  jobId: string | null;
  requestedBy: string | null;
}

/** The night job's last decision (bothy-updater-auto.timer, 03:30). */
export interface AutoDecision {
  at: string | null;
  outcome: 'requested' | 'skipped';
  reason: string | null;
  component: string | null;
  jobId: string | null;
}

/** requestedBy on every record the night job wrote. bothy-ops refuses it from a person. */
export const AUTO_ACTOR = 'auto';

/** What the HOST said about the last run of one of the two asks (2026-10-06).
 *
 *  Both of them can finish with nothing visibly different - a discovery that found
 *  no newer version leaves available.json saying the same thing, and a night job
 *  that skipped leaves no job at all - so the outcome has to be recorded rather
 *  than inferred. The host writes it; this is its allow-listed copy. */
export interface AskRecord {
  at: string | null;
  /** The person who asked, from X-Auth-Request-Email. Null when the ask itself was refused. */
  askedBy: string | null;
  /** `ok` it ran · `skipped` a gate said no, which is an answer · `refused` the ask
   *  was not acceptable · `failed` it ran and broke. */
  outcome: 'ok' | 'skipped' | 'refused' | 'failed';
  reason: string | null;
  tookMs: number | null;
}

/** A night-job run, which also says what it decided and what it passed over. */
export interface AutorunRecord extends AskRecord {
  dryRun: boolean;
  component: string | null;
  jobId: string | null;
  skipped: { component: string; why: string }[];
}

export interface Asks {
  /** An ask of that kind is in the spool, waiting for the host. */
  discoverQueued: boolean;
  autorunQueued: boolean;
  /** How soon discovery may run again - a registry quota, not a UI preference. */
  discoverMinSeconds: number;
  discover: AskRecord | null;
  autorun: AutorunRecord | null;
}

export interface UpdatesStatus {
  discovery: {
    present: boolean;
    generatedAt: string | null;
    ageSeconds: number | null;
    stale: boolean;
    hint: string | null;
  };
  summary: {
    components: number;
    /** How many have something NEWER UPSTREAM. Merging its PR is what gets it. */
    updates: number;
    behind: number;
    drift: number;
    errors: number;
    /** How many have a pin THIS BOX HAS NOT APPLIED. A different question from
     *  `updates`, and the one that matters here: Apply is what this page does. */
    toApply?: number;
    /** How many whole recipes can be applied at once. */
    groups?: number;
  };
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
  /** Step 7: the automatic channel. Absent from an older service. */
  auto?: { enabled: boolean; actor: string; paused: string[]; last: AutoDecision | null };
  /** The two asks, and the host's record of each. Absent from an older service, so
   *  every control behind it draws only when the field is there. */
  asks?: Asks;
  /** Step 6: which copy of the host updater runs, and a newer one staged by an
   *  update of Bothy itself, waiting for `just install-updater`. Null: not installed. */
  updater?: UpdaterInfo | null;
  /** One per `apply` recipe with two or more components to apply at once. Absent
   *  from an older service, so the block that draws them draws nothing then. */
  groups?: GroupRow[];
  components: UpdateRow[];
}

export interface UpdaterInfo {
  current: string | null;
  installedAt: string | null;
  staged: string | null;
  stagedAt: string | null;
}

// ── plans, requests, jobs (step 4) ───────────────────────────────────────────

export type PlanSummary =
  | { id: string; deployable: true; from: string; to: string; level: Level; createdAt: string }
  | { id: null; deployable: false; reason: string; createdAt: string | null };

export interface Plan {
  id: string;
  component: string;
  title: string;
  class: 'stateless' | 'timeseries' | 'app-db' | 'own-code' | 'cluster' | 'database';
  createdAt: string;
  /** A major only for Bothy itself (calendar versions), and then type-the-name. */
  level: Level;
  /** 'type-name' (every one-way plan, and any major) means confirm must equal the component id. */
  confirm: 'click' | 'type-name';
  from: { image: string; tag: string | null; version: string | null; digest: string | null; container: string };
  to: { image: string; tag: string | null; version: string | null; digest: string | null };
  /** `service` is null for Bothy itself, whose "pin" is VERSION. */
  pin: { file: string; service: string | null; line: number; commit: string };
  /** Every pin line the plan moves - Keycloak's image is pinned twice. Absent from an older service. */
  pins?: { file: string; service: string; line: number | null }[];
  changelog: string | null;
  oneWay: boolean;
  oneWayWhy: string | null;
  restarts: string[];
  recipe: string;
  downtime: string;
  signedOut: string;
  snapshot: {
    kind: 'image' | 'victoriametrics' | 'loki' | 'grafana' | 'keycloak' | 'git' | 'helm' | 'daemonset' | 'pg-dumpall';
    what: string; dir: string; estimateBytes: number | null;
  };
  preflight: string[];
  verify: string[];
  rollback: string;
  /** Bothy itself (class own-code, step 6): a green release tag instead of a pin. */
  own?: OwnPlan;
  /** Step 8: a cluster add-on, or the Postgres major (a guided, manual procedure). Null for the rest. */
  kind?: 'cluster' | 'postgres-major' | null;
  /** The request must carry a maintenance note (the Postgres major) - as well as the typed name. */
  requiresNote?: boolean;
  /** The procedure, step by step (the Postgres major). */
  procedure?: string[];
  cluster?: ClusterPlan;
  pgMajor?: PgMajorPlan;
}

/** A cluster add-on (step 8): where, as whom, and which part of k8s-monitoring.sh runs. */
export interface ClusterPlan {
  kind: 'helm' | 'daemonset' | null;
  context: string | null;
  identity: string | null;
  namespace: string | null;
  release: string | null;
  name: string | null;
  revision: number | null;
  part: 'ksm' | 'alloy' | null;
  configMaps: string[];
}

/** The Postgres major (step 8): the two majors and the two volumes. The old one is never deleted by it. */
export interface PgMajorPlan {
  fromMajor: number | null;
  toMajor: number | null;
  oldVolume: string | null;
  newVolume: string | null;
  oldMount: string | null;
  newMount: string | null;
  dataBytes: number | null;
  databases: string[];
  keycloakDb: string | null;
  stops: string[];
  deleteOld: string | null;
}

export interface OwnPlan {
  fromSha: string | null;
  toSha: string | null;
  /** The release tag, `v2026.9.1` - release.yml cuts it only on a green commit. */
  tag: string | null;
  releaseUrl: string | null;
  commits: number | null;
  diffstat: string | null;
  /** Which images' SOURCE changed. All three are recreated regardless. */
  apps: string[];
  /** Bothy's own compose files - applied by `just up-apps`. */
  compose: string[];
  /** edge/dynamic - Traefik reloads them the moment the checkout moves. */
  edge: string[];
  /** Other stacks' files: in the checkout afterwards, NOT applied by this update. */
  elsewhere: string[];
  elsewhereCount: number | null;
  /** The release changes the updater itself: staged, never switched mid-run. */
  updater: boolean;
  updaterFiles: string[];
  ci: { via: string | null; detail: string | null; runs: number | null };
  rollbackAfter: number | null;
  order: string[];
}

export interface PlanAnswer {
  ok: true;
  component: string;
  plan: Plan | null;
  reason: string | null;
  ageSeconds: number | null;
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'rolled_back' | 'aborted' | 'failed' | 'refused';
export type StepName = 'validate' | 'preflight' | 'snapshot' | 'pull' | 'apply' | 'verify' | 'rollback' | 'restore' | 'record'
  // Bothy itself (step 6): build before anything changes, arm the rollback timer,
  // move the checkout, stage a new updater.
  | 'build' | 'arm' | 'switch' | 'stage'
  // The Postgres major (step 8): writers stopped, dump, a new volume, load, compare, start.
  | 'stop' | 'dump' | 'create' | 'load' | 'compare' | 'start';
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
  /** A GROUP job (updater/groups.py): `component` is the RECIPE, and these are the
   *  components it moved. Empty for a single-component job. */
  members?: string[];
  /** Set while the group ask is still in the spool, waiting for the host. */
  group?: string | null;
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
export async function requestUpdate(body: { component: string; plan_id: string; confirm: true | string; note?: string }): Promise<RequestAnswer> {
  if (import.meta.env.DEV) return (await import('./updates.dev')).requestMock(body);
  return apiFetch<RequestAnswer>('/-/api/updates/request', { method: 'POST', body, ...WIRE });
}

export async function fetchGroup(group: string, signal?: AbortSignal): Promise<GroupAnswer> {
  if (import.meta.env.DEV) return (await import('./updates.dev')).groupMock(group);
  return apiFetch<GroupAnswer>(`/-/api/updates/plan?group=${encodeURIComponent(group)}`, { signal, ...WIRE });
}

export interface GroupRequestAnswer { ok: true; jobId: string; group: string; planId: string; components: string[] }

/** Ask the host to apply everything one `apply` recipe pins, in ONE compose up.
 *
 *  The same route and the same gate as a component apply: the browser sends the
 *  GROUP PLAN's id, the host recomputes the whole plan and every member's, and
 *  refuses one that is no longer current. The rollback is all-or-nothing, which
 *  the dialog says before it is pressed. */
export async function applyGroup(body: { group: string; plan_id: string; confirm: true | string }): Promise<GroupRequestAnswer> {
  if (import.meta.env.DEV) return (await import('./updates.dev')).groupRequestMock(body);
  return apiFetch<GroupRequestAnswer>('/-/api/updates/request', { method: 'POST', body, ...WIRE });
}

export interface UnpauseAnswer { ok: true; id: string; component: string }

/** Ask the host to clear an automatic-update pause. The host owns the pause; this
 *  drops one request in the spool, and the row shows it as waiting until then. */
export async function unpauseAuto(component: string): Promise<UnpauseAnswer> {
  if (import.meta.env.DEV) return (await import('./updates.dev')).unpauseMock(component);
  return apiFetch<UnpauseAnswer>('/-/api/updates/unpause', { method: 'POST', body: { component }, ...WIRE });
}

export interface AskAnswer { ok: true; id: string }
export interface AutorunAnswer extends AskAnswer { dryRun: boolean }

/** Ask the host to run discovery now. It reads the pins, asks the public registries
 *  anonymously and rewrites available.json and the plans - on the HOST, which also
 *  rate-limits it: the quota it spends is per public IP, not per person. */
export async function askDiscover(): Promise<AskAnswer> {
  if (import.meta.env.DEV) return (await import('./updates.dev')).discoverMock();
  return apiFetch<AskAnswer>('/-/api/updates/discover', { method: 'POST', body: {}, ...WIRE });
}

/** Ask the host's night job to decide now - the same gate chain the 03:30 timer runs.
 *  `dryRun` writes nothing at all; a real run may end in ONE update the HOST chose,
 *  recorded as the night job's because the night job chose it. */
export async function askNightJob(dryRun: boolean): Promise<AutorunAnswer> {
  if (import.meta.env.DEV) return (await import('./updates.dev')).autorunMock(dryRun);
  return apiFetch<AutorunAnswer>('/-/api/updates/autorun', { method: 'POST', body: { dry_run: dryRun }, ...WIRE });
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
