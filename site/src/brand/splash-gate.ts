/**
 * Whether the first-visit splash (brand/splash.ts) plays. Kept apart from the splash itself so the entry script can
 * ask cheaply, and the lazy chunk is fetched only when the answer is yes. Pure: the caller passes the page's facts.
 *
 * It plays once per browser session, on the home page's hero, and never:
 *   - with prefers-reduced-motion (not even when forced);
 *   - when sessionStorage cannot be read or written (a blocked or full store would replay it on every page);
 *   - a second time in the same session (the flag is set the moment the answer is yes);
 *   - when the page did not open at the top (a deep link to #sizes, a restored scroll);
 *   - under automation (navigator.webdriver), so the site's own browser checks see the page, not the splash.
 * `?splash=1` forces it (still not with reduced motion) and leaves the flag alone; `?splash=0` turns it off.
 */
export const SPLASH_KEY = 'bb-splash-seen';

export interface SplashEnv {
  /** location.search */
  search: string;
  /** matchMedia('(prefers-reduced-motion: reduce)').matches */
  reducedMotion: boolean;
  /** The page has the story's hero (the home page). */
  hasHero: boolean;
  /** The page opened at the top: scrollY is 0 and there is no #fragment. */
  atTop: boolean;
  /** navigator.webdriver */
  automated: boolean;
  /** Returns window.sessionStorage. Reading the property itself can throw (storage blocked), so it is a function. */
  storage: () => Pick<Storage, 'getItem' | 'setItem'>;
}

export function splashParam(search: string): 'force' | 'off' | null {
  const v = new URLSearchParams(search).get('splash');
  if (v === '0') return 'off';
  return v === null ? null : 'force';
}

export function shouldPlaySplash(env: SplashEnv): boolean {
  if (env.reducedMotion || !env.hasHero) return false;
  const param = splashParam(env.search);
  if (param === 'off') return false;
  if (param === 'force') return true;
  if (env.automated || !env.atTop) return false;
  try {
    const s = env.storage();
    if (s.getItem(SPLASH_KEY)) return false;
    s.setItem(SPLASH_KEY, '1');
    // A store that accepts the write but does not keep it (some private modes) would replay: read it back.
    return s.getItem(SPLASH_KEY) === '1';
  } catch {
    return false;
  }
}
