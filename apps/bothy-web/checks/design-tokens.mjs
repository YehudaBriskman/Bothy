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
//   8. MOTION BEHAVIOUR (batch 3, 2026-09-22). No `mode="wait"` and one
//      AnimatePresence (the route cross-fade); no transition or keyframe of a
//      layout property (grid rows only in ui/Disclosure); no framer entrance
//      from opacity 0 or of height/width; the overlays move on transitions with
//      the hold timer, grow from the trigger and have reduced-motion values;
//      both global reduce blocks keep fades and drop movement; the Live pulse is
//      finite; the theme follows the OS by default and cross-fades on a switch.
//   9. THE SWEEP HOLDS (batch 4, 2026-09-22). Every font size is a scale token
//      (px only for the two geometry labels, em only for inline code); weights
//      on the five steps; no raw spacing or radius literal (1px hairlines
//      aside); no selector declared twice; every lucide glyph drawn through
//      ui/Icon; sticky chrome shows a scroll edge, not a hairline; the reading
//      measure is capped by the column's padding.
//  10. ONE LOADER (2026-09-22). `thinking-orbs` is imported only by
//      components/ui/Loader.tsx, and only lazily; LOADER equals --loader-*; the
//      Loader is paused under useMotionReduced() and speaks through role=status;
//      and no hand-made spinner comes back - no keyframe named or shaped like a
//      spinner, no .spin/.sa-spin class, no spun lucide glyph, no bare
//      "Loading…" text outside a Loader label.

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
  say(blur.length === 0, 'every backdrop-filter is a --mat-* material (top bar, palette) - decision 4', blur.join('; '));
  const rt = rules(INDEX).find((r) => /prefers-reduced-transparency/.test(r.media));
  say(!!rt && /--mat-chrome-blur:\s*none/.test(rt.body) && /--mat-palette-blur:\s*none/.test(rt.body) && /--mat-palette-bg:\s*var\(--surface-4\)/.test(rt.body), 'reduced transparency makes both materials solid (top bar, palette)');
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
  say(JSON.stringify(js) === JSON.stringify(css) && Object.keys(js).length === 5, 'ICON equals --icon-xs/sm/md/lg/xl', JSON.stringify(css));
}

