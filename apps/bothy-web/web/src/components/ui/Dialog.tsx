// Dialog - Radix primitive, portal tokens.
//
// This is the shadcn arrangement: Radix owns the behaviour (focus trap, focus
// return, Escape, scroll lock, `aria-modal` + labelling, inert background,
// portalling out of any `overflow: hidden` ancestor), and the styling is ours.
// Only the styling layer differs from upstream shadcn - they write Tailwind
// classes, we write one CSS file against the same tokens, because this app has
// no Tailwind and adding it to get a dialog would be a tail-wags-dog migration.
//
// Written by hand, the focus trap alone is the part that is always subtly wrong:
// Shift+Tab off the first element, focus escaping to the address bar and back
// into the inert page behind, and returning focus to the element that opened it
// after a re-render has replaced that element.

import * as RD from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import './Dialog.css';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Rendered under the title. Also the dialog's accessible description. */
  description?: ReactNode;
  /** Right-aligned in the header - a status chip, a count, an open-in-new link. */
  headerAside?: ReactNode;
  footer?: ReactNode;
  /** Wider variant for tables and log output. */
  size?: 'md' | 'lg';
  children: ReactNode;
}

export function Dialog({
  open, onOpenChange, title, description, headerAside, footer, size = 'md', children,
}: DialogProps) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="dlg-overlay" />
        <RD.Content className={`dlg dlg-${size}`}>
          <header className="dlg-head">
            <div className="dlg-head-text">
              <RD.Title className="dlg-title">{title}</RD.Title>
              {description ? (
                <RD.Description className="dlg-desc">{description}</RD.Description>
              ) : (
                // Radix warns when a dialog has no description; this says
                // "deliberately none" rather than leaving a console warning that
                // trains everyone to ignore console warnings.
                <RD.Description className="sr-only">Details</RD.Description>
              )}
            </div>
            {headerAside && <div className="dlg-head-aside">{headerAside}</div>}
            <RD.Close className="dlg-x" aria-label="Close">
              <X size={16} />
            </RD.Close>
          </header>

          {/* scroll-shade: long bodies get the same top/bottom inner shadows as
              every other scroller in the app, so a clipped dialog looks clipped. */}
          <div className="dlg-body scroll-shade">{children}</div>

          {footer && <footer className="dlg-foot">{footer}</footer>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

// DialogClose stays and DialogTrigger went, which looks arbitrary and is not.
// This Dialog is CONTROLLED-ONLY - it requires `open`/`onOpenChange` and owns
// RD.Root internally - so a Trigger placed in `children` would render INSIDE the
// already-open dialog. It could not work, which makes it a misleading re-export
// rather than an escape hatch. Close renders inside Root and does work; both
// consumers currently hand-roll it, so it is a refactor away from use.
export const DialogClose = RD.Close;
