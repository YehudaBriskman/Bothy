// Changing one declared value in one file - the client for /-/api/config.
//
// THE CONTRACT AND THE RULES ONLY, on the lib/actions.ts pattern and for the
// same reason: THIS MODULE IMPORTS NOTHING. Everything a form over a compose
// file has to get right is a derivation rather than a render - where a system's
// file is, whether the file is now ahead of the container, how each refusal is
// worded - and a module with no imports is one that can be compiled and
// exercised on its own. React is the part that is hard to test and it is not in
// here.
//
// ── a form is a typed lens over a file, never a second store ────────────────
//
// docs/plans/editing-model.md §1. Every configurable thing on this box is a file
// in git; if this wrote to a database instead, the repository would stop
// describing the box and a `git pull` would silently revert somebody's change.
// So the only write below is a patch to a file, through the one service that
// owns the round-trip parser, with that service's conflict check, snapshot,
// audit line and role gate inherited rather than reinvented.
//
// ── editing is not applying, and this file refuses to pretend otherwise ─────
//
// §4, and the hardest part of the whole feature. A compose label is read when
// the container is CREATED. Writing `dev.portal.project` into edge/compose.yml
// changes the file and changes nothing on screen, because the screen is drawn
// from what docker reports about a container that already exists. The service
// says so in its own response (`applied: false` plus a note), and this module
// turns that into a state the page can render honestly - see driftOf() and
// APPLY, both of which are careful not to claim a restart does something it
// does not.
//
// ── what is NOT here ────────────────────────────────────────────────────────
//
// No optimistic value. Nothing below ever hands back the value somebody typed
// as though it were the value the box is running. The observed side of every
// comparison comes from the container's own labels and the declared side from
// the file, and when they disagree the answer is "they disagree", never a
// spinner and never a quiet substitution.

// ── the field ───────────────────────────────────────────────────────────────

/** The one field the policy declares patchable today: a system's display name.
 *
 *  Named here rather than typed at each call site because it appears in four
 *  places - the fields lookup, the patch body, the container label read for the
 *  observed side, and the copy - and a string literal repeated four times is
 *  three chances to typo something that fails as "not declared in this file". */
export const PROJECT_TITLE_FIELD = 'dev.portal.project';

/** Where each of bothy-config's roots lives on the host.
 *
 *  The service answers in `{root, path}` pairs and a container tells us an
 *  ABSOLUTE host path, so somebody has to hold the mapping between them. It is
 *  policy - apps/bothy-config/policy.toml declares exactly one root, `stacks`,
 *  mounted at /repos/stacks from /home/devssh/stacks - and the browser has no
 *  way to ask for it: /healthz lists the root NAMES and is deliberately not
 *  routed, precisely so the field allowlist is not on the tailnet.
 *
 *  discover.ts holds the same string as `STACK_ROOT` and this does not import
 *  it, which is a duplication worth stating rather than hiding. They answer
 *  different questions: STACK_ROOT decides whether a compose file makes a
 *  container a "project" or a "stack service", and would still be right if
 *  bothy-config were deleted tomorrow. This one is the patch service's mount
 *  list. Sharing them would tie a classification rule to a write policy, and
 *  the import would cost this module the property the header opens with. */
export const ROOT_PATHS: Readonly<Record<string, string>> = {
  // Trailing slash on purpose: without it `/home/devssh/stacks-old/x.yml` would
  // match `stacks` and resolve to the relative path `-old/x.yml`, which the
  // service would then refuse for reasons that have nothing to do with the
  // mistake that was made.
  stacks: '/home/devssh/stacks/',
};

const CONFIG_FILES = 'com.docker.compose.project.config_files';
const COMPOSE_SERVICE = 'com.docker.compose.service';

// ── finding the file ────────────────────────────────────────────────────────

/** A container, reduced to the two things this module needs from it. Structural
 *  rather than discover.ts's `PortalNode`, so nothing has to be imported. */
export interface LabelBearer {
  /** What docker calls it - the name an Apply would act on. */
  container: string;
  /** The label map, exactly as the container carries it. */
  labels: Record<string, string>;
}

