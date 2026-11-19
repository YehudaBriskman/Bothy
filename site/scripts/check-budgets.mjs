// Byte budgets for the built site (build plan S11; sky design "Budgets").
//
// What a visitor downloads, gzip-compressed the way a static host sends it, measured from dist/ after `npm run build`:
//   - first load of every route: its HTML, the scripts and stylesheets it names, its non-lazy images, and the one
//     still-sky photograph its stylesheet picks (the largest -desk file for a desktop, the largest -phone file for a
//     phone, because the hour decides which one and the budget must hold at every hour);
//   - the lazy sky island (every chunk reached only through a dynamic import()), which has its own cap and is NOT
//     part of first load: the page is complete without it; the brand splash (src/brand/splash.ts, a lazy chunk
//     fetched once per session on the home page) is counted apart from it in its own lazy row;
//   - per asset class: entry script, all scripts, the stylesheet, each HTML class, the search index, the dev pages.
//
// Limits are the sizes measured on 2026-11-18 (main at 5f6bd95) plus about 15 % headroom, rounded up to the KB.
// The sky design's production first-paint budgets (120 KB desktop, 60 KB phone) are shown beside the gate as an
// advisory column: the gate is the ratchet, the design budget is the ceiling it must stay under.
// To move a limit, change it here in the same PR that grows the page, and say why in the commit.
//
//   node scripts/check-budgets.mjs            table, exit 1 on any row over its limit
//   node scripts/check-budgets.mjs --json     the measurements as JSON (for CI summaries)
//   node scripts/check-budgets.mjs --propose  the table plus a limit proposal (measured + 15 %) for every row
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const KB = 1024;

/** Gate limits in gzip KB (raw KB where the row says raw). Measured value in the comment. */
// 2026-11-19 sections 21-24 (below the fold, lazy player): css +4.0 KB (new-sections.css), home html about +5 KB, js +0.7 KB
// (new-sections.ts, lazy). Limits moved to the measured total + about 1 KB; the 60 KB phone advisory was already exceeded.
export const LIMITS = {
  'first load / desktop': 92, // sections 21-24 (+4.0 KB css in every page, +5 KB home html; below the fold, player lazy): 84.4 with chosen.css (+2 KB css: capsule, hero words, camera, clouds, outline wordmark); was 72.8
  'first load / phone': 77, // sections 21-24 (+4.0 KB css in every page, +5 KB home html; below the fold, player lazy): 69.4 with chosen.css (+1.2 KB over main's 68.2); // 68.2 after sections 05-12 (+3.4 KB css) merged with the inner pages' css; was 57.8 - the design's 60 is the real ceiling here: 2.2 KB left
  //   59.9 on main at 229577e; 61.8 with the BothyBox lockup in every page's HTML (+0.6), the Cube favicon and touch
  //   icon (+0.8), the splash gate in the entry (+0.3) and its CSS (+0.1): over the design's 60, flagged in the PR. 62.2 with
  //   the intro: its gate inlined in the home page's head and styles/intro.css (+0.4).
  'first load, worst other route / desktop': 84, // sections 21-24 (+4.0 KB css in every page, +5 KB home html; below the fold, player lazy): 69.6 (docs/configuring)
  'first load, worst other route / phone': 69, // sections 21-24 (+4.0 KB css in every page, +5 KB home html; below the fold, player lazy): 65.1 with chosen.css (+1 KB); // 64.1 (inner.css and home-sections.css are both in every page's css); was 54.6
  'html / home': 21, // sections 21-24 (+4.0 KB css in every page, +5 KB home html; below the fold, player lazy): 16.0; 13.5 before the sections 05-12 redesign (tab panels, install rail, two example terminals, big-word row; the long proof lists left for the Install page)
  'html / page (max)': 12, // 10.1 changelog
  'html / doc (max)': 12, // 10.4 docs/configuring
  'js / entry (+ static imports)': 4, // 3.1
  'js / lazy sky island': 23, // 21.1 with the console camera (story/lens.ts, +1.5) on top of main's 18.8 + inner pages; // 18.8 (mount, progress, enhance-sky, footmark, and home-sections: size tabs, count-up, rail, typed terminals, 1.4 KB)
  // The first-visit splash (owner-chosen Cube loader, 2026-11-18): lazy, once per session, never with reduced motion.
  'js / lazy brand splash': 4, // 3.3
  'js / all shipped scripts': 30, // 28.0 with the camera (+1.5 over main's 25.5, +inner pages); // 25.5; 22.4 with the splash (18.9 + 3.3 splash + 0.3 its gate in the entry)
  'css / all stylesheets': 33, // 30.5: main's 27.7 plus styles/chosen.css (+1.8) and the outline wordmark; // 27.7; 24.3 before home-sections.css (3.4 KB: hill, rail, band, photo drift, reveal states)
  'images / lazy on home': 121, // 104.4 (three scene backdrops and the <picture> still)
  'search index': 43, // 37.0
  'dev pages (sky-spike, scene-mock, brand-mock, section-mock), raw': 1150, // 994.2 (748, then + section-mock gallery 167.5, 2026-11-19)
  'share cards and icons (og/, icons, manifest), raw': 343, // 297.9 (S10, 2026-11-18)
  'dist total without share cards and icons, raw': 2560, // 1889; 1905.5 after S10; 2216.2 with the section-mock gallery (dev page, 2026-11-19)
};

