// A Lighthouse-like audit of the built site that needs no browser and no network (build plan S11, s9).
// Only the cheap, deterministic audits: the ones Lighthouse would run on the HTML alone and that never flake.
//
// Every route the prerender wrote (dist-prerender/routes.json):
//   - <html lang>, <meta charset>, <meta name="viewport">, a non-empty <title> unique across routes,
//     a non-empty <meta name="description"> (at most 300 characters);
//   - canonical: exactly one, equal to origin + the route's path, when the build has a public origin;
//   - exactly one heading of level 1 (aria-level wins over the tag: the rendered console's <h1 aria-level="3">
//     is a level-3 heading to a screen reader), and no level skipped going down (h2 then h4);
//   - no duplicate id (a fragment link would land on the first one only);
//   - target="_blank" links carry rel="noopener" (or noreferrer).
// Every HTML page in dist/, the dev pages included:
//   - every <img> has an alt attribute (alt="" is a decision, a missing alt is not) and width and height, unless
//     it is a full-bleed backdrop listed in BACKDROPS (sized by CSS, object-fit: cover, so it cannot shift layout).
// Every text file in dist/ (HTML, CSS, JS, JSON manifests):
//   - no request to another origin: no src/srcset/poster, <link href> (other than canonical/alternate), CSS url()
//     or @import, or http(s) string in a script, to an origin outside ALLOWED. A page that loads nothing from
//     elsewhere cannot be render-blocked by a third party and works offline. Ordinary <a href> links are navigation,
//     not requests, and are allowed.
//
//   node scripts/check-meta.mjs     exit 1 and a list of problems on any failure
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Origins a built file may name outside a navigation link. Namespaces are identifiers, never fetched. */
export const ALLOWED = ['http://www.w3.org', 'https://www.w3.org'];

/** <img> sources exempt from width/height: full-bleed CSS-sized backdrops (prefix match on the src). */
export const BACKDROPS = ['/sky/'];

/**
 * Problems known on main and owned by a later slice: printed as warnings, not failures, so the gate can land
 * before the fix. Each entry is the exact problem line. Delete the entry with the fix; a stale entry is reported.
 */
export const KNOWN = {};

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))?.[1] ?? null;
const hasAttr = (tag, name) => new RegExp(`\\s${name}(=|\\s|/?>)`, 'i').test(tag);
const strip = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .trim();

function walk(d, out = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Problems on one route's HTML. `expectCanonical` is the URL it must name, or null when there is no origin. */
export function auditPage(html, expectCanonical) {
  const f = [];
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? '';
  if (!attr(htmlTag, 'lang')) f.push('<html> has no lang');
  if (!/<meta\s+charset=/i.test(html)) f.push('no <meta charset>');
  if (!/<meta\s+name="viewport"/i.test(html)) f.push('no <meta name="viewport">');
  const title = strip(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  if (!title) f.push('empty or missing <title>');
  const desc = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1]?.trim() ?? '';
  if (!desc) f.push('empty or missing meta description');
  else if (desc.length > 300) f.push(`meta description is ${desc.length} characters (at most 300)`);
  const canon = [...html.matchAll(/<link\b[^>]*rel="canonical"[^>]*>/gi)].map((m) => attr(m[0], 'href'));
  if (expectCanonical) {
    if (canon.length !== 1) f.push(`${canon.length} canonical links (expected one)`);
    else if (canon[0] !== expectCanonical) f.push(`canonical is ${canon[0]}, expected ${expectCanonical}`);
  }
  // headings, by the level a screen reader announces
  const levels = [...html.matchAll(/<h([1-6])\b([^>]*)>/gi)].map((m) => {
    const aria = m[2].match(/aria-level="(\d)"/)?.[1];
    return Number(aria ?? m[1]);
  });
  const h1 = levels.filter((l) => l === 1).length;
  if (h1 !== 1) f.push(`${h1} level-1 headings (expected exactly one)`);
  let prev = 0;
  for (const l of levels) {
    if (prev && l > prev + 1) f.push(`heading order skips from h${prev} to h${l}`);
    prev = l;
  }
  const ids = new Map();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.set(m[1], (ids.get(m[1]) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) f.push(`id "${id}" appears ${n} times`);
  for (const m of html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/gi)) {
    if (!/rel="[^"]*\b(noopener|noreferrer)\b/i.test(m[0])) f.push(`target=_blank without rel=noopener: ${m[0]}`);
  }
  return f;
}

/** Problems with the images on any HTML page. */
export function auditImages(html) {
  const f = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = attr(tag, 'src') ?? '(no src)';
    if (!hasAttr(tag, 'alt')) f.push(`<img src="${src}"> has no alt attribute`);
    if (BACKDROPS.some((b) => src.startsWith(b))) continue;
    if (!attr(tag, 'width') || !attr(tag, 'height')) f.push(`<img src="${src}"> has no width and height`);
  }
  return f;
}

