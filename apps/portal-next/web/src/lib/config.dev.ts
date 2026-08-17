// The stand-in for bothy-config, used by `vite dev` and by nothing else.
//
// WHY IT EXISTS, and why the READ is mocked as well as the write. `vite dev`
// proxies /-/api/* straight at the live box, which means a real client here
// would rewrite compose files in the repository somebody is working in - the
// same hazard lib/actions.dev.ts exists for, one level worse, because a patch
// leaves no container to restart back. And the read cannot simply be left real:
// the dev browser holds no session cookie for the box, so every fields lookup
// would be a 401 and the form could not be looked at at all while it was being
// built.
//
// lib/config.ts routes to this behind `import.meta.env.DEV`, which vite replaces
// with a literal `false` in a build, so none of this reaches the bundle.
//
// It is deliberately NOT a happy path. Every branch below is a state the real
// interface has to render, and provoking them is the only way to see them before
// anything ships:
//
//   · the conflict, because the whole reason baseMtime exists is a second writer
//     and the 409 is the only screen that has to explain a decision rather than
//     report one;
//   · the policy refusal, because "value must not contain ' #'" is a sentence
//     the page shows verbatim and it has to look right;
//   · 401, 403 and 5xx, because each has a different next action.

import type { FieldsResult, PatchRequest, PatchResult } from './config';

/** Read at call time so it can be changed from the console without a reload. */
const OUTCOME_KEY = 'bothy-dev-config-outcome';

const read = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};

function refuse(status: number, message: string, fromService: boolean, extra?: object): never {
  // Constructed by hand rather than imported, so this module keeps its single
  // type-only import of config.ts. `ConfigRefused` is a class and importing it
  // for its constructor would make this a runtime dependency in both directions.
  const e = new Error(message) as Error & { status: number; fromService: boolean };
  e.name = 'ConfigRefused';
  e.status = status;
  e.fromService = fromService;
  Object.assign(e, extra ?? {});
  throw e;
}

// ONE file, in memory, for as long as the tab lives. Its mtime moves on every
// write exactly as the real one does, so the conflict check is a real check here
// and not a branch that is only ever taken when it is forced.
//
// One rather than a table of every compose file on the box, and the reason is
// that a shared value is worse than no value: a single `FILE` answered for every
// path, so opening a second system showed IT the first system's declared name
// and reported a drift that was an artefact of the mock. Every other path
// returns an empty field list, which is a real state the panel has to render
// anyway - a compose file that declares no name.
const FILE = {
  path: 'edge/compose.yml',
  value: 'Edge · Traefik',
  mtime: 1_755_400_000,
};

const LATENCY = 260;
const wait = () => new Promise((r) => setTimeout(r, LATENCY));

export async function loadFieldsMock(root: string, path: string): Promise<FieldsResult> {
  await wait();
  const forced = read(OUTCOME_KEY);
  if (forced === 'signed-out') refuse(401, 'Unauthorized', false);
  if (forced === 'no-viewer') refuse(403, 'Forbidden', false);
  if (forced === 'silence') refuse(0, 'no answer', false);
  if (forced === 'undeclared' || path !== FILE.path) {
    return { root, path, mtime: FILE.mtime, fields: [], patchable: ['dev.portal.project'] };
  }
  return {
    root,
    path,
    mtime: FILE.mtime,
    fields: [{
      field: 'dev.portal.project',
      service: 'traefik',
      value: FILE.value,
      line: 44,
      kind: 'compose-label',
      maxLength: 80,
    }],
    patchable: ['dev.portal.project'],
  };
}

export async function patchFieldMock(req: PatchRequest): Promise<PatchResult> {
  await wait();
  const forced = read(OUTCOME_KEY);
  if (forced === 'signed-out') refuse(401, 'Unauthorized', false);
  if (forced === 'no-editor') refuse(403, 'Forbidden', false);
  if (forced === 'fault') refuse(500, 'internal error', true);
  if (forced === 'silence') refuse(0, 'no answer', false);
  if (forced === 'unwritable') {
    refuse(422, 'the value changed the document\'s structure', true);
  }
  if (forced === 'raced') {
    // Somebody else wrote between the GET and this POST. The file's mtime moves
    // so the SECOND attempt after a reload succeeds, which is the behaviour the
    // reload button in the conflict state has to be able to produce.
    FILE.value = 'Edge · Traefik (changed elsewhere)';
    FILE.mtime += 41;
  }

  if (req.baseMtime !== FILE.mtime) {
    refuse(409, 'the file changed on disk since the form was loaded', true, {
      conflict: {
        path: req.path,
        baseMtime: req.baseMtime,
        currentMtime: FILE.mtime,
        yours: req.value,
        theirs: [{ field: req.field, service: 'traefik', value: FILE.value }],
      },
    });
  }

  if (req.value === FILE.value) {
    return {
      ok: true, path: req.path, field: req.field, service: 'traefik', value: req.value,
      mtime: FILE.mtime, changed: false, snapshot: false, applied: false,
      appliedNote: 'nothing changed, so nothing to apply',
    };
  }

  const previous = FILE.value;
  FILE.value = req.value;
  FILE.mtime += 7;
  return {
    ok: true, path: req.path, field: req.field, service: 'traefik', value: req.value,
    previous, mtime: FILE.mtime, changed: true, snapshot: true, applied: false,
    author: 'dev@localhost',
    appliedNote:
      'written to the file. A compose label is read at container-creation time, so this takes '
      + 'effect when the service is recreated - that is operator work, not this service\'s.',
  };
}
