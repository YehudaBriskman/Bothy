// The Bothy mark is drawn twice, on purpose. This is what stops the two copies
// from becoming two logos.
//
// ── why this exists ──────────────────────────────────────────────────────────
//
// On 2026-10-07 the repo held two different marks and four statements that it
// held one:
//
//   · public/favicon.svg and public/icon-maskable.svg are a SOLID silhouette,
//     door arch radius 3, in three hard colours. Every shipped PNG is one of
//     these two, which was established by decoding them - not by reading a
//     comment.
//   · components/Brand.tsx is a 2px currentColor OUTLINE, door arch radius 1.85,
//     a different roof pitch and different walls.
//   · favicon.svg's own comment said the generator read it. index.html said all
//     the icons came from one set of coordinates. Brand.tsx said its geometry
//     was duplicated in two places "generated from the same numbers".
//     docs/brand/foundations/logo-and-app-icons.md said it lived in exactly
//     three, all from the same numbers.
//   · and apps/bothy-web/web/scripts/gen-icons.py - since deleted - held a
//     FOURTH copy, the outline one, and wrote three of the four shipped
//     filenames. Running it would have replaced three live icons with a
//     different logo.
//
// None of that is visible in a diff and none of it is visible in the app: the
// app does not render a favicon, and nothing renders the PNGs at all. It is only
// visible to somebody who decodes the files, which is what this does.
//
// ── what it holds ────────────────────────────────────────────────────────────
//
// Two renderings of one mark is a legitimate answer - a 2px stroke fills in at
// 16px, and a filled mark cannot inherit `currentColor` for a watermark that has
// to work on seven themes. An UNDECLARED difference is not. So:
//
//   1. SHARED. Both renderings must agree on the canvas, the apex, left-right
//      symmetry, a door centred on the mark and standing on the ground, a
//      semicircular arch, and exactly one accent element.
//   2. DECLARED. Every way in which they differ is pinned below to the value it
//      has today, with the same numbers as the table in
//      docs/brand/foundations/logo-and-app-icons.md. Move a coordinate in either
//      file and this fails until that table is updated too - which is the point:
//      the cost of changing the mark should be writing down that you changed it.
//   3. DERIVED. icon-maskable.svg's paths must be favicon.svg's, character for
//      character, under one transform; and each committed PNG is decoded and its
//      ink and accent bounding boxes compared with what its source SVG predicts.
//      That is what catches a hand-edited or stale raster, and it is a stronger
//      claim than "re-run the generator and diff the bytes" - which needs a
//      browser, takes a minute, and had never once been run.
//   4. SINGULAR. No file outside the three may carry the mark's coordinates.
//      This is the one that would have caught the deleted generator.
//
// Everything here reads the source tree. No build, no browser, no network.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const PUBLIC = join(WEB, 'public');
const SRC = join(WEB, 'src');
const REPO = join(HERE, '..', '..', '..');

