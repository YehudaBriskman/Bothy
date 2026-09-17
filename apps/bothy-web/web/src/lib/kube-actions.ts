// Acting on cluster workloads - the client half of bothy-ops' kube verbs.
//
// THE CATALOG IS FETCHED, NOT MIRRORED (2026-09). Until then KUBE_CATALOG was a
// hand-copied literal of apps/bothy-ops/catalog.toml that checks/wiring.py held
// in step. With ~30 actions a copy is a second thing to edit per action, so the
// service now serves its own catalog at GET /-/api/kube/catalog (viewer, one
// exact Path() like every other action) and the interface draws from that.
// catalog.toml stays the only hand-written wiring; scripts/gen-ops-wiring.py
// generates the edge routers, the RBAC and the dev fixture
// (lib/kube-catalog.dev.json) from it.
//
// WHAT THE INTERFACE HIDES IS NEVER WHAT THE API ENFORCES. Roles are checked at
// the edge (sso-viewer, sso-operator), the namespace enum, the allowlists and the
// `type-name` confirmation again by the service, and the verbs a third time by
// the cluster's RBAC. Everything here is a courtesy that explains a refusal
// before the click.
//
// THIS MODULE IMPORTS ONLY lib/http.ts, which imports nothing, on lib/actions.ts's
// reasoning: checks/run.sh compiles and exercises it in node, and the rules below
// are cheap to get wrong and cheap to check.

import { apiFetch, refusalOf as httpRefusalOf, statusOf } from './http';

export type KubeActionId = string;
export type KubeRole = 'viewer' | 'operator';
export type ConfirmLevel = 'none' | 'click' | 'type-name';
export type KubeTargetKind = 'namespace' | 'deployment' | 'pod' | 'job' | 'template' | 'configmap';

export interface KubeParamSpec {
  type: 'int' | 'bool' | 'name' | 'image' | 'configmap-key' | 'configmap-value';
  required?: boolean;
  default?: number | boolean | null;
  min?: number | null;
  max?: number | null;
}

export interface KubeActionSpec {
  id: KubeActionId;
  title: string;
  /** One sentence: what it does, in the reader's terms. */
  meaning: string;
  target: KubeTargetKind;
  method: 'GET' | 'POST';
  role: KubeRole;
  confirm: ConfirmLevel;
  stream: boolean;
  params: Record<string, KubeParamSpec>;
}

export interface KubeCatalog {
  namespaces: string[];
  actions: KubeActionSpec[];
  configmaps: string[];
  configmapKeys: Record<string, { pattern: string; meaning: string }>;
  imageRegistries: string[];
  jobTemplates: string[];
}

/**
 * The namespaces a ROW CONTROL is drawn for, before any catalog has loaded.
 *
 * This one list stays a literal, and it is not the catalog: it decides whether a
 * Services-table row gets a cluster button at all, on a page that has no reason
 * to fetch the catalog for rows it will never offer one on. It mirrors
 * guard.NAMESPACES and checks/wiring.py asserts the two agree. The page and the
 * dialog use the catalog's own `namespaces`.
 */
export const KUBE_NAMESPACES: readonly string[] = ['thales-dev', 'thales-pre-prod'];

export const LOG_TAIL_MAX = 500;
export const FOLLOW_SECONDS = 120;

export interface KubeTarget {
  namespace: string;
  deployment: string;
}

/** The action spec by id, or null. */
export function findSpec(catalog: KubeCatalog | null | undefined, id: KubeActionId): KubeActionSpec | null {
  return catalog?.actions.find((a) => a.id === id) ?? null;
}

/** The action spec by id. Throws on an unknown id - the catalog and the caller disagree. */
export function specOf(catalog: KubeCatalog, id: KubeActionId): KubeActionSpec {
  const s = findSpec(catalog, id);
  if (!s) throw new Error(`unknown kube action ${id}`);
  return s;
}

/** An int parameter's bounds, as the catalog declares them. */
export function boundsOf(spec: KubeActionSpec, param: string): { min: number; max: number } {
  const p = spec.params[param];
  return { min: p?.min ?? 0, max: p?.max ?? 0 };
}

/** The request field a target kind is named by. Null for a namespace action. */
export function targetField(kind: KubeTargetKind): string | null {
  return kind === 'namespace' ? null : kind;
}

/**
 * What `type-name` asks the person to type - the SERVICE checks the same
 * string: the target's name, except a configmap action that takes a `key`,
 * where it is the key (typing `thales` for every key would confirm nothing).
 */
export function confirmNameOf(spec: KubeActionSpec, req: Record<string, unknown>): string {
  if (spec.target === 'configmap' && 'key' in spec.params) return String(req.key ?? '');
  const f = targetField(spec.target);
  return String(f ? req[f] ?? '' : req.namespace ?? '');
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
  if (level === 'type-name') return name !== '' && typed === name;
  return true;
}

