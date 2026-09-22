// Tooltip - replaces bare `title=` attributes.
//
// `title` was doing real work in this app (the freshness pill's full text, the
// Files rail buttons) but it is invisible to keyboard users, cannot be styled,
// and takes ~1s to appear. This shows on hover AND focus, immediately.
//
// ON ui/Popover SINCE BATCH 3 (design audit SYS-5, 2026-09-22). It used to be a
// span drawn inside its own wrapper, "no portal, no positioning library, no
// collision logic", with `align` as the whole edge-case budget - and the budget
// ran out: Files needed three rules to stop a tip inside a 24px rail button
// wrapping into a nine-line ribbon, because a tooltip's containing block was
// the button it hung from. Portalled and positioned by the primitive, it sizes
// to its text, flips at a viewport edge, and grows out of its control like
// every other floating surface. `align` survives as the preferred alignment.
//
// Focus never moves: the tooltip neither takes it on open nor gives it back.

import { useId, useState, type ReactNode } from 'react';
import { Popover } from './ui/Popover';

export function Tooltip({
  label,
  children,
  align = 'center',
}: {
  label: string;
  children: ReactNode;
  /** The preferred alignment against the control; the primitive still flips
   *  and shifts it to stay 8px inside the viewport. */
  align?: 'center' | 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      role="tooltip"
      id={id}
      align={align}
      sideOffset={8}
      focusOnOpen={false}
      returnFocus={false}
      anchor={(
        <span
          className="tip-wrap"
          onPointerEnter={() => setOpen(true)}
          onPointerLeave={() => setOpen(false)}
          onFocusCapture={() => setOpen(true)}
          onBlurCapture={() => setOpen(false)}
          // A press is an intent to use the control, not to read about it.
          onPointerDown={() => setOpen(false)}
          // aria-describedby, not aria-label: the tooltip supplements the
          // control's own accessible name rather than replacing it.
          aria-describedby={open ? id : undefined}
        >
          {children}
        </span>
      )}
    >
      {label}
    </Popover>
  );
}
