/**
 * The staged dot dissolve of the story: sky to black through a halftone that rises from the bottom of the window.
 *
 * Three stages, all from one number (the front) that story/console.ts writes from the scroll position:
 *   1. the whole sky wears a fine, thin dot grid from the first pixel (pure CSS, `.story::after` in dither.css);
 *   2. a band of denser, larger dots rises from the bottom while the console grows and pins: coverage is a smooth
 *      ramp of height, bent by smooth noise along the width so the front is ragged, not a line;
 *   3. the band is solid ink, then everything is: the page is the black that #story-end hands over.
 *
 * The band is drawn ONCE (and again on resize) into a small canvas, then only moved: one transform per update, no
 * per-frame drawing and no per-pixel loop. Under it is a block of the page's ink, so below the band it is solid.
 * `prefers-reduced-motion`, phones and no script never create it: they keep the static dissolve (dither.css).
 */

const PITCH = 8; // CSS px between dots along a row
const ROW = PITCH * 0.866; // rows of a staggered (hexagonal) grid
const BAND = 0.42; // the band is this fraction of the window tall

/** Smooth 2-D value noise in [0, 1]: lattice hash, smoothstep blend. Pure, no state. */
function noise(x: number, y: number): number {
  const h = (i: number, j: number) => {
    const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * u;
  const b = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * u;
  return a + (b - a) * v;
}

/** Dot coverage 0..1+ at depth v (0 at the band's top edge, 1 at its solid bottom) and column x. */
export function coverage(v: number, x: number): number {
  // the front is bent sideways: low-frequency along the width (clouds at the edges stay lighter longer), a finer one
  // on top, both fading out toward the solid bottom so the band always ends in ink
  const n = (noise(x / 330, v * 2.2) - 0.5) * 0.7 + (noise(x / 95, v * 5 + 9) - 0.5) * 0.3;
  const w = Math.sqrt(Math.max(0, 1 - v));
  const d = Math.min(1, Math.max(0, v + n * 0.66 * w));
  const s = d * d * (3 - 2 * d);
  return s * 1.32; // above 1 the dots overlap: that is what makes the bottom solid
}

export interface Dither {
  /** Where the band's top edge is, as a fraction of the window height (1 = at the foot: hidden; negative = gone). */
  set(front: number): void;
  measure(): void;
  /** Band height in px (for the caller's maths). */
  readonly band: number;
}

export function setupDither(root: HTMLElement): Dither | null {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const el = document.createElement('div');
  el.className = 'sd';
  el.setAttribute('aria-hidden', 'true');
  const front = document.createElement('div');
  front.className = 'sd-front';
  canvas.className = 'sd-band';
  const solid = document.createElement('div');
  solid.className = 'sd-solid';
  front.append(canvas, solid);
  el.append(front);
  root.prepend(el);
  root.classList.add('sd-on');

  let vh = innerHeight;
  let band = Math.round(vh * BAND);
  let drawn = '';
  let last = NaN;

  function draw() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = innerWidth;
    const key = `${w}x${band}@${dpr}`;
    if (key === drawn) return;
    drawn = key;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(band * dpr);
    canvas.style.blockSize = `${band}px`;
    const c = ctx!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, band);
    c.fillStyle = getComputedStyle(root).getPropertyValue('--after-story-bg').trim() || '#09090c';
    const rows = Math.ceil(band / ROW);
    const cell = PITCH * ROW;
    c.beginPath();
    for (let j = 0; j < rows; j++) {
      const y = j * ROW + ROW / 2;
      const v = y / band;
      const off = j % 2 ? PITCH / 2 : 0;
      for (let x = off - PITCH; x < w + PITCH; x += PITCH) {
        const cv = coverage(v, x);
        if (cv < 0.02) continue;
        const r = Math.min(PITCH * 0.66, Math.sqrt((cv * cell) / Math.PI));
        c.moveTo(x + r, y);
        c.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    c.fill();
    c.fillRect(0, band - 3, w, 3);
  }

  const api: Dither = {
    get band() {
      return band;
    },
    measure() {
      vh = innerHeight;
      band = Math.round(vh * BAND);
      el.style.setProperty('--sd-h', `${band}px`);
      draw();
      last = NaN;
    },
    set(f: number) {
      const y = Math.round(f * vh * 2) / 2;
      if (y === last) return;
      last = y;
      front.style.transform = `translate3d(0, ${y}px, 0)`;
      el.style.visibility = y >= vh ? 'hidden' : 'visible';
    },
  };
  api.measure();
  api.set(1.05);
  return api;
}
