// What the app shows WHILE IT IS WAITING - the skeletons, the plate over them,
// and the links a loading or broken page offers (2026-09-23).
//
// Two defects were found together, and they have the same shape: a placeholder
// that describes a page, or a box, that is no longer there.
//
//   1. The loader and the skeleton fought for the same pixels. The orb was laid
//      straight over the reserved shape - no plate, no clearing - so it printed
//      onto a grey bar with its label across the next one. The fix is a plate on
//      the Loader (ui/Loader.tsx `plate`), not a hole carved into every skeleton
//      variant: a hole moves with each layout and breaks the skeleton's one job.
//   2. Four pages stood under a skeleton shaped like a DIFFERENT page, and the
//      Overview's quick-links strip offered `:9090` - Prometheus, replaced by
//      VictoriaMetrics on 2026-09-17 - on every cold load.
//
// So this file asserts three things that cannot be held by a screenshot:
//
//   A. THE PLATE'S CONTRACT. It exists, it is the floating-surface material, it
//      is OPAQUE (no backdrop-filter, no translucent background - decision 4
//      keeps translucent material for the top bar and the palette), it restates
//      itself under forced colours, and it is an explicit prop rather than a
//      guess. The placeholder under it is quieted, once, in one rule.
//   B. NO SKELETON VARIANT IS USED BY A PAGE IT DOES NOT MATCH. Every <Skeleton>
//      call site is registered here against the variant that reserves its page's
//      shape, every registered variant is implemented, and every implemented
//      variant is reachable. A new page must declare itself; an existing one
//      cannot be quietly repointed at the wrong shape.
//   C. NO LOADING, FALLBACK OR FLOOR PATH NAMES A PORT THIS REPO DOES NOT STILL
//      PUBLISH. The port index is built from the compose files themselves, and a
//      service behind a `profiles:` key does not count - `prometheus` is still
//      in monitoring/compose.yml under `legacy-prometheus`, which is exactly why
//      "grep the repo for 9090" would have said the link was fine.
//
// Imports nothing but node builtins and reads the source tree, like its siblings.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = process.argv[2] ?? join(HERE, '..', 'web', 'src');
const REPO = process.argv[3] ?? join(SRC, '..', '..', '..', '..');

let passes = 0, failures = 0;
const say = (ok, label, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(SRC);
const rel = (p) => relative(SRC, p).split('\\').join('/');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
// Comments are stripped before ANY of the matching below. A check that reads a
// comment can be "passed" by editing prose, and a mutation planted in prose is a
// mutation the check never saw.
const stripTs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const tsx = files.filter((p) => /\.tsx?$/.test(p));

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const INDEX = stripCss(read(join(SRC, 'index.css')));
const LOADER_CSS = stripCss(read(join(SRC, 'components', 'ui', 'Loader.css')));
const LOADER_TSX = stripTs(read(join(SRC, 'components', 'ui', 'Loader.tsx')));
const STATES = stripTs(read(join(SRC, 'components', 'states.tsx')));

// ── A. the plate over content ───────────────────────────────────────────────
console.log('\n── a loader over content is plated, and the plate is opaque ─');
{
  const block = /\.ui-loader-plate\s*\{([^}]*)\}/.exec(LOADER_CSS)?.[1] ?? '';
  say(!!block, '.ui-loader-plate is declared in ui/Loader.css');
  say(/background:\s*var\(--surface-4\)/.test(block),
    'the plate is the floating-surface material - an OPAQUE --surface-4', block.match(/background:[^;]*/)?.[0] ?? '(none)');
  say(/border:\s*var\(--border-w\) solid var\(--line-strong\)/.test(block) && /border-radius:\s*var\(--r-lg\)/.test(block)
    && /box-shadow:\s*var\(--shadow-3\)/.test(block),
    'and the rest of it: the strong hairline, --r-lg, --shadow-3 (the same surface ui/Popover uses)');
  // The defect being fixed is an orb printed onto skeleton bars. A translucent
  // plate IS that defect with a blur on it, and decision 4 reserves translucent
  // material for the top bar and the command palette anyway.
  const plateRules = [...LOADER_CSS.matchAll(/\.ui-loader-plate[^{]*\{([^}]*)\}/g)].map((m) => m[1]).join(';');
  say(!/backdrop-filter/.test(plateRules), 'no backdrop-filter on the plate - decision 4, and a blurred plate over skeleton bars is the bug');
  say(!/background:[^;]*(transparent|rgba|color-mix)/.test(plateRules) || /forced-colors/.test(LOADER_CSS),
    'the plate never takes a translucent background');
  say(/@media \(forced-colors: active\)\s*\{[^}]*\.ui-loader-plate[^}]*\}/.test(LOADER_CSS)
    && /\.ui-loader-plate\s*\{[^}]*background:\s*Canvas/.test(LOADER_CSS),
    'and it is restated in system colours under forced colours - --surface-4 is not a colour the browser keeps');

  // The prop. A loader inline in a button must not grow a plate, so this is
  // declared and passed, never inferred.
  say(/\bplate\?:\s*boolean/.test(LOADER_TSX), 'ui/Loader exposes `plate` as an explicit prop');
  say(/plate\s*\?\s*'ui-loader-plate'\s*:\s*''/.test(LOADER_TSX), 'and the class is applied only when it is true');
  say(/plate = false/.test(LOADER_TSX), 'and it is off by default - a Loader is bare unless it is over something');
}