let fails = 0;
const check = (label, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(54)} ${detail}`);
};
const eq = (label, got, want) =>
  check(label, same(got, want), same(got, want) ? `${fmt(got)}` : `got ${fmt(got)}, declared ${fmt(want)}`);
const fmt = (v) => (Array.isArray(v) ? `[${v.map(fmt).join(', ')}]` : String(v));
const same = (a, b) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((v, i) => same(v, b[i]))
    : typeof a === 'number' && typeof b === 'number'
      ? Math.abs(a - b) < 1e-9
      : a === b;

// ── reading the three files ──────────────────────────────────────────────────
//
// COMMENTS ARE STRIPPED FIRST, in every language here. A check that can be
// satisfied by a comment is a check that reads the prose about the code instead
// of the code, and this repo has shipped that mistake twice. It also means a
// mutation planted in a comment is a NO-OP rather than a false positive in
// scripts/checks/mutants.sh - so the rows there are anchored on markup and on
// executable lines, never on prose.
const stripXml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const favicon = stripXml(readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8'));
const maskable = stripXml(readFileSync(join(PUBLIC, 'icon-maskable.svg'), 'utf8'));
const brand = stripJs(readFileSync(join(SRC, 'components', 'Brand.tsx'), 'utf8'));
const indexCss = readFileSync(join(SRC, 'index.css'), 'utf8');

// ── a path parser for the subset these three files use ───────────────────────
//
// M L H V A Z, absolute and relative. Anything else throws rather than being
// skipped: a command this does not understand is a part of the mark it would
// silently stop measuring, which is the failure mode of every check above.
function parsePath(d) {
  const toks = d.match(/[MmLlHhVvAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  let i = 0, cx = 0, cy = 0, sx = 0, sy = 0, cmd = null;
  const pts = [], arcs = [];
  const num = () => {
    const t = toks[i++];
    if (t === undefined || !/^-?\d*\.?\d/.test(t)) throw new Error(`expected a number in "${d}"`);
    return parseFloat(t);
  };
  while (i < toks.length) {
    if (/^[A-Za-z]$/.test(toks[i])) cmd = toks[i++];
    if (cmd === null) throw new Error(`path does not start with a command: "${d}"`);
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M': {
        const x = num(), y = num();
        cx = rel ? cx + x : x; cy = rel ? cy + y : y; sx = cx; sy = cy;
        pts.push([cx, cy]);
        cmd = rel ? 'l' : 'L';           // an implicit lineto follows a moveto
        break;
      }
      case 'L': { const x = num(), y = num(); cx = rel ? cx + x : x; cy = rel ? cy + y : y; pts.push([cx, cy]); break; }
      case 'H': { const x = num(); cx = rel ? cx + x : x; pts.push([cx, cy]); break; }
      case 'V': { const y = num(); cy = rel ? cy + y : y; pts.push([cx, cy]); break; }
      case 'A': {
        const rx = num(), ry = num();
        num(); num(); num();             // x-rotation, large-arc, sweep
        const x = num(), y = num();
        const ex = rel ? cx + x : x, ey = rel ? cy + y : y;
        arcs.push({ rx, ry, from: [cx, cy], to: [ex, ey] });
        cx = ex; cy = ey; pts.push([cx, cy]);
        break;
      }
      case 'Z': { cx = sx; cy = sy; break; }
      default: throw new Error(`unsupported path command "${cmd}" in "${d}"`);
    }
  }
  return { pts, arcs };
}

// The extents of a path, arcs included. Both arcs in this mark are semicircular
// door heads with a horizontal chord, so the only point the vertex list misses
// is the crown - and missing it would under-measure the mark by a full radius.
function extents({ pts, arcs }) {
  const all = pts.slice();
  for (const a of arcs) {
    const mx = (a.from[0] + a.to[0]) / 2, my = (a.from[1] + a.to[1]) / 2;
    all.push([mx, my - a.rx], [mx, my + a.rx]);
  }
  return {
    x0: Math.min(...all.map((p) => p[0])), x1: Math.max(...all.map((p) => p[0])),
    y0: Math.min(...all.map((p) => p[1])), y1: Math.max(...all.map((p) => p[1])),
  };
}
const round = (n, k = 4) => Math.round(n * 10 ** k) / 10 ** k;

// ── the two renderings ───────────────────────────────────────────────────────
const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`)) || [])[1];
const paths = (s) => [...s.matchAll(/<path\b[^>]*>/g)].map((m) => m[0]);

const svgPaths = paths(favicon);
const hutD = attr(svgPaths[0], 'd');
const doorD = attr(svgPaths[1], 'd');

const brandPaths = paths(brand);
const outlineDs = brandPaths.filter((p) => !/className/.test(p)).map((p) => attr(p, 'd'));
const outDoorD = attr(brandPaths.find((p) => /className="brand-door"/.test(p)) || '', 'd');

