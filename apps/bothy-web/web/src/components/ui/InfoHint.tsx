// InfoHint - the one "there is more to say about this" affordance (2026-10-07).
//
// WHY IT EXISTS, in the owner's words: "theres a lot of words and too much data,
// we need to add the global icon of additional data beside stuff with hover
// popups data". The point is NOT to put an icon beside the same words. The point
// is to TAKE THE WORDS OFF THE SURFACE and leave a 12px glyph where they were.
// A page that gains a hint and keeps its paragraph has been made busier, which is
// the opposite of the request. Every call site below therefore deletes prose.
//
// ── why this is not ui/Tooltip ───────────────────────────────────────────────
//
// components/Tooltip.tsx is right for what it does and wrong for this, and the
// three reasons are each disqualifying rather than aesthetic:
//
//   1. IT CANNOT BE OPENED BY TOUCH. Its anchor opens on pointerenter and closes
//      again on pointerdown ("a press is an intent to use the control, not to
//      read about it"), and on a touch screen a tap fires both - so on the
//      owner's phone the tooltip opens and shuts in the same gesture. A hint
//      whose whole job is to hold what the surface no longer says has to open on
//      a tap, and a tap has to close it again.
//   2. ITS SURFACE TAKES NO POINTER. `.ui-pop-tip` is `pointer-events: none`, so
//      the text in it cannot be selected and nothing in it can be hovered - fine
//      for a four-word label, useless for a sentence somebody wants to re-read
//      or copy a command out of.
//   3. IT IS NOT A CONTROL. The anchor is a <span> with no role and no name of
//      its own, so there is nothing for a screen reader to announce and nothing
//      for a keyboard to land on except whatever the tooltip happens to wrap.
//      A hint beside a table header wraps nothing.
//
// So this is built ON ui/Popover - the one anchored floating surface (SYS-5) -
// rather than beside it: the portal out of the table's `overflow`, the collision
// flipping, the outside-press and Escape dismissal and the motion are all the
// primitive's, already measured and already checked.
//
// ── the contract, and why each half of it is non-negotiable ──────────────────
//
//   a real control    a <button> with an aria-label. `checks/design-tokens.mjs`
//                     registers `ui-hint` as an icon trigger, and
//                     `checks/a11y-contract.mjs` §7 asserts every one of them
//                     carries a name - a bare glyph is "button" to a screen
//                     reader and nothing at all to the owner's phone.
//   opens on FOCUS    Tab reaches it and it opens. Hover alone is not an
//                     affordance: it does not exist for a keyboard, and it does
//                     not exist on a phone.
//   opens on a TAP    pointerenter is honoured for `pointerType === 'mouse'`
//                     only, precisely so that a touch tap reaches the click
//                     handler instead of being eaten by a hover that opened and
//                     closed in the same gesture (this is defect 1 above).
//   Escape closes it  Radix's DismissableLayer listens on the document, so this
//                     works with focus still on the trigger.
//   focus NEVER moves The panel is a description, not a destination: focus stays
//                     on the trigger and `aria-describedby` points at the open
//                     panel, so a screen reader reads the hint as the trigger's
//                     description. THE COROLLARY IS A RULE: a hint's content is
//                     text, never a control - a link or a button inside one is
//                     unreachable by keyboard. docs/brand/patterns/feedback.md
//                     states it; `checks/a11y-contract.mjs` §7 enforces it.
//
// The 120 ms grace on close is what lets the pointer travel from the glyph onto
// the panel without the panel vanishing under it. It is a timer, not an
// animation of a layout property.

import { Info } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Popover } from './Popover';
import { Icon } from './Icon';
import './InfoHint.css';

export interface InfoHintProps {
  /** The accessible name of the trigger AND of the panel. A phrase, not a
   *  sentence: "What Pinned means", "Why nothing can be applied together". */
  label: string;
  /** Text. Not a control - see the contract above. */
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  className?: string;
}

export function InfoHint({ label, children, side = 'top', align = 'center', className }: InfoHintProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const grace = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = () => { if (grace.current) { clearTimeout(grace.current); grace.current = null; } };
  const show = () => { cancel(); setOpen(true); };
  // Not an immediate close: the pointer has to be able to cross the gap between
  // the glyph and the panel, and a blur that lands inside the panel is not a
  // dismissal either.
  const hide = () => { cancel(); grace.current = setTimeout(() => setOpen(false), 120); };
  useEffect(() => cancel, []);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => { cancel(); setOpen(o); }}
      id={id}
      label={label}
      side={side}
      align={align}
      sideOffset={6}
      // The panel is a description: focus stays where the reader put it, and
      // nothing is handed back on close because nothing was taken.
      focusOnOpen={false}
      returnFocus={false}
      className={`ui-hint-pop${className ? ` ${className}` : ''}`}
      trigger={(
        <button
          type="button"
          className="ui-hint"
          aria-label={label}
          aria-describedby={open ? id : undefined}
          onFocus={show}
          onBlur={hide}
          onPointerEnter={(e) => { if (e.pointerType === 'mouse') show(); }}
          onPointerLeave={(e) => { if (e.pointerType === 'mouse') hide(); }}
        >
          <Icon icon={Info} size="xs" />
        </button>
      )}
    >
      {/* The pointer entering the panel keeps it open; leaving it closes it. */}
      <div className="ui-hint-body" onPointerEnter={show} onPointerLeave={hide}>{children}</div>
    </Popover>
  );
}
