// Sky hours: the keyframe table and its interpolation (the owner-approved look, daylight only: there is no night
// sky). Pure data and arithmetic, no DOM.
//
// One real photograph per light (day, dusk) is cross-faded and graded by these numbers in the shader:
//   w      mix of the two photographs [day, dusk]
//   gain   per-channel multiplier; lift: per-channel offset (the "LUT-like curve": out = lift + gain * in)
//   sat    saturation about luminance;  exp: exposure
//   glow   horizon glow colour + strength (follows the sun sideways)
//   sunCol colour of the sun disc and its bloom
//   haze   colour + amount of low haze;  scrim: strength of the local dark scrim behind the text
//   top/bot  CSS still gradient (the no-WebGL, phone and no-JS-with-JS path)
// Hours are local clock hours. The table runs from dawn to sunset and is clamped, never wrapped: before dawn the
// sky is the dawn palette, after sunset it is the sunset palette. It is never dark.

export const SUNRISE = 6.25;
export const SUNSET = 18.75;

export interface Key {
  /** The hour class of `styles/sky-still.css` (data-hour), so the still and the live sky agree on names. */
  n: string;
  h: number;
  w: number[];
  gain: number[];
  lift: number[];
  sat: number;
  exp: number;
  glow: number[];
  sunCol: number[];
  haze: number[];
  scrim: number;
  top: number[];
  bot: number[];
}

export type Grade = Omit<Key, 'h'> & { hour: number; name: string };

export const KEYS: Key[] = [
  {
    n: 'dawn',
    h: 6.4,
    w: [0, 1],
    gain: [0.9, 0.86, 1.0],
    lift: [0.02, 0.016, 0.03],
    sat: 1.05,
    exp: 0.72,
    glow: [1.0, 0.55, 0.38, 0.6],
    sunCol: [1, 0.62, 0.42],
    haze: [0.9, 0.62, 0.55, 0.4],
    scrim: 0.5,
    top: [84, 98, 150],
    bot: [238, 164, 124],
  },
  {
    n: 'morning',
    h: 8.5,
    w: [0.85, 0.15],
    gain: [1.04, 1.0, 0.94],
    lift: [0, 0, 0],
    sat: 1.08,
    exp: 1.0,
    glow: [1.0, 0.82, 0.6, 0.12],
    sunCol: [1, 0.9, 0.72],
    haze: [0.85, 0.86, 0.88, 0.25],
    scrim: 0.58,
    top: [74, 118, 188],
    bot: [196, 206, 218],
  },
  {
    n: 'noon',
    h: 12,
    w: [1, 0],
    gain: [0.98, 1.0, 1.04],
    lift: [0, 0, 0],
    sat: 1.12,
    exp: 1.02,
    glow: [1, 0.96, 0.88, 0.05],
    sunCol: [1, 0.98, 0.9],
    haze: [0.86, 0.9, 0.96, 0.2],
    scrim: 0.55,
    top: [52, 104, 190],
    bot: [176, 198, 224],
  },
  {
    n: 'afternoon',
    h: 15.5,
    w: [1, 0],
    gain: [1.04, 1.0, 0.93],
    lift: [0.004, 0.002, 0],
    sat: 1.08,
    exp: 0.95,
    glow: [1, 0.86, 0.6, 0.12],
    sunCol: [1, 0.92, 0.74],
    haze: [0.95, 0.88, 0.76, 0.25],
    scrim: 0.58,
    top: [66, 110, 186],
    bot: [214, 206, 192],
  },
  {
    n: 'golden',
    h: 17.5,
    w: [0.3, 0.7],
    gain: [1.1, 0.98, 0.8],
    lift: [0.012, 0.004, 0],
    sat: 1.1,
    exp: 0.88,
    glow: [1.0, 0.64, 0.28, 0.55],
    sunCol: [1, 0.72, 0.38],
    haze: [1.0, 0.74, 0.45, 0.4],
    scrim: 0.58,
    top: [92, 118, 170],
    bot: [244, 176, 108],
  },
  {
    n: 'sunset',
    h: 18.7,
    w: [0, 1],
    gain: [1.12, 0.9, 0.78],
    lift: [0.02, 0.006, 0.01],
    sat: 1.15,
    exp: 0.82,
    glow: [1.0, 0.45, 0.2, 0.8],
    sunCol: [1, 0.52, 0.22],
    haze: [1.0, 0.56, 0.36, 0.5],
    scrim: 0.54,
    top: [88, 92, 146],
    bot: [244, 124, 76],
  },
];

const FIELDS = ['w', 'gain', 'lift', 'sat', 'exp', 'glow', 'sunCol', 'haze', 'scrim', 'top', 'bot'] as const;

const sm = (t: number) => t * t * (3 - 2 * t);
const mixv = (a: number | number[], b: number | number[], t: number): number | number[] =>
  Array.isArray(a) ? a.map((x, i) => x + ((b as number[])[i]! - x) * t) : a + ((b as number) - a) * t;

/** Wrap any number to [0, 24). */
export const wrapHour = (h: number) => ((h % 24) + 24) % 24;

/** First and last hour of the table: the sky never goes past either end. */
export const DAY_START = KEYS[0]!.h;
export const DAY_END = KEYS[KEYS.length - 1]!.h;

/** The daylight hour a clock hour shows: before dawn is dawn, after sunset is sunset. */
export const daylight = (hour: number) => Math.min(DAY_END, Math.max(DAY_START, wrapHour(hour)));

/** Interpolated keyframe values at hour h: smooth (zero slope at keys), clamped to dawn..sunset. */
export function sample(hour: number): Grade {
  const h = daylight(hour);
  let i = 0;
  for (let k = 0; k < KEYS.length; k++) if (KEYS[k]!.h <= h) i = k;
  const a = KEYS[i]!;
  const b = KEYS[Math.min(KEYS.length - 1, i + 1)]!;
  const t = b.h === a.h ? 0 : sm(Math.min(1, Math.max(0, (h - a.h) / (b.h - a.h))));
  const out: Record<string, unknown> = { hour: h, name: t < 0.5 ? a.n : b.n };
  for (const f of FIELDS) out[f] = mixv(a[f], b[f], t);
  const g = out as unknown as Grade;
  // Renormalise the photograph mix (interpolation of a partition of unity stays one, but be exact).
  const s = g.w[0]! + g.w[1]! || 1;
  g.w = g.w.map((x) => x / s);
  return g;
}

/** The sun on a fixed, honest arc: x in 0..1 screen space, elevation in -1..1. Clamped to daylight like the sky. */
export interface Bodies {
  sun: { x: number; elev: number };
}
export function bodies(hour: number): Bodies {
  const day = SUNSET - SUNRISE;
  const st = Math.min(1, Math.max(0, (daylight(hour) - SUNRISE) / day)); // 0 at sunrise, 1 at sunset
  return { sun: { x: 0.1 + 0.8 * st, elev: Math.sin(Math.PI * st) } };
}

/** Hour (0..24) from the visitor's local clock. */
export function localHour(date = new Date()): number {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

/** Format an hour as HH:MM. */
export function fmt(h: number): string {
  const m = Math.round(wrapHour(h) * 60) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
