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
      u: Number(r.dataset.csU ?? 0),
      t: Number(r.style.getPropertyValue('--cs-t') || 0),
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
  // The scroll STARTS the beats, a player runs them on its own clock (src/story/console.ts): scroll quickly to the end of
  // the story, then give the player time to play what was queued. Real wheel events, real time.
  const seen = [];
  let max = -1;
  let mid;
  const note = (m) => {
    if (m.beat !== null) {
      seen.push(Number(m.beat));
      max = Math.max(max, Number(m.beat));
    }
  };
  for (let i = 0; i < 160; i++) {
    await p.mouse.wheel(0, 120 + (i % 3) * 20);
    await sleep(60);
    mid = await state(p);
    note(mid);
    if (mid.t >= 0.985) break;
  }
  for (let i = 0; i < (s.play ? 400 : 0); i++) {
    mid = await state(p);
    note(mid);
    if (mid.beat === '6' && mid.u >= 0.99) break;
    await sleep(250);
  }
  const pinned = await state(p);
  let back = pinned;
  for (let i = 0; i < 200; i++) {
    await p.mouse.wheel(0, -160);
    await sleep(40);
    back = await state(p);
    if (back.t <= 0.001 || back.y < 200) break;
  }
  for (let i = 0; i < 200 && s.play && back.beat !== '0' && back.beat !== null; i++) {
    await sleep(250);
    back = await state(p);
  }
  const advanced = new Set(seen).size >= 6 && max === 6 && pinned.beat === '6';
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

// Once started, an animation plays to its end WITHOUT STOPPING: one wheel notch past the dock starts the sign-in; after the
// scroll has stopped the player must keep moving (more than a second of it), reach the first rest point, and a jerky
// reversed scroll must not move it backwards while it plays.
if (!process.env.ONLY || 'continuity'.includes(process.env.ONLY)) {
  const b = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: NOGL,
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${base}/?debug=story`, { waitUntil: 'load' });
  await sleep(1500);
  await p.evaluate(() => {
    const t = document.querySelector('[data-console-track]');
    scrollTo(0, Math.round(t.getBoundingClientRect().top + scrollY) - 40); // just before the dock
  });
  await sleep(500);
  let st = await state(p);
  for (let i = 0; i < 40 && st.t < 0.02; i++) {
    await p.mouse.wheel(0, 40);
    await sleep(30);
    st = await state(p);
  }
  const t0 = Date.now();
  const us = [];
  let jerk = false;
  while (Date.now() - t0 < 3200) {
    await sleep(150);
    if (!jerk && Date.now() - t0 > 700) {
      jerk = true; // a small jerk backwards while it plays
      await p.mouse.wheel(0, -60);
    }
    us.push((await state(p)).u);
  }
  const moving = us.filter((u, i) => i > 0 && u > us[i - 1]).length;
  const never_back = us.every((u, i) => i === 0 || u >= us[i - 1] - 1e-9);
  const ok = st.beat === '0' && us.at(-1) >= 0.2 && moving >= 6 && never_back;
  if (!ok) bad++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} continuity: after the scroll stopped the sign-in kept playing (u ${us[0]} to ${us.at(-1)}, ${moving} advances, never backwards: ${never_back})`,
  );
  await b.close();
}

