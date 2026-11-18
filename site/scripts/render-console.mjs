#!/usr/bin/env node
/**
 * Renders the console views the site shows (Services, Files, Health, Modules) to static HTML and CSS.
 *
 *   node scripts/render-console.mjs            write src/console/generated/fragments.json and src/styles/console.css
 *   node scripts/render-console.mjs --check    fail (exit 1) if those two files differ from what the sources give
 *   node scripts/render-console.mjs --demo F   also write a standalone page to F (site stylesheet + frame), to look at
 *
 * Inputs: fixtures/console/*.json (example data) and the console's own stylesheets under apps/bothy-web/web/src, which
 * are READ, never edited. The console CSS becomes the site's by four transformations, all in `scopeCss`:
 *
 *   1. SCOPE. `:root`, `html` and `body` become `.console-frame`; every other selector gains `.console-frame ` in
 *      front. The console's tokens are therefore defined on `.console-frame` and nowhere else, so the site's own
 *      `--bg`, `--fg` and `--accent` (same names, other values) never reach into it, and the console's never reach out.
 *   2. PRUNE. A selector is kept only if every class it names is used by the fragments. 120 KB of console CSS that
 *      styles screens the site does not show would otherwise ship for nothing.
 *   3. LOGICAL. `left`/`right` become `inline-start`/`inline-end`, because the site is built to need no second
 *      stylesheet for Hebrew (verify-dist.sh refuses physical directions). The frame is `dir="ltr"`, so nothing moves.
 *   4. ISOLATE. A rule at the top makes the frame immune to the site's bare element rules (`table`, `th`, `a`, `h2` ...).
 *
 * The three.js components (components/three) are not touched: no view here imports them.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const siteRoot = resolve(here, '..');
export const repoRoot = resolve(siteRoot, '..');
const web = resolve(repoRoot, 'apps/bothy-web/web/src');

const require = createRequire(import.meta.url);

/** The console stylesheets the four views draw on, in the console's own cascade order. */
export const CONSOLE_CSS = [
  'index.css',
  'hl.css',
  'components/Tables.css',
  'pages/Services.css',
  'pages/control/controlHome.css',
  'pages/files/shell.css',
  'pages/files/explorer.css',
  'pages/files/read.css',
  'pages/files/editor.css',
];

export const OUT_FRAGMENTS = resolve(siteRoot, 'src/console/generated/fragments.json');
export const OUT_CSS = resolve(siteRoot, 'src/styles/console.css');

const readJson = (name) => JSON.parse(readFileSync(resolve(siteRoot, 'fixtures/console', name), 'utf8'));

// The only element rule the frame needs to survive the site: undo every author rule on every element inside it
// (zero specificity, so every scoped console rule below still wins), then let the console's rules apply.
const ISOLATE = `.console-frame :where(*:not(svg):not(svg *)) { all: revert; }`;

const PHYSICAL_PROPS = new Map([
  ['margin-left', 'margin-inline-start'],
  ['margin-right', 'margin-inline-end'],
  ['padding-left', 'padding-inline-start'],
  ['padding-right', 'padding-inline-end'],
  ['border-left', 'border-inline-start'],
  ['border-right', 'border-inline-end'],
  ['border-left-color', 'border-inline-start-color'],
  ['border-right-color', 'border-inline-end-color'],
  ['border-left-width', 'border-inline-start-width'],
  ['border-right-width', 'border-inline-end-width'],
  ['border-left-style', 'border-inline-start-style'],
  ['border-right-style', 'border-inline-end-style'],
  ['border-top-left-radius', 'border-start-start-radius'],
  ['border-top-right-radius', 'border-start-end-radius'],
  ['border-bottom-left-radius', 'border-end-start-radius'],
  ['border-bottom-right-radius', 'border-end-end-radius'],
  ['left', 'inset-inline-start'],
  ['right', 'inset-inline-end'],
  ['scroll-margin-left', 'scroll-margin-inline-start'],
  ['scroll-margin-right', 'scroll-margin-inline-end'],
]);

