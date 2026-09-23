// Tabs - a real tablist, replacing the `.seg-toggle` pattern.
//
// `.seg-toggle` is a row of buttons with aria-pressed and no roles, so a screen
// reader announces N unrelated toggle buttons rather than "tab 1 of 2", and the
// arrow keys do nothing. This implements the WAI-ARIA tabs pattern properly:
// roving tabindex (only the selected tab is in the tab order, so Tab moves past
// the whole group in one press), Left/Right to move, Home/End to jump.
//
// index.css also carries a `.tabs button[role="tab"]` block that nothing has
// ever rendered - this is the component that finally uses it.

import { createContext, useContext, useId, useRef, type ReactNode } from 'react';

// CL-18: THE IDS ARE PER TABLIST, not per key. They were `tab-${key}` and
// `panel-${key}`, and the Cluster page and the dialog it opens both have a tab
// called "pods" - so the document carried two elements with the same id, and
// `aria-labelledby` resolved to whichever came first. A `useId()` prefix is
// unique per component instance; TabPanel reads it from a context rather than
// taking it as a prop, so a caller cannot forget to pass it and get a panel
// that points at nothing.
const TabIds = createContext('');

/** The id prefix of the nearest <Tabs>. Exported for a panel rendered outside
 *  the component that renders its tablist. */
export function useTabIds() {
  return useContext(TabIds);
}

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
  // The group's prefix when there is one, else this tablist's own. A tablist
  // with no <TabPanel> beside it (most of them - the panels are plain divs)
  // needs only that its own ids are unique in the document.
  const own = useId();
  const uid = useTabIds() || own;

  const move = (dir: 1 | -1 | 'home' | 'end') => {
    const i = tabs.findIndex((t) => t.key === value);
    const next =
      dir === 'home' ? 0
      : dir === 'end' ? tabs.length - 1
      : (i + dir + tabs.length) % tabs.length;
    onChange(tabs[next].key);
    // Focus follows selection - the automatic-activation variant of the
    // pattern, which is correct when switching costs nothing (both panels are
    // already in memory; there is no fetch behind either).
    ref.current?.querySelector<HTMLElement>(`[data-tab="${tabs[next].key}"]`)?.focus();
  };

  return (
    // CL-24: the strip scrolls sideways rather than wrapping. Six tabs wrapped
    // onto two rows at 390 inside a dialog, which moved everything under them
    // by a row's height the moment a tab was added. `scroll-shade` gives it the
    // same edge cue every other scroller in the app has, and it was already the
    // treatment `.cl-tabs` had locally - promoted here so every tablist gets it.
    <div className="tabs scroll-shade" role="tablist" aria-label={label} ref={ref}>
      {tabs.map((t) => {
        const selected = t.key === value;
        return (
          <button
            key={t.key}
            data-tab={t.key}
            role="tab"
            id={`${uid}tab-${t.key}`}
            aria-selected={selected}
            aria-controls={`${uid}panel-${t.key}`}
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

/** Wraps a tablist and the panels it controls, so both share one id prefix. */
export function TabGroup({ children }: { children: ReactNode }) {
  const uid = useId();
  return <TabIds.Provider value={uid}>{children}</TabIds.Provider>;
}

export function TabPanel({ tabKey, active, className, children }: {
  tabKey: string; active: boolean; className?: string; children: ReactNode;
}) {
  // A panel and the tab that labels it have to agree, and they can only do that
  // through a <TabGroup> above both - a tablist cannot hand a prefix to its
  // siblings. Outside one this falls back to the unprefixed ids, which is what
  // it always did.
  const uid = useTabIds();
  if (!active) return null;
  return (
    <div role="tabpanel" id={`${uid}panel-${tabKey}`} aria-labelledby={`${uid}tab-${tabKey}`} className={className} tabIndex={0}>
      {children}
    </div>
  );
}
