// The design audit's batch 2 - tokens and shared primitives - turned into
// assertions so it cannot quietly come undone (docs/plans/design-audit-apple.md
// §7, 2026-09-21). Reads the source tree; imports the compiled lib/contract.ts
// and lib/motion.ts that run.sh puts beside it.
//
//   1. ONE BUTTON. No hand-written `btn` class outside components/ui/Button.tsx,
//      and every other raw <button> is a REGISTERED kind of control (a tab, a
//      row, an icon trigger...) - an unregistered class fails until somebody
//      says which family it belongs to or uses the primitive.
//      No stylesheet but ui/Button.css may give `.btn` a look.
//   2. A PRESS STATE exists, shrinks by the token, and is dropped under reduced
//      motion by both sources; the Button has a real disabled state.
//   3. TYPE. The root follows the browser (no px/rem font-size on html, :root or
//      body), the scale is closed and in rem, and every font-size in the shared
//      primitives is a --fs-* token.
//   4. MOTION. lib/motion.ts equals the CSS tokens; no literal duration and no
//      bare `ease` keyword in any transition or animation.
//   5. HIT, ELEVATION, SCRIM. --hit is 24px fine / 44px coarse; four shadow
//      steps and no old ones; a theme sets shadow COLOURS, never geometry; the
//      scrim darkens and the button variants clear 4.5:1 in every theme.
//   6. ICONS. --icon-* equals ui/Icon.tsx's ICON.
//   7. DOCS. docs/brand/reference/tokens.md is what scripts/gen-tokens-doc.mjs
//      generates from index.css today.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateTheme } from './contract.mjs';
import { DUR, EASE, EASE_EXIT, EASE_STANDARD, SPRING, SPRING_BOUNCE, STAGGER } from './motion.mjs';

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
const rel = (p) => relative(SRC, p);
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const stripTs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const cssFiles = files.filter((p) => p.endsWith('.css'));
const tsx = files.filter((p) => p.endsWith('.tsx'));
const INDEX = readFileSync(join(SRC, 'index.css'), 'utf8');

/** Every rule as { sel, body, media } with a brace counter (at-rules recursed). */
function rules(css) {
  const src = stripCss(css), out = [];
  const scan = (text, media) => {
    let i = 0, start = 0;
    while (i < text.length) {
      if (text[i] === '{') {
        const prelude = text.slice(start, i).trim();
        let depth = 1, j = i + 1;
        while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
        const body = text.slice(i + 1, j - 1);
        if (prelude.startsWith('@')) { if (!/^@keyframes/.test(prelude)) scan(body, `${media}${prelude} `); }
        else out.push({ sel: prelude, body, media });
        i = j; start = j; continue;
      }
      if (text[i] === '}') { i++; start = i; continue; }
      i++;
    }
  };
  scan(src, '');
  return out;
}
const decls = (body) => [...body.matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)].map((m) => [m[1], m[2].trim()]);
const tokensOf = (sel, media = '') => Object.fromEntries(rules(INDEX)
  .filter((r) => r.sel === sel && r.media === media)
  .flatMap((r) => [...r.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])));
const ROOT = tokensOf(':root');
const LIGHT = { ...ROOT, ...tokensOf(":root[data-theme='light']") };

