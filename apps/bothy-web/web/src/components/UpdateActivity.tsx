// What the box is doing right now - one store, two presentations.
//
// ── what the owner asked for, and what was wrong before ──────────────────────
//
//   "the live actions card is not in the right pannel like i wanted but just got
//    transfared from upper section above the controles to the side of them, i
//    want that in the side of the PAGE. compleate sepurations that we can actualy
//    see the live actions happening in all of the app pages. in the updates it
//    grows to all of the side as side pannel, and in all the other places itll be
//    flowting in the side as circle or something in some corner or something and
//    in hover itll get opened to see more of that."
//
// They were right. `.upd-top` was a two-column grid whose LEFT cell was the
// Controls block, so "the right column" meant "right of Controls" and not "right
// of the page" - and `.set-body` caps at 1080px with no auto margin, so on a wide
// screen there were ~570 unused pixels to the right of it, which is exactly where
// they were pointing. So:
//
//   UpdateActivityRail   on Settings > Updates: a rail down the side of the PAGE,
//                        spanning the whole scroller, separated by a hairline.
//   UpdateActivityDock   everywhere else: a fixed round indicator in the corner,
//                        mounted ONLY while a job is being followed, that opens to
//                        a card with the step, the reason and what to press.
//
// ── one store, and why it is not in here ─────────────────────────────────────
//
// Both read `jobFeed()` in lib/updates.ts through `useJobFeed` below, so there is
// exactly ONE 2s loop behind them however many of them are mounted. The dock is
// mounted beside <CommandPalette/> in AppShell, the only place in the app that
// survives a route change (RouteFade keeps two <main>s alive for ~120ms per
// navigation, so anything live inside a page is duplicated and then unmounted
// every time you move). The loop starts when a job starts and stops when the host
// says it is over; nothing polls on app load, because every read of the job route
// writes an audit line on the host.
//
// ── the five house rules this had to obey, all already written down ──────────
//
//  1. "Hover alone is not an affordance" (brand/patterns/feedback.md). The dock
//     opens on FOCUS, on a TAP and on hover - hover gated to `pointerType ===
//     'mouse'` on both pointer handlers, which is what keeps a touch tap reaching
//     the toggle instead of being eaten by a hover that opens and shuts in the
//     same gesture. That is the defect that disqualified components/Tooltip.tsx.
//  2. It expands by TRANSFORM, not by size (brand/foundations/motion.md: width
//     and height never animate; index.css:1144 records the nav label that tweened
//     max-width and reflowed the whole bar every frame). The panel is absolutely
//     positioned off the dock, so opening it moves nothing, and it arrives on
//     opacity + scale + translate.
//  3. A card with a Dismiss and a link in it is not a hint and not a tooltip. The
//     moment the detail contains something to press it is a DISCLOSURE, so the
//     trigger is a real named button with aria-expanded/aria-controls and Escape
//     puts focus back on it - not ui/InfoHint, whose panel focus may never enter.
//  4. "An idle orb is a perpetual loop for an idle thing" - so there is no dock
//     at all when nothing is running. `feed.id === null` is the whole condition.
//  5. "No toasts" is a written decision; this is the first thing in the product to
//     touch it, and it is amended in brand/reference/decisions.md rather than
//     quietly ignored. The short of it: a toast is a transient notification of
//     something that already happened, and this is a persistent handle on
//     something still happening - it never auto-dismisses, and it is the same
//     component as the page rail rather than a second error channel.
//
// It is a plain fixed element, NOT a Radix popper: checks/a11y-contract.mjs fails
// the build if anything outside components/ui/ imports a dialog or popper
// primitive, writes aria-modal, draws a popup role, or adds a document-level
// outside-press listener. There is none of that here - no scrim, no focus trap,
// no outside-press; it is a disclosure in the corner of the page.

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertTriangle, Check, CircleDashed, Minus, RotateCcw, X } from 'lucide-react';
import {
  type HistoryEntry, type Job, type JobState, type JobStep,
  dismissJob, isTerminal, jobFeed, onJobFeed, resumeJob,
} from '../lib/updates';
import { Actor, Prose, Ticks, When } from './settings/bits';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';
import { Loader } from './ui/Loader';
import './UpdateActivity.css';

/** The one subscription. `jobFeed()` returns the same object until something
 *  changes, which is what makes this safe to call from as many places as like. */
export function useJobFeed() {
  return useSyncExternalStore(onJobFeed, jobFeed, jobFeed);
}

export const STATE_WORD: Record<JobState, string> = {
  queued: 'Queued - waiting for the host',
  running: 'Running on the host',
  succeeded: 'Applied',
  rolled_back: 'Rolled back',
  aborted: 'Aborted - nothing running was changed',
  failed: 'Failed - a person is needed',
  refused: 'Refused - nothing was touched',
};

