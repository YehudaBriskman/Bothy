// Tabs — a real tablist, replacing the `.seg-toggle` pattern.
//
// `.seg-toggle` is a row of buttons with aria-pressed and no roles, so a screen
// reader announces N unrelated toggle buttons rather than "tab 1 of 2", and the
// arrow keys do nothing. This implements the WAI-ARIA tabs pattern properly:
// roving tabindex (only the selected tab is in the tab order, so Tab moves past
// the whole group in one press), Left/Right to move, Home/End to jump.
//
// index.css also carries a `.tabs button[role="tab"]` block that nothing has
// ever rendered — this is the component that finally uses it.

import { useRef, type ReactNode } from 'react';

export interface TabSpec {
  key: string;
  label: ReactNode;
  /** Right-aligned count, kept out of `label` so it can be styled apart. */
  count?: number;
}

export function Tabs({
  tabs, value, onChange, label,
}: {
  tabs: TabSpec[];
  value: string;
  onChange: (key: string) => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const move = (dir: 1 | -1 | 'home' | 'end') => {
    const i = tabs.findIndex((t) => t.key === value);
    const next =
      dir === 'home' ? 0
      : dir === 'end' ? tabs.length - 1
      : (i + dir + tabs.length) % tabs.length;
    onChange(tabs[next].key);
    // Focus follows selection — the automatic-activation variant of the
    // pattern, which is correct when switching costs nothing (both panels are
    // already in memory; there is no fetch behind either).
    ref.current?.querySelector<HTMLElement>(`[data-tab="${tabs[next].key}"]`)?.focus();
  };

  return (
    <div className="tabs" role="tablist" aria-label={label} ref={ref}>
      {tabs.map((t) => {
        const selected = t.key === value;
        return (
          <button
            key={t.key}
            data-tab={t.key}
            role="tab"
            id={`tab-${t.key}`}
            aria-selected={selected}
            aria-controls={`panel-${t.key}`}
            tabIndex={selected ? 0 : -1}
            className={selected ? 'on' : ''}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
              else if (e.key === 'Home') { e.preventDefault(); move('home'); }
              else if (e.key === 'End') { e.preventDefault(); move('end'); }
            }}
          >
            {t.label}
            {t.count != null && <span className="tab-n">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ tabKey, active, children }: { tabKey: string; active: boolean; children: ReactNode }) {
  if (!active) return null;
  return (
    <div role="tabpanel" id={`panel-${tabKey}`} aria-labelledby={`tab-${tabKey}`} tabIndex={0}>
      {children}
    </div>
  );
}
