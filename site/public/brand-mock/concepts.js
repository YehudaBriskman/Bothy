// BothyBox brand exploration: every mark on this page is a hand-built geometric path, written here. No font is
// converted, embedded or requested, so there is no font licence to honour. The same module is imported by the gallery
// (in the browser) and by export.mjs (in Node) so the SVG files in svg/ are byte-identical to what the gallery shows.
//
// Units. The wordmark is drawn on a cap height of 100 (baseline y = 100, x-height top y = 28, descender to y = 126).
// Every icon is drawn on a 64 x 64 grid, so at 16 px one unit is a quarter pixel and an 8-unit stem is 2 px.

export const INK = '#09090c';
export const PAPER = '#f3f2ee';
export const AMBER = '#ffd58a'; // the lit window, the site's focus colour

// ── The B ────────────────────────────────────────────────────────────────────────────────────────────────────────
// A geometric B: square left corners, two bowls that are true half-rounds, the upper bowl narrower than the lower one
// (as in a grotesk), counters cut with evenodd. s = stem width, b = horizontal bar thickness.
export function bPath(x, y, w, h, s, b, o = {}) {
  const split = o.split ?? 0.46;
  const wu = w * (o.upper ?? 0.92);
  const sb = o.bowl ?? s; // bowl thickness on the right
  const ym = y + h * split;
  const ru = (ym - y) / 2;
  const rl = (y + h - ym) / 2;
  const f = (n) => +n.toFixed(2);
  let d =
    `M${f(x)} ${f(y)}H${f(x + wu - ru)}A${f(ru)} ${f(ru)} 0 0 1 ${f(x + wu - ru)} ${f(ym)}` +
    `H${f(x + w - rl)}A${f(rl)} ${f(rl)} 0 0 1 ${f(x + w - rl)} ${f(y + h)}H${f(x)}Z`;
  const cu0 = y + b;
  const cu1 = ym - b / 2;
  const riu = (cu1 - cu0) / 2;
  const cxu = Math.max(x + s, x + wu - sb - riu);
  d += `M${f(x + s)} ${f(cu0)}H${f(cxu)}A${f(riu)} ${f(riu)} 0 0 1 ${f(cxu)} ${f(cu1)}H${f(x + s)}Z`;
  const cl0 = ym + b / 2;
  const cl1 = y + h - b;
  const ril = (cl1 - cl0) / 2;
  const cxl = Math.max(x + s, x + w - sb - ril);
  d += `M${f(x + s)} ${f(cl0)}H${f(cxl)}A${f(ril)} ${f(ril)} 0 0 1 ${f(cxl)} ${f(cl1)}H${f(x + s)}Z`;
  return d;
}

// ── The wordmark glyphs (cap height 100) ────────────────────────────────────────────────────────────────────────
// Heavy, tight, geometric: vertical stems 22, horizontals 18. Each glyph has an advance width; kerning is the
// `gap` before it. Only the six letters BothyBox needs are drawn.
export const GLYPHS = {
  B: { w: 72, d: bPath(0, 0, 72, 100, 22, 18) },
  o: {
    w: 72,
    d: 'M0 64A36 37 0 1 0 72 64A36 37 0 1 0 0 64ZM22 64A14 19 0 1 1 50 64A14 19 0 1 1 22 64Z',
  },
  t: {
    w: 46,
    d: 'M8 8H30V28H45V45H30V75C30 80.5 32.5 83 38 83H45V100H33C17 100 8 92 8 77V45H0V28H8Z',
  },
  h: {
    w: 68,
    d: 'M0 0H22V37C27 30.5 34.5 27 44 27C59.5 27 68 37 68 54V100H46V58.5C46 50 42.5 46 36 46C27.5 46 22 52 22 61V100H0Z',
  },
  y: {
    w: 72,
    d: 'M0 28H23L36.5 71L50 28H72L44 106C39.5 119.5 32 126 18 126H8V108H16C21.5 108 23.5 106 25.5 101.5L27 98Z',
  },
  x: {
    w: 72,
    d: 'M1 28H25L36 46.5L47 28H71L49 63L72 100H48L36 79.5L24 100H0L23 63Z',
  },
};