/**
 * Where a system's compose file is, or why there is no answer.
 *
 * A SYSTEM DOES NOT CARRY ITS FILE, ITS CONTAINERS DO. There is no registry of
 * compose files on this box and there should not be one; what exists is
 * `com.docker.compose.project.config_files` on every container compose created,
 * which is an absolute host path (or a comma-separated list of them, when the
 * project was brought up with several `-f` flags).
 *
 * The consequence is honest and worth rendering rather than papering over: a
 * system whose containers are gone has no pointer to its file, because the
 * pointer was on the containers. That is a real state, not an error - see
 * `whyNoFile` for what to say about each one.
 */
export type ComposeTarget =
  | {
      t: 'file';
      root: string;
      /** Relative to the root, which is the pair the service speaks in. */
      path: string;
      /** The absolute host path, kept for the copy - "edge/compose.yml" alone is
       *  ambiguous on a box with several repositories. */
      abs: string;
      /** The compose service inside that file, for the recreate command. */
      service: string | null;
      /** The container an Apply would act on. */
      container: string;
      /** What the RUNNING container says the field is - the observed side of the
       *  comparison, and null when the container carries no such label. */
      observed: string | null;
    }
  | { t: 'no-container' }
  | { t: 'no-compose'; container: string }
  | { t: 'outside-roots'; abs: string; container: string };

function underRoot(abs: string): { root: string; path: string } | null {
  for (const root of Object.keys(ROOT_PATHS)) {
    const prefix = ROOT_PATHS[root];
    if (abs.startsWith(prefix) && abs.length > prefix.length) {
      return { root, path: abs.slice(prefix.length) };
    }
  }
  return null;
}

export function composeTarget(
  bearers: readonly LabelBearer[],
  field: string = PROJECT_TITLE_FIELD,
): ComposeTarget {
  if (bearers.length === 0) return { t: 'no-container' };

  // PREFER THE CONTAINER THAT ALREADY CARRIES THE FIELD. Every container in a
  // compose project shares the same config_files label, so any of them names the
  // right FILE - but only one of them is the service the label is declared on,
  // and that is the one an Apply has to recreate. On `edge` the label is on
  // `traefik` and there is one container; on `monitoring` it is on `prometheus`
  // and there are six. Picking the first would offer to recreate cadvisor.
  const chosen =
    bearers.find((b) => b.labels[field])
    ?? bearers.find((b) => b.labels[CONFIG_FILES])
    ?? bearers[0];

  const raw = chosen.labels[CONFIG_FILES];
  if (!raw) return { t: 'no-compose', container: chosen.container };

  const candidates = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const abs of candidates) {
    const hit = underRoot(abs);
    // The FIRST candidate inside a root wins, not the first candidate. A project
    // brought up as `-f compose.yml -f ~/local-override.yml` has one file this
    // service may open and one it may not, and refusing the whole system because
    // the list also mentions an unreachable file would be wrong about which file
    // the label is in.
    if (hit) {
      return {
        t: 'file',
        root: hit.root,
        path: hit.path,
        abs,
        service: chosen.labels[COMPOSE_SERVICE] ?? null,
        container: chosen.container,
        observed: chosen.labels[field] ?? null,
      };
    }
  }
  return { t: 'outside-roots', abs: candidates[0] ?? raw, container: chosen.container };
}

/** What to say when there is no file to edit. Null when there is one.
 *
 *  Each of these is a different NEXT ACTION, which is the only reason to
 *  distinguish them: start the system, edit it where it lives, or accept that
 *  nothing declares this at all. */
export function whyNoFile(target: ComposeTarget): { title: string; detail: string } | null {
  switch (target.t) {
    case 'file':
      return null;
    case 'no-container':
      return {
        title: 'There is no file to edit, because nothing is running.',
        detail:
          'Bothy learns where a system is declared from the containers compose created, and this '
          + 'system has none right now - so the pointer to its file went with them. Start it and this '
          + 'form comes back, or open the compose file directly in Bothy Files.',
      };
    case 'no-compose':
      return {
        title: `${target.container} was not started by docker compose.`,
        detail:
          'It carries no compose labels, so nothing on this box says which file declares it. A '
          + 'container started by hand has no declared name to change - the name it has is the one it '
          + 'was created with.',
      };
    case 'outside-roots':
      return {
        title: 'This system is declared outside the stack repository.',
        detail:
          `It comes from ${target.abs}, and the config service mounts ~/stacks and nothing else. That `
          + 'is deliberate rather than an oversight: the repositories under ~/projects have their own '
          + 'review and CI, and a form that edited them would bypass both. Change it where it lives.',
      };
  }
}

