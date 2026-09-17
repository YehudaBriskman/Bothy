// The stand-in for bothy-ops' kube verbs, used by `vite dev` and by nothing else.
//
// Same reason as actions.dev.ts: the dev server proxies /-/api/* at the live
// box, so a real client in a dev tab would restart real pods. lib/kube-actions.ts
// routes here behind `import.meta.env.DEV`, a literal false after a build.
//
// EVERY catalog action has an answer here, shaped like the service's. The
// catalog itself is lib/kube-catalog.dev.json, GENERATED from
// apps/bothy-ops/catalog.toml by scripts/gen-ops-wiring.py - so the dev page can
// never offer an action the service does not declare.
//
// Not a happy path. Force an outcome from the console:
//   localStorage['bothy-dev-kube-outcome'] = 'role' | 'scope' | 'fault' | 'silence' | 'unavailable'
// and grant roles for drawing with the existing key:
//   localStorage['bothy-dev-roles'] = 'viewer,operator'

import catalogJson from './kube-catalog.dev.json';
import type {
  ConfigEntry, DeploymentRow, JobRow, KubeActionId, KubeCatalog, KubeTarget, LogStreamHandlers, PodRow,
} from './kube-actions';

const OUTCOME_KEY = 'bothy-dev-kube-outcome';
const CATALOG = catalogJson as unknown as KubeCatalog;

const read = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};

