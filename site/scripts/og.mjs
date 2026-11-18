// Share images and app icons (build plan S10). Run by hand when the words, the photographs or the mark change:
//
//   npm run og            writes public/favicon.svg, renders public/og/*.jpg, the PNG icons, and public/og/PROVENANCE.json
//
// Each share image is a sky photograph from public/sky/ (CC0, see its PROVENANCE.json), cropped to 1200 x 630, with
// a dark scrim, the BothyBox lockup and the words from src/seo.ts (OG_CARDS) set in the site's own type. It is drawn by headless
// Chromium (playwright-core, already a dev dependency) and saved as JPEG, because Facebook and LinkedIn do not render
// WebP reliably. Before saving, the words are hidden, the pixels behind each line are read, and WCAG 2.2 and APCA
// contrast are computed with the same maths and floors as scripts/check-sky.mjs (body floors for every line: a card
// is shown small). A line under its floor fails the run and nothing is written.
//
// The output is committed, not built: fonts differ between machines, so CI checks the committed files
// (scripts/check-seo.mjs: size, dimensions, sha256 against PROVENANCE.json) instead of re-rendering them.
// Needs a Chromium: playwright-core's own, or CHROMIUM_PATH.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLOORS, apcaLuminance, wcagLuminance, worstCase } from './check-sky.mjs';
import { OG_CARDS, OG_SIZE } from '../src/seo.ts';
import { AMBER, LOCKUP_VIEWBOX, iconSVG, lockupInner } from '../src/brand/cube.ts';
import { OG_MAX_BYTES } from './check-seo.mjs';

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(siteDir, 'public');
const ogDir = path.join(pub, 'og');

const JPEG_QUALITY = 84;
const INK = [244, 239, 230]; // --lit, the lit window: the words' colour
const FONT =
  "'Ubuntu Sans', 'SF Pro Display', 'Segoe UI Variable Display', 'Segoe UI', system-ui, Ubuntu, Roboto, 'Noto Sans', 'Helvetica Neue', Arial, sans-serif";
// The header's lockup (src/brand/cube.ts: the Cube icon and the drawn wordmark), in the words' colour, `cap` px cap
// height. The lockup's box is 7.18 x 1.36 cap heights.
const LOCKUP = (cap, colour, id) =>
  `<svg viewBox="${LOCKUP_VIEWBOX}" width="${+(cap * 7.18).toFixed(1)}" height="${+(cap * 1.36).toFixed(1)}" aria-hidden="true">${lockupInner({ fg: colour, lid: AMBER, id })}</svg>`;

const dataUrl = (file, type) => `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const ink = `rgb(${INK.join(' ')})`;

function cardHtml(card) {
  const photo = dataUrl(path.join(pub, 'sky', `${card.photo}-desk.webp`), 'image/webp');
  // The home card's heading is the name itself: it is drawn as the lockup, large, and the small brand row is left out.
  const big = card.heading === 'BothyBox';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${OG_SIZE.width}px; height: ${OG_SIZE.height}px; overflow: hidden; background: #08090d; }
  body { font-family: ${FONT}; color: ${ink}; -webkit-font-smoothing: antialiased; }
  .photo { position: absolute; inset: 0; background: url(${photo}) center 35% / cover no-repeat; }
  .scrim { position: absolute; inset: 0; background:
      linear-gradient(90deg, rgb(8 9 13 / 0.86) 0%, rgb(8 9 13 / 0.74) 50%, rgb(8 9 13 / 0.3) 82%, rgb(8 9 13 / 0) 100%),
      linear-gradient(0deg, rgb(8 9 13 / 0.7) 0%, rgb(8 9 13 / 0) 32%); }
  .card { position: absolute; inset: 72px 80px 64px; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; }
  h1.lockup { line-height: 0; }
  h1 { margin-block-start: auto; font-size: ${big ? 128 : 84}px; font-weight: 650; line-height: 0.98;
       letter-spacing: -0.045em; max-inline-size: 900px; }
  p.line { margin-block-start: 26px; font-size: 36px; font-weight: 450; line-height: 1.25; letter-spacing: -0.01em;
       max-inline-size: 760px; }
  .foot { margin-block-start: 40px; display: flex; gap: 28px; font-size: 24px; font-weight: 500; }
  .hide [data-t] { color: transparent !important; }
  .hide svg { visibility: hidden; }
  </style></head><body>
  <div class="photo"></div><div class="scrim"></div>
  <div class="card">
    ${big ? '' : `<div class="brand" data-t data-label="BothyBox lockup">${LOCKUP(26, ink, 'bs')}</div>`}
    ${big ? `<h1 class="lockup" data-t data-label="${esc(card.heading)}">${LOCKUP(92, ink, 'bh')}</h1>` : `<h1 data-t>${esc(card.heading)}</h1>`}
    <p class="line" data-t>${esc(card.line)}</p>
    <div class="foot"><span data-t>bothybox.com</span><span data-t>Free and open source, MIT</span></div>
  </div></body></html>`;
}

