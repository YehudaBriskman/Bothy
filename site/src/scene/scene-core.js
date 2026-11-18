// The hills, the mist and the bothy: pure functions, no DOM, no dependencies.
//
//   sceneMarkup()         the static SVG markup (seeded, deterministic, same bytes every call)
//   sceneVars(sample)     the colours for an hour, as CSS custom properties, from the sky hour table's sample()
//   windowGlow(sample)    0..1, how lit the bothy window is (the same number the CSS uses)
//
// Everything that changes with the hour is a CSS variable, so grading never rebuilds markup and the markup can be
// prerendered. The sample is whatever sky-keys.js `sample(hour)` returns (fields used: top, bot, haze, glow).
// Colours are atmospheric: the farthest ridge is nearly the horizon haze, each nearer ridge is darker and more of
// the ground colour. Keep this file byte-identical with public/scene-mock/scene-core.js (a test checks it).

export const VIEW_W = 1600;
export const VIEW_H = 700;
/** The bothy: x of its centre and the layer (index into LAYERS) whose ridge it stands on. */
export const HUT = { x: 905, layer: 2 };

/** Ridge layers, far to near. base: mean crest y (down); amp: height swing; f: base frequency; ridged: crag weight. */
export const LAYERS = [
  { seed: 11, base: 372, amp: 92, f: 0.0024, ridged: 0.34, k: 0.2 },
  { seed: 29, base: 430, amp: 92, f: 0.0032, ridged: 0.26, k: 0.45 },
  { seed: 47, base: 500, amp: 78, f: 0.0042, ridged: 0.16, k: 0.72 },
  { seed: 83, base: 604, amp: 60, f: 0.0058, ridged: 0.08, k: 0.93 },
];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Integer hash to [-1, 1]: deterministic lattice values. */
function lattice(i, seed) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** 1D value noise, quintic-smoothed, in [-1, 1]. */
function noise(x, seed) {
  const i = Math.floor(x);
  const t = x - i;
  const s = t * t * t * (t * (t * 6 - 15) + 10);
  return lerp(lattice(i, seed), lattice(i + 1, seed), s);
}

function fbm(x, seed, octaves) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x, seed + o * 101);
    norm += amp;
    x *= 2.07;
    amp *= 0.5;
  }
  return sum / norm;
}

// Highland profile: rounded tops (compress highs), longer concave flanks (stretch lows).
const shape = (v) => (v > 0 ? Math.pow(v, 0.85) : -Math.pow(-v, 1.25));

/** Crest height y (down) of a layer at x. Broad rounded masses, steeper flanks, crags on the far ridges. */
export function ridgeY(layer, x) {
  const L = LAYERS[layer];
  const mass = fbm(x * L.f * 0.45, L.seed, 2); // the big shoulders
  const body = fbm(x * L.f, L.seed + 7, 5); // the lumps
  const crag = 1 - Math.abs(noise(x * L.f * 3.1, L.seed + 19)) * 2; // sharp creases, -1..1
  const h = 0.75 * shape(mass * 1.5) + 0.45 * shape(body * 1.7) + L.ridged * crag * 0.5;
  let y = L.base - L.amp * h;
  if (layer === HUT.layer) {
    // The bothy's ground: a gentle bench, so the hut sits on something.
    const hutY = L.base - L.amp * (0.75 * shape(fbm(HUT.x * L.f * 0.45, L.seed, 2) * 1.5) + 0.2) + 6;
    y = lerp(y, hutY, 1 - smooth(34, 150, Math.abs(x - HUT.x)));
  }
  return y;
}

const r1 = (v) => Math.round(v * 10) / 10;

/** SVG path data for one layer's silhouette, closed along the bottom. */
export function ridgePath(layer) {
  const pts = [];
  for (let x = -80; x <= VIEW_W + 80; x += 8) pts.push(`${r1(x)} ${r1(ridgeY(layer, x))}`);
  return `M${pts.join('L')}L${VIEW_W + 80} ${VIEW_H + 20}L-80 ${VIEW_H + 20}Z`;
}

