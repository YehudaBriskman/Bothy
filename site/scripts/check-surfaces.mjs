// check:surfaces - nothing stands behind a group of cards. Serves dist/ itself, offline, and on every prerendered
// page (desktop, and the home page at a phone width too) looks at the wrappers that hold groups of cards below the
// story: sections, chapter wraps, card lists, the footer. Each one, and its ::before and ::after, must paint no
// background image (no gradient, glow, star field or photo) and a background colour that is either transparent or
// exactly the page's ink, rgb(9 9 12) (the story's chapters keep that opaque ink because the sky stage behind them is
// fixed). Only the cards inside have surfaces of their own. The closing band (.end-cta) is allowed its night photo.
// On the home page only what follows #story-end is checked: above it is the hero and the story's sky.
//   npm run build && npm run check:surfaces
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('check:surfaces: no dist/index.html; run npm run build first');
  process.exit(1);
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(dist, path.normalize(p));
  if (!f.startsWith(dist)) return void res.writeHead(403).end();
  fs.readFile(f, (e, b) =>
    e ? res.writeHead(404).end() : res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? '' }).end(b),
  );
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;

const pages = fs
  .readdirSync(dist, { recursive: true })
  .map((f) => f.replaceAll('\\', '/'))
  .filter((f) => f.endsWith('.html') && !/^(sky-spike|scene-mock|brand-mock)\//.test(f))
  .map((f) => `/${f.replace(/index\.html$/, '')}`)
  .sort();
const runs = [...pages.map((p) => [p, 1440, 900]), ['/', 390, 844]];

// The wrappers that hold groups. Cards themselves (.card, .glass, .path-card ...) are not in this list.
const WRAPPERS = [
  'main > *',
  'main section',
  '.ch',
  '.ch-wrap',
  '.wrap',
  '.after-story',
  '.section-head',
  '.cards',
  '.features',
  '.ch-cards',
  '.ch-modes',
  '.path-grid',
  '.proof-grid',
  '.releases',
  '.doc-cards',
  '.about-grid',
  '.docs-shell',
  '.site-foot',
  '.foot-body',
  '.foot-grid',
].join(',');

function probe(wrappers) {
  const INK = 'rgb(9, 9, 12)';
  const end = document.querySelector('#story-end');
  const bad = [];
  const name = (el) =>
    el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + [...el.classList].map((c) => `.${c}`).join('');
  for (const el of document.querySelectorAll(wrappers)) {
    if (el.closest('.night-cta, .end-cta, [data-story-dots], .story-end, .site-nav')) continue; // the band keeps its photo; the dots and the header's capsule are UI
    if (el.closest('.card, .glass')) continue; // a card (even a <section> one) is a surface by design
    if (document.querySelector('[data-story]') && !(end && end.compareDocumentPosition(el) & 4)) continue;
    for (const pseudo of [null, '::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      if (pseudo && (cs.content === 'none' || cs.content === 'normal')) continue;
      if (cs.display === 'none') continue;
      const bg = cs.backgroundColor;
      if (cs.backgroundImage !== 'none')
        bad.push(`${name(el)}${pseudo ?? ''}: background-image ${cs.backgroundImage.slice(0, 60)}`);
      if (bg !== 'rgba(0, 0, 0, 0)' && bg !== INK) bad.push(`${name(el)}${pseudo ?? ''}: background-color ${bg}`);
    }
  }
  return bad;
}

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--disable-gpu', '--no-sandbox'],
});
let failures = 0;
for (const [p, width, height] of runs) {
  const page = await (await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' })).newPage();
  await page.goto(`${base}${p}`, { waitUntil: 'load' });
  const bad = await page.evaluate(probe, WRAPPERS);
  for (const b of bad) console.log(`FAIL ${p} ${width}px ${b}`);
  failures += bad.length;
  await page.close();
}
await browser.close();
srv.close();
console.log(
  `check:surfaces: ${runs.length} page views, ${failures} surface${failures === 1 ? '' : 's'} behind a group`,
);
process.exit(failures ? 1 : 0);