const allowed = (url) => ALLOWED.some((o) => url === o || url.startsWith(`${o}/`));
const ext = /^(?:https?:)?\/\//i;

/** Requests to another origin named by one file. `kind` is html, css or js. */
export function externalRequests(text, kind) {
  const out = [];
  const check = (u) => {
    if (u && ext.test(u.trim()) && !allowed(u.trim().replace(/^\/\//, 'https://'))) out.push(u.trim());
  };
  const css = (t) => {
    for (const m of t.matchAll(/url\(\s*["']?([^"')]+)/gi)) if (!m[1].startsWith('data:')) check(m[1]);
    for (const m of t.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/gi)) check(m[1]);
  };
  if (kind === 'html') {
    for (const m of html_tags(text)) {
      const [tag, name] = m;
      for (const a of ['src', 'poster', 'data']) check(attr(tag, a));
      for (const a of ['srcset', 'imagesrcset'])
        for (const part of (attr(tag, a) ?? '').split(',')) check(part.trim().split(/\s+/)[0]);
      if (name === 'link') {
        const rel = (attr(tag, 'rel') ?? '').toLowerCase();
        if (!/^(canonical|alternate|author|license|me)$/.test(rel)) check(attr(tag, 'href'));
      }
    }
    for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) css(m[1]);
    for (const m of text.matchAll(/\sstyle="([^"]*)"/gi)) css(m[1]);
    for (const m of text.matchAll(/<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi))
      if (!/type="application\/(ld\+)?json"/i.test(m[0])) out.push(...externalRequests(m[1], 'js'));
  } else if (kind === 'css') css(text);
  else for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>\\]+/g)) check(m[0]);
  return out;
}

function* html_tags(text) {
  for (const m of text.matchAll(/<(img|script|link|source|video|audio|iframe|embed|object|track|input)\b[^>]*>/gi))
    yield [m[0], m[1].toLowerCase()];
}

/** Audit a built dist/. Returns { problems: string[], pages: number, files: number }. */
export function audit(dist) {
  const problems = [];
  const rec = JSON.parse(readFileSync(join(dist, '..', 'dist-prerender', 'routes.json'), 'utf8'));
  const origin = (rec.origin ?? '').replace(/\/$/, '');
  const titles = new Map();
  for (const r of rec.files) {
    const html = readFileSync(join(dist, r), 'utf8');
    const path = r === '404.html' ? null : `/${r.replace(/index\.html$/, '')}`;
    const expect = origin && path ? `${origin}${path}` : null;
    for (const p of auditPage(html, expect)) problems.push(`${r}: ${p}`);
    const t = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim();
    if (t) titles.set(t, [...(titles.get(t) ?? []), r]);
  }
  for (const [t, rs] of titles) if (rs.length > 1) problems.push(`title "${t}" is shared by ${rs.join(', ')}`);

  const files = walk(dist).filter((p) => /\.(html|css|js|mjs|json|svg|webmanifest|xml)$/.test(p));
  for (const p of files) {
    const rel = relative(dist, p).split(sep).join('/');
    const text = readFileSync(p, 'utf8');
    if (rel.endsWith('.html')) for (const x of auditImages(text)) problems.push(`${rel}: ${x}`);
    // sitemap.xml and robots.txt name the site's own public URLs by design; search-index.json is page text
    if (
      /^(sitemap\.xml|search-index\.json)$/.test(rel) ||
      rel.endsWith('ASSETS.json') ||
      rel.endsWith('PROVENANCE.json')
    )
      continue;
    const kind = rel.endsWith('.html') ? 'html' : rel.endsWith('.css') ? 'css' : /\.(m?js)$/.test(rel) ? 'js' : 'other';
    if (kind === 'other') continue;
    const reqs = externalRequests(text, kind).filter((u) => !(origin && u.startsWith(`${origin}/`)));
    for (const u of new Set(reqs)) problems.push(`${rel}: requests another origin: ${u}`);
  }
  return { problems, pages: rec.files.length, files: files.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  if (!existsSync(join(dist, '..', 'dist-prerender', 'routes.json'))) {
    console.error('check-meta: no dist-prerender/routes.json - run `npm run build` first');
    process.exit(2);
  }
  const { problems: all, pages, files } = audit(dist);
  const problems = all.filter((p) => !(p in KNOWN));
  for (const p of all.filter((x) => x in KNOWN)) console.log(`::warning::check-meta (known, ${KNOWN[p]}): ${p}`);
  for (const k of Object.keys(KNOWN).filter((x) => !all.includes(x)))
    console.log(`::notice::check-meta: KNOWN entry no longer occurs, delete it: ${k}`);
  for (const p of problems) console.error(`::error::check-meta: ${p}`);
  if (problems.length) {
    console.error(`check-meta: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`check-meta: ok (${pages} routes; ${files} text files scanned for requests to other origins)`);
}
