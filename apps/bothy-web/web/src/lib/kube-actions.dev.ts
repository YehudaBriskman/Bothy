// The stand-in for bothy-ops' kube verbs, used by `vite dev` and by nothing else.
//
// Same reason as actions.dev.ts: the dev server proxies /-/api/* at the live
// box, so a real client in a dev tab would restart real pods. lib/kube-actions.ts
// routes here behind `import.meta.env.DEV`, a literal false after a build.
//
// Not a happy path. Force an outcome from the console:
//   localStorage['bothy-dev-kube-outcome'] = 'role' | 'scope' | 'fault' | 'silence'
// and grant roles for drawing with the existing key:
//   localStorage['bothy-dev-roles'] = 'viewer,operator'

import type { KubeActionId, KubeTarget, LogStreamHandlers } from './kube-actions';

const OUTCOME_KEY = 'bothy-dev-kube-outcome';

const read = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};

function refuse(status: number, message: string): never {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  throw e;
}

const TAKES: Record<KubeActionId, number> = {
  'rollout-restart': 900, scale: 700, events: 350, logs: 400, 'delete-completed-pods': 800,
};

const replicas: Record<string, number> = {};

const SAMPLE = [
  'GET /healthz 200 1ms',
  'INFO  starting worker pool size=4',
  'GET /api/items?limit=50 200 12ms',
  'WARN  slow query took=842ms table=detections',
  'GET /api/items/41 200 4ms',
  'POST /api/login 302 38ms',
];

export async function kubeMock(id: KubeActionId, body: Record<string, unknown>): Promise<unknown> {
  await new Promise((r) => setTimeout(r, TAKES[id]));
  const forced = read(OUTCOME_KEY);
  if (forced === 'role') refuse(403, `${id} refused (403)`);
  if (forced === 'scope') refuse(403, `namespace 'kube-system' is out of scope - bothy-ops acts on thales-dev and thales-pre-prod only`);
  if (forced === 'fault') refuse(502, 'the cluster refused bothy-ops (403): forbidden - its token or its Role has diverged from the catalog');
  if (forced === 'silence') refuse(0, 'no answer');

  const namespace = String(body.namespace ?? '');
  const target = String(body.deployment ?? namespace);
  const base = { ok: true, namespace, target, tookMs: TAKES[id] };
  const key = `${namespace}/${target}`;
  switch (id) {
    case 'rollout-restart':
      return { ...base, restartedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), fromGeneration: 4, toGeneration: 5, replicas: replicas[key] ?? 1 };
    case 'scale': {
      if (body.confirm !== target) refuse(400, `scale must be confirmed by typing the name of what it acts on (confirm must equal '${target}')`);
      const from = replicas[key] ?? 1;
      replicas[key] = Number(body.replicas);
      return { ...base, from, to: replicas[key] };
    }
    case 'events': {
      const now = Date.now();
      const at = (s: number) => new Date(now - s * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
      return {
        ...base,
        events: [
          { type: 'Normal', reason: 'ScalingReplicaSet', message: `Scaled up replica set ${target}-6d9f8 to 1`, object: `Deployment/${target}`, count: 1, lastSeen: at(40) },
          { type: 'Warning', reason: 'Unhealthy', message: 'Readiness probe failed: HTTP probe failed with statuscode: 503', object: `Pod/${target}-6d9f8-x2k4q`, count: 3, lastSeen: at(95) },
          { type: 'Normal', reason: 'Pulled', message: 'Container image already present on machine', object: `Pod/${target}-6d9f8-x2k4q`, count: 1, lastSeen: at(120) },
          { type: 'Normal', reason: 'SuccessfulCreate', message: `Created pod: ${target}-6d9f8-x2k4q`, object: `ReplicaSet/${target}-6d9f8`, count: 1, lastSeen: at(124) },
        ],
      };
    }
    case 'logs':
      return {
        ...base, pod: `${target}-6d9f8-x2k4q`, container: target, pods: [`${target}-6d9f8-x2k4q`], containers: [target],
        lines: Array.from({ length: 24 }, (_, i) => `2026-09-17T10:${String(i).padStart(2, '0')}:00Z ${SAMPLE[i % SAMPLE.length]}`),
      };
    case 'delete-completed-pods':
      return { ...base, deleted: ['migrate-29301-8kq2d', 'seed-fixture-4mz7p'], skipped: [] };
  }
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