// ── 1. one button ───────────────────────────────────────────────────────────
console.log('── every button look comes from components/ui/Button ─────');
{
  const BUTTON = join('components', 'ui', 'Button.tsx');
  const handBtn = [];
  for (const f of tsx) {
    if (rel(f) === BUTTON) continue;
    const s = stripTs(readFileSync(f, 'utf8'));
    for (const m of s.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
      const txt = (m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, ' ');
      if (/(^|\s)btn(\s|$)/.test(txt)) handBtn.push(`${rel(f)}: "${txt.trim()}"`);
    }
  }
  say(handBtn.length === 0, 'no hand-written `btn` class outside ui/Button.tsx (use <Button> or buttonClass())',
    handBtn.length ? `\n    ${handBtn.join('\n    ')}` : `(${tsx.length} files read)`);

  // The registry of controls that are NOT buttons. Every raw <button>'s first
  // class names one of these families; a new class fails until it is listed
  // here with the family it belongs to - or becomes a <Button>. Batch 3 (the
  // Menu/Popover primitives) is expected to empty the menu-row family.
  const FAMILIES = {
    'tab or segment (selection within a group; carries aria-selected/pressed)': [
      'topo-view-btn', 'sv-focus-btn', 'fx-sr-toggle', 'fx-panel-tab', 'fx-actbtn', 'chip', 'fx-rootchip',
    ],
    'row or card (a whole list item is the target; presses darken, never scale)': [
      'fx-row', 'fx-scm-row', 'fx-scm-grouph', 'fx-json-row', 'fx-sr-file', 'fx-sr-line', 'rd-dir', 'rd-doc',
      'rd-card', 'rd-recent', 'rd-toc-a', 'tm-row', 'fx-menu-item', 'theme-card', 'svc-group-head',
      'cl-topo-node', 'sa-verb',
    ],
    'icon trigger (a glyph with an aria-label; hit slop to --hit)': [
      'icon-btn', 'fx-hbtn', 'svc-act-btn', 'fx-filter-x', 'fx-tab-x', 'fx-rowbtn', 'sn-copy', 'set-cmd-copy',
      'logp-refresh', 'rd-root-btn', 'rd-scope-btn', 'rd-scope-go', 'ct-collapse', 'sort-btn', 'fx-dlbtn',
    ],
    'inline text action (reads as a link inside prose or a breadcrumb)': [
      'cl-link', 'md-reflink', 'mono', 'rd-inline', 'rd-crumb-root', 'rd-back', 'te-back', 'te-more', 'fx-sha',
    ],
    'field-shaped trigger (looks like the input it opens)': ['topbar-search'],
  };
  const ALLOWED = new Map(Object.entries(FAMILIES).flatMap(([fam, cs]) => cs.map((c) => [c, fam])));
  // Buttons whose className is a pure state expression (`on` / '') inside a
  // group container that carries the look (.chips, .seg-toggle, .tabs,
  // .vit-ranges), and the few with no class inside a styled parent.
  const STATE_ONLY_FILES = new Set([
    'components/PortsTab.tsx', 'components/RoutesTab.tsx', 'pages/control/Cluster.tsx', 'pages/settings/Audit.tsx',
    'components/Vitals.tsx', 'components/Tabs.tsx', 'pages/Overview.tsx', 'pages/control/ClusterTabs.tsx',
    'pages/files/Editor.tsx', 'components/SystemMatrix.tsx', 'pages/files/DocIndex.tsx', 'pages/files/Reader.tsx',
  ]);
  const unknown = [];
  let raw = 0;
  for (const f of tsx) {
    if (rel(f) === BUTTON) continue;
    const s = stripTs(readFileSync(f, 'utf8'));
    for (const m of s.matchAll(/<button\b([^>]*?)>/gs)) {
      raw++;
      const cm = m[1].match(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/);
      const lit = cm ? (cm[1] ?? cm[2]) : null;
      const first = lit != null ? lit.replace(/\$\{[^}]*\}/g, ' ').match(/[a-z][\w-]*/)?.[0] : null;
      if (first && ALLOWED.has(first)) continue;
      if (!first && STATE_ONLY_FILES.has(rel(f))) continue;
      unknown.push(`${rel(f)}: ${first ?? (cm ? cm[0].slice(0, 60) : '(no class)')}`);
    }
  }
  say(unknown.length === 0, 'every other raw <button> is a registered control kind',
    unknown.length ? `\n    ${unknown.join('\n    ')}` : `${raw} raw buttons in ${Object.keys(FAMILIES).length} families`);

  // Only ui/Button.css may give .btn a look. Elsewhere a rule that names .btn may
  // PLACE it - margins, flex, width, alignment - and nothing else.
  const LAYOUT = /^(margin|margin-[a-z]+|align-self|justify-self|flex|flex-[a-z]+|order|width|max-width|min-width|justify-content|grid-[a-z-]+|display)$/;
  const styled = [];
  for (const f of cssFiles) {
    const r = rel(f);
    if (r === join('components', 'ui', 'Button.css')) continue;
    for (const { sel, body } of rules(readFileSync(f, 'utf8'))) {
      if (!/\.btn(?![\w-])/.test(sel) || sel.includes(':where(')) continue; // the shared press/hit rules
      const bad = decls(body).filter(([p]) => !LAYOUT.test(p));
      if (bad.length) styled.push(`${r}: ${sel.replace(/\s+/g, ' ')} { ${bad.map(([p]) => p).join(', ')} }`);
    }
  }
  say(styled.length === 0, 'no stylesheet but ui/Button.css styles .btn (placing it is fine)',
    styled.length ? `\n    ${styled.join('\n    ')}` : '');
  // The variants exist, and the two destructive confirms use danger.
  const bcss = stripCss(readFileSync(join(SRC, 'components', 'ui', 'Button.css'), 'utf8'));
  for (const v of ['primary', 'secondary', 'ghost', 'danger', 'caution']) {
    say(bcss.includes(`.btn-${v}`), `Button.css defines the ${v} variant`);
  }
  say(/\.btn-danger\s*\{[^}]*color:\s*var\(--st-down-fg\)[^}]*\}/.test(bcss) && /\.btn-danger\s*\{[^}]*background:\s*transparent/.test(bcss),
    'danger is the UNFILLED --st-down-fg outline (decision 9)');
  say(/\.btn-sm\s*\{/.test(bcss), 'Button has one small size');
  say(/\.btn:is\(:disabled,\s*\[aria-disabled='true'\]\)\s*\{[^}]*opacity:\s*var\(--disabled-opacity\)/.test(bcss)
    && /:not\(:disabled,\s*\[aria-disabled='true'\]\):hover/.test(bcss),
    'Button has a real disabled state: the opacity token, and no hover');
  const data = readFileSync(join(SRC, 'pages', 'settings', 'Data.tsx'), 'utf8');
  say(/variant="danger"[\s\S]{0,200}?Yes, clear all/.test(data), '"Yes, clear all N" is a danger button');
  const kc = readFileSync(join(SRC, 'components', 'KubeConfirm.tsx'), 'utf8');
  say(/spec\.id\.startsWith\('delete-'\) \? 'danger'/.test(kc), 'a delete confirm ("Delete this pod", "Delete this job") is a danger button');
}

