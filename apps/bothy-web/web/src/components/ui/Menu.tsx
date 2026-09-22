// Menu - Radix DropdownMenu, portal tokens. THE ONLY MENU IN THE APP (design
// audit SYS-5). Introduced 2026-09-21 for the Cluster row menu; since batch 3
// (2026-09-22) it also carries the topbar theme and account menus and the Files
// overflow menu, which is why an item can be a radio, a link, carry a second
// line, a trailing mark or a key chord.
//
// WHY A PRIMITIVE AND NOT A FIX IN PLACE. The Cluster "…" menu was a
// `position: absolute` list inside the table's own scroller, so the scroller
// clipped it: a 2px sliver under the last row, and one item of four at 390px.
// No z-index fixes that - `overflow` clips regardless of stacking. The list has
// to leave the scroller, which means a portal, which means positioning it
// against its trigger by hand and re-doing that on scroll, resize and when it
// would run off the viewport. That is Radix Popper's whole job. It also brings
// the menu keyboard model three hand-rolled menus had each re-implemented
// slightly differently: focus moves into the menu, arrows and Home/End walk it,
// typeahead jumps, Escape closes it and gives focus back to the trigger. Tab
// closes it too - that one is ours: the old menus TRAPPED Tab, and so does
// Radix by default (audit FL-21).
//
// THE CHOSEN ITEM RUNS AFTER FOCUS IS BACK ON THE TRIGGER. An item that opens a
// dialog is the common case here, and ui/Dialog returns focus to whatever had
// it when the dialog opened. If the item ran on select, the dialog would open
// while focus was still on a menu row that is about to unmount - the dialog's
// opener would be a detached node, and the menu's own focus return would then
// fight the dialog's trap. So select only records the item, and it is run from
// the menu's close-autofocus, after Radix has put focus on the trigger. A LINK
// item is the exception: it is a real <a>, and the browser follows it.
//
// A DISABLED ITEM WITH A NOTE STAYS REACHABLE. Radix skips disabled rows in the
// arrow order, which is right for a row that says nothing - and wrong for one
// whose whole value is the sentence explaining why not (the Files menu: "Save -
// nothing to save"). Those rows are aria-disabled instead, stay in the order,
// and refuse the activation.
//
// Surface and motion: Popover.css - one contract for everything that floats.

import * as DM from '@radix-ui/react-dropdown-menu';
import { Fragment, useRef, useState, type ReactNode } from 'react';
import './Popover.css';
import './Menu.css';

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  /** A second, quieter line under the label. */
  sub?: ReactNode;
  /** At the row's end: a swatch, a count, a key chord. */
  trailing?: ReactNode;
  /** Run after the menu closes and focus is back on the trigger. */
  onSelect?: () => void;
  /** A link item: rendered as a real <a>, so middle-click and the status bar work. */
  href?: string;
  disabled?: boolean;
  /** Said beside a disabled row; keeps the row reachable (see the header). */
  note?: string;
  /** Draw a separator above this item. */
  separatorAbove?: boolean;
}

export interface MenuProps {
  /** The trigger, rendered as-is (Radix wires aria-haspopup/expanded onto it). */
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'center' | 'end';
  /** When set, the items are a single-choice group (menuitemradio) and this is
   *  the chosen key - the theme menu. */
  selected?: string;
  /** A non-interactive block above the items (who you are signed in as). */
  header?: ReactNode;
  /** A quiet line under the items. */
  footer?: ReactNode;
  /** The menu's name when the trigger's own label is not the right one. */
  label?: string;
  className?: string;
  /** Told when the menu opens or closes (it stays uncontrolled). */
  onOpenChange?: (open: boolean) => void;
}

function Row({ it }: { it: MenuItem }) {
  return (
    <>
      {it.icon && <span className="ui-menu-ico" aria-hidden="true">{it.icon}</span>}
      <span className="ui-menu-label">
        {it.label}
        {it.sub && <span className="ui-menu-sub">{it.sub}</span>}
        {it.disabled && it.note && <span className="ui-menu-sub">{it.note}</span>}
      </span>
      {it.trailing && <span className="ui-menu-trail">{it.trailing}</span>}
    </>
  );
}

export function Menu({
  trigger, items, align = 'end', selected, header, footer, label, className, onOpenChange,
}: MenuProps) {
  const chosen = useRef<(() => void) | null>(null);
  const radio = selected !== undefined;
  const [open, setOpenState] = useState(false);
  const setOpen = (o: boolean) => { setOpenState(o); onOpenChange?.(o); };

  const itemProps = (it: MenuItem) => {
    const soft = !!(it.disabled && it.note); // reachable but refuses
    return {
      className: 'ui-menu-item',
      disabled: it.disabled && !soft,
      'aria-disabled': soft || undefined,
      'data-soft-disabled': soft || undefined,
      onSelect: (e: Event) => {
        if (soft) { e.preventDefault(); return; }
        if (!it.href) chosen.current = it.onSelect ?? null;
      },
    };
  };

  const render = (it: MenuItem) => (
    <Fragment key={it.key}>
      {it.separatorAbove && <DM.Separator className="ui-menu-sep" />}
      {radio ? (
        <DM.RadioItem value={it.key} {...itemProps(it)}>
          <span className="ui-menu-mark" aria-hidden="true">
            <DM.ItemIndicator><Tick /></DM.ItemIndicator>
          </span>
          <Row it={it} />
        </DM.RadioItem>
      ) : it.href ? (
        <DM.Item asChild {...itemProps(it)}>
          <a href={it.href}><Row it={it} /></a>
        </DM.Item>
      ) : (
        <DM.Item {...itemProps(it)}><Row it={it} /></DM.Item>
      )}
    </Fragment>
  );

  return (
    <DM.Root open={open} onOpenChange={setOpen}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content
          className={`ui-menu overlay-motion${className ? ` ${className}` : ''}`}
          // Named by its trigger unless told otherwise: Radix sets
          // aria-labelledby to the trigger's id.
          aria-label={label}
          align={align}
          sideOffset={6}
          // Keep 8px off every viewport edge, flip above when there is no room
          // below, and slide along the edge rather than overflow it.
          collisionPadding={8}
          // Tab CLOSES the menu (APG menu pattern; audit FL-21) and focus goes
          // back to the trigger, one Tab from where it was. Radix's default
          // swallows Tab and leaves the menu open, which is the trap the three
          // hand-rolled menus had.
          onKeyDown={(e) => { if (e.key === 'Tab') { e.preventDefault(); setOpen(false); } }}
          onCloseAutoFocus={() => {
            const run = chosen.current;
            chosen.current = null;
            // Radix focuses the trigger right after this handler returns; the
            // item's effect renders on a later task, so it sees the trigger as
            // the focused element.
            if (run) setTimeout(run, 0);
          }}
        >
          {header && <div className="ui-menu-head">{header}</div>}
          {radio ? (
            <DM.RadioGroup value={selected}>{items.map(render)}</DM.RadioGroup>
          ) : items.map(render)}
          {footer && (
            <>
              <DM.Separator className="ui-menu-sep" />
              <div className="ui-menu-foot">{footer}</div>
            </>
          )}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

/** The radio tick, drawn inline so the primitive does not pick an icon set. */
function Tick() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