const PHYSICAL_CSS = /(margin|padding|border)-(left|right)|text-align: *(left|right)|(^|[^-])(left|right): /;

/** `.a.b:has(.c)` -> ['a', 'b', 'c']. Attribute selectors and strings are blanked first so `[data-x='.y']` is no class. */
function classesIn(selector) {
  const bare = selector.replace(/\[[^\]]*\]/g, '').replace(/(["'])(?:\\.|(?!\1).)*\1/g, '');
  return [...bare.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
}

/** Rewrites one selector for the frame, or returns null to drop it. */
function scopeSelector(sel, used, alias) {
  let s = sel.trim();
  if (!s) return null;
  // Classes the site also styles are renamed (see CLASS_ALIAS in src/console/components.ts).
  s = s.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (m, c) => (alias[c] ? `.${alias[c]}` : m));
  if (classesIn(s).some((c) => !used.has(c))) return null;
  // The document's own elements become the frame.
  const root = /^(?::root|html|body)(?![\w-])/;
  if (root.test(s)) {
    s = s.replace(root, '.console-frame');
    if (/^\.console-frame\[data-scrolled/.test(s)) return null;
    return s;
  }
  if (/^\.console-frame/.test(s)) return s;
  return `.console-frame ${s}`;
}

/** Scopes, prunes and logicalises one stylesheet. `postcss` is the one the site already builds with (through Vite). */
export function scopeCss(postcss, css, used, from, alias = {}) {
  const root = postcss.parse(css, { from });
  root.walkAtRules((at) => {
    if (['import', 'font-face', 'layer', 'charset'].includes(at.name) && !at.nodes) at.remove();
    if (at.name === 'font-face') at.remove();
  });
  root.walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
    const kept = rule.selectors.map((s) => scopeSelector(s, used, alias)).filter(Boolean);
    if (!kept.length) rule.remove();
    else rule.selectors = kept;
  });
  root.walkDecls((decl) => {
    const to = PHYSICAL_PROPS.get(decl.prop);
    if (to) decl.prop = to;
    if (decl.prop === 'text-align') decl.value = decl.value.replace(/\bleft\b/, 'start').replace(/\bright\b/, 'end');
  });
  // Empty at-rules (a @media whose rules were all pruned) go; so do comments, which are the console's own.
  root.walkComments((c) => c.remove());
  let again = true;
  while (again) {
    again = false;
    root.walkAtRules((at) => {
      if (at.nodes && !at.nodes.length) {
        at.remove();
        again = true;
      }
    });
  }
  // A keyframes block stays only if something kept still names it.
  const text = root.toString();
  root.walkAtRules(/keyframes$/, (at) => {
    const name = at.params.trim();
    const refs = text.split(new RegExp(`(?<![\\w-])${name}(?![\\w-])`)).length - 1;
    if (refs < 2) at.remove();
  });
  return root.toString();
}

const classesOf = (html) =>
  new Set([...html.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean)));

