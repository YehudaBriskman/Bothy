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
//
// EVERY HEIGHT BELOW WAS MEASURED on the live page at 1440x900 (2026-09-23),
// not estimated. An invented height is the same defect as an out-of-date one.
// Where a block's height is genuinely data-dependent - the Control landing's
// Quick links grows with the number of published UIs - the comment says so
// rather than a number pretending to be exact.
//
// 2026-09-23: four pages stood under a skeleton shaped like a different page.
// The Control landing wore `overview` (a status line and chip rows, for a page
// that is a health strip over a card grid); the service and system detail pages
// wore `panels` (two generic 132px boxes); and the three file readers wore
// `table` - a header row over eight even rows, for a column of ragged prose.
export function Skeleton({
  variant = 'panels',
  state = 'load',
  label = 'Loading…',
  size = 'lg',
}: {
  variant?: SkelVariant;
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
  //
  // `plate` because this Loader is OVER the shapes. Without it the orb printed
  // straight onto a grey bar and the label crossed the next one down; the clear
  // area the plate carves is the whole reason it exists (ui/Loader.tsx).
  return (
    <div className="skel-host" aria-busy="true">
      <Shapes variant={variant} />
      <Loader state={state} size={size} label={label} plate className="skel-orb" />
    </div>
  );
}

export type SkelVariant = 'panels' | 'overview' | 'table' | 'control' | 'detail' | 'reader';

/** `--skel-min` for a .skel-row: the cell width below which the row wraps, set
 *  to whatever the real row uses so the skeleton collapses where the page does. */
const rowMin = (v: string) => ({ ['--skel-min' as string]: v }) as React.CSSProperties;
const bars = (n: number, h: number) =>
  Array.from({ length: n }, (_, i) => <div className="skel" key={i} style={{ height: h }} />);

function Shapes({ variant }: { variant: SkelVariant }) {
  if (variant === 'overview') {
    // The five blocks of .ov-body under the quick-links strip, which renders
    // ABOVE the skeleton and so is not reserved here. Measured at 1440:
    // .ov-status 56, .qv 100, .ov-attn 91, .sm 182, .vit 244.
    //
    // It used to reserve a 152px hero that no longer exists, and then
    // 55/40/40/40/172 for blocks that are 56/100/91/182/244 - an out-of-date
    // skeleton is worse than none, because it moves the layout in the exact
    // moment it was added to keep it still. The trailing .ov-dash (316 at 1440)
    // is left out on purpose: it is the last block, below the fold, and one a
    // reader can switch off in Settings.
    return (
      <div className="skel-col" aria-hidden="true">
        <div className="skel" style={{ height: 56 }} />
        <div className="skel" style={{ height: 100 }} />
        <div className="skel" style={{ height: 92 }} />
        <div className="skel" style={{ height: 184 }} />
        <div className="skel" style={{ height: 244 }} />
      </div>
    );
  }
  if (variant === 'control') {
    // The Control landing (pages/control/ControlHome.tsx), which stood under the
    // `overview` skeleton until 2026-09-23 and so reserved a status line and
    // three chip rows for a page that has neither.
    //
    // Measured: six .ch-tile at 109 each - at 390 too, where the tile keeps its
    // height and the strip rewraps to 2x3, which --skel-min 160px reproduces
    // because 160px is the floor .ch-strip itself uses. Then the .ch-grid: row
    // one is Needs attention beside Quick links, row two the three glance cards
    // (Cluster 255, Edge 277, Activity 479).
    //
    // Attention measured 263 and Quick links 606 on this box. Quick links is one
    // row per published UI, so its height is a property of the BOX and not of
    // the page; both cells take attention's height rather than a number that is
    // exact here and wrong everywhere else. .ch-groups (921) is left out for the
    // same reason, only more so - it grows with the number of systems, and a
    // fixed guess there is wrong by hundreds of pixels either way.
    return (
      <div className="skel-col" aria-hidden="true">
        <div className="skel-row" style={rowMin('160px')}>{bars(6, 109)}</div>
        <div className="skel-row" style={rowMin('22rem')}>{bars(2, 264)}</div>
        <div className="skel-row" style={rowMin('17rem')}>{bars(3, 260)}</div>
      </div>
    );
  }
  if (variant === 'detail') {
    // A service or system page (ServiceDetail, ProjectDetail), which both stood
    // under `panels` - two generic 132px boxes - for a page that opens with a
    // breadcrumb and a header.
    //
    // Measured at 1440 on a real service: .crumbs 19, .detail-head 67, then the
    // .dgrid - a span-12 Reachability panel at 231 and a span-6 pair at 246. The
    // Logs panel between them (499) is left out because it exists only for a
    // node with somewhere to read logs from, and reserving a panel half these
    // pages do not have moves the layout on the other half.
    return (
      <div className="skel-col" aria-hidden="true">
        <div className="skel skel-line" style={{ height: 20, maxWidth: 280 }} />
        <div className="skel" style={{ height: 68 }} />
        <div className="skel" style={{ height: 232 }} />
        <div className="skel-row" style={rowMin('22rem')}>{bars(2, 248)}</div>
      </div>
    );
  }
  if (variant === 'reader') {
    // A text reader: the file view, the diff and the editor's document pane. All
    // three stood under `table` - a header row over eight even rows - for
    // something that has neither a header nor an even row in it. What arrives is
    // a heading and then ragged lines, so that is what is reserved. The widths
    // are a plausible right edge; a 0 is the gap between paragraphs.
    const LINES = [92, 98, 84, 96, 71, 0, 100, 88, 94, 62, 0, 90, 97, 78, 55];
    return (
      <div className="skel-read" aria-hidden="true">
        <div className="skel skel-line" style={{ height: 28, maxWidth: 320 }} />
        {LINES.map((w, i) => (w
          ? <div className="skel skel-line" key={i} style={{ height: 14, width: `${w}%` }} />
          : <div className="skel-gap" key={i} />))}
      </div>
    );
  }
  if (variant === 'table') {
    return (
      <div className="skel-wrap" aria-hidden="true">
        <div className="skel" style={{ height: 34 }} />
        {bars(8, 32)}
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
