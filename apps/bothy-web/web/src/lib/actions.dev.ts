// The stand-in for bothy-control, used by `vite dev` and by nothing else.
//
// WHY IT EXISTS AT ALL. The interface and the service were written in parallel
// against lib/actions.ts, so there was no backend to develop against - and even
// once there is one, the dev server proxies /-/api/* at the live box, which means
// a real client here would restart real containers on the machine somebody is
// working on. lib/actions.ts routes to this behind `import.meta.env.DEV`, a
// literal `false` after a build, so none of this reaches the bundle.
//
// It is deliberately NOT a happy path. Every branch below is a state the real
// interface has to render, and the only way to see them before the service ships
// is to be able to provoke them:
//
//   · latency, because a restart gated on a healthcheck is not instant and the
//     in-flight state is most of this feature;
//   · 409, because asking a running container to start is the ordinary mistake
//     and the daemon, not the page, is the one that says no;
//   · 403 and 5xx, because both are outcomes with different next actions.
//
// The matching role override lives in lib/session.ts, next to the check it
// overrides rather than here, so nothing has to import a dev module to make a
// production decision.

import type { ActionResult, Verb } from './actions';

/** Read at call time so it can be changed from the console without a reload.
 *  Prefixed like every other key this app owns. */
const OUTCOME_KEY = 'bothy-dev-control-outcome';

const read = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};

/** What a verb leaves behind, in docker's own vocabulary - `from` and `to` are
 *  container states, not the portal's five-word status set. */
const LANDS_ON: Record<Verb, string> = { restart: 'running', stop: 'exited', start: 'running' };

// Roughly what the real thing takes on this box: a stop is a SIGTERM and a wait,
// a start returns as soon as the daemon has forked, a restart is both plus
// whatever the healthcheck's start period costs.
const TAKES: Record<Verb, number> = { restart: 1600, stop: 900, start: 700 };

function refuse(status: number, message: string): never {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  throw e;
}

export async function actMock(container: string, verb: Verb): Promise<ActionResult> {
  const forced = read(OUTCOME_KEY);
  const took = TAKES[verb];
  await new Promise((r) => setTimeout(r, took));

  // `bothy-dev-control-outcome` = 'role' | 'conflict' | 'fault' | 'silence'.
  // One key rather than four, because only one of them can be true at a time.
  if (forced === 'role') refuse(403, 'operator role required');
  if (forced === 'conflict') {
    refuse(409, `container ${container} is already ${verb === 'start' ? 'running' : 'stopped'}.`);
  }
  if (forced === 'fault') refuse(502, 'the docker socket proxy did not answer.');
  if (forced === 'silence') refuse(0, 'no answer');

  return {
    ok: true,
    container,
    verb,
    // The mock cannot read the container's real state - it is a module in the
    // browser - so `from` is the honest guess for the verb that was offered.
    // verbsFor() only offers `start` to something that is not running.
    from: verb === 'start' ? 'exited' : 'running',
    to: LANDS_ON[verb],
    tookMs: took,
  };
}