const SIL = {
  name: 'silhouette (public/favicon.svg)',
  viewBox: attr(favicon.match(/<svg\b[^>]*>/)[0], 'viewBox'),
  structure: [parsePath(hutD)],
  door: parsePath(doorD),
};
const OUT = {
  name: 'outline (src/components/Brand.tsx)',
  viewBox: attr(brand.match(/<svg[\s\S]*?>/)[0], 'viewBox'),
  structure: outlineDs.map(parsePath),
  door: parsePath(outDoorD),
};

// ── 1. what both renderings must share ───────────────────────────────────────
//
// These are the mark. A change to any of them is a change of logo, not a change
// of rendering, and there is no value to declare it against - so they are
// asserted as equalities rather than pinned to a table.
console.log('── one mark: what both renderings must share ────────────');
for (const R of [SIL, OUT]) {
  const struct = R.structure.flatMap((p) => p.pts);
  const se = { x0: Math.min(...struct.map((p) => p[0])), x1: Math.max(...struct.map((p) => p[0])),
               y0: Math.min(...struct.map((p) => p[1])), y1: Math.max(...struct.map((p) => p[1])) };
  const de = extents(R.door);
  console.log(`\n  ${R.name}`);

  check('    the canvas is the 24-unit box', R.viewBox === '0 0 24 24', R.viewBox);

  // The apex. The one coordinate that is identical in both files, and the reason
  // the two drawings are recognisably the same hut.
  const apex = struct.filter((p) => Math.abs(p[1] - se.y0) < 1e-9);
  check('    the apex is exactly (12, 4.2)',
    apex.length === 1 && same(apex[0], [12, 4.2]), fmt(apex));

  // Symmetry about x=12, asserted on the coordinates rather than on a rendering:
  // a mark that is a pixel off-centre looks fine and sits wrong in every tile.
  const mirrored = (pts) => pts.every((p) => pts.some((q) => Math.abs(q[0] - (24 - p[0])) < 1e-9 && Math.abs(q[1] - p[1]) < 1e-9));
  check('    every path mirrors about x = 12',
    R.structure.every((p) => mirrored(p.pts)) && mirrored(R.door.pts), '');

  // The door is the mark's one idea - a hut you can walk into - so it is centred
  // on the mark and it stands on the ground rather than floating above it.
  check('    the door is centred on x = 12', round((de.x0 + de.x1) / 2) === 12, `${round(de.x0)} .. ${round(de.x1)}`);
  check('    the door stands on this rendering\'s ground line',
    round(de.y1) === round(se.y1), `door foot ${round(de.y1)}, walls ${round(se.y1)}`);
  // The uprights, not the eaves: the roof overhangs, so measuring the opening
  // against the roofline would let a door wider than the hut pass.
  const walls = [...new Set(struct.filter((p) => Math.abs(p[1] - se.y1) < 1e-9).map((p) => p[0]))].sort((a, b) => a - b);
  check('    the door is between the walls', de.x0 > walls[0] && de.x1 < walls[walls.length - 1],
    `${round(walls[0])} < ${round(de.x0)} .. ${round(de.x1)} < ${round(walls[walls.length - 1])}`);

  // A semicircular head, not an ellipse: rx === ry === half the opening. An
  // ellipse here reads as a rounded rectangle and the doorway stops being an arch.
  check('    there is exactly one arch', R.door.arcs.length === 1, `${R.door.arcs.length}`);
  const arc = R.door.arcs[0];
  const halfW = (de.x1 - de.x0) / 2;
  check('    the arch is a semicircle of half the door\'s width',
    arc && round(arc.rx) === round(arc.ry) && round(arc.rx) === round(halfW),
    arc ? `r ${arc.rx}/${arc.ry}, half-width ${round(halfW)}` : '');
}

// Exactly one accent element in each, and it is the door. Two coloured parts and
// the mark stops saying the one thing it says.
console.log();
check('the silhouette has exactly one accent fill',
  (favicon.match(/fill="#60a5fa"/g) || []).length === 1);
check('the outline has exactly one accent element',
  brandPaths.filter((p) => /className="brand-door"/.test(p)).length === 1);
