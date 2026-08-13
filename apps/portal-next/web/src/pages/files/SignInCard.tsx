// The ONE shape a 401 takes, wherever it lands - the tree, a file, or a save.
// Never an error state: a signed-out visitor has done nothing wrong, and this
// page's whole reason to exist is behind a door that a click opens.

import { LogIn } from 'lucide-react';
import { signInUrl } from '../../lib/files';

export function SignInCard({ what, onRetry }: { what: string; onRetry?: () => void }) {
  return (
    <div className="state fx-signin">
      <span className="fx-signin-ico"><LogIn size={22} aria-hidden="true" /></span>
      <h4>Sign in to {what}</h4>
      <p>
        BothyFiles reads the stack repo, the notes and <span className="mono">~/projects</span> -
        which hold real credentials - so it asks who you are first. Browsing needs
        the <b>viewer</b> role; saving needs <b>editor</b>.
      </p>
      <div className="fx-signin-actions">
        <a className="btn primary" href={signInUrl()}>Sign in</a>
        {onRetry && <button type="button" className="btn ghost" onClick={onRetry}>Retry</button>}
      </div>
    </div>
  );
}
