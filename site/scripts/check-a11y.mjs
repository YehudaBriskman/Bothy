// check:a11y - the accessibility gate for the built site (build plan S9). Serves dist/ itself, offline, and for every
// prerendered page, at a desktop size and a phone width:
//
//   1. axe-core (vendored as a devDependency, injected from node_modules; nothing is fetched) with the WCAG 2.0 to
//      2.2 A and AA rules plus best practice. A serious or critical violation fails; moderate and minor ones print.
//   2. Text contrast outside the story. For each visible text run: its computed colour (alpha and ancestor opacity
//      folded in) against its effective background, found by walking up the ancestors and compositing their
//      background colours. WCAG AA: 4.5:1, or 3:1 for large text (24px, or 18.66px bold). Text whose background walk
//      meets an image or a gradient is skipped and counted: the sky and the photographs behind the story are
//      measured pixel by pixel by check:sky, not here. Text that is aria-hidden, visually hidden or not rendered is
//      skipped too.
//   3. Reflow: at 320 CSS px wide (a 1280 px window at 400 percent zoom) the page must not scroll sideways.
//
// The pages are rendered with reduced motion, so a reveal animation never measures a half-faded word.
// Needs a Chromium: playwright-core's own, or CHROMIUM_PATH. Exit 1 on any failure.
//   npm run build && npm run check:a11y            options: --only=/docs/  --no-axe
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const require = createRequire(import.meta.url);
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('check:a11y: no dist/index.html; run npm run build first');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.png': 'image/png',
};
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(dist, path.normalize(p));
  if (!f.startsWith(dist)) return void res.writeHead(403).end();
  fs.readFile(f, (e, b) =>
    e
      ? res.writeHead(404).end('not found')
      : res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' }).end(b),
  );
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;

// Every prerendered page; the spike and the scene and brand mocks are design scratch pages, not the site.
const pages = fs
  .readdirSync(dist, { recursive: true })
  .filter((f) => f.endsWith('.html') && !/^(sky-spike|scene-mock|brand-mock)\//.test(f.replaceAll('\\', '/')))
  .map((f) => `/${f.replaceAll('\\', '/').replace(/index\.html$/, '')}`)
  .filter((p) => !args.only || p.includes(args.only))
  .sort();

const axeSource = args['no-axe'] ? '' : fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

/** Runs in the page: every text run outside the story with its contrast against its effective background. */
function measureContrast() {
  const parse = (c) => {
    let m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(c);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    m = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(c);
    if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] === undefined ? 1 : +m[4]];
    return null;
  };
  const over = (top, under) => {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1);
  };
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  /**
   * The backgrounds that can sit behind `el`: the ancestors' background colours composited bottom-up. A CSS gradient
   * is a set of colours, so each stop (over that element's own background colour) is a candidate and the worst one
   * is judged. A url() image (a photograph) ends the walk: `image` names the element that carries it.
   */
  const backdrop = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      const c = parse(cs.backgroundColor) ?? [0, 0, 0, 0];
      const img = cs.backgroundImage;
      // a thin gradient line (an underline drawn as a background, .link-draw) is not a backdrop
      const line = /\s([\d.]+)px$/.exec(cs.backgroundSize);
      if (img !== 'none' && !(line && +line[1] <= 3)) {
        if (/url\(/.test(img)) return { image: e };
        const stops = (img.match(/rgba?\([^)]*\)|color\(srgb [^)]*\)/g) ?? []).map(parse).filter(Boolean);
        const solid = c[3] >= 1 || (stops.length > 0 && stops.every((st) => st[3] >= 1));
        // each stop over the element's own colour; transparent where neither paints
        const variants = stops.map((st) => {
          if (c[3] <= 0) return st;
          const a = st[3] + c[3] * (1 - st[3]);
          return [0, 1, 2].map((i) => (st[i] * st[3] + c[i] * c[3] * (1 - st[3])) / a).concat(a);
        });
        layers.push(variants.length ? variants : [c]);
        if (solid) break;
        continue;
      }
      if (c[3] > 0) {
        layers.push([c]);
        if (c[3] >= 1) break;
      }
    }
    let cands = [[255, 255, 255, 1]]; // the canvas, if nothing is opaque
    for (const variants of layers.reverse()) {
      const next = [];
      for (const under of cands) for (const v of variants) next.push(over(v, under));
      cands = next.slice(0, 64);
    }
    return { cands };
  };
  const out = { checked: 0, skippedImage: 0, imageOwners: {}, unknown: [], fails: [] };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    if (el.closest('[data-story], [aria-hidden="true"], [hidden], script, style, noscript, .visually-hidden, .sr-only'))
      continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || cs.clipPath === 'inset(50%)') continue;
    let opacity = 1;
    for (let e = el; e; e = e.parentElement) opacity *= +getComputedStyle(e).opacity;
    if (opacity === 0) continue;
    const fg = parse(cs.color);
    const back = backdrop(el);
    if (back.image) {
      out.skippedImage++;
      const i = back.image;
      const k = `${i.tagName.toLowerCase()}.${i.classList[0] ?? ''}`;
      out.imageOwners[k] = (out.imageOwners[k] ?? 0) + 1;
      continue;
    }
    if (!fg) {
      out.unknown.push(`${el.tagName.toLowerCase()} color ${cs.color}`);
      continue;
    }
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700);
    const need = large ? 3 : 4.5;
    let got = Infinity;
    let worstBg = back.cands[0];
    for (const bg of back.cands) {
      const v = ratio(over([fg[0], fg[1], fg[2], fg[3] * opacity], bg), bg);
      if (v < got) [got, worstBg] = [v, bg];
    }
    out.checked++;
    if (got < need - 0.005) {
      const id = el.id ? `#${el.id}` : el.classList[0] ? `.${el.classList[0]}` : '';
      out.fails.push(
        `${el.tagName.toLowerCase()}${id} "${n.textContent.trim().slice(0, 40)}" ${got.toFixed(2)}:1 < ${need} (${cs.color} on rgb(${worstBg.slice(0, 3).map(Math.round).join(', ')}), ${size}px)`,
      );
    }
  }
  return out;
}

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--disable-gpu', '--no-sandbox'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let warnings = 0;
let checkedText = 0;
let skippedImage = 0;

