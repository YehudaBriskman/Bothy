// ── the overflow menu ────────────────────────────────────────────────────────
//
// A real menu, written here rather than taken from a library, because there is
// no menu in this codebase to reuse: @radix-ui/react-dialog is present and a
// dialog is not a menu (it takes the whole screen, it has a title, and its
// keyboard model is Escape-and-Tab rather than arrows). One dependency for one
// popup on one strip is not a trade worth making.
//
// THE TRAP THIS PAGE HAS ALREADY FALLEN INTO ONCE, written down so it does not
// happen a third time: a control that is `display: none` until :hover is not a
// hidden control, it is a control that does not exist for a keyboard. It is out
// of the tab order entirely, and nothing about the page says so. That is exactly
// how the per-directory download in the explorer shipped mouse-only, and the fix
// there (`:focus-within`, in explorer.css) is a patch on a pattern that should
// not be used for anything richer than one button.
//
// So there is NO hover-reveal here at all. The menu is either rendered or it is
// not, and while it is rendered it behaves like a menu:
//
//   · click, Enter or Space on the button opens it and focuses the first item;
//   · ↑/↓ move, Home/End jump, Enter/Space activate;
//   · Tab does NOT leave - focus is trapped for as long as it is open, because
//     tabbing out of an open menu leaves a floating panel over the document
//     with no way back to it;
//   · Escape closes it and puts focus back on the button, which is the one
//     behaviour that makes it safe to open by accident;
//   · a pointer press anywhere else closes it.
//
// DISABLED ITEMS STAY. A menu whose contents change shape between openings is
// one you have to re-read every time; a greyed row that says why is a menu you
// can learn. They keep their place in the arrow order for the same reason - a
// screen reader has to be able to reach the explanation.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

export interface MenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** The chord, from `chordOf()` in keys.ts. Never a retyped string: the table
   *  is the single source for what a key does, and a menu that disagrees with
   *  it is the kind of wrong a reader cannot check without trying it. */
  chord?: readonly string[];
  disabled?: boolean;
  /** Said out loud beside a disabled row. "Why not" is the whole value of
   *  leaving it in the menu rather than removing it. */
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
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const btn = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const id = useId();

  const close = useCallback((toButton: boolean) => {
    setOpen(false);
    if (toButton) btn.current?.focus();
  }, []);

  // A pointer press outside. `pointerdown` rather than `click`, so the menu is
  // gone before whatever was pressed under it reacts.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  // Focus lands on the first row when it opens. Without this the menu is open
  // and the keyboard is still on the button, which reads as a menu that ignores
  // the arrow keys.
  useEffect(() => {
    if (!open) return;
    setAt(0);
    const first = list.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);

  const move = (to: number) => {
    const rows = list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    if (!rows?.length) return;
    const i = ((to % rows.length) + rows.length) % rows.length;
    setAt(i);
    rows[i]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Escape': e.preventDefault(); close(true); break;
      case 'ArrowDown': e.preventDefault(); move(at + 1); break;
      case 'ArrowUp': e.preventDefault(); move(at - 1); break;
      case 'Home': e.preventDefault(); move(0); break;
      case 'End': e.preventDefault(); move(items.length - 1); break;
      // The trap. Tab out of an open menu and the panel is still on screen with
      // the focus somewhere behind it.
      case 'Tab': e.preventDefault(); move(at + (e.shiftKey ? -1 : 1)); break;
      default: break;
    }
  };

  return (
    <div className="fx-menu-wrap" ref={wrap}>
      <button
        type="button"
        ref={btn}
        className={`fx-hbtn ${open ? 'on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div
          className={`fx-menu fx-menu-${align}`}
          role="menu"
          id={id}
          aria-label={label}
          ref={list}
          onKeyDown={onKeyDown}
        >
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              // Roving tabindex: exactly one row is in the tab order, and the
              // arrows move which. Disabled rows keep their place so they can
              // still be reached and read.
              tabIndex={i === at ? 0 : -1}
              className={`fx-menu-item${it.group ? ' fx-menu-cut' : ''}`}
              aria-disabled={it.disabled || undefined}
              onFocus={() => setAt(i)}
              onClick={() => {
                // `aria-disabled`, not `disabled`: a disabled button is not
                // focusable, and the explanation on it would be unreachable.
                // So the refusal happens here instead.
                if (it.disabled) return;
                close(false);
                it.onPick();
              }}
            >
              <span className="fx-menu-ico" aria-hidden="true">{it.icon}</span>
              <span className="fx-menu-label">
                {it.label}
                {it.disabled && it.note && <span className="fx-menu-note">{it.note}</span>}
              </span>
              {it.chord && (
                <span className="fx-menu-chord" aria-hidden="true">
                  {it.chord.map((k) => <span className="kbd" key={k}>{k}</span>)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
