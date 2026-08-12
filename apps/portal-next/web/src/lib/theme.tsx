// Theme: dark (default) / light / system. Persisted to localStorage and stamped
// onto <html data-theme>.
//
// The choice ('dark' | 'light' | 'system') and the RESOLVED theme
// ('dark' | 'light') are different things, and only the resolved one reaches
// the DOM: 'system' is resolved here against matchMedia and stamped as a
// concrete attribute. index.css therefore carries ONE light palette
// (:root[data-theme='light']) instead of the two copies it used to maintain —
// one for the pinned case and one inside @media (prefers-color-scheme: light).
// Those two had already drifted apart (--ok-ink was in both, --unk in neither),
// which is exactly the failure a single source of truth prevents.
//
// index.html stamps the same attribute before first paint, so resolving in JS
// costs no flash.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'dark' | 'light' | 'system';
export type Resolved = 'dark' | 'light';

const KEY = 'portal-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const systemTheme = (): Resolved =>
  typeof matchMedia !== 'undefined' && matchMedia(DARK_QUERY).matches ? 'dark' : 'light';

export const resolve = (t: Theme): Resolved => (t === 'system' ? systemTheme() : t);

function apply(t: Theme) {
  document.documentElement.setAttribute('data-theme', resolve(t));
}

interface ThemeCtx {
  theme: Theme;
  /** What is actually painted right now — 'system' already collapsed. */
  resolved: Resolved;
  setTheme: (t: Theme) => void;
  cycle: () => void;
}
const Ctx = createContext<ThemeCtx | null>(null);

const read = (): Theme => {
  const v = (typeof localStorage !== 'undefined' && localStorage.getItem(KEY)) as Theme | null;
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'dark';
};

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(read);
  const [resolved, setResolved] = useState<Resolved>(() => resolve(read()));

  useEffect(() => {
    apply(theme);
    setResolved(resolve(theme));
  }, [theme]);

  // Track a live OS flip. Without this, 'system' only ever sampled the OS at
  // mount, so switching the desktop to light left the portal dark until reload
  // — the one behaviour 'system' exists to provide.
  useEffect(() => {
    if (theme !== 'system' || typeof matchMedia === 'undefined') return;
    const mq = matchMedia(DARK_QUERY);
    const onChange = () => { apply('system'); setResolved(systemTheme()); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = (t: Theme) => {
    try { localStorage.setItem(KEY, t); } catch { /* private mode */ }
    setThemeState(t);
  };
  const order: Theme[] = ['dark', 'light', 'system'];
  const cycle = () => setTheme(order[(order.indexOf(theme) + 1) % order.length]);

  return <Ctx.Provider value={{ theme, resolved, setTheme, cycle }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme() must be used inside <ThemeProvider>');
  return v;
}
