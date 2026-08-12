// Shared empty / error states.

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
        <button type="button" className="btn ghost" onClick={onClear}>
          Clear filter
        </button>
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
        <button type="button" className="btn ghost" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

// Shape-matched skeletons.
//
// A skeleton's only job is to reserve the shape that is coming, so the page
// does not jump when data lands. Two identical 132px grey boxes did the
// opposite everywhere they were used: on the Overview they stood in for a hero
// and a wrapping row of chips, so the layout moved twice — once when the
// skeleton appeared and again when it was replaced by something a different
// height. `variant` costs a few lines and makes the placeholder honest.
export function Skeleton({ variant = 'panels' }: { variant?: 'panels' | 'overview' | 'table' }) {
  if (variant === 'overview') {
    // Reserves the CURRENT shape of the page, which is the only thing a
    // skeleton is for: a 55px status line, three wrapping chip rows, then the
    // vitals charts. It used to reserve a 152px hero that no longer exists —
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
