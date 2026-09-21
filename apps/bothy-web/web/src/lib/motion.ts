// Motion tokens for JS - the same values index.css declares as --dur-*, --ease*,
// --spring* and --stagger, for framer-motion and anything else that animates
// from script (design audit SYS-9, 2026-09-21).
//
// TWO COPIES OF ONE SET OF NUMBERS, ON PURPOSE, AND CHECKED. framer-motion wants
// seconds and bezier arrays, not CSS strings, and reading computed style at
// animation time would put a style recalc on the input path (R1.2). So the
// values are written twice and checks/design-tokens.mjs compiles this file and
// asserts that every one of them equals its CSS token. Change both or neither.
//
// IMPORTS NOTHING, so checks/run.sh can compile it with a bare tsc. The React
// half - whether motion is reduced right now - is lib/useMotionReduced.ts.
//
// Where each is for (docs/brand/foundations/motion.md, decisions 1-3):
//   DUR.fast / EASE        colour, hover, fades
//   DUR.base / EASE        a transform or an elevation change
//   DUR.slow / EASE        a large surface arriving
//   DUR.exit / EASE_EXIT   anything leaving - quicker than it arrived
//   SPRING.*               dialogs, menus and drag, and NOTHING else
//   SPRING_BOUNCE          only a release after a momentum gesture

/** Durations in SECONDS, framer-motion's unit. index.css: --dur-fast, --dur,
 *  --dur-slow, --dur-exit, --press-dur. */
export const DUR = {
  fast: 0.12,
  base: 0.18,
  slow: 0.26,
  exit: 0.12,
  press: 0.1,
} as const;

type Bezier = readonly [number, number, number, number];

/** The brand curve, an ease-out: for things arriving and settling. --ease. */
export const EASE: Bezier = [0.2, 0.7, 0.2, 1];
/** Its mirror, for things leaving (R7.3). --ease-exit. */
export const EASE_EXIT: Bezier = [0.4, 0, 0.9, 0.4];
/** Symmetric, for a reversible hover or toggle. --ease-standard. */
export const EASE_STANDARD: Bezier = [0.4, 0, 0.2, 1];

/** A spring in Apple's two designer terms (R4): `response` in seconds (roughly
 *  the period, lower is snappier) and `damping` as a ratio (1 = critically
 *  damped, no overshoot; below 1 overshoots). Converted exactly to the physics
 *  framer-motion takes, with mass 1: stiffness = (2pi/response)^2 and
 *  damping = 2 * ratio * sqrt(stiffness). */
export function spring(response: number, damping = 1) {
  const w = (2 * Math.PI) / response;
  return { type: 'spring' as const, mass: 1, stiffness: w * w, damping: 2 * damping * w };
}

/** The three critically damped springs. `settle` is the CSS duration of the
 *  matching --spring-dur* token: the time to come within 0.1% of the target,
 *  which is what a CSS `linear()` curve needs and a spring does not. */
export const SPRING = {
  short: { ...spring(0.3), settle: 0.44 },   // --spring-dur-s
  base: { ...spring(0.35), settle: 0.52 },   // --spring-dur (the default)
  long: { ...spring(0.4), settle: 0.59 },    // --spring-dur-l
} as const;

/** Damping 0.8 - a 1.5% overshoot. Only after a momentum gesture (R4.2): a menu
 *  that bounces into place just because it appeared is motion with nothing to
 *  say. --spring-bounce / --spring-bounce-dur. */
export const SPRING_BOUNCE = { ...spring(0.35, 0.8), settle: 0.48 } as const;

/** Per-item stagger in seconds, and the index it stops growing at, so item 60
 *  does not wait two seconds (brand motion.md, "cap stagger"). --stagger. */
export const STAGGER = { step: 0.03, max: 8 } as const;
export const staggerDelay = (i: number) => Math.min(Math.max(i, 0), STAGGER.max) * STAGGER.step;

/** Frame-rate-independent smoothing for a per-frame follow (the 3D camera):
 *  the fraction of the remaining distance to cover this frame, so the motion
 *  takes the same time at 30, 60 or 144Hz. A bare `lerp(a, b, 0.08)` per frame
 *  is 2.4x faster on a 144Hz screen than on a 60Hz one. `rate` is per second;
 *  2pi/response gives the spring's own rate. */
export const followFactor = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);