/** Pixels behind each [data-t] line, read from a screenshot with the words hidden. */
async function contrastRows(page) {
  const rects = await page.evaluate(() =>
    [...document.querySelectorAll('[data-t]')].map((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return {
        label: el.dataset.label ?? el.textContent.trim(),
        boxes: [...r.getClientRects()].map((b) => b.toJSON()),
      };
    }),
  );
  await page.evaluate(() => document.documentElement.classList.add('hide'));
  const png = (await page.screenshot({ type: 'png' })).toString('base64');
  await page.evaluate(() => document.documentElement.classList.remove('hide'));
  const pixels = await page.evaluate(
    async ({ png, rects }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return rects.map((t) =>
        t.boxes.flatMap((b) => {
          const x = Math.max(0, Math.floor(b.x));
          const y = Math.max(0, Math.floor(b.y));
          const w = Math.max(1, Math.min(c.width - x, Math.ceil(b.width)));
          const h = Math.max(1, Math.min(c.height - y, Math.ceil(b.height)));
          return [...g.getImageData(x, y, w, h).data];
        }),
      );
    },
    { png, rects },
  );
  return rects.map((t, i) => {
    const flat = pixels[i];
    const wy = [];
    const ay = [];
    for (let k = 0; k < flat.length; k += 4) {
      const c = [flat[k], flat[k + 1], flat[k + 2]];
      wy.push(wcagLuminance(c));
      ay.push(apcaLuminance(c));
    }
    const w = worstCase([INK], wy, ay);
    const ok = w.wcag >= FLOORS.body.wcag && Math.abs(w.lc) >= FLOORS.body.lc;
    return { text: t.label, wcag: +w.wcag.toFixed(2), apcaLc: +Math.abs(w.lc).toFixed(1), ok };
  });
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

async function main() {
  const { chromium } = await import('playwright-core');
  // The same flags as check-sky.mjs: software GL, so a headless box with no GPU still produces frames.
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const version = browser.version();
  const page = await browser.newPage({ viewport: OG_SIZE, deviceScaleFactor: 1 });
  // A screenshot waits for a frame, and some headless boxes produce one rarely (claude-notes: about one per 40 s).
  page.setDefaultTimeout(180000);
  const out = [];
  const fails = [];
  try {
    for (const [key, card] of Object.entries(OG_CARDS)) {
      await page.setContent(cardHtml(card), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const contrast = await contrastRows(page);
      for (const r of contrast.filter((r) => !r.ok))
        fails.push(`${key}: "${r.text}" WCAG ${r.wcag} / Lc ${r.apcaLc} under ${FLOORS.body.wcag} / ${FLOORS.body.lc}`);
      const jpg = await page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY });
      if (jpg.length > OG_MAX_BYTES) fails.push(`${key}: ${jpg.length} bytes, over ${OG_MAX_BYTES}`);
      out.push({ key, card, jpg, contrast });
    }
    // Icons: the Cube's full-bleed variant (src/brand/cube.ts iconSVG('full'): an ink square, the cube at 80 %)
    // drawn at the sizes platforms ask for. Apple rounds the touch icon's corners itself; the manifest icons are
    // square too, so a launcher that masks them keeps the whole cube.
    const full = iconSVG('full');
    const icons = [];
    for (const [file, size] of [
      ['apple-touch-icon.png', 180],
      ['icon-192.png', 192],
      ['icon-512.png', 512],
    ]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<html><body style="margin:0;background:transparent">${full.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
      );
      icons.push({ file, size, png: await page.screenshot({ type: 'png' }) });
    }
    if (fails.length) {
      for (const f of fails) console.error(`og: ${f}`);
      process.exit(1);
    }
    fs.mkdirSync(ogDir, { recursive: true });
    fs.writeFileSync(path.join(pub, 'favicon.svg'), `${iconSVG('favicon')}\n`);
    for (const o of out) fs.writeFileSync(path.join(ogDir, `${o.key}.jpg`), o.jpg);
    for (const i of icons) fs.writeFileSync(path.join(pub, i.file), i.png);
    let fonts = '';
    try {
      fonts = execFileSync('fc-match', ['Ubuntu Sans:weight=650'], { encoding: 'utf8' }).trim();
    } catch {
      fonts = 'unknown (no fc-match)';
    }
    const prov = {
      generator: 'site/scripts/og.mjs (npm run og)',
      generated: new Date().toISOString().slice(0, 10),
      renderer: `Chromium ${version} via playwright-core, deviceScaleFactor 1, JPEG quality ${JPEG_QUALITY}`,
      font: `font stack: ${FONT}; resolved on the generating machine by fc-match to ${fonts}`,
      licence:
        'The photographs are CC0 1.0 (public/sky/PROVENANCE.json). The mark, words and layout are this repository’s, MIT.',
      contrast: `WCAG 2.2 and APCA Lc against the pixels behind each line with the words hidden, worst 5 percent tail, floors ${FLOORS.body.wcag}:1 and Lc ${FLOORS.body.lc} (scripts/check-sky.mjs)`,
      maxBytes: OG_MAX_BYTES,
      images: out.map((o) => ({
        file: `${o.key}.jpg`,
        width: OG_SIZE.width,
        height: OG_SIZE.height,
        bytes: o.jpg.length,
        sha256: sha(o.jpg),
        photo: `public/sky/${o.card.photo}-desk.webp (see public/sky/PROVENANCE.json, key "${o.card.photo}")`,
        heading: o.card.heading,
        line: o.card.line,
        contrast: o.contrast,
      })),
      icons: icons.map((i) => ({
        file: i.file,
        width: i.size,
        height: i.size,
        bytes: i.png.length,
        sha256: sha(i.png),
        source: "src/brand/cube.ts iconSVG('full') (the Cube icon, full bleed)",
      })),
    };
    fs.writeFileSync(path.join(ogDir, 'PROVENANCE.json'), `${JSON.stringify(prov, null, 2)}\n`);
    for (const o of out) {
      const worst = o.contrast.reduce((a, r) => (r.wcag < a.wcag ? r : a));
      console.log(
        `og: ${o.key}.jpg ${(o.jpg.length / 1024).toFixed(1)} KB, worst line WCAG ${worst.wcag}:1 Lc ${worst.apcaLc}`,
      );
    }
    for (const i of icons) console.log(`og: ${i.file} ${i.size}px ${(i.png.length / 1024).toFixed(1)} KB`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
