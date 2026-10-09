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
//  10. RESPONSIVE AND STATE (batch 5, 2026-09-23). Every `.tbl` becomes cards at
//      640px and below, and the rule they wear is declared once; the five
//      shared states are written once, so no page hand-rolls an empty, an
//      error, a 404 or a "needs a role"; and "the first poll has not answered"
//      is one function, not six copies of the same two comparisons.
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
      // The primary-tile and primary-card pins: at most one of a group is
      // pressed, and pressing the pressed one clears it.
      'qv-pick', 'ch-pick',
    ],
    'row or card (a whole list item is the target; presses darken, never scale)': [
      'fx-row', 'fx-scm-row', 'fx-scm-grouph', 'fx-json-row', 'fx-sr-file', 'fx-sr-line', 'rd-dir', 'rd-doc',
      'rd-card', 'rd-recent', 'rd-toc-a', 'tm-row', 'fx-menu-item', 'theme-card', 'svc-group-head',
      'cl-topo-node', 'sa-verb', 'topo-list-open',
      // The Settings nav's group heading (2026-10-08), which became the fold's
      // toggle. A full-width row in the sidebar, like .svc-group-head - not a
      // button shape, and ui/Button may not be restyled into a 10px uppercase
      // label.
      'set-nav-gh',
    ],
    'icon trigger (a glyph with an aria-label; hit slop to --hit)': [
      'icon-btn', 'fx-hbtn', 'svc-act-btn', 'fx-filter-x', 'fx-tab-x', 'fx-rowbtn', 'sn-copy', 'set-cmd-copy',
      'logp-refresh', 'rd-root-btn', 'rd-scope-btn', 'rd-scope-go', 'ct-collapse', 'sort-btn', 'fx-dlbtn',
      // ui/InfoHint's trigger (2026-10-07): the 12px glyph that stands where a
      // paragraph used to be. A <Button iconOnly> was the alternative and is
      // wrong here - it is a bordered 24px control, and a page with eight of
      // them reads as eight things to press rather than as eight footnotes.
      'ui-hint',
      // The update activity dock's circle (2026-10-08): a round, shadowed,
      // tone-ringed indicator that is the only thing in the corner of the
      // screen. A <Button iconOnly> is a square bordered control in a row of
      // controls, which is the wrong object entirely - and the orb inside it is
      // a canvas, not a glyph.
      'upd-dock-orb',
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
  // pages/Overview.tsx left this list when its last hand-rolled `.seg-toggle`
  // became a <Tabs> - it now renders no raw <button> at all.
  const STATE_ONLY_FILES = new Set([
    'components/PortsTab.tsx', 'components/RoutesTab.tsx', 'pages/control/Cluster.tsx', 'pages/settings/Audit.tsx',
    'components/Vitals.tsx', 'components/Tabs.tsx', 'pages/control/ClusterTabs.tsx',
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
  const ICON_FILE = join('components', 'ui', 'Icon.tsx');
  const icon = readFileSync(join(SRC, ICON_FILE), 'utf8');
  const js = Object.fromEntries([...(icon.match(/ICON\s*=\s*\{([^}]*)\}/)?.[1] ?? '').matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
  const css = Object.fromEntries(Object.entries(ROOT).filter(([k]) => k.startsWith('--icon-')).map(([k, v]) => [k.slice(7), parseFloat(v)]));
  say(JSON.stringify(js) === JSON.stringify(css) && Object.keys(js).length === 5, 'ICON equals --icon-xs/sm/md/lg/xl', JSON.stringify(css));

  // ── 6b. a CONTAINER and its GLYPH cannot be set apart (batch A, A5) ───────
  // Nothing bound them before, and two defects followed: `.ico.sm` (26px) was
  // handed `size="md"` at four call sites and `size="sm"` at a fifth, so two
  // optical rings appeared on adjacent surfaces; and `.ui-menu-ico` was 14px
  // wide with no height while UserMenu passed 16px glyphs into it, so this
  // app's two menus aligned their rows differently. ICON_BOX and MENU_ICON in
  // ui/Icon.tsx are the binding; these four assertions are what keeps it one.
  const BOX = Object.fromEntries([...(icon.match(/ICON_BOX\s*=\s*\{([\s\S]*?)\n\}/)?.[1] ?? '')
    .matchAll(/(\w+):\s*\{\s*px:\s*(\d+),\s*glyph:\s*'(\w+)'/g)].map((m) => [m[1], { px: Number(m[2]), glyph: m[3] }]));
  say(Object.keys(BOX).length === 3, 'ICON_BOX names the three .ico containers', JSON.stringify(BOX));
  // The CSS squares equal ICON_BOX's px, and each is a square.
  const boxCss = [['md', '.ico'], ['sm', '.ico.sm'], ['lg', '.ico.lg']].map(([k, sel]) => {
    const r = rules(INDEX).find((x) => x.sel === sel && !x.media);
    const d = r ? Object.fromEntries(decls(r.body)) : {};
    return [k, sel, d.width, d.height ?? (k === 'md' ? d.height : undefined)];
  });
  const boxBad = boxCss.filter(([k, , w, h]) => {
    const want = `${BOX[k]?.px}px`;
    return w !== want || (h !== undefined && h !== want);
  }).map(([, sel, w, h]) => `${sel} ${w}/${h}`);
  // `.ico.sm` and `.ico.lg` override only the width in the shorthand they
  // inherit, so a height that is PRESENT must match; `.ico` sets both.
  say(boxBad.length === 0, 'every .ico container is the square ICON_BOX says it is', boxBad.join('; ') || boxCss.map(([k, , w]) => `${k} ${w}`).join(' '));
  // Nobody renders one by hand any more - that is what let the glyph drift.
  const handBox = [];
  for (const f of tsx) {
    if (rel(f) === ICON_FILE) continue;
    const s = stripTs(readFileSync(f, 'utf8'));
    for (const m of s.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
      const txt = (m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, ' ');
      if (/(^|\s)ico(\s|$)/.test(txt)) handBox.push(`${rel(f)}: "${txt.trim()}"`);
    }
  }
  say(handBox.length === 0, 'no hand-written `ico` container outside ui/Icon.tsx (use <IconBox>, which hands the glyph its size)',
    handBox.join('; ') || `${tsx.length} files read`);
  // The menu gutter: both dimensions, equal, and equal to the glyph MENU_ICON
  // names - and every menu item passing exactly that.
  const menuCss = rules(readFileSync(join(SRC, 'components', 'ui', 'Menu.css'), 'utf8')).find((r) => r.sel === '.ui-menu-ico');
  const md = menuCss ? Object.fromEntries(decls(menuCss.body)) : {};
  const menuGlyph = icon.match(/MENU_ICON:\s*IconSize\s*=\s*'(\w+)'/)?.[1];
  say(!!menuGlyph && md.width === `var(--icon-${menuGlyph})` && md.height === md.width,
    'the menu gutter is a square the size of the glyph MENU_ICON names', `${md.width} x ${md.height} vs --icon-${menuGlyph}`);
  const literalMenu = [];
  for (const f of tsx) for (const m of stripTs(readFileSync(f, 'utf8')).matchAll(/icon:\s*<\w+\s[^>]*size=(?:"(\w+)"|\{(\w+)\})/g)) {
    if (m[2] !== 'MENU_ICON') literalMenu.push(`${rel(f)}: size=${m[1] ?? `{${m[2]}}`}`);
  }
  say(literalMenu.length === 0, 'every menu item\'s glyph is MENU_ICON, not a size typed at the call site', literalMenu.join('; '));
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
  const EM_OK = new Set(['.sa-title .mono', ':is(.set-shell, .upd-plan, .upd-dock) .upd-code', '.bothy-files .md .md-img-remote', '.bothy-files .md .md-code']);
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

// ── 10. responsive tables and the shared states (batch 5) ───────────────────
console.log('\n── batch 5: tables become cards, states are written once ─────');
{
  // SYS-17. A `.tbl` that has not opted in is a table that still scrolls
  // sideways at 390 with its last columns off-screen, which is the finding.
  // `.md-tbl` is not a `.tbl`: its columns are somebody's markdown and the
  // renderer has no headers to label cards with.
  const tables = [];
  for (const f of tsx) {
    const src = stripTs(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/<table\b[^>]*className=(?:"([^"]*)"|\{`([^`]*)`\})/gs)) {
      const cls = (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, ' ');
      if (!/(^|\s)tbl(\s|$)/.test(cls)) continue;
      tables.push({ at: `${rel(f)}:${src.slice(0, m.index).split('\n').length}`, cards: /\bas-cards\b/.test(cls) });
    }
  }
  say(tables.length >= 20, 'the tables are found', `${tables.length} .tbl tables`);
  const notCards = tables.filter((t) => !t.cards).map((t) => t.at);
  say(notCards.length === 0, 'every .tbl also carries as-cards (SYS-17)', notCards.join(', '));

  // The rule itself, once, in index.css - and the media query it lives in.
  const cardsRule = /@media \(max-width: 640px\)[\s\S]*?\.tbl\.as-cards thead \{[^}]*display:\s*none/.test(INDEX);
  say(cardsRule, '.tbl.as-cards is declared in index.css, at 640px and below');
  say(/\.tbl\.as-cards td\[data-label\]::before\s*\{[^}]*content:\s*attr\(data-label\)/.test(INDEX),
    'a card cell names its column from data-label');
  // The trap this rule was written around: a min-width that makes a TABLE
  // scroll inside its wrapper makes a BLOCK push the page that wide.
  say(/\.tbl\.as-cards \{[^}]*min-width:\s*0/.test(INDEX),
    'the cards rule resets min-width, so a block cannot widen the page');

  // SYS-18. The five states live in components/states.tsx. A page that writes
  // `.state` markup by hand is a page whose 404 has no heading, whose error has
  // no way out, or whose "loading" is spelled "not found".
  const STATES = join('components', 'states.tsx');
  const hand = [];
  for (const f of tsx) {
    if (rel(f) === STATES) continue;
    const src = stripTs(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/className="(state|state err|sa-norole)"/g)) {
      hand.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  say(hand.length === 0, 'no hand-rolled .state / .sa-norole markup outside components/states.tsx', hand.join(', '));

  const states = readFileSync(join(SRC, STATES), 'utf8');
  for (const fn of ['EmptyState', 'ErrState', 'NotFound', 'NeedsRole', 'Skeleton', 'firstPoll']) {
    say(new RegExp(`export function ${fn}\\b`).test(states), `components/states.tsx exports ${fn}`);
  }
  say(/<h1>/.test(states.slice(states.indexOf('export function NotFound'))),
    'NotFound draws an h1 (the 404 had no heading at all)');
  say(/useDocTitle\(/.test(states.slice(states.indexOf('export function NotFound'))),
    'NotFound sets the document title');

  // The first-poll test, in one place. Two pages got it wrong in the same
  // direction: a real service page said "not found" for the 3-4s a cold load
  // takes.
  const firstPollHand = [];
  for (const f of tsx) {
    if (rel(f) === STATES) continue;
    const src = stripTs(readFileSync(f, 'utf8'));
    if (/\.at === 0 && [a-z]*\.?fails === 0/.test(src)) firstPollHand.push(rel(f));
  }
  say(firstPollHand.length === 0, 'no hand-written `at === 0 && fails === 0` (use firstPoll)', firstPollHand.join(', '));
}

// ── 11. batch A: the footprint rule, applied to the dashboards ──────────────
console.log('\n── batch A: a one-ratio bar is capped, dashboard cards keep the tile ─');
{
  const ovCss = rules(readFileSync(join(SRC, 'pages', 'Overview.css'), 'utf8'));
  const one = (rs, want) => rs.find((r) => r.sel.replace(/\s+/g, ' ') === want && !r.media);

  // A1. The counts were always `auto`; the BAR held the `1fr`, so in a 1320px
  // column it drew ~1100px of 8px ribbon for a single ratio. Reverting the cap
  // is one token, and nothing on the page would look broken - which is exactly
  // the kind of regression this file exists for.
  const head = one(ovCss, '.ov-status-head');
  const cols = head ? (decls(head.body).find(([p]) => p === 'grid-template-columns')?.[1] ?? '') : '';
  const just = head ? (decls(head.body).find(([p]) => p === 'justify-content')?.[1] ?? '') : '';
  say(!!head && /minmax\([^)]*rem\s*\)/.test(cols) && !/\b1fr\b/.test(cols),
    'the status strip\'s bar is capped, never 1fr (principles.md §3: one ratio is not a page-wide row)', cols);
  // Without this the `auto` counts column stretches - a grid stretches auto
  // tracks and only auto tracks - and the capped bar lands on the right edge.
  say(just === 'start', 'and the strip is start-justified, so the cap is not undone by the auto track stretching', just);

  // A3. `.seg-toggle` is the hand-rolled selector components/Tabs.tsx was
  // written to replace: `role="group"` plus `aria-pressed`, so a screen reader
  // hears N unrelated toggles rather than "tab 1 of 2" and the arrow keys do
  // nothing. Two survive, and each is a DIFFERENT CONTROL rather than one
  // nobody got round to - which is exactly why the registry names the reason:
  //   settings/Audit.tsx - a filter among filters, inside role="search". A
  //     tablist there would claim the table below is N panels while three other
  //     controls narrow that one table.
  //   files/Editor.tsx - an icon-only pair in a dense toolbar, each button
  //     wrapped in a Tooltip that owns its accessible name. TabSpec has no
  //     per-tab label or tooltip slot, and growing the shared primitive to fit
  //     one toolbar is the wrong direction of travel.
  // A4. The tile unit is ONE constant in :root and both dashboards read it.
  // Two copies of one number is how the two content widths came to disagree
  // (space-and-layout.md's own known gap), and the failure is invisible: the
  // grids simply stop lining up with each other.
  const chCss = rules(readFileSync(join(SRC, 'pages', 'control', 'controlHome.css'), 'utf8'));
  const grid = one(chCss, '.ch-grid');
  const gridD = grid ? Object.fromEntries(decls(grid.body)) : {};
  say('--tile' in ROOT && !/--tile\s*:/.test(stripCss(readFileSync(join(SRC, 'pages', 'Overview.css'), 'utf8'))),
    'the tile unit is declared once, in :root (space-and-layout.md: "declare ONE tile height")', ROOT['--tile']);
  say(gridD['grid-auto-rows'] === 'var(--tile)' && gridD['align-items'] === 'stretch',
    'the Control landing is on the tile unit, not `align-items: start` with content-sized cards',
    `${gridD['grid-auto-rows']} / ${gridD['align-items']}`);
  const chBody = one(chCss, '.ch-card-body');
  const bodyD = chBody ? Object.fromEntries(decls(chBody.body)) : {};
  say(bodyD['overflow-y'] === 'auto' && bodyD['min-height'] === '0',
    'and its card body is the scroller, so a long card scrolls instead of growing the row');
  // The trap the Overview's own comment records: a max-height inside a tile
  // fights the tile and brings the ragged bottoms back.
  const capped = chCss.filter((r) => /max-height/.test(r.body) && !/ch-tile|ch-spark/.test(r.sel)).map((r) => r.sel.replace(/\s+/g, ' '));
  say(capped.length === 0, 'no max-height left inside a tile (it would fight the tile - see .ov-panel-body)', capped.join('; '));
  // The structural-footer corollary, held from the "none does" side: these cards
  // state their size in the header `meta`, so a footer would restate it.
  say(!/ch-card-foot/.test(stripCss(readFileSync(join(SRC, 'pages', 'control', 'controlHome.css'), 'utf8'))),
    'no Control card has a footer - either every card in a row has one or none does, and none does');
  // The grid's spans are keyed on `nth-child`, so the JSX order IS the layout.
  // Reorder the cards and the spans land on the wrong ones silently: nothing
  // throws, the page just stops being two full rows. checks/control-home.mjs
  // holds which cards a role is shown; this holds the order they are drawn in.
  const chTs = stripTs(readFileSync(join(SRC, 'pages', 'control', 'ControlHome.tsx'), 'utf8'));
  const inGrid = chTs.slice(chTs.indexOf('<div className="ch-grid">'), chTs.indexOf('</div>', chTs.indexOf('<div className="ch-grid">')));
  const order = [...inGrid.matchAll(/<([A-Z]\w+)/g)].map((m) => m[1]);
  say(JSON.stringify(order) === JSON.stringify(['AttentionList', 'QuickLinks', 'ClusterCard', 'EdgeCard', 'ActivityCard']),
    'the Control grid draws its cards in the order its nth-child spans assume', order.join(' '));

  const SEG_OK = [join('pages', 'settings', 'Audit.tsx'), join('pages', 'files', 'Editor.tsx')];
  const segs = tsx.filter((f) => /className="[^"]*\bseg-toggle\b/.test(stripTs(readFileSync(f, 'utf8')))).map(rel);
  say(segs.length === SEG_OK.length && segs.every((f) => SEG_OK.includes(f)),
    'the only hand-rolled `.seg-toggle` left are the two registered exceptions (a new one, or a stale entry, fails)',
    segs.join(', ') || '(none)');
}

// ── 12. D2/D3: the hint, and the slot that does not move ────────────────────
//
// Both of these fail INVISIBLY, which is the only reason they are here rather
// than left to a screenshot.
//
//   · A hint that is added BESIDE the prose it was meant to replace looks
//     perfectly fine and is the exact opposite of the request ("theres a lot of
//     words and too much data"). The page gets busier one hint at a time, and no
//     single diff is obviously wrong. So: the paragraphs that moved stay moved.
//   · A reserved slot whose child is in NORMAL FLOW looks identical while nothing
//     is running, and gives the jump straight back the first time a job starts -
//     which is a bug you only see while watching the thing you shipped the fix
//     for. The absolute positioning IS the fix, so it is what is asserted.
console.log('\n── the detail hint, and the activity slot that cannot move ──');
{
  const HINT = join('components', 'ui', 'InfoHint.tsx');
  const hintTs = stripTs(readFileSync(join(SRC, HINT), 'utf8'));
  const hintCss = stripCss(readFileSync(join(SRC, 'components', 'ui', 'InfoHint.css'), 'utf8'));
  const upd = stripTs(readFileSync(join(SRC, 'pages', 'settings', 'Updates.tsx'), 'utf8'));
  const setCss = rules(readFileSync(join(SRC, 'components', 'settings', 'settings.css'), 'utf8'));
  const one = (want, media = '') => setCss.find((r) => r.sel.replace(/\s+/g, ' ') === want && r.media.trim() === media);

  // It is BUILT ON the one floating primitive rather than beside it (SYS-5).
  say(/from '\.\/Popover'/.test(hintTs), 'ui/InfoHint is built on ui/Popover, not on a tenth hand-rolled surface');
  // The three halves of "hover alone is not an affordance". A tap must reach the
  // click handler, which is why pointerenter is honoured for a mouse only: on a
  // touch screen pointerenter and click arrive in the same gesture, and the
  // component this replaces (components/Tooltip.tsx) closes on pointerdown - so
  // its tip opens and shuts in one tap.
  say(/onFocus=\{show\}/.test(hintTs), 'the hint opens on FOCUS, so a keyboard reaches it');
  const gated = (hintTs.match(/onPointer(?:Enter|Leave)=\{\(e\)\s*=>\s*\{\s*if\s*\(e\.pointerType === 'mouse'\)/g) ?? []).length;
  say(gated === 2,
    'and hover is honoured for a mouse only ON BOTH pointer handlers, so a TAP reaches the toggle instead of being eaten by it',
    `${gated} of 2 gated`);
  say(/aria-label=\{label\}/.test(hintTs) && /label\?: never/.test(hintTs) === false && /label: string;/.test(hintTs),
    'the trigger carries a required accessible name (a bare glyph is "button" to a screen reader)');
  say(/aria-describedby=\{open \? id : undefined\}/.test(hintTs),
    'the open panel is the trigger\'s DESCRIPTION, which is what lets focus stay put');
  say(/focusOnOpen=\{false\}/.test(hintTs) && /returnFocus=\{false\}/.test(hintTs),
    'focus never moves into the panel, and nothing is handed back on close');
  // The corollary of focus never moving: anything focusable in there is
  // unreachable. Caught as text because that is where it would be written.
  const ctrl = [...upd.matchAll(/<InfoHint\b[\s\S]{0,2200}?<\/InfoHint>/g)]
    .filter((m) => /<(button|a|input|select|textarea|Button|Link|Cmd)\b/.test(m[0]))
    .map((m) => m[0].slice(0, 60).replace(/\s+/g, ' '));
  say(ctrl.length === 0, 'no hint holds a control - focus never enters one, so a link in there is unreachable',
    ctrl.join('; '));
  say(/inset: min\(0px, calc\(\(100% - var\(--hit\)\)/.test(hintCss),
    'the 12px glyph still reaches --hit through the shared hit-slop arithmetic');

  // D2's actual measure: the paragraphs that moved are GONE from the surface.
  // Each of these is a sentence that was printed for every reader on every visit.
  const MOVED = [
    ['the group footer note', 'A recipe is one'],
    ['the table glossary', 'is what is newer <i>upstream</i>'],
    ['the Apply/Update paragraph', 'a Dependabot PR, reviewed and merged'],
    ['the night-window gate list', 'succeeded and the component itself was'],
  ];
  const still = MOVED.filter(([, needle]) => {
    const at = upd.indexOf(needle);
    if (at < 0) return false;                       // deleted outright: also fine
    // Inside a hint is where it belongs; outside one is the defect.
    const open = upd.lastIndexOf('<InfoHint', at);
    const close = upd.lastIndexOf('</InfoHint>', at);
    return !(open > close);
  }).map(([what]) => what);
  say(still.length === 0, 'the prose that moved behind a hint is not also still on the surface (D2)',
    still.join(', '));
  const hints = (upd.match(/<InfoHint\b/g) ?? []).length;
  say(hints >= 8, 'Settings > Updates reaches for the hint rather than one more paragraph', `${hints} hints`);

  // -- D3, rewritten 2026-10-08: THE RAIL IS A COLUMN OF THE PAGE -------------
  //
  // What the old assertions pinned was the shape the owner then rejected: they
  // required `.upd-top` to be a two-column grid, and the message said "the owner
  // asked for the right side" while the grid's left cell was the CONTROLS BLOCK.
  // It was the right side of a row, not the side of the page. So the invariant is
  // restated rather than deleted - and the part that was hard-won is restated
  // unchanged, because it is the part that fails invisibly:
  //
  //   - The slot is drawn whether or not a job exists, so it cannot appear.
  //   - Its WIDTH is reserved by the body, independently of the rail's content.
  //   - The card inside it is ABSOLUTELY POSITIONED, so it contributes no height
  //     and cannot move a block however many steps it grows. A reserved
  //     min-height would not do: the panel grows, and a reserved box that is
  //     sometimes too small is a delayed jump.
  //   - Below 1340px the band keeps a FIXED height instead, which is the same
  //     promise on the device the owner actually reads this on.
  //
  // And the new ones, all of which also fail silently:
  //
  //   - The rail is positioned against the SCROLLER, not against the body. That
  //     is what makes it the side of the page (the full pane height, and it does
  //     not scroll away while you read) rather than the side of a block.
  //   - The dock exists at all, is FIXED on the named layer, and is mounted in
  //     AppShell. Mounted inside a page instead it would be duplicated and then
  //     unmounted on every navigation (RouteFade keeps two <main>s alive), which
  //     looks fine on the page you started the job from and nowhere else.
  const actTs = stripTs(readFileSync(join(SRC, 'components', 'UpdateActivity.tsx'), 'utf8'));
  const actCss = rules(readFileSync(join(SRC, 'components', 'UpdateActivity.css'), 'utf8'));
  const actOne = (want, media = '') => actCss.find((r) => r.sel.replace(/\s+/g, ' ') === want && r.media.trim() === media);
  const shell = stripTs(readFileSync(join(SRC, 'components', 'AppShell.tsx'), 'utf8'));

  say(/<UpdateActivityRail d=\{data\} onFinished=\{reload\} \/>/.test(upd),
    'Settings > Updates draws the activity rail as a child of the PAGE, not of a row inside it');
  say(!/upd-top/.test(upd) && !actCss.some((r) => /upd-top/.test(r.sel)),
    'and the two-column row it used to be a cell of (.upd-top) is gone, not merely restyled');
  say(/<RestingJob last=/.test(actTs),
    'the slot is drawn whether or not a job exists, and carries the last job at rest');

  const reserve = setCss.find((r) => r.sel.replace(/\s+/g, ' ') === '.set-shell .set-body:has(> .upd-rail)' && !r.media.trim());
  const resD = reserve ? Object.fromEntries(decls(reserve.body)) : {};
  say(/^calc\(var\(--upd-rail-w\) \+ var\(--sp-\w+\)\)$/.test(resD['padding-right'] ?? ''),
    "the page RESERVES the rail's width itself, so no block can ever be under it", resD['padding-right']);
  const pane = setCss.find((r) => r.sel.replace(/\s+/g, ' ') === '.set-shell .set-main:has(.upd-rail)');
  say(!!pane && /position:\s*relative/.test(pane.body),
    'the rail is positioned against the SCROLLER - the full height of the page, and it does not scroll away',
    pane ? pane.body.replace(/\s+/g, ' ').trim() : '(no rule)');
  const rail = actOne('.set-shell .upd-rail');
  const railD = rail ? Object.fromEntries(decls(rail.body)) : {};
  say(railD.position === 'absolute' && railD.inset === '0 0 0 auto' && railD.width === 'var(--upd-rail-w)',
    "it is a full-height column at the page's right edge", `${railD.position ?? '(none)'} / ${railD.inset ?? '(none)'}`);
  const railIn = actOne('.set-shell .upd-rail-in');
  const inD = railIn ? Object.fromEntries(decls(railIn.body)) : {};
  say(inD.position === 'absolute' && /^var\(--sp-/.test(inD.inset ?? ''),
    'the card inside it is absolutely positioned - the no-shift guarantee is structural, not a reserved min-height',
    `${inD.position ?? '(none)'} / ${inD.inset ?? '(none)'}`);
  say(inD['overflow-y'] === 'auto', 'so a panel taller than the slot scrolls inside it rather than growing the page');
  const narrow = actCss.find((r) => /max-width:\s*1340px/.test(r.media) && r.sel.replace(/\s+/g, ' ') === '.set-shell .upd-rail');
  say(!!narrow && /height:\s*var\(--upd-rail-h\)/.test(narrow.body) && /position:\s*relative/.test(narrow.body),
    'below 1340px there is no right, so the band takes a FIXED height instead - reserved, and still shift-free',
    narrow ? narrow.body.replace(/\s+/g, ' ').trim() : '(no narrow rule)');
  const narrowBody = setCss.find((r) => /max-width:\s*1340px/.test(r.media)
    && r.sel.replace(/\s+/g, ' ') === '.set-shell .set-body:has(> .upd-rail)');
  say(!!narrowBody && /padding-right:\s*var\(--sp-\w+\)/.test(narrowBody.body),
    'and the RESERVE goes with it - a 21rem gutter kept for a rail that is not there leaves 6px of content at 390px',
    narrowBody ? narrowBody.body.replace(/\s+/g, ' ').trim() : '(no narrow rule)');

  // The dock. "in all the other places itll be flowting in the side as circle or
  // something in some corner or something and in hover itll get opened."
  say(/<UpdateActivityDock \/>/.test(shell),
    'the dock is mounted in the SHELL, the one mount point that survives a route change');
  const dockUsers = tsx.filter((f) => /<UpdateActivityDock\b/.test(stripTs(readFileSync(f, 'utf8')))).map(rel);
  say(dockUsers.length === 1 && dockUsers[0] === join('components', 'AppShell.tsx'),
    'and nowhere else - inside a page it would be duplicated and unmounted on every navigation', dockUsers.join(', '));
  say(/if \(!feed\.id\) return null;/.test(actTs),
    'there is no dock at all when no job is being followed (an idle orb is a perpetual loop for an idle thing)');
  say(/if \(loc\.pathname\.startsWith\('\/settings\/updates'\)\) return null;/.test(actTs),
    'and none on Settings > Updates, where the rail IS it - two would be two live regions saying one thing');
  const dock = actOne('.upd-dock');
  const dockD = dock ? Object.fromEntries(decls(dock.body)) : {};
  say(dockD.position === 'fixed' && dockD['z-index'] === 'var(--z-activity)',
    "it is fixed on the NAMED layer, so it moves no content and sits above the page's own chrome",
    `${dockD.position ?? '(none)'} / ${dockD['z-index'] ?? '(none)'}`);
  say(/env\(safe-area-inset-bottom/.test(dockD.bottom ?? '') && /env\(safe-area-inset-right/.test(dockD.right ?? ''),
    "and it applies the safe-area insets - a round target in a phone's bottom corner is exactly where that gap bites");
  const orb = actOne('.upd-dock-orb');
  const orbD = orb ? Object.fromEntries(decls(orb.body)) : {};
  say(orbD['border-radius'] === 'var(--r-full)' && !!orbD.width && orbD.width === orbD.height,
    'the collapsed form is a circle, which is what was asked for', `${orbD.width ?? '?'} / ${orbD['border-radius'] ?? '?'}`);

  // THE THREE HALVES OF "hover alone is not an affordance", the same shape
  // ui/InfoHint is held to above - and for the same reason: a touch tap must
  // reach the toggle instead of being eaten by a hover that opens and shuts in
  // one gesture, which is the defect that disqualified components/Tooltip.tsx.
  say(/onFocus=\{\(e\) => \{ if \(e\.currentTarget\.matches\(':focus-visible'\)\) setOpen\(true\); \}\}/.test(actTs),
    "the dock opens on KEYBOARD focus, so it is reachable with no pointer at all - and a pointer's focus does not, or a tap would open and shut in one gesture");
  say(/onClick=\{\(\) => setOpen\(\(o\) => !o\)\}/.test(actTs), 'and on a TAP, through a click handler on the toggle itself');
  const dockGated = (actTs.match(/onPointer(?:Enter|Leave)=\{\(e\)[\s\S]{0,340}?e\.pointerType [!=]== 'mouse'/g) ?? []).length;
  say(dockGated === 2, 'and hover is honoured for a mouse only ON BOTH pointer handlers', `${dockGated} of 2 gated`);
  say(/aria-expanded=\{open\}/.test(actTs) && /aria-controls=\{panelId\}/.test(actTs) && /aria-label="Update activity"/.test(actTs),
    'the trigger is a real named DISCLOSURE toggle - the panel holds controls, so it is not a hint and not a tooltip');
  say(/e\.key !== 'Escape'/.test(actTs) && /orb\.current\?\.focus\(\);/.test(actTs),
    'Escape closes it and hands focus back to the trigger');
  say(/inert=\{!open\}/.test(actTs),
    'the panel is always in the DOM so aria-controls resolves, and inert while shut so nothing in it is reachable by Tab');

  // IT EXPANDS BY TRANSFORM, NOT BY SIZE. motion.md forbids animating width or
  // height; index.css records the nav label that tweened max-width and reflowed
  // the whole bar every frame, pushing its neighbour ~60px sideways under the
  // pointer. An absolutely positioned panel cannot do that to anything.
  const panel = actOne('.upd-dock-panel');
  const panD = panel ? Object.fromEntries(decls(panel.body)) : {};
  say(panD.position === 'absolute', 'the panel is positioned OFF the dock, so opening it moves nothing - not the page, not the orb');
  const tProps = (panD.transition ?? '').split(/,(?![^(]*\))/).map((t) => t.trim().split(/\s+/)[0]).filter(Boolean);
  say(tProps.length > 0 && tProps.every((x) => ['opacity', 'scale', 'translate', 'visibility'].includes(x)),
    'and it arrives on transform and opacity only - never on a size', tProps.join(' '));
  const bridge = actOne('.upd-dock-panel::after');
  const brD = bridge ? Object.fromEntries(decls(bridge.body)) : {};
  say(brD.top === '100%' && brD.height === panD['margin-bottom'],
    'the gap between the circle and the panel is bridged, so a mouse can reach what hovering opened',
    `${brD.height ?? '(no bridge)'} vs a gap of ${panD['margin-bottom']}`);
  const shut = actOne(".upd-dock-panel[data-open='false']");
  say(!!shut && /opacity:\s*0/.test(shut.body) && panD.opacity === undefined,
    'the SHUT state is the exception, so a resting panel is visible - a default of opacity 0 is how a surface stays invisible forever');

  // The loop's cost. Every read of the job route writes an audit line on the
  // host, which is why the sidebar's behind count is TTL'd to a quarter hour.
  const updLib = stripTs(readFileSync(join(SRC, 'lib', 'updates.ts'), 'utf8'));
  say(/export function followJob/.test(updLib) && /setTimeout\(\(\) => void tick\(\), JOB_POLL_MS\)/.test(updLib),
    'the 2s loop is ONE module store, not a hook per mount - two surfaces, one request');
  say(/again = !isTerminal\(j\.state\);/.test(updLib),
    'and it stops the moment the host says the job is over (an audit line per read is the reason)');
  // WHO MAY START ONE, AND WHO MAY ONLY PICK ONE UP. Settings > Updates is the
  // only thing that may BEGIN following a job (it asked for it, or the status it
  // already read says one is running). The shell may RESUME one that outlived a
  // reload, which is a different and strictly bounded thing: one request, and
  // none at all when no id was stored. The bound is the assertion that matters -
  // every read of the job route is an audit line on the host.
  const begins = tsx.filter((f) => /\b(followJob|adoptJob)\(/.test(stripTs(readFileSync(f, 'utf8'))))
    .map(rel).filter((r) => r !== join('components', 'UpdateActivity.tsx'));
  say(begins.length === 1 && begins[0] === join('pages', 'settings', 'Updates.tsx'),
    'nothing but Settings > Updates may BEGIN following a job', begins.join(', '));
  const resumes = tsx.filter((f) => /\bresumeJob\(\)/.test(stripTs(readFileSync(f, 'utf8')))).map(rel);
  say(resumes.length === 1 && resumes[0] === join('components', 'UpdateActivity.tsx'),
    'and only the shell may RESUME one, from the dock that survives a route change', resumes.join(', '));
  const resume = updLib.slice(updLib.indexOf('export async function resumeJob'));
  const guard = resume.indexOf('if (!id) return;');
  say(guard > 0 && guard < resume.indexOf('fetchJob('),
    'the resume asks for NOTHING when no job id was stored - the bound that keeps an idle tab free');
  say(/followJob\(id, j\);/.test(resume) && /export function followJob\(id: string, seed\?: Job\)/.test(updLib),
    'and it hands the job it already read to the loop, so a resume is ONE request and not two');
  say(/if \(feed\.id \|\| isTerminal\(j\.state\)\) return;/.test(resume),
    'a job that ended while the tab was away is not raised in a corner, and nothing starts a loop for it');
}

console.log(`\n  ${passes} pass · ${failures} fail`);
process.exit(failures ? 1 : 0);