// ── 2. press ────────────────────────────────────────────────────────────────
console.log('\n── a press state, and reduced motion keeps only the dim ────');
{
  const rs = rules(INDEX);
  const press = rs.find((r) => /:active/.test(r.sel) && /\.btn/.test(r.sel) && /\.chip/.test(r.sel) && !r.media);
  say(!!press && /scale:\s*var\(--press-scale\)/.test(press.body), 'one shared :active rule shrinks .btn, .chip and the compact controls by --press-scale',
    press ? '' : '(no :active rule naming .btn and .chip)');
  const rows = rs.find((r) => /:active/.test(r.sel) && /\.nav-item/.test(r.sel) && !r.media);
  say(!!rows && /var\(--surface-press\)/.test(rows.body), 'rows (nav, tabs, menu rows) darken to --surface-press on press');
  say(rs.some((r) => /prefers-reduced-motion/.test(r.media) && /:active/.test(r.sel) && /scale:\s*none/.test(r.body)),
    'the OS reduced-motion setting drops the press scale');
  say(rs.some((r) => /html\[data-motion='reduce'\]/.test(r.sel) && /:active/.test(r.sel) && /scale:\s*none/.test(r.body)),
    'the in-app Motion setting drops it too');
  say(ROOT['--press-scale'] === '.97' && ROOT['--press-dur'] === '100ms', '--press-scale .97 and --press-dur 100ms',
    `${ROOT['--press-scale']} / ${ROOT['--press-dur']}`);
}

