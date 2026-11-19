// Contrast and still-image checker (build plan S4, website-sky-design.md "Legibility").
//
// For each hour and viewport it renders the built home page with `?hour=`, hides the words, reads the pixels that sit
// BEHIND each text element, and computes WCAG 2.2 contrast and APCA Lc against the real ink (the lit-text gradient's
// lighter and darker extremes, whichever is worse). Worst case, not mean: the mean of the lightest 5 percent and of
// the darkest 5 percent of the pixels. Writes a table (markdown + JSON) and the stills (text visible) that S10 reuses
// for OG images. Exits 1 if any element is under its floor. Offline: it serves dist/ itself.
//
//   npm run build && npm run check:sky            fast: 8 hours, both viewports
//   npm run check:sky -- --full                   48 hours (every half hour), both viewports (CI/nightly)
//   options: --hours=6,18.5  --viewport=desktop|phone  --out=DIR  --dist=DIR  --no-stills
// Needs a Chromium: playwright-core's own, or CHROMIUM_PATH. Software GL (SwiftShader) is forced; the first frame
// takes about a minute, and this box has no frame clock, so frames are stepped by hand through window.__sky.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ------------------------------------------------------------------ the maths (unit-tested in test/sky)

/** sRGB 0..255 to linear 0..1 (WCAG 2.2 relative luminance uses the piecewise curve). */
const lin = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
/** WCAG 2.2 relative luminance of an [r,g,b] (0..255). */
export function wcagLuminance([r, g, b]) {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
/** WCAG 2.2 contrast ratio, 1..21, of two [r,g,b] colours or two luminances. */
export function wcagRatio(a, b) {
  const la = typeof a === 'number' ? a : wcagLuminance(a);
  const lb = typeof b === 'number' ? b : wcagLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** APCA (SAPC 0.0.98G-4g) screen luminance: simple 2.4 gamma and its own coefficients. */
export function apcaLuminance([r, g, b]) {
  return 0.2126729 * (r / 255) ** 2.4 + 0.7151522 * (g / 255) ** 2.4 + 0.072175 * (b / 255) ** 2.4;
}
/** APCA Lc (signed: positive dark text on light, negative light text on dark) from screen luminances. */
export function apcaLc(yText, yBg) {
  const soft = (y) => (y < 0.022 ? y + (0.022 - y) ** 1.414 : y);
  const t = soft(yText);
  const b = soft(yBg);
  if (Math.abs(b - t) < 0.0005) return 0;
  let s;
  if (b > t) {
    s = (b ** 0.56 - t ** 0.57) * 1.14;
    s = s < 0.1 ? 0 : s - 0.027;
  } else {
    s = (b ** 0.65 - t ** 0.62) * 1.14;
    s = s > -0.1 ? 0 : s + 0.027;
  }
  return s * 100;
}
/** Mean of the darkest and of the brightest `frac` of a list of numbers (the tails of the pixels behind a word). */
export function tails(values, frac = 0.05) {
  const v = Float64Array.from(values).sort();
  const n = Math.max(1, Math.round(v.length * frac));
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    lo += v[i];
    hi += v[v.length - 1 - i];
  }
  return { dark: lo / n, light: hi / n };
}
/**
 * Worst case of one element: every ink colour (lit gradient extremes) against both tails of the backdrop.
 * `wcagYs` and `apcaYs` are per-pixel luminances for the two models; returns the lowest WCAG ratio and lowest |Lc|.
 */
export function worstCase(inks, wcagYs, apcaYs) {
  const w = tails(wcagYs);
  const a = tails(apcaYs);
  let wcag = Infinity;
  let lc = Infinity;
  for (const ink of inks) {
    for (const bg of [w.dark, w.light]) wcag = Math.min(wcag, wcagRatio(wcagLuminance(ink), bg));
    for (const bg of [a.dark, a.light]) lc = Math.min(lc, Math.abs(apcaLc(apcaLuminance(ink), bg)));
  }
  return { wcag, lc, bgDark: w.dark, bgLight: w.light };
}
/** The floors (design doc): body and tagline 4.5 and Lc 60, large text 3 and Lc 45. */
export const FLOORS = { large: { wcag: 3, lc: 45 }, body: { wcag: 4.5, lc: 60 } };

export const FAST_HOURS = [1, 5, 6.5, 8.5, 12, 16, 18.5, 21];
export const FULL_HOURS = Array.from({ length: 48 }, (_, i) => i / 2);
export const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

// ------------------------------------------------------------------ the page side

/** Runs in the page: lists the text elements of the sky sections with ink and line boxes, then hides the words. */
function collectAndHide() {
  const sel = 'h1,h2,h3,.ch-line,.ch-lede,p,a,button,label,output,li,small';
  const out = [];
  const seen = new Set();
  for (const sec of document.querySelectorAll('[data-sky], .site-nav')) {
    for (const el of sec.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!hasText && !(el.matches('a,button') && el.textContent.trim())) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (el.closest('[hidden]') || el.closest('.ch-skip')) continue; // the skip links are out of sight until a key focuses them
      {
        const r0 = el.getBoundingClientRect();
        if (r0.width < 4 || r0.height < 4) continue;
      } // clipped out of sight (the keyboard skip links)
      if (el.closest('details:not([open])') && !el.closest('summary')) continue; // a closed menu is not on screen
      const box = el.getBoundingClientRect();
      if (box.width <= 2 || box.height <= 2) continue; // visually-hidden text (a screen-reader label) is not seen
      const r = document.createRange();
      r.selectNodeContents(el);
      const lines = [...r.getClientRects()].filter((q) => q.width > 1 && q.height > 1);
      if (!lines.length) continue;
      seen.add(el);
      const rgb = (s) =>
        (s.match(/rgba?\(([^)]+)\)/g) ?? [])
          .map((m) =>
            m
              .match(/[\d.]+/g)
              .slice(0, 3)
              .map(Number),
          )
          .filter((c) => c.length === 3);
      let inks;
      if (el.style.backgroundImage && cs.backgroundClip === 'text') inks = rgb(el.style.backgroundImage);
      else inks = rgb(cs.color);
      const tag = el.tagName.toLowerCase();
      const size = parseFloat(cs.fontSize);
      const bold = parseInt(cs.fontWeight, 10) >= 700;
      const role =
        tag === 'h1'
          ? 'h1'
          : /^h[2-6]$/.test(tag)
            ? 'heading'
            : el.classList.contains('ch-line')
              ? 'tagline'
              : el.classList.contains('ch-lede')
                ? 'lede'
                : tag === 'a' || tag === 'button'
                  ? 'button'
                  : 'body';
      const large = role === 'h1' || role === 'heading' || size >= 24 || (bold && size >= 18.66); // WCAG large text; the statement is 37px and up
      out.push({
        role,
        label: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28),
        large,
        size,
        inks,
        lines: lines.map((q) => ({ x: q.x + scrollX, y: q.y + scrollY, w: q.width, h: q.height })),
      });
      el.dataset.skyCheck = '1';
    }
  }
  const st = document.createElement('style');
  st.id = 'check-sky-hide';
  // words invisible, their backgrounds (a button's own fill, the sky, the scrim) untouched; the lit gradient fill is
  // clipped to the glyphs, so it goes too
  st.textContent = `[data-sky-check] svg{visibility:hidden!important}
[data-sky-check]{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;filter:none!important}
[data-sky-check]:is(h1,.ch-line,.ch-lede){background-image:none!important}`;
  document.head.append(st);
  return out;
}

