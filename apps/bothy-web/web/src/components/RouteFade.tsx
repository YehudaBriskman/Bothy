// RouteFade - the page transition, a CROSS-FADE (design audit SYS-8, decision 2,
// batch 3, 2026-09-22).
//
// It was `AnimatePresence mode="wait"`: the outgoing page faded to 0, THEN the
// next one mounted and faded in. Measured: opacity 0 by 251ms and still 0 at
// 354ms - about 130ms of blank page on every navigation, ~560ms in all, and
// ~440ms even under reduced motion. The brand said "the outgoing page finishes
// before the next mounts"; the owner's decision 2 reversed that: the next route
// mounts at once and fades in OVER the outgoing one, nothing waits for an exit,
// and there is no frame in which neither page is visible.
//
// How: `mode="popLayout"`. The new page mounts in the same commit; the old one
// is lifted out of the flow (absolutely positioned where it was, so nothing
// jumps) and fades out on the exit curve while the new one fades in on the
// brand curve. The exit is shorter than the enter and starts slow (--ease-exit)
// while the enter starts fast (--ease), so their sum never dips: at every frame
// at least one of the two is substantially opaque. The whole change is the
// enter, DUR.base = 180ms, inside the ~200ms budget.
//
// THE OUTLET IS FROZEN PER KEY. A route element rendered through <Outlet/>
// reads the router context at render time, so the exiting copy would re-render
// as the NEW page and fade out the wrong content. `useOutlet()` captures the
// element for this key, and the exiting child keeps the element it was given.
//
// AND SO IS THE URL IT READS (2026-09-22, the batch-4 observation). Freezing the
// ELEMENT is not enough: the exiting copy is still mounted inside the live
// router, so every `useLocation`, `useSearchParams` and `useParams` in it
// answers with the URL of the page that replaced it. That is not cosmetic. It
// cost a page: navigating from the Files reader to #/settings/appearance landed
// back in Files. `FilesLanding` decides between the reader and a redirect to the
// guide by looking at `?root=`/`?path=`; on the way out it re-read the query of
// /settings/appearance, found none, concluded it was a bare /files, and issued
// <Navigate to="/files/guide">. The reader then wrote the guide's `?path=` and
// the navigation the reader asked for was gone.
//
// So a leaving page gets a location context pinned to the last URL it was
// PRESENT at, and a navigator whose push, replace and go do nothing. Both
// providers are always rendered - switching the VALUE, never the element - so
// nothing in the subtree remounts as it leaves. The rule this encodes is worth
// stating on its own: a page on its way out shows what it showed, and does not
// steer.
//
// Reduced motion (decision 3): the fade stays, at DUR.fast; the 6px rise goes.
// Nothing here can leave a page invisible: framer runs opacity on the Web
// Animations API, which finishes on time whether or not the main thread paints.

import { AnimatePresence, MotionConfig, motion, useIsPresent } from 'framer-motion';
import { useContext, useMemo, useRef, type ReactNode, type Ref } from 'react';
import {
  useOutlet,
  UNSAFE_LocationContext as LocationContext,
  UNSAFE_NavigationContext as NavigationContext,
} from 'react-router-dom';
import { DUR, EASE, EASE_EXIT } from '../lib/motion';
import { useMotionReduced } from '../lib/useMotionReduced';

interface PageProps {
  as: 'main' | 'div';
  id?: string;
  className?: string;
  reduce: boolean;
  children: ReactNode;
  ref?: Ref<HTMLElement>;
}

/** One page in the fade. While it is LEAVING it gives up its id and its
 *  landmark and becomes inert: for those 120ms there are two <main>s on screen,
 *  and the skip link, the keyboard and a screen reader must only find the new
 *  one. */
const NOOP = () => {};

function Page({ as, id, className, reduce, children, ref }: PageProps) {
  const present = useIsPresent();
  const M = as === 'main' ? motion.main : motion.div;

  // The URL this page last rendered AT. `present` goes false in the same commit
  // that brings the new location, so the last value written here is the old one
  // - which is exactly the URL the leaving page should keep answering with.
  const loc = useContext(LocationContext);
  const nav = useContext(NavigationContext);
  const keptLoc = useRef(loc);
  if (present) keptLoc.current = loc;
  // Object.create, not a spread: the history object's `location` and `action`
  // are getters, and spreading would freeze them to whatever they were when
  // this memo ran. Only the three ways to steer are replaced.
  const inertNav = useMemo(() => {
    const navigator = Object.create(nav.navigator as object) as typeof nav.navigator;
    navigator.push = NOOP;
    navigator.replace = NOOP;
    navigator.go = NOOP;
    return { ...nav, navigator };
  }, [nav]);
  return (
    <M
      ref={ref as Ref<HTMLDivElement>}
      id={present ? id : undefined}
      tabIndex={present && id ? -1 : undefined}
      className={className}
      data-route-fade={present ? 'in' : 'out'}
      aria-hidden={present ? undefined : true}
      inert={!present}
      initial={{ opacity: 0, y: reduce ? 0 : 6 }}
      animate={{ opacity: 1, y: 0, transition: { duration: reduce ? DUR.fast : DUR.base, ease: EASE } }}
      exit={{ opacity: 0, transition: { duration: DUR.exit, ease: EASE_EXIT } }}
    >
      <LocationContext.Provider value={present ? loc : keptLoc.current}>
        <NavigationContext.Provider value={present ? nav : inertNav}>
          {children}
        </NavigationContext.Provider>
      </LocationContext.Provider>
    </M>
  );
}

/** The routed body, cross-faded on `routeKey`. The parent must be a positioned
 *  box (`position: relative`): the leaving page is lifted out of the flow into
 *  it, at the place it was. */
export function RouteFade({ routeKey, as = 'div', id, className }: {
  routeKey: string;
  as?: 'main' | 'div';
  id?: string;
  className?: string;
}) {
  const outlet = useOutlet();
  const reduce = useMotionReduced();
  // reducedMotion="never" HERE ONLY: this component already drops the rise
  // when motion is reduced, and framer's own reduced mode (PrefsRuntime) made
  // the route change an instant swap - removing the fade that decision 3 keeps.
  return (
    <MotionConfig reducedMotion="never">
      <AnimatePresence mode="popLayout" initial={false}>
        <Page key={routeKey} as={as} id={id} className={className} reduce={reduce}>
          {outlet}
        </Page>
      </AnimatePresence>
    </MotionConfig>
  );
}
