import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Writes one static file per route from the single built shell.
 *
 * The client build emits `dist/index.html` with the hashed asset links; each
 * route's head and body are poured into it. Also writes what is derived from the
 * route table so it cannot drift from it: the search index, and - only when the
 * build has a public origin - the sitemap, robots.txt and CNAME.
 */

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, '..');
const dist = resolve(siteRoot, 'dist');
const ssrEntry = resolve(siteRoot, 'dist-prerender/prerender.js');
const shellPath = resolve(dist, 'index.html');

for (const [what, p] of [
  ['SSR bundle', ssrEntry],
  ['client shell', shellPath],
]) {
  if (!existsSync(p)) {
    console.error(`prerender: missing ${what} ${p} - run the client build and the --ssr build first`);
    process.exit(1);
  }
}

const shell = readFileSync(shellPath, 'utf8');

// `String.replace` with a string pattern that does not match is a silent no-op:
// reformatting the shell would ship every page without its head or its lang.
// So every marker is asserted, including the opening <html> tag.
const LANG_TAG = '<html lang="en">';
for (const marker of ['<!--app-->', '<!--head-->', LANG_TAG]) {
  if (!shell.includes(marker)) {
    console.error(`prerender: the shell has no ${marker} to fill`);
    process.exit(1);
  }
}

const { renderAll } = await import(ssrEntry);
const site = renderAll();
const failures = [];
let written = 0;

for (const page of site.pages) {
  const floor = page.files[0] === '404.html' ? 300 : 800;
  if (!page.html || page.html.length < floor) {
    failures.push(`${page.files[0]}: rendered only ${page.html?.length ?? 0} characters, needed ${floor}`);
    continue;
  }
  // Replacer functions, not strings: `$&` and `$'` in a page (a shell snippet)
  // would otherwise be read as substitution patterns and splice the shell in.
  const html = shell
    .replace('<!--head-->', () => page.head)
    .replace('<!--app-->', () => page.html)
    .replace(LANG_TAG, () => `<html lang="${page.lang}" dir="${page.dir}">`);
  for (const file of page.files) {
    const target = resolve(dist, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html);
    written += 1;
  }
}

if (failures.length) {
  for (const f of failures) console.error(`prerender: ${f}`);
  process.exit(1);
}

const searchJson = JSON.stringify(site.search);
if (!site.search.pages.length) {
  console.error('prerender: the search index is empty');
  process.exit(1);
}
writeFileSync(resolve(dist, 'search-index.json'), searchJson);

// What was rendered from the repository, for scripts/check-public.mjs. This is a
// build artefact for the check, kept OUT of dist so it is never published.
mkdirSync(resolve(siteRoot, 'dist-prerender'), { recursive: true });
writeFileSync(
  resolve(siteRoot, 'dist-prerender/docs-rendered.json'),
  JSON.stringify({ rendered: site.docsRendered }, null, 2),
);
writeFileSync(
  resolve(siteRoot, 'dist-prerender/routes.json'),
  JSON.stringify(
    { origin: site.origin, files: site.pages.flatMap((p) => p.files), indexable: site.sitemap.map((s) => s.path) },
    null,
    2,
  ),
);

if (site.origin) {
  const urls = site.sitemap.map((s) => `  <url><loc>${s.loc}</loc></url>`).join('\n');
  writeFileSync(
    resolve(dist, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  );
  writeFileSync(resolve(dist, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${site.origin}/sitemap.xml\n`);
  writeFileSync(resolve(dist, 'CNAME'), `${new URL(site.origin).host}\n`);
} else {
  // A build with no public origin (served from a box) has no address for these.
  writeFileSync(resolve(dist, 'robots.txt'), 'User-agent: *\nAllow: /\n');
}

console.log(
  `prerender: ${site.pages.length} pages, ${written} files, ${site.docsRendered.length} docs, ` +
    `search index ${(Buffer.byteLength(searchJson) / 1024).toFixed(1)} KB, origin ${site.origin || '(none)'}`,
);
