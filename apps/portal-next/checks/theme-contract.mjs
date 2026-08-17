// A theme is legal or it is not, and the rules are already written down.
//
// index.css does not merely assert its palette is accessible - it records the
// measurements, the bands, the orderings and the two historical bugs that
// produced the rules. All of that is prose, which means it holds exactly as long
// as the next person reads it. This turns it into a test, so that porting a
// theme becomes mechanical: write the tokens, run this, fix what it names.
//
// It is deliberately run against the SHIPPED palette too. If a rule stated here
// fails on Bothy's own dark and light themes, the rule is wrong - not the
// palette - and this file is where that gets found out.
//
// WHAT A THEME OWES. Of the 73 custom properties in :root, 16 are DERIVED
// (color-mix over another token, on the same element, so they re-evaluate for
// free) and 16 are STRUCTURAL (radii, motion, fonts, widths - not colour, and
// shared by every theme). The remaining 41 are the theme's own, and a theme must
// declare all of them: a missing token silently inherits the base palette, which
// is how you get a Gruvbox page with one blue button on it.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '..', 'web', 'src');

// ── colour ──────────────────────────────────────────────────────────────────

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Parse the value forms that actually appear in these files: #rgb, #rrggbb,
 *  #rrggbbaa, rgb()/rgba() in both comma and space syntax. Returns
 *  {r,g,b,a} in 0..1, or null for anything else (a var(), a gradient, a
 *  shadow recipe) - callers decide whether "not a flat colour" is a failure. */
function parseColour(v) {
  const s = String(v).trim();
  const hex = s.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  const fn = s.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const parts = fn[1].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (p) => (p.endsWith('%') ? parseFloat(p) / 100 * 255 : parseFloat(p));
    const alpha = (p) => (p == null ? 1 : p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p));
    const [r, g, b] = parts.slice(0, 3).map(num);
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r: r / 255, g: g / 255, b: b / 255, a: alpha(parts[3]) };
  }
  return null;
}

/** Flatten a translucent colour onto an opaque one. --line and the shadow
 *  recipes are alpha over a surface, and comparing them un-composited would
 *  measure a colour that is never on screen. */
const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});

const luminance = (c) =>
  0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** sRGB → OKLCH. The accent-legality rule is stated in OKLCH (hue degrees and
 *  chroma), and index.css records every accent's coordinates in a comment, so
 *  this is the space the contract is written in. */
function oklch(c) {
  const [r, g, b] = [c.r, c.g, c.b].map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const C = Math.hypot(A, B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}

/** Shortest angular distance, because hue is a circle and 355° is 20° away from
 *  15°, not 340°. The --a5/--st-down pair is only legal by this reading. */
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// ── the token blocks ────────────────────────────────────────────────────────

/** Split a stylesheet into { sel, toks } with a BRACE COUNTER, not a flat regex.
 *
 *  The flat version - `/(^|})([^{}]+)\{([^{}]*)\}/g` - is the obvious thing to
 *  write and it is wrong here, silently. index.css has eleven @media blocks, and
 *  a nested `}` puts the pattern out of step with the real block structure: it
 *  found ONE :root block where the file has two, so the eleven derived tint
 *  tokens in the second one were invisible to the check. That happened not to
 *  change the required set (all eleven are derived), which is precisely why it
 *  would have gone unnoticed - a parser that is wrong about a file it currently
 *  agrees with is a check waiting to stop working.
 *
 *  At-rules are recursed into and their prelude is prefixed onto the selector,
 *  so a `:root` inside `@media (prefers-color-scheme: dark)` is reported as
 *  distinct from the bare `:root` rather than merged into it. */
function blocks(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];

  const scan = (text, prefix) => {
    let i = 0, start = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '{') {
        const prelude = text.slice(start, i).trim();
        let depth = 1, j = i + 1;
        while (j < text.length && depth) {
          if (text[j] === '{') depth++;
          else if (text[j] === '}') depth--;
          j++;
        }
        const body = text.slice(i + 1, j - 1);
        if (prelude.startsWith('@')) {
          scan(body, `${prefix}${prelude} `);
        } else {
          const toks = {};
          // Only declarations at THIS level: strip any nested block first, so a
          // token inside a nested rule is not attributed to its parent.
          const flat = body.replace(/\{[^{}]*\}/g, '');
          for (const t of flat.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) toks[t[1]] = t[2].trim();
          // `color-scheme` is not a custom property but it is how a theme
          // declares its appearance, so it is carried alongside rather than
          // inferred from the id - "tokyo-night" does not say dark, and a
          // convention that it should would break on the first exception.
          const cs = flat.match(/color-scheme\s*:\s*(dark|light)/);
          if (Object.keys(toks).length) {
            out.push({ sel: prefix + prelude, toks, scheme: cs ? cs[1] : null });
          }
        }
        i = j; start = j;
        continue;
      }
      if (c === '}') { i++; start = i; continue; }
      i++;
    }
  };

  scan(src, '');
  return out;
}