console.log('\n── the placeholder under a plate is quieted, in one rule ──');
{
  const quiet = [...INDEX.matchAll(/([^{}]*\.ui-loader-plate[^{}]*)\{([^}]*)\}/g)];
  say(quiet.length === 1, 'exactly one rule quiets a skeleton under a plate', quiet.map((m) => m[1].trim()).join(' | ') || '(none)');
  say(quiet.length === 1 && /opacity:\s*var\(--quiet-opacity\)/.test(quiet[0][2]),
    'and it does so with --quiet-opacity', quiet[0]?.[2].trim() ?? '');
  say(/--quiet-opacity:\s*\.?\d/.test(INDEX), '--quiet-opacity is a token on :root');

  // The positioning that caused the defect. `height: 100%` stretched the Loader
  // across the whole reserved shape; in a grid cell it sizes to its own words.
  const orb = /\.skel-host\s*>\s*\.skel-orb\s*\{([^}]*)\}/.exec(INDEX)?.[1] ?? '';
  say(!!orb && !/position:\s*absolute/.test(orb) && !/height:\s*100%/.test(orb),
    'the orb is no longer stretched across the skeleton (was position:absolute; height:100%)', orb.replace(/\s+/g, ' ').trim());
  say(/\.skel-host\s*\{[^}]*display:\s*grid/.test(INDEX) && /\.skel-host\s*>\s*\*\s*\{[^}]*grid-area:\s*1 \/ 1/.test(INDEX),
    'the shapes and the loader share one grid cell, so the plate sizes to its content');

  // Every Loader laid over content passes `plate`. `.skel-orb` is the class that
  // MEANS "over the shapes", so it is the one that has to.
  const bare = [];
  for (const f of tsx) {
    const src = stripTs(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/<Loader\b[^>]*className="[^"]*\bskel-orb\b[^"]*"[^>]*\/>/g)) {
      if (!/\bplate\b/.test(m[0])) bare.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  say(bare.length === 0, 'every Loader laid over a skeleton passes `plate`', bare.join(', '));
}

// ── B. a skeleton reserves the shape of ITS OWN page ────────────────────────
console.log('\n── every skeleton variant matches the page that uses it ────');
{
  // The register. A page is here with the variant that reserves ITS shape; a
  // <Skeleton> anywhere else fails until somebody says which shape is arriving.
  // Four of these were wrong on 2026-09-22 and the defect was invisible, because
  // nothing in the tree related a page to the shape it stands under.
  const VARIANT_OF = {
    'pages/Overview.tsx': 'overview',                 // .ov-body: status, quickview, attention, matrix, vitals
    'pages/control/ControlHome.tsx': 'control',       // health strip over the .ch-grid cards
    'pages/Services.tsx': 'table',                    // a real table, with a header row
    'pages/ServiceDetail.tsx': 'detail',              // breadcrumb, header, .dgrid panels
    'pages/ProjectDetail.tsx': 'detail',              // the same shape
    'pages/files/Diff.tsx': 'reader',                 // a column of lines
    'pages/files/FileView.tsx': 'reader',
    'pages/files/Editor.tsx': 'reader',
  };
  const seen = new Map();
  const wrong = [], unregistered = [];
  for (const f of tsx) {
    const src = stripTs(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/<Skeleton\b([^>]*)\/>/g)) {
      const at = `${rel(f)}:${src.slice(0, m.index).split('\n').length}`;
      const v = /variant="([a-z]+)"/.exec(m[1])?.[1] ?? 'panels';
      const want = VARIANT_OF[rel(f)];
      if (want === undefined) unregistered.push(`${at} (${v})`);
      else if (want !== v) wrong.push(`${at}: uses ${v}, registered ${want}`);
      seen.set(rel(f), v);
    }
  }
  say(seen.size >= 8, 'the <Skeleton> call sites are found', `${seen.size} files`);
  say(unregistered.length === 0, 'every page that shows a skeleton is registered with the shape it reserves', unregistered.join(', '));
  say(wrong.length === 0, 'and none of them stands under a variant shaped like a different page', wrong.join('; '));

  // The register, the union type and the implementation must be the same set.
  const declared = (/export type SkelVariant =([^;]*);/.exec(STATES)?.[1] ?? '')
    .split('|').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  const implemented = new Set([...STATES.matchAll(/variant === '([a-z]+)'/g)].map((m) => m[1]));
  const registered = new Set(Object.values(VARIANT_OF));
  say(declared.length > 0 && declared.every((v) => implemented.has(v)) && implemented.size === declared.length,
    'every variant in SkelVariant has a shape in Shapes()', `${declared.join(', ')} vs ${[...implemented].join(', ')}`);
  const orphan = declared.filter((v) => !registered.has(v));
  say(orphan.length === 0, 'and every variant is used by some page - a shape nobody stands under goes stale unseen', orphan.join(', '));

  // The shapes are measured, so they carry real numbers. A variant whose blocks
  // are all the same height is the "two identical 132px boxes" defect returning.
  // `bars(n, h)` counts as n blocks of h - it is the same declaration, spelled
  // shorter.
  for (const v of ['overview', 'control', 'detail']) {
    const body = new RegExp(`variant === '${v}'\\)[\\s\\S]*?\\n  \\}`).exec(STATES)?.[0] ?? '';
    const hs = [
      ...[...body.matchAll(/height: (\d+)/g)].map((m) => Number(m[1])),
      ...[...body.matchAll(/bars\((\d+), (\d+)\)/g)].flatMap((m) => Array(Number(m[1])).fill(Number(m[2]))),
    ];
    say(hs.length >= 3 && new Set(hs).size >= 2, `the ${v} skeleton reserves blocks of more than one height`, hs.join('/'));
  }
}