// ── the drift ───────────────────────────────────────────────────────────────

/**
 * The file says one thing and the running container says another.
 *
 * THIS IS DERIVED, NEVER REMEMBERED, and that is the single most important
 * decision in this module. The obvious implementation is a flag set after a
 * successful patch - "I just wrote, so show pending" - and it is wrong in both
 * directions: it shows nothing at all for a file somebody changed in `vim` or in
 * Bothy Files, and it keeps claiming "pending" after a reload of a page whose
 * container was recreated in between.
 *
 * Comparing the two values instead means the state is a fact about the box
 * rather than a memory of this tab. It appears on a page nobody has touched when
 * the file is ahead, and it clears by itself the moment the container is
 * replaced - which is exactly when it stopped being true.
 *
 * `observed` is null for a container that carries no such label at all. That is
 * still drift, and a different sentence: the file names this system and the
 * running container does not.
 */
export interface Drift {
  /** What the file says now. */
  declared: string;
  /** What the running container says, or null if it says nothing. */
  observed: string | null;
}

export function driftOf(
  declared: string | null | undefined,
  observed: string | null | undefined,
): Drift | null {
  if (!declared) return null; // nothing declared cannot be ahead of anything
  if (declared === observed) return null;
  return { declared, observed: observed ?? null };
}

/**
 * What actually applies a compose-label change, said plainly.
 *
 * A RESTART DOES NOT DO IT, and the interface has to say so rather than offer a
 * button that looks like it does. `docker restart` stops and starts the container
 * it already has; labels are fixed on a container when it is created and are not
 * re-read from the file afterwards. bothy-control's three verbs are restart, stop
 * and start, deliberately and permanently - `create` is the thing the write
 * socket proxy is configured to make impossible - so the tier that can apply this
 * is `docker compose up -d`, on the box.
 *
 * This box has already paid for the lesson: the `Role · Vendor` rename changed
 * six compose labels and nothing on screen moved until every affected container
 * was recreated.
 */
export const APPLY = {
  /** The heading over the pending state. */
  title: 'This is written to the file and not yet running.',
  /** Why the page still shows the old name. */
  why:
    'A compose label is read when a container is created, and this container already exists. It '
    + 'keeps the name it was made with until it is replaced, so nothing on this page will move on '
    + 'its own.',
  /** What replaces it. */
  how:
    'Recreating the container applies it. Compose notices the file changed and builds a new '
    + 'container from it, which is where the new label comes from.',
  /** Said next to the Restart button, before it is pressed rather than after. */
  restartCaveat:
    'A restart is not a recreate. It stops and starts the container this system already has, so '
    + 'the label does not move and this notice will still be here afterwards. It is offered because '
    + 'restarting is the one thing Bothy can do to a running service, not because it applies this.',
} as const;

/** The command that applies it, ready to be copied into a shell on the box. */
export function recreateCommand(target: Extract<ComposeTarget, { t: 'file' }>): string {
  // Scoped to the one service rather than the whole file. `up -d` on a project
  // touches every service in it, and recreating six containers to rename one is
  // a bigger act than the one being explained.
  return `docker compose -f ${target.abs} up -d${target.service ? ` ${target.service}` : ''}`;
}

// ── the wire ────────────────────────────────────────────────────────────────

const BASE = '/-/api/config';

export interface FieldSite {
  field: string;
  /** The compose service the label is declared on. Sent back on the patch so the
   *  service never has to guess which of several sites was meant. */
  service: string;
  value: string;
  line: number;
  kind: string;
  maxLength: number;
}

export interface FieldsResult {
  root: string;
  path: string;
  /** The file's modification time, and the whole reason this endpoint returns
   *  the values and the mtime in ONE response: fetched separately, a client
   *  could read a file, have it change, then read the newer mtime and send a
   *  patch that passes the conflict check while carrying the older value. */
  mtime: number;
  fields: FieldSite[];
  /** Every field the policy declares, so a page can say "nothing here is a form
   *  field" without a hardcoded list. */
  patchable: string[];
}

