// check:story - the console demo (chapter 3) plays from real scrolling, in the built dist. Serves dist/, drives
// Chromium with real wheel events and asserts that the beat index advances through the pinned range and returns when
// scrolling back. It needs only scroll + CSS/JS: it also runs with WebGL off and with the sky scripts blocked.
// Needs a Chromium: playwright-core's own, or CHROMIUM_PATH. Exit 1 on any failed assertion. Not part of npm test.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
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
const { chromium } = await import('playwright-core');
const NOGL = ['--disable-gpu', '--disable-software-rasterizer', '--no-sandbox'];

const state = (p) =>
  p.evaluate(() => {
    const r = document.querySelector('.story');
    const st = document.querySelector('[data-console-track] .ch-stage');
    return {
      y: Math.round(scrollY),
      on: r.classList.contains('cs-on'),
      beat: r.dataset.csBeat ?? null,
      stageTop: st && Math.round(st.getBoundingClientRect().top),
    };
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scenarios = [
  { name: 'desktop 1440x900', vp: [1440, 900], gl: false, play: true },
  { name: 'laptop 1280x650', vp: [1280, 650], gl: false, play: true },
  { name: 'zoom 125% (1152x560 css px)', vp: [1152, 560], gl: false, play: true },
  { name: 'no WebGL (canvas unavailable)', vp: [1440, 900], gl: false, play: true },
  { name: 'sky scripts blocked', vp: [1440, 900], gl: false, block: /sky|engine/i, play: true },
  { name: 'reduced motion', vp: [1440, 900], gl: false, ctx: { reducedMotion: 'reduce' }, play: false },
  { name: 'phone 390', vp: [390, 844], gl: false, play: false },
];
let bad = 0;
for (const s of scenarios.filter((x) => !process.env.ONLY || x.name.includes(process.env.ONLY))) {
  const b = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: NOGL,
  });
  const ctx = await b.newContext({ viewport: { width: s.vp[0], height: s.vp[1] }, ...(s.ctx ?? {}) });
  const p = await ctx.newPage();
  if (s.block)
    await p.route('**/*', (r) => {
      const u = new URL(r.request().url()).pathname;
      return s.block.test(u) && u.endsWith('.js') ? r.abort() : r.continue();
    });
  const errs = [];
  p.on('pageerror', (e) => {
    // a scenario that blocks the sky scripts on purpose expects their import to fail
    if (s.block && /dynamically imported module/.test(String(e))) return;
    errs.push(String(e));
  });
  await p.goto(`${base}/?debug=story${s.gl === false ? '' : '&manual=1'}`, { waitUntil: 'load' });
  await sleep(1500);
  const seen = [];
  let max = -1;
  let mid;
  for (let i = 0; i < 90; i++) {
    await p.mouse.wheel(0, 120 + (i % 3) * 20);
    await sleep(60);
    mid = await state(p);
    if (mid.beat !== null) {
      seen.push(Number(mid.beat));
      max = Math.max(max, Number(mid.beat));
    }
    if (mid.beat === '6' && i > 20) break;
  }
  const pinned = await state(p);
  let back = pinned;
  for (let i = 0; i < 160; i++) {
    await p.mouse.wheel(0, -160);
    await sleep(40);
    back = await state(p);
    if (back.beat === '0' || back.y < 200) break;
  }
  const advanced = new Set(seen).size >= 6 && max === 6;
  const monotonic = seen.every((v, i) => i === 0 || v >= seen[i - 1]);
  const returned = back.beat === '0' || back.beat === null;
  const ok = s.play ? advanced && monotonic && returned && pinned.on : !pinned.on && max === -1;
  if (s.block) errs.length = 0; // the blocked sky island is expected to fail its import
  if (!ok || errs.length) bad++;
  console.log(
    `${ok && !errs.length ? 'ok  ' : 'FAIL'} ${s.name}: beats seen ${[...new Set(seen)].join(',') || 'none'}, pinned=${pinned.on}, back at beat ${back.beat}${errs.length ? ', errors: ' + errs.join('; ') : ''}`,
  );
  await b.close();
}

