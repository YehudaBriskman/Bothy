// Every internal link and fragment in the built site resolves to a file and an id.
// External links are not fetched (a build needs no network).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const base = (process.env.SITE_BASE ?? '/').replace(/^\/?/, '/').replace(/\/?$/, '/');

const pages = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.html')) pages.push(p);
  }
})(dist);

const idsOf = new Map();
const html = new Map();
for (const p of pages) {
  const t = readFileSync(p, 'utf8');
  html.set(p, t);
  idsOf.set(p, new Set([...t.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
}

function fileFor(urlPath) {
  const rel = decodeURIComponent(urlPath.slice(base.length));
  for (const c of [rel, `${rel}/index.html`, rel === '' ? 'index.html' : null]) {
    if (c !== null && existsSync(join(dist, c)) && statSync(join(dist, c)).isFile()) return join(dist, c);
  }
  return null;
}

const fails = [];
let checked = 0;
for (const [p, t] of html) {
  for (const m of t.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const url = m[1];
    if (/^(https?:|mailto:|data:)/.test(url)) continue;
    checked += 1;
    const [pathPart, frag] = url.split('#');
    let target = p;
    if (pathPart) {
      if (!pathPart.startsWith(base)) {
        fails.push(`${p.slice(dist.length)}: ${url} is not under the base ${base}`);
        continue;
      }
      target = fileFor(pathPart.split('?')[0]);
      if (!target) {
        fails.push(`${p.slice(dist.length)}: ${url} does not exist`);
        continue;
      }
    }
    if (frag && target.endsWith('.html') && !idsOf.get(target)?.has(decodeURIComponent(frag))) {
      fails.push(`${p.slice(dist.length)}: ${url} has no #${frag}`);
    }
  }
}
if (fails.length) {
  for (const f of fails) console.error(`::error::check-links: ${f}`);
  process.exit(1);
}
console.log(`check-links: ${checked} internal links across ${pages.length} pages resolve`);