// ── 8. motion behaviour (batch 3) ───────────────────────────────────────────
console.log('\n── motion behaviour: overlays, pages, layout, reduce, theme ─');
{
  const srcOf = (f) => stripTs(readFileSync(f, 'utf8'));
  // A missing primitive is a FAIL below, not a crash here.
  const readSafe = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  const waits = tsx.filter((f) => /mode\s*=\s*\{?\s*["']wait["']/.test(srcOf(f))).map(rel);
  say(waits.length === 0, 'no AnimatePresence mode="wait" - pages cross-fade, never a blank frame (SYS-8, decision 2)', waits.join(', '));
  const presence = tsx.filter((f) => /<AnimatePresence\b/.test(srcOf(f))).map(rel);
  say(presence.length === 1 && presence[0] === join('components', 'RouteFade.tsx'),
    'AnimatePresence lives only in components/RouteFade.tsx', presence.join(', '));
  const rf = readSafe(join(SRC, 'components', 'RouteFade.tsx'));
  const exitDur = /exit=\{\{[^}]*duration:\s*DUR\.exit/.test(rf), enterDur = /duration:\s*reduce \? DUR\.fast : DUR\.base/.test(rf);
  say(/mode="popLayout"/.test(rf) && exitDur && enterDur && Math.max(DUR.base, DUR.exit) <= 0.2,
    'the route fade overlaps (popLayout) and ends by 200ms', `enter ${DUR.base * 1000}ms, exit ${DUR.exit * 1000}ms`);

  // Layout properties never animate. Transitions are read per declaration;
  // keyframes are read from their bodies (rules() skips @keyframes).
  const LAYOUT = /^(width|height|min-width|min-height|max-width|max-height|top|left|right|bottom|inset|margin(-[a-z]+)?|padding(-[a-z]+)?|gap|flex(-basis|-grow|-shrink)?|font-size|line-height|stroke-width|r|cx|cy|border-width|grid-template-columns|grid-template-rows)$/;
  const moved = [];
  for (const f of cssFiles) {
    const css = stripCss(readFileSync(f, 'utf8'));
    for (const { sel, body } of rules(css)) for (const [p, v] of decls(body)) {
      if (p === 'transition-property') { for (const x of v.replace(/!important/, '').split(',').map((t) => t.trim())) if (LAYOUT.test(x)) moved.push(`${rel(f)}: ${sel.slice(0, 40)} { transition-property: ${x} }`); continue; }
      if (p !== 'transition') continue;
      for (const part of v.split(/,(?![^(]*\))/)) {
        const prop = part.trim().split(/\s+/)[0];
        if (!LAYOUT.test(prop)) continue;
        if (prop === 'grid-template-rows' && rel(f) === join('components', 'ui', 'Disclosure.css')) continue;
        moved.push(`${rel(f)}: ${sel.replace(/\s+/g, ' ').slice(0, 40)} { transition: ${prop} }`);
      }
    }
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)) {
      for (const d of m[2].matchAll(/([a-z-]+)\s*:/g)) if (LAYOUT.test(d[1])) moved.push(`${rel(f)}: @keyframes ${m[1]} animates ${d[1]}`);
    }
  }
  say(moved.length === 0, 'no transition or keyframe animates a layout property (SYS-10, R11.1) - grid rows only in ui/Disclosure',
    moved.length ? `\n    ${moved.join('\n    ')}` : '');
  const fm = [];
  for (const f of tsx) {
    const t = srcOf(f);
    for (const m of t.matchAll(/(initial|animate|exit)\s*=\s*\{\{([^}]*)\}/g)) {
      if (/\b(height|width|top|left)\s*:/.test(m[2])) fm.push(`${rel(f)}: framer ${m[1]} animates a layout property`);
      if (m[1] === 'initial' && /opacity:\s*0\b/.test(m[2]) && rel(f) !== join('components', 'RouteFade.tsx')) fm.push(`${rel(f)}: a framer entrance from opacity 0`);
    }
    if (/from 'framer-motion'/.test(t) && !/useMotionReduced|riseIn\(|reduce\b/.test(t) && !/MotionConfig/.test(t)) fm.push(`${rel(f)}: framer without a reduced-motion branch`);
  }
  say(fm.length === 0, 'framer: no height/width tweens, no entrance from opacity 0 outside the cross-fade, and every user asks useMotionReduced (SYS-11)', fm.join('; '));
  say(/--z-modal:\s*\d+/.test(stripCss(INDEX)) && /--z-popover:\s*\d+/.test(stripCss(INDEX)), 'the floating layers are tokens (--z-modal, --z-popover, --z-tooltip)');

  // Overlays: transitions + the hold timer, from the trigger, reduce values.
  const POP = readSafe(join(SRC, 'components', 'ui', 'Popover.css'));
  const DLG = readSafe(join(SRC, 'components', 'ui', 'Dialog.css'));
  const popR = rules(POP), dlgR = rules(DLG);
  say(popR.some((r) => /\.ui-pop\b/.test(r.sel) && /transform-origin:\s*var\(--radix-popper-transform-origin\)/.test(r.body)),
    'popovers and menus grow out of their trigger (transform-origin at the popper origin, R7.2)');
  const closed = (rs) => rs.find((r) => /\[data-state='closed'\]/.test(r.sel) && /animation:\s*overlay-hold/.test(r.body) && /transition:/.test(r.body));
  say(!!closed(popR) && !!closed(dlgR), 'popover and dialog closed states are TRANSITIONS back along the path, held by overlay-hold (R3.2, R7.1)');
  say(/@starting-style/.test(POP) && /@starting-style/.test(DLG), 'both enter from @starting-style (no in-keyframe to restart from)');
  say(/var\(--spring\)/.test(POP) && /var\(--spring\)/.test(DLG), 'both move on the critically damped --spring (decision 1)');
  say(!/@keyframes\s+(dlg-in|dlg-out|ui-menu-in|set-drawer-in)/.test(cssFiles.map((f) => readFileSync(f, 'utf8')).join('\n')),
    'the old enter-only keyframes (dlg-in, ui-menu-in, set-drawer-in) are gone');
  const reduceBoth = (css, v) => rules(css).some((r) => /prefers-reduced-motion:\s*reduce/.test(r.media) && r.body.includes(v))
    && rules(css).some((r) => /html\[data-motion='reduce'\]/.test(r.sel) && r.body.includes(v));
  say(reduceBoth(POP, '--pop-from-scale: 1') && reduceBoth(DLG, '--ov-from: none'),
    'the overlays drop scale and rise under BOTH reduce sources, and keep the fade (decision 3)');
  const dlgTsx = readSafe(join(SRC, 'components', 'ui', 'Dialog.tsx'));
  say(/function ghostOut/.test(dlgTsx) && (dlgTsx.match(/useExitGhost\(\)/g) ?? []).length >= 2,
    'a dialog unmounted while open leaves a ghost that plays the exit (both shapes)');

  // The global reduce blocks: fades stay, movement goes.
  const PREFS = readFileSync(join(SRC, 'prefs.css'), 'utf8');
  const fadeList = (body) => { const m = body.match(/transition-property:\s*([^;]+)/); if (!m) return null; return m[1].replace(/!important/, '').split(',').map((x) => x.trim()); };
  const osBlock = rules(INDEX).filter((r) => /prefers-reduced-motion:\s*reduce/.test(r.media) && /transition-property/.test(r.body));
  const appBlock = rules(PREFS).filter((r) => /html\[data-motion='reduce'\]/.test(r.sel) && /transition-property/.test(r.body));
  const ok = (bl) => bl.length > 0 && bl.every((r) => { const l = fadeList(r.body); return l && l.includes('opacity') && !l.some((x) => /transform|translate|scale|rotate|all/.test(x)); });
  say(ok(osBlock) && ok(appBlock), 'OS and in-app reduce: transitions limited to opacity and colour - movement lands, fades stay (decision 3)');
  const reduceRules = [...rules(INDEX).filter((r) => /prefers-reduced-motion:\s*reduce/.test(r.media)), ...rules(PREFS).filter((r) => /data-motion='reduce'/.test(r.sel))];
  const noZero = reduceRules.every((r) => !/transition-duration:\s*\.01ms/.test(r.body));
  say(noZero, 'neither reduce block zeroes transition durations any more (that removed the fades too, ST-11)');
  const exempt = (css, sel) => rules(css).some((r) => r.sel.includes(sel) && /animation-duration:\s*\.01ms/.test(r.body));
  say(exempt(INDEX, ':not(.overlay-motion)') && exempt(PREFS, ':not(.overlay-motion)'), 'both reduce blocks leave the overlays\' hold timer running');
  const pulse = stripCss(INDEX);
  say(/\.pill \.pulse::after\s*\{[^}]*animation:[^;]*\b3\s*;/.test(pulse) && !/infinite[^;]*;\s*\}[^{]*\.pill/.test(pulse) && !/\.pill\.live \.pulse \{[^}]*infinite/.test(pulse),
    'the Live pulse runs 3 times on a change, not forever (SH-11)');

  // The theme follows the OS, and a switch cross-fades.
  const themes = readFileSync(join(SRC, 'lib', 'themes.ts'), 'utf8');
  const html = readFileSync(join(SRC, '..', 'index.html'), 'utf8');
  const theme = readFileSync(join(SRC, 'lib', 'theme.tsx'), 'utf8');
  say(/DEFAULT_SELECTION:\s*Selection\s*=\s*'system'/.test(themes) && /getItem\('portal-theme'\)\s*\|\|\s*'system'/.test(html),
    "the theme follows the OS by default, in the app and the pre-paint script (SYS-19, decision 5)");
  say(/startViewTransition/.test(theme) && /typeof doc\.startViewTransition !== 'function'/.test(theme) && /::view-transition-old\(root\)/.test(INDEX),
    'a theme switch is a view-transition cross-fade, guarded for browsers without it');
}

// ── 9. the sweep holds (batch 4) ────────────────────────────────────────────
console.log('\n── batch 4: type, rhythm, icons and edges stay on the tokens ─');
{
  const COMPONENT_CSS = cssFiles.filter((f) => !rel(f).startsWith('themes'));
  const all = COMPONENT_CSS.map((f) => ({ f: rel(f), rs: rules(readFileSync(f, 'utf8')) }));
  const where = (f, sel) => `${f}: ${sel.replace(/\s+/g, ' ').slice(0, 56)}`;

  // TYPE. The allowlist is the whole of it, each entry with its reason:
  //   px  - labels whose box is geometry in another unit: the chart ticks sit
  //         in an SVG laid out in JS px (TimeChart PAD), the 3D nameplates are
  //         scaled by drei's distanceFactor. Both hold a step's px value.
  //   em  - inline code/mono inside running text, sized to the text around it.
  //   the reader - --read-* and --code-fs are tokens; --rd-ui-fs is the user's
  //         panel size and its fixed ratios (pages/files/reading.ts).
  const PX_OK = new Map([['.tc-ytick, .tc-xtick', 11], ['.sv-plate-txt', 13]]);
  const EM_OK = new Set(['.sa-title .mono', ':is(.set-shell, .upd-plan) .upd-code', '.bothy-files .md .md-img-remote', '.bothy-files .md .md-code']);
  const STEP_PX = [11, 12, 13, 14, 16, 17, 21, 28];
  const TOKEN_FS = /^(var\(--fs-(2xs|xs|sm|md|body|lg|xl|2xl|display)\)|var\(--read-(fs|h[1-4])\)|var\(--code-fs\)|var\(--rd-ui-fs\)|calc\(var\(--rd-ui-fs\) \* 0?\.\d+\)|inherit|0)$/;
  const badFs = [], pxKept = [], emKept = [], badFw = [];
  let decl = 0;
  for (const { f, rs } of all) for (const { sel, body } of rs) for (const [p, v] of decls(body)) {
    if (p === 'font-size') {
      decl++;
      const s = sel.replace(/\s+/g, ' ');
      const px = v.match(/^(\d*\.?\d+)px$/);
      if (px && PX_OK.get(s) === Number(px[1]) && STEP_PX.includes(Number(px[1]))) pxKept.push(s);
      else if (/^\d*\.?\d+em$/.test(v) && EM_OK.has(s)) emKept.push(s);
      else if (!TOKEN_FS.test(v)) badFs.push(`${where(f, sel)} { font-size: ${v} }`);
    }
    if (p === 'font-weight' && !/^(400|500|600|700|800|normal|bold|inherit|var\(--fw-(regular|medium|semibold|bold|heavy)\))$/.test(v)) badFw.push(`${where(f, sel)} { font-weight: ${v} }`);
    if (p === 'font' && /\d(px|rem|em)\b/.test(v)) badFs.push(`${where(f, sel)} { font: ${v} } (a size in the shorthand)`);
  }
  say(badFs.length === 0, 'every font-size is a scale token - px and em only on the documented allowlist (SYS-13)',
    badFs.length ? `\n    ${badFs.join('\n    ')}` : `${decl} declarations; px kept: ${pxKept.join(', ')}; em: ${emKept.length}`);
  say(pxKept.length === PX_OK.size, 'the px allowlist is live and on-scale (a stale entry fails)', pxKept.join(', '));
  say(badFw.length === 0, 'font weights are the five steps (no 550/650/750)', badFw.join('; '));
  const readPx = Object.entries(ROOT).filter(([k, v]) => /^--(read|rd|code)-/.test(k) && /\d(px)\b/.test(v)).map(([k, v]) => `${k}: ${v}`);
  const codeFs = /--code-fs:\s*var\(--fs-/.test(stripCss(readFileSync(join(SRC, 'pages', 'files', 'shell.css'), 'utf8')));
  say(readPx.length === 0 && codeFs && /--read-fs:\s*var\(--fs-body\)/.test(stripCss(INDEX)), 'the reader sizes are rem tokens: --read-*, --rd-ui-fs, --code-fs (FL-5)', readPx.join('; '));
  const reading = readFileSync(join(SRC, 'pages', 'files', 'reading.ts'), 'utf8');
  say(/'--read-fs':\s*`\$\{r\.doc \/ 16\}rem`/.test(reading) && /'--rd-ui-fs':\s*`\$\{r\.ui \/ 16\}rem`/.test(reading),
    'the reading-size setting is written in rem, so the browser text size still reaches it');
  const inlineFs = [];
  for (const f of tsx) for (const m of stripTs(readFileSync(f, 'utf8')).matchAll(/fontSize:\s*(`[^`]*`|'[^']*'|[^,}]+)/g)) {
    if (!/var\(--fs-|rem`/.test(m[1])) inlineFs.push(`${rel(f)}: fontSize: ${m[1].trim()}`);
  }
  say(inlineFs.length === 0, 'no inline px font size in a component', inlineFs.join('; '));
  const used = new Set(); for (const f of COMPONENT_CSS) for (const m of stripCss(readFileSync(f, 'utf8')).matchAll(/var\((--(fs|lh|tr)-[\w-]+)\)/g)) used.add(m[1]);
  const unknownTok = [...used].filter((t) => !(t in ROOT));
  say(unknownTok.length === 0, 'every --fs/--lh/--tr token used exists (a typo is a size silently dropped)', unknownTok.join(', '));

  // RHYTHM. padding/margin/gap: tokens only; the one literal is a 1px hairline
  // nudge. calc() may combine tokens with unitless factors. Radii: --r-* only.
  const SPACING = /^(padding(-[a-z]+)*|margin(-[a-z]+)*|gap|row-gap|column-gap)$/;
  const RADIUS = /^border(-[a-z]+)*-radius$/;
  const badSp = [], badR = [];
  let spN = 0, rN = 0;
  for (const { f, rs } of all) for (const { sel, body } of rs) for (const [p, v] of decls(body)) {
    const bare = v.replace(/!important/, '').replace(/var\([^()]*\)/g, 'V');
    if (SPACING.test(p)) {
      spN++;
      const lits = [...bare.matchAll(/-?\d*\.?\d+(px|rem|em|ch|vh|vw)\b/g)].map((m) => m[0]).filter((x) => !/^-?1px$/.test(x));
      if (lits.length) badSp.push(`${where(f, sel)} { ${p}: ${v} }`);
    }
    if (RADIUS.test(p)) {
      rN++;
      if (/\d(px|rem|em)\b/.test(bare)) badR.push(`${where(f, sel)} { ${p}: ${v} }`);
    }
  }
  say(badSp.length === 0, 'no raw spacing literal in component CSS - --sp-* only, 1px hairlines aside (SYS-15)',
    badSp.length ? `\n    ${badSp.slice(0, 40).join('\n    ')}${badSp.length > 40 ? `\n    ... ${badSp.length - 40} more` : ''}` : `${spN} declarations`);
  say(badR.length === 0, 'no raw radius literal - --r-* only (SYS-15)', badR.length ? `\n    ${badR.join('\n    ')}` : `${rN} declarations`);
  const spSteps = Object.keys(ROOT).filter((k) => k.startsWith('--sp-'));
  say(spSteps.every((k) => /rem$/.test(ROOT[k])) && '--sp-3_5' in ROOT && '--r-2xs' in ROOT, 'the spacing steps are rem (with --sp-3_5) and radii have --r-2xs', spSteps.join(' '));
  const jsPad = [];
  for (const f of tsx) for (const m of stripTs(readFileSync(f, 'utf8')).matchAll(/(padding|margin)(Left|Right|Top|Bottom)?:\s*(`[^`]*`|\d+)/g)) {
    if (/^\d+$/.test(m[3]) && m[3] !== '0' || /px`$/.test(m[3])) jsPad.push(`${rel(f)}: ${m[0]}`);
  }
  say(jsPad.length === 0, 'inline paddings and indents are token calcs, not px (they must line up with the CSS)', jsPad.join('; '));

  // DUPLICATES. One copy of each rule: the same whole selector twice in one
  // stylesheet (same @media), or in two stylesheets, is a fail. A rule that
  // only sets custom properties is a parameterisation (the drawer's motion
  // lives with ui/Dialog), not a copy; :root blocks are token groups.
  const seen = new Map(), dup = [];
  for (const { f, rs } of all) for (const { sel, body, media } of rs) {
    const s = sel.replace(/\s+/g, ' ');
    if (/^(:root|html|body|\*)/.test(s)) continue;
    if (decls(body).every(([p]) => p.startsWith('--')) && /--/.test(body)) continue;
    const k = `${media}|${s}`;
    if (seen.has(k)) dup.push(`${s}${media ? ` [${media.trim()}]` : ''}: ${seen.get(k)} and ${f}`);
    else seen.set(k, f);
  }
  say(dup.length === 0, 'no selector is declared twice, in one stylesheet or across two (SYS-15: the .ov-* copies)', dup.join('; '));

  // ICONS. lucide is drawn only by ui/Icon: no JSX element named after a
  // lucide import, and no numeric size prop on any component but the brand mark.
  const ICON_FILE = join('components', 'ui', 'Icon.tsx');
  const direct = [], numeric = [];
  for (const f of tsx) {
    if (rel(f) === ICON_FILE) continue;
    const s = stripTs(readFileSync(f, 'utf8'));
    const imp = s.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-react'/);
    const names = imp ? imp[1].split(',').map((x) => x.trim()).filter((x) => x && !x.startsWith('type ')).map((x) => x.split(/\s+as\s+/).pop()) : [];
    for (const n of names) if (new RegExp(`<${n}[\\s/>]`).test(s)) direct.push(`${rel(f)}: <${n}>`);
    for (const m of s.matchAll(/<([A-Z][\w.]*|[a-z]\w*\.[A-Z][\w.]*)\b[^<>]*?\ssize=\{\d+(\.\d+)?\}/g)) if (m[1] !== 'BothyMark') numeric.push(`${rel(f)}: <${m[1]} size={n}>`);
  }
  say(direct.length === 0 && numeric.length === 0, 'every icon is drawn through ui/Icon - no bare lucide glyph, no numeric size (SYS-15)',
    [...direct, ...numeric].join('; ') || `${tsx.length} files`);

  // EDGES. Sticky chrome has no permanent bottom hairline; the top bar and the
  // Settings phone bar shade when the page is under them, the in-pane ones
  // when their scroller is. Every table wrapper can report that it scrolled.
  const sticky = [];
  for (const { f, rs } of all) for (const { sel, body } of rs) {
    if (/position:\s*sticky/.test(body) && /border-bottom:\s*1px/.test(body)) sticky.push(where(f, sel));
  }
  say(sticky.length === 0, 'no sticky element draws a permanent bottom hairline (SYS-16)', sticky.join('; '));
  const edgeRule = (re) => all.some(({ rs }) => rs.some((r) => re.test(r.sel.replace(/\s+/g, ' ')) && /box-shadow:\s*var\(--shadow-edge\)/.test(r.body)));
  const edges = [
    ['the top bar', /^html\[data-scrolled\] \.topbar$/], ['table headers', /\[data-shade-t\] \.tbl th$/],
    ['the Settings phone bar', /^html\[data-scrolled\] \.set-shell \.set-mobile-bar$/],
    ['the reader index header', /\[data-shade-t\] \.rd-index-h$/], ['the diff summary', /\[data-shade-t\] \.fx-diff-sum$/],
  ].filter(([, re]) => !edgeRule(re)).map(([n]) => n);
  say('--shadow-edge' in ROOT && edges.length === 0, 'the sticky chrome takes --shadow-edge only when something is under it', edges.join(', '));
  const scroll = readFileSync(join(SRC, 'lib', 'scroll.ts'), 'utf8');
  say(/export function usePageScrolled/.test(scroll) && /usePageScrolled\(\)/.test(readFileSync(join(SRC, 'components', 'AppShell.tsx'), 'utf8')),
    'html[data-scrolled] is kept by lib/scroll.ts and mounted by the AppShell');
  const wraps = [];
  for (const f of tsx) for (const m of stripTs(readFileSync(f, 'utf8')).matchAll(/className=(?:"([^"]*\btbl-wrap\b[^"]*)"|\{`([^`]*\btbl-wrap\b[^`]*)`\})/g)) {
    if (!/\bscroll-shade\b/.test(m[1] ?? m[2])) wraps.push(`${rel(f)}: ${(m[1] ?? m[2]).slice(0, 40)}`);
  }
  say(wraps.length === 0, 'every .tbl-wrap is a .scroll-shade', wraps.join('; '));
  const top = rules(INDEX).find((r) => r.sel === '.topbar' && !r.media);
  const setBar = all.flatMap(({ rs }) => rs).find((r) => r.sel.replace(/\s+/g, ' ') === '.set-shell .set-mobile-bar' && /sticky/.test(r.body));
  say('--topbar-h' in ROOT && !!top && /height:\s*var\(--topbar-h\)/.test(top.body) && !!setBar && /top:\s*var\(--topbar-h\)/.test(setBar.body),
    'the top bar IS --topbar-h tall, and the Settings phone bar sticks under it (ST-6)');

  // MEASURE (FL-5): capped in ch, applied as the column's padding, never as a
  // max-width on the scroller or a per-block width.
  const ed = stripCss(readFileSync(join(SRC, 'pages', 'files', 'editor.css'), 'utf8'));
  say(/^\d+ch$/.test(ROOT['--read-measure'] ?? '') && /\.fx-read \{[^}]*padding:[^;]*var\(--read-measure\)/.test(ed) && !/\.fx-read > \* \{[^}]*max-width/.test(ed) && !/\.fx-read \{[^}]*max-width/.test(ed),
    'the reading measure is capped in ch by the column padding - one width, scrollbar on the edge (FL-5)', ROOT['--read-measure']);
}

// ── 10. one loader ──────────────────────────────────────────────────────────
console.log('\n── one loader: ui/Loader is the only loading indicator ─────');
{
  const LOADER_FILE = join('components', 'ui', 'Loader.tsx');
  const code = files.filter((p) => /\.(tsx?|mjs|js)$/.test(p));
  const importers = code.filter((f) => /from\s+'thinking-orbs'|import\(\s*'thinking-orbs'\s*\)/.test(stripTs(readFileSync(f, 'utf8')))).map(rel);
  say(importers.length === 1 && importers[0] === LOADER_FILE, 'thinking-orbs is imported only by components/ui/Loader.tsx', importers.join(', ') || '(nobody)');
  const LP = join(SRC, LOADER_FILE);
  const L = existsSync(LP) ? stripTs(readFileSync(LP, 'utf8')) : '';
  say(/import\(\s*'thinking-orbs'\s*\)/.test(L) && !/^import\s+(?!type\b)[^;]*from\s+'thinking-orbs'/m.test(L),
    'and only LAZILY (a dynamic import) - the orb stays out of the first paint');
  const js = Object.fromEntries([...(L.match(/LOADER\s*=\s*\{([^}]*)\}/)?.[1] ?? '').matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
  const css = Object.fromEntries(Object.entries(ROOT).filter(([k]) => /^--loader-(sm|md|lg)$/.test(k)).map(([k, v]) => [k.slice(9), parseFloat(v)]));
  say(JSON.stringify(js) === JSON.stringify(css) && JSON.stringify(Object.values(js)) === '[20,32,64]',
    'LOADER equals --loader-sm/md/lg, and they are the orb\'s own presets (20, 32, 64)', JSON.stringify(css));
  say(/useMotionReduced\(\)/.test(L) && /paused=\{reduced\}/.test(L), 'the orb is PAUSED under reduced motion - the OS setting or the in-app one (useMotionReduced)');
  say(/role=\{announce \? 'status'/.test(L) && /aria-live=\{announce \? 'polite'/.test(L) && /aria-hidden="true"/.test(L),
    'the Loader speaks through role=status / aria-live=polite, and its canvas is aria-hidden');
  say(!/\bactive\s*[?:]/.test(L.match(/interface LoaderProps[\s\S]*?\n\}/)?.[0] ?? ''), 'no `active` prop - a Loader is mounted only while something is in progress');

  // No hand-made spinner. The allowlist is the whole of it, each with a reason:
  //   lib/icons.tsx LoaderCircle - the STATIC glyph of the `starting` status. A
  //     status is a category (legends, filters, rows); it does not move.
  const SPIN_KF = /^(spin|rotate|turn|loading|loader|spinner)$|(^|-)(spin|rotate|turn|spinner)(-|$)/;
  const kf = [];
  for (const f of cssFiles) {
    const t = stripCss(readFileSync(f, 'utf8'));
    for (const m of t.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)) {
      if (SPIN_KF.test(m[1]) || /rotate\(|rotate:\s/.test(m[2])) kf.push(`${rel(f)}: @keyframes ${m[1]}`);
    }
  }
  say(kf.length === 0, 'no keyframe named or shaped like a spinner (spin, rotate, turn, loading; a rotate() inside)', kf.join('; '));
  const cls = [], glyph = [], bare = [];
  const GLYPH_OK = new Map([[join('lib', 'icons.tsx'), 'LoaderCircle']]);
  for (const f of tsx) {
    if (rel(f) === LOADER_FILE) continue;
    const t = stripTs(readFileSync(f, 'utf8'));
    for (const m of t.matchAll(/className=(?:"([^"]*)"|'([^']*)'|\{[^}]*?['"`]([^'"`]*)['"`][^}]*\})/g)) {
      const c = m[1] ?? m[2] ?? m[3] ?? '';
      if (/(^|\s)(spin|sa-spin|spinner|loading-spinner|ka-live)(\s|$)/.test(c)) cls.push(`${rel(f)}: "${c}"`);
    }
    const imp = t.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-react'/)?.[1] ?? '';
    for (const n of ['LoaderCircle', 'Loader2', 'LoaderPinwheel', 'Loader']) {
      if (new RegExp(`\\b${n}\\b`).test(imp) && GLYPH_OK.get(rel(f)) !== n) glyph.push(`${rel(f)}: ${n}`);
    }
    t.split('\n').forEach((line, i) => {
      if (/\bLoading\b[^'"`<{]*(…|\.\.\.)/.test(line) && !/\blabel\b/.test(line)) bare.push(`${rel(f)}:${i + 1}`);
    });
  }
  say(cls.length === 0, 'no .spin / .sa-spin / spinner class on any element', cls.join('; '));
  say(glyph.length === 0, 'no lucide loader glyph standing in for a spinner (lib/icons.tsx keeps the static `starting` glyph)', glyph.join('; '));
  say(bare.length === 0, 'no bare "Loading…" text - it is a Loader label or nothing', bare.join('; '));
  const users = tsx.filter((f) => /from '[./]*(components\/)?ui\/Loader'|from '\.\/Loader'|from '\.\/ui\/Loader'/.test(readFileSync(f, 'utf8'))).map(rel);
  say(users.length >= 20, 'the Loader is used across the app (states, settings, cluster, files, control)', `${users.length} files`);
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
