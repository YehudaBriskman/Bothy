// Sky hours: the keyframe table and its interpolation. Pure data and arithmetic, no DOM, so a node test can import it.
//
// One real photograph per light (day, dusk, night) is cross-faded and graded by these numbers in the shader:
//   w      mix of the three photographs [day, dusk, night]
//   gain   per-channel multiplier; lift: per-channel offset (the "LUT-like curve": out = lift + gain * in)
//   sat    saturation about luminance;  exp: exposure
//   glow   horizon glow colour + strength (follows the sun/moon sideways)
//   sunCol colour of the sun disc and its bloom;  moonK: moon strength;  stars: star strength
//   haze   colour + amount of low haze;  scrim: strength of the local dark scrim behind the text
//   top/bot  CSS still gradient (the no-WebGL, phone and no-JS-with-JS path)
// Hours are local clock hours, 0 to 24. Keys are listed in order and the table wraps (24 = 0).

export const SUNRISE = 6.25;
export const SUNSET = 18.75;

export const KEYS = [
  {
    n: 'night',
    h: 0,
    w: [0, 0, 1],
    gain: [0.66, 0.82, 1.15],
    lift: [0.004, 0.012, 0.034],
    sat: 0.85,
    exp: 1.1,
    glow: [0.1, 0.18, 0.4, 0.05],
    sunCol: [1, 0.8, 0.6],
    moonK: 1,
    stars: 1,
    haze: [0.05, 0.09, 0.2, 0.25],
    scrim: 0.3,
    top: [5, 10, 26],
    bot: [20, 34, 62],
  },
  {
    n: 'night',
    h: 4.25,
    w: [0, 0, 1],
    gain: [0.66, 0.82, 1.15],
    lift: [0.004, 0.012, 0.034],
    sat: 0.85,
    exp: 1.1,
    glow: [0.1, 0.18, 0.4, 0.05],
    sunCol: [1, 0.8, 0.6],
    moonK: 1,
    stars: 1,
    haze: [0.05, 0.09, 0.2, 0.25],
    scrim: 0.3,
    top: [5, 10, 26],
    bot: [20, 34, 62],
  },
  {
    n: 'pre-dawn',
    h: 5.4,
    w: [0, 0.22, 0.78],
    gain: [0.75, 0.8, 1.2],
    lift: [0.012, 0.018, 0.05],
    sat: 0.95,
    exp: 1.5,
    glow: [0.55, 0.3, 0.45, 0.35],
    sunCol: [1, 0.6, 0.45],
    moonK: 0.55,
    stars: 0.6,
    haze: [0.2, 0.18, 0.38, 0.4],
    scrim: 0.34,
    top: [18, 24, 58],
    bot: [96, 74, 108],
  },
  {
    n: 'dawn',
    h: 6.4,
    w: [0, 1, 0],
    gain: [0.9, 0.86, 1.0],
    lift: [0.02, 0.016, 0.03],
    sat: 1.05,
    exp: 0.72,
    glow: [1.0, 0.55, 0.38, 0.6],
    sunCol: [1, 0.62, 0.42],
    moonK: 0,
    stars: 0,
    haze: [0.9, 0.62, 0.55, 0.4],
    scrim: 0.5,
    top: [84, 98, 150],
    bot: [238, 164, 124],
  },
  {
    n: 'morning',
    h: 8.5,
    w: [0.85, 0.15, 0],
    gain: [1.04, 1.0, 0.94],
    lift: [0, 0, 0],
    sat: 1.08,
    exp: 1.0,
    glow: [1.0, 0.82, 0.6, 0.12],
    sunCol: [1, 0.9, 0.72],
    moonK: 0,
    stars: 0,
    haze: [0.85, 0.86, 0.88, 0.25],
    scrim: 0.58,
    top: [74, 118, 188],
    bot: [196, 206, 218],
  },
  {
    n: 'noon',
    h: 12,
    w: [1, 0, 0],
    gain: [0.98, 1.0, 1.04],
    lift: [0, 0, 0],
    sat: 1.12,
    exp: 1.02,
    glow: [1, 0.96, 0.88, 0.05],
    sunCol: [1, 0.98, 0.9],
    moonK: 0,
    stars: 0,
    haze: [0.86, 0.9, 0.96, 0.2],
    scrim: 0.55,
    top: [52, 104, 190],
    bot: [176, 198, 224],
  },
  {
    n: 'afternoon',
    h: 15.5,
    w: [1, 0, 0],
    gain: [1.04, 1.0, 0.93],
    lift: [0.004, 0.002, 0],
    sat: 1.08,
    exp: 0.95,
    glow: [1, 0.86, 0.6, 0.12],
    sunCol: [1, 0.92, 0.74],
    moonK: 0,
    stars: 0,
    haze: [0.95, 0.88, 0.76, 0.25],
    scrim: 0.58,
    top: [66, 110, 186],
    bot: [214, 206, 192],
  },
  {
    n: 'golden hour',
    h: 17.5,
    w: [0.3, 0.7, 0],
    gain: [1.1, 0.98, 0.8],
    lift: [0.012, 0.004, 0],
    sat: 1.1,
    exp: 0.88,
    glow: [1.0, 0.64, 0.28, 0.55],
    sunCol: [1, 0.72, 0.38],
    moonK: 0,
    stars: 0,
    haze: [1.0, 0.74, 0.45, 0.4],
    scrim: 0.58,
    top: [92, 118, 170],
    bot: [244, 176, 108],
  },
  {
    n: 'sunset',
    h: 18.7,
    w: [0, 1, 0],
    gain: [1.12, 0.9, 0.78],
    lift: [0.02, 0.006, 0.01],
    sat: 1.15,
    exp: 0.82,
    glow: [1.0, 0.45, 0.2, 0.8],
    sunCol: [1, 0.52, 0.22],
    moonK: 0,
    stars: 0,
    haze: [1.0, 0.56, 0.36, 0.5],
    scrim: 0.54,
    top: [88, 92, 146],
    bot: [244, 124, 76],
  },
  {
    n: 'dusk',
    h: 19.7,
    w: [0, 0.65, 0.35],
    gain: [0.86, 0.72, 0.98],
    lift: [0.014, 0.012, 0.045],
    sat: 1.05,
    exp: 0.62,
    glow: [0.85, 0.32, 0.4, 0.5],
    sunCol: [1, 0.4, 0.3],
    moonK: 0.35,
    stars: 0.25,
    haze: [0.55, 0.3, 0.45, 0.45],
    scrim: 0.36,
    top: [40, 40, 96],
    bot: [176, 86, 98],
  },
  {
    n: 'twilight',
    h: 20.8,
    w: [0, 0.14, 0.86],
    gain: [0.66, 0.74, 1.22],
    lift: [0.008, 0.014, 0.05],
    sat: 0.95,
    exp: 1.2,
    glow: [0.3, 0.26, 0.6, 0.25],
    sunCol: [1, 0.4, 0.3],
    moonK: 0.8,
    stars: 0.8,
    haze: [0.18, 0.2, 0.46, 0.35],
    scrim: 0.32,
    top: [12, 18, 48],
    bot: [58, 62, 118],
  },
  {
    n: 'night',
    h: 22.2,
    w: [0, 0, 1],
    gain: [0.66, 0.82, 1.15],
    lift: [0.004, 0.012, 0.034],
    sat: 0.85,
    exp: 1.1,
    glow: [0.1, 0.18, 0.4, 0.05],
    sunCol: [1, 0.8, 0.6],
    moonK: 1,
    stars: 1,
    haze: [0.05, 0.09, 0.2, 0.25],
    scrim: 0.3,
    top: [5, 10, 26],
    bot: [20, 34, 62],
  },
];