for (const page of pages) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      reducedMotion: 'reduce',
    });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(base + page, { waitUntil: 'load' });
    // A11Y_INJECT_CSS='p{color:#555}' proves the gate can fail (it must, on dark pages)
    if (process.env.A11Y_INJECT_CSS) await p.addStyleTag({ content: process.env.A11Y_INJECT_CSS });
    await sleep(400);
    const lines = [];
    let bad = false;

    if (axeSource) {
      await p.addScriptTag({ content: axeSource });
      const violations = await p.evaluate(async () => {
        const r = await window.axe.run(document, {
          runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
          resultTypes: ['violations'],
        });
        return r.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ')),
          count: v.nodes.length,
        }));
      });
      for (const v of violations) {
        const serious = v.impact === 'serious' || v.impact === 'critical';
        if (serious) bad = true;
        else warnings++;
        lines.push(
          `  ${serious ? 'FAIL' : 'warn'} axe ${v.impact} ${v.id} x${v.count}: ${v.help} [${v.nodes.join(' ; ')}]`,
        );
      }
    }

    const c = await p.evaluate(measureContrast);
    checkedText += c.checked;
    skippedImage += c.skippedImage;
    for (const f of c.fails) lines.push(`  FAIL contrast ${f}`);
    if (process.env.A11Y_DEBUG) lines.push(`  info over images: ${JSON.stringify(c.imageOwners)}`);
    for (const u of c.unknown) lines.push(`  warn contrast: could not read ${u}`);
    warnings += c.unknown.length;
    if (c.fails.length) bad = true;

    if (errors.length) {
      bad = true;
      lines.push(`  FAIL page errors: ${errors.join('; ')}`);
    }
    if (bad) failures++;
    console.log(`${bad ? 'FAIL' : 'ok  '} ${page} ${vp.name}: ${c.checked} text runs measured`);
    for (const l of lines) console.log(l);
    await ctx.close();
  }

  // Reflow at 320 CSS px: nothing may scroll sideways.
  const ctx = await browser.newContext({ viewport: { width: 320, height: 640 }, reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  await p.goto(base + page, { waitUntil: 'load' });
  await sleep(300);
  const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 0) {
    failures++;
    console.log(`FAIL ${page} 320px: the page scrolls sideways by ${over}px`);
  }
  await ctx.close();
}

await browser.close();
srv.close();
console.log(
  `\ncheck:a11y: ${pages.length} pages x ${VIEWPORTS.length} viewports + 320px reflow; ${checkedText} text runs measured, ${skippedImage} over images left to check:sky; ${warnings} warnings; ${failures} failing`,
);
process.exit(failures ? 1 : 0);
