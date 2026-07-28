// Theme: dark (default) / light / system. Persisted to localStorage and stamped
// onto <html data-theme>. index.css keeps prefers-color-scheme working for the
// 'system' choice (no attribute), and the explicit data-theme selectors win when
// the user pins a mode.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'dark' | 'light' | 'system';
const KEY = 'portal-theme';

function apply(t: Theme) {
  const el = document.documentElement;
  if (t === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', t);
}

interface ThemeCtx {
  theme: Theme;
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

  useEffect(() => {
    apply(theme);
  }, [theme]);

  const setTheme = (t: Theme) => {
    try { localStorage.setItem(KEY, t); } catch { /* private mode */ }
    setThemeState(t);
  };
  const order: Theme[] = ['dark', 'light', 'system'];
  const cycle = () => setTheme(order[(order.indexOf(theme) + 1) % order.length]);

  return <Ctx.Provider value={{ theme, setTheme, cycle }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme() must be used inside <ThemeProvider>');
  return v;
}