/** The sky design's production first-paint budgets (website-sky-design.md, "Budgets"). Advisory. */
export const DESIGN = { 'first load / desktop': 120, 'first load / phone': 60 };

const gz = (buf) => gzipSync(buf).length; // zlib level 6: what nginx, Pages and most CDNs send

function walk(d, out = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))?.[1] ?? null;

/** Measure a built dist/. Returns { rows: [{ name, kb, limit, design?, detail }], notes }. */
export function measure(dist, limits = LIMITS) {
  const base = '/';
  const cache = new Map();
  const file = (url) => {
    const rel = decodeURIComponent(url.split(/[?#]/)[0].replace(/^\//, ''));
    return join(dist, rel);
  };
  const size = (path) => {
    if (!cache.has(path)) {
      const b = readFileSync(path);
      cache.set(path, { raw: b.length, gz: gz(b) });
    }
    return cache.get(path);
  };
  const urlOf = (path) => base + relative(dist, path).split(sep).join('/');

  // A script's static imports (first load) and dynamic imports (lazy), followed transitively.
  const jsGraph = (entry) => {
    const stat = new Set();
    const lazy = new Set();
    const visit = (p, isLazy) => {
      const set = isLazy ? lazy : stat;
      if (set.has(p) || (isLazy && stat.has(p))) return;
      set.add(p);
      const t = readFileSync(p, 'utf8');
      const dir = dirname(p);
      for (const m of t.matchAll(/(?:^|[;}\s])import\s*(?:[\w${},*\s]+from\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g))
        visit(join(dir, m[1]), isLazy);
      for (const m of t.matchAll(/import\(\s*[`"'](\.{1,2}\/[^`"']+\.js)[`"']\s*\)/g)) visit(join(dir, m[1]), true);
    };
    visit(entry, false);
    for (const s of stat) lazy.delete(s);
    return { stat, lazy };
  };

  // The still sky: a stylesheet names every hour's photograph; a page loads one per viewport class.
  const cssImages = (cssPath) => {
    const t = readFileSync(cssPath, 'utf8');
    const urls = [...t.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)]
      .map((m) => m[1])
      .filter((u) => !u.startsWith('data:'));
    const paths = [...new Set(urls)].map(file).filter((p) => existsSync(p));
    const pick = (re) => Math.max(0, ...paths.filter((p) => re.test(p)).map((p) => size(p).gz));
    const other = paths.filter((p) => !/-(desk|phone)\.\w+$/.test(p));
    return {
      desktop: pick(/-desk\.\w+$/),
      phone: pick(/-phone\.\w+$/),
      other: other.reduce((n, p) => n + size(p).gz, 0),
    };
  };

  const routes = JSON.parse(readFileSync(join(dist, '..', 'dist-prerender', 'routes.json'), 'utf8')).files;
  const lazyIsland = new Set();
  const lazyHomeImages = new Set();
  const firstLoad = [];
  for (const r of routes) {
    const htmlPath = join(dist, r);
    const html = readFileSync(htmlPath, 'utf8');
    const parts = { html: size(htmlPath).gz, js: 0, css: 0, img: 0, sky: { desktop: 0, phone: 0 } };
    const seen = new Set();
    for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
      const src = attr(m[0], 'src');
      if (!src || /^https?:/.test(src)) continue;
      const g = jsGraph(file(src));
      for (const p of g.stat) if (!seen.has(p) && seen.add(p)) parts.js += size(p).gz;
      for (const p of g.lazy) lazyIsland.add(p);
    }
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      const rel = (attr(m[0], 'rel') ?? '').toLowerCase();
      const href = attr(m[0], 'href');
      if (!href || /^https?:/.test(href) || !/stylesheet|modulepreload|preload|icon/.test(rel)) continue;
      const p = file(href);
      if (!existsSync(p) || seen.has(p)) continue;
      seen.add(p);
      if (rel.includes('stylesheet')) {
        parts.css += size(p).gz;
        const ci = cssImages(p);
        parts.sky.desktop = Math.max(parts.sky.desktop, ci.desktop);
        parts.sky.phone = Math.max(parts.sky.phone, ci.phone);
        parts.img += ci.other;
      } else if (rel.includes('modulepreload') || href.endsWith('.js')) parts.js += size(p).gz;
      else parts.img += size(p).gz; // icon, preloaded image
    }
    for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
      const src = attr(m[0], 'src');
      if (!src || src.startsWith('data:') || /^https?:/.test(src)) continue;
      const p = file(src);
      if (!existsSync(p)) continue;
      if (/loading="lazy"/i.test(m[0])) {
        if (r === 'index.html') lazyHomeImages.add(p);
      } else if (!seen.has(p) && seen.add(p)) parts.img += size(p).gz;
    }
    const total = parts.html + parts.js + parts.css + parts.img;
    firstLoad.push({ route: r, ...parts, desktop: total + parts.sky.desktop, phone: total + parts.sky.phone });
  }

  const rows = [];
  const add = (name, bytes, detail = '') =>
    rows.push({ name, kb: bytes / KB, limit: limits[name], design: DESIGN[name], detail });

  const home = firstLoad.find((f) => f.route === 'index.html');
  const fmt = (f) =>
    `html ${(f.html / KB).toFixed(1)} + js ${(f.js / KB).toFixed(1)} + css ${(f.css / KB).toFixed(1)} + img ${(f.img / KB).toFixed(1)}`;
  add('first load / desktop', home.desktop, `${fmt(home)} + sky ${(home.sky.desktop / KB).toFixed(1)}`);
  add('first load / phone', home.phone, `${fmt(home)} + sky ${(home.sky.phone / KB).toFixed(1)}`);
  const others = firstLoad.filter((f) => f.route !== 'index.html');
  const worstD = others.reduce((a, b) => (b.desktop > a.desktop ? b : a));
  const worstP = others.reduce((a, b) => (b.phone > a.phone ? b : a));
  add('first load, worst other route / desktop', worstD.desktop, worstD.route);
  add('first load, worst other route / phone', worstP.phone, worstP.route);

  add('html / home', home.html);
  const isDoc = (r) => r.startsWith('docs/');
  const maxOf = (list) => list.reduce((a, b) => (b.html > a.html ? b : a));
  const pages = others.filter((f) => !isDoc(f.route));
  const docs = others.filter((f) => isDoc(f.route));
  if (pages.length) add('html / page (max)', maxOf(pages).html, maxOf(pages).route);
  if (docs.length) add('html / doc (max)', maxOf(docs).html, maxOf(docs).route);

  add('js / entry (+ static imports)', Math.max(...firstLoad.map((f) => f.js)));
  const isSplash = (p) => /^splash-[\w-]{8}\.js$/.test(posix.basename(urlOf(p)));
  const island = [...lazyIsland].filter((p) => !isSplash(p));
  add(
    'js / lazy sky island',
    island.reduce((n, p) => n + size(p).gz, 0),
    island.map((p) => posix.basename(urlOf(p)).replace(/-[\w-]{8}\.js$/, '')).join(', '),
  );
  const splash = [...lazyIsland].filter(isSplash);
  if (splash.length)
    add(
      'js / lazy brand splash',
      splash.reduce((n, p) => n + size(p).gz, 0),
    );

  const all = walk(dist);
  const inDir = (p, d) => p.startsWith(join(dist, d) + sep);
  const shipped = all.filter(
    (p) => !inDir(p, 'sky-spike') && !inDir(p, 'scene-mock') && !inDir(p, 'brand-mock') && !inDir(p, 'section-mock'),
  );
  const sum = (list) => list.reduce((n, p) => n + size(p).gz, 0);
  add('js / all shipped scripts', sum(shipped.filter((p) => p.endsWith('.js'))));
  add('css / all stylesheets', sum(shipped.filter((p) => p.endsWith('.css'))));
  add(
    'images / lazy on home',
    [...lazyHomeImages].reduce((n, p) => n + size(p).gz, 0),
    `${lazyHomeImages.size} file(s)`,
  );
  const idx = join(dist, 'search-index.json');
  if (existsSync(idx)) add('search index', size(idx).gz);
  const dev = all.filter(
    (p) => inDir(p, 'sky-spike') || inDir(p, 'scene-mock') || inDir(p, 'brand-mock') || inDir(p, 'section-mock'),
  );
  add(
    'dev pages (sky-spike, scene-mock, brand-mock, section-mock), raw',
    dev.reduce((n, p) => n + size(p).raw, 0),
    `${dev.length} files`,
  );
  // Share cards, home-screen icons and the manifest: fetched by a link unfurler or an "add to home screen", never by
  // a page load. Their own row here; each OG card is also capped by check:seo (120 KB).
  const share = all.filter(
    (p) => inDir(p, 'og') || /^(apple-touch-icon\.png|icon-\d+\.png|site\.webmanifest)$/.test(relative(dist, p)),
  );
  add(
    'share cards and icons (og/, icons, manifest), raw',
    share.reduce((n, p) => n + size(p).raw, 0),
    `${share.length} files`,
  );
  const visitor = all.filter((p) => !share.includes(p));
  add(
    'dist total without share cards and icons, raw',
    visitor.reduce((n, p) => n + size(p).raw, 0),
    `${visitor.length} files`,
  );
  return { rows, firstLoad };
}

export function verdicts(rows) {
  return rows.map((r) => ({
    ...r,
    over: r.limit !== undefined && r.kb > r.limit,
    unbudgeted: r.limit === undefined,
    overDesign: r.design !== undefined && r.kb > r.design,
  }));
}

function table(rows, propose) {
  const head = ['budget', 'KB', 'limit', 'used', 'design', ''];
  if (propose) head.push('proposed');
  const lines = rows.map((r) => {
    const cells = [
      r.name,
      r.kb.toFixed(1),
      r.limit === undefined ? '-' : String(r.limit),
      r.limit === undefined ? '-' : `${Math.round((100 * r.kb) / r.limit)}%`,
      r.design === undefined ? '' : String(r.design),
      r.over ? 'OVER' : r.unbudgeted ? 'NO LIMIT' : r.overDesign ? 'over design' : 'ok',
    ];
    if (propose) cells.push(String(Math.ceil(r.kb * 1.15)));
    return { cells, detail: r.detail };
  });
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l.cells[i].length)));
  const fmtRow = (c) => c.map((x, i) => (i === 0 ? x.padEnd(w[i]) : x.padStart(w[i]))).join('  ');
  console.log(fmtRow(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const l of lines) console.log(fmtRow(l.cells) + (l.detail ? `   ${l.detail}` : ''));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  if (!existsSync(join(dist, 'index.html'))) {
    console.error('check-budgets: no dist/index.html - run `npm run build` first');
    process.exit(2);
  }
  const rows = verdicts(measure(dist).rows);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log('check-budgets: gzip KB per route and asset class (limits in scripts/check-budgets.mjs)\n');
    table(rows, process.argv.includes('--propose'));
  }
  const bad = rows.filter((r) => r.over || r.unbudgeted);
  for (const r of rows.filter((x) => x.overDesign))
    console.log(`::warning::${r.name}: ${r.kb.toFixed(1)} KB is over the sky design's ${r.design} KB budget`);
  for (const r of bad)
    console.log(
      `::error::${r.name}: ${r.kb.toFixed(1)} KB ${r.over ? `over its ${r.limit} KB limit` : 'has no limit in LIMITS'}`,
    );
  if (bad.length) process.exit(1);
  console.log('\ncheck-budgets: ok');
}
