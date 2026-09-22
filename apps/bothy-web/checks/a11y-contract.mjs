// The accessibility blockers the 2026-09-19 design audit found, turned into
// assertions so they cannot come back (docs/plans/design-audit-apple.md, batch 1).
//
// Four families, all read straight from the source tree:
//
//   1. STATUS TEXT. A status has two halves - the fill (`--st-up`) for areas and
//      marks, and the text half (`--st-up-fg`) measured for words. The audit's
//      P0 was 52 "public" tags on Routes painted in the FILL: 2.43:1 in light.
//      So: (a) no `color:` anywhere in src/ may name a bare --st-* fill, and
//      (b) every -fg clears 4.5:1 on every ground status text is painted on -
//      the page, the cards, the raised surfaces dialogs and menus sit on, AND its
//      own tinted pill background - in both shipped themes. The ratios are
//      computed from the CSS tokens, not copied from a comment.
//   2. ONE MODAL. Only components/ui/Dialog.tsx may import @radix-ui/react-dialog
//      or write `aria-modal`, and only components/ui/Menu.tsx may import the
//      dropdown menu. Every hand-rolled modal in this app had lost focus to
//      <body> on close; the primitive is where that is solved, so a dialog
//      outside it is a dialog without the fix. `role="dialog"` elsewhere is
//      allowed only for the NON-modal popovers listed below, each with a reason.
//   3. SORTABLE HEADERS. No `<th onClick>`: a click handler on a header cell is
//      a control a keyboard cannot reach. components/SortHeader.tsx puts a
//      <button> inside the <th>.
//   4. THE FOCUS RING never sets a radius. `*:focus-visible { border-radius }`
//      reshaped 19 of 30 controls on Services the moment they were focused.
//   5. EVERY FLOATING SURFACE THROUGH A PRIMITIVE (batch 3, SYS-5). Nine
//      hand-rolled popovers had nine behaviours; they are on ui/Menu and
//      ui/Popover now, and this keeps a tenth from being written: no Radix
//      popper-family import outside components/ui/, no intrinsic element
//      carrying a popup role (menu, menuitem*, listbox, tooltip) outside ui/
//      except the palette's inline list, no document-level outside-press
//      listener (the hand-rolled popover's tell), no dropdown positioned by
//      hand under its trigger, and no literal z-index in the floating range.
//
// Run through checks/run.sh (it needs the compiled lib/contract.ts beside it).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseColour, over, contrast, STATUSES, AA } from './contract.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = process.argv[2] ?? join(HERE, '..', 'web', 'src');

