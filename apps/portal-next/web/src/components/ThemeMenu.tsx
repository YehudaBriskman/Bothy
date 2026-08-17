// The topbar theme control.
//
// It was a CYCLE button, and that was the bug: it rotated dark -> light ->
// system, so every named theme was unreachable from the topbar and the only way
// to choose one was to know that Settings had a picker. A control that can only
// reach three of six options is worse than no control, because it looks like the
// whole answer.
//
// So it is a menu. Cycling was never wrong because cycling is bad - it is right
// for two states - it stopped being able to express the choice the moment the
// set of themes became data.
//
// OPENS ON HOVER, and also on click and on keyboard, because hover alone is not
// an interaction on a touchscreen and not one for anybody navigating by keys.
// Hover is an accelerator over a control that works without it, never the only
// way in.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../lib/theme';
import { ThemeSwatch } from './ThemeSwatch';
import './ThemeMenu.css';

/** Pointer-out grace. Moving from the button to the panel crosses a few pixels
 *  of topbar, and closing on that gap is the classic hover-menu failure - the
 *  menu vanishes exactly as you reach for it. Long enough to cross, short enough
 *  that a menu you have left does not linger. */
const CLOSE_MS = 220;
/** Open delay. Without one, sweeping the pointer across the topbar on the way to
 *  the account button flashes this open behind it. */
const OPEN_MS = 90;

export function ThemeMenu() {
  const { selection, theme, themes, setSelection } = useTheme();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const btn = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const id = useId();

  const clearTimer = () => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
  };
  // Every unmount path goes through this, or a pending open fires into a
  // component that is gone.
  useEffect(() => clearTimer, []);

  const close = useCallback((toButton: boolean) => {
    clearTimer();
    setOpen(false);
    if (toButton) btn.current?.focus();
  }, []);

  // A pointer press outside. `pointerdown` rather than `click`, so the menu is
  // gone before whatever sits under it reacts. Same as UserMenu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const rows = () => Array.from(
    list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [],
  );
  const move = (to: number) => {
    const r = rows();
    if (!r.length) return;
    const i = ((to % r.length) + r.length) % r.length;
    setAt(i);
    r[i]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Escape': e.preventDefault(); close(true); break;
      case 'ArrowDown': e.preventDefault(); move(at + 1); break;
      case 'ArrowUp': e.preventDefault(); move(at - 1); break;
      case 'Home': e.preventDefault(); move(0); break;
      case 'End': e.preventDefault(); move(rows().length - 1); break;
      // Tab out of an open menu leaves the panel on screen with the focus behind
      // it, so Tab moves within, like the arrows.
      case 'Tab': e.preventDefault(); move(at + (e.shiftKey ? -1 : 1)); break;
      default: break;
    }
  };

  // Hover opens WITHOUT moving focus. Focusing the first row on a hover-open
  // would yank the caret away from whatever the user was doing, and a menu that
  // steals focus because the pointer passed over it is a menu that fights you.
  // Keyboard and click opens do focus - see the effect below.
  const [byPointer, setByPointer] = useState(false);
  const onEnter = () => {
    clearTimer();
    if (open) return;
    timer.current = window.setTimeout(() => { setByPointer(true); setOpen(true); }, OPEN_MS);
  };
  const onLeave = () => {
    clearTimer();
    timer.current = window.setTimeout(() => setOpen(false), CLOSE_MS);
  };

  useEffect(() => {
    if (!open) return;
    setAt(0);
    if (!byPointer) list.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
  }, [open, byPointer]);

  const choose = (next: string) => {
    setSelection(next);
    close(true);
  };

  const Icon = selection === 'system' ? Monitor : theme.appearance === 'light' ? Sun : Moon;
  const current = selection === 'system' ? `System, currently ${theme.name}` : theme.name;

  return (
    <div className="theme-menu" ref={wrap} onPointerEnter={onEnter} onPointerLeave={onLeave}>
      <button
        type="button"
        ref={btn}
        className={`icon-btn ${open ? 'on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`Theme: ${current}. Choose a theme.`}
        title={`Theme: ${current}`}
        onClick={() => { clearTimer(); setByPointer(false); setOpen((v) => !v); }}
      >
        <Icon size={18} aria-hidden="true" />
      </button>

      {open && (
        <div
          className="tm-panel"
          role="menu"
          id={id}
          aria-label="Theme"
          ref={list}
          onKeyDown={onKeyDown}
        >
          {/* System first, and it is the only row without a swatch: it is not a
              palette, it is a rule for picking one, and giving it five chips
              would imply it had colours of its own. */}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selection === 'system'}
            className={`tm-row ${selection === 'system' ? 'is-on' : ''}`}
            onClick={() => choose('system')}
            tabIndex={-1}
          >
            <span className="tm-mark">{selection === 'system' && <Check size={13} />}</span>
            <span className="tm-text">
              <span className="tm-name">System</span>
              <span className="tm-sub">Follow the desktop</span>
            </span>
          </button>

          <div className="tm-sep" role="none" />

          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitemradio"
              aria-checked={selection === t.id}
              className={`tm-row ${selection === t.id ? 'is-on' : ''}`}
              onClick={() => choose(t.id)}
              tabIndex={-1}
            >
              <span className="tm-mark">{selection === t.id && <Check size={13} />}</span>
              <span className="tm-text">
                <span className="tm-name">{t.name}</span>
              </span>
              <ThemeSwatch id={t.id} />
            </button>
          ))}

          {/* The menu lists themes; Settings explains them. Saying so here is
              cheaper than repeating every one-line note in a 220px popover. */}
          <div className="tm-sep" role="none" />
          <p className="tm-foot">Descriptions in Settings → Appearance</p>
        </div>
      )}
    </div>
  );
}
