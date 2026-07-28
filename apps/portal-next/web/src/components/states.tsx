// Shared empty / error states.

export function EmptyState({ message, onClear }: { message: string; onClear: () => void }) {
  return (
    <div className="state">
      <h4>{message}</h4>
      <button type="button" className="btn ghost" onClick={onClear}>
        Clear filter
      </button>
    </div>
  );
}

export function ErrState({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }) {
  return (
    <div className="state err">
      <h4>{title}</h4>
      <p>{body}</p>
      <button type="button" className="btn ghost" onClick={onRetry}>
        Retry
      </button>
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