// Scrolling inside the story. A wheel, a key or a touch over the frame must just move the page, and nothing inside
// the frame may be a scroll container (a trap would swallow the wheel). Also: the end marker the sections after the
// story follow, and the dark variable they sit on.
if (!process.env.ONLY || 'scroll'.includes(process.env.ONLY)) {
  const b = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: NOGL,
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(`${base}/`, { waitUntil: 'load' });
  await sleep(1500);
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push(ok);
    console.log(`${ok ? 'ok  ' : 'FAIL'} scroll: ${name}${extra ? ' (' + extra + ')' : ''}`);
  };
  await p.evaluate(() => {
    const t = document.querySelector('[data-console-track]');
    scrollTo(0, Math.round(t.getBoundingClientRect().top + scrollY + 600));
  });
  await sleep(400);
  const centre = await p.evaluate(() => {
    const r = document.querySelector('.console-frame').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  const y0 = () => p.evaluate(() => Math.round(scrollY));
  let a = await y0();
  await p.mouse.move(centre.x, centre.y);
  for (let i = 0; i < 5; i++) await p.mouse.wheel(0, 120);
  await sleep(300);
  let c = await y0();
  check('wheel over the frame moves the page', c > a, `${a} to ${c}`);
  const traps = await p.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('.cf, .cf *')) {
      const cs = getComputedStyle(el);
      if (/auto|scroll/.test(cs.overflowX + cs.overflowY) || cs.overscrollBehaviorY !== 'auto')
        bad.push(el.className || el.tagName);
    }
    return bad.slice(0, 5);
  });
  check('nothing inside the frame is a scroll container or traps the wheel', traps.length === 0, traps.join(' | '));
  for (const key of ['PageDown', 'Space', 'ArrowDown']) {
    await p.mouse.click(centre.x, centre.y); // the frame is inert while the story plays: the click lands on the page
    a = await y0();
    await p.keyboard.press(key === 'Space' ? ' ' : key);
    await sleep(500);
    c = await y0();
    check(`${key} with focus at the frame scrolls`, c > a, `${a} to ${c}`);
  }
  // touch needs a touch-scrolling page: a mobile-emulating context at the same 1440x900 so the story still plays
  const tctx = await b.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true, isMobile: true });
  const tp = await tctx.newPage();
  await tp.goto(`${base}/`, { waitUntil: 'load' });
  await sleep(1500);
  await tp.evaluate(() => {
    const t = document.querySelector('[data-console-track]');
    scrollTo(0, Math.round(t.getBoundingClientRect().top + scrollY + 600));
  });
  await sleep(400);
  const cdp = await tctx.newCDPSession(tp);
  a = await tp.evaluate(() => Math.round(scrollY));
  const touchY = Math.round(centre.y);
  for (const [t, yy] of [
    ['touchStart', touchY],
    ['touchMove', touchY - 60],
    ['touchMove', touchY - 160],
    ['touchMove', touchY - 300],
    ['touchEnd', null],
  ]) {
    await cdp.send('Input.dispatchTouchEvent', { type: t, touchPoints: yy === null ? [] : [{ x: centre.x, y: yy }] });
    await sleep(40);
  }
  await sleep(600);
  c = await tp.evaluate(() => Math.round(scrollY));
  check('a touch drag over the frame scrolls the page', c > a, `${a} to ${c}`);
  const end = await p.evaluate(() => ({
    has: !!document.getElementById('story-end'),
    v: getComputedStyle(document.querySelector('.story')).getPropertyValue('--after-story-bg').trim(),
  }));
  check('#story-end exists and --after-story-bg is defined', end.has && end.v.length > 0, end.v);
  if (results.includes(false)) bad++;
  await b.close();
}
srv.close();
process.exit(bad ? 1 : 0);
