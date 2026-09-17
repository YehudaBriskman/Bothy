// Acting on cluster workloads: rollout restart, scale, events, logs, and
// deleting completed pods. The client half of the kube verbs in apps/bothy-ops
// (bothy-kube until it merged with the container tier, 2026-09).
//
// THE CATALOG IS MIRRORED, NOT FETCHED. KUBE_CATALOG below is a copy of
// apps/bothy-ops/catalog.toml, and apps/bothy-ops/checks/wiring.py fails when
// the two disagree on an id, a role or a confirm level. Fetching it would add a
// sixth route to the edge for something that changes only in a reviewed commit.
//
// WHAT THE INTERFACE HIDES IS NEVER WHAT THE API ENFORCES. Roles are checked at
// the edge (sso-viewer, sso-operator), the namespace enum and the `type-name`
// confirmation again by the service, and the verbs a third time by the cluster's
// RBAC. Everything here is a courtesy that explains a refusal before the click.
//
// THIS MODULE IMPORTS ONLY lib/http.ts, which imports nothing, on lib/actions.ts's
// reasoning: checks/run.sh compiles and exercises it in node, and the rules below
// are cheap to get wrong and cheap to check.

import { apiFetch, refusalOf as httpRefusalOf, statusOf } from './http';

export type KubeActionId = 'rollout-restart' | 'scale' | 'events' | 'logs' | 'delete-completed-pods';
export type KubeRole = 'viewer' | 'operator';
export type ConfirmLevel = 'none' | 'click' | 'type-name';

export interface KubeActionSpec {
  id: KubeActionId;
  title: string;
  role: KubeRole;
  confirm: ConfirmLevel;
  target: 'deployment' | 'namespace';
  stream: boolean;
  /** One sentence: what it does, in the reader's terms. */
  meaning: string;
}

// Kept one entry per line with `id:` first - wiring.py reads this literal.
export const KUBE_CATALOG: readonly KubeActionSpec[] = [
  { id: 'rollout-restart', title: 'Restart rollout', role: 'operator', confirm: 'click', target: 'deployment', stream: false, meaning: 'Replace every pod of this deployment, one at a time. Configuration is unchanged.' },
  { id: 'scale', title: 'Scale', role: 'operator', confirm: 'type-name', target: 'deployment', stream: false, meaning: 'Set how many pods run, from 0 to 3. Scaling to 0 stops the workload.' },
  { id: 'events', title: 'Events', role: 'viewer', confirm: 'none', target: 'deployment', stream: false, meaning: 'What the cluster recently said about this deployment and its pods.' },
  { id: 'logs', title: 'Logs', role: 'viewer', confirm: 'none', target: 'deployment', stream: true, meaning: 'The last lines a pod wrote, or follow them live for up to two minutes.' },
  { id: 'delete-completed-pods', title: 'Delete completed pods', role: 'operator', confirm: 'click', target: 'namespace', stream: false, meaning: 'Remove pods that finished successfully. Running pods are never touched.' },
];

/** The two namespaces bothy-ops' kube verbs act on. Mirrors guard.NAMESPACES. */
export const KUBE_NAMESPACES: readonly string[] = ['thales-dev', 'thales-pre-prod'];

export const SCALE_MIN = 0;
export const SCALE_MAX = 3;
export const LOG_TAIL_MAX = 500;
export const FOLLOW_SECONDS = 120;

export interface KubeTarget {
  namespace: string;
  deployment: string;
}

/** The action spec by id. Throws on an unknown id, which is a programming error. */
export function specOf(id: KubeActionId): KubeActionSpec {
  const s = KUBE_CATALOG.find((a) => a.id === id);
  if (!s) throw new Error(`unknown kube action ${id}`);
  return s;
}

/**
 * The cluster target of a node, or null when there is nothing bothy-ops may act
 * on. Out-of-scope namespaces return null rather than a disabled control: the
 * service would refuse every action on them, and a button whose only outcome is
 * a refusal is worse than no button (the same call ActionCell makes for a node
 * with no container).
 */
export function kubeTargetOf(node: { kube?: { namespace?: string | null; deployment?: string | null } | null }): KubeTarget | null {
  const ns = node.kube?.namespace;
  const dep = node.kube?.deployment;
  if (!ns || !dep || !KUBE_NAMESPACES.includes(ns)) return null;
  return { namespace: ns, deployment: dep };
}

