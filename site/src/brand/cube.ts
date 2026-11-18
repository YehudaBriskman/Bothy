/**
 * The BothyBox mark: the Cube icon (an isometric box, a B on each visible side, an amber lid) and the drawn
 * "BothyBox" wordmark. Chosen by the owner on 2026-11-18 from the gallery in public/brand-mock/ (concept "Cube",
 * loader "Cube"; docs/plans/thin-bothy/brand-options.md). Every shape is a hand-built geometric path ported from
 * public/brand-mock/concepts.js: no font is converted or embedded, so no font licence applies.
 *
 * One source for every use: the header and footer lockup (components/Brand.tsx), the first-visit splash
 * (brand/splash.ts), and the favicon, home-screen icons and share cards (scripts/og.mjs). Plain strings and numbers,
 * no DOM, so Node can import it too.
 *
 * Units. The wordmark is drawn on a cap height of 100 (baseline y = 100, descender to y = 126). The icon is drawn on a
 * 64 x 64 grid. The horizontal lockup sets the icon 1.2 x cap height (120) with a gap of 0.36 x cap height (36).
 */

export const INK = '#09090c';
export const PAPER = '#f3f2ee';
export const AMBER = '#ffd58a'; // the lit window, the site's focus colour

const f = (n: number) => +n.toFixed(2);

/** A geometric B: square left corners, two half-round bowls (the upper one narrower), counters cut with evenodd. */
export function bPath(x: number, y: number, w: number, h: number, s: number, b: number): string {
  const ym = y + h * 0.46;
  const wu = w * 0.92;
  const ru = (ym - y) / 2;
  const rl = (y + h - ym) / 2;
  let d =
    `M${f(x)} ${f(y)}H${f(x + wu - ru)}A${f(ru)} ${f(ru)} 0 0 1 ${f(x + wu - ru)} ${f(ym)}` +
    `H${f(x + w - rl)}A${f(rl)} ${f(rl)} 0 0 1 ${f(x + w - rl)} ${f(y + h)}H${f(x)}Z`;
  const cu0 = y + b;
  const cu1 = ym - b / 2;
  const riu = (cu1 - cu0) / 2;
  const cxu = Math.max(x + s, x + wu - s - riu);
  d += `M${f(x + s)} ${f(cu0)}H${f(cxu)}A${f(riu)} ${f(riu)} 0 0 1 ${f(cxu)} ${f(cu1)}H${f(x + s)}Z`;
  const cl0 = ym + b / 2;
  const cl1 = y + h - b;
  const ril = (cl1 - cl0) / 2;
  const cxl = Math.max(x + s, x + w - s - ril);
  d += `M${f(x + s)} ${f(cl0)}H${f(cxl)}A${f(ril)} ${f(ril)} 0 0 1 ${f(cxl)} ${f(cl1)}H${f(x + s)}Z`;
  return d;
}

/** The six letters "BothyBox" needs, cap height 100, each with its advance width. */
export const GLYPHS: Record<'B' | 'o' | 't' | 'h' | 'y' | 'x', { w: number; d: string }> = {
  B: { w: 72, d: bPath(0, 0, 72, 100, 22, 18) },
  o: { w: 72, d: 'M0 64A36 37 0 1 0 72 64A36 37 0 1 0 0 64ZM22 64A14 19 0 1 1 50 64A14 19 0 1 1 22 64Z' },
  t: { w: 46, d: 'M8 8H30V28H45V45H30V75C30 80.5 32.5 83 38 83H45V100H33C17 100 8 92 8 77V45H0V28H8Z' },
  h: {
    w: 68,
    d: 'M0 0H22V37C27 30.5 34.5 27 44 27C59.5 27 68 37 68 54V100H46V58.5C46 50 42.5 46 36 46C27.5 46 22 52 22 61V100H0Z',
  },
  y: {
    w: 72,
    d: 'M0 28H23L36.5 71L50 28H72L44 106C39.5 119.5 32 126 18 126H8V108H16C21.5 108 23.5 106 25.5 101.5L27 98Z',
  },
  x: { w: 72, d: 'M1 28H25L36 46.5L47 28H71L49 63L72 100H48L36 79.5L24 100H0L23 63Z' },
};

/** Each letter of "BothyBox" with the gap before it (the kerning, set by eye). */
const WORD: [keyof typeof GLYPHS, number][] = [
  ['B', 0],
  ['o', 3],
  ['t', 1],
  ['h', 2],
  ['y', 0],
  ['B', 6],
  ['o', 3],
  ['x', 1],
];

export interface Letter {
  ch: keyof typeof GLYPHS;
  x: number;
  w: number;
  d: string;
  i: number;
}

