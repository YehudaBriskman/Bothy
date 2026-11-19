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
// The first-visit intro (src/brand/splash.ts, splash-gate.ts, styles/intro.css). Automation never gets it unasked
// (navigator.webdriver), so these scenarios either force it with ?splash=1 or pretend to be a person. The page opens
// on the sky alone (header and hero at opacity 0), the Cube opens and flies into the header while the page assembles
// round it, and by about 3 s everything is at opacity 1 again. It must not move anything (CLS 0, the same rects), must
// not take a click, must jump to the end on a key, must never hide anything with reduced motion or on a repeat visit,
// must show the page by 3.5 s even when its chunk never arrives, and must not hold LCP back past the assembly.
if (!process.env.ONLY || 'splash'.includes(process.env.ONLY)) {
  const b = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: NOGL,
  });
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push(ok);
    console.log(`${ok ? 'ok  ' : 'FAIL'} splash: ${name}${extra ? ' (' + extra + ')' : ''}`);
  };
  const observe = () => {
    window.__cls = 0;
    window.__lcp = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        window.__lcp.push({
          el: e.element ? e.element.className || e.element.tagName : null,
          t: e.startTime,
          size: e.size,
        });
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  };
  const person = () => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
  // the layout boxes (offsets, which a `translate` does not change: the rise is a paint effect, not a shift)
  const rects = (p) =>
    p.evaluate(() =>
      ['.site-nav .brand', '#main h1', '.ch-sky .ch-actions', '.ch-flow .ch-stage'].map((q) => {
        let el = document.querySelector(q);
        if (!el) return 'missing';
        const box = [0, 0, el.offsetWidth, el.offsetHeight];
        for (; el; el = el.offsetParent) [box[0], box[1]] = [box[0] + el.offsetLeft, box[1] + el.offsetTop];
        return box.join(',');
      }),
    );
  // what a visitor sees of the header and the hero: the lowest computed opacity among them
  const ITEMS = [
    '.site-nav .brand',
    '.site-nav .primary',
    '.site-nav .tools',
    '#main h1',
    '.ch-sky .ch-lede',
    '.ch-sky .ch-actions',
  ];
  const seen = (p) =>
    p.evaluate((qs) => Math.min(...qs.map((q) => Number(getComputedStyle(document.querySelector(q)).opacity))), ITEMS);
  // poll by hand: this box's headless Chromium has no frame clock, so waitForFunction's rAF polling would stall
  const until = async (p, fn, ms, arg) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await p.evaluate(fn, arg)) return Date.now() - t0;
      await sleep(50);
    }
    return -1;
  };
  const present = () => !!document.querySelector('.bb-splash');
  const assembled = (qs) =>
    !document.querySelector('.bb-splash') &&
    !document.documentElement.classList.contains('bb-intro') &&
    qs.every((q) => getComputedStyle(document.querySelector(q)).opacity === '1');

  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(observe);
  let p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${base}/?splash=1`, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  const start = await seen(p);
  check(
    'at the start the header and the hero are invisible (opacity 0), the sky alone',
    start === 0,
    `min opacity ${start}`,
  );
  const shown = await until(p, present, 3000);
  check('?splash=1 shows the overlay', shown >= 0);
  if (shown >= 0) {
    const during = await rects(p);
    const o = await p.evaluate(() => {
      const el = document.querySelector('.bb-splash');
      const cs = getComputedStyle(el);
      const hit = document.elementFromPoint(innerWidth / 2, innerHeight * 0.42);
      return { aria: el.getAttribute('aria-hidden'), pe: cs.pointerEvents, pos: cs.position, hit: !el.contains(hit) };
    });
    check(
      'the overlay is aria-hidden, fixed and takes no pointer',
      o.aria === 'true' && o.pe === 'none' && o.pos === 'fixed' && o.hit,
      JSON.stringify(o),
    );
    const gone = await until(p, assembled, 3600, ITEMS);
    check(
      'assembled by itself within 3.5 s: overlay gone, everything at opacity 1',
      gone >= 0,
      `${Date.now() - t0} ms`,
    );
    const after = await rects(p);
    const c = await p.evaluate(() => window.__cls);
    check(
      'no layout shift: CLS 0 and the same rects while it plays and after',
      c === 0 && during.join() === after.join(),
      `CLS ${c}; ${during.join(' | ')} vs ${after.join(' | ')}`,
    );
    const left = await p.evaluate((qs) => qs.flatMap((q) => document.querySelector(q).getAnimations()).length, ITEMS);
    check('no animation is left holding a style', left === 0, `${left} left`);
  }
  check('no page errors', errs.length === 0, errs.join('; '));

  // a key jumps straight to the assembled page
  p = await ctx.newPage();
  await p.goto(`${base}/?splash=1`, { waitUntil: 'load' });
  if ((await until(p, present, 3000)) >= 0) {
    await sleep(200);
    await p.keyboard.press('Shift');
    const gone = await until(p, assembled, 1000, ITEMS);
    check('a key jumps to the assembled page at once', gone >= 0 && gone < 500, `${gone} ms`);
  } else check('a key jumps to the assembled page at once', false, 'never shown');

  // a person (no webdriver flag) gets it once per session; the reload sees the page from the start
  const pc = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await pc.addInitScript(person);
  await pc.addInitScript(observe);
  p = await pc.newPage();
  await p.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  const hidden = await seen(p);
  const first = await until(p, present, 3000);
  await until(p, assembled, 3600, ITEMS);
  // LCP. The sky's still cannot be the LCP element: Chrome ignores an image that covers the whole viewport (measured:
  // not even a plain background on .sky-still is reported), so the normal page's LCP is the hero's big line. Hidden
  // text is reported when it is revealed, so the intro moves LCP to the reveal: it must land by the time the page is
  // assembled (in a browser with a frame clock about 1.8 s; this box's headless one paints only at the end).
  const lcp = await p.evaluate(() => window.__lcp.at(-1));
  check(
    'LCP on a first visit lands by the time the page is assembled',
    !!lcp && /^(A$|.*ch-)/.test(lcp.el ?? '') && lcp.t <= 4000, // the hero's badge, or a nav link of the bare bar: both are revealed with the assembled page
    lcp ? `${lcp.el} at ${Math.round(lcp.t)} ms, ${lcp.size} px²` : 'no entry',
  );
  await p.reload({ waitUntil: 'domcontentloaded' });
  const repeat = await seen(p);
  await sleep(1200);
  const again = await p.evaluate(present);
  check(
    'a first visit hides and plays, a reload in the same session shows the page at once',
    hidden === 0 && first >= 0 && repeat === 1 && !again,
    `first: opacity ${hidden}, overlay at ${first} ms; reload: opacity ${repeat}, overlay ${again}`,
  );

  // the failsafe: the splash chunk hangs (never answers) or fails, and the page still shows by 3.5 s
  for (const mode of ['hangs', 'fails']) {
    const fc = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await fc.addInitScript(person);
    await fc.route(/\/splash-[\w-]+\.js$/, (r) => (mode === 'fails' ? r.abort() : new Promise(() => {})));
    p = await fc.newPage();
    await p.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    const t1 = Date.now();
    const at0 = await seen(p);
    const ok = await until(p, assembled, 4000, ITEMS);
    const ms = ok >= 0 ? Date.now() - t1 : -1;
    check(
      `failsafe: the splash chunk ${mode}, the page shows by 3.5 s`,
      // a hung chunk leaves it to the head script's 3.5 s timer; a failed one is undone by enhance.ts at once
      (mode === 'fails' || at0 === 0) && ok >= 0 && ms <= 3700,
      `opacity ${at0} at first, all visible after ${ms} ms`,
    );
    await fc.close();
  }

  // reduced motion: nothing hidden, not even forced, and the chunk is never fetched
  const rm = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  p = await rm.newPage();
  let fetched = false;
  p.on('request', (r) => (fetched ||= /\/splash-[\w-]+\.js$/.test(r.url())));
  await p.goto(`${base}/?splash=1`, { waitUntil: 'domcontentloaded' });
  const rmSeen = await seen(p);
  await sleep(1200);
  check(
    'reduced motion: everything visible at once, no overlay and no splash chunk, even with ?splash=1',
    rmSeen === 1 && !(await p.evaluate(present)) && !fetched,
    `opacity ${rmSeen}`,
  );

  // no script: the class is never set, the page is whole
  const nj = await b.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
  p = await nj.newPage();
  await p.goto(`${base}/?splash=1`, { waitUntil: 'load' });
  const njSeen = await seen(p).catch(() => -1);
  check('no script: everything visible', njSeen === 1, `opacity ${njSeen}`);
  if (results.includes(false)) bad++;
  await b.close();
}

srv.close();
process.exit(bad ? 1 : 0);