check('the outline\'s accent comes from the token, not a literal',
  /\.brand-door\s*\{\s*fill:\s*var\(--accent\)\s*;?\s*\}/.test(indexCss));

// ── 2. the declared differences ──────────────────────────────────────────────
//
// The same numbers as the table in docs/brand/foundations/logo-and-app-icons.md.
// This block is the whole point of the check: these ARE allowed to differ, and
// they are not allowed to differ QUIETLY. Changing one here without changing the
// document leaves two tables disagreeing, which is what the next reader is owed
// a chance to notice.
console.log('\n── two renderings: every difference, declared ───────────');
const DECLARED = {
  silhouette: { eaves: [1.6, 10.6], walls: [5, 19], foot: 20.2, doorW: 6, arch: 3, springline: 17.2 },
  outline: { eaves: [2.4, 11.6], walls: [5.6, 18.4], foot: 20.4, doorW: 3.7, arch: 1.85, springline: 15.3 },
};
for (const [key, R] of [['silhouette', SIL], ['outline', OUT]]) {
  const want = DECLARED[key];
  const struct = R.structure.flatMap((p) => p.pts);
  const de = extents(R.door);
  const se = { x0: Math.min(...struct.map((p) => p[0])), y1: Math.max(...struct.map((p) => p[1])) };
  // The eave is the lowest-but-outermost structural point: the end of the roof.
  const eaveX = se.x0;
  const eaveY = Math.min(...struct.filter((p) => Math.abs(p[0] - eaveX) < 1e-9).map((p) => p[1]));
  // The walls are the uprights: the vertical extremes that are not the roof.
  const wallXs = [...new Set(struct.filter((p) => Math.abs(p[1] - se.y1) < 1e-9).map((p) => p[0]))].sort((a, b) => a - b);
  console.log(`\n  ${R.name}`);
  eq('    eaves', [round(eaveX), round(eaveY)], want.eaves);
  eq('    walls', [round(wallXs[0]), round(wallXs[wallXs.length - 1])], want.walls);
  eq('    ground line', round(se.y1), want.foot);
  eq('    door width', round(de.x1 - de.x0), want.doorW);
  eq('    arch radius', round(R.door.arcs[0].rx), want.arch);
  eq('    springline', round(R.door.arcs[0].from[1]), want.springline);
}

console.log();
// How each is painted. The silhouette carries no stroke at all, deliberately:
// lucide is a 2px-stroke set, so a filled mark is categorically not one of its
// glyphs - which is the cheapest reliable way to stop reading as `house`.
check('the silhouette is fill-only, no stroke anywhere', !/\bstroke\s*=/.test(favicon) && !/\bstroke:/.test(favicon));
check('the outline is a 2-unit stroke on no fill',
  /stroke="currentColor"/.test(brand) && /strokeWidth="2"/.test(brand) && /fill="none"/.test(brand));
