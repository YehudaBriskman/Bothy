// The ONE shape a 401 takes, wherever it lands - the tree, a file, or a save.
// Never an error state: a signed-out visitor has done nothing wrong, and this
// page's whole reason to exist is behind a door that a click opens.

import { LogIn } from 'lucide-react';
import { signInUrl } from '../../lib/files';
import { Button, buttonClass } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';

export function SignInCard({ what, onRetry }: { what: string; onRetry?: () => void }) {
  return (
    <div className="state fx-signin">
      <span className="fx-signin-ico"><Icon icon={LogIn} size="xl" /></span>
      <h4>Sign in to {what}</h4>
      <p>
        BothyFiles reads the stack repo, the notes and <span className="mono">~/projects</span> -
        which hold real credentials - so it asks who you are first. Browsing needs
        the <b>viewer</b> role; saving needs <b>editor</b>.
      </p>
      <div className="fx-signin-actions">
        <a className={buttonClass({ variant: 'primary' })} href={signInUrl()}>Sign in</a>
        {onRetry && <Button variant="ghost" onClick={onRetry}>Retry</Button>}
      </div>
    </div>
  );
}
