// ── the overflow menu ────────────────────────────────────────────────────────
//
// A thin adapter onto components/ui/Menu since batch 3 (design audit SYS-5 and
// FL-21, 2026-09-22). This file used to be a whole menu, written here "because
// there is no menu in this codebase to reuse" - which stopped being true when
// ui/Menu arrived, and then there were four menus with four keyboard models.
// What this keeps is its own item shape, because the chord is read from keys.ts
// (never a retyped string) and the Editor builds its list in these terms.
//
// Two behaviours are worth knowing, both now the primitive's:
//   · DISABLED ITEMS STAY, and a disabled row with a `note` stays in the arrow
//     order so the sentence explaining "why not" can be reached and read.
//   · Tab CLOSES the menu (the APG pattern) instead of being trapped in it,
//     which is what FL-21 asked for. The menu is portalled, so `.fx-centre`
//     clipping its overflow no longer caps its height either.
//
// AND STILL NO HOVER-REVEAL: the menu is rendered or it is not, and a control
// that exists only on :hover does not exist for a keyboard.

import { MoreHorizontal } from 'lucide-react';
import { Menu } from '../../components/ui/Menu';
import { Icon } from '../../components/ui/Icon';

export interface MenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** The chord, from `chordOf()` in keys.ts. Never a retyped string: the table
   *  is the single source for what a key does. */
  chord?: readonly string[];
  disabled?: boolean;
  /** Said out loud beside a disabled row. */
  note?: string;
  /** A separator is drawn ABOVE this item. */
  group?: boolean;
  onPick: () => void;
}

export function OverflowMenu({ items, label = 'More actions', align = 'end' }: {
  items: MenuItem[];
  label?: string;
  align?: 'start' | 'end';
}) {
  return (
    <Menu
      align={align}
      className="fx-menu-pop"
      trigger={(
        <button type="button" className="fx-hbtn" aria-label={label} title={label}>
          <Icon icon={MoreHorizontal} size="sm" />
        </button>
      )}
      items={items.map((it) => ({
        key: it.id,
        label: it.label,
        icon: it.icon,
        disabled: it.disabled,
        note: it.note,
        separatorAbove: it.group,
        onSelect: it.onPick,
        trailing: it.chord
          ? <span aria-hidden="true">{it.chord.map((k) => <span className="kbd" key={k}>{k}</span>)}</span>
          : undefined,
      }))}
    />
  );
}