check('the outline takes its colour from the theme, never a literal',
  !/#[0-9a-f]{3,8}\b/i.test(brand), 'currentColor + var(--accent)');

// The three literals in public/*.svg. They stay literals on purpose - these files
// are static assets, are never imported by the app, and a favicon sits on the tab
// strip where there is no theme to read. checks/stray-colour.mjs scans web/src
// only, so it never sees them; this is the assertion that takes its place.
const token = (n) => (indexCss.match(new RegExp(`--${n}:\\s*(#[0-9a-f]{6})`, 'i')) || [])[1];
console.log();
for (const [name, want] of [['bg', 'tile'], ['fg', 'ink'], ['accent', 'door']]) {
  const v = token(name);
  check(`the ${want} literal equals the dark palette's --${name}`,
    v && favicon.toLowerCase().includes(v.toLowerCase()) && maskable.toLowerCase().includes(v.toLowerCase()), v);
}

// ── 3. everything else is derived from favicon.svg ───────────────────────────
console.log('\n── the maskable variant is a copy under one transform ───');
const maskPaths = paths(maskable).map((p) => attr(p, 'd'));
check('the maskable holds favicon.svg\'s two paths, character for character',
  maskPaths.length === 2 && maskPaths[0] === hutD && maskPaths[1] === doorD);
const gTag = (maskable.match(/<g\b[^>]*>/) || [''])[0];
const tf = (attr(gTag, 'transform') || '').match(/translate\(\s*([\d.-]+)[ ,]+([\d.-]+)\s*\)\s*scale\(\s*([\d.-]+)\s*\)\s*translate\(\s*([\d.-]+)[ ,]+([\d.-]+)\s*\)/);
check('and exactly one scale-about-a-point transform', !!tf, attr(gTag, 'transform') || 'none');
const SCALE = tf ? parseFloat(tf[3]) : NaN;
const ORIGIN = tf ? [parseFloat(tf[1]), parseFloat(tf[2])] : [0, 0];
check('the transform is a pure scale about its own centre',
  tf && parseFloat(tf[4]) === -ORIGIN[0] && parseFloat(tf[5]) === -ORIGIN[1],
  tf ? `scale ${SCALE} about (${ORIGIN})` : '');
// Android crops to the centred circle of 80% diameter - radius 9.6 on this grid.
// At scale 1 the wall foot sits at 10.63 and the hut's feet are cut off on every
// circular launcher, which is the whole reason this file exists.
if (tf) {
  const far = Math.max(...SIL.structure.flatMap((p) => p.pts).map(([x, y]) => Math.hypot(x - ORIGIN[0], y - ORIGIN[1])));
  check('the scaled mark fits Android\'s 80% safe circle',
    far * SCALE <= 9.6, `furthest vertex ${round(far, 2)} x ${SCALE} = ${round(far * SCALE, 2)} of 9.6`);
}
check('the favicon tile is rounded and the maskable is full bleed',
  attr((favicon.match(/<rect\b[^>]*>/) || [''])[0], 'rx') === '5.4'
  && attr((maskable.match(/<rect\b[^>]*>/) || [''])[0], 'rx') === undefined);

// ── the committed rasters ────────────────────────────────────────────────────
//
// Decoded, not trusted. A PNG is the one artefact here that no reviewer can read
// and no diff can show, so it is the one most worth measuring - and "re-run the
// generator and compare bytes" cannot be the answer, because the generator needs
// a browser and a minute, so nobody runs it and the claim rots. Measuring the
// mark inside the file needs neither.
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let i = 8, idat = [], hdr = null;
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), tag = buf.toString('latin1', i + 4, i + 8);
    if (tag === 'IHDR') hdr = { w: buf.readUInt32BE(i + 8), h: buf.readUInt32BE(i + 12), depth: buf[i + 16], ctype: buf[i + 17], interlace: buf[i + 20] };
    if (tag === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  if (hdr.depth !== 8 || hdr.interlace !== 0) throw new Error(`unsupported PNG: depth ${hdr.depth}, interlace ${hdr.interlace}`);
  const nch = { 0: 1, 2: 3, 4: 2, 6: 4 }[hdr.ctype];
  if (!nch) throw new Error(`unsupported colour type ${hdr.ctype}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = hdr.w * nch, px = Buffer.alloc(hdr.h * stride);
  let p = 0, prev = Buffer.alloc(stride);
  for (let y = 0; y < hdr.h; y++) {
    const ft = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride)); p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= nch ? line[x - nch] : 0, b = prev[x], c = x >= nch ? prev[x - nch] : 0;
      if (ft === 1) line[x] = (line[x] + a) & 255;
      else if (ft === 2) line[x] = (line[x] + b) & 255;
      else if (ft === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else if (ft !== 0) throw new Error(`unknown filter ${ft}`);
    }
    line.copy(px, y * stride); prev = line;
  }
  return { ...hdr, nch, px, stride };
}

// A box around every pixel the predicate accepts. The predicates are deliberately
// loose - "clearly white", "clearly blue" - because an antialiased edge is a
// gradient, and a tight predicate would measure the threshold rather than the art.
function bbox(img, want) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = y * img.stride + x * img.nch;
      const a = img.nch === 4 ? img.px[i + 3] : 255;
      if (a < 128) continue;
      if (!want(img.px[i], img.px[i + 1], img.px[i + 2])) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1 };
}
const INK = (r, g, b) => r > 200 && g > 200 && b > 200;
const ACCENT = (r, g, b) => g > r + 20 && b > r + 20;

// (file, source, pixel size). The same table as scripts/gen-icons.py's JOBS and
// as the one in logo-and-app-icons.md - which is itself a thing worth checking,
// so it is checked below rather than just written down three times.
const RASTERS = [
  ['icon-192.png', 'favicon.svg', 192],
  ['icon-512.png', 'favicon.svg', 512],
  ['icon-maskable-512.png', 'icon-maskable.svg', 512],
  ['apple-touch-icon.png', 'icon-maskable.svg', 180],
];

// What each source predicts, in 24-unit space.
const map = (e, s, o) => ({ x0: o[0] + (e.x0 - o[0]) * s, x1: o[0] + (e.x1 - o[0]) * s,
                            y0: o[1] + (e.y0 - o[1]) * s, y1: o[1] + (e.y1 - o[1]) * s });
const hutE = extents(SIL.structure[0]), doorE = extents(SIL.door);
const PREDICT = {
  'favicon.svg': { ink: hutE, accent: doorE, rounded: true },
  'icon-maskable.svg': { ink: map(hutE, SCALE, ORIGIN), accent: map(doorE, SCALE, ORIGIN), rounded: false },
};

console.log('\n── every committed PNG still is that SVG ────────────────');
for (const [name, src, size] of RASTERS) {
  const f = join(PUBLIC, name);
  if (!existsSync(f)) { check(`${name} exists`, false, 'missing'); continue; }
  let img;
  try { img = decodePng(readFileSync(f)); }
  catch (e) { check(`${name} decodes`, false, e.message); continue; }
  const p = PREDICT[src];
  console.log(`\n  ${name}  <- ${src}   ${img.w}x${img.h}, colour type ${img.ctype}`);
  check('    the declared pixel size', img.w === size && img.h === size, `${img.w}x${img.h} of ${size}`);

  // A rounded source must leave its corner see-through, a full-bleed source must
  // paint it. apple-touch-icon.png is the one that got this wrong: it was the
  // rounded tile, so iOS rounded it a second time and the mark sat visibly inset.
  const corner = (() => { const i = 2 * img.stride + 2 * img.nch; return { a: img.nch === 4 ? img.px[i + 3] : 255, rgb: [img.px[i], img.px[i + 1], img.px[i + 2]] }; })();
  check(p.rounded ? '    the tile\'s corner is see-through' : '    the art is full bleed to the corner',
    p.rounded ? corner.a < 128 : corner.a === 255, `alpha ${corner.a}`);

  // Bounding boxes, in device pixels, against what the SVG says they should be.
  // TOLERANCE IS 2px, and it is about the measurement rather than about the art:
  // an antialiased edge reaches the predicate a fraction of a pixel inside the
  // geometry, and at 180px one 24-unit is 7.5px - so 2px is a quarter of a unit,
  // nowhere near enough to hide a moved coordinate and more than enough for a
  // renderer's edge rule.
  const TOL = 2;
  for (const [what, want, pred] of [['ink', p.ink, INK], ['accent', p.accent, ACCENT]]) {
    const got = bbox(img, pred);
    const px = (u) => (u * size) / 24;
    const d = [Math.abs(got.x0 - px(want.x0)), Math.abs(got.x1 + 1 - px(want.x1)),
               Math.abs(got.y0 - px(want.y0)), Math.abs(got.y1 + 1 - px(want.y1))];
    check(`    the ${what} sits where ${src} puts it`, Math.max(...d) <= TOL,
      `off by ${round(Math.max(...d), 2)}px of ${TOL} (box ${got.x0},${got.y0}..${got.x1},${got.y1})`);
  }
}

// The manifest and index.html must point at what exists, and the generator's job
// table must be this one. Three lists of the same four files is three chances to
// disagree.
console.log('\n── the manifest, the page and the generator agree ───────');
const manifest = JSON.parse(readFileSync(join(PUBLIC, 'site.webmanifest'), 'utf8'));
for (const icon of manifest.icons) {
  const f = icon.src.replace(/^\//, '');
  check(`the manifest's ${f} exists`, existsSync(join(PUBLIC, f)));
}
check('the manifest\'s colours are the tile colour',
  manifest.background_color === '#09090b' && manifest.theme_color === '#09090b',
  `${manifest.background_color} / ${manifest.theme_color}`);
const html = readFileSync(join(WEB, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:href)="\/([\w.-]+\.(?:svg|png|webmanifest))"/g)) {
  check(`index.html's ${m[1]} exists`, existsSync(join(PUBLIC, m[1])));
}
const gen = readFileSync(join(REPO, 'scripts', 'gen-icons.py'), 'utf8');
for (const [name, src] of RASTERS) {
  check(`the generator makes ${name} from ${src}`,
    new RegExp(`\\("${src}",\\s*"${name}"`).test(gen));
}