/** The same states in three words, for a row and for the corner. */
export const HIST_WORD: Record<JobState, string> = {
  queued: 'queued', running: 'running', succeeded: 'applied', rolled_back: 'rolled back', aborted: 'aborted',
  failed: 'failed', refused: 'refused',
};

// What a state means in the reserved palette: good, a warning, or down.
export const STATE_TONE: Record<JobState, 'up' | 'warn' | 'down' | 'busy'> = {
  queued: 'busy', running: 'busy', succeeded: 'up', rolled_back: 'warn', aborted: 'warn', refused: 'warn', failed: 'down',
};

export const STEP_WORD: Record<JobStep['name'], string> = {
  validate: 'Re-validate the request and the plan',
  preflight: 'Pre-flight',
  snapshot: 'Snapshot',
  pull: 'Pull the image',
  apply: 'Apply',
  verify: 'Verify (canaries)',
  rollback: 'Roll back',
  restore: 'Restore the data snapshot',
  record: 'Record',
  build: 'Build the new images (nothing running is touched)',
  arm: 'Arm the rollback timer',
  switch: 'Move the checkout (fast-forward)',
  stage: 'Stage the new updater (not switched)',
  // The Postgres major (step 8). `switch` there is compose moving to the new volume.
  stop: 'Stop the writers (Keycloak, oauth2-proxy, the exporter)',
  dump: 'pg_dumpall, rows counted from the dump',
  create: 'Create the new volume and a temporary Postgres on it',
  load: 'Restore the dump into it',
  compare: 'Compare every database and row count with the dump',
  start: 'Start Keycloak and oauth2-proxy again',
};

const secs = (a: string, b: string) => {
  const s = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));
  return s >= 90 ? `${Math.round(s / 60)} min` : `${s} s`;
};

function StepGlyph({ state }: { state: JobStep['state'] }) {
  if (state === 'running') return <Loader state="work" size="sm" label="running" labelHidden announce={false} className="upd-step-g" />;
  if (state === 'ok') return <Icon icon={Check} size="sm" className="upd-step-g" aria-label="done" />;
  if (state === 'failed') return <Icon icon={X} size="sm" className="upd-step-g" aria-label="failed" />;
  if (state === 'skipped') return <Icon icon={Minus} size="sm" className="upd-step-g" aria-label="skipped" />;
  return <Icon icon={CircleDashed} size="sm" className="upd-step-g" aria-label="pending" />;
}

export function JobGlyph({ state }: { state: JobState }) {
  if (state === 'succeeded') return <Icon icon={Check} size="md" />;
  if (state === 'failed') return <Icon icon={X} size="md" />;
  if (state === 'rolled_back') return <Icon icon={RotateCcw} size="md" />;
  return <Icon icon={AlertTriangle} size="md" />;
}

/** The step the host is on, and where it is in the list - the one line that
 *  answers "what is it doing" without the whole table. */
function running(job: Job | null): { step: JobStep; n: number; of: number } | null {
  if (!job) return null;
  const i = job.steps.findIndex((s) => s.state === 'running');
  if (i < 0) return null;
  return { step: job.steps[i], n: i + 1, of: job.steps.length };
}

// ── the rail: a column down the side of Settings > Updates ───────────────────

/** THE RAIL IS A COLUMN OF THE PAGE, not a cell of a row inside it (2026-10-08).
 *
 *  It is reserved whether or not a job exists and its card is absolutely
 *  positioned, which is what makes the no-shift guarantee structural rather than
 *  a guess: an absolutely positioned child contributes NO height, so no block on
 *  the page can be moved by a panel that grows as its steps arrive. At rest the
 *  slot is not empty - it carries the last job, which is the one fact somebody
 *  opening this page while nothing runs actually wants. */
export function UpdateActivityRail({ d, onFinished }: { d: ActivityStatus | null; onFinished: () => void }) {
  const feed = useJobFeed();
  return (
    <div className="upd-rail">
      {/* The scroller takes the app's shared edge cue (lib/scroll.ts drives every
          .scroll-shade) and a tab stop, because a live panel can be taller than
          the slot and a scroller nothing can focus is a scroller a keyboard
          cannot reach. */}
      <div className="upd-rail-in scroll-shade" tabIndex={0} role="region" aria-label="Update activity">
        {feed.id
          ? <JobCard onFinished={onFinished} />
          : <RestingJob last={d?.history?.[0] ?? null} />}
      </div>
    </div>
  );
}

/** Only what the rail reads off the status answer, so this component does not
 *  depend on the whole of `UpdatesStatus`. */
export interface ActivityStatus { history?: HistoryEntry[] }

