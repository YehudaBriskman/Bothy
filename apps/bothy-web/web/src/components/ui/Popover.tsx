// Popover - Radix Popover, portal tokens. THE ONLY ANCHORED FLOATING SURFACE
// that is not a menu (design audit SYS-5, batch 3, 2026-09-22).
//
// Nine surfaces floated over the page before this, each hand-rolled: 4 offsets,
// 3 radii, 2 shadows, surfaces 1, 2 and 4, z-index 20 to 80, and not one of them
// animated out of its trigger or animated out at all. The Cluster row menu was
// clipped by its own table because an absolutely positioned child cannot leave
// an `overflow` ancestor. The two primitives fix all of it once:
//
//   ui/Menu      a list of commands (role=menu, arrows, typeahead)
//   ui/Popover   everything else anchored to a control: a panel with fields in
//                it (the Files scope picker), a listbox under a combobox (the
//                Settings search), a tooltip.
//
// Radix brings the parts that are easy to get almost right: a portal out of any
// clipping ancestor, collision flipping and shifting (8px off every viewport
// edge), Escape and outside-press dismissal, and focus going back to the
// trigger. What is ours is the ONE CSS contract in Popover.css (surface-4, the
// strong hairline, --r-lg, --shadow-3, 6px off the trigger, one z-index token)
// and the motion: the surface grows out of the trigger - transform-origin is
// the point on the trigger Radix computed (R7.2) - on the critically damped
// spring, and leaves along the same path (R7.1). The motion is a CSS
// TRANSITION rather than keyframes on purpose - see Popover.css.
//
// checks/a11y-contract.mjs fails if anything outside components/ui/ imports a
// Radix popper primitive, or draws its own `role="menu"`, `role="listbox"`
// popup, `role="tooltip"` or non-modal `role="dialog"`.

import * as RP from '@radix-ui/react-popover';
import { useRef, type ReactElement, type ReactNode, type RefObject } from 'react';
import './Popover.css';

export interface PopoverProps {
  /** The control that opens it, rendered as-is. Radix wires aria-expanded,
   *  aria-controls and aria-haspopup=dialog onto it and toggles on click. */
  trigger?: ReactElement;
  /** OR an element it is positioned against without being opened by it - the
   *  input of a combobox, the control a tooltip describes. The caller then owns
   *  `open`. */
  anchor?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  /** Distance from the trigger. 6px is the contract; a tooltip may ask for less. */
  sideOffset?: number;
  /** The popup's role. `dialog` (Radix's default) for a panel with controls in
   *  it, `listbox` for a combobox popup, `tooltip` for a tooltip. */
  role?: 'dialog' | 'listbox' | 'tooltip';
  /** The accessible name, for a `dialog` popover. */
  label?: string;
  id?: string;
  className?: string;
  /** Move focus into the popover when it opens (the first focusable inside, or
   *  whatever the caller focuses itself). False leaves focus where it is: a
   *  combobox's input, a control a tooltip is describing. */
  focusOnOpen?: boolean;
  /** Where focus goes on open, instead of the first focusable. A text field
   *  there is also selected, so typing replaces it. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Put focus back on the trigger when it closes. False for a tooltip and a
   *  combobox, where focus never left the anchor in the first place. */
  returnFocus?: boolean;
  /** Match the anchor's width (a combobox list under its input). */
  matchWidth?: boolean;
  children: ReactNode;
}

export function Popover({
  trigger, anchor, open, onOpenChange, side = 'bottom', align = 'center', sideOffset = 6,
  role = 'dialog', label, id, className, focusOnOpen = true, initialFocus, returnFocus = true, matchWidth = false,
  children,
}: PopoverProps) {
  const passive = role === 'tooltip';
  const anchorEl = useRef<HTMLDivElement | null>(null);
  return (
    <RP.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RP.Trigger asChild>{trigger}</RP.Trigger>}
      {anchor && <RP.Anchor asChild ref={anchorEl}>{anchor}</RP.Anchor>}
      <RP.Portal>
        <RP.Content
          className={`ui-pop overlay-motion${passive ? ' ui-pop-tip' : ''}${matchWidth ? ' ui-pop-match' : ''}${className ? ` ${className}` : ''}`}
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          role={role}
          id={id}
          aria-label={label}
          onOpenAutoFocus={(e) => {
            if (!focusOnOpen) { e.preventDefault(); return; }
            const el = initialFocus?.current;
            if (!el) return; // Radix: the first focusable inside
            e.preventDefault();
            el.focus();
            if (el instanceof HTMLInputElement) el.select();
          }}
          onCloseAutoFocus={returnFocus ? undefined : (e) => e.preventDefault()}
          // A combobox's popup must not close because focus went back to its own
          // input, and a press on the anchor is the anchor's business (it
          // toggles), not an outside press.
          onFocusOutside={anchor ? (e) => e.preventDefault() : undefined}
          onPointerDownOutside={anchor ? (e) => {
            if (e.target instanceof Node && anchorEl.current?.contains(e.target)) e.preventDefault();
          } : undefined}
        >
          {children}
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}
