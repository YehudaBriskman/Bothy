// Menu - Radix DropdownMenu, portal tokens. The shared menu primitive (design
// audit SYS-5), introduced 2026-09-21 for the Cluster row menu and meant to
// absorb the other hand-rolled popovers in a later batch.
//
// WHY A PRIMITIVE AND NOT A FIX IN PLACE. The Cluster "…" menu was a
// `position: absolute` list inside the table's own scroller, so the scroller
// clipped it: a 2px sliver under the last row, and one item of four at 390px.
// No z-index fixes that - `overflow` clips regardless of stacking. The list has
// to leave the scroller, which means a portal, which means positioning it
// against its trigger by hand and re-doing that on scroll, resize and when it
// would run off the viewport. That is Radix Popper's whole job, and Radix is
// already here through ui/Dialog. It also brings the menu keyboard model the
// old list declared (`role=menu`) and did not implement: focus moves into the
// menu, arrows and Home/End walk it, typeahead jumps, Escape and Tab close it
// and give focus back to the trigger.
//
// THE CHOSEN ITEM RUNS AFTER FOCUS IS BACK ON THE TRIGGER. An item that opens a
// dialog is the common case here, and ui/Dialog returns focus to whatever had
// it when the dialog opened. If the item ran on select, the dialog would open
// while focus was still on a menu row that is about to unmount - the dialog's
// opener would be a detached node, and the menu's own focus return would then
// fight the dialog's trap. So select only records the item, and it is run from
// the menu's close-autofocus, after Radix has put focus on the trigger.

import * as DM from '@radix-ui/react-dropdown-menu';
import { useRef, type ReactNode } from 'react';
import './Menu.css';

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

export interface MenuProps {
  /** The trigger, rendered as-is (Radix wires aria-haspopup/expanded onto it). */
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'center' | 'end';
}

export function Menu({ trigger, items, align = 'end' }: MenuProps) {
  const chosen = useRef<(() => void) | null>(null);
  return (
    <DM.Root>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content
          className="ui-menu"
          // Named by its trigger: Radix sets aria-labelledby to the trigger's id,
          // so the trigger's own label ("Actions for frontend") names the menu.
          align={align}
          sideOffset={6}
          // Keep 8px off every viewport edge, flip above when there is no room
          // below, and slide along the edge rather than overflow it.
          collisionPadding={8}
          onCloseAutoFocus={() => {
            const run = chosen.current;
            chosen.current = null;
            // Radix focuses the trigger right after this handler returns; the
            // item's effect renders on a later task, so it sees the trigger as
            // the focused element.
            if (run) setTimeout(run, 0);
          }}
        >
          {items.map((it) => (
            <DM.Item
              key={it.key}
              className="ui-menu-item"
              disabled={it.disabled}
              onSelect={() => { chosen.current = it.onSelect; }}
            >
              {it.icon}
              <span className="ui-menu-label">{it.label}</span>
            </DM.Item>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
