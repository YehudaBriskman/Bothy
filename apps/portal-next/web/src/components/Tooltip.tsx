// Tooltip — replaces bare `title=` attributes.
//
// `title` was doing real work in this app (the freshness pill's full text, the
// theme toggle's current mode) but it is invisible to keyboard users, cannot be
// styled, and takes ~1s to appear. This shows on hover AND focus, immediately.
//
// Deliberately small: no portal, no positioning library, no arrow collision
// logic. Everything it is used for sits in the topbar, so `align="end"` for the
// right-hand controls is the entire edge-case budget. If a tooltip is ever
// needed inside a scroll container or near a viewport edge, that is the moment
// to reach for a real positioner — not before.

import { useId, useState, type ReactNode } from 'react';

export function Tooltip({
  label,
  children,
  align = 'center',
}: {
  label: string;
  children: ReactNode;
  align?: 'center' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span
      className="tip-wrap"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
      // Escape closes it without moving focus — a tooltip pinned open by focus
      // otherwise covers whatever is below it until the user tabs away.
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
    >
      {/* aria-describedby, not aria-label: the tooltip supplements the control's
          own accessible name rather than replacing it. */}
      <span aria-describedby={open ? id : undefined} style={{ display: 'inline-flex' }}>
        {children}
      </span>
      {open && (
        <span className="tip" role="tooltip" id={id} data-align={align === 'end' ? 'end' : undefined}>
          {label}
        </span>
      )}
    </span>
  );
}
