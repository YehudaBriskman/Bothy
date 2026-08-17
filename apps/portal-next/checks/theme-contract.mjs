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
//
// THE RULES THEMSELVES ARE NOT IN HERE - they are in web/src/lib/contract.ts,
// which imports nothing and is compiled by run.sh into the temp dir this file is
// run from. They moved because the in-app theme editor has to show the SAME
// warnings live while somebody picks colours, and two copies of a threshold is
// one copy that will be wrong. What stays here is the part that is node's:
// finding the stylesheets, parsing them, discovering the themes, printing lines.
// Run it through checks/run.sh; on its own there is no compiled contract to
// import.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateTheme, requiredTokens, STRUCTURAL,
} from './contract.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// Unlike the other checks, this one READS the source tree, and run.sh runs it
// from a temp dir beside the compiled contract - so the tree is passed in rather
// than assumed to be a sibling. The fallback is what it means to run in place.
const SRC = process.argv[2] ?? join(HERE, '..', 'web', 'src');

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
// Required of every theme: literal, not derived, not structural. The rule for
// which is which is in contract.ts, because the editor has to answer the same
// question about a half-finished theme.
const REQUIRED = requiredTokens(BASE);

// ── printing ────────────────────────────────────────────────────────────────

let failures = 0, passes = 0;
const say = (ok, label, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

// An 'allow' is a fill below the floor that the palette permits out loud, so it
// prints its reason rather than a verdict - see FILL_ALLOWANCE in contract.ts.
const render = (f) => {
  if (f.level === 'allow') {
    console.log(`ALLOW ${f.label} - ${f.detail}`);
    passes++;
    return;
  }
  say(f.level === 'pass', f.label, f.detail);
};

function checkTheme(name, appearance, toks, hl) {
  console.log(`\n── ${name}  (${appearance}) ─────────────────────────────────`);
  for (const f of evaluateTheme(toks, appearance, { required: REQUIRED, syntax: hl })) render(f);
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
  // They live in themes/picker.css, scoped to .theme-swatch: scoped, because
  // unscoped they matched the root element and leaked --sw-1..5 into the whole
  // document; in themes/, because a file that defines colour values is a
  // palette definition site and stray-colour.mjs is right to refuse them
  // anywhere else.
  const settings = blocks(readFileSync(join(SRC, 'themes', 'picker.css'), 'utf8'));
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