export interface Conflict {
  path: string;
  baseMtime: number;
  currentMtime: number;
  /** What this form was about to write. */
  yours: string;
  /** What the field says on disk right now. */
  theirs: { field: string; service: string; value: string }[];
}

/** A refusal that carries what the wire said about it.
 *
 *  `fromService` separates "bothy-config answered and said no" from "the edge
 *  never let this through", which is the difference between a policy message
 *  worth showing verbatim and a session problem. See parseFailure. */
export class ConfigRefused extends Error {
  status: number;
  fromService: boolean;
  conflict?: Conflict;

  constructor(status: number, message: string, fromService: boolean, conflict?: Conflict) {
    super(message);
    this.name = 'ConfigRefused';
    this.status = status;
    this.fromService = fromService;
    this.conflict = conflict;
  }
}

const isJson = (r: Response): boolean =>
  (r.headers.get('content-type') ?? '').includes('json');

/**
 * Turn a non-2xx into a ConfigRefused, and decide who said no.
 *
 * THE CONTENT TYPE IS THE TELL, not the status code, and this is the one piece
 * of protocol knowledge the whole module rests on. bothy-config answers every
 * refusal as JSON `{"error": "..."}` with a message written for a person to
 * read. The edge answers in neither: a missing session is a 401 whose body
 * Traefik's `sso-errors` middleware replaces with oauth2-proxy's sign-in page,
 * and a session without the role is oauth2-proxy's own plain-text 403.
 *
 * So a 403 with JSON is the policy talking - "value must not contain ' #'" -
 * and a 403 without JSON is the role. Branching on the status alone would print
 * a sign-in prompt at somebody who typed a hash in a project name.
 */
async function parseFailure(r: Response): Promise<ConfigRefused> {
  if (!isJson(r)) {
    return new ConfigRefused(r.status, `refused with ${r.status}`, false);
  }
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  const message = typeof body.error === 'string' ? body.error : `refused with ${r.status}`;
  const conflict =
    r.status === 409 && Array.isArray(body.theirs)
      ? ({
          path: String(body.path ?? ''),
          baseMtime: Number(body.baseMtime ?? 0),
          currentMtime: Number(body.currentMtime ?? 0),
          yours: String(body.yours ?? ''),
          theirs: body.theirs as Conflict['theirs'],
        } satisfies Conflict)
      : undefined;
  return new ConfigRefused(r.status, message, true, conflict);
}

/** A 200 IS NOT PROOF THAT THIS ROUTE EXISTS.
 *
 *  The portal is a catch-all on :80 at priority 1, so any path Traefik has no
 *  rule for is answered by the portal itself - HTML, status 200, from the bare
 *  IP and from any hostname. A JSON.parse failure on that body would surface as
 *  "Unexpected token <", which is true about the bytes and useless to a reader.
 *  Anything that is not JSON is treated as nothing having answered, because that
 *  is what it is. */
function mustBeJson(r: Response): void {
  if (!isJson(r)) {
    throw new ConfigRefused(0, 'answered by something that is not Bothy Config', false);
  }
}

