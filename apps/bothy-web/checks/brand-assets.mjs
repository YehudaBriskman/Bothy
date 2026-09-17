// A brand asset must be small, vector, and take its colour from the theme.
//
// WHY THIS EXISTS. `docs/brand/Black white logo.svg` arrived at 1467 KB. It was
// not really vector: four base64 PNGs (1.06 MB decoded, the largest a 1250x1250
// at 902 KB) painted a soft radial glow and its matte through two feColorMatrix
// filters, and the actual geometry was 8.4 KB of paths. Chromium could not
// screenshot it inside five seconds. Stripping the bitmaps left 13 KB and an
// identical mark.
//
// It was also two-tone by accident: "thy" was filled and "Bo" was drawn as three
// stroke="#ffffff" outlines at stroke-width 156. So on a light background half
// the wordmark vanished, and on a dark one the other half did. Bothy ships seven
// themes; a mark that only works on one of them is not a mark.
//
// Both failures are invisible in a diff - the file is one enormous line - and
// both are the kind that get noticed by a reader, not by a reviewer. So they are
// asserted here instead.
//
// The rules are deliberately about SHAPE, not about aesthetics. Nothing here has
// an opinion on the artwork; it only refuses the three states that make an asset
// unusable in this app.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'web', 'public');

// 32 KB, against 13 KB actual: room to redraw the mark, nowhere near room to
// bake a bitmap back in. A budget set at the current size is a budget that fails
// on the next legitimate edit, and one set in megabytes is not a budget.
const MAX_BYTES = 32 * 1024;

let fails = 0;
const check = (label, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail}`);
};

// Every SVG the app serves, not a hand-kept list: an asset added tomorrow is
// covered without anyone remembering to add it here.
const SVGS = ['favicon.svg', 'icon-maskable.svg', 'wordmark.svg'].filter(
  (n) => existsSync(join(PUBLIC, n)),
);

check('there are brand SVGs to check', SVGS.length > 0, `${SVGS.length} found`);

for (const name of SVGS) {
  const raw = readFileSync(join(PUBLIC, name), 'utf8');
  console.log(`\n── ${name}  (${(raw.length / 1024).toFixed(1)} KB) ─────────────────`);

  check('under the size budget', raw.length <= MAX_BYTES,
    `${(raw.length / 1024).toFixed(1)} KB of ${MAX_BYTES / 1024} KB`);

  // THE ONE THAT MATTERS. An <image> or a data: URI means a raster has been
  // baked into a file whose whole point is that it is not one - it stops
  // scaling, stops following the theme, and takes the byte budget with it.
  check('no raster is embedded', !/<image\b/i.test(raw) && !/data:image\//i.test(raw),
    /<image\b/i.test(raw) ? 'contains <image> - this is a bitmap in a wrapper' : '');

  // A filter is not banned in principle, but every one in the logo that arrived
  // existed only to tint an embedded bitmap. Worth naming rather than failing.
  if (/<filter\b/i.test(raw)) {
    console.log('NOTE  carries a <filter> - check it is not tinting a bitmap');
  }
}

// The wordmark specifically must be single-colour and inherit it. favicon.svg is
// exempt on purpose: it is a two-colour app icon (black tile, white gable, blue
// lit door) whose colours ARE the mark, and it is rendered on its own tile
// rather than on a themed surface.
const WORDMARK = join(PUBLIC, 'wordmark.svg');
if (existsSync(WORDMARK)) {
  console.log('\n── wordmark follows the theme ──────────────────────────');
  const raw = readFileSync(WORDMARK, 'utf8');
  // fill AND stroke. Checking fill alone is exactly the mistake that hid this:
  // "Bo" is three heavy strokes, so a fill-only scan reported the file clean
  // while half the wordmark was still hard white.
  const paints = [...raw.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]);
  const hard = [...new Set(paints)].filter((v) => v !== 'currentColor' && v !== 'none');
  check('every fill AND stroke is currentColor or none', hard.length === 0,
    hard.length ? `hard colours: ${hard.join(', ')}` : `${paints.length} paints`);
  check('it actually paints something', paints.includes('currentColor'),
    'a mark with no currentColor cannot follow the theme');
}

console.log();
console.log(fails ? `${fails} check(s) FAILED` : 'all pass');
process.exit(fails ? 1 : 0);
