import { Button } from './ui/Button';
import { Loader, type LoaderState } from './ui/Loader';
// Shared empty / error / loading states.

// `onClear` is optional: "no services discovered" is not a filter problem, and
// offering to clear a filter that isn't set is a dead control.
export function EmptyState({
  message,
  hint,
  onClear,
}: {
  message: string;
  hint?: string;
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

export function ErrState({ title, body, onRetry }: { title: string; body: string; onRetry?: () => void }) {
  return (
    <div className="state err">
      <h4>{title}</h4>
      <p>{body}</p>
      {onRetry && (
        <Button variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
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
