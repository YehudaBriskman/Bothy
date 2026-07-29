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

export function Skeleton() {
  return (
    <div className="skel-wrap">
      <div className="skel" />
      <div className="skel" />
    </div>
  );
}
