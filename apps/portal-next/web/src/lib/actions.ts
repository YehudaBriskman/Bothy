// Acting on what is running: restart, stop, start.
//
// THE CONTRACT ONLY. The service behind this is `bothy-control`; this file is
// written first so the interface and the backend can be built against the same
// shape rather than against each other's guesses.
//
// THREE VERBS, AND NO MORE. Not `exec` - that is root on this box. Not `create`,
// not `rm`, not image pulls, not volume operations. Those are `just` recipes and
// an ssh session, and the reason they stay there is that the mutation surface
// has to be code somebody wrote, not an environment variable away from being
// everything: the read-only socket proxy sets POST=0 precisely because POST=1
// with CONTAINERS=1 also grants /containers/create.
//
// EVERY CALL HERE IS GATED AT THE EDGE on the `operator` role. What this module
// exposes about roles is for the interface - showing a disabled button and a
// reason beats a 403 after a click - and it is never the boundary.

export type Verb = 'restart' | 'stop' | 'start';

export const VERB_MEANING: Record<Verb, string> = {
  restart: 'Stop it and start it again. The container keeps its configuration.',
  stop: 'Leave it stopped. It will not come back until something starts it.',
  start: 'Start a container that is stopped. It keeps the configuration it was created with.',
};

/** What a verb does to something Bothy itself is served through. */
export interface Consequence {
  /** True when acting on this can take away the page you are acting from. */
  selfAffecting: boolean;
  /** Said out loud before the act, not after. */
  warning?: string;
}

// The portal is served THROUGH traefik, BY portal-next, and reads Docker through
// portal-socket-proxy. Stopping any of those from a page they serve is a foot-gun
// that deserves a sentence rather than a toast afterwards - you would lose the
// interface that could put it back.
const SELF: Record<string, string> = {
  traefik: 'Bothy is served through Traefik. Stopping it takes this page down, and the way back is a terminal.',
  'portal-next': 'This page is served by portal-next. Stopping it takes this page down.',
  'portal-socket-proxy': 'Bothy reads Docker through this. Stopping it blinds every page that shows what is running.',
  'portal-files': 'Bothy Files reads and writes through this. Stopping it leaves the editor unable to load or save.',
  'bothy-config': 'Settings writes configuration through this.',
  keycloak: 'Keycloak issues the session you are using. Stopping it means nobody can sign in again, including you.',
  'oauth2-proxy': 'Every role check goes through oauth2-proxy. Stopping it locks the editor and settings tiers.',
};

export function consequenceOf(container: string, verb: Verb): Consequence {
  if (verb === 'start') return { selfAffecting: false };
  const warning = SELF[container];
  return warning ? { selfAffecting: true, warning } : { selfAffecting: false };
}

export interface ActionResult {
  ok: boolean;
  container: string;
  verb: Verb;
  /** What the container's state was before, so the log reads as a transition. */
  from: string;
  to: string;
  /** Milliseconds the daemon took. Restart on a healthcheck-gated service is
   *  not instant, and a UI that claims done before the daemon does is lying. */
  tookMs: number;
}

export interface ActionRefusal {
  error: string;
  /** Set when the refusal is the role, so the UI can offer sign-in rather than
   *  an apology. */
  needsRole?: 'operator';
}

const BASE = '/-/api/control';

/** Rejects with an Error carrying `.status` on refusal. 403 means the role is
 *  missing, which is a fact about the session and not a failure of the page. */
export async function act(container: string, verb: Verb): Promise<ActionResult> {
  const r = await fetch(`${BASE}/${verb}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ container }),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as Partial<ActionRefusal>;
    const err = new Error(body.error ?? `${verb} refused (${r.status})`) as Error & { status: number };
    err.status = r.status;
    throw err;
  }
  return (await r.json()) as ActionResult;
}
