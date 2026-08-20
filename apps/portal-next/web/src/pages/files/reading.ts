// ── how big a document is, and how big the panels around it are ──────────────
//
// Two numbers, and they are deliberately two.
//
//   · the DOCUMENT     - `--read-fs`, 16px by default. index.css argues for it:
//                        "14.5px is a good size for a control that sits beside a
//                        chart and a tiring one for a page of prose you actually
//                        read".
//   · the PANELS       - `--rd-ui-fs`. The index rows, the outline entries, the
//                        breadcrumbs. They were ~11.5px, set at the app's
//                        control size, on a surface whose whole argument is that
//                        a document is not a dashboard.
//
// They are two because they answer different questions. Raising the document
// widens the column (the measure is in `ch`) and does nothing to the rails;
// raising the panels makes the index legible without reflowing a word of prose.
// One number would force the two to move together and neither would land.
//
// ── WHY localStorage, AND WHY THAT IS NOT A PLACEHOLDER ─────────────────────
//
// docs/plans/control-and-settings.md §6b draws the line: theme, pane widths and
// collapsed groups belong to the BROWSER; identity and roles belong to the USER;
// and only "default root, default landing page, favourites" needs a store that
// does not exist. A text size passes the browser test outright - it is a fact
// about the screen you are sitting at, not about you, and the same size is wrong
// on a 14" laptop and a 27" monitor.
//
// So this ships now, honestly, beside `bothy-files-panes-v1` and
// `bothy-read-recent-v1`, and Settings says in the same sentence it says for
// those that it does not follow you to another device. #157 is the separate
// question of a per-user store; if that is answered yes this moves into it and
// the key below becomes the fallback - the same migration the theme would make.
//
// AND IT IS NOT A WRITE PATH. reading-first.md §7 is about writing to the BOX.
// This writes two numbers to the browser you are sitting at and reaches no
// server, which is the same thing the theme picker has always done.
//
// IMPORTS NOTHING except React, so the pure half below can be compiled and run
// by checks/run.sh with a bare `tsc`.

import { useCallback, useEffect, useState } from 'react';

/** Versioned, so a shape change is a reset rather than a crash on somebody's
 *  three-week-old localStorage. Same convention as `bothy-files-panes-v1`. */
export const READING_KEY = 'bothy-reading-v1';

export interface Reading {
  /** The rendered document, in px. */
  doc: number;
  /** The index and the outline, in px. */
  ui: number;
}

/** Today's values, so nobody who never opens Settings sees anything move.
 *
 *  `doc` is index.css's `--read-fs`. `ui` is 12.5px, which is what `.rd-doc-title`
 *  was - the largest of the panel sizes, chosen as the base because every other
 *  panel rule is expressed as a ratio BELOW it and a base picked from the
 *  smallest would have needed ratios above 1 to say "this one is bigger". */
export const READING_DEFAULT: Reading = { doc: 16, ui: 12.5 };

/** The band each is allowed into.
 *
 *  Bounded rather than free, and not to be tidy: `--read-measure` is `100%` and
 *  the panels are fixed-width rails, so a 40px index row does not wrap into a
 *  taller row - it ellipsises every title down to two words. The ceiling is the
 *  size at which the rail still says something. The floor is the size below
 *  which raising it was the point. */
export const READING_LIMITS = {
  doc: { min: 13, max: 24 },
  ui: { min: 11, max: 18 },
} as const;

/** One step of the +/- controls. Half a pixel on the panels because the range is
 *  seven pixels wide and whole steps would make it a four-position switch. */
export const READING_STEP = { doc: 1, ui: 0.5 } as const;

export function clampReading(key: keyof Reading, v: number): number {
  const { min, max } = READING_LIMITS[key];
  if (!Number.isFinite(v)) return READING_DEFAULT[key];
  // Rounded to a half pixel, which is the finest step either control offers.
  // Without it a hand-edited 16.333 reaches the stylesheet and every derived
  // size inherits a fraction nobody chose.
  return Math.max(min, Math.min(max, Math.round(v * 2) / 2));
}

/**
 * Whatever is in the store, made safe.
 *
 * Every field re-checked rather than trusted, for the reason `parseRecents` in
 * start.ts gives at length: this value is hand-editable, it survives deploys,
 * and it is fed straight into a CSS custom property. A stored `{doc: "huge"}`
 * would otherwise reach the stylesheet as `font-size: huge` and be silently
 * dropped by the browser, which renders as the setting not working.
 */
export function parseReading(raw: string | null): Reading {
  if (!raw) return READING_DEFAULT;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return READING_DEFAULT; }
  if (!j || typeof j !== 'object') return READING_DEFAULT;
  const r = j as Record<string, unknown>;
  return {
    doc: clampReading('doc', typeof r.doc === 'number' ? r.doc : READING_DEFAULT.doc),
    ui: clampReading('ui', typeof r.ui === 'number' ? r.ui : READING_DEFAULT.ui),
  };
}

/** The two custom properties, as a style object for the reader's root element.
 *
 *  ON THE ELEMENT, not on `:root`. The document scale belongs to the reading
 *  surface: written to `:root` it would resize the Settings page that changes it
 *  and every panel elsewhere in the app that happens to inherit, which is a
 *  preference reaching a great deal further than its own name claims. */
export function readingVars(r: Reading): Record<string, string> {
  return { '--read-fs': `${r.doc}px`, '--rd-ui-fs': `${r.ui}px` };
}

function read(): Reading {
  try { return parseReading(localStorage.getItem(READING_KEY)); } catch { return READING_DEFAULT; }
}

/**
 * The stored size, and a setter that stores.
 *
 * Never throws: private mode, a disabled store and a quota error all mean "the
 * defaults", which is a state every caller already renders.
 *
 * It listens for `storage` as well, so the Settings page changing the size is
 * reflected in a reader open in another tab. That event does not fire in the tab
 * that WROTE the value, which is why the setter also updates its own state -
 * the two halves are not redundant, they cover different tabs.
 */
export function useReading(): [Reading, (next: Partial<Reading>) => void] {
  const [reading, setReading] = useState<Reading>(read);

  const update = useCallback((next: Partial<Reading>) => {
    setReading((prev) => {
      const merged: Reading = {
        doc: clampReading('doc', next.doc ?? prev.doc),
        ui: clampReading('ui', next.ui ?? prev.ui),
      };
      try { localStorage.setItem(READING_KEY, JSON.stringify(merged)); } catch { /* not fatal */ }
      return merged;
    });
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== READING_KEY) return;
      setReading(parseReading(e.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return [reading, update];
}
