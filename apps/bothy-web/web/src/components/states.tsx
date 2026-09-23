import { useEffect, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';
import { Loader, type LoaderState } from './ui/Loader';
// The five shared states, in ONE place (design audit SYS-18): empty, error,
// loading, "this address is not a thing" and "your session does not hold the
// role". Before this file was finished, a page that needed one of them wrote
// its own markup, and the five copies disagreed about the things that matter:
// whether the heading was a heading, whether the document title changed,
// whether there was a way out, and - the one that was actually wrong - whether
// "we have not asked yet" is the same answer as "it does not exist".

// `onClear` is optional: "no services discovered" is not a filter problem, and
// offering to clear a filter that isn't set is a dead control.
export function EmptyState({
  message,
  hint,
  onClear,
}: {
  message: string;
  /** A node, not a string: a hint may carry a command, and Settings renders
   *  those as copyable spans rather than as text. */
  hint?: ReactNode;
  onClear?: () => void;
}) {
  return (
    <div className="state">
      <h4>{message}</h4>
      {hint && <p>{hint}</p>}
      {onClear && (
        <Button variant="ghost" onClick={onClear}>
          Clear filter
        </Button>
      )}
    </div>
  );
}

// `actions` is for the ways out that are NOT "try that again". The audit found
// Retry offered on a 404, where it is a button that repeats a failure: a file
// that is not there wants "Back to Start", not another read of the same path.
export function ErrState({
  title, body, onRetry, actions,
}: { title: string; body: string; onRetry?: () => void; actions?: ReactNode }) {
  return (
    <div className="state err">
      <h4>{title}</h4>
      <p>{body}</p>
      {(onRetry || actions) && (
        <div className="state-acts">
          {onRetry && (
            <Button variant="ghost" onClick={onRetry}>
              Retry
            </Button>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}

/** "The first poll has not answered yet", which is NOT "it does not exist".
 *
 *  Four pages wrote this test by hand, and two of them got it wrong the other
 *  way: a real service page said "Service not found" for the 3-4 s a cold load
 *  takes. The rule is the whole of it - no answer AND no failure means the
 *  question is still in flight, so show the search, not a 404. */
export function firstPoll(data: { at: number; fails: number }): boolean {
  return data.at === 0 && data.fails === 0;
}

/** An address that is not a thing.
 *
 *  Every 404 in this app is this component: an <h1> (the audit found the 404
 *  and the unknown settings section had no heading at all, so a screen reader
 *  landed on a page with no name), a document title that says so, the value
 *  that was asked for shown in mono so it can be read and compared, and at
 *  least one way out. Never a Retry - see ErrState. */
export function NotFound({
  title, what, value, hint, actions, docTitle,
}: {
  /** The heading, e.g. "Page not found". */
  title: string;
  /** What kind of thing was looked for, e.g. "There is no settings section at". */
  what: string;
  /** The address or name that was asked for. Shown in mono. */
  value: string;
  hint?: string;
  actions: ReactNode;
  /** The document title; defaults to the heading. */
  docTitle?: string;
}) {
  useDocTitle(`${docTitle ?? title} · Bothy`);
  return (
    <div className="state state-404">
      <h1>{title}</h1>
      <p>{what} <span className="mono">{value}</span>.</p>
      {hint && <p>{hint}</p>}
      <div className="state-acts">{actions}</div>
    </div>
  );
}

/** A refusal for want of a role.
 *
 *  Said the same way everywhere: a heading for the state the reader is in,
 *  then what cannot be done and which role would do it, then whatever the page
 *  wants to add - a sign-in button, links to the roles document. It is a note,
 *  not an alert: nothing has failed, and the page around it is usually still
 *  fully readable. */
export function NeedsRole({
  title = 'These are read-only for you.', what, role, detail, children,
}: {
  /** The heading. The default is the common case: signed in, role missing. */
  title?: string;
  /** What cannot be done, e.g. "Changing cluster workloads". */
  what: string;
  /** The role that would allow it, e.g. "operator". */
  role: string;
  /** One more sentence, where the page has something specific to say. */
  detail?: ReactNode;
  /** Actions - a sign-in button, links. */
  children?: ReactNode;
}) {
  return (
    <div className="sa-norole" role="note">
      <p className="sa-norole-h">
        <Icon icon={ShieldAlert} size="md" /> {title}
      </p>
      <p className="sa-note">
        {what} needs the <b className="mono">{role}</b> role.{detail ? <> {detail}</> : null}
      </p>
      {children}
    </div>
  );
}

/** Sets the document title while a component is mounted, and puts the previous
 *  one back on the way out - the same contract SettingsShell has used since it
 *  was written, so a 404 inside Settings cannot leave the tab named after a
 *  page nobody is on. */
export function useDocTitle(title: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => { document.title = prev; };
  }, [title]);
}

// Shape-matched skeletons.
//
// A skeleton's only job is to reserve the shape that is coming, so the page
// does not jump when data lands. Two identical 132px grey boxes did the
// opposite everywhere they were used: on the Overview they stood in for a hero
// and a wrapping row of chips, so the layout moved twice - once when the
// skeleton appeared and again when it was replaced by something a different
// height. `variant` costs a few lines and makes the placeholder honest.
export function Skeleton({
  variant = 'panels',
  state = 'load',
  label = 'Loading…',
  size = 'lg',
}: {
  variant?: 'panels' | 'overview' | 'table';
  /** What kind of waiting (ui/Loader): `search` for the discovery poll, `load` otherwise. */
  state?: LoaderState;
  /** What is being waited on - announced, and shown under the orb. */
  label?: string;
  /** lg for a page, md for a pane (a file, a diff). */
  size?: 'md' | 'lg';
}) {
  // The skeleton reserves the shape; the Loader is the one thing that says
  // "working" (and the only thing that moves - .skel-host stills the shimmer).
  // aria-busy marks the region, role=status (inside Loader) announces it.
  return (
    <div className="skel-host" aria-busy="true">
      <Shapes variant={variant} />
      <Loader state={state} size={size} label={label} className="skel-orb" />
    </div>
  );
}

function Shapes({ variant }: { variant: 'panels' | 'overview' | 'table' }) {
  if (variant === 'overview') {
    // Reserves the CURRENT shape of the page, which is the only thing a
    // skeleton is for: a 55px status line, three wrapping chip rows, then the
    // vitals charts. It used to reserve a 152px hero that no longer exists -
    // an out-of-date skeleton is worse than none, because it moves the layout
    // in the exact moment it was added to keep it still.
    return (
      <div className="skel-col" aria-hidden="true">
        <div className="skel" style={{ height: 55 }} />
        <div className="skel" style={{ height: 40 }} />
        <div className="skel" style={{ height: 40 }} />
        <div className="skel" style={{ height: 40 }} />
        <div className="skel" style={{ height: 172 }} />
      </div>
    );
  }
  if (variant === 'table') {
    return (
      <div className="skel-wrap" aria-hidden="true">
        <div className="skel" style={{ height: 34 }} />
        {Array.from({ length: 8 }, (_, i) => <div className="skel" key={i} style={{ height: 32 }} />)}
      </div>
    );
  }
  return (
    <div className="skel-wrap" aria-hidden="true">
      <div className="skel" />
      <div className="skel" />
    </div>
  );
}