/** The actions a session may run, given its roles. Viewer reads; operator changes and reads. */
export function allowedFor(roles: readonly string[], spec: Pick<KubeActionSpec, 'role'>): boolean {
  if (spec.role === 'viewer') return roles.includes('viewer') || roles.includes('operator');
  return roles.includes('operator');
}

export interface KubeRefusal {
  title: string;
  detail: string;
  needsRole: boolean;
}

export function kubeRefusalOf(e: unknown, spec: Pick<KubeActionSpec, 'title' | 'role'>, what: string): KubeRefusal {
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

export interface KubeBase { ok: boolean; action?: string; namespace: string; target: string; tookMs: number }
export interface ImageRef { container: string; image: string }
export interface RestartResult extends KubeBase { restartedAt: string; fromGeneration?: number; toGeneration?: number; replicas?: number }
export interface ScaleResult extends KubeBase { from: number; to: number }
export interface KubeEvent { type: string; reason: string; message: string; object: string; count: number; lastSeen: string }
export interface EventsResult extends KubeBase { events: KubeEvent[] }
export interface LogsResult extends KubeBase { pod: string; container: string; pods: string[]; containers: string[]; lines: string[]; previous?: boolean }
export interface DeleteCompletedResult extends KubeBase { deleted: string[]; skipped: string[] }
export interface Condition { type: string; status: string; reason?: string; message?: string }
export interface DeploymentRow {
  name: string; replicas: number; readyReplicas: number; updatedReplicas: number; availableReplicas: number;
  paused: boolean; generation: number; observedGeneration: number; revision: number | null;
  images: ImageRef[]; selector: Record<string, string>; templateLabels: Record<string, string>;
  configmaps: string[]; createdAt: string; conditions: Condition[];
}
export interface DeploymentsResult extends KubeBase { deployments: DeploymentRow[] }
export interface RolloutStatusResult extends KubeBase {
  done: boolean; message: string; replicas: number; updatedReplicas: number; readyReplicas: number;
  availableReplicas: number; paused: boolean; generation: number; observedGeneration: number; revision: number | null;
}
export interface RevisionRow { revision: number; replicaset: string; images: ImageRef[]; replicas: number; readyReplicas: number; createdAt: string; current: boolean }
export interface HistoryResult extends KubeBase { current: number | null; revisions: RevisionRow[] }
export interface RollbackResult extends KubeBase { fromRevision: number | null; toRevision: number; images: ImageRef[]; skipped: boolean }
export interface PauseResult extends KubeBase { from: boolean; to: boolean }
export interface SetImageResult extends KubeBase { container: string; from: string; to: string }
export interface PodContainer { name: string; image: string; ready: boolean; restartCount: number; state: string; reason?: string | null }
export interface PodRow {
  name: string; phase: string; status: string; readyContainers: number; totalContainers: number; restarts: number;
  owner: { kind: string; name: string } | null; deletable: boolean; containers: PodContainer[]; createdAt: string; node?: string | null;
}
export interface PodsResult extends KubeBase { pods: PodRow[] }
export interface DeletePodResult extends KubeBase { deleted: string; owner: { kind: string; name: string } | null }
export interface JobRow {
  name: string; template: string | null; status: 'Running' | 'Complete' | 'Failed' | string;
  active: number; succeeded: number; failed: number; startTime: string | null; completionTime: string | null;
  createdAt: string; images: ImageRef[];
}
export interface JobsResult extends KubeBase { jobs: JobRow[] }
export interface JobLogsResult extends KubeBase { job: string; pod: string; container: string; pods: string[]; containers: string[]; previous: boolean; lines: string[] }
export interface DeleteJobResult extends KubeBase { deleted: string; propagationPolicy: string }
export interface RunTemplateResult extends KubeBase { job: string; template: string; image: string }
export interface ConfigEntry { key: string; value: string; editable: boolean; pattern?: string; meaning?: string }
export interface ConfigMapResult extends KubeBase { configmap: string; resourceVersion: string; data: ConfigEntry[] }
export interface PatchKeyResult extends KubeBase { key: string; from: string | null; to: string; restarted?: string[]; restartedAt?: string }
export interface ServiceRow { name: string; type: string; clusterIP: string; ports: { name?: string | null; port: number; targetPort: string | number; protocol: string; nodePort?: number | null }[]; selector: Record<string, string> }
export interface ServicesResult extends KubeBase { services: ServiceRow[] }
export interface RouteRow { name: string; host: string; path?: string | null; service: string; targetPort?: string | number | null; tls: string | null; admitted: boolean | null }
export interface RoutesResult extends KubeBase { routes: RouteRow[] }
export interface IngressRow { name: string; className?: string | null; rules: { host?: string | null; path?: string | null; service: string; port?: string | number | null }[]; tlsHosts: string[] }
export interface IngressesResult extends KubeBase { ingresses: IngressRow[] }
export interface ClaimRow { name: string; phase: string; requested?: string | null; capacity?: string | null; accessModes: string[]; storageClass?: string | null; volume?: string | null }
export interface ClaimsResult extends KubeBase { claims: ClaimRow[] }
export interface PolicyRow { name: string; podSelector: Record<string, string>; policyTypes: string[]; ingress: string[]; egress: string[] }
export interface PoliciesResult extends KubeBase { policies: PolicyRow[] }
export interface QuotaRow { name: string; hard: Record<string, string>; used: Record<string, string> }
export interface QuotasResult extends KubeBase { quotas: QuotaRow[] }
export interface LimitRangeRow { name: string; limits: { type: string; default?: Record<string, string>; defaultRequest?: Record<string, string>; max?: Record<string, string>; min?: Record<string, string> }[] }
export interface LimitRangesResult extends KubeBase { limitRanges: LimitRangeRow[] }

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

let catalogPromise: Promise<KubeCatalog> | null = null;

/**
 * The catalog, fetched once per tab. A rejection is not cached - a blip on the
 * first open must not make the page believe there are no actions until reload.
 */
export function loadCatalog(): Promise<KubeCatalog> {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      if (import.meta.env.DEV) {
        const { catalogMock } = await import('./kube-actions.dev');
        return catalogMock();
      }
      return apiFetch<KubeCatalog>(`${BASE}/catalog`, { refused: refused('catalog'), notService: notService('catalog') });
    })().catch((e) => { catalogPromise = null; throw e; });
  }
  return catalogPromise;
}