/** The letters of "BothyBox" placed on one baseline, and the word's advance width (562). */
export function layoutWord(): { letters: Letter[]; width: number } {
  let x = 0;
  const letters: Letter[] = WORD.map(([ch, gap], i) => {
    x += gap;
    const l = { ch, x, w: GLYPHS[ch].w, d: GLYPHS[ch].d, i };
    x += GLYPHS[ch].w;
    return l;
  });
  return { letters, width: x };
}

/** The wordmark as paths (no <svg>), cap height 100. */
export const wordmarkPaths = (): string =>
  layoutWord()
    .letters.map((l) => `<path transform="translate(${l.x} 0)" d="${l.d}"/>`)
    .join('');

// ── The Cube icon, 64 grid ────────────────────────────────────────────────────────────────────────────────────────
/** The lid: the top rhombus. */
export const CUBE_LID = 'M32 6L56 18L32 30L8 18Z';
/** The left (lit) face and the right (shaded) face. */
export const CUBE_LEFT = 'M8 18L32 30V58L8 46Z';
export const CUBE_RIGHT = 'M32 30L56 18V46L32 58Z';
const CUBE_B = bPath(4, 4, 15, 21, 5, 3.6);

/**
 * The icon's markup inside a 64 x 64 viewBox. `id` must be unique in the document (the Bs are cut out of the faces
 * with a mask, so they show whatever is behind the icon). `lid` is the accent; with lid === fg the lid is drawn at
 * 45 % so the icon still reads in one colour. `lidClass` names the lid's path (the header's hover wiggle moves it).
 */
export function cubeBody(o: { fg: string; lid: string; id: string; lidClass?: string }): string {
  const mono = o.lid === o.fg;
  const cls = o.lidClass ? ` class="${o.lidClass}"` : '';
  return (
    `<mask id="${o.id}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">` +
    `<rect width="64" height="64" fill="#fff"/>` +
    `<path fill="#000" fill-rule="evenodd" transform="matrix(1 .5 0 1 8 18)" d="${CUBE_B}"/>` +
    `<path fill="#000" fill-rule="evenodd" transform="matrix(1 -.5 0 1 32 30)" d="${CUBE_B}"/></mask>` +
    `<g mask="url(#${o.id})"><path fill="${o.fg}" d="${CUBE_LEFT}"/>` +
    `<path fill="${o.fg}" opacity=".72" d="${CUBE_RIGHT}"/></g>` +
    `<path${cls} fill="${o.lid}"${mono ? ' opacity=".45"' : ''} d="${CUBE_LID}"/>`
  );
}

/**
 * The icon as a standalone SVG file.
 *   'favicon'  ink rounded tile, paper faces, amber lid; in a dark browser theme a faint paper rim keeps the tile's
 *              edge visible on a dark tab strip.
 *   'full'     full-bleed ink square, the cube at 80 %: the apple-touch-icon (iOS rounds the corners itself) and the
 *              manifest icons.
 */
export function iconSVG(mode: 'favicon' | 'full'): string {
  const open = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">';
  const body = cubeBody({ fg: PAPER, lid: AMBER, id: 'bb' });
  if (mode === 'full')
    return `${open}<rect width="64" height="64" fill="${INK}"/><g transform="translate(6.4 6.4) scale(.8)">${body}</g></svg>`;
  return (
    `${open}<style>.rim{stroke:none}@media (prefers-color-scheme:dark){.rim{stroke:${PAPER};stroke-opacity:.22}}</style>` +
    `<rect class="rim" x=".75" y=".75" width="62.5" height="62.5" rx="13.25" fill="${INK}" stroke-width="1.5"/>${body}</svg>`
  );
}

// ── The horizontal lockup ─────────────────────────────────────────────────────────────────────────────────────────
/** Icon 1.2 x cap height, gap 0.36 x cap height, then the word. Its own box in cap units: x 0..718, y -10..126. */
export const LOCKUP = { icon: 120, gap: 36, top: -10, height: 136 } as const;
export const LOCKUP_WIDTH = LOCKUP.icon + LOCKUP.gap + layoutWord().width;
export const LOCKUP_VIEWBOX = `0 ${LOCKUP.top} ${LOCKUP_WIDTH} ${LOCKUP.height}`;

/**
 * The lockup's inner markup for a viewBox of LOCKUP_VIEWBOX: the icon (wrapped in `iconClass` when given) and the
 * word. Faces and word take `fg` (use 'currentColor' in the page).
 */
export function lockupInner(o: { fg: string; lid: string; id: string; iconClass?: string; lidClass?: string }): string {
  const cls = o.iconClass ? ` class="${o.iconClass}"` : '';
  return (
    `<g${cls} transform="translate(0 ${LOCKUP.top}) scale(${LOCKUP.icon / 64})">${cubeBody(o)}</g>` +
    `<g transform="translate(${LOCKUP.icon + LOCKUP.gap} 0)" fill="${o.fg}" fill-rule="evenodd">${wordmarkPaths()}</g>`
  );
}