// ── 3. type ─────────────────────────────────────────────────────────────────
console.log('\n── the root follows the browser, the scale is closed ──────');
{
  const rootSize = [];
  for (const f of cssFiles) {
    for (const { sel, body } of rules(readFileSync(f, 'utf8'))) {
      if (!sel.split(',').some((s) => /^(html|:root|body)(\[[^\]]*\])*$/.test(s.trim()))) continue;
      for (const [p, v] of decls(body)) if ((p === 'font-size' || p === 'font') && !/%|inherit/.test(v)) rootSize.push(`${rel(f)}: ${sel} { ${p}: ${v} }`);
    }
  }
  say(rootSize.length === 0, 'no font-size on html, :root or body except a percentage', rootSize.join('; '));
  const STEPS = ['2xs', 'xs', 'sm', 'md', 'body', 'lg', 'xl', '2xl', 'display'];
  const fs = Object.keys(ROOT).filter((k) => k.startsWith('--fs-'));
  say(fs.length === STEPS.length && STEPS.every((s) => `--fs-${s}` in ROOT), `the type scale is exactly ${STEPS.length} steps`, fs.join(' '));
  say(STEPS.every((s) => /rem/.test(ROOT[`--fs-${s}`])), 'every step is in rem');
  say(STEPS.every((s) => `--lh-${s}` in ROOT && `--tr-${s}` in ROOT), 'every step has its own leading and tracking');
  const tr = STEPS.map((s) => parseFloat(ROOT[`--tr-${s}`]));
  say(tr[0] > 0 && tr.at(-1) < 0 && tr.every((v, i) => i === 0 || v <= tr[i - 1] + 1e-9),
    'tracking runs from positive on the smallest step to negative on display (R15.1)', tr.join(' '));
  const lh = STEPS.filter((s) => s !== 'body').map((s) => parseFloat(ROOT[`--lh-${s}`]));
  say(parseFloat(ROOT['--lh-display']) < parseFloat(ROOT['--lh-md']), 'leading tightens as the type grows (R15.2)');
  void lh;

  // Font sizes in the shared primitives are tokens.
  const PRIM_FILES = files.filter((p) => rel(p).startsWith(join('components', 'ui')) && p.endsWith('.css'));
  const PRIM_SEL = /^(\.btn|\.chip|\.chips button|\.tag|\.badge|\.kbd|kbd|\.tip|\.tabs|\.panel-h|\.page-head|\.page-sub|\.nav-item|\.topbar-search|\.seg-toggle|\.cmdk|\.tbl\b|\.pill|\.eyebrow|h1\b|\.skip-link|\.state h4|\.cnt|\.si-label)/;
  const bad = [];
  const check = (f, sel, body) => {
    for (const [p, v] of decls(body)) if (p === 'font-size' && !/^var\(--fs-[\w-]+\)$|^inherit$|^0$/.test(v)) bad.push(`${rel(f)}: ${sel.replace(/\s+/g, ' ').slice(0, 50)} { font-size: ${v} }`);
  };
  for (const f of PRIM_FILES) for (const { sel, body } of rules(readFileSync(f, 'utf8'))) check(f, sel, body);
  for (const { sel, body } of rules(INDEX)) if (sel.split(',').every((s) => PRIM_SEL.test(s.trim()))) check(join(SRC, 'index.css'), sel, body);
  say(bad.length === 0, 'every font-size in the shared primitives is a --fs-* token',
    bad.length ? `\n    ${bad.join('\n    ')}` : `${PRIM_FILES.length} ui/ stylesheets + the index.css primitives`);
  say(/button,\s*input,\s*select,\s*textarea\s*\{[^}]*font:\s*inherit/.test(stripCss(INDEX)),
    'form controls inherit the type (no Arial buttons, CT-7)');
}

