// Restart, stop, start - the affordance, on the row you are looking at.
//
// ONE CONTROL PER ROW, NOT A COLUMN OF THREE. The footprint rule (principles.md
// rule 3) says an element's size is proportional to the number of independent
// facts it carries, and "you may act on this" is one bit. Three verb buttons in
// every row would be three bits of affordance per row and ~120 of them on the
// Services page, drawn permanently, for a thing done a few times a week. So the
// row carries a single 26px trigger which is transparent until the row is
// hovered or the trigger is focused, and every word - which verbs apply, what
// each one does, what it will cost - lives in the dialog it opens.
//
// The dialog is not only a confirm step. It is where the verbs are CHOSEN, which
// is what lets the choice be explained: VERB_MEANING exists in the contract for
// exactly this, and a tooltip on an icon in a table cell could not carry it.
// Only a self-affecting verb then adds a second step - see below.
//
// WHAT THE INTERFACE HIDES IS NEVER WHAT THE API ENFORCES. `canAct` decides
// whether the verbs are drawn live or explained-and-inert. It has stopped
// nothing: every /-/api/control/* call is gated at the edge by a forwardAuth
// middleware reading a signed cookie, and it would refuse a hand-written curl
// exactly the same way. This is a courtesy that saves a round trip, and it turns
// a bare 403 into a sentence that arrives before the click rather than after it.

import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CirclePlay, CircleStop, LogIn, Power, RotateCw } from 'lucide-react';
import {
  act, consequenceOf, refusalOf, verbsFor,
  VERB_DONE, VERB_LABEL, VERB_MEANING, VERB_WORKING,
  type ActionResult, type Refusal, type Verb,
} from '../lib/actions';
import { useOperator } from '../lib/session';
import { usePortal } from '../lib/data';
import { signInHref } from '../lib/me';
import type { PortalNode } from '../lib/discover';
import { StatusIcon } from '../lib/icons';
import { Dialog } from './ui/Dialog';
import './ServiceActions.css';

// Three circles. lucide's bare `Square` was the first choice for stop and had to
// go: rendered at 16px on the left of a list row it is a 16px empty box beside a
// bold word, which is a checkbox, and the verb list read as a form you were meant
// to tick. `CircleStop` and `CirclePlay` carry the mark inside a ring, which no
// control in this app uses for anything else, and `RotateCw` is already a ring.
const VERB_ICON: Record<Verb, typeof RotateCw> = {
  restart: RotateCw,
  stop: CircleStop,
  start: CirclePlay,
};

// The contract's SELF table is written for `stop` - "Stopping it takes this page
// down, and the way back is a terminal" - and consequenceOf() returns the same
// sentence for a restart, which is not the same claim: a restart puts it back,
// and the thing worth saying is what it costs if it does not. Rather than
// rewrite the contract's sentences per verb (they are the backend's words too,
// and they are right about what is at stake), the verb supplies the frame and
// the contract supplies the stake.
const CONSEQUENCE_LEAD: Partial<Record<Verb, string>> = {
  restart: 'A restart is meant to put it back within a few seconds. If it does not come back, this is what you have lost:',
  stop: 'This does not come back on its own:',
};

// The mark on the verb row. "Takes something away" is true of a stop and an
// overstatement of a restart, and a warning that overstates gets clicked through.
const CONSEQUENCE_FLAG: Partial<Record<Verb, string>> = {
  restart: 'Interrupts something',
  stop: 'Takes something away',
};

// Five states, one union, because they are mutually exclusive and modelling them
// as four booleans is how a page comes to be "working" and "done" at once.
type Phase =
  | { t: 'choose' }
  | { t: 'confirm'; verb: Verb; warning: string }
  | { t: 'working'; verb: Verb }
  | { t: 'done'; verb: Verb; res: ActionResult }
  | { t: 'failed'; verb: Verb; refusal: Refusal };