/** The blobs of one mist band, tiled across two widths so the drift loops seamlessly. */
function mistBlobs(seed, y, ry, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const cx = ((i + 0.5 + lattice(i, seed) * 0.35) / count) * VIEW_W;
    const rx = 150 + (lattice(i, seed + 3) + 1) * 130;
    const cy = y + lattice(i, seed + 5) * ry * 0.5;
    const h = ry * (0.6 + (lattice(i, seed + 9) + 1) * 0.4);
    for (const dx of [0, VIEW_W]) {
      out.push(`<ellipse cx="${r1(cx + dx)}" cy="${r1(cy)}" rx="${r1(rx)}" ry="${r1(h)}"/>`);
    }
  }
  return out.join('');
}

const mist = (n, y, ry, count, dur, delay) =>
  `<svg class="scene-mist scene-mist-${n}" viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><g class="scene-mist-drift" style="--dur:${dur}s;--delay:${delay}s" fill="url(#sc-mist)">${mistBlobs(
    n * 17 + 5,
    y,
    ry,
    count,
  )}</g></svg>`;

/** The bothy, drawn with its base centre at (0, 0); y is up-negative. Stone, slate, one window. */
function bothy(y) {
  const courses = [];
  for (let row = 0; row < 6; row++) {
    const cy = -5.6 * (row + 1);
    courses.push(`<path d="M-34 ${r1(cy)}H34"/>`);
    for (let i = 0; i < 5; i++) {
      const x = -30 + i * 13 + (row % 2) * 6 + lattice(row * 7 + i, 5) * 2;
      courses.push(`<path d="M${r1(x)} ${r1(cy)}v-5.6"/>`);
    }
  }
  return `<g class="scene-bothy" transform="translate(${HUT.x} ${r1(y)}) scale(0.8)">
<ellipse class="scene-spill" cx="14" cy="2" rx="50" ry="6" fill="url(#sc-halo)"/>
<path class="scene-wall" d="M-34 0V-33H34V0Z"/>
<g class="scene-courses">${courses.join('')}</g>
<path class="scene-gable-shade" d="M10 -33H34V0H10Z"/>
<path class="scene-roof" d="M-41 -31L0 -62L41 -31Z"/>
<path class="scene-roof-lit" d="M0 -62L41 -31H33Z"/>
<path class="scene-chimney" d="M15 -52V-70H25V-46Z"/>
<path class="scene-door" d="M-21 0V-24Q-14.5 -29 -8 -24V0Z"/>
<rect class="scene-glass" x="8" y="-25" width="16" height="12" rx="0.6"/>
<rect class="scene-glow-core" x="8" y="-25" width="16" height="12" rx="0.6"/>
<path class="scene-mullion" d="M16 -25V-13M8 -19H24"/>
<circle class="scene-halo" cx="16" cy="-19" r="62" fill="url(#sc-halo)"/>
<g class="scene-smoke"><circle cx="20" cy="-72" r="4"/><circle cx="20" cy="-72" r="5"/><circle cx="20" cy="-72" r="4.5"/></g>
</g>`;
}

/** The whole scene as one static string. */
export function sceneMarkup() {
  const layers = LAYERS.map((_, i) => {
    const hut = i === HUT.layer ? bothy(ridgeY(i, HUT.x)) : '';
    return `<svg class="scene-ridge scene-ridge-${i}" viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><g filter="url(#sc-grain)"><path fill="url(#sc-g${i})" d="${ridgePath(i)}"/></g>${hut}</svg>`;
  });
  const grads = LAYERS.map((L, i) => {
    const top = L.base - L.amp * 1.1;
    return `<linearGradient id="sc-g${i}" gradientUnits="userSpaceOnUse" x1="0" y1="${r1(top)}" x2="0" y2="${VIEW_H}"><stop offset="0" style="stop-color:var(--r${i})"/><stop offset="0.14" style="stop-color:var(--c${i})"/><stop offset="0.62" style="stop-color:var(--c${i})"/><stop offset="1" style="stop-color:var(--f${i})"/></linearGradient>`;
  }).join('');
  const defs = `<svg class="scene-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>${grads}
<radialGradient id="sc-mist"><stop offset="0" style="stop-color:var(--mist)" stop-opacity="1"/><stop offset="0.55" style="stop-color:var(--mist)" stop-opacity="0.45"/><stop offset="1" style="stop-color:var(--mist)" stop-opacity="0"/></radialGradient>
<radialGradient id="sc-halo"><stop offset="0" stop-color="rgb(255,176,84)" stop-opacity="0.85"/><stop offset="0.25" stop-color="rgb(255,150,60)" stop-opacity="0.32"/><stop offset="1" stop-color="rgb(255,130,50)" stop-opacity="0"/></radialGradient>
<filter id="sc-grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="4" result="n"/><feColorMatrix in="n" type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 0.2" result="g"/><feTurbulence type="fractalNoise" baseFrequency="0.011 0.045" numOctaves="3" seed="9" result="m"/><feColorMatrix in="m" type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 0.13" result="m2"/><feBlend in="m2" in2="SourceGraphic" mode="soft-light" result="a"/><feBlend in="g" in2="a" mode="soft-light" result="b"/><feComposite in="b" in2="SourceAlpha" operator="in"/></filter></defs></svg>`;
  return `${defs}${layers[0]}${mist(0, 440, 34, 5, 190, 0)}${layers[1]}${mist(1, 525, 40, 5, 150, -60)}${layers[2]}${mist(2, 615, 46, 4, 120, -30)}${layers[3]}`;
}

