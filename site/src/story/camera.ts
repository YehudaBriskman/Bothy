// The descent, as numbers. Pure arithmetic, no DOM: scroll progress p (0 at the top of the page, 1 at its end) in,
// the camera and the sky's stage out. The sky engine feeds these into the shader's uniforms; story.css reads the same
// p for the CSS-only path. Stages, in the order the visitor passes them:
//   clear height -> cloud layer -> sea of cloud -> horizon glow -> twilight -> stars
// The sky never jumps: every curve is a smoothstep of p, so it is continuous and has zero slope at its ends.

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** The stage names, with the p at which each begins. Shown in the debug line and used by tests. */
export const STAGES = [
  { name: 'clear height', from: 0 },
  { name: 'cloud layer', from: 0.17 },
  { name: 'sea of cloud', from: 0.34 },
  { name: 'horizon glow', from: 0.55 },
  { name: 'twilight', from: 0.72 },
  { name: 'stars', from: 0.88 },
] as const;

export function stageAt(p: number): string {
  let name: string = STAGES[0].name;
  for (const s of STAGES) if (p >= s.from) name = s.name;
  return name;
}

export interface Camera {
  /** Where the camera looks, as a shift down the photograph (uv units): the view descends. */
  pan: number;
  /** Zoom multiplier on top of the engine's base 1.07: we move toward the clouds, then ease back to the horizon. */
  zoom: number;
  /** How far near cloud has crossed sideways (uv units, scaled by each pixel's depth in the shader). */
  cross: number;
  /** How far near cloud has risen past the camera (uv units, scaled by depth): clouds pass faster than open sky. */
  rise: number;
  /** 0..1 how much the sea of cloud fills the lower screen. */
  sea: number;
  /** Multiplier on the horizon glow strength. */
  glow: number;
  /** 0..1 how far the clock is advanced toward night (so twilight and stars arrive with the descent). */
  advance: number;
}

/** The camera at progress p. */
export function cameraAt(p: number): Camera {
  p = clamp01(p);
  const down = smooth(0, 0.55, p);
  const back = smooth(0.55, 1, p);
  return {
    pan: 0.07 * down - 0.03 * back,
    zoom: 1 + 0.26 * down - 0.12 * back,
    cross: 0.05 * smooth(0.1, 0.9, p),
    rise: 0.1 * smooth(0, 0.6, p),
    // the sea rises as the cloud layer ends, is deepest at the horizon, and drops back into twilight
    sea: smooth(0.2, 0.42, p) * (1 - 0.55 * smooth(0.72, 0.95, p)),
    glow: 1 + 1.1 * Math.sin(Math.PI * smooth(0.45, 0.85, p)),
    advance: smooth(0.5, 1, p),
  };
}

/** The clock the sky shows at progress p, given the visitor's hour: it runs on toward 23:00, and a night stays night. */
export function effectiveHour(hour: number, p: number): number {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 23 || h < 5) return h;
  return h + (23 - h) * cameraAt(p).advance;
}

/**
 * Scroll position to progress. `tops` are the document offsets of each chapter's top edge, `maxY` the last scroll
 * position. Chapters are anchors: p is `MARKS[i]` when chapter i's top is at the top of the window, linear between.
 */
export const MARKS = [0, 0.16, 0.33, 0.46, 0.6, 0.76, 0.92];
export function progressAt(y: number, tops: number[], maxY: number): number {
  if (!tops.length || maxY <= 0) return 0;
  if (y <= tops[0]!) return 0;
  for (let i = 1; i < tops.length; i++) {
    const a = tops[i - 1]!;
    const b = tops[i]!;
    if (y <= b) return MARKS[i - 1]! + ((y - a) / Math.max(1, b - a)) * (MARKS[i]! - MARKS[i - 1]!);
  }
  const last = tops[tops.length - 1]!;
  const lm = MARKS[tops.length - 1] ?? 0.92;
  return clamp01(lm + ((y - last) / Math.max(1, maxY - last)) * (1 - lm));
}