let passes = 0, failures = 0;
const say = (ok, label, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const files = walk(SRC);
const rel = (p) => relative(SRC, p);
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
// Line comments and block comments out of TS/TSX, so prose ABOUT a pattern -
// "this used to be a role=dialog div" - is not mistaken for the pattern.
const stripTs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

// ── 1a. no status FILL used as text ─────────────────────────────────────────
console.log('── status text uses the -fg half, never the fill ─────────');
{
  const FILL = /--st-(?:up|warn|down|unknown|off)(?![-\w])/;
  const hits = [];
  for (const f of files.filter((p) => p.endsWith('.css'))) {
    const css = stripCss(readFileSync(f, 'utf8'));
    for (const m of css.matchAll(/(?:^|[;{\s])(color)\s*:\s*([^;}]+)/g)) {
      if (FILL.test(m[2])) {
        const line = css.slice(0, m.index).split('\n').length;
        hits.push(`${rel(f)}:${line}  color: ${m[2].trim()}`);
      }
    }
  }
  for (const f of files.filter((p) => /\.tsx?$/.test(p))) {
    const ts = stripTs(readFileSync(f, 'utf8'));
    for (const m of ts.matchAll(/\bcolor\s*:\s*['"`]([^'"`]+)['"`]/g)) {
      if (FILL.test(m[1])) hits.push(`${rel(f)}  color: '${m[1]}'`);
    }
  }
  say(hits.length === 0, 'no `color:` names a bare --st-* fill token', hits.length ? `\n    ${hits.join('\n    ')}` : `(${files.length} files read)`);
}

// ── 1b. status -fg contrast, computed from the tokens ───────────────────────
/** { selector -> tokens } with a brace counter, at-rules recursed into. The same
 *  approach as theme-contract.mjs, for the same reason: a flat regex loses step
 *  at the first nested block. */
function blocks(css) {
  const src = stripCss(css);
  const out = [];
  const scan = (text, prefix) => {
    let i = 0, start = 0;
    while (i < text.length) {
      if (text[i] === '{') {
        const prelude = text.slice(start, i).trim();
        let depth = 1, j = i + 1;
        while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
        const body = text.slice(i + 1, j - 1);
        if (prelude.startsWith('@')) scan(body, `${prefix}${prelude} `);
        else {
          const toks = {};
          for (const t of body.replace(/\{[^{}]*\}/g, '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) toks[t[1]] = t[2].trim();
          if (Object.keys(toks).length) out.push({ sel: prefix + prelude, toks });
        }
        i = j; start = j; continue;
      }
      if (text[i] === '}') { i++; start = i; continue; }
      i++;
    }
  };
  scan(src, '');
  return out;
}

console.log('\n── status text contrast, both themes, every ground ──────');
{
  const idx = blocks(readFileSync(join(SRC, 'index.css'), 'utf8'));
  const merge = (pred) => Object.assign({}, ...idx.filter((b) => pred(b.sel)).map((b) => b.toks));
  const BASE = merge((s) => s === ':root');
  const LIGHT = { ...BASE, ...merge((s) => /^:root\[data-theme=['"]?light/.test(s)) };

  // A tint is `color-mix(in oklab, var(--st-x) N%, transparent)`: mixing with
  // transparent keeps the colour and scales the alpha, so it is the fill at N%.
  const tintOf = (toks, s) => {
    const m = (toks[`--st-${s}-bg`] ?? '').match(/var\((--st-[a-z]+)\)\s+([\d.]+)%\s*,\s*transparent/);
    if (!m) return null;
    const c = parseColour(toks[m[1]]);
    return c ? { ...c, a: Number(m[2]) / 100 } : null;
  };
  // Where status words are actually painted: the page, the sidebars, cards,
  // table headers and tags (surface-2), hovered rows (surface-3) and the
  // dialogs and menus (surface-4).
  const GROUNDS = ['--bg', '--bg-2', '--surface-1', '--surface-2', '--surface-3', '--surface-4'];

  // The tinted pill is measured only for statuses whose tint really is painted
  // behind text somewhere - read from the stylesheets, so a new pairing is
  // measured the day it is written. (--st-off-bg is never a text ground, and a
  // rule about a pairing nobody draws is a rule nobody can satisfy honestly.)
  const tintedText = new Set();
  for (const f of files.filter((p) => p.endsWith('.css'))) {
    for (const m of stripCss(readFileSync(f, 'utf8')).matchAll(/background\s*:\s*var\(--st-([a-z]+)-bg\)/g)) tintedText.add(m[1]);
  }

  for (const [name, toks] of [['Bothy Dark', BASE], ['Bothy Light', LIGHT]]) {
    const ground = (k) => { const c = parseColour(toks[k] ?? ''); return c && c.a < 1 ? over(c, parseColour(toks['--bg'])) : c; };
    for (const s of STATUSES) {
      const fg = parseColour(toks[`--st-${s}-fg`] ?? '');
      if (!fg) { say(false, `${name} --st-${s}-fg parses`, toks[`--st-${s}-fg`] ?? '(missing)'); continue; }
      const tint = tintedText.has(s) ? tintOf(toks, s) : null;
      let worst = { v: Infinity, on: '' };
      for (const g of GROUNDS) {
        const bg = ground(g);
        if (!bg) continue;
        const plain = contrast(fg, bg);
        if (plain < worst.v) worst = { v: plain, on: g };
        if (tint) {
          const pill = over(tint, bg);
          const v = contrast(fg, pill);
          if (v < worst.v) worst = { v, on: `--st-${s}-bg over ${g}` };
        }
      }
      say(worst.v >= AA, `${name}: --st-${s}-fg >= ${AA}:1 as text`, `worst ${worst.v.toFixed(2)} on ${worst.on}`);
    }
    // And the fill really is not text-safe in light - the reason 1a exists.
    if (name === 'Bothy Light') {
      const v = contrast(parseColour(toks['--st-up']), ground('--surface-2'));
      say(v < AA, `${name}: --st-up (the fill) is below ${AA}:1 on surface-2, which is why text must not use it`, v.toFixed(2));
    }
  }
}

// ── 2. one modal primitive ──────────────────────────────────────────────────
console.log('\n── every modal goes through components/ui/Dialog ──────────');
{
  const DIALOG = join('components', 'ui', 'Dialog.tsx');
  const MENU = join('components', 'ui', 'Menu.tsx');
  // Non-modal popovers that carry role="dialog" on an element of their own.
  // Empty since batch 3: the last one (the Files scope picker) is a ui/Popover
  // now, and a new non-modal popover should be one too.
  const NON_MODAL = new Map([]);
  const tsx = files.filter((p) => /\.tsx?$/.test(p));
  const offenders = { radix: [], modal: [], role: [], menu: [] };
  for (const f of tsx) {
    const r = rel(f);
    const src = stripTs(readFileSync(f, 'utf8'));
    if (r !== DIALOG && /@radix-ui\/react-dialog/.test(src)) offenders.radix.push(r);
    if (r !== DIALOG && /aria-modal/.test(src)) offenders.modal.push(r);
    if (r !== DIALOG && /role=["{']+dialog/.test(src) && !NON_MODAL.has(r)) offenders.role.push(r);
    if (r !== MENU && /@radix-ui\/react-dropdown-menu/.test(src)) offenders.menu.push(r);
  }
  say(offenders.radix.length === 0, 'only ui/Dialog.tsx imports @radix-ui/react-dialog', offenders.radix.join(', '));
  say(offenders.modal.length === 0, 'nothing outside ui/Dialog.tsx writes aria-modal', offenders.modal.join(', '));
  say(offenders.role.length === 0, 'no role="dialog" outside ui/Dialog.tsx (non-modal popovers are ui/Popover)',
    offenders.role.join(', '));
  say(offenders.menu.length === 0, 'only ui/Menu.tsx imports @radix-ui/react-dropdown-menu', offenders.menu.join(', '));

  // The primitive itself still does the thing it exists for.
  const d = readFileSync(join(SRC, DIALOG), 'utf8');
  say(/onCloseAutoFocus=\{onCloseAutoFocus\}/.test(d) && (d.match(/onCloseAutoFocus=\{onCloseAutoFocus\}/g) ?? []).length >= 2,
    'both Dialog shapes route close-focus through useFocusReturn');
}

// ── 5. every floating surface through ui/Menu or ui/Popover ─────────────────
console.log('\n── every popover and menu goes through ui/Menu or ui/Popover ─');
{
  const UI = join('components', 'ui');
  const inUi = (r) => r.startsWith(UI + '/') || r.startsWith(UI + '\\');
  const tsx = files.filter((p) => /\.tsx?$/.test(p));
  const radix = [], roles = [], outside = [];
  // The palette's result list is a listbox INSIDE the modal palette (a
  // combobox's own list, not a popup), so it is the one intrinsic popup role
  // allowed outside the primitives.
  const ROLE_OK = new Set([join('components', 'CommandPalette.tsx')]);
  for (const f of tsx) {
    const r = rel(f);
    const src = stripTs(readFileSync(f, 'utf8'));
    if (!inUi(r) && /@radix-ui\/react-(popover|popper|tooltip|hover-card|select|menubar|context-menu|navigation-menu)/.test(src)) radix.push(r);
    if (!inUi(r) && !ROLE_OK.has(r)) {
      for (const m of src.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\brole=["{']+(menu|menuitem|menuitemradio|menuitemcheckbox|listbox|tooltip)["}']/g)) roles.push(`${r}: <${m[1]} role="${m[2]}">`);
    }
    if (!inUi(r) && /document\.addEventListener\(\s*['"]pointerdown['"]/.test(src)) outside.push(r);
  }
  say(radix.length === 0, 'no Radix popper-family import outside components/ui/', radix.join(', '));
  say(roles.length === 0, 'no hand-drawn popup role (menu, listbox, tooltip) outside components/ui/', roles.join('; '));
  say(outside.length === 0, 'no document-level outside-press listener outside components/ui/ (a hand-rolled popover)', outside.join(', '));

  const cssFiles = files.filter((p) => p.endsWith('.css'));
  const byHand = [], z = [];
  // A fixed banner and the skip link are not floating surfaces; they are the
  // only literal layers allowed at 40 and above.
  const Z_OK = /\.upd-banner|\.skip-link/;
  for (const f of cssFiles) {
    const css = stripCss(readFileSync(f, 'utf8'));
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().split('\n').pop().trim(), body = m[2];
      if (/(top|bottom):\s*calc\(100%\s*\+/.test(body) && /position:\s*absolute/.test(body)) byHand.push(`${rel(f)}: ${sel.slice(0, 50)}`);
      const zv = body.match(/z-index:\s*(\d+)/);
      if (zv && Number(zv[1]) >= 40 && !Z_OK.test(sel)) z.push(`${rel(f)}: ${sel.slice(0, 40)} z-index ${zv[1]}`);
    }
  }
  say(byHand.length === 0, 'no dropdown positioned by hand under its trigger (top: calc(100% + …))', byHand.join('; '));
  say(z.length === 0, 'no literal z-index in the floating range - overlays use --z-modal / --z-popover / --z-tooltip', z.join('; '));

  // The primitives themselves: portalled, collision-aware, focus handled.
  const readSafe = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : ''); // missing = FAIL, not a crash
  const pop = readSafe(join(SRC, UI, 'Popover.tsx'));
  const menu = readSafe(join(SRC, UI, 'Menu.tsx'));
  say(/<RP\.Portal>/.test(pop) && /collisionPadding=\{8\}/.test(pop) && /<DM\.Portal>/.test(menu) && /collisionPadding=\{8\}/.test(menu),
    'ui/Popover and ui/Menu portal out of clipping ancestors and keep 8px off the viewport edge');
  say(/onCloseAutoFocus/.test(pop) && /onCloseAutoFocus/.test(menu), 'both decide where focus goes on close');
  const users = tsx.filter((f) => /from ['"][./]+(components\/)?ui\/(Popover|Menu)['"]|from ['"]\.\/ui\/(Popover|Menu)['"]|from ['"]\.\.\/ui\/(Popover|Menu)['"]|from ['"]\.\/(Popover)['"]/.test(readFileSync(f, 'utf8'))).map(rel);
  say(users.length >= 7, 'the migrated surfaces import the primitives', users.join(', '));
}

// ── 3. sortable headers are buttons ─────────────────────────────────────────
console.log('\n── a sortable header is a button a keyboard can reach ─────');
{
  const hits = [];
  for (const f of files.filter((p) => p.endsWith('.tsx'))) {
    const src = stripTs(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/<th\b[^>]*\bonClick=/g)) hits.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length}`);
  }
  say(hits.length === 0, 'no <th onClick> (use components/SortHeader.tsx)', hits.join(', '));
}

// ── 4. the focus ring does not reshape what it rings ────────────────────────
console.log('\n── the focus ring never sets a radius ─────────────────────');
{
  const css = stripCss(readFileSync(join(SRC, 'index.css'), 'utf8'));
  const rule = css.match(/(?:^|\n)\*:focus-visible\s*\{([^}]*)\}/);
  say(!!rule, 'index.css has the global *:focus-visible rule');
  say(!!rule && /outline\s*:/.test(rule[1]) && !/border-radius/.test(rule[1]),
    'it draws an outline and sets no border-radius', rule ? rule[1].trim() : '');
}

console.log(`\n  ${passes} pass · ${failures} fail`);
process.exit(failures ? 1 : 0);
