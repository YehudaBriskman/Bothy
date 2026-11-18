// The SEO and share-image guard (build plan S10). Run after `npm run build` (verify-dist.sh runs it):
//
//   npm run check:seo
//
// Fails when any built page lacks a field (title, description, theme-color, lang, Open Graph, Twitter card, icons),
// a title or description is out of the range in src/seo.ts, a canonical or og:url is not origin + base + path, a share
// image or icon is missing, oversized, the wrong size, or differs from public/og/PROVENANCE.json, the sitemap does not
// list exactly the indexable pages, robots.txt does not point at it, the 404 page is indexable, or the JSON-LD on the
// home page is missing or claims what we do not state (ratings, reviews, prices).
// The table-only half (checkTable, checkImages) needs no build and runs in `npm test` too (test/seo/).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OG_CARDS, OG_SIZE, SEO, SEO_LIMITS } from '../src/seo.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OG_MAX_BYTES = 120 * 1024;
const ICON_MAX_BYTES = 32 * 1024;

const unescape = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Width and height of a PNG (IHDR) or a baseline/progressive JPEG (first SOFn), or null. */
export function imageSize(b) {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47)
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/** The data table on its own: every row in range, every card has words. */
export function checkTable() {
  const fails = [];
  const titles = new Map();
  for (const [path, row] of Object.entries(SEO)) {
    const t = row.title.length;
    const d = row.description.length;
    if (!t || t > SEO_LIMITS.titleMax) fails.push(`${path}: title is ${t} characters (1 to ${SEO_LIMITS.titleMax})`);
    if (d < SEO_LIMITS.descriptionMin || d > SEO_LIMITS.descriptionMax)
      fails.push(
        `${path}: description is ${d} characters (${SEO_LIMITS.descriptionMin} to ${SEO_LIMITS.descriptionMax})`,
      );
    if (!OG_CARDS[row.image]) fails.push(`${path}: no share image "${row.image}"`);
    if (titles.has(row.title)) fails.push(`${path}: same title as ${titles.get(row.title)}`);
    titles.set(row.title, path);
  }
  for (const [k, c] of Object.entries(OG_CARDS)) {
    if (!c.heading || !c.line || !c.alt) fails.push(`card ${k}: heading, line and alt are all required`);
  }
  return fails;
}

/** The committed images: present, the right size, under budget, and the bytes PROVENANCE.json recorded. */
export function checkImages(pub = join(root, 'public')) {
  const fails = [];
  let prov;
  try {
    prov = JSON.parse(readFileSync(join(pub, 'og', 'PROVENANCE.json'), 'utf8'));
  } catch (e) {
    return [`public/og/PROVENANCE.json unreadable: ${e.message} (run npm run og)`];
  }
  const entries = [
    ...(prov.images ?? []).map((e) => ({ ...e, path: join(pub, 'og', e.file), max: OG_MAX_BYTES })),
    ...(prov.icons ?? []).map((e) => ({ ...e, path: join(pub, e.file), max: ICON_MAX_BYTES })),
  ];
  for (const key of Object.keys(OG_CARDS)) {
    const e = (prov.images ?? []).find((i) => i.file === `${key}.jpg`);
    if (!e) fails.push(`og/${key}.jpg: no PROVENANCE entry (run npm run og)`);
    else if (e.heading !== OG_CARDS[key].heading || e.line !== OG_CARDS[key].line)
      fails.push(`og/${key}.jpg: drawn with other words than src/seo.ts now has (run npm run og)`);
    else if (!e.contrast?.length || e.contrast.some((r) => !r.ok)) fails.push(`og/${key}.jpg: contrast not passed`);
  }
  for (const f of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) {
    if (!(prov.icons ?? []).some((i) => i.file === f)) fails.push(`${f}: no PROVENANCE entry (run npm run og)`);
  }
  for (const e of entries) {
    if (!existsSync(e.path)) {
      fails.push(`${e.file}: missing`);
      continue;
    }
    const b = readFileSync(e.path);
    if (b.length > e.max) fails.push(`${e.file}: ${b.length} bytes, over ${e.max}`);
    if (b.length !== e.bytes) fails.push(`${e.file}: ${b.length} bytes, ${e.bytes} recorded`);
    if (createHash('sha256').update(b).digest('hex') !== e.sha256) fails.push(`${e.file}: sha256 differs`);
    const size = imageSize(b);
    if (!size || size.width !== e.width || size.height !== e.height)
      fails.push(`${e.file}: ${size ? `${size.width}x${size.height}` : 'unreadable'}, expected ${e.width}x${e.height}`);
  }
  for (const e of prov.images ?? []) {
    if (e.width !== OG_SIZE.width || e.height !== OG_SIZE.height)
      fails.push(`${e.file}: not ${OG_SIZE.width}x${OG_SIZE.height}`);
  }
  return fails;
}