// Nothing is ever dropped. Jump straight to the end of the pinned track (an anchor link, the End key, a fast fling) and
// even past it: the player must still run every beat, in order, faster but whole, and finish within a bounded time, WITHOUT ever blocking the scroll (the window is held fixed behind the next section until
// it has finished); the
// last beat's typed command is complete when it does. Scrolling back afterwards drops nothing already played.
if (!process.env.ONLY || 'jump'.includes(process.env.ONLY)) {
  const b = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: NOGL,
  });
  for (const past of [false, true]) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(`${base}/?debug=story`, { waitUntil: 'load' });
    await sleep(1500);
    await p.evaluate(() => {
      const r = document.querySelector('.story');
      window.__beats = [r.dataset.csBeat ?? '0'];
      new MutationObserver(() => {
        const v = r.dataset.csBeat;
        if (v !== undefined && window.__beats.at(-1) !== v) window.__beats.push(v);
      }).observe(r, { attributes: true, attributeFilter: ['data-cs-beat'] });
    });
    await p.evaluate((past) => {
      const t = document.querySelector('[data-console-track]');
      const top = Math.round(t.getBoundingClientRect().top + scrollY);
      scrollTo(0, past ? top + t.offsetHeight + innerHeight * 0.3 : top + t.offsetHeight - innerHeight); // in one jump
    }, past);
    const t0 = Date.now();
    let s;
    let done = false;
    const tops = [];
    const ys = [];
    const target = await p.evaluate(() => scrollY);
    let nudged = false;
    while (Date.now() - t0 < 40000) {
      s = await state(p);
      const g = await p.evaluate(() => ({
        y: scrollY,
        top: document.querySelector('[data-console-track] .ch-stage').getBoundingClientRect().top,
        curtain: document.querySelector('.story').dataset.csCurtain,
      }));
      if (g.curtain) {
        tops.push(g.top);
        ys.push(g.y);
        if (!nudged) {
          // free scrolling while the demo finishes: the wheel must move the page at once, the window must not follow
          nudged = true;
          await p.mouse.move(700, 450);
          await p.mouse.wheel(0, 120);
          await sleep(120);
        }
      }
      if (s.beat === '6' && s.u >= 0.99) {
        done = true;
        break;
      }
      await sleep(200);
    }
    const took = Date.now() - t0;
    const beats = await p.evaluate(() => window.__beats);
    const typed = await p.evaluate(() => {
      const el = document.querySelector('.cf-cmd .cf-typed');
      return !el || el.textContent === (el.dataset.type ?? '');
    });
    const inOrder = beats.join(',') === '0,1,2,3,4,5,6';
    // never held: scrollY follows the visitor (it only ever goes forward from the jump), and while the window is pinned
    // behind the curtain it does not move in the viewport
    const still = tops.length === 0 || Math.max(...tops) - Math.min(...tops) <= 1;
    const free = ys.length === 0 || (Math.min(...ys) >= target - 2 && (!nudged || Math.max(...ys) >= target + 100));
    await sleep(300);
    const y0 = await p.evaluate(() => scrollY);
    await p.mouse.move(700, 450);
    for (let i = 0; i < 5; i++) await p.mouse.wheel(0, 200);
    await sleep(600);
    const y1 = await p.evaluate(() => scrollY);
    const released = y1 > y0 + 200 && (await p.evaluate(() => !document.querySelector('.story').dataset.csCurtain));
    const ok = done && inOrder && typed && took < 40000 && still && free && released && (!past || ys.length > 0);
    if (!ok) bad++;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} jump to the end${past ? ' and past it' : ''}: beats ${beats.join(',')} in ${took} ms, last command typed in full: ${typed}, stage still behind the curtain: ${still} (${tops.length} samples), scroll free: ${free} (y ${ys[0]}..${ys.at(-1)}), released: ${released}`,
    );
    await ctx.close();
  }
  // a jump to the very bottom of the page: only the end block and the footer are on screen, so the console window must not
  // be visible anywhere (it is released at once, the rest of the demo plays on unseen), and a resize must never leave it fixed
  {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(`${base}/?debug=story`, { waitUntil: 'load' });
    await sleep(1500);
    await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await sleep(700);
    const seen = async () =>
      p.evaluate(() => {
        const st = document.querySelector('[data-console-track] .ch-stage');
        const root = document.querySelector('.story');
        const cs = getComputedStyle(st);
        const r = st.getBoundingClientRect();
        const visible = r.bottom > 0 && r.top < innerHeight && +cs.opacity > 0.02 && cs.position === 'fixed';
        const top = document.elementFromPoint(innerWidth / 2, Math.min(innerHeight - 2, Math.max(2, r.top + 40)));
        return { visible, covered: !top || !st.contains(top), curtain: root.dataset.csCurtain ?? '' };
      });
    const check = (name, ok, extra = '') => {
      if (!ok) bad++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} curtain: ${name}${extra ? ' (' + extra + ')' : ''}`);
    };
    const a = await seen();
    check('jump to the page bottom: the console window is not on screen', !a.visible && a.covered, JSON.stringify(a));
    await p.setViewportSize({ width: 600, height: 900 });
    await sleep(600);
    await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await sleep(500);
    const c = await seen();
    check('after a resize the window is not left fixed on screen', !c.visible && c.curtain === '', JSON.stringify(c));
    await ctx.close();
  }
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
    !!lcp && /^(A$|pill|.*ch-)/.test(lcp.el ?? '') && lcp.t <= 4000, // the hero's pill, its badge, or a nav link of the bare bar: both are revealed with the assembled page
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