function refuse(status: number, message: string): never {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  throw e;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

export async function catalogMock(): Promise<KubeCatalog> {
  await sleep(120);
  if (read(OUTCOME_KEY) === 'silence') refuse(0, 'no answer');
  return CATALOG;
}

// ── the pretend cluster, one per namespace, mutated by the change actions ────

interface NsState {
  deployments: DeploymentRow[];
  history: Record<string, { revision: number; replicaset: string; image: string; createdAt: string }[]>;
  pods: PodRow[];
  jobs: JobRow[];
  config: Record<string, string>;
  rv: number;
}

const APPS = ['algorithm', 'backend', 'frontend', 'postgres'] as const;
const PORTS: Record<string, number> = { algorithm: 8000, backend: 3001, frontend: 8080, postgres: 5432 };
const imageOf = (app: string) => (app === 'postgres' ? 'postgres:16-alpine' : `thales/${app}:0.1.7`);
const hash = (app: string, rev: number) => `${app.slice(0, 3)}${rev}f8c94d`.slice(0, 10);
const suffix = (s: string) => s.replace(/[^a-z0-9]/g, '').padEnd(5, 'x').slice(0, 5);

function makeState(ns: string): NsState {
  const pre = ns === 'thales-pre-prod';
  const deployments: DeploymentRow[] = APPS.map((app, i) => {
    const rev = app === 'postgres' ? 2 : 5;
    const ready = !pre && app === 'algorithm' ? 0 : 1;
    return {
      name: app, replicas: 1, readyReplicas: ready, updatedReplicas: 1, availableReplicas: ready,
      paused: false, generation: rev + 2, observedGeneration: rev + 2, revision: rev,
      images: [{ container: app, image: imageOf(app) }],
      selector: { app }, templateLabels: { app },
      configmaps: app === 'postgres' ? [] : ['thales'],
      createdAt: iso(90000 + i * 60),
      conditions: [{ type: 'Available', status: ready ? 'True' : 'False', reason: ready ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable' }],
    };
  });
  const history: NsState['history'] = {};
  for (const d of deployments) {
    const n = d.revision ?? 1;
    history[d.name] = Array.from({ length: Math.min(n, 4) }, (_, k) => {
      const revision = n - k;
      const image = revision === 1 && d.name !== 'postgres' ? `localhost:5000/thales/${d.name}:0.1.6` : imageOf(d.name);
      return { revision, replicaset: `${d.name}-${hash(d.name, revision)}`, image, createdAt: iso(3600 * (k * 7 + 1)) };
    });
  }
  const pods: PodRow[] = deployments.map((d) => {
    const crash = d.readyReplicas === 0;
    return {
      name: `${d.name}-${hash(d.name, d.revision ?? 1)}-${suffix(d.name + ns)}`,
      phase: 'Running', status: crash ? 'CrashLoopBackOff' : 'Running',
      readyContainers: crash ? 0 : 1, totalContainers: 1, restarts: crash ? 14 : d.name === 'backend' ? 2 : 0,
      owner: { kind: 'Deployment', name: d.name }, deletable: true,
      containers: [{ name: d.name, image: d.images[0].image, ready: !crash, restartCount: crash ? 14 : 0, state: crash ? 'waiting' : 'running', reason: crash ? 'CrashLoopBackOff' : null }],
      createdAt: iso(crash ? 4200 : 72000), node: 'thales-scc',
    };
  });
  pods.push({
    name: 'thales-migrate-7k2qp-zx4mf', phase: 'Succeeded', status: 'Completed', readyContainers: 0, totalContainers: 1, restarts: 0,
    owner: { kind: 'Job', name: 'thales-migrate-7k2qp' }, deletable: true,
    containers: [{ name: 'migrate', image: 'thales/backend:0.1.7', ready: false, restartCount: 0, state: 'terminated', reason: 'Completed' }],
    createdAt: iso(20000), node: 'thales-scc',
  });
  const jobs: JobRow[] = [
    { name: 'thales-migrate-7k2qp', template: 'migrate', status: 'Complete', active: 0, succeeded: 1, failed: 0, startTime: iso(20000), completionTime: iso(19950), createdAt: iso(20000), images: [{ container: 'migrate', image: 'thales/backend:0.1.7' }] },
    { name: 'thales-seed-reference-p9vtd', template: 'seed-reference', status: 'Failed', active: 0, succeeded: 0, failed: 1, startTime: iso(19000), completionTime: null, createdAt: iso(19000), images: [{ container: 'seed', image: 'thales/backend:0.1.7' }] },
  ];
  const config: Record<string, string> = {
    API_VERSION: 'v1', APP_BASE_URL: `http://box.example:${pre ? 31080 : 31081}`, AUTH_IDP: 'keycloak', AUTH_MODE: pre ? 'saml' : 'both',
    AUTH_RATE_LIMIT_ENABLED: 'true', AUTH_RATE_LIMIT_MAX: '100', CPSAT_SEARCH_WORKERS: '8', CPSAT_TIME_LIMIT: '540',
    DB_CONNECTION_TIMEOUT_MS: '10000', DB_POOL_MAX: '10', DB_SSL: 'false', DEMO_LOGINS: pre ? 'false' : 'true',
    DEPLOY_ENV: pre ? 'pre-prod' : 'dev', ENABLED_ALGORITHMS: 'heuristic,milp,cpsat', ENABLE_OTLP_EXPORT: 'false',
    JOB_MAX_WORKERS: '2', JOB_TTL_SECONDS: '900', LOG_LEVEL: 'info', MAX_REQUEST_BODY_BYTES: '10485760',
    NODE_ENV: 'production', SESSION_EXPIRES_IN_S: '604800', SSO_DEFAULT_ROLE: 'viewer', TRUSTED_PROXY_HOPS: '1',
  };
  return { deployments, history, pods, jobs, config, rv: 48213 };
}

const STATE: Record<string, NsState> = {};
const stateOf = (ns: string) => (STATE[ns] ??= makeState(ns));

const SAMPLE = [
  'GET /healthz 200 1ms',
  'INFO  starting worker pool size=4',
  'GET /api/items?limit=50 200 12ms',
  'WARN  slow query took=842ms table=detections',
  'GET /api/items/41 200 4ms',
  'POST /api/login 302 38ms',
];

const logLines = (who: string, previous: boolean) => (previous
  ? ['2026-09-17T09:58:01Z INFO  starting', '2026-09-17T09:58:02Z ERROR config: JOB_MAX_WORKERS="x" is not an integer', `2026-09-17T09:58:02Z FATAL ${who} refusing to start`]
  : Array.from({ length: 24 }, (_, i) => `2026-09-17T10:${String(i).padStart(2, '0')}:00Z ${SAMPLE[i % SAMPLE.length]}`));

function eventsFor(ns: string, match?: string) {
  const s = stateOf(ns);
  const all = [
    ...s.deployments.flatMap((d, i) => [
      { type: 'Normal', reason: 'ScalingReplicaSet', message: `Scaled up replica set ${d.name}-${hash(d.name, d.revision ?? 1)} to 1`, object: `Deployment/${d.name}`, count: 1, lastSeen: iso(40 + i * 300) },
      { type: 'Normal', reason: 'Pulled', message: 'Container image already present on machine', object: `Pod/${s.pods[i].name}`, count: 1, lastSeen: iso(120 + i * 300) },
    ]),
    ...s.pods.filter((p) => p.restarts > 5).map((p) => ({ type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container', object: `Pod/${p.name}`, count: p.restarts, lastSeen: iso(25) })),
    { type: 'Warning', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit', object: 'Job/thales-seed-reference-p9vtd', count: 1, lastSeen: iso(18900) },
  ];
  return all
    .filter((e) => !match || e.object === `Deployment/${match}` || e.object.startsWith(`Pod/${match}-`) || e.object.startsWith(`ReplicaSet/${match}-`))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export async function kubeMock(id: KubeActionId, body: Record<string, unknown>): Promise<unknown> {
  await sleep(id.startsWith('patch') || ['rollout-restart', 'run-template', 'rollback-to-revision', 'set-image'].includes(id) ? 700 : 250);
  const forced = read(OUTCOME_KEY);
  if (forced === 'role') refuse(403, `${id} refused (403)`);
  if (forced === 'scope') refuse(403, `namespace 'kube-system' is out of scope - bothy-ops acts on thales-dev and thales-pre-prod only`);
  if (forced === 'fault') refuse(502, 'the cluster refused bothy-ops (403): forbidden - its token or its Role has diverged from the catalog');
  if (forced === 'unavailable') refuse(503, 'cluster unavailable - cannot reach the apiserver (ConnectionRefusedError)');
  if (forced === 'silence') refuse(0, 'no answer');

  const spec = CATALOG.actions.find((a) => a.id === id);
  if (!spec) refuse(404, `'${id}' is not an action`);
  const namespace = String(body.namespace ?? '');
  if (!CATALOG.namespaces.includes(namespace)) refuse(403, `namespace '${namespace}' is out of scope - bothy-ops acts on thales-dev and thales-pre-prod only`);
  const field = spec.target === 'namespace' ? null : spec.target;
  const target = String(field ? body[field] ?? '' : namespace);
  const s = stateOf(namespace);
  const base = { ok: true, action: id, namespace, target, tookMs: 240 };
  const dep = () => s.deployments.find((d) => d.name === target) ?? refuse(404, `deployments.apps "${target}" not found`);
  const confirmed = (name: string) => { if (body.confirm !== name) refuse(400, `${id} must be confirmed by typing the name of what it acts on (confirm must equal '${name}')`); };

  switch (id) {
    case 'deployments':
      return { ...base, deployments: s.deployments };
    case 'rollout-status': {
      const d = dep();
      const done = d.readyReplicas >= d.replicas && d.updatedReplicas >= d.replicas;
      return { ...base, done, message: done ? `deployment "${d.name}" successfully rolled out` : `Waiting for deployment "${d.name}" rollout to finish: ${d.readyReplicas} of ${d.replicas} updated replicas are available...`, replicas: d.replicas, updatedReplicas: d.updatedReplicas, readyReplicas: d.readyReplicas, availableReplicas: d.availableReplicas, paused: d.paused, generation: d.generation, observedGeneration: d.observedGeneration, revision: d.revision };
    }
    case 'rollout-history': {
      const d = dep();
      return {
        ...base, current: d.revision,
        revisions: s.history[d.name].map((h) => ({ revision: h.revision, replicaset: h.replicaset, images: [{ container: d.name, image: h.image }], replicas: h.revision === d.revision ? d.replicas : 0, readyReplicas: h.revision === d.revision ? d.readyReplicas : 0, createdAt: h.createdAt, current: h.revision === d.revision })),
      };
    }
    case 'rollback-to-revision': {
      const d = dep();
      confirmed(d.name);
      const want = Number(body.revision);
      const h = s.history[d.name].find((x) => x.revision === want) ?? refuse(404, `revision ${want} of ${d.name} not found`);
      if (!CATALOG.imageRegistries.some((p) => h.image.startsWith(p))) refuse(400, `revision ${want} runs ${h.image}, which is not from an allowed registry`);
      if (want === d.revision) return { ...base, fromRevision: d.revision, toRevision: want, images: [{ container: d.name, image: h.image }], skipped: true };
      const from = d.revision;
      const next = (d.revision ?? 0) + 1;
      s.history[d.name] = [{ ...h, revision: next, createdAt: iso(0) }, ...s.history[d.name].filter((x) => x.revision !== want)];
      d.revision = next;
      d.images = [{ container: d.name, image: h.image }];
      return { ...base, fromRevision: from, toRevision: want, images: d.images, skipped: false };
    }
    case 'pause':
    case 'resume': {
      const d = dep();
      const from = d.paused;
      d.paused = id === 'pause';
      return { ...base, from, to: d.paused };
    }
    case 'set-image': {
      const d = dep();
      confirmed(d.name);
      const c = d.images.find((x) => x.container === body.container) ?? refuse(404, `container '${String(body.container)}' is not in ${d.name}'s template`);
      const image = String(body.image ?? '');
      if (!CATALOG.imageRegistries.some((p) => image.startsWith(p))) refuse(400, `image must start with ${CATALOG.imageRegistries.join(' or ')}`);
      const from = c.image;
      c.image = image;
      return { ...base, container: c.container, from, to: image };
    }
    case 'rollout-restart': {
      dep();
      return { ...base, restartedAt: iso(0), fromGeneration: 4, toGeneration: 5, replicas: 1 };
    }
    case 'scale': {
      const d = dep();
      confirmed(d.name);
      const from = d.replicas;
      d.replicas = Number(body.replicas);
      d.readyReplicas = Math.min(d.readyReplicas, d.replicas);
      return { ...base, from, to: d.replicas };
    }
    case 'events':
      dep();
      return { ...base, events: eventsFor(namespace, target).slice(0, Number(body.limit ?? 50)) };
    case 'namespace-events':
      return { ...base, events: eventsFor(namespace).slice(0, Number(body.limit ?? 200)) };
    case 'logs': {
      const d = dep();
      const pods = s.pods.filter((p) => p.owner?.name === d.name).map((p) => p.name);
      const pod = body.pod ? String(body.pod) : pods[0];
      if (!pods.includes(pod)) refuse(404, `pod '${pod}' does not belong to ${d.name}`);
      const containers = d.images.map((x) => x.container);
      const previous = body.previous === 'true' || body.previous === true;
      return { ...base, pod, container: String(body.container ?? containers[0]), pods, containers, previous, lines: logLines(d.name, previous) };
    }
    case 'pods': {
      const only = body.deployment ? String(body.deployment) : null;
      return { ...base, pods: only ? s.pods.filter((p) => p.owner?.kind === 'Deployment' && p.owner.name === only) : s.pods };
    }
    case 'delete-pod': {
      const p = s.pods.find((x) => x.name === target) ?? refuse(404, `pods "${target}" not found`);
      if (!p.deletable) refuse(403, `pod ${target} is not owned by a deployment or a job`);
      s.pods = s.pods.filter((x) => x !== p);
      if (p.owner?.kind === 'Deployment') {
        s.pods.push({ ...p, name: `${p.name.slice(0, p.name.lastIndexOf('-'))}-${suffix(String(Date.now()))}`, status: 'ContainerCreating', readyContainers: 0, restarts: 0, createdAt: iso(0) });
      }
      return { ...base, deleted: p.name, owner: p.owner };
    }
    case 'delete-completed-pods': {
      const done = s.pods.filter((p) => p.phase === 'Succeeded');
      s.pods = s.pods.filter((p) => p.phase !== 'Succeeded');
      return { ...base, deleted: done.map((p) => p.name), skipped: [] };
    }
    case 'jobs':
      return { ...base, jobs: [...s.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
    case 'job-logs': {
      const j = s.jobs.find((x) => x.name === target) ?? refuse(404, `jobs.batch "${target}" not found`);
      const previous = body.previous === 'true' || body.previous === true;
      const failed = j.status === 'Failed';
      return {
        ...base, job: j.name, pod: `${j.name}-zx4mf`, container: j.images[0].container, pods: [`${j.name}-zx4mf`], containers: [j.images[0].container], previous,
        lines: failed
          ? ['INFO  seeding reference data', 'INFO  component catalog: 412 rows present', 'ERROR relation "treatment_rules" does not exist - run the migrate job first']
          : ['INFO  acquiring migration lock', 'INFO  applying 0042_add_base_timezone', 'INFO  applying 0043_component_rules_index', 'INFO  2 migrations applied in 1.8s'],
      };
    }
    case 'delete-job': {
      if (!s.jobs.some((x) => x.name === target)) refuse(404, `jobs.batch "${target}" not found`);
      s.jobs = s.jobs.filter((x) => x.name !== target);
      s.pods = s.pods.filter((p) => !(p.owner?.kind === 'Job' && p.owner.name === target));
      return { ...base, deleted: target, propagationPolicy: 'Background' };
    }
    case 'run-template': {
      if (!CATALOG.jobTemplates.includes(target)) refuse(404, `'${target}' is not a job template - there are ${CATALOG.jobTemplates.join(', ')}`);
      confirmed(target);
      const job = `thales-${target}-${suffix(String(Date.now()).split('').reverse().join('')).replace(/[0-9]/g, (c) => 'abcdefghij'[Number(c)])}`;
      s.jobs.unshift({ name: job, template: target, status: 'Running', active: 1, succeeded: 0, failed: 0, startTime: iso(0), completionTime: null, createdAt: iso(0), images: [{ container: target === 'migrate' ? 'migrate' : 'seed', image: 'thales/backend:0.1.7' }] });
      return { ...base, job, template: target, image: 'thales/backend:0.1.7' };
    }
    case 'configmap': {
      if (!CATALOG.configmaps.includes(target)) refuse(403, `configmap '${target}' is not one bothy-ops may read`);
      const data: ConfigEntry[] = Object.keys(s.config).sort().map((key) => {
        const rule = CATALOG.configmapKeys[key];
        return rule ? { key, value: s.config[key], editable: true, pattern: rule.pattern, meaning: rule.meaning } : { key, value: s.config[key], editable: false };
      });
      return { ...base, configmap: target, resourceVersion: String(s.rv), data };
    }
    case 'patch-key':
    case 'patch-key-and-restart': {
      const key = String(body.key ?? '');
      const rule = CATALOG.configmapKeys[key] ?? refuse(400, `key '${key}' is not one bothy-ops may change - it may change ${Object.keys(CATALOG.configmapKeys).join(', ')}`);
      const value = String(body.value ?? '');
      if (!new RegExp(`^(?:${rule.pattern})$`).test(value)) refuse(400, `value for ${key} must match ${rule.pattern}`);
      confirmed(key);
      const from = s.config[key] ?? null;
      s.config[key] = value;
      s.rv += 1;
      if (id === 'patch-key') return { ...base, key, from, to: value };
      return { ...base, key, from, to: value, restarted: s.deployments.filter((d) => d.configmaps.includes(target)).map((d) => d.name), restartedAt: iso(0) };
    }
    case 'services':
      return { ...base, services: APPS.map((app, i) => ({ name: app, type: 'ClusterIP', clusterIP: `10.10${i}.${40 + i * 13}.${6 + i}`, ports: [{ name: app === 'postgres' ? 'postgres' : 'http', port: PORTS[app], targetPort: PORTS[app], protocol: 'TCP', nodePort: null }], selector: { app } })) };
    case 'routes':
      return { ...base, routes: [{ name: 'thales', host: 'thales.apps.interior.example', path: null, service: 'frontend', targetPort: 'http', tls: 'edge', admitted: null }] };
    case 'ingresses':
      return { ...base, ingresses: namespace === 'thales-dev' ? [] : [{ name: 'thales-api', className: 'nginx', rules: [{ host: 'api.thales.local', path: '/api', service: 'backend', port: 3001 }, { host: 'api.thales.local', path: '/solve', service: 'solver', port: 8000 }], tlsHosts: [] }] };
    case 'persistentvolumeclaims':
      return { ...base, claims: [{ name: 'postgres', phase: 'Bound', requested: '10Gi', capacity: '10Gi', accessModes: ['ReadWriteOnce'], storageClass: 'standard', volume: `pvc-${namespace === 'thales-dev' ? '2300bac0' : 'e94924a4'}-621a-47c0-9077-f620c4a4c261` }] };
    case 'networkpolicies':
      return { ...base, policies: [
        { name: 'default-deny', podSelector: {}, policyTypes: ['Ingress'], ingress: [], egress: [] },
        { name: 'postgres-from-backend', podSelector: { app: 'postgres' }, policyTypes: ['Ingress'], ingress: ['from pods app=backend, app=algorithm on TCP 5432'], egress: [] },
      ] };
    case 'resourcequotas':
      return { ...base, quotas: [{ name: 'thales', hard: { 'requests.cpu': '4', 'requests.memory': '6Gi', pods: '20' }, used: { 'requests.cpu': '1350m', 'requests.memory': '2304Mi', pods: String(s.pods.length) } }] };
    case 'limitranges':
      return { ...base, limitRanges: [{ name: 'defaults', limits: [{ type: 'Container', default: { cpu: '500m', memory: '512Mi' }, defaultRequest: { cpu: '100m', memory: '128Mi' }, max: { cpu: '2', memory: '2Gi' } }] }] };
  }
  refuse(404, `the dev stand-in has no answer for ${id}`);
}

export function followMock(t: KubeTarget, _tail: number, seconds: number, h: LogStreamHandlers): () => void {
  if (read(OUTCOME_KEY)) {
    const id = setTimeout(() => h.onError('The log stream was refused or dropped.'), 300);
    return () => clearTimeout(id);
  }
  h.onMeta?.({ pod: `${t.deployment}-6d9f8-x2k4q`, container: t.deployment, seconds });
  let n = 0;
  const tick = setInterval(() => {
    h.onLine(`${new Date().toISOString()} ${SAMPLE[n % SAMPLE.length]}`);
    n += 1;
  }, 700);
  const end = setTimeout(() => { clearInterval(tick); h.onEnd({ lines: n, reason: 'deadline' }); }, Math.min(seconds, 20) * 1000);
  return () => { clearInterval(tick); clearTimeout(end); };
}

/** Per-pod CPU and memory for the Metrics tab, in Prometheus' matrix shape. */
export function promMock(query: string, start: number, end: number, step: number): unknown {
  const ns = /namespace="([^"]+)"/.exec(query)?.[1] ?? 'thales-dev';
  const memory = query.includes('memory');
  const s = stateOf(ns);
  const result = s.pods.filter((p) => p.phase === 'Running').map((p, i) => {
    const values: [number, string][] = [];
    for (let t = start; t <= end; t += step) {
      const wave = Math.sin(t / 300 + i) * 0.5 + 0.5;
      const v = memory ? (60 + i * 55 + wave * 25) * 1e6 : 0.004 + i * 0.012 + wave * 0.02 * (i + 1);
      values.push([t, String(v)]);
    }
    return { metric: { pod: p.name }, values };
  });
  return { status: 'success', data: { resultType: 'matrix', result } };
}