/** The row cell. Renders nothing at all for a node with no container - an
 *  @file route or a host process has nothing docker can be asked about, and an
 *  affordance that could only ever fail is worse than an empty cell. */
export function ActionCell({ node }: { node: PortalNode }) {
  const [open, setOpen] = useState(false);
  if (!node.container) return null;

  const name = node.container.name;
  return (
    <>
      <button
        type="button"
        className="svc-act-btn"
        // The row itself navigates to the detail page. Without this, opening the
        // dialog also leaves the page it was opened from.
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        // Kept visible while its own dialog is open, or the trigger vanishes
        // under the overlay and reappears on close for no reason the reader can
        // see. Also the hook for the focus ring, since opacity alone would
        // return it to transparent the moment focus is styled rather than held.
        data-open={open ? 'true' : 'false'}
        // The container, in the name, because a screen reader reading the
        // controls of a forty-row table hears this forty times and "Actions"
        // forty times is forty identical buttons. `title` is the third fallback
        // for touch, where neither hover nor focus-visible fires.
        aria-label={`Restart, stop or start ${name}`}
        title={`Restart, stop or start ${name}`}
      >
        <Power size={15} aria-hidden="true" />
      </button>
      {/* Mounted only while open. Radix renders no portal content for a closed
          dialog, but the hooks inside would still run once per row on every
          poll, and there are forty rows. */}
      {open && <ActionDialog node={node} onClose={() => setOpen(false)} />}
    </>
  );
}