// ── 4. motion ───────────────────────────────────────────────────────────────
console.log('\n── motion: JS equals CSS, and no literals ──────────────────');
{
  const ms = (v) => (/ms$/.test(v) ? parseFloat(v) : parseFloat(v) * 1000);
  const bez = (v) => (v.match(/cubic-bezier\(([^)]+)\)/)?.[1] ?? '').split(',').map(Number);
  const eq = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  const pairs = [
    ['--dur-fast', DUR.fast], ['--dur', DUR.base], ['--dur-slow', DUR.slow], ['--dur-exit', DUR.exit],
    ['--press-dur', DUR.press], ['--spring-dur-s', SPRING.short.settle], ['--spring-dur', SPRING.base.settle],
    ['--spring-dur-l', SPRING.long.settle], ['--spring-bounce-dur', SPRING_BOUNCE.settle], ['--stagger', STAGGER.step],
  ];
  const off = pairs.filter(([k, s]) => Math.abs(ms(ROOT[k] ?? 'NaN') - s * 1000) > 0.5).map(([k, s]) => `${k} ${ROOT[k]} vs ${s}s`);
  say(off.length === 0, 'lib/motion.ts durations equal the CSS tokens', off.join('; ') || `${pairs.length} pairs`);
  say(eq(bez(ROOT['--ease']), EASE) && eq(bez(ROOT['--ease-exit']), EASE_EXIT) && eq(bez(ROOT['--ease-standard']), EASE_STANDARD),
    'EASE, EASE_EXIT and EASE_STANDARD equal --ease, --ease-exit and --ease-standard');
  // The spring curve really is critically damped (samples of 1-(1+wt)e^-wt).
  const pts = (ROOT['--spring'].match(/linear\(([^)]+)\)/)?.[1] ?? '').split(',').map(Number);
  const n = pts.length - 1, T = SPRING.short.settle, w = 2 * Math.PI / 0.3;
  const worst = Math.max(...pts.map((y, i) => Math.abs(y - (i === n ? 1 : 1 - (1 + w * T * i / n) * Math.exp(-w * T * i / n)))));
  say(n >= 16 && worst < 0.01, '--spring is a critically damped curve (no overshoot, within 0.01)', `${n + 1} samples, max error ${worst.toFixed(4)}`);
  say(Math.abs(SPRING.base.damping - 2 * Math.sqrt(SPRING.base.stiffness)) < 1e-9, 'SPRING.base is critically damped in framer terms (damping = 2 sqrt(k))');

  const literal = [], bare = [];
  for (const f of cssFiles) {
    for (const { sel, body } of rules(readFileSync(f, 'utf8'))) {
      for (const [p, v] of decls(body)) {
        if (!/^(transition|animation)(-duration|-delay|-timing-function)?$/.test(p)) continue;
        if (/!important/.test(v)) continue; // the reduced-motion collapse (.01ms) is the one sanctioned literal
        const noVar = v.replace(/var\([^)]*\)/g, '').replace(/cubic-bezier\([^)]*\)|linear\([^)]*\)/g, '');
        if (/(^|[\s,(])\.?\d+(\.\d+)?m?s\b/.test(noVar)) literal.push(`${rel(f)}: ${sel.replace(/\s+/g, ' ').slice(0, 40)} { ${p}: ${v} }`);
        if (/(^|[\s,])(ease|ease-in|ease-out|ease-in-out)(?=$|[\s,])/.test(noVar)) bare.push(`${rel(f)}: ${sel.replace(/\s+/g, ' ').slice(0, 40)} { ${p}: ${v} }`);
        if (/cubic-bezier\(/.test(v)) literal.push(`${rel(f)}: ${sel.slice(0, 40)} { ${p}: a literal cubic-bezier }`);
      }
    }
  }
  say(literal.length === 0, 'no literal duration or curve in any transition or animation (SYS-9)', literal.length ? `\n    ${literal.join('\n    ')}` : '');
  say(bare.length === 0, 'no bare `ease` keyword (use --ease, --ease-exit or --ease-standard)', bare.length ? `\n    ${bare.join('\n    ')}` : '');
  const framer = [];
  for (const f of tsx) {
    const s = stripTs(readFileSync(f, 'utf8'));
    if (/useReducedMotion\b/.test(s)) framer.push(`${rel(f)}: framer's useReducedMotion (OS only; use useMotionReduced)`);
    for (const m of s.matchAll(/duration:\s*\d*\.?\d+/g)) framer.push(`${rel(f)}: ${m[0]}`);
    if (/ease:\s*\[/.test(s)) framer.push(`${rel(f)}: a literal ease array`);
    if (/behavior:\s*'smooth'/.test(s)) framer.push(`${rel(f)}: a smooth scroll that ignores reduced motion (use scrollBehavior())`);
  }
  say(framer.length === 0, 'framer and scroll code take lib/motion.ts and useMotionReduced (SYS-9, SYS-11)', framer.join('; '));
}

