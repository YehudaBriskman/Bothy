// Cheap one-shot WebGL capability check. If this returns false we render the
// static CSS layered diagram instead - the Overview must never be blank.
export function hasWebGL(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    return !!(
      window.WebGLRenderingContext &&
      (c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'))
    );
  } catch {
    return false;
  }
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

import type { Status } from '../../lib/discover';

// The reserved status palette, mirrored from index.css's DARK block
// (--st-up/--st-warn/--st-down/--st-off/--st-unknown) so the 3D LEDs glow in the
// same colours as every dot on the page. This is a hard fallback for the case
// where there is no computed style to read (SSR, a detached canvas);
// `statusHexes()` prefers the live token values, so a theme change stays in sync
// automatically.
//
// `stopped` and `unknown` were #4a5263 and #6b7688 here, against tokens of
// #4a5568 and #64748b. Two hand-copied values drifting is exactly what happens
// when the live path silently stops running - the fallback becomes the only code
// path and nothing compares it to its source again. Corrected with the bridge.
export const STATUS_HEX: Record<Status, string> = {
  up: '#34d399',
  starting: '#fbbf24',
  down: '#fb7185',
  // Dimmer than 'unknown': a stopped unit should read as an unlit slab in the
  // rack, not as another thing demanding attention.
  stopped: '#4a5568',
  unknown: '#64748b',
};

export const STATUS_LABEL: Record<Status, string> = {
  up: 'Up',
  starting: 'Starting',
  down: 'Down',
  stopped: 'Stopped',
  unknown: 'Unknown',
};

// index.css maps state → status token.
//
// The BARE fill, not the `-fg` half, and that differs from lib/icons.tsx on
// purpose: these drive emissive materials on LEDs in a 3D scene - light sources
// a few pixels across seen against a dark rack - not text on a surface. The
// contrast floors that make `-fg` the right answer for a glyph are a statement
// about text on a background, and there is no background here.
//
// These names were `--ok/--warn/--down/--off/--unk` until the palette was
// reorganised into `--st-*`, and the map was left behind. Because cssVar()
// returns '' for an undefined property, every lookup fell through to the
// STATUS_HEX fallback below and the "prefers the live computed values" promise
// in that comment had been false ever since - which is why two of the five
// fallbacks had drifted from the tokens they claim to mirror.
const STATUS_VAR: Record<Status, string> = {
  up: '--st-up', starting: '--st-warn', down: '--st-down',
  stopped: '--st-off', unknown: '--st-unknown',
};

// Read a CSS custom property off :root, trimmed. Returns '' if unavailable.
export function cssVar(name: string): string {
  if (typeof window === 'undefined' || !window.getComputedStyle) return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ── scene palette ───────────────────────────────────────────────────────────
// The 3D scene paints with real materials, so unlike every other surface it
// CANNOT inherit the CSS tokens. Its colours were hardcoded dark, which made
// the whole rack read as a black blob on the light theme's white page. This
// mirrors the two themes for the handful of structural materials.

export function isLightTheme(): boolean {
  if (typeof document === 'undefined') return false;
  const pinned = document.documentElement.getAttribute('data-theme');
  if (pinned === 'light') return true;
  if (pinned === 'dark') return false;
  return !!window.matchMedia?.('(prefers-color-scheme: light)').matches;
}

export interface ScenePalette {
  unit: string;        // rack-unit body
  unitHover: string;
  screen: string;      // the little label screen on a unit
  screenGlow: string;
  chassis: string;     // rack trunk
  bezel: string;
  frame: string;       // rack cabinet frame + edge legs
  backPanel: string;   // rack back wall
  rail: string;        // rack rails
  slab: string;        // 1U server front bezel
  // The slab's CHASSIS, behind the bezel, and its hover state. These were two
  // literals inline on the mesh while the bezel one line below already read
  // `pal.slab`, so a light theme lifted the bezel to mid-slate and left the body
  // it sits on near-black. A palette with a hole in it is worse than no palette:
  // the surrounding meshes move and the hole stays put, which reads as a
  // rendering fault rather than as a missing value.
  slabBody: string;
  slabBodyHover: string;
  slabScreen: string;
  slabGlow: string;
  handle: string;
  // The three faint activity LEDs on each slab, and the cyan point light that
  // keys the scene. Emissive, so they need to stay bright against a dark rack
  // and step down against a white page.
  activity: string;
  machine: string;     // container-floor machine body
  vent: string;
  pad: string;         // grounding pad under the floor
  padOpacity: number;
  sky: string;         // hemisphere light
  ground: string;
  key: string;         // directional key/fill
  fill: string;
  ambient: number;
}

const DARK: ScenePalette = {
  unit: '#0f1526', unitHover: '#243056',
  screen: '#0a1622', screenGlow: '#12405a',
  chassis: '#16203a', bezel: '#0c1324',
  frame: '#0d1119', backPanel: '#0a0d14', rail: '#2b3446',
  slab: '#0f141f', slabBody: '#182031', slabBodyHover: '#26324a',
  slabScreen: '#0a1622', slabGlow: '#123449', handle: '#3c4a63',
  activity: '#22d3ee',
  machine: '#161d2c', vent: '#05070c',
  pad: '#0a0f18', padOpacity: 0.55,
  sky: '#d7e6ff', ground: '#0a0e16',
  key: '#e4edff', fill: '#9db4ff',
  ambient: 0.72,
};

// Light: bodies lift to mid-slate so they read as objects rather than holes,
// the grounding pad becomes a faint shadow instead of a grey disc, and ambient
// rises so the unlit faces don't crush to black.
const LIGHT: ScenePalette = {
  unit: '#94a3b8', unitHover: '#cbd5e1',
  screen: '#dbeafe', screenGlow: '#60a5fa',
  chassis: '#8fa0b5', bezel: '#aab6c7',
  frame: '#7d8b9e', backPanel: '#9aa7b8', rail: '#cbd5e1',
  // slabBody sits a step DARKER than the bezel it carries, the same way the dark
  // set does - the relationship is what makes it read as a body, not the value.
  slab: '#b3bece', slabBody: '#9fabbb', slabBodyHover: '#c3ccd9',
  slabScreen: '#dbeafe', slabGlow: '#7dd3fc', handle: '#e2e8f0',
  // Cyan-600 rather than cyan-400: an emissive that glows against a black rack
  // washes out to near-white against a white page.
  activity: '#0891b2',
  machine: '#a8b4c4', vent: '#7c8aa3',
  pad: '#64748b', padOpacity: 0.16,
  sky: '#ffffff', ground: '#cbd5e1',
  key: '#ffffff', fill: '#dbeafe',
  ambient: 1.05,
};

export const scenePalette = (): ScenePalette => (isLightTheme() ? LIGHT : DARK);

// Live status palette pulled from the actual CSS tokens (falls back to the
// mirrored hexes above). Read once at scene mount so the LEDs are guaranteed to
// match the page even if the tokens are edited later.
export function statusHexes(): Record<Status, string> {
  return {
    up: cssVar(STATUS_VAR.up) || STATUS_HEX.up,
    starting: cssVar(STATUS_VAR.starting) || STATUS_HEX.starting,
    down: cssVar(STATUS_VAR.down) || STATUS_HEX.down,
    stopped: cssVar(STATUS_VAR.stopped) || STATUS_HEX.stopped,
    unknown: cssVar(STATUS_VAR.unknown) || STATUS_HEX.unknown,
  };
}