/** Everything the build produces, as strings. No file is touched. */
export async function build() {
  const postcss = require('postcss');
  const prettier = await import('prettier');
  const { renderServices, renderHealth, renderFiles, renderModules, CLASS_ALIAS } = await import(
    pathToFileURL(resolve(siteRoot, 'src/console/components.ts')).href
  );
  const { renderFrame, tabRules, EN } = await import(pathToFileURL(resolve(siteRoot, 'src/console/frame.ts')).href);

  const panels = {
    services: renderServices(readJson('services.json')),
    files: renderFiles(readJson('files.json')),
    health: renderHealth(readJson('health.json')),
    modules: renderModules(readJson('modules.json')),
  };
  // The demo (src/console/flow.ts): scenes drawn on top of the four views, and the step list under the frame.
  const flow = await import(pathToFileURL(resolve(siteRoot, 'src/console/flow.ts')).href);
  const services = readJson('services.json');
  const shown = {
    ...panels,
    services: `${flow.renderScanBar(services)}${panels.services}${flow.renderDetail(services)}`,
    health: `${panels.health}${flow.renderSpark()}`,
    modules: `${panels.modules}${flow.renderModuleFlow(readJson('modules.json'))}`,
  };
  const frame = renderFrame(shown, EN, 'cf', { panels: flow.renderLogin(), steps: flow.renderSteps() });

  const used = classesOf(frame);
  used.add('console-frame');

  const parts = [];
  for (const rel of CONSOLE_CSS) {
    const file = resolve(web, rel);
    if (!existsSync(file)) throw new Error(`render-console: the console stylesheet ${rel} is gone; update CONSOLE_CSS`);
    parts.push(scopeCss(postcss, readFileSync(file, 'utf8'), used, file, CLASS_ALIAS));
  }
  const frameCss = readFileSync(resolve(siteRoot, 'src/console/frame.css'), 'utf8');
  const addendum = readFileSync(resolve(siteRoot, 'src/console/addendum.css'), 'utf8');
  const raw = [
    '/* GENERATED by scripts/render-console.mjs from the console stylesheets and src/console/*.css. Do not edit. */',
    '/* 1. The glass frame and its tabs: site chrome, drawn with its own tokens. */',
    frameCss,
    tabRules(EN.tabs),
    '/* 2. The console, scoped under .console-frame. */',
    ISOLATE,
    ...parts,
    '/* 3. What the static views need that the live console gets from its app shell. */',
    addendum,
  ].join('\n');
  if (PHYSICAL_CSS.test(raw)) {
    const hit = raw.split('\n').find((l) => PHYSICAL_CSS.test(l));
    throw new Error(`render-console: a physical left/right survived in the generated CSS: ${hit?.trim()}`);
  }
  const cfg = (await prettier.resolveConfig(OUT_CSS)) ?? {};
  const css = await prettier.format(raw, { ...cfg, parser: 'css' });
  const fragments = await prettier.format(JSON.stringify({ frame, panels }), { ...cfg, parser: 'json' });
  return { css, fragments, frame, panels };
}

function demoPage(frame, css) {
  const site = readFileSync(resolve(siteRoot, 'src/styles/site.css'), 'utf8');
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Console frame demo</title>
<style>${site}</style><style>${css}</style>
<style>body{background:radial-gradient(120% 80% at 50% 0%,#2b2f3a 0%,#13161b 60%);}</style></head>
<body><main><div class="wrap" style="max-inline-size:62rem;margin-inline:auto;padding:2rem 1rem">
<h2>What it does inside</h2>${frame}<p>Text after the frame, in the site's own style. <a href="#">A link</a>.</p>
<table><thead><tr><th>Site table</th><th class="num">n</th></tr></thead><tbody><tr><td>row</td><td class="num">1</td></tr></tbody></table>
</div></main></body></html>`;
}

async function main() {
  const args = process.argv.slice(2);
  const { css, fragments, frame } = await build();
  if (args.includes('--check')) {
    const stale = [];
    for (const [file, want] of [
      [OUT_CSS, css],
      [OUT_FRAGMENTS, fragments],
    ]) {
      if (!existsSync(file) || readFileSync(file, 'utf8') !== want) stale.push(file.replace(`${repoRoot}/`, ''));
    }
    if (stale.length) {
      console.error(`render-console: out of date: ${stale.join(', ')}\nrun: npm run render-console`);
      process.exit(1);
    }
    console.log('render-console: generated files are current');
    return;
  }
  mkdirSync(dirname(OUT_FRAGMENTS), { recursive: true });
  writeFileSync(OUT_FRAGMENTS, fragments);
  writeFileSync(OUT_CSS, css);
  console.log(
    `render-console: wrote ${OUT_FRAGMENTS.replace(`${repoRoot}/`, '')} and ${OUT_CSS.replace(`${repoRoot}/`, '')}`,
  );
  const i = args.indexOf('--demo');
  if (i >= 0 && args[i + 1]) {
    writeFileSync(resolve(args[i + 1]), demoPage(frame, css));
    console.log(`render-console: demo page ${args[i + 1]}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