/** Query-string form of a GET request. Undefined and null values are left out. */
export function queryOf(req: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(req)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, String(v));
  }
  return q.toString();
}

/** POST a change. */
export async function kubePost<T>(id: KubeActionId, body: Record<string, unknown>): Promise<T> {
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

/** GET a read. */
export async function kubeGet<T>(id: KubeActionId, q: Record<string, unknown>): Promise<T> {
  if (import.meta.env.DEV) {
    const { kubeMock } = await import('./kube-actions.dev');
    return kubeMock(id, q) as Promise<T>;
  }
  return apiFetch<T>(`${BASE}/${id}?${queryOf(q)}`, { refused: refused(id), notService: notService(id) });
}

/** Run any catalog action by its declared method. */
export function kubeCall<T>(spec: Pick<KubeActionSpec, 'id' | 'method'>, req: Record<string, unknown>): Promise<T> {
  return spec.method === 'POST' ? kubePost<T>(spec.id, req) : kubeGet<T>(spec.id, req);
}

export const rolloutRestart = (t: KubeTarget) =>
  kubePost<RestartResult>('rollout-restart', { namespace: t.namespace, deployment: t.deployment });

/** `confirm` must be the deployment's name - the service checks it too. */
export const scale = (t: KubeTarget, replicas: number, confirm: string) =>
  kubePost<ScaleResult>('scale', { namespace: t.namespace, deployment: t.deployment, replicas, confirm });

export const deleteCompletedPods = (namespace: string) =>
  kubePost<DeleteCompletedResult>('delete-completed-pods', { namespace });

export const kubeEvents = (t: KubeTarget, limit = 50) =>
  kubeGet<EventsResult>('events', { namespace: t.namespace, deployment: t.deployment, limit });

export interface LogOptions { pod?: string; container?: string; previous?: boolean }

export const kubeLogs = (t: KubeTarget, tail = 200, o: LogOptions = {}) =>
  kubeGet<LogsResult>('logs', {
    namespace: t.namespace, deployment: t.deployment, tail: Math.min(tail, LOG_TAIL_MAX),
    pod: o.pod, container: o.container, previous: o.previous ? 'true' : undefined,
  });

/** The follow URL. Exported for the check; the component uses followLogs(). */
export function followUrl(t: KubeTarget, tail: number, seconds: number, pod?: string, container?: string): string {
  const q = new URLSearchParams({
    namespace: t.namespace, deployment: t.deployment, tail: String(Math.min(tail, LOG_TAIL_MAX)),
    follow: 'true', seconds: String(Math.max(5, Math.min(seconds, 300))),
    ...(pod ? { pod } : {}),
    ...(container ? { container } : {}),
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
export function followLogs(t: KubeTarget, tail: number, seconds: number, h: LogStreamHandlers, pod?: string, container?: string): () => void {
  if (import.meta.env.DEV) {
    let stop: () => void = () => {};
    let stopped = false;
    void import('./kube-actions.dev').then(({ followMock }) => {
      if (!stopped) stop = followMock(t, tail, seconds, h);
    });
    return () => { stopped = true; stop(); };
  }
  const es = new EventSource(followUrl(t, tail, seconds, pod, container));
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