/** The full card: every step, the reconnecting line, the error and the footer.
 *  The rail's presentation - the dock shows the current step instead, because a
 *  twenty-step table in a corner is a page in the wrong place. */
function JobCard({ onFinished }: { onFinished: () => void }) {
  const { id, job, lost, gone } = useJobFeed();
  const done = !!job && isTerminal(job.state);
  const finished = useRef(false);
  useEffect(() => {
    if (done && !finished.current) { finished.current = true; onFinished(); }
  }, [done, onFinished]);

  if (gone) {
    return (
      <section className="upd-job" data-tone="warn" aria-label="Update job">
        <p className="upd-job-h"><Icon icon={AlertTriangle} size="md" />The host has no job <span className="mono">{id?.slice(0, 12)}</span>.</p>
        <div className="ka-row"><Button variant="ghost" size="sm" onClick={dismissJob}>Dismiss</Button></div>
      </section>
    );
  }
  const tone = job ? STATE_TONE[job.state] : 'busy';
  return (
    <section className="upd-job" data-tone={tone} aria-label="Update job" aria-live="polite">
      <header className="upd-job-head">
        <p className="upd-job-h">
          {!job || !done ? <Loader state="work" size="sm" announce={false} /> : <JobGlyph state={job.state} />}
          <span>{job ? STATE_WORD[job.state] : 'Asking the host…'}</span>
          {job && <span className="mono upd-job-what">{job.component}{job.to ? ` → ${job.to.version ?? job.to.image}` : ''}</span>}
          {/* A group job: `component` is the recipe, so say which components it
              is moving - otherwise the panel names a `just` target and nothing
              about what is being replaced. */}
          {job && (job.members?.length ?? 0) > 0 && (
            <span className="set-cell-sub">{job.members!.join(', ')}</span>
          )}
        </p>
        {done && <Button variant="ghost" size="sm" onClick={dismissJob}>Dismiss</Button>}
      </header>
      {lost && !done && (
        <p className="set-note upd-lost" role="status">
          <Loader state="connect" size="sm" announce={false} /> Reconnecting - {lost.why}. The job runs on the host whatever this tab does;
          an update to Bothy itself or to Traefik interrupts this page on purpose.
        </p>
      )}
      {job && (
        <>
          <ol className="upd-steps">
            {job.steps.map((s) => (
              <li key={s.name} className="upd-step" data-state={s.state}>
                <StepGlyph state={s.state} />
                <span className="upd-step-name">{STEP_WORD[s.name]}</span>
                <span className="upd-step-when">{s.endedAt && s.startedAt ? secs(s.startedAt, s.endedAt) : s.state === 'running' ? 'now' : ''}</span>
                {s.detail && <span className="upd-step-detail"><Ticks text={s.detail} /></span>}
              </li>
            ))}
          </ol>
          {job.error && done && <p className="upd-job-err"><b>Why:</b> <Prose text={job.error} /></p>}
          {job.note && done && <p className="set-note"><Prose text={job.note} /></p>}
          <p className="set-cell-sub">
            job <span className="mono">{job.id.slice(0, 12)}</span> · asked by <Actor who={job.requestedBy} /> <When iso={job.requestedAt} />
            {job.snapshot && <> · snapshot <span className="mono upd-path">{job.snapshot}</span></>}
          </p>
        </>
      )}
    </section>
  );
}

/** THE SLOT AT REST. It exists so that the rail's box is the same size with and
 *  without a job - that is the whole no-shift guarantee - and it carries a fact
 *  rather than reserving blank space. Reserved emptiness is a worse answer than a
 *  reserved fact, and the last job is the one the History block below makes you
 *  scroll for. One line: what, how it ended, when, who asked. */
function RestingJob({ last }: { last: HistoryEntry | null }) {
  return (
    <section className="upd-job upd-job-rest" data-tone="rest" aria-label="Update activity">
      <p className="upd-job-h">
        <Icon icon={CircleDashed} size="md" />
        <span>Nothing is running</span>
      </p>
      {last ? (
        <p className="set-cell-sub upd-rest-last">
          Last: <b>{last.component}</b>{' '}
          <span className="upd-result" data-tone={STATE_TONE[last.state]}>
            <JobGlyph state={last.state} />{HIST_WORD[last.state]}
          </span>{' '}
          <When iso={last.endedAt ?? last.requestedAt} /> · asked by <Actor who={last.requestedBy} />
        </p>
      ) : (
        <p className="set-cell-sub">No update has run from here yet.</p>
      )}
    </section>
  );
}

// ── the dock: the same job, in the corner of every other page ────────────────

