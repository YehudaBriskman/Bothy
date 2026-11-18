// The S11 gates must be able to fail: each audit is fed a small page that breaks exactly one rule, and the budget
// measure is run on a throwaway dist/ whose sizes are known.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { measure, verdicts } from '../scripts/check-budgets.mjs';
import { audit, auditImages, auditPage, externalRequests } from '../scripts/check-meta.mjs';

const page = (body, head = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width"/>` +
  `<title>T</title><meta name="description" content="A page."/>` +
  `<link rel="canonical" href="https://x.test/a/"/>${head}</head><body>${body}</body></html>`;

test('a sound page passes', () => {
  assert.deepEqual(auditPage(page('<h1>A</h1><h2>B</h2><h3>C</h3><h2>D</h2>'), 'https://x.test/a/'), []);
});

test('each page rule can fail', () => {
  const one = (html, re) => {
    const f = auditPage(html, 'https://x.test/a/');
    assert.ok(
      f.some((x) => re.test(x)),
      `expected ${re} in ${JSON.stringify(f)}`,
    );
  };
  one(page('<h1>A</h1>').replace(' lang="en"', ''), /no lang/);
  one(page('<h1>A</h1>').replace('<title>T</title>', '<title></title>'), /title/);
  one(page('<h1>A</h1>').replace('content="A page."', 'content=""'), /description/);
  one(page('<h1>A</h1>').replace('/a/"', '/b/"'), /canonical is/);
  one(page('<h2>A</h2>'), /0 level-1/);
  one(page('<h1>A</h1><h1>B</h1>'), /2 level-1/);
  one(page('<h1>A</h1><h3>B</h3>'), /skips from h1 to h3/);
  one(page('<h1>A</h1><h2 aria-level="4">B</h2>'), /skips from h1 to h4/);
  one(page('<h1 id="a">A</h1><p id="a"></p>'), /id "a" appears 2/);
  one(page('<h1>A</h1><a href="https://e.test" target="_blank">e</a>'), /noopener/);
  // aria-level wins over the tag
  assert.deepEqual(auditPage(page('<h1>A</h1><h2>B</h2><h1 aria-level="3">C</h1>'), 'https://x.test/a/'), []);
  assert.deepEqual(auditPage(page('<h1>A</h1><a target="_blank" rel="noreferrer" href="/">x</a>'), null), []);
});

test('images need alt and dimensions, except backdrops', () => {
  assert.match(auditImages('<img src="/a.png" width="1" height="1">').join(), /no alt/);
  assert.match(auditImages('<img src="/a.png" alt="">').join(), /width and height/);
  assert.deepEqual(auditImages('<img src="/a.png" alt="" width="1" height="1">'), []);
  assert.deepEqual(auditImages('<img src="/sky/day-desk.webp" alt="">'), []);
});

test('requests to another origin are found in html, css and js', () => {
  assert.deepEqual(externalRequests('<script src="https://cdn.test/a.js"></script>', 'html'), [
    'https://cdn.test/a.js',
  ]);
  assert.deepEqual(externalRequests('<link rel="stylesheet" href="//fonts.test/c.css">', 'html'), [
    '//fonts.test/c.css',
  ]);
  assert.deepEqual(externalRequests('<link rel="canonical" href="https://x.test/">', 'html'), []);
  assert.deepEqual(externalRequests('<a href="https://github.com/x">x</a>', 'html'), []);
  assert.deepEqual(externalRequests('<img srcset="/a.png 1x, https://i.test/b.png 2x">', 'html'), [
    'https://i.test/b.png',
  ]);
  assert.deepEqual(externalRequests('a{background:url("https://i.test/x.png")}', 'css'), ['https://i.test/x.png']);
  assert.deepEqual(externalRequests('@import "https://f.test/x.css";', 'css'), ['https://f.test/x.css']);
  assert.deepEqual(
    externalRequests(`a{background:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>")}`, 'css'),
    [],
  );
  assert.deepEqual(externalRequests('fetch("https://api.test/v1")', 'js'), ['https://api.test/v1']);
  assert.deepEqual(externalRequests('createElementNS("http://www.w3.org/2000/svg","g")', 'js'), []);
  assert.deepEqual(externalRequests('<script>fetch("https://t.test/p")</script>', 'html'), ['https://t.test/p']);
});

function fakeDist() {
  const root = mkdtempSync(join(tmpdir(), 'budgets-'));
  const dist = join(root, 'dist');
  for (const d of ['assets', 'sky', 'docs/a']) mkdirSync(join(dist, d), { recursive: true });
  mkdirSync(join(root, 'dist-prerender'));
  writeFileSync(
    join(root, 'dist-prerender', 'routes.json'),
    JSON.stringify({ origin: 'https://x.test', files: ['index.html', 'docs/a/index.html'] }),
  );
  const rand = (n) => randomBytes(n); // incompressible, like a photograph
  writeFileSync(join(dist, 'sky', 'day-desk.avif'), rand(4000));
  writeFileSync(join(dist, 'sky', 'day-phone.avif'), rand(2000));
  writeFileSync(
    join(dist, 'assets', 'app.css'),
    'body{background:url(/sky/day-desk.avif)}@media{body{background:url(/sky/day-phone.avif)}}',
  );
  writeFileSync(join(dist, 'assets', 'entry.js'), 'import("./lazy.js");');
  writeFileSync(join(dist, 'assets', 'lazy.js'), 'import "./dep.js";' + 'x'.repeat(100));
  writeFileSync(join(dist, 'assets', 'dep.js'), 'y');
  const html = page(
    '<h1>A</h1>',
    '<script type="module" src="/assets/entry.js"></script><link rel="stylesheet" href="/assets/app.css">',
  );
  writeFileSync(join(dist, 'index.html'), html);
  writeFileSync(join(dist, 'docs/a/index.html'), html);
  // share cards and icons: never loaded by a page, so outside the visitor total
  mkdirSync(join(dist, 'og'));
  writeFileSync(join(dist, 'og', 'home.jpg'), randomBytes(50000));
  writeFileSync(join(dist, 'icon-512.png'), randomBytes(20000));
  writeFileSync(join(dist, 'site.webmanifest'), '{}');
  return { root, dist };
}

test('budgets: first load counts the still sky per viewport, the lazy island apart', () => {
  const { root, dist } = fakeDist();
  try {
    const { rows } = measure(dist, {});
    const row = (n) => rows.find((r) => r.name === n);
    const d = row('first load / desktop').kb * 1024;
    const p = row('first load / phone').kb * 1024;
    assert.ok(d - p > 1500, `desktop ${d} should carry the bigger still than phone ${p}`);
    assert.match(row('js / lazy sky island').detail, /lazy/);
    assert.match(row('js / lazy sky island').detail, /dep/);
    const share = row('share cards and icons (og/, icons, manifest), raw');
    const visitor = row('dist total without share cards and icons, raw');
    assert.equal(share.detail, '3 files');
    assert.ok(share.kb * 1024 >= 70000, `share row ${share.kb} KB should carry the card and the icon`);
    assert.ok(visitor.kb * 1024 < 20000, `visitor total ${visitor.kb} KB must leave the card and icon out`);
    // with no limits every row is unbudgeted, which fails; with tiny limits every row is over
    assert.ok(verdicts(rows).every((r) => r.unbudgeted));
    const tiny = Object.fromEntries(rows.map((r) => [r.name, 0.001]));
    const sized = verdicts(measure(dist, tiny).rows).filter((r) => r.kb > 0);
    assert.ok(sized.length >= 10 && sized.every((r) => r.over));
    // the audit on the same tree: both pages name /a/ as canonical and share one title
    assert.deepEqual(audit(dist).problems.sort(), [
      'docs/a/index.html: canonical is https://x.test/a/, expected https://x.test/docs/a/',
      'index.html: canonical is https://x.test/a/, expected https://x.test/',
      'title "T" is shared by index.html, docs/a/index.html',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
