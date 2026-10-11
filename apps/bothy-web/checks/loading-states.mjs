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
//   D. WHAT THE PAGE DOES NOT WAIT FOR (2026-10-11). The disk measurement
//      (/-/api/docker/system/df, ~4.6s against the four list calls' 0.18s) was
//      the fifth member of loadAll's allSettled, which made its budget a
//      FIRST-PAINT budget - and api.ts said so, in capitals, as the reason the
//      budget could not be generous. Then the call outgrew the budget on a box
//      that had merely got bigger, and the Overview told its owner "Volume sizes
//      could not be read". So this section holds the structure that makes the
//      trade go away: four requests in the gate and not five, the measurement on
//      its own module with its own generous budget, a cadence that no event may
//      quicken, and - the other half of the same bug - a panel that says which
//      of its four states it is in. That last part is a truth table over the
//      compiled lib/df.ts, because "nearly silent by design" is what kept the
//      first half hidden, and silence is not something a screenshot can fail.
//
// Imports nothing but node builtins and reads the source tree, like its siblings
// - with ONE exception, § D's truth table, which imports the compiled lib/df.ts
// that checks/run.sh leaves beside this file.

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

// ── D. the disk measurement is outside the first-paint gate ────────────────
console.log('\n── nothing paints behind the disk measurement ──────────────');
{
  // LINE COMMENTS FIRST, then blocks - and that order is load-bearing here, for
  // a reason worth writing down. The shared stripTs strips `/* */` first, and
  // lib/api.ts's very first line reads "read-only APIs under /-/api/*". That
  // `/*` opens a block comment as far as a regex is concerned, so the shared
  // stripper swallowed everything down to the next `*/` - fifty lines, including
  // the whole of PortalData. The first version of this section therefore asserted
  // "PortalData carries no df" against a string that did not contain PortalData,
  // and it would have gone on passing after somebody put `df` back.
  const stripAll = (src) => stripTs(src.replace(/(^|[^:'"`])\/\/.*$/gm, '$1'));
  const API = stripAll(read(join(SRC, 'lib', 'api.ts')));
  const DATA = stripAll(read(join(SRC, 'lib', 'data.tsx')));
  const DF = stripAll(read(join(SRC, 'lib', 'df.ts')));
  const modules = [...new Set([...tsx, ...files.filter((f) => /\.tsx?$/.test(f))])];

  // loadAll IS the first-paint gate: `data` starts empty, every page shows a
  // Skeleton until `at` is non-zero (firstPoll), and allSettled waits for the
  // slowest member. So what is in this array decides how long the app is grey.
  const loadAll = /export async function loadAll\([\s\S]*?\n\}/.exec(API)?.[0] ?? '';
  say(!!loadAll, 'lib/api.ts still declares loadAll - the first-paint gate');
  say(!/system\/df/.test(loadAll), 'and the disk measurement is NOT one of the requests it waits for');
  const settled = /Promise\.allSettled\(\[([\s\S]*?)\n    \]\)/.exec(loadAll)?.[1] ?? '';
  const waited = [...settled.matchAll(/getJSON<[^>]*>\('([^']+)'/g)].map((m) => m[1]);
  say(waited.length === 4, 'four requests gate the first paint, not five', waited.join(' ') || '(none found)');
  say(waited.every((u) => !u.includes('system/df')), 'none of the four is /system/df', waited.join(' '));

  // The whole-poll object must not carry it either: a `df` on PortalData is how
  // it gets quietly readded to the gate, since `data` is what the pages read.
  const portalData = /export interface PortalData \{[\s\S]*?\n\}/.exec(API)?.[0] ?? '';
  say(!!portalData && !/^\s*df[?]?:/m.test(portalData), 'PortalData carries no `df` - it is not a whole-poll fact');
  const dfOnData = [];
  for (const f of modules) {
    const src = stripAll(readFileSync(f, 'utf8'));
    if (/\bdata\.df\b/.test(src)) dfOnData.push(rel(f));
  }
  say(dfOnData.length === 0, 'and no page reads `data.df`', dfOnData.join(', '));

  // One fetch of it in the app, and the module that owns the cadence is the only
  // caller. A second call site is a second cadence nobody is counting.
  const fetchers = [];
  for (const f of modules) {
    const src = stripAll(readFileSync(f, 'utf8'));
    if (/['"`][^'"`]*\/system\/df/.test(src)) fetchers.push(rel(f));
  }
  say(fetchers.length === 1 && fetchers[0] === 'lib/api.ts',
    'exactly one module requests /system/df, and it is lib/api.ts', fetchers.join(', ') || '(nobody)');
  say(/export async function loadDf\(/.test(API), 'it does so in loadDf(), a call of its own');
  const callers = [];
  for (const f of modules) {
    const src = stripAll(readFileSync(f, 'utf8'));
    if (rel(f) !== 'lib/api.ts' && /\bloadDf\(/.test(src)) callers.push(rel(f));
  }
  say(callers.length === 1 && callers[0] === 'lib/data.tsx',
    'and lib/data.tsx is its only caller - one cadence, in one place', callers.join(', ') || '(nobody)');

  // The budget may now be generous, which is the entire point of the move - but
  // it has to stay well inside the cadence, or a measurement can still be
  // running when the next one is due and the box gets two at once.
  const num = (src, k) => Number((new RegExp(`export const ${k} = ([\\d_]+)`).exec(src)?.[1] ?? '0').replace(/_/g, ''));
  const budget = num(DF, 'DF_TIMEOUT');
  const every = num(DF, 'DF_EVERY');
  say(budget >= 20_000, 'DF_TIMEOUT is GENEROUS now that nothing paints behind it', `${budget}ms`);
  say(every >= 120_000, 'DF_EVERY is no quicker than the 120s it was inside the poll', `${every}ms`);
  say(budget > 0 && budget * 2 <= every, 'and the budget is at most half the cadence - two can never overlap',
    `${budget}ms budget vs ${every}ms cadence`);

  // The cadence is the thing the 2026-10-07 incident was about: every container
  // healthcheck here runs through `docker exec` on the same daemon. So no event
  // may turn into a measurement on its own - becoming visible asks dfDueIn, and
  // a `focus` listener (which fires on every click back into the window) must
  // not exist on this loop at all.
  const loop = /function useDiskUsage\([\s\S]*?\n\}/.exec(DATA)?.[0] ?? '';
  say(!!loop, 'lib/data.tsx declares the measurement loop');
  say(/addEventListener\('visibilitychange'/.test(loop), 'it pauses and resumes with the tab');
  say(!/addEventListener\('focus'/.test(loop) && !/window\.addEventListener/.test(loop),
    'and it has NO focus listener - that would be a measurement per alt-tab');
  const onVis = /const onVisible = \(\) => \{([^}]*)\};/.exec(loop)?.[1] ?? '';
  say(/pulse\(\)/.test(onVis) && !/\brun\(\)/.test(onVis),
    'becoming visible ASKS whether one is due (pulse), it does not measure', onVis.trim() || '(no handler)');
  say(/dfDueIn\(/.test(loop), 'and that question is dfDueIn, the one the cadence is defined by');
  say(/if \(cancelled \|\| inFlight\.current\) return;/.test(loop),
    'never two at once - the one guard the daemon actually needs');
}

console.log('\n── the disk panel says which of four states it is in ──────');
{
  // The truth table. lib/df.ts imports nothing, so checks/run.sh compiles it
  // beside this file and the words are asserted rather than eyeballed.
  const df = await import('./df.mjs');
  const T = 1_000_000;
  const states = {
    never: df.dfInitial(),
    measuring: df.dfStarted(df.dfInitial()),
    ok: df.dfMeasured(df.dfInitial(), { Volumes: [{ Name: 'v', UsageData: { Size: 4 } }] }, T),
    failed: df.dfFailed(df.dfInitial(), { kind: 'timeout', afterMs: 30_000 }, T),
  };
  const remeasuring = df.dfStarted(states.ok);
  const staleFailed = df.dfFailed(states.ok, { kind: 'status', status: 500 }, T + 60_000);

  say(new Set(Object.values(states).map((s) => s.phase)).size === 4,
    'the four phases are distinct: never, measuring, ok, failed',
    Object.values(states).map((s) => s.phase).join('/'));

  // Every state says something. The old panel had one sentence for one of them
  // and nothing for the rest, which is what "nearly silent by design" bought.
  for (const [name, st] of Object.entries({ ...states, remeasuring, staleFailed })) {
    const r = df.dfReport(st, T + 1000);
    say(typeof r.provenance === 'string' && r.provenance.length > 0,
      `${name}: says where its numbers came from`, r.provenance);
  }

  const never = df.dfReport(states.never, T);
  say(never.hasNumbers === false && /not been measured/.test(never.message ?? ''),
    'never measured is its own answer, not an empty panel', never.message ?? '(none)');
  const measuring = df.dfReport(states.measuring, T);
  say(measuring.hasNumbers === false && measuring.canMeasure === false && /Measuring/.test(measuring.message ?? ''),
    'measuring says so, and offers no second button while it runs', measuring.message ?? '(none)');

  const ok = df.dfReport(states.ok, T + 12_000);
  say(ok.hasNumbers && !ok.stale && ok.provenance === 'measured 12s ago',
    'a measurement is reported WITH ITS AGE', ok.provenance);
  say(ok.meta === null, 'and the header chip is left to the caller\'s real total');

  // The decision this module exists to hold: a failure keeps the numbers.
  say(staleFailed.value === states.ok.value && staleFailed.at === T,
    'a failed attempt NEVER clears the last good measurement');
  const sf = df.dfReport(staleFailed, T + 61_000);
  say(sf.hasNumbers && sf.stale, 'so the panel still draws them, marked stale');
  say(/measured 1m ago/.test(sf.provenance) && /answered 500/.test(sf.provenance),
    'and names both ages and what went wrong', sf.provenance);
  const rm = df.dfReport(remeasuring, T + 5000);
  say(rm.hasNumbers && rm.stale && /measuring again/.test(rm.provenance),
    're-measuring keeps the old numbers on screen rather than blanking the panel', rm.provenance);

  // A timeout is not the only way this fails, and saying it is was the SECOND
  // bug: the panel printed "the daemon did not answer in time" for any failure.
  say(df.dfFailureOf({ name: 'TimeoutError' }).kind === 'timeout', 'a timeout is classed as a timeout');
  say(df.dfFailureOf({ status: 500 }).kind === 'status', 'an HTTP status is classed as a status');
  say(df.dfFailureOf(new Error('boom')).kind === 'unreachable', 'anything else is "never reached the daemon"');
  const budget = df.DF_TIMEOUT;
  say(df.dfWhy({ kind: 'timeout', afterMs: budget }) === `the daemon did not answer within ${budget / 1000}s`,
    'and the timeout sentence quotes the REAL budget', df.dfWhy({ kind: 'timeout', afterMs: budget }));
  say(df.dfWhy({ kind: 'status', status: 500 }) !== df.dfWhy({ kind: 'timeout', afterMs: budget }),
    'a 500 and a timeout do not read the same');

  // The cadence, as the state machine sees it.
  say(df.dfDueIn(states.never, T) === 0, 'a box that has never measured is due immediately');
  say(df.dfDueIn(states.ok, T) === df.DF_EVERY && df.dfDueIn(states.ok, T + df.DF_EVERY) === 0,
    'and a measured one is due again exactly DF_EVERY later');
  say(df.dfDueIn(states.measuring, T) === df.DF_EVERY,
    'while one is in flight nothing else is ever due');
  say(df.dfDueIn(states.failed, T) === df.DF_EVERY,
    'a FAILURE waits as long as a success - the old cache retried it on the next 10s poll');

  // And the panel's own markup: the "No persistent volumes." sentence may only
  // be reached with a real measurement in hand. That sentence, printed on a box
  // with fourteen volumes, is the bug this whole section descends from.
  const OV = stripTs(read(join(SRC, 'pages', 'Overview.tsx')));
  // Sliced between two executable anchors rather than matched with `\n\}`:
  // DiskBody's props are an inline object type, so its signature ends in `}) {`
  // and a `\n\}` match stops four lines in. The first version of this check did
  // exactly that, and then reported the guard it was looking for as missing.
  const from = OV.indexOf('function DiskBody(');
  const to = OV.indexOf('export function Overview(', from + 1);
  const body = from < 0 || to < 0 ? '' : OV.slice(from, to);
  say(!!body, 'pages/Overview.tsx still declares DiskBody, above the page');
  const guard = body.indexOf('!report.hasNumbers');
  const none = body.indexOf('No persistent volumes.');
  say(guard > 0 && none > guard, '"No persistent volumes." is behind the hasNumbers guard',
    guard > 0 ? `guard at ${guard}, sentence at ${none}` : '(no guard)');
  say(/report\.provenance|disk\.provenance/.test(OV), 'and the panel prints the provenance it was given');

  // The other page that draws these sizes. It said " · sizes unavailable",
  // which covered "never asked", "asking", "it failed" and "it failed four
  // minutes after answering" with one phrase - the same silence, one file over.
  const PD = stripTs(read(join(SRC, 'pages', 'ProjectDetail.tsx')));
  say(/dfReport\(/.test(PD) && /\.provenance/.test(PD), 'the system page says where its sizes came from too');
  say(!/sizes unavailable/.test(PD), 'and not with one phrase standing in for four states');
  say(!/could not be read - the daemon did not answer in time/.test(OV),
    'the one-sentence-for-every-failure line is gone');
}

console.log(`\n  ${passes} pass · ${failures} fail`);
process.exit(failures ? 1 : 0);