/** Whether the confirm step has been satisfied for this level. */
export function confirmSatisfied(level: ConfirmLevel, typed: string, name: string): boolean {
  if (level === 'type-name') return typed === name;
  return true;
}

/** The actions a session may run, given its roles. Viewer reads; operator changes and reads. */
export function allowedFor(roles: readonly string[], spec: KubeActionSpec): boolean {
  if (spec.role === 'viewer') return roles.includes('viewer') || roles.includes('operator');
  return roles.includes('operator');
}

export interface KubeRefusal {
  title: string;
  detail: string;
  needsRole: boolean;
}

export function kubeRefusalOf(e: unknown, spec: KubeActionSpec, what: string): KubeRefusal {
  const status = statusOf(e);
  const kind = httpRefusalOf(status);
  const said = status > 0 && e instanceof Error ? e.message : '';
  const verb = spec.title.toLowerCase();
  if (kind === 'sign-in' || kind === 'role') {
    // A 403 from the SERVICE carries its own reason (an out-of-scope namespace,
    // a cross-site request). A 403 from the edge carries none - that one is the role.
    if (said && !said.includes('refused (')) {
      return { title: `Bothy would not ${verb} ${what}.`, detail: said, needsRole: false };
    }
    return {
      title: `You may not ${verb} ${what}.`,
      detail: spec.role === 'operator'
        ? 'Changing cluster workloads needs the operator role, and this session does not hold it.'
        : 'Reading cluster workloads needs the viewer role, and this session does not hold it.',
      needsRole: true,
    };
  }
  if (kind === 'unavailable') {
    // 503 from bothy-ops' kube half: the service is up and the CLUSTER is not -
    // minikube stopped, the thales-scc overlay not applied, or no token yet.
    // Container actions are unaffected, which is the point of saying so.
    return {
      title: 'The cluster is not available.',
      detail: (said ? `${said}. ` : '') + 'Nothing was changed. Container actions still work; cluster actions return when the cluster does.',
      needsRole: false,
    };
  }
  if (kind === 'conflict' || status === 400 || status === 404 || status === 405 || status === 429) {
    return { title: `The cluster tier would not ${verb} ${what}.`, detail: said ? `${said} Nothing was changed.` : 'Nothing was changed.', needsRole: false };
  }
  if (status >= 500) {
    return {
      title: `Could not ${verb} ${what}.`,
      detail: (said ? `${said} ` : '') + 'bothy-ops or the cluster answered with a fault. Its audit log says what happened.',
      needsRole: false,
    };
  }
  return {
    title: 'The cluster tier did not answer.',
    detail: 'Nothing that understands this request replied, so nothing was changed. bothy-ops is not running or not reachable from here.',
    needsRole: false,
  };
}

// ── results ─────────────────────────────────────────────────────────────────

interface Base { ok: boolean; namespace: string; target: string; tookMs: number }
export interface RestartResult extends Base { restartedAt: string; fromGeneration?: number; toGeneration?: number; replicas?: number }
export interface ScaleResult extends Base { from: number; to: number }
export interface KubeEvent { type: string; reason: string; message: string; object: string; count: number; lastSeen: string }
export interface EventsResult extends Base { events: KubeEvent[] }
export interface LogsResult extends Base { pod: string; container: string; pods: string[]; containers: string[]; lines: string[] }
export interface DeleteCompletedResult extends Base { deleted: string[]; skipped: string[] }

export interface LogStreamHandlers {
  onMeta?: (m: { pod: string; container: string; seconds: number }) => void;
  onLine: (line: string) => void;
  onEnd: (why: { lines: number; reason: string }) => void;
  onError: (message: string) => void;
}

// ── the calls ───────────────────────────────────────────────────────────────

const BASE = '/-/api/kube';

const refused = (id: KubeActionId) => (status: number) => `${id} refused (${status})`;
const notService = (id: KubeActionId) => `${id} was answered by something that is not bothy-ops`;