// letter, gap before it (negative tightens)
const WORD = [
  ['B', 0],
  ['o', 3],
  ['t', 1],
  ['h', 2],
  ['y', 0],
  ['B', 6],
  ['o', 3],
  ['x', 1],
];

/** Letters of "BothyBox" placed on one baseline: [{ch, x, w, d, i}] plus the total width. */
export function layoutWord() {
  let x = 0;
  const out = [];
  WORD.forEach(([ch, gap], i) => {
    x += gap;
    out.push({ ch, x, w: GLYPHS[ch].w, d: GLYPHS[ch].d, i });
    x += GLYPHS[ch].w;
  });
  return { letters: out, width: x };
}

export function wordmarkSVG({ fill = 'currentColor', title = 'BothyBox' } = {}) {
  const { letters, width } = layoutWord();
  const paths = letters.map((l) => `<path transform="translate(${l.x} 0)" d="${l.d}"/>`).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -2 ${width} 130" role="img" aria-label="${title}">` +
    `<g fill="${fill}" fill-rule="evenodd">${paths}</g></svg>`
  );
}

// ── Icon concepts (64 grid) ─────────────────────────────────────────────────────────────────────────────────────
// body(c) returns the glyph markup; c = { fg, bg, accent, uid }. `bg` is what knock-outs are painted with (the tile
// colour when on a tile). A concept never relies on the accent: with accent = fg it must still read.
let seq = 0;
const uid = () => `bm${(seq += 1)}`;

const mirror = (inner) => `<g transform="translate(64 0) scale(-1 1)">${inner}</g>`;