// ── 4. nobody else holds a copy of the coordinates ───────────────────────────
//
// THE ONE THAT WOULD HAVE CAUGHT THE DELETED GENERATOR. It is not enough to make
// the three files agree: the failure here was a FOURTH file that nothing in the
// repo mentioned, quietly holding a mark of its own and offering to write it over
// three live icons. A rule phrased as "these three must match" has nothing to say
// about a file it has never heard of; this one is phrased the other way round.
console.log('\n── no fourth copy of the mark ───────────────────────────');
const COORDS = new Set(['1.6', '2.4', '4.2', '5.4', '5.6', '10.15', '10.6', '11.6', '11.8',
  '13.85', '15.3', '17.2', '18.4', '20.2', '20.4', '21.6', '22.4', '1.85', '3.7']);
const ALLOWED = new Set(['apps/bothy-web/web/public/favicon.svg',
  'apps/bothy-web/web/public/icon-maskable.svg',
  'apps/bothy-web/web/src/components/Brand.tsx',
  'apps/bothy-web/checks/mark-geometry.mjs',
  'scripts/checks/mutants.sh']);
const SCAN = [join(SRC), join(WEB, 'scripts'), join(WEB, 'public'), join(REPO, 'scripts')];
const EXT = /\.(tsx?|mjs|js|py|svg|sh)$/;
const walk = (d, out = []) => {
  if (!existsSync(d)) return out;
  for (const e of readdirSync(d)) {
    const f = join(d, e);
    if (e === 'node_modules' || e.startsWith('.')) continue;
    if (statSync(f).isDirectory()) walk(f, out);
    else if (EXT.test(e)) out.push(f);
  }
  return out;
};
const culprits = [];
for (const f of new Set(SCAN.flatMap((d) => walk(d)))) {
  const rel = relative(REPO, f).split('\\').join('/');
  if (ALLOWED.has(rel)) continue;
  const text = /\.(tsx?|mjs|js)$/.test(f) ? stripJs(readFileSync(f, 'utf8'))
    : /\.svg$/.test(f) ? stripXml(readFileSync(f, 'utf8'))
      : readFileSync(f, 'utf8').replace(/^\s*#.*$/gm, '').replace(/"""[\s\S]*?"""/g, '');
  const hit = [...new Set((text.match(/\d+\.\d+/g) || []).filter((n) => COORDS.has(n)))];
  // Four. One or two of these numbers turn up in anything that measures in
  // fractions; four of them together is the mark and nothing else.
  if (hit.length >= 4) culprits.push(`${rel} (${hit.sort().join(' ')})`);
}
check('only the two SVGs and Brand.tsx carry the mark\'s coordinates',
  culprits.length === 0, culprits.join('; ') || 'nothing else does');

console.log();
console.log(fails ? `${fails} check(s) FAILED` : 'all pass');
process.exit(fails ? 1 : 0);