export function UpdateActivityDock() {
  const feed = useJobFeed();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const orb = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // PICK UP A JOB THAT OUTLIVED THE TAB. The update being watched may recreate
  // bothy-web underneath it, so a reload mid-deploy is a normal thing to happen
  // - and on any page but Settings > Updates there would otherwise be nothing on
  // screen at all until somebody opened that page. The shell is where this
  // belongs because the shell is what survives a route change; `resumeJob` makes
  // exactly one request, and none at all when no job id was stored.
  useEffect(() => { void resumeJob(); }, []);

  // Escape closes it AND hands focus back to the trigger, from wherever in the
  // card the reader had got to. On the wrapper rather than on the document: a
  // document-level listener here is what a11y-contract.mjs § 5 forbids, and it
  // would also swallow Escape for every other surface in the app.
  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open) return;
    e.stopPropagation();
    setOpen(false);
    orb.current?.focus();
  }, [open]);

  // Nothing is being followed: no dock at all. Not a grey orb, not a dot - the
  // brand forbids an idle loop for an idle thing, and it is what the owner asked
  // for ("nothing at all when idle").
  if (!feed.id) return null;
  // On Settings > Updates the rail IS this, at full height. Two of them would be
  // two live regions saying the same thing.
  if (loc.pathname.startsWith('/settings/updates')) return null;

  const { job, lost, gone } = feed;
  const tone = gone ? 'warn' : job ? STATE_TONE[job.state] : 'busy';
  const done = !!job && isTerminal(job.state);
  const at = running(job);
  const word = gone ? 'The host has no such job' : job ? STATE_WORD[job.state] : 'Asking the host…';

  return (
    <div
      className="upd-dock" ref={box} data-tone={tone} onKeyDown={onKeyDown}
      onPointerLeave={(e) => {
        // A mouse leaving closes it; a finger lifting does not, or a tap would
        // open and shut in one gesture. And never while the reader's focus is
        // still inside the card.
        if (e.pointerType !== 'mouse') return;
        if (box.current?.contains(document.activeElement)) return;
        setOpen(false);
      }}
    >
      {/* The one thing said out loud, and only when it CHANGES: the state word.
          The card itself is not a live region - at 2s a step table would talk
          over everything else on the page. */}
      <p className="sr-only" role="status">{word}{job ? ` - ${job.component}` : ''}</p>

      <button
        type="button" ref={orb} className="upd-dock-orb"
        aria-expanded={open} aria-controls={panelId} aria-label="Update activity"
        onClick={() => setOpen((o) => !o)}
        // KEYBOARD focus opens it; a pointer's does not, and the difference is
        // `:focus-visible`. Opening on every focus looked right and was the "tap
        // eaten by the hover" defect in a second costume: a tap focuses the
        // button and then clicks it, so focus opened the panel and the click's
        // toggle shut it again in the same gesture, and nothing happened at all
        // on a phone. The pointer has its own ways in - hover for a mouse, the
        // click for a finger - so this handler is only for the one that does not.
        onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) setOpen(true); }}
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') setOpen(true); }}
      >
        {done || gone ? <JobGlyph state={job && !gone ? job.state : 'aborted'} /> : <Loader state="work" size="sm" label="an update is running" labelHidden announce={false} />}
      </button>

      {/* Always in the DOM so aria-controls resolves while it is shut, `inert`
          while it is shut so nothing in it is reachable by Tab - the ui/Disclosure
          contract, hand-rolled here because this surface is fixed and owes no
          layout animation at all. */}
      <div id={panelId} className="upd-dock-panel" data-open={open} inert={!open}>
        <p className="upd-dock-h">
          <span className="upd-dock-word">{word}</span>
          {job && <span className="mono upd-dock-what">{job.component}{job.to ? ` → ${job.to.version ?? job.to.image}` : ''}</span>}
        </p>
        {at && (
          <p className="upd-dock-step">
            <span className="upd-dock-step-n">{at.n}/{at.of}</span>
            <span className="upd-dock-step-name">{STEP_WORD[at.step.name]}</span>
          </p>
        )}
        {at?.step.detail && <p className="upd-dock-detail"><Ticks text={at.step.detail} /></p>}
        {lost && !done && (
          <p className="upd-dock-lost">
            <Loader state="connect" size="sm" announce={false} /> Reconnecting - {lost.why}. The job runs on the host whatever this tab does.
          </p>
        )}
        {job?.error && done && <p className="upd-dock-err"><b>Why:</b> <Prose text={job.error} /></p>}
        <div className="upd-dock-acts">
          <Link className="link upd-dock-open" to="/settings/updates">Open Updates</Link>
          {(done || gone) && <Button variant="ghost" size="sm" onClick={dismissJob}>Dismiss</Button>}
          <Button
            variant="ghost" size="sm" iconOnly aria-label="Hide the details"
            onClick={() => { setOpen(false); orb.current?.focus(); }}
          >
            <Icon icon={X} size="sm" />
          </Button>
        </div>
      </div>
    </div>
  );
}
