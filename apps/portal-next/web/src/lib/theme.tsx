// Theme selection. Persisted to localStorage and stamped onto <html>.
//
// The SELECTION ('system' or a theme id) and the RESOLVED theme are different
// things, and only the resolved one reaches the DOM: 'system' is collapsed here
// against matchMedia and stamped as concrete attributes. index.css therefore
// carries ONE light palette (:root[data-theme='light']) instead of the two
// copies it used to maintain - one for the pinned case and one inside
// @media (prefers-color-scheme: light). Those two had already drifted apart
// (--ok-ink was in both, --unk in neither), which is exactly the failure a
// single source of truth prevents.
//
// Two attributes are stamped, and lib/themes.ts explains why: `data-theme`
// carries the APPEARANCE, so everything already keyed on it keeps working, and
// `data-bothy-theme` carries the theme id, which is what the palette blocks in
// src/themes/*.css select on.
//
// index.html stamps the same pair before first paint, so resolving in JS costs
// no flash. That script is duplicated from here ON PURPOSE - an import would
// defeat the point - and it is allowed by an exact CSP hash in nginx.conf, so
// editing it means regenerating that hash. checks/csp_hash.mjs enforces both
// halves.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  DEFAULT_SELECTION, migrate, resolveSelection, THEMES,
  type Appearance, type Selection, type ThemeDef,
} from './themes';

export type { Selection, Appearance, ThemeDef };
/** Kept as a name because the rest of the app talks about 'dark' | 'light'. */
export type Resolved = Appearance;

const KEY = 'portal-theme';
/** Read only by the pre-paint script in index.html. Never read back here - this
 *  module computes the appearance from the registry, which is the source. */
const APPEARANCE_KEY = 'portal-theme-appearance';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const prefersDark = (): boolean =>
  typeof matchMedia !== 'undefined' && matchMedia(DARK_QUERY).matches;

export const resolve = (sel: Selection): ThemeDef => resolveSelection(sel, prefersDark());

/** The browser/OS chrome around the page - Android's address bar, iOS's status
 *  bar in standalone mode - is painted from <meta name="theme-color">.
 *
 *  It used to be two static tags keyed on prefers-color-scheme, which was
 *  already wrong for anyone who had PINNED a theme against their OS, and is
 *  hopeless once a theme can be any of several palettes. Reading the resolved
 *  --bg back out of the document is the only version that cannot disagree with
 *  what is on screen, because it IS what is on screen. */
function paintChrome() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (!bg) return;
  let tag = document.querySelector('meta[name="theme-color"]');
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute('name', 'theme-color');
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', bg);
}

function apply(sel: Selection) {
  const t = resolve(sel);
  const el = document.documentElement;
  el.setAttribute('data-theme', t.appearance);
  el.setAttribute('data-bothy-theme', t.id);
  // Persist the RESOLVED appearance beside the selection, for the pre-paint
  // script in index.html. That script has no registry - it cannot know whether
  // 'gruvbox' is dark or light - and without this it would guess dark and flash
  // the wrong frame at anyone using a light named theme. Writing it here means
  // the answer is always the one the app itself computed.
  try { localStorage.setItem(APPEARANCE_KEY, t.appearance); } catch { /* private mode */ }
  paintChrome();
}

interface ThemeCtx {
  /** What the user chose: 'system' or a theme id. */
  selection: Selection;
  /** What is actually painted right now - 'system' already collapsed. */
  theme: ThemeDef;
  /** The appearance of the painted theme. */
  resolved: Resolved;
  themes: readonly ThemeDef[];
  setSelection: (s: Selection) => void;
  /** Dark -> Light -> System, over the two built-ins. The header control is a
   *  one-tap toggle for the common case; the full list lives in Settings, so
   *  cycling through eight themes to get back to where you were is not a thing
   *  this can do to you. */
  cycle: () => void;
}
const Ctx = createContext<ThemeCtx | null>(null);

const read = (): Selection => {
  try { return migrate(localStorage.getItem(KEY)); } catch { return DEFAULT_SELECTION; }
};

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [selection, setSel] = useState<Selection>(read);
  const [theme, setTheme] = useState<ThemeDef>(() => resolve(read()));

  useEffect(() => {
    apply(selection);
    setTheme(resolve(selection));
  }, [selection]);

  // Track a live OS flip. Without this, 'system' only ever sampled the OS at
  // mount, so switching the desktop to light left the portal dark until reload
  // - the one behaviour 'system' exists to provide.
  useEffect(() => {
    if (selection !== 'system' || typeof matchMedia === 'undefined') return;
    const mq = matchMedia(DARK_QUERY);
    const onChange = () => { apply('system'); setTheme(resolve('system')); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [selection]);

  const setSelection = (s: Selection) => {
    try { localStorage.setItem(KEY, s); } catch { /* private mode */ }
    setSel(s);
  };

  const order: Selection[] = ['bothy-dark', 'bothy-light', 'system'];
  const cycle = () => {
    const i = order.indexOf(selection);
    // A named theme is not on the cycle, so the first tap from one lands on
    // Light rather than nowhere.
    setSelection(order[(i + 1) % order.length] ?? 'bothy-light');
  };

  return (
    <Ctx.Provider value={{
      selection, theme, resolved: theme.appearance, themes: THEMES, setSelection, cycle,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme() must be used inside <ThemeProvider>');
  return v;
}