function ActionDialog({ node, onClose }: { node: PortalNode; onClose: () => void }) {
  const name = node.container?.name ?? node.name;
  const { canAct, me, loading } = useOperator();
  const { refresh } = usePortal();
  const [phase, setPhase] = useState<Phase>({ t: 'choose' });
  // A second guard behind the disabled attribute. `disabled` is set by a state
  // update, and two clicks inside one frame both read the old state - which for
  // `restart` means asking docker to restart something that is already mid
  // restart, and a 409 the reader cannot explain.
  const firing = useRef(false);

  const dockerState = typeof node.container?.state === 'string' ? node.container.state : undefined;
  const verbs = verbsFor(node.status, dockerState);

  const run = useCallback(async (verb: Verb) => {
    if (firing.current) return;
    firing.current = true;
    setPhase({ t: 'working', verb });
    try {
      const res = await act(name, verb);
      setPhase({ t: 'done', verb, res });
      // FORCE A POLL, do not wait for the one that is coming.
      //
      // The shared poll is 10s and it does not run at all while the tab is
      // hidden, so the row behind this dialog could read "Up" for ten seconds
      // after a successful stop - which looks exactly like the stop having
      // failed, and is the one outcome that would make somebody press it twice.
      //
      // The row is NOT patched optimistically instead. discover.ts::statusOf is
      // the only thing allowed to turn a container into one of five words, and a
      // second opinion written here would be a second classifier to keep in
      // agreement with it - the exact bug the "status comes from node.status and
      // NOTHING else" comment in ServiceRow.tsx records. A refetch is authority,
      // not a guess.
      //
      // It also does not close the gap on its own, and is not asked to: a
      // restart gated on a healthcheck comes back `starting`, and only settles to
      // `up` a few seconds later. That later transition is precisely what the
      // 10s poll is for. What this dialog adds is the daemon's own answer -
      // `from`, `to` and how long it took - which is true earlier than any poll
      // can be, and stays on screen until it is dismissed.
      refresh();
    } catch (e) {
      setPhase({ t: 'failed', verb, refusal: refusalOf(e, verb, name) });
    } finally {
      firing.current = false;
    }
  }, [name, refresh]);

  const choose = (verb: Verb) => {
    const { selfAffecting, warning } = consequenceOf(name, verb);
    // The confirm step is not a habit, it is a consequence. A generic "are you
    // sure" on every verb trains the reader to click through the one that
    // matters; this only interrupts when the contract says this container is
    // something Bothy is served through, and then it says which and what breaks.
    if (selfAffecting && warning) setPhase({ t: 'confirm', verb, warning });
    else void run(verb);
  };

  // What the live region says, at every moment. Assembled here rather than
  // scattered through the branches so there is exactly one sentence at a time
  // and no chance of two.
  const announcement =
    phase.t === 'working' ? `${VERB_WORKING[phase.verb]} ${name}.`
    : phase.t === 'done' ? `${VERB_DONE[phase.verb]} ${name}. ${phase.res.from} to ${phase.res.to}, ${fmtTook(phase.res.tookMs)}.`
    : phase.t === 'failed' ? `${phase.refusal.title} ${phase.refusal.detail}`
    : '';

  return (
    <Dialog
      open
      // Escape and the close button both land here. Closing mid-flight does not
      // cancel anything - the daemon was already asked - so the poll is what
      // tells the reader how it ended, and the row is where they will see it.
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={<span className="sa-title">Act on <span className="mono">{name}</span></span>}
      description={
        phase.t === 'confirm'
          ? 'Read this before it happens.'
          : 'Three verbs, and no more. Anything else is a terminal.'
      }
      headerAside={<StatusIcon status={node.status} showLabel title={node.container?.statusText || node.status} />}
      footer={<Footer phase={phase} name={name} onCancel={() => setPhase({ t: 'choose' })} onRun={run} onClose={onClose} />}
    >
      <div className="sa-body">
        {/* Always present, never conditionally mounted: a live region that
            appears at the same moment as its text is not reliably announced,
            because the assistive tech has nothing to have been watching. */}
        <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

        {phase.t === 'choose' && (
          <>
            {!loading && !canAct && <NoRole signedIn={!!me} />}
            {verbs.length === 0 ? (
              <p className="sa-note">
                Nothing to act on. This route has no container behind it, so there is nothing for
                docker to restart, stop or start.
              </p>
            ) : (
              <ul className="sa-verbs">
                {verbs.map((v) => (
                  <VerbRow key={v} verb={v} container={name} enabled={canAct} onPick={() => choose(v)} />
                ))}
              </ul>
            )}
          </>
        )}

        {phase.t === 'confirm' && (
          <div className="sa-consequence">
            <p className="sa-note">{CONSEQUENCE_LEAD[phase.verb]}</p>
            <p className="sa-warn">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{phase.warning}</span>
            </p>
            <p className="sa-note">{VERB_MEANING[phase.verb]}</p>
          </div>
        )}

        {phase.t === 'working' && (
          <p className="sa-working" aria-hidden="true">
            <span className="sa-spin" />
            {VERB_WORKING[phase.verb]} {name}…
          </p>
        )}

        {phase.t === 'done' && (
          <div className="sa-outcome" data-ok="true">
            <p className="sa-outcome-h">{VERB_DONE[phase.verb]} {name}.</p>
            {/* The transition, in docker's words rather than the portal's five.
                `running -> running` after a restart is not a redundancy, it is
                the thing you wanted to be told: it came back. The status colours
                are legal here because this IS state - the buttons above are
                chrome and never take them. */}
            <p className="sa-transition">
              <span className="mono">{phase.res.from}</span>
              <span aria-hidden="true">-&gt;</span>
              <span className="sr-only">to</span>
              <span className="mono sa-to">{phase.res.to}</span>
              <span className="sa-took">{fmtTook(phase.res.tookMs)}</span>
            </p>
            <p className="sa-note">
              The table behind this has already been re-read. A service with a healthcheck reads
              &ldquo;Starting&rdquo; there until it passes one.
            </p>
          </div>
        )}

        {phase.t === 'failed' && (
          <div className="sa-outcome" data-ok="false">
            <p className="sa-outcome-h">{phase.refusal.title}</p>
            <p className="sa-note">{phase.refusal.detail}</p>
            {phase.refusal.needsRole && <RoleLinks signedIn={!!me} />}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function VerbRow({
  verb, container, enabled, onPick,
}: { verb: Verb; container: string; enabled: boolean; onPick: () => void }) {
  const Icon = VERB_ICON[verb];
  const { selfAffecting, warning } = consequenceOf(container, verb);

  return (
    <li>
      <button
        type="button"
        className="sa-verb"
        // aria-disabled rather than disabled, and deliberately: a `disabled`
        // button is not focusable, so a reader tabbing the dialog would never
        // reach the thing the sentence above it is about. Same choice, for the
        // same reason, as the menu rows in pages/files/Menu.tsx.
        aria-disabled={enabled ? undefined : true}
        onClick={() => { if (enabled) onPick(); }}
      >
        <Icon size={16} className="sa-verb-ico" aria-hidden="true" />
        <span className="sa-verb-text">
          <span className="sa-verb-name">
            {VERB_LABEL[verb]}
            {/* A mark, not a colour, and it carries its own word: the warning
                itself is one Enter away and repeating it under every verb would
                make the list unreadable. */}
            {selfAffecting && warning && (
              <span className="sa-flag">
                <AlertTriangle size={13} aria-hidden="true" />
                {CONSEQUENCE_FLAG[verb]}
              </span>
            )}
          </span>
          <span className="sa-verb-why">{VERB_MEANING[verb]}</span>
        </span>
      </button>
    </li>
  );
}

function NoRole({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="sa-norole">
      <p className="sa-norole-h">
        {signedIn ? 'These are read-only for you.' : 'Sign in to act on what is running.'}
      </p>
      <p className="sa-note">
        {signedIn
          ? 'Acting on what is running needs the operator role, and this session does not hold it. '
            + 'The edge would refuse the request before it reached anything.'
          : 'Nothing here knows who you are yet, so the edge would refuse these before they reached '
            + 'anything. Signing in returns you to this page.'}
      </p>
      <RoleLinks signedIn={signedIn} />
    </div>
  );
}

function RoleLinks({ signedIn }: { signedIn: boolean }) {
  return signedIn ? (
    <p className="sa-note">
      <Link className="link" to="/settings">Settings</Link> lists the four roles and what each one
      permits. They are granted in Keycloak, not here.
    </p>
  ) : (
    <a className="btn primary sa-signin" href={signInHref()}>
      <LogIn size={15} aria-hidden="true" />
      Sign in
    </a>
  );
}

function Footer({
  phase, name, onCancel, onRun, onClose,
}: {
  phase: Phase;
  name: string;
  onCancel: () => void;
  onRun: (v: Verb) => void;
  onClose: () => void;
}) {
  if (phase.t === 'confirm') {
    return (
      <>
        {/* The way out is named for what it preserves, not "Cancel" - the
            question was "shall I take the edge down", and the answer worth
            offering by name is the one that does not. */}
        <button type="button" className="btn ghost" onClick={onCancel}>Leave it alone</button>
        {/* The object and the verb, so the button reads as the sentence it
            performs even out of context. Not `primary`: the accent is chrome and
            filling the destructive answer with it would make it the invitation
            on the row. */}
        <button type="button" className="btn sa-go" onClick={() => onRun(phase.verb)}>
          {VERB_LABEL[phase.verb]} {name}
        </button>
      </>
    );
  }
  if (phase.t === 'working') {
    // No cancel. The daemon has been asked and there is nothing to withdraw, and
    // a button that says Cancel and cancels nothing is worse than no button.
    return <button type="button" className="btn ghost sa-busy" disabled>{VERB_WORKING[phase.verb]}…</button>;
  }
  if (phase.t === 'done' || phase.t === 'failed') {
    return (
      <>
        <button type="button" className="btn ghost" onClick={onCancel}>Back</button>
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </>
    );
  }
  return <button type="button" className="btn ghost" onClick={onClose}>Close</button>;
}

/** One duration format, and never more precision than the source has: the daemon
 *  reports whole milliseconds, and a restart is a second-scale event. */
function fmtTook(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