// ---- grading ------------------------------------------------------------------------------------------------

const mix = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const css = (c) => `rgb(${c.map((v) => Math.round(Math.min(255, Math.max(0, v)))).join(',')})`;
const desat = (c, t) => mix(c, [lum(c) * 255, lum(c) * 255, lum(c) * 255], t);
const scale = (c, k) => c.map((v) => v * k);
const num = (v) => String(Math.round(v * 100) / 100);

/** 0..1: how lit the window is. Off by day (a hint remains), full at night, rising through sunset and dusk. */
export function windowGlow(sample) {
  return 0.08 + 0.92 * (1 - smooth(0.22, 0.62, lum(sample.bot)));
}

/** CSS custom properties for the hour, as a plain object (name to value). */
export function sceneVars(sample) {
  const top = sample.top;
  const bot = sample.bot;
  const light = clamp01(lum(bot) * 1.15); // 0 night .. 1 day
  // Air colour at the horizon: the sky's bottom, drawn a little toward its top and calmed so it reads as haze, not fire.
  const dark = 1 - light;
  // At night the horizon haze is lifted a little (starlight on the air) so the ridges still separate from one another.
  const air = desat(mix(bot, top, 0.5), 0.2).map((v, i) => v * (1 + 0.7 * dark) + dark * [10, 14, 26][i]);
  // Ground: peat and heather, bluer at night, a touch of green by day.
  const ground = mix([6, 8, 13], [46, 52, 46], light);
  const sun = [sample.glow[0] * 255, sample.glow[1] * 255, sample.glow[2] * 255];
  const vars = {};
  LAYERS.forEach((L, i) => {
    const far = i / 3;
    const c = scale(mix(air, mix(ground, top, 0.12), L.k), lerp(0.97, 0.9, far));
    // Crest light: the sun's colour on the top edge, strongest near sunrise and sunset, absent at night.
    const rimAmt = clamp01(sample.glow[3] * 1.15) * lerp(0.55, 0.25, far) * smooth(0.12, 0.3, lum(bot)) + dark * 0.12;
    vars[`--c${i}`] = css(c);
    vars[`--r${i}`] = css(mix(c, mix(sun, air, 0.25), rimAmt));
    // Valley mist pools in the foot of every ridge, more in the far ones.
    vars[`--f${i}`] = css(mix(c, air, lerp(0.55, 0.12, far)));
  });
  vars['--mist'] = css(mix(air, [255, 255, 255], 0.18 * light));
  vars['--mist-a'] = num(clamp01(0.16 + sample.haze[3] * 0.5));
  const wall = mix(ground, air, 0.25 + 0.2 * light);
  vars['--hut-wall'] = css(scale(wall, 0.85));
  vars['--hut-shade'] = css(scale(wall, 0.6));
  vars['--hut-roof'] = css(scale(mix(ground, top, 0.2), 0.62));
  vars['--hut-roof-lit'] = css(scale(mix(mix(ground, top, 0.2), sun, clamp01(0.66 * sample.glow[3])), 0.9));
  vars['--hut-door'] = css(scale(ground, 0.45));
  const g = windowGlow(sample);
  vars['--win'] = num(g);
  vars['--glass'] = css(mix(mix(ground, air, 0.5), [255, 196, 112], g));
  vars['--smoke'] = css(mix(air, [255, 255, 255], 0.1));
  vars['--smoke-a'] = num(clamp01(0.1 + 0.3 * (1 - light)));
  return vars;
}
