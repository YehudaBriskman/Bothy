// Is motion reduced RIGHT NOW - by the OS, or by Settings > Appearance > Motion?
// One answer for the whole app (design audit SYS-11, 2026-09-21).
//
// There were two answers, and they disagreed. The in-app "Reduce here" setting
// stamps `html[data-motion=reduce]`, which reached the CSS (prefs.css) and
// framer's <MotionConfig> - but framer's own `useReducedMotion()` reads ONLY the
// OS media query, so every branch written as `reduce ? {} : {animate…}` (the
// page transition, the Services collapse, the detail pages) kept animating for
// somebody who had asked this app to stop. The 3D scene read the media query
// once at mount, and two smooth scrolls never asked at all.
//
// So: one function that ORs the two sources, and a hook that re-renders when
// EITHER changes - the media query flips when the OS setting does, and the
// attribute flips when Settings (or another tab, via PrefsRuntime) re-stamps it.

import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/** The same answer, synchronously, for code that is not a component. */
export function motionReduced(): boolean {
  if (typeof window === 'undefined') return false;
  return document.documentElement.getAttribute('data-motion') === 'reduce'
    || (!!window.matchMedia && window.matchMedia(QUERY).matches);
}

/** 'auto' when motion is reduced, 'smooth' otherwise - for scrollIntoView and
 *  scrollTo, which the CSS reduce blocks cannot reach. */
export const scrollBehavior = (): ScrollBehavior => (motionReduced() ? 'auto' : 'smooth');

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia?.(QUERY);
  mq?.addEventListener('change', onChange);
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  return () => { mq?.removeEventListener('change', onChange); mo.disconnect(); };
}

/** True while motion should be reduced; re-renders when either source changes.
 *  Use this, never framer's `useReducedMotion()` - see the header. */
export function useMotionReduced(): boolean {
  return useSyncExternalStore(subscribe, motionReduced, () => false);
}
