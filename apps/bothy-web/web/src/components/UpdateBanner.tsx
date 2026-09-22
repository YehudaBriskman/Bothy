// "Bothy updated - reload". Mounted once, in the shell: when the revision being
// served is no longer the one this tab loaded (lib/version.ts), say so and offer
// the reload. Not an error and not a status - the accent, a glyph and words.
//
// "Later" hides it for THIS change only: a second update while the tab is still
// open brings it back, because that is new information.

import { useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { useServedRevision } from '../lib/version';
import './UpdateBanner.css';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';

export function UpdateBanner() {
  const { loaded, now } = useServedRevision();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!loaded || !now || now === loaded || dismissed === now) return null;
  const short = (s: string) => (s === 'unknown' ? 'an unlabelled build' : s.slice(0, 7));
  return (
    <div className="upd-banner" role="status" aria-live="polite">
      <Icon icon={RefreshCw} size="md" className="upd-banner-ico" />
      <p className="upd-banner-text">
        <b>Bothy updated.</b>{' '}
        <span>This tab is running <span className="mono">{short(loaded)}</span>; the box now serves{' '}
          <span className="mono">{short(now)}</span>. Reload to use it.</span>
      </p>
      <div className="upd-banner-actions">
        <Button size="sm" onClick={() => location.reload()}>Reload</Button>
        <Button variant="ghost" size="sm" iconOnly aria-label="Later" title="Later" onClick={() => setDismissed(now)}>
          <Icon icon={X} size="sm" />
        </Button>
      </div>
    </div>
  );
}