export const CONCEPTS = [
  {
    id: 'pair',
    name: 'Pair',
    line: 'Two heavy Bs, side by side, on an ink tile.',
    why: 'The plainest reading of BothyBox. Strong at 32 px and up; at 16 px the four counters are under 2 px each.',
    body: (c) =>
      `<path fill="${c.fg}" fill-rule="evenodd" d="${bPath(8, 15, 22, 34, 7.5, 6)}"/>` +
      `<path fill="${c.fg}" fill-rule="evenodd" d="${bPath(34, 15, 22, 34, 7.5, 6)}"/>`,
  },
  {
    id: 'facing',
    name: 'Facing',
    line: 'A B and its mirror, bowls meeting: together they close into a box.',
    why: 'The outline is a box made of two Bs; the seam in the middle is where it opens. Symmetry makes it calm and ownable.',
    body: (c) => {
      const d = bPath(6, 13, 26, 38, 8, 6.5, { upper: 0.94 });
      return (
        `<path fill="${c.fg}" fill-rule="evenodd" d="${d}"/>` +
        mirror(`<path fill="${c.fg}" fill-rule="evenodd" d="${d}"/>`)
      );
    },
  },
  {
    id: 'backtoback',
    name: 'Back to back',
    line: 'Two Bs sharing one stem, bowls out: a mirrored BB.',
    why: 'Very compact and symmetric. Reads as a bow or a butterfly before it reads as BB, which is the risk.',
    body: (c) => {
      const d = bPath(28, 12, 28, 40, 8, 6.5);
      return (
        `<path fill="${c.fg}" fill-rule="evenodd" d="${d}"/>` +
        mirror(`<path fill="${c.fg}" fill-rule="evenodd" d="${d}"/>`)
      );
    },
  },
  {
    id: 'hut',
    name: 'Bothy B',
    line: 'A B with a pitched roof: the upper counter is the window, the lower bowl the hut.',
    why: "Says bothy (a shelter) and B at once. The window can be lit amber, the site's one warm colour; in one ink it still reads.",
    body: (c) =>
      `<path fill="${c.fg}" fill-rule="evenodd" d="M11 56V24L26.5 8.5L42 24V31L39.5 33.5H43A11.25 11.25 0 0 1 43 56ZM19.5 20.5H30.5V29H19.5ZM19.5 36H39.75A6.5 6.5 0 0 1 39.75 49H19.5Z"/>` +
      (c.accent !== c.fg ? `<path fill="${c.accent}" d="M19.5 20.5H30.5V29H19.5Z"/>` : ''),
  },
  {
    id: 'crate',
    name: 'Crate',
    line: 'A B in a box whose lid is lifted on its hinge.',
    why: 'The box opening is the mark itself, so the loader is just this icon moving. The thin outline is fragile at 16 px.',
    body: (c) =>
      `<path fill="${c.fg}" fill-rule="evenodd" d="M9 19H55V58H9ZM14.5 24.5V52.5H49.5V24.5Z"/>` +
      `<path fill="${c.fg}" transform="rotate(-14 9 16)" d="M9 10.5H55V16H9Z"/>` +
      `<path fill="${c.fg}" fill-rule="evenodd" d="${bPath(22.5, 28, 19, 21, 6, 4.5)}"/>`,
  },
  {
    id: 'iso',
    name: 'Cube',
    line: 'An isometric box, one B on each visible side.',
    why: 'Literally BothyBox. Rich at 180 px and on the splash; the sheared Bs blur into texture at 16 px.',
    body: (c) => {
      const id = uid();
      const bL = bPath(4, 4, 15, 21, 5, 3.6);
      return (
        `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">` +
        `<rect width="64" height="64" fill="#fff"/>` +
        `<path fill="#000" fill-rule="evenodd" transform="matrix(1 .5 0 1 8 18)" d="${bL}"/>` +
        `<path fill="#000" fill-rule="evenodd" transform="matrix(1 -.5 0 1 32 30)" d="${bL}"/></mask>` +
        `<g mask="url(#${id})">` +
        `<path fill="${c.fg}" d="M8 18L32 30V58L8 46Z"/>` +
        `<path fill="${c.fg}" opacity=".72" d="M32 30L56 18V46L32 58Z"/></g>` +
        `<path fill="${c.accent === c.fg ? c.fg : c.accent}" opacity="${c.accent === c.fg ? '.45' : '1'}" d="M32 6L56 18L32 30L8 18Z"/>`
      );
    },
  },
  {
    id: 'open',
    name: 'Open box',
    line: 'A carton with its two flaps thrown open and two Bs rising out of it.',
    why: "The loader's middle frame as a still. Tells the story, but box, flaps and two Bs is a lot to ask of 16 px.",
    body: (c) => {
      const id = uid();
      return (
        `<clipPath id="${id}"><path d="M0 0H64V33H0Z"/></clipPath>` +
        `<g clip-path="url(#${id})" fill="${c.fg}" fill-rule="evenodd">` +
        `<path d="${bPath(14, 6, 17, 29, 6, 4.5)}"/><path d="${bPath(33, 6, 17, 29, 6, 4.5)}"/></g>` +
        `<path fill="${c.fg}" d="M10 36H54V58H10Z"/>` +
        `<path fill="${c.fg}" opacity=".7" d="M10 36L1.5 27.5L5 24.5L14.5 36ZM54 36L62.5 27.5L59 24.5L49.5 36Z"/>`
      );
    },
  },
  {
    id: 'roof',
    name: 'Shelter',
    line: 'A roof over a pair of Bs: two letters under one shelter.',
    why: 'The warmest idea: a shelter for BB. The roof steals height, so the Bs shrink; weakest at 16 px.',
    body: (c) =>
      `<path fill="${c.fg}" d="M4 29.5L32 6L60 29.5V36L32 12.5L4 36Z"/>` +
      `<path fill="${c.fg}" fill-rule="evenodd" d="${bPath(12, 30, 18.5, 26, 6, 4.5)}"/>` +
      `<path fill="${c.fg}" fill-rule="evenodd" d="${bPath(33.5, 30, 18.5, 26, 6, 4.5)}"/>`,
  },
];