async function post<T>(id: KubeActionId, body: Record<string, unknown>): Promise<T> {
  // DEV NEVER TOUCHES THE REAL CLUSTER. `vite dev` proxies /-/api/* at the live
  // box, so a real call from a dev tab would restart real pods. `import.meta.env.DEV`
  // is a literal false in a build, so the mock is not in the bundle.
  if (import.meta.env.DEV) {
    const { kubeMock } = await import('./kube-actions.dev');
    return kubeMock(id, body) as Promise<T>;
  }
  // The portal catch-all answers any unrouted path with HTML and a 200, so
  // apiFetch checks the content type before it believes the body (lib/http.ts).
  return apiFetch<T>(`${BASE}/${id}`, { body, refused: refused(id), notService: notService(id) });
}

async function get<T>(id: KubeActionId, q: Record<string, string>): Promise<T> {
  if (import.meta.env.DEV) {
    const { kubeMock } = await import('./kube-actions.dev');
    return kubeMock(id, q) as Promise<T>;
  }
  return apiFetch<T>(`${BASE}/${id}?${new URLSearchParams(q)}`, { refused: refused(id), notService: notService(id) });
}

export const rolloutRestart = (t: KubeTarget) =>
  post<RestartResult>('rollout-restart', { namespace: t.namespace, deployment: t.deployment });

/** `confirm` must be the deployment's name - the service checks it too. */
export const scale = (t: KubeTarget, replicas: number, confirm: string) =>
  post<ScaleResult>('scale', { namespace: t.namespace, deployment: t.deployment, replicas, confirm });

export const deleteCompletedPods = (namespace: string) =>
  post<DeleteCompletedResult>('delete-completed-pods', { namespace });

export const kubeEvents = (t: KubeTarget, limit = 50) =>
  get<EventsResult>('events', { namespace: t.namespace, deployment: t.deployment, limit: String(limit) });

export const kubeLogs = (t: KubeTarget, tail = 200, pod?: string) =>
  get<LogsResult>('logs', {
    namespace: t.namespace, deployment: t.deployment, tail: String(Math.min(tail, LOG_TAIL_MAX)),
    ...(pod ? { pod } : {}),
  });

/** The follow URL. Exported for the check; the component uses followLogs(). */
export function followUrl(t: KubeTarget, tail: number, seconds: number, pod?: string): string {
  const q = new URLSearchParams({
    namespace: t.namespace, deployment: t.deployment, tail: String(Math.min(tail, LOG_TAIL_MAX)),
    follow: 'true', seconds: String(Math.max(5, Math.min(seconds, 300))),
    ...(pod ? { pod } : {}),
  });
  return `${BASE}/logs?${q}`;
}

/**
 * Follow a deployment's logs over EventSource. Returns a function that stops it.
 *
 * The service ends every stream with an `end` event at its deadline and then
 * closes. EventSource RECONNECTS on close by design, so `end` must close the
 * source here or the browser would reopen the stream forever - which is the
 * exact unbounded follow the deadline exists to prevent.
 */
export function followLogs(t: KubeTarget, tail: number, seconds: number, h: LogStreamHandlers, pod?: string): () => void {
  if (import.meta.env.DEV) {
    let stop: () => void = () => {};
    let stopped = false;
    void import('./kube-actions.dev').then(({ followMock }) => {
      if (!stopped) stop = followMock(t, tail, seconds, h);
    });
    return () => { stopped = true; stop(); };
  }
  const es = new EventSource(followUrl(t, tail, seconds, pod));
  let done = false;
  const finish = () => { done = true; es.close(); };
  es.addEventListener('meta', (e) => {
    try { h.onMeta?.(JSON.parse((e as MessageEvent).data)); } catch { /* informational only */ }
  });
  es.onmessage = (e) => h.onLine(e.data);
  es.addEventListener('end', (e) => {
    let why = { lines: 0, reason: 'closed' };
    try { why = JSON.parse((e as MessageEvent).data); } catch { /* keep the default */ }
    finish();
    h.onEnd(why);
  });
  es.onerror = () => {
    if (done) return;
    // EventSource exposes no status code. A stream that never opened was
    // refused (role, scope, stream cap) - the caller asks the same question as
    // a plain read to get the reason in words.
    finish();
    h.onError('The log stream was refused or dropped.');
  };
  return finish;
}
