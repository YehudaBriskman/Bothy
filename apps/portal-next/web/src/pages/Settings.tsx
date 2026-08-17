// Settings - who you are, and what that lets you do.
//
// STUB - the contract, not the implementation.
//
// READ-ONLY ON PURPOSE, for now. The genuinely per-user facts (identity, roles)
// come from the session and cannot be edited here; the genuinely per-browser
// ones (theme, pane widths) are already localStorage and already correct. What
// is missing is a store for preferences nobody has asked to keep yet, so this
// page shows rather than sets until one exists.
import { useMe } from '../components/UserMenu';

export function Settings() {
  const { me, loading } = useMe();
  return (
    <section className="page">
      <h1>Settings</h1>
      {loading ? <p>Checking your session…</p>
        : me ? <p>Signed in as {me.preferredUsername} ({me.email}).</p>
        : <p>You are not signed in.</p>}
    </section>
  );
}