const FIELDS = ['w', 'gain', 'lift', 'sat', 'exp', 'glow', 'sunCol', 'moonK', 'stars', 'haze', 'scrim', 'top', 'bot'];

const sm = (t) => t * t * (3 - 2 * t);
const mixv = (a, b, t) => (Array.isArray(a) ? a.map((x, i) => x + (b[i] - x) * t) : a + (b - a) * t);

/** Wrap any number to [0, 24). */
export const wrapHour = (h) => ((h % 24) + 24) % 24;

/** Interpolated keyframe values at hour h: smooth (zero slope at keys) and continuous across midnight. */
export function sample(hour) {
  const h = wrapHour(hour);
  let i = KEYS.length - 1;
  for (let k = 0; k < KEYS.length; k++) if (KEYS[k].h <= h) i = k;
  const a = KEYS[i];
  const b = KEYS[(i + 1) % KEYS.length];
  const ah = a.h;
  const bh = b.h + (b.h <= a.h ? 24 : 0);
  const hh = h < ah ? h + 24 : h;
  const t = sm(Math.min(1, Math.max(0, (hh - ah) / (bh - ah))));
  const out = { hour: h, name: t < 0.5 ? a.n : b.n };
  for (const f of FIELDS) out[f] = mixv(a[f], b[f], t);
  // Renormalise the photograph mix (interpolation of a partition of unity stays one, but be exact).
  const s = out.w[0] + out.w[1] + out.w[2] || 1;
  out.w = out.w.map((x) => x / s);
  return out;
}

/** Sun and moon on a fixed, honest arc: x and y in 0..1 screen space (y down), elevation in -1..1. */
export function bodies(hour, date = new Date()) {
  const h = wrapHour(hour);
  const day = SUNSET - SUNRISE;
  const st = (h - SUNRISE) / day; // 0 at sunrise, 1 at sunset
  const sunElev = Math.sin(Math.PI * st);
  const sun = { x: 0.1 + 0.8 * Math.min(1, Math.max(0, st)), elev: st < 0 || st > 1 ? -Math.abs(sunElev) : sunElev };
  // The moon crosses in the night hours, sunset + 0.5 to sunrise + 0.5 (24 - day long).
  const mh = wrapHour(h - (SUNSET + 0.5));
  const night = 24 - day;
  const mt = mh / night;
  const moonElev = mt <= 1 ? Math.sin(Math.PI * mt) : -0.2;
  const moon = { x: 0.1 + 0.8 * Math.min(1, mt), elev: moonElev };
  return { sun, moon, phase: moonPhase(date) };
}

/** Moon phase 0..1 (0 new, 0.5 full) from the date: mean synodic month from the new moon of 2000-01-06. */
export function moonPhase(date) {
  const days = (date.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86400000;
  const p = (days / 29.530588853) % 1;
  return p < 0 ? p + 1 : p;
}

/** Hour (0..24) from the visitor's local clock. */
export function localHour(date = new Date()) {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

/** Format an hour as HH:MM. */
export function fmt(h) {
  const m = Math.round(wrapHour(h) * 60) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
