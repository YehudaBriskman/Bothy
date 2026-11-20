// screenshots: stills of the built site for a reviewer to look at, not a gate (build plan S11).
// Home at three hours (dawn, midday, sunset) x desktop and phone, plus Install and the docs index at both sizes.
// Serves dist/ on 127.0.0.1, drives Chromium (playwright-core's own, or CHROMIUM_PATH), writes PNGs and an
// index.md into .screenshots/ (or --out=DIR). Exit 1 only when a page could not be opened at all.
//
//   npm run screenshots
//   npm run screenshots -- --out=/tmp/shots
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const dist = path.resolve(opt('dist') ?? path.join(here, '..', 'dist'));
const out = path.resolve(opt('out') ?? path.join(here, '..', '.screenshots'));

const HOURS = [6.5, 13, 18.5];
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const SHOTS = [
  ...HOURS.map((h) => ({ name: `home-${String(h).replace('.', '_')}h`, url: `/?hour=${h}&manual=1`, hour: h })),
  { name: 'install', url: '/install/' },
  { name: 'docs', url: '/docs/' },
];

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

async function main() {
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error(`no build at ${dist}: run npm run build first`);
  fs.mkdirSync(out, { recursive: true });
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
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const t0 = Date.now();
  const index = ['# Site screenshots', '', `${new Date().toISOString().slice(0, 16)}Z, from ${dist}`, ''];
  let failed = 0;
  try {
    for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
      for (const s of SHOTS) {
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        const file = `${s.name}-${vpName}.png`;
        try {
          await page.goto(base + s.url, { waitUntil: 'load', timeout: 120000 });
          if (s.hour !== undefined) {
            // the sky island, when it runs (WebGL may be off: then the still sky is what a visitor sees, and is shot)
            for (let i = 0; i < 60; i++) {
              if (await page.evaluate(() => !!window.__sky?.ready?.())) break;
              await new Promise((r) => setTimeout(r, 500));
            }
            await page.evaluate((h) => {
              const sky = window.__sky;
              if (!sky?.ready?.()) return;
              sky.setHour(h);
              sky.frame(0);
              sky.frame(6);
            }, s.hour);
          }
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          await page.evaluate(() => document.fonts.ready);
          // no rAF wait: headless Chromium may run one frame in tens of seconds; settle CSS animations instead
          await page.evaluate(() =>
            Promise.race([
              Promise.all(
                document
                  .getAnimations()
                  .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
                  .map((a) => a.finished.catch(() => {})),
              ),
              new Promise((r) => setTimeout(r, 3000)),
            ]),
          );
          await page.screenshot({ path: path.join(out, file), fullPage: s.hour === undefined });
          const mode = await page.evaluate(() => window.__sky?.mode?.() ?? 'no sky island');
          index.push(`- \`${file}\` ${s.url} (${mode})${errors.length ? ` - page errors: ${errors.length}` : ''}`);
          console.error(`  ${file}`);
        } catch (e) {
          failed += 1;
          index.push(`- \`${file}\` ${s.url} FAILED: ${String(e.message ?? e).split('\n')[0]}`);
          console.error(`  ${file} FAILED: ${e.message ?? e}`);
        }
        await page.close();
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  fs.writeFileSync(path.join(out, 'index.md'), index.join('\n') + '\n');
  console.log(
    `screenshots: ${SHOTS.length * 2 - failed} written to ${out} in ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(2);
});
