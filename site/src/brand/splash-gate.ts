/**
 * Whether the first-visit intro (brand/splash.ts) plays. The decision is made by an inline script in the home page's
 * head (introScript below), before the first paint, so a first visit never flashes the page before hiding it. Pure:
 * the caller passes the page's facts.
 *
 * It plays on EVERY load of the home page's hero (a refresh included; it used to play once per session, and the owner
 * wants the icon animation on each refresh), and never:
 *   - with prefers-reduced-motion (not even when forced);
 *   - when the page opened on a #fragment (a deep link to #sizes);
 *   - under automation (navigator.webdriver), so the site's own browser checks see the page, not the intro.
 * `?splash=1` forces it (still not with reduced motion) and leaves the flag alone; `?splash=0` turns it off.
 */
export interface SplashEnv {
  /** location.search */
  search: string;
  /** matchMedia('(prefers-reduced-motion: reduce)').matches */
  reducedMotion: boolean;
  /** The page has the story's hero (the home page). */
  hasHero: boolean;
  /** The page opened at the top: no #fragment. */
  atTop: boolean;
  /** navigator.webdriver */
  automated: boolean;
}

export function splashParam(search: string): 'force' | 'off' | null {
  const v = new URLSearchParams(search).get('splash');
  if (v === '0') return 'off';
  return v === null ? null : 'force';
}

/**
 * Self-contained on purpose (no imports, no outer names): introScript() inlines its source into the page head. Keep
 * it plain ES2019 that uses nothing but its argument.
 */
export function shouldPlaySplash(env: SplashEnv): boolean {
  if (env.reducedMotion || !env.hasHero) return false;
  const v = new URLSearchParams(env.search).get('splash');
  if (v === '0') return false;
  if (v !== null) return true;
  if (env.automated || !env.atTop) return false;
  return true;
}

/** The class that hides the page, only visually, for the intro (styles/intro.css). */
export const INTRO_CLASS = 'bb-intro';
/** The failsafe: whatever happens to the splash module, the class is gone by then. */
export const INTRO_FAILSAFE_MS = 3500;

/**
 * The home page's inline head script. When the gate says yes it sets `bb-intro` on <html> (styles/intro.css takes the
 * header and the hero to opacity 0: nothing moves, and the content stays in the HTML for crawlers; without script or
 * with reduced motion the class is never set) and arms the failsafe that removes it after 3.5 s whether or not the
 * splash module ever loads. brand/splash.ts then takes the page over and assembles it around the flying lockup.
 */
export function introScript(): string {
  const env =
    "{search:location.search,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,hasHero:true," +
    'atTop:!location.hash,automated:navigator.webdriver===true}';
  return (
    `(function(){var d=document.documentElement;try{if((${shouldPlaySplash.toString()})(${env})){` +
    `d.classList.add('${INTRO_CLASS}');setTimeout(function(){d.classList.remove('${INTRO_CLASS}')},${INTRO_FAILSAFE_MS})}}` +
    `catch(e){d.classList.remove('${INTRO_CLASS}')}})()`
  );
}