/** What this file declares that a form may change, and what it says now. */
export async function loadFields(
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<FieldsResult> {
  // DEV NEVER TOUCHES THE REAL REPOSITORY, for the same reason lib/actions.ts
  // never touches the real daemon: `vite dev` proxies /-/api/* straight at the
  // live box, so a patch typed into a dev tab would rewrite a compose file on
  // the machine somebody is working on. `import.meta.env.DEV` is replaced with a
  // literal `false` in a build, so the import below is not in the shipped
  // bundle. The READ is mocked too, and not only the write - against the live
  // box a dev tab holds no session cookie, so the real read is a 401 and the
  // form could never be looked at while it was being built.
  if (import.meta.env.DEV) {
    const { loadFieldsMock } = await import('./config.dev');
    return loadFieldsMock(root, path);
  }

  const q = `root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
  const r = await fetch(`${BASE}/fields?${q}`, { signal, headers: { Accept: 'application/json' } });
  if (!r.ok) throw await parseFailure(r);
  mustBeJson(r);
  return (await r.json()) as FieldsResult;
}

export interface PatchRequest {
  root: string;
  path: string;
  field: string;
  value: string;
  /** From the GET that filled the form in. Required by the service, and the
   *  reason it is required is that a form sends one value for a file it never
   *  showed anybody - a patch with no baseMtime is a patch against a version
   *  nobody can name. */
  baseMtime: number;
  /** Which compose service, when the file declares the field more than once. */
  service?: string;
}

export interface PatchResult {
  ok: boolean;
  path: string;
  field: string;
  service: string;
  value: string;
  /** Absent when nothing changed. */
  previous?: string;
  mtime: number;
  changed: boolean;
  /** Reported by the service rather than assumed here, so "there is an undo net"
   *  is never something the interface claims on its behalf. */
  snapshot: boolean;
  /** Always false today, and the interface must not paper over it. */
  applied: boolean;
  appliedNote: string;
  author?: string;
}

export async function patchField(req: PatchRequest): Promise<PatchResult> {
  if (import.meta.env.DEV) {
    const { patchFieldMock } = await import('./config.dev');
    return patchFieldMock(req);
  }

  const r = await fetch(`${BASE}/patch`, {
    method: 'POST',
    // application/json is not decoration. The service refuses anything else with
    // a 415, because a text/plain POST is a CORS-simple request that skips the
    // preflight - and the session cookie is sent to every port on this host, so
    // a page on the sandbox origin is same-site with this one.
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(req),
  });
  if (!r.ok) throw await parseFailure(r);
  mustBeJson(r);
  return (await r.json()) as PatchResult;
}

// ── refusals, in the interface's own words ──────────────────────────────────

/**
 * The microcopy rule is: what happened, why if you know, what to do next - and
 * never a bare status code, because "409" is for the console.
 *
 * The families below are the different NEXT ACTIONS, which is the only reason to
 * distinguish them at all:
 *
 *   · no session          -> sign in, and come back here
 *   · no role             -> ask for it; it is granted in Keycloak, not here
 *   · the file moved      -> reload the form and decide again
 *   · the policy said no  -> the service's own sentence, which names the fix
 *   · the file is unusual -> this is Bothy Files' job, not a form's
 *   · nothing answered    -> the service is not running or not reachable
 */
export interface Refusal {
  title: string;
  detail: string;
  /** Set when the fix is a session or a role rather than a retry. */
  needs: 'sign-in' | 'editor' | 'viewer' | null;
  /** Set on a 409, so the page can show what it would have overwritten. */
  conflict?: Conflict;
}

export function refusalOf(e: unknown, act: 'read' | 'write'): Refusal {
  // Read STRUCTURALLY rather than with `instanceof ConfigRefused`, on the same
  // reasoning as lib/actions.ts. The dev stand-in throws its own error object -
  // it holds a type-only import of this module on purpose, so that a mock cannot
  // become a runtime dependency of the thing it mocks - and an `instanceof` that
  // quietly answered "nothing replied" to every mocked refusal would make the
  // whole dev path a happy path.
  const r = e as { status?: unknown; fromService?: unknown; message?: unknown; conflict?: unknown } | null;
  const status = typeof r?.status === 'number' ? r.status : 0;
  const fromService = r?.fromService === true;
  const conflict = (r?.conflict ?? undefined) as Conflict | undefined;
  // Only trusted when bothy-config itself answered in its own format. Everything
  // else that lands here - a sign-in page, a plain-text 403, the portal
  // catch-all - has a body that is about HTTP rather than about this field.
  const said = fromService && typeof r?.message === 'string' ? r.message : '';

  if (status === 401) {
    return {
      title: 'Sign in to change this.',
      detail:
        'Nothing here knows who you are yet, so the edge refused the request before it reached the '
        + 'config service. Signing in returns you to this page.',
      needs: 'sign-in',
    };
  }
  if (status === 403 && !fromService) {
    return act === 'read'
      ? {
          title: 'You may not read this system’s configuration.',
          detail:
            'Seeing what a form can change needs the viewer role, and this session does not hold it. '
            + 'Settings lists the four roles and what each one permits; they are granted in Keycloak, '
            + 'not here.',
          needs: 'viewer',
        }
      : {
          title: 'You may not change this.',
          detail:
            'Writing a declared value needs the editor role, and this session does not hold it. '
            + 'Nothing was written. Settings lists the four roles and what each one permits; they are '
            + 'granted in Keycloak, not here.',
          needs: 'editor',
        };
  }
  if (status === 409 && conflict) {
    return {
      title: 'This file changed while the form was open.',
      detail:
        'Somebody or something else wrote to it after this form was filled in - another tab, Bothy '
        + 'Files, or an editor on the box. Nothing was written, because saving now would have thrown '
        + 'their change away without showing it to you. Reload the form to see what it says and '
        + 'decide again.',
      needs: null,
      conflict,
    };
  }
  if (status === 409) {
    // The other 409 the service returns: one field declared on several services
    // in one file. It names the services in its message, and that message is the
    // whole of what is worth saying.
    return {
      title: 'This name is declared more than once in the file.',
      detail: said
        ? `${said} Nothing was written.`
        : 'The same label appears on more than one service in this compose file, so there is no '
          + 'single value to change. Nothing was written. Bothy Files shows the file as it is.',
      needs: null,
    };
  }
  if (status === 403 || status === 400) {
    // The policy talking. Its sentences are written for a person and each one
    // names the fix - "value must not contain ': ' or end with ':' - YAML would
    // read it as a key" - so repeating a generic apology after it would read as
    // the page not having listened.
    return {
      title: 'That value was not written.',
      detail: said
        ? `${capitalise(said)}. Nothing was changed.`
        : 'The config service refused it and did not say why. Nothing was changed.',
      needs: null,
    };
  }
  if (status === 404) {
    return {
      title: 'That name is not declared in this file.',
      detail:
        'The compose file no longer carries the label this form edits, so there is nothing to '
        + 'change. It may have been removed by hand. Bothy Files shows the file as it is now.',
      needs: null,
    };
  }
  if (status === 422) {
    return {
      title: 'This file is in a shape a form will not change.',
      detail: (said ? `${capitalise(said)}. ` : '')
        + 'The config service refuses to write a file it cannot re-read exactly as it wrote it, '
        + 'rather than reformatting it into something it can express. Nothing was changed, and the '
        + 'answer is to edit it as text in Bothy Files.',
      needs: null,
    };
  }
  if (status >= 500) {
    return {
      title: 'Bothy Config faulted.',
      detail: (said ? `${capitalise(said)}. ` : '')
        + 'The service that writes configuration answered with a fault of its own. Its logs will say '
        + 'why; nothing was changed unless they say otherwise.',
      needs: null,
    };
  }
  return {
    title: 'Bothy Config did not answer.',
    detail:
      'Nothing that understands this request replied, so nothing was changed. The service that '
      + 'writes configuration is either not running or not reachable from here.',
    needs: null,
  };
}

/** The service's messages start lower-case because they are fragments; here they
 *  are the first word of a sentence. */
function capitalise(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

// ── what the form itself can refuse ─────────────────────────────────────────

/**
 * The same rules the service applies, applied before the round trip.
 *
 * THIS IS NOT THE BOUNDARY AND MUST NEVER BE MISTAKEN FOR IT. bothy-config
 * validates every one of these again and would refuse a hand-written curl
 * identically; what this buys is that the reason arrives while somebody is
 * typing rather than after they press save. The wording is the service's own
 * reasoning in the interface's voice, so the two never disagree about what is
 * legal.
 *
 * Returns null when the value is fine. The value is NOT sanitised into a legal
 * one, on the service's own reasoning: silently trimming a hostile value means
 * an attack and a typo produce the same quiet success.
 */
export function whyRefused(value: string, maxLength: number): string | null {
  if (value === '') return 'A name cannot be empty. Removing a name is a different act from changing it, and not one this form does.';
  if (value.length > maxLength) return `A name can be at most ${maxLength} characters. This one is ${value.length}.`;
  if (/[\n\r\t\0]/.test(value)) return 'A name cannot contain a line break or a tab.';
  if (/^\s|\s$/.test(value)) return 'A name cannot start or end with a space - YAML would strip it, and the file would not say what you typed.';
  // The two sequences a plain YAML scalar cannot carry. They are refused rather
  // than quoted because quoting rewrites the whole label item instead of the
  // value inside it, and the span that was proved literal would no longer be the
  // span being written.
  if (value.includes(' #')) return 'A name cannot contain a space followed by "#" - YAML would read the rest of the line as a comment, and the name would silently lose its ending.';
  if (value.includes(': ') || value.endsWith(':')) return 'A name cannot contain ": " or end with ":" - YAML would read it as a key rather than a name.';
  return null;
}
