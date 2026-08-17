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

// THIS MODULE IMPORTS NOTHING, and that is worth keeping. checks/run.sh can only
// compile and exercise a file that has no imports, and every rule below - which
// verbs a state deserves, how a refusal is worded - is the kind of thing that is
// cheap to get wrong and cheap to check. `verbsFor` therefore takes the status as
// a plain string rather than importing discover.ts's `Status` union.

export type Verb = 'restart' | 'stop' | 'start';

export const VERB_MEANING: Record<Verb, string> = {
  restart: 'Stop it and start it again. The container keeps its configuration.',
  stop: 'Leave it stopped. It will not come back until something starts it.',
  start: 'Start a container that is stopped. It keeps the configuration it was created with.',
};

/** The button. Sentence case, and the verb names the outcome. */
export const VERB_LABEL: Record<Verb, string> = {
  restart: 'Restart',
  stop: 'Stop',
  start: 'Start',
};

/** While the daemon has been asked and has not answered. */
export const VERB_WORKING: Record<Verb, string> = {
  restart: 'Restarting',
  stop: 'Stopping',
  start: 'Starting',
};

/** After it has. */
export const VERB_DONE: Record<Verb, string> = {
  restart: 'Restarted',
  stop: 'Stopped',
  start: 'Started',
};

/**
 * Which verbs are worth offering for a container in this state, most likely
 * first.
 *
 * Offering all three always would be simpler and would be a worse page: `Start`
 * beside a running container is a button whose only outcome is a 409, and the
 * interface knew that before the click. The daemon is still the authority - this
 * only decides what is worth drawing.
 *
 * The DOCKER STATE is passed as well as the portal's status because the two
 * answer different questions and only one of them can tell these apart:
 * discover.ts collapses "exited non-zero", "restarting in a loop" and "running
 * but unhealthy" into the single word `down` (correctly - they are all "meant to
 * be up and is not"), and those three want different verbs. `restarting` gets
 * Stop FIRST, because a container docker is flapping is the one case where
 * restarting it again is the least useful thing you can do.
 */
export function verbsFor(status: string, dockerState?: string): Verb[] {
  switch (dockerState) {
    case 'running':   return ['restart', 'stop'];
    case 'restarting': return ['stop', 'restart'];
    // Paused is rare enough that there is no Unpause verb, and there are only
    // ever going to be three verbs. `docker stop` does end a paused container,
    // and `docker restart` does resume one, so both are real answers.
    case 'paused':    return ['restart', 'stop'];
    case 'exited': case 'created': case 'dead': return ['start'];
    default: break;
  }
  // No container state to read - fall back on what the page itself decided. An
  // `unknown` node is a route with nothing behind it, and there is nothing to
  // act on.
  switch (status) {
    case 'up': case 'starting': return ['restart', 'stop'];
    case 'stopped': return ['start'];
    // `down` with no readable state: it exists and it is wrong, and either
    // restarting it or stopping the flapping is a defensible next move.
    case 'down': return ['restart', 'stop'];
    default: return [];
  }
}

/**
 * A refusal, in the interface's own words.
 *
 * The microcopy rule is: what happened, why if you know, what to do next - and
 * never a bare status code, because "409" is for the console. The four families
 * below are the four different NEXT ACTIONS, which is the only reason to
 * distinguish them at all:
 *
 *   · the role is missing        -> sign in, or ask for the role
 *   · the daemon said no         -> look at what the container is actually doing
 *   · the control service faulted -> read its logs
 *   · nothing answered           -> it is not running, or not reachable
 */
export interface Refusal {
  /** One line, first. */
  title: string;
  /** Why, and what to do about it. */
  detail: string;
  /** True when the fix is a session rather than a retry. */
  needsRole: boolean;
}

export function refusalOf(e: unknown, verb: Verb, container: string): Refusal {
  const status = typeof (e as { status?: unknown })?.status === 'number'
    ? (e as { status: number }).status
    : 0;
  // Only trusted when the service answered in its own format. A 200 of HTML from
  // the portal catch-all also lands in here, and its "message" would be a JSON
  // parse error - which is true about the bytes and useless to a reader.
  const said = status > 0 && e instanceof Error ? e.message : '';

  if (status === 401 || status === 403) {
    return {
      title: `You may not ${verb} ${container}.`,
      detail: 'Acting on what is running needs the operator role, and this session does not hold it. '
        + 'Settings lists the four roles and what each one permits; they are granted in Keycloak, not here.',
      needsRole: true,
    };
  }
  if (status === 409) {
    return {
      title: `Docker would not ${verb} ${container}.`,
      // When the daemon gave a reason, that reason IS the explanation and
      // repeating the generic one after it reads as the page not having listened.
      detail: said
        ? `${said} Nothing was changed.`
        : 'Nothing was changed. Most often the container is already in the state you asked for, or '
          + 'another change is in flight; the status beside its name is what docker thinks now.',
      needsRole: false,
    };
  }
  if (status >= 500) {
    return {
      title: `Bothy Control could not ${verb} ${container}.`,
      detail: (said ? `${said} ` : '')
        + 'The service that performs actions answered with a fault of its own. Its logs will say why; '
        + 'nothing was changed unless they say otherwise.',
      needsRole: false,
    };
  }
  return {
    title: 'Bothy Control did not answer.',
    detail: 'Nothing that understands this request replied, so nothing was changed. The service that '
      + 'performs actions is either not running or not reachable from here.',
    needsRole: false,
  };
}

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
  // DEV NEVER TOUCHES THE REAL DAEMON, and that is a safety property rather than
  // a stub waiting to be removed. `vite dev` proxies /-/api/* straight at the
  // live box (vite.config.ts), so the day bothy-control ships, a stray click in
  // a dev tab would stop the edge on the machine somebody is working on. The
  // check is `import.meta.env.DEV`, which vite replaces with a literal `false`
  // in a build, so the import below is not in the shipped bundle at all.
  if (import.meta.env.DEV) {
    const { actMock } = await import('./actions.dev');
    return actMock(container, verb);
  }

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
  // A 200 IS NOT PROOF THAT THIS ROUTE EXISTS. The portal is a catch-all on :80
  // at priority 1, so any path Traefik has no rule for is answered by the portal
  // itself - HTML, status 200, from the bare IP and from any hostname. Measured
  // against the live box today, POST /-/api/control/restart returns 405 with an
  // HTML body, which at least fails; a GET-shaped route would return 200 and
  // this function would hand a page of HTML back as an ActionResult.
  //
  // So the content type is checked before the body is believed. Anything that is
  // not JSON is the same outcome as nothing answering, because that is what it
  // is: the request never reached a service that understood it.
  if (!(r.headers.get('content-type') ?? '').includes('json')) {
    const err = new Error(`${verb} was answered by something that is not Bothy Control`) as Error & { status: number };
    err.status = 0;
    throw err;
  }
  return (await r.json()) as ActionResult;
}