export const byId = (id) => CONCEPTS.find((c) => c.id === id);

/**
 * Icon + wordmark. layout 'h' (icon 1.2 x cap height, gap 0.36 x cap) or 'v' (icon 2 x cap, centred over the word).
 * Clear space is half the cap height round the mark's own box; `clear` draws it as a guide.
 */
export function lockupSVG(id, layout, { fill = PAPER, clear = false, standalone = false } = {}) {
  const c = byId(id);
  const { letters, width: ww } = layoutWord();
  const wm = `<g fill="${fill}">${letters.map((l) => `<path transform="translate(${l.x} 0)" d="${l.d}"/>`).join('')}</g>`;
  const icon = c.body({ fg: fill, bg: 'transparent', accent: fill === PAPER ? AMBER : fill });
  let inner;
  let box;
  if (layout === 'h') {
    inner = `<g transform="translate(0 -10) scale(${120 / 64})">${icon}</g><g transform="translate(156 0)">${wm}</g>`;
    box = { x: 0, y: -10, w: 156 + ww, h: 136 };
  } else {
    const iw = 200;
    inner = `<g transform="translate(${(ww - iw) / 2} -250) scale(${iw / 64})">${icon}</g>${wm}`;
    box = { x: 0, y: -250, w: ww, h: 376 };
  }
  const pad = 50;
  const vb = `${box.x - pad} ${box.y - pad} ${box.w + pad * 2} ${box.h + pad * 2}`;
  const guide = clear
    ? `<rect x="${box.x - pad}" y="${box.y - pad}" width="${box.w + 2 * pad}" height="${box.h + 2 * pad}" fill="none" stroke="${AMBER}" stroke-width="2" stroke-dasharray="8 6" opacity=".7"/>` +
      `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="none" stroke="${AMBER}" stroke-width="1.5" opacity=".35"/>` +
      `<text x="${box.x - pad + 8}" y="${box.y - pad + 30}" fill="${AMBER}" font-size="22" font-family="ui-monospace, monospace">1/2 cap</text>`
    : '';
  const ns = standalone ? ' xmlns="http://www.w3.org/2000/svg"' : '';
  return `<svg${ns} viewBox="${vb}" role="img" aria-label="BothyBox"><g fill-rule="evenodd">${inner}</g>${guide}</svg>`;
}

/**
 * One icon as a standalone SVG string.
 * mode: 'tile' (ink rounded square, paper glyph, amber accent), 'mono' (currentColor, no tile),
 *       'full' (full-bleed ink square for apple-touch-icon and OG), 'light' (paper tile, ink glyph).
 */
export function iconSVG(concept, mode = 'tile', { label } = {}) {
  const c = typeof concept === 'string' ? byId(concept) : concept;
  const aria = label ? ` role="img" aria-label="${label}"` : ' aria-hidden="true"';
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"${aria}>`;
  if (mode === 'mono')
    return `${open}${c.body({ fg: 'currentColor', bg: 'transparent', accent: 'currentColor' })}</svg>`;
  if (mode === 'light')
    return `${open}<rect width="64" height="64" rx="14" fill="${PAPER}"/>${c.body({ fg: INK, bg: PAPER, accent: INK })}</svg>`;
  if (mode === 'full')
    return `${open}<rect width="64" height="64" fill="${INK}"/><g transform="translate(6.4 6.4) scale(.8)">${c.body({ fg: PAPER, bg: INK, accent: AMBER })}</g></svg>`;
  return `${open}<rect width="64" height="64" rx="14" fill="${INK}"/>${c.body({ fg: PAPER, bg: INK, accent: AMBER })}</svg>`;
}