async function decodeRegions(page, png, regions) {
  return page.evaluate(
    async ({ b64, regions }) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      return regions.map((rs) =>
        rs.map((r) => {
          const x = Math.max(0, Math.floor(r.x));
          const y = Math.max(0, Math.floor(r.y));
          const w = Math.max(1, Math.min(img.width - x, Math.ceil(r.w)));
          const h = Math.max(1, Math.min(img.height - y, Math.ceil(r.h)));
          const d = g.getImageData(x, y, w, h).data;
          const px = [];
          for (let i = 0; i < d.length; i += 4) px.push(d[i], d[i + 1], d[i + 2]);
          return px;
        }),
      );
    },
    { b64: png.toString('base64'), regions },
  );
}

// ------------------------------------------------------------------ server, browser, run

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

function serve(root) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(root, path.normalize(p));
    if (!f.startsWith(root)) return void res.writeHead(403).end();
    fs.readFile(f, (e, buf) => {
      if (e) return void res.writeHead(404).end('not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' }).end(buf);
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

async function launch() {
  const { chromium } = await import('playwright-core');
  return chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--no-sandbox',
    ],
  });
}

const hh = (h) => `${String(Math.floor(h)).padStart(2, '0')}${h % 1 ? '30' : '00'}`;
const fmtH = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${h % 1 ? '30' : '00'}`;

async function runViewport(browser, base, name, vp, hours, o) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/?hour=${hours[0]}&manual=1`, { waitUntil: 'load', timeout: 180000 });
  for (let i = 0; i < 300; i++) {
    if (await page.evaluate(() => !!window.__sky && window.__sky.ready())) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const mode = await page.evaluate(() => window.__sky?.mode?.());
  if (!mode) throw new Error(`${name}: window.__sky never appeared (is the build current? run npm run build)`);
  await page.evaluate(() => window.__sky.loadAll());
  await page.evaluate(() => document.fonts.ready);
  const rows = [];
  for (const h of hours) {
    const t0 = Date.now();
    await page.evaluate((h) => {
      window.__sky.setHour(h);
      window.__sky.frame(0);
      window.__sky.frame(6);
    }, h);
    await page.waitForLoadState('networkidle').catch(() => {});
    // settle the finite animations only: a looping one (the photo windows' slow drift) never finishes, and waiting on
    // it stalls the run until the job's time limit
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => {})),
      ),
    );
    await page.evaluate(() => window.__sky.frame(0));
    const sky = await page.evaluate(() => document.querySelector('[data-sky]').getBoundingClientRect().toJSON());
    if (o.stills) {
      await page.screenshot({
        path: path.join(o.out, `sky-${name}-${hh(h)}.png`),
        clip: { x: 0, y: 0, width: vp.width, height: vp.height },
      });
    }
    const els = await page.evaluate(collectAndHide);
    const top = 0; // from the very top, so the navigation (above the hero) is measured too
    const clip = { x: 0, y: top, width: vp.width, height: Math.ceil(Math.min(sky.y + sky.height, 4000)) };
    const png = await page.screenshot({ fullPage: true, clip });
    const regions = await decodeRegions(
      page,
      png,
      els.map((e) => e.lines.map((l) => ({ ...l, y: l.y - top }))),
    );
    await page.evaluate(() => {
      document.getElementById('check-sky-hide')?.remove();
      document.querySelectorAll('[data-sky-check]').forEach((e) => e.removeAttribute('data-sky-check'));
    });
    els.forEach((e, i) => {
      const flat = regions[i].flat();
      const wy = [];
      const ay = [];
      for (let k = 0; k < flat.length; k += 3) {
        const c = [flat[k], flat[k + 1], flat[k + 2]];
        wy.push(wcagLuminance(c));
        ay.push(apcaLuminance(c));
      }
      const inks = e.inks.length ? e.inks : [[247, 245, 239]];
      const w = worstCase(inks, wy, ay);
      const f = e.large ? FLOORS.large : FLOORS.body;
      rows.push({
        hour: h,
        viewport: name,
        mode,
        role: e.role,
        text: e.label,
        large: e.large,
        ink: inks.map((c) => c.map(Math.round).join(',')).join(' | '),
        wcag: +w.wcag.toFixed(2),
        lc: +w.lc.toFixed(1),
        floorWcag: f.wcag,
        floorLc: f.lc,
        pass: w.wcag >= f.wcag && w.lc >= f.lc,
      });
    });
    console.error(`  ${name} ${fmtH(h)}  ${els.length} elements  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  await ctx.close();
  return { rows, errors };
}

function markdown(rows, meta) {
  const L = [];
  L.push('# Sky contrast, measured from pixels', '');
  L.push(
    `${meta.when}. ${meta.hours} hours x ${meta.viewports.join(' + ')}. Mean of the worst 5 percent of pixels behind each element, against the`,
  );
  L.push(
    'worse lit-ink extreme; WCAG 2.2 ratio and APCA Lc (absolute). Floors: large 3.0 / Lc 45, body 4.5 / Lc 60 (the 37px-and-up statement counts as large text).',
    '',
  );
  const bad = rows.filter((r) => !r.pass);
  L.push(
    `**${bad.length ? `${bad.length} failing of ${rows.length} measurements` : `all ${rows.length} measurements pass`}.**`,
    '',
  );
  L.push(
    '## Worst per hour',
    '',
    '| Hour | Viewport | Mode | Worst WCAG (element) | Worst Lc (element) | Result |',
    '|---|---|---|---|---|---|',
  );
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.hour}|${r.viewport}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const margin = (r, key) => (key === 'wcag' ? r.wcag / r.floorWcag : r.lc / r.floorLc);
  for (const g of groups.values()) {
    const worst = (key) => g.reduce((a, b) => (margin(b, key) < margin(a, key) ? b : a));
    const w = worst('wcag');
    const l = worst('lc');
    L.push(
      `| ${fmtH(g[0].hour)} | ${g[0].viewport} | ${g[0].mode} | ${w.wcag} (${w.role}) | ${l.lc} (${l.role}) | ${g.every((r) => r.pass) ? 'pass' : 'FAIL'} |`,
    );
  }
  L.push(
    '',
    '## Every element',
    '',
    '| Hour | Viewport | Element | Text | WCAG | Lc | Floor | Result |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const r of rows) {
    L.push(
      `| ${fmtH(r.hour)} | ${r.viewport} | ${r.role} | ${r.text.replace(/\|/g, '/')} | ${r.wcag} | ${r.lc} | ${r.floorWcag} / ${r.floorLc} | ${r.pass ? 'pass' : 'FAIL'} |`,
    );
  }
  return L.join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const siteDir = path.resolve(here, '..');
  const dist = path.resolve(opt('dist') ?? path.join(siteDir, 'dist'));
  const out = path.resolve(opt('out') ?? path.join(siteDir, '.check-sky'));
  const hours = opt('hours') ? opt('hours').split(',').map(Number) : args.includes('--full') ? FULL_HOURS : FAST_HOURS;
  const vps = opt('viewport') ? [opt('viewport')] : Object.keys(VIEWPORTS);
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error(`no build at ${dist}: run npm run build first`);
  fs.mkdirSync(out, { recursive: true });
  const srv = await serve(dist);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await launch();
  const t0 = Date.now();
  const rows = [];
  const errors = [];
  try {
    for (const v of vps) {
      console.error(`${v} ${VIEWPORTS[v].width}x${VIEWPORTS[v].height}: ${hours.length} hours`);
      const r = await runViewport(browser, base, v, VIEWPORTS[v], hours, {
        out,
        stills: !args.includes('--no-stills'),
      });
      rows.push(...r.rows);
      errors.push(...r.errors);
    }
  } finally {
    await browser.close();
    srv.close();
  }
  const meta = {
    when: new Date().toISOString().slice(0, 10),
    hours: hours.length,
    viewports: vps,
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  fs.writeFileSync(path.join(out, 'contrast.json'), JSON.stringify({ meta, rows }, null, 1));
  fs.writeFileSync(path.join(out, 'contrast.md'), markdown(rows, meta));
  const bad = rows.filter((r) => !r.pass);
  for (const r of bad) {
    console.log(
      `FAIL ${fmtH(r.hour)} ${r.viewport} ${r.role} "${r.text}": WCAG ${r.wcag} (need ${r.floorWcag}), Lc ${r.lc} (need ${r.floorLc})`,
    );
  }
  if (errors.length) console.error(`page errors:\n${errors.slice(0, 5).join('\n')}`);
  console.log(
    `check-sky: ${rows.length} measurements, ${bad.length} failing, ${meta.seconds}s, table in ${path.relative(process.cwd(), out)}/contrast.md`,
  );
  if (!rows.length) throw new Error('no text elements measured: is there a [data-sky] section on the home page?');
  process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(2);
  });
}