// ── 5. hit, elevation, scrim, button contrast ───────────────────────────────
console.log('\n── hit targets, the elevation ladder, the scrim ────────────');
{
  const coarse = rules(INDEX).find((r) => /pointer:\s*coarse/.test(r.media) && r.sel === ':root');
  say(ROOT['--hit'] === '1.5rem' && !!coarse && /--hit:\s*2\.75rem/.test(coarse.body),
    '--hit is 24px under a fine pointer and 44px under a coarse one (decision 6)',
    `${ROOT['--hit']} / ${coarse?.body.match(/--hit:\s*([^;]+)/)?.[1] ?? '(no coarse block)'}`);
  const need = ['.btn', '.chip', '.icon-btn', '.nav-item', '.dlg-x', '.ui-menu-item', '.tabs button'];
  const all = cssFiles.flatMap((f) => rules(readFileSync(f, 'utf8')));
  const missing = need.filter((c) => !all.some((r) => r.sel.split(',').some((s) => s.trim().startsWith(c) && !/:/.test(s.trim().slice(c.length, c.length + 1)))
    && /min-height:\s*var\(--hit\)/.test(r.body)));
  say(missing.length === 0, 'the compact controls take min-height: var(--hit)', missing.join(', '));
  say(/::after\s*\{[^}]*inset:\s*min\(0px,\s*calc\(\(100% - var\(--hit\)\)/.test(stripCss(INDEX)),
    'small drawn controls get an invisible hit slop reaching --hit');

  say([1, 2, 3, 4].every((i) => `--shadow-${i}` in ROOT) && !Object.keys(ROOT).some((k) => /^--shadow-(sm|md|lg)$/.test(k)),
    'four elevation steps, and the old sm/md/lg are gone (SYS-14)');
  const oldUse = cssFiles.filter((f) => /--shadow-(sm|md|lg)\b/.test(stripCss(readFileSync(f, 'utf8')))).map(rel);
  say(oldUse.length === 0, 'nothing still reads --shadow-sm/md/lg', oldUse.join(', '));
  const themeGeo = walk(join(SRC, 'themes')).filter((f) => /--shadow-(\d|sm|md|lg)\s*:/.test(stripCss(readFileSync(f, 'utf8')))).map(rel);
  say(themeGeo.length === 0, 'no theme sets shadow geometry, only --shadow-color and --shadow-hairline', themeGeo.join(', '));
  const blur = [];
  for (const f of cssFiles) for (const { sel, body } of rules(readFileSync(f, 'utf8'))) {
    for (const [p, v] of decls(body)) if (p === 'backdrop-filter' && !/^var\(--mat-/.test(v) && v !== 'none') blur.push(`${rel(f)}: ${sel.slice(0, 40)}`);
  }
  say(blur.length === 0, 'every backdrop-filter is a --mat-* material (top bar, palette scrim) - decision 4', blur.join('; '));
  const rt = rules(INDEX).find((r) => /prefers-reduced-transparency/.test(r.media));
  say(!!rt && /--mat-chrome-blur:\s*none/.test(rt.body) && /--mat-scrim-blur:\s*none/.test(rt.body), 'reduced transparency makes both materials solid');
  const hc = rules(INDEX).find((r) => /prefers-contrast:\s*more/.test(r.media));
  say(!!hc && /--line:/.test(hc.body) && /--line-strong:/.test(hc.body), 'prefers-contrast: more strengthens the lines');
  const oldScrim = cssFiles.filter((f) => /background:\s*color-mix\(in oklab,\s*var\(--bg\)\s*\d+%,\s*transparent\)/.test(stripCss(readFileSync(f, 'utf8')))
    && /overlay|scrim/.test(readFileSync(f, 'utf8'))).map(rel);
  say(oldScrim.length === 0, 'no overlay is a wash of --bg (that lightened the light theme)', oldScrim.join(', '));

  // Contrast: the contract's rule 2b, for both shipped themes and every accent.
  const acc = (a, id) => tokensOf(`:root[data-accent='${a}'][data-bothy-theme='${id}']`);
  const palettes = [
    ['Bothy Dark', 'dark', ROOT], ['Bothy Light', 'light', LIGHT],
    ['Dark + violet', 'dark', { ...ROOT, ...acc('violet', 'bothy-dark') }], ['Light + violet', 'light', { ...LIGHT, ...acc('violet', 'bothy-light') }],
    ['Dark + cyan', 'dark', { ...ROOT, ...acc('cyan', 'bothy-dark') }], ['Light + cyan', 'light', { ...LIGHT, ...acc('cyan', 'bothy-light') }],
  ];
  for (const [name, app, toks] of palettes) {
    const found = evaluateTheme(toks, app).filter((x) => x.id.startsWith('button/') || x.id === 'scrim/darkens');
    const bad = found.filter((x) => x.level !== 'pass');
    say(found.length === 5 && !bad.length, `${name}: every Button variant >= 4.5:1 (caution shares secondary's label) and the scrim darkens`,
      bad.length ? bad.map((x) => `${x.id} ${x.detail}`).join('; ') : found.map((x) => `${x.id.split('/')[1]} ${x.detail.replace(/^worst /, '').split(' on ')[0]}`).join(' · '));
  }
}

// ── 6. icons ────────────────────────────────────────────────────────────────
console.log('\n── icon sizes: CSS and ui/Icon.tsx agree ───────────────────');
{
  const icon = readFileSync(join(SRC, 'components', 'ui', 'Icon.tsx'), 'utf8');
  const js = Object.fromEntries([...(icon.match(/ICON\s*=\s*\{([^}]*)\}/)?.[1] ?? '').matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
  const css = Object.fromEntries(Object.entries(ROOT).filter(([k]) => k.startsWith('--icon-')).map(([k, v]) => [k.slice(7), parseFloat(v)]));
  say(JSON.stringify(js) === JSON.stringify(css) && Object.keys(js).length === 4, 'ICON equals --icon-xs/sm/md/lg', JSON.stringify(css));
}

// ── 7. docs ─────────────────────────────────────────────────────────────────
console.log('\n── the token reference is generated from the code ──────────');
{
  const doc = join(REPO, 'docs', 'brand', 'reference', 'tokens.md');
  const gen = join(SRC, '..', 'scripts', 'gen-tokens-doc.mjs');
  if (!existsSync(doc) || !existsSync(gen)) say(false, 'tokens.md and scripts/gen-tokens-doc.mjs exist', doc);
  else {
    const { render } = await import(gen);
    const want = render(INDEX);
    say(readFileSync(doc, 'utf8') === want, 'docs/brand/reference/tokens.md is current (run web/scripts/gen-tokens-doc.mjs)');
  }
}

console.log(`\n  ${passes} pass · ${failures} fail`);
process.exit(failures ? 1 : 0);
