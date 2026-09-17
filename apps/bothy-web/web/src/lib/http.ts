// The one way Bothy's action and config modules talk to a backend.
//
// lib/actions.ts, lib/kube-actions.ts and lib/config.ts each carried their own
// copy of the same fetch: send JSON, read a refusal's `{"error": ...}`, and -
// the part that mattered - refuse to believe a 200 that is not JSON. Three
// copies had already drifted in wording; one cannot.
//
// A 200 IS NOT PROOF THAT A ROUTE EXISTS. The portal is a catch-all on :80 at
// priority 1, so any /-/api path Traefik has no exact Path() rule for is
// answered by the portal itself - HTML, status 200, from any hostname. A
// JSON.parse on that body would surface as "Unexpected token <", true about the
// bytes and useless to a reader. So apiFetch() checks the content type before
// it believes the body, and treats HTML as nothing having answered (status 0).
//
// THIS MODULE IMPORTS NOTHING. checks/run.sh compiles actions.ts and
// kube-actions.ts standalone and exercises them in node; they import this file,
// so it must stay import-free for that to keep working.

/** A refusal as the wire said it. `status` 0 means nothing that understands the
 *  request answered (network failure, or the portal catch-all's HTML). */
export class ApiRefused extends Error {
  status: number;
  /** True when the backend answered in its own JSON format - its message is
   *  written for a person. False for the edge (oauth2-proxy's sign-in page or
   *  plain-text 403) and for the catch-all. */
  fromService: boolean;
  /** The parsed JSON body of a service refusal, `{}` otherwise. */
  body: Record<string, unknown>;

  constructor(status: number, message: string, fromService: boolean, body: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiRefused';
    this.status = status;
    this.fromService = fromService;
    this.body = body;
  }
}

export interface ApiFetchOptions {
  /** GET unless a body is given. */
  method?: 'GET' | 'POST';
  /** Sent as JSON. application/json is not decoration: every backend refuses
   *  anything else with a 415, because a text/plain POST is a CORS-simple
   *  request that skips the preflight (bothy_common/http.py). */
  body?: unknown;
  signal?: AbortSignal;
  /** The message when a refusal carries no `error` of its own. */
  refused?: (status: number) => string;
  /** The message when a 200 is not JSON. */
  notService?: string;
}

const isJson = (r: Response): boolean => (r.headers.get('content-type') ?? '').includes('json');

/** Fetch a JSON API path on this origin. Resolves with the parsed body, or
 *  rejects with an ApiRefused carrying `.status`. */
export async function apiFetch<T>(url: string, o: ApiFetchOptions = {}): Promise<T> {
  const post = o.method === 'POST' || o.body !== undefined;
  const r = await fetch(url, {
    method: post ? 'POST' : 'GET',
    signal: o.signal,
    credentials: 'same-origin',
    headers: post
      ? { 'Content-Type': 'application/json', Accept: 'application/json' }
      : { Accept: 'application/json' },
    body: post ? JSON.stringify(o.body ?? {}) : undefined,
  });
  if (!r.ok) {
    const json = isJson(r);
    const body = json ? ((await r.json().catch(() => ({}))) as Record<string, unknown>) : {};
    const message = typeof body.error === 'string'
      ? body.error
      : (o.refused ? o.refused(r.status) : `refused with ${r.status}`);
    throw new ApiRefused(r.status, message, json, body);
  }
  if (!isJson(r)) {
    throw new ApiRefused(0, o.notService ?? 'answered by something that is not a Bothy service', false);
  }
  return (await r.json()) as T;
}

/**
 * Which family a refusal status belongs to. The families are the different
 * NEXT ACTIONS - the only reason to tell refusals apart at all - and each module
 * words them in its own terms:
 *
 *   silent       nothing answered (0), or a status no family claims
 *   sign-in      401 - no session; sign in and come back
 *   role         403 - the session lacks the role (or, with a service message,
 *                the service's own 403: an out-of-scope namespace, a policy)
 *   conflict     409 - the thing changed, or is already in that state
 *   refused      another 4xx (400/404/405/413/415/422/429) - the request was
 *                understood and declined; the service's sentence says why
 *   unavailable  503 - the backend is up but what it depends on is not (for
 *                bothy-ops' kube verbs: the cluster)
 *   fault        another 5xx - the backend faulted; its logs say why
 */
export type RefusalKind = 'silent' | 'sign-in' | 'role' | 'conflict' | 'refused' | 'unavailable' | 'fault';

export function refusalOf(status: number): RefusalKind {
  if (status === 401) return 'sign-in';
  if (status === 403) return 'role';
  if (status === 409) return 'conflict';
  if (status === 503) return 'unavailable';
  if (status >= 500) return 'fault';
  if (status >= 400) return 'refused';
  return 'silent';
}

/** The status an error carries, read STRUCTURALLY: the dev stand-ins throw their
 *  own objects, and an `instanceof` that answered "nothing replied" to every
 *  mocked refusal would make the whole dev path a happy path. */
export function statusOf(e: unknown): number {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : 0;
}