const indexCss = readFileSync(join(SRC, 'index.css'), 'utf8');
const shellCss = readFileSync(join(SRC, 'pages', 'files', 'shell.css'), 'utf8');
const idx = blocks(indexCss);

const merge = (...sets) => Object.assign({}, ...sets);
const pick = (pred) => merge(...idx.filter((b) => pred(b.sel)).map((b) => b.toks));

const BASE = pick((s) => s === ':root');
const LIGHT = pick((s) => /^:root\[data-theme=['"]?light/.test(s));

// The syntax palette lives beside the editor it serves rather than in index.css.
// A theme that restyles everything except code is not a theme, so it is part of
// the contract - but as an OPTIONAL group, because a theme that omits it falls
// back to a set that is already contrast-checked for its appearance.
const hlBlocks = blocks(shellCss).filter((b) => b.sel.includes('bothy-files'));
const HL_DARK = merge(...hlBlocks.filter((b) => !b.sel.includes('light')).map((b) => b.toks));
const HL_LIGHT = merge(...hlBlocks.filter((b) => b.sel.includes('light')).map((b) => b.toks));

const DERIVED = new Set(Object.entries(BASE).filter(([, v]) => v.includes('var(')).map(([k]) => k));
const STRUCTURAL = new Set([
  '--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-full', '--border-w', '--wrap',
  '--scrollbar-w', '--dur-fast', '--dur', '--dur-slow', '--ease', '--font', '--mono',
  '--disabled-opacity', '--rest-opacity',
]);
// Required of every theme: literal, not derived, not structural.
const REQUIRED = Object.keys(BASE)
  .filter((k) => !DERIVED.has(k) && !STRUCTURAL.has(k))
  .sort();

// ── the rules ───────────────────────────────────────────────────────────────

const STATUSES = ['up', 'warn', 'down', 'unknown', 'off'];
const ACCENTS = ['--a1', '--a2', '--a3', '--a4', '--a5'];
const CHARTS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'];

// Written into index.css as measurements, reproduced here as thresholds.
const AA = 4.5;              // text
const ACCENT_ON_SURFACE = 4.6; // --a1..--a5 are painted as 12px bold text
const CHART_VS_CARD = 3.0;
const CHROMATIC_C = 0.06;    // a status at or above this is "chromatic"
const HUE_SEPARATION = 45;   // degrees, against a chromatic status
const CHROMA_MARGIN = 0.06;  // against a near-grey status
const BAND = { dark: [0.48, 0.67], light: [0.43, 0.77] };

// Three light-mode status FILLS sit below 3:1 on purpose: they are large solid
// areas beside a track, never small glyphs or 1px borders, and status is never
// encoded by colour alone. Recorded as an allowance WITH its reason so that a
// new theme cannot quietly widen it - the allowance is per token, not a blanket
// "fills are exempt".
const FILL_ALLOWANCE = {
  '--st-up': 'large filled area beside a track; the -fg half carries any text',
  '--st-unknown': 'as --st-up',
  '--st-off': 'as --st-up, and deliberately the quietest thing on the page',
};

let failures = 0, passes = 0;
const say = (ok, label, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

function checkTheme(name, appearance, toks, hl) {
  console.log(`\n── ${name}  (${appearance}) ─────────────────────────────────`);

  // 1. completeness
  const missing = REQUIRED.filter((k) => !(k in toks));
  say(!missing.length, 'declares every required token',
    missing.length ? `missing ${missing.length}: ${missing.slice(0, 6).join(' ')}` : `${REQUIRED.length} tokens`);
  if (missing.length) return;

  const C = (k) => {
    const p = parseColour(toks[k]);
    return p;
  };
  const s1 = C('--surface-1'), s2 = C('--surface-2'), bg2 = C('--bg-2');
  const on = (fg, bg) => contrast(fg.a < 1 ? over(fg, bg) : fg, bg);

  // A foreground is measured against every ground it is PAINTED on, not against
  // one canonical background. That distinction is not pedantry: the first thing
  // this check found was that the two quietest status foregrounds had been
  // measured on a card while being used mostly in the file explorer and the
  // reader's index, both of which sit on --bg-2 - a darker ground, so the real
  // ratios were ~0.35 lower than the ones written into index.css, and below AA.
  const GROUNDS = [['surface-1', s1], ['surface-2', s2], ['bg-2', bg2]];
  const worst = (fg) => GROUNDS.reduce(
    (acc, [n, g]) => { const v = on(fg, g); return v < acc.v ? { n, v } : acc; },
    { n: '', v: Infinity },
  );

  // 2. foreground contrast
  for (const k of ['--fg', '--fg-muted', '--fg-subtle']) {
    const w = worst(C(k));
    say(w.v >= AA, `${k} >= ${AA}:1 on every ground it is painted on`,
      `worst ${w.v.toFixed(2)} on ${w.n}`);
  }
  {
    const a = on(C('--accent-fg'), s1);
    say(a >= AA, `--accent-fg >= ${AA}:1 on surface-1`, a.toFixed(2));
    const o = on(C('--on-accent'), C('--accent'));
    say(o >= 3.0, '--on-accent >= 3:1 on --accent (button text)', o.toFixed(2));
  }

  // 3. status: -fg is the text-safe half, the fill is not asserted where the
  //    palette says out loud that it is a large area.
  for (const s of STATUSES) {
    const w = worst(C(`--st-${s}-fg`));
    say(w.v >= AA, `--st-${s}-fg >= ${AA}:1 on every ground it is painted on`,
      `worst ${w.v.toFixed(2)} on ${w.n}`);
  }
  for (const s of STATUSES) {
    const key = `--st-${s}`;
    const v = on(C(key), s1);
    if (key in FILL_ALLOWANCE) {
      console.log(`ALLOW ${key} fill at ${v.toFixed(2)}:1 - ${FILL_ALLOWANCE[key]}`);
      passes++;
    } else {
      say(v >= CHART_VS_CARD, `${key} fill >= 3:1 on surface-1`, v.toFixed(2));
    }
  }

  // 4. light-mode status weight must run down > warn > up > unknown > stopped.
  //    Not asserted on dark: a saturated red is intrinsically darker than a
  //    saturated green and index.css forbids "fixing" it by brightening the red
  //    into the amber's territory.
  if (appearance === 'light') {
    const order = ['down', 'warn', 'up', 'unknown', 'off'];
    const w = order.map((s) => ({ s, L: oklch(C(`--st-${s}`)).L }));
    const ok = w.every((x, i) => i === 0 || w[i - 1].L <= x.L + 1e-9);
    say(ok, 'light status weight runs down > warn > up > unknown > stopped',
      w.map((x) => `${x.s} ${x.L.toFixed(3)}`).join(' < '));
  }

  // 5. accent legality - the whole reason --a4 stopped being #34d399
  const stats = STATUSES.map((s) => ({ s, ...oklch(C(`--st-${s}`)) }));
  for (const k of ACCENTS) {
    const a = oklch(C(k));
    const bad = [];
    for (const st of stats) {
      if (st.C >= CHROMATIC_C) {
        const g = hueGap(a.H, st.H);
        if (g < HUE_SEPARATION) bad.push(`${st.s}: hue gap ${g.toFixed(0)}° < ${HUE_SEPARATION}°`);
      } else if (a.C - st.C < CHROMA_MARGIN) {
        bad.push(`${st.s}: chroma margin ${(a.C - st.C).toFixed(3)} < ${CHROMA_MARGIN}`);
      }
    }
    say(!bad.length, `${k} is legal against every status`,
      bad.length ? bad.join('; ') : `L ${a.L.toFixed(2)} C ${a.C.toFixed(3)} H ${a.H.toFixed(0)}°`);
  }
  for (const k of ACCENTS) {
    const v = on(C(k), s2);
    say(v >= ACCENT_ON_SURFACE, `${k} >= ${ACCENT_ON_SURFACE}:1 on surface-2 (12px bold text)`,
      v.toFixed(2));
  }

  // 6. charts - band, and separation against the card. Slot ORDER is part of
  //    what was validated upstream, so the check reads them in order and never
  //    sorts them.
  const [lo, hi] = BAND[appearance];
  for (const k of CHARTS) {
    const c = oklch(C(k));
    say(c.L >= lo && c.L <= hi, `${k} inside the ${appearance} lightness band ${lo}-${hi}`,
      `L ${c.L.toFixed(3)}`);
  }
  for (const k of CHARTS) {
    const v = on(C(k), s1);
    say(v >= CHART_VS_CARD, `${k} >= 3:1 on surface-1`, v.toFixed(2));
  }

  // 7. the syntax palette, when the theme carries one
  if (hl && Object.keys(hl).length) {
    for (const [k, v] of Object.entries(hl)) {
      const c = parseColour(v);
      if (!c) continue; // --hl-com is var(--fg-subtle); already checked above
      const a = contrast(c, bg2);
      say(a >= AA, `${k} >= ${AA}:1 on --bg-2`, a.toFixed(2));
    }
  }
}

// ── run ─────────────────────────────────────────────────────────────────────

console.log(`  contract: ${REQUIRED.length} required tokens · `
  + `${DERIVED.size} derived (re-evaluate for free) · ${STRUCTURAL.size} structural (shared)`);

checkTheme('Bothy Dark', 'dark', BASE, HL_DARK);
checkTheme('Bothy Light', 'light', merge(BASE, LIGHT), merge(HL_DARK, HL_LIGHT));

// The five swatch copies the picker paints for the two built-ins. They exist
// because a :root palette cannot be applied to a card in a list; they are safe
// only while they still equal what they claim to preview.
console.log('\n── picker swatches match the palettes they preview ─────');
{
  const PREVIEWS = [['--sw-1', '--accent'], ['--sw-2', '--st-up'], ['--sw-3', '--st-warn'],
    ['--sw-4', '--st-down'], ['--sw-5', '--a5']];
  // They live in Settings.css, scoped to .theme-swatch, because unscoped they
  // matched the root element and leaked --sw-1..5 into the whole document.
  const settings = blocks(readFileSync(join(SRC, 'pages', 'Settings.css'), 'utf8'));
  for (const [id, toks] of [['bothy-dark', BASE], ['bothy-light', merge(BASE, LIGHT)]]) {
    const want = `.theme-swatch[data-bothy-theme='${id}']`;
    const sw = merge(...settings
      .filter((b) => b.sel.split(',').some((p) => p.trim() === want))
      .map((b) => b.toks));
    for (const [k, real] of PREVIEWS) {
      const a = (sw[k] ?? '').toLowerCase();
      const b = (toks[real] ?? '').toLowerCase();
      say(!!a && a === b, `${id} ${k} still equals ${real}`, a === b ? a : `${a || '(missing)'} vs ${b}`);
    }
  }
}

// Every file in src/themes is a theme. Adding one is adding a file; the check
// finds it without being told.
const themeDir = join(SRC, 'themes');
if (existsSync(themeDir)) {
  // A theme file holds two kinds of block and they must not be confused: the
  // PALETTE, whose selector is the doubled root attribute and nothing else, and
  // the optional SYNTAX block, which is a descendant selector ending in
  // .bothy-files. Matching on `data-bothy-theme` alone matched both, so each
  // theme was checked twice - the second time with five syntax tokens layered
  // over the BASE palette, which of course passed, because it was measuring
  // Bothy Dark and calling it Tokyo Night. A check that reports a PASS for a
  // thing it did not look at is worse than one that reports nothing.
  const PALETTE = /^:?(?:root)?\[data-bothy-theme=['"]?([a-z0-9-]+)['"]?\](?:\[data-bothy-theme\])?$/;
  const SYNTAX = /^:root\[data-bothy-theme=['"]?([a-z0-9-]+)['"]?\]\s+\S/;
  // A palette declares two selectors in one comma list (see any theme file), so
  // matching has to look at each part rather than at the whole prelude.
  const parts = (sel) => sel.split(',').map((s) => s.trim());
  const matchAny = (sel, re) => parts(sel).map((s) => s.match(re)).find(Boolean);

  for (const f of readdirSync(themeDir).filter((n) => n.endsWith('.css')).sort()) {
    const bs = blocks(readFileSync(join(themeDir, f), 'utf8'));
    const hl = {};
    for (const b of bs) {
      const m = matchAny(b.sel, SYNTAX);
      if (m) Object.assign(hl, { [m[1]]: merge(hl[m[1]] ?? {}, b.toks) });
    }
    for (const b of bs) {
      const m = matchAny(b.sel, PALETTE);
      if (!m) continue;
      if (!b.scheme) {
        console.log(`FAIL  ${m[1]} declares no color-scheme - the appearance is not guessable`);
        failures++;
        continue;
      }
      checkTheme(m[1], b.scheme, merge(BASE, b.toks), hl[m[1]] ?? null);
    }
  }
}

console.log(`\n  ${passes} pass · ${failures} fail`);
process.exit(failures ? 1 : 0);