// ── C. a fallback may not name a port this box no longer publishes ──────────
console.log('\n── no loading or fallback path links to a dead port ────────');
{
  // Ports this repo publishes BY DEFAULT. A service behind `profiles:` is not
  // started by `just up-*`, so a link to it is a link to nothing - which is the
  // whole reason grepping for "9090" would have said Prometheus was still here.
  const composes = [];
  const scan = (d, depth = 0) => {
    if (depth > 4) return;
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === '.git' || n === 'dist') continue;
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) scan(p, depth + 1);
      else if (/^compose.*\.ya?ml$/.test(n) || /\.compose\.ya?ml$/.test(n)) composes.push(p);
    }
  };
  scan(REPO);
  const published = new Map(); // port -> "file:service"
  for (const f of composes) {
    const lines = readFileSync(f, 'utf8').split('\n');
    let inServices = false, svc = null, profiled = new Set(), ports = new Map();
    const flush = () => {
      if (!svc) return;
      if (!profiled.has(svc)) for (const [p, at] of ports) if (!published.has(p)) published.set(p, at);
      ports = new Map();
    };
    for (const line of lines) {
      if (/^services:/.test(line)) { inServices = true; continue; }
      if (/^\S/.test(line)) { flush(); inServices = false; svc = null; continue; }
      if (!inServices) continue;
      const s = /^  ([A-Za-z0-9._-]+):\s*$/.exec(line);
      if (s) { flush(); svc = s[1]; continue; }
      if (!svc) continue;
      if (/^\s+profiles:/.test(line)) profiled.add(svc);
      // "8428:8428", "127.0.0.1:5432:5432", '0.0.0.0:80:80'
      const m = /^\s+-\s*["']?(?:[\d.]+:)?(\d{2,5}):\d{2,5}(?:\/\w+)?["']?\s*$/.exec(line);
      if (m) ports.set(Number(m[1]), `${relative(REPO, f)}:${svc}`);
    }
    flush();
  }
  say(published.size >= 8, 'the repo\'s published host ports are found', `${published.size} ports`);
  say(!published.has(9090), 'and 9090 is NOT among them - prometheus is behind the legacy-prometheus profile');

  // The two registries that can invent a link out of a bare port: the Overview's
  // quick-links strip and the offline floor. Both are hand-written lists, and
  // both had a dead entry.
  const REGISTRIES = [
    ['pages/Overview.tsx', /const QUICK_ITEMS[\s\S]*?\n\];/],
    ['lib/discover.ts', /export const KNOWN_SERVICES[\s\S]*?\n\];/],
  ];
  const dead = [];
  let found = 0;
  for (const [f, re] of REGISTRIES) {
    const body = re.exec(stripTs(read(join(SRC, f))))?.[0];
    say(!!body, `${f} still declares the list this checks`);
    if (!body) continue;
    for (const m of body.matchAll(/(?:port:\s*|,\s*)(\d{2,5})\b/g)) {
      found++;
      if (!published.has(Number(m[1]))) dead.push(`${f}: ${m[1]}`);
    }
  }
  say(found >= 5, 'the ports in those lists are found', `${found} ports`);
  say(dead.length === 0, 'every port a fallback can invent a link from is published by this repo, by default', dead.join(', '));

  // And every hard-coded address anywhere on a rendering path. The dev mocks are
  // behind import.meta.env.DEV and never ship, so they are not read here.
  const urls = [];
  for (const f of tsx) {
    if (/\.dev\.tsx?$/.test(f)) continue;
    const src = stripTs(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/https?:\/\/[^'"`\s]*?:(\d{2,5})\b/g)) {
      if (!published.has(Number(m[1]))) urls.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length} -> :${m[1]}`);
    }
  }
  say(urls.length === 0, 'and no rendered URL points at a port this repo does not publish', urls.join(', '));
}

console.log(`\n  ${passes} pass · ${failures} fail`);
process.exit(failures ? 1 : 0);