const metaRe = (attr, name) => new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`);

/** The built site: every page's head, the sitemap, robots.txt and the 404 page. */
export function checkBuild(dist = join(root, 'dist'), routesFile = join(root, 'dist-prerender/routes.json')) {
  const fails = [];
  if (!existsSync(routesFile)) return [`no ${routesFile}: run npm run build first`];
  const routes = JSON.parse(readFileSync(routesFile, 'utf8'));
  const origin = routes.origin;
  const base = (process.env.SITE_BASE ?? '/').replace(/^\/?/, '/').replace(/\/?$/, '/');
  const pathOf = (file) => (file === '404.html' ? '/404.html' : `/${file.replace(/index\.html$/, '')}`);
  const abs = (p) => `${origin}${base}${p.replace(/^\//, '')}`;
  const seen = { title: new Map(), description: new Map() };

  for (const file of routes.files) {
    const where = file;
    const html = readFileSync(join(dist, file), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    const p = pathOf(file);
    const indexable = routes.indexable.includes(p);
    const get = (re) => {
      const m = head.match(re);
      return m ? unescape(m[1]) : null;
    };

    if (!/<html lang="[a-z]{2}(-[A-Z]{2})?" dir="(ltr|rtl)">/.test(html))
      fails.push(`${where}: <html> has no lang/dir`);
    const title = get(/<title>([^<]*)<\/title>/);
    const description = get(metaRe('name', 'description'));
    if (!title) fails.push(`${where}: no <title>`);
    else if (title.length > SEO_LIMITS.titleMax) fails.push(`${where}: title ${title.length} characters`);
    if (!description) fails.push(`${where}: no meta description`);
    else if (description.length < SEO_LIMITS.descriptionMin || description.length > SEO_LIMITS.descriptionMax)
      fails.push(`${where}: description ${description.length} characters: "${description}"`);
    for (const [k, v] of [
      ['title', title],
      ['description', description],
    ]) {
      if (v && seen[k].has(v)) fails.push(`${where}: same ${k} as ${seen[k].get(v)}`);
      seen[k].set(v, where);
    }

    if (!get(metaRe('name', 'theme-color'))) fails.push(`${where}: no theme-color`);
    for (const prop of ['og:type', 'og:site_name', 'og:locale']) {
      if (!get(metaRe('property', prop))) fails.push(`${where}: no ${prop}`);
    }
    if (get(metaRe('property', 'og:title')) !== title) fails.push(`${where}: og:title differs from <title>`);
    if (get(metaRe('property', 'og:description')) !== description)
      fails.push(`${where}: og:description differs from the description`);
    for (const rel of ['icon', 'apple-touch-icon', 'manifest']) {
      const h = get(new RegExp(`<link rel="${rel}" href="([^"]*)"`));
      if (!h) fails.push(`${where}: no <link rel="${rel}">`);
      else if (!existsSync(join(dist, h.slice(base.length)))) fails.push(`${where}: ${rel} ${h} is not in dist`);
    }

    const canonical = get(/<link rel="canonical" href="([^"]*)"/);
    const robots = get(metaRe('name', 'robots'));
    const card = get(metaRe('name', 'twitter:card'));
    if (!card) fails.push(`${where}: no twitter:card`);
    if (!indexable && !/noindex/.test(robots ?? '')) fails.push(`${where}: not indexable but has no noindex`);
    if (indexable && robots && /noindex/.test(robots)) fails.push(`${where}: indexable page says noindex`);

    if (!origin) {
      if (canonical || get(metaRe('property', 'og:image')))
        fails.push(`${where}: a build with no origin must have no absolute address`);
      continue;
    }
    if (indexable) {
      if (canonical !== abs(p)) fails.push(`${where}: canonical ${canonical}, expected ${abs(p)}`);
      if (get(metaRe('property', 'og:url')) !== canonical) fails.push(`${where}: og:url differs from canonical`);
    } else if (canonical) fails.push(`${where}: a noindex page has a canonical`);

    const image = get(metaRe('property', 'og:image'));
    const m = image?.match(new RegExp(`^${abs('/og/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([a-z]+)\\.jpg$`));
    if (!m) fails.push(`${where}: og:image ${image} is not ${abs('/og/')}<card>.jpg`);
    else {
      const f = join(dist, 'og', `${m[1]}.jpg`);
      if (!existsSync(f)) fails.push(`${where}: og:image ${m[1]}.jpg is not in dist`);
      else {
        const b = readFileSync(f);
        const s = imageSize(b);
        if (b.length > OG_MAX_BYTES) fails.push(`${where}: og:image ${b.length} bytes`);
        if (!s || s.width !== OG_SIZE.width || s.height !== OG_SIZE.height) fails.push(`${where}: og:image size`);
        if (get(metaRe('property', 'og:image:width')) !== String(s?.width)) fails.push(`${where}: og:image:width`);
        if (get(metaRe('property', 'og:image:height')) !== String(s?.height)) fails.push(`${where}: og:image:height`);
      }
    }
    if (!get(metaRe('property', 'og:image:alt'))) fails.push(`${where}: no og:image:alt`);
    if (get(metaRe('name', 'twitter:image')) !== image) fails.push(`${where}: twitter:image differs from og:image`);
    if (card !== 'summary_large_image') fails.push(`${where}: twitter:card is ${card}`);

    if (p === '/') {
      const ld = head.match(/<script type="application\/ld\+json">([^<]*)<\/script>/);
      let data = null;
      try {
        data = ld && JSON.parse(ld[1]);
      } catch {
        /* reported below */
      }
      const graph = data?.['@graph'] ?? [];
      const app = graph.find((n) => n['@type'] === 'SoftwareApplication');
      const site = graph.find((n) => n['@type'] === 'WebSite');
      if (!app || !site) fails.push(`${where}: JSON-LD needs a WebSite and a SoftwareApplication`);
      else {
        if (app.operatingSystem !== 'Linux') fails.push(`${where}: JSON-LD operatingSystem must be Linux`);
        if (!/LICENSE$/.test(app.license ?? '')) fails.push(`${where}: JSON-LD licence must be the repository's`);
        if (site.url !== abs('/')) fails.push(`${where}: JSON-LD url`);
      }
      if (/aggregateRating|"review"|"offers"|"price"/.test(ld?.[1] ?? ''))
        fails.push(`${where}: JSON-LD claims a rating, review or price that nobody gave`);
    }
  }

  // The sitemap and robots.txt, against the route table.
  if (origin) {
    const sm = existsSync(join(dist, 'sitemap.xml')) ? readFileSync(join(dist, 'sitemap.xml'), 'utf8') : '';
    const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => x[1]);
    const want = routes.indexable.map(abs);
    for (const w of want) if (!locs.includes(w)) fails.push(`sitemap.xml misses ${w}`);
    for (const l of locs) if (!want.includes(l)) fails.push(`sitemap.xml lists ${l}, which is not an indexable page`);
    if (new Set(locs).size !== locs.length) fails.push('sitemap.xml lists a page twice');
    const robots = existsSync(join(dist, 'robots.txt')) ? readFileSync(join(dist, 'robots.txt'), 'utf8') : '';
    if (!robots.includes(`Sitemap: ${origin}/sitemap.xml`)) fails.push('robots.txt does not name the sitemap');
  } else if (existsSync(join(dist, 'sitemap.xml'))) fails.push('a build with no origin has a sitemap.xml');
  if (!routes.files.includes('404.html')) fails.push('no 404.html in the route table');
  if (routes.indexable.includes('/404.html')) fails.push('404.html is indexable');
  return fails;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const fails = [...checkTable(), ...checkImages(), ...checkBuild()];
  if (fails.length) {
    for (const f of fails) console.error(`::error::check-seo: ${f}`);
    process.exit(1);
  }
  const routes = JSON.parse(readFileSync(join(root, 'dist-prerender/routes.json'), 'utf8'));
  console.log(
    `check-seo: ${routes.files.length} pages, ${routes.indexable.length} in the sitemap, ` +
      `${Object.keys(OG_CARDS).length} share images, origin ${routes.origin || '(none)'}: ok`,
  );
}
