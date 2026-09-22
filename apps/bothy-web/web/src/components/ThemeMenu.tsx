// The topbar theme control.
//
// It was a CYCLE button, and that was the bug: it rotated dark -> light ->
// system, so every named theme was unreachable from the topbar and the only way
// to choose one was to know that Settings had a picker. A control that can only
// reach three of six options is worse than no control, because it looks like the
// whole answer. So it is a menu.
//
// ON ui/Menu SINCE BATCH 3 (design audit SYS-5, 2026-09-22). It was one of nine
// hand-rolled popovers: its own keyboard model, its own outside-press listener,
// its own panel geometry, no motion in or out. It is now a single-choice
// (menuitemradio) group on the shared primitive, which grows out of this button
// and goes back into it.
//
// IT NO LONGER OPENS ON HOVER. The hand-rolled version opened after 90ms of
// hover with a 220ms close grace and a hover bridge under the button, and was
// careful not to move focus on a hover-open. A shared menu opens on the press
// (pointer-DOWN, R1.1), like the account menu beside it (R16.4 - two menus on
// one bar that open differently read as two applications), and a menu that
// takes focus on open is what makes its arrow keys work. Hover was an
// accelerator over a control that always worked without it; dropping it costs
// ~100ms on a mouse and nothing on touch or keys.

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../lib/theme';
import { ThemeSwatch } from './ThemeSwatch';
import { Menu, type MenuItem } from './ui/Menu';
import './ThemeMenu.css';

export function ThemeMenu() {
  const { selection, theme, themes, setSelection } = useTheme();

  const Icon = selection === 'system' ? Monitor : theme.appearance === 'light' ? Sun : Moon;
  const current = selection === 'system' ? `System, currently ${theme.name}` : theme.name;

  const items: MenuItem[] = [
    // System first, and the only row without a swatch: it is not a palette, it
    // is a rule for picking one - and since batch 3 it is the default (SYS-19).
    { key: 'system', label: 'System', sub: 'Follow the desktop', onSelect: () => setSelection('system') },
    ...themes.map((t, i) => ({
      key: t.id,
      label: t.name,
      trailing: <ThemeSwatch id={t.id} />,
      separatorAbove: i === 0,
      onSelect: () => setSelection(t.id),
    })),
  ];

  return (
    <Menu
      className="theme-menu-pop"
      label="Theme"
      selected={selection}
      items={items}
      // The menu lists themes; Settings explains them.
      footer="Descriptions in Settings → Appearance"
      trigger={(
        <button
          type="button"
          className="icon-btn"
          aria-label={`Theme: ${current}. Choose a theme.`}
          title={`Theme: ${current}`}
        >
          <Icon size={18} aria-hidden="true" />
        </button>
      )}
    />
  );
}
