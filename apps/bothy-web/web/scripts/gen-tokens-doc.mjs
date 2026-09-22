#!/usr/bin/env node
// Generates docs/brand/reference/tokens.md from src/index.css (design audit
// SYS-20, 2026-09-21). The page was hand-transcribed and had drifted: six chrome
// accents where the code has five, a light --bg-glow described as white when it
// is blue, three tokens missing, and "no spacing or type scale" after one
// landed. A generated page cannot drift; checks/design-tokens.mjs fails when
// this output and the committed page disagree.
//
//   node apps/bothy-web/web/scripts/gen-tokens-doc.mjs          write the page
//   import { render } from './gen-tokens-doc.mjs'                 (the check)
//
// Only the token TABLES are generated. The reasoning lives in the foundations
// pages, which link here; the one-line role beside each token is the comment
// written next to it in index.css, so the place to change a description is the
// place the value is.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** { name -> { value, note } } for every declaration directly in a block whose
 *  selector is exactly `sel` (outside any at-rule). The note is a trailing
 *  comment on the same line. */
function tokens(css, sel) {
  const out = {};
  let i = 0;
  const src = css;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const prelude = src.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    let depth = 1, j = open + 1;
    while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
    const body = src.slice(open + 1, j - 1);
    if (prelude === sel) {
      // Walk statements; keep the comment that trails a declaration on its line.
      const re = /(--[\w-]+)\s*:\s*([^;]+);[ \t]*(\/\*([^*]|\*(?!\/))*\*\/)?/g;
      const clean = body.replace(/\/\*[\s\S]*?\*\//g, (c) => (c.includes('\n') ? ' '.repeat(c.length) : c));
      for (const m of clean.matchAll(re)) {
        const note = m[3] ? m[3].slice(2, -2).trim() : '';
        out[m[1]] = { value: m[2].replace(/\s+/g, ' ').trim(), note };
      }
    }
    i = j;
  }
  return out;
}

const GROUPS = [
  ['Surfaces', (k) => /^--(bg|bg-2|surface-\d|bg-glow)$/.test(k), 'Opaque, an elevation ladder. See [shape-and-elevation](../foundations/shape-and-elevation.md).'],
  ['Foreground', (k) => /^--(fg|fg-muted|fg-subtle|on-accent)$/.test(k), 'Held at 4.5:1 on every ground they are painted on (`checks/theme-contract.mjs`).'],
  ['Lines', (k) => /^--line/.test(k), ''],
  ['Accent - chrome only, never state', (k) => /^--(accent|accent-2|accent-fg|accent-bg|accent-line|ring)$/.test(k), 'Settings > Appearance > Accent swaps `--accent`, `--accent-2` and `--accent-fg` on the two built-in palettes.'],
  ['Brand - identity, never chrome and never state', (k) => k === '--brand', ''],
  ['Status - reserved, never chrome', (k) => /^--st-/.test(k), 'Each status has a fill, a `-fg` text half (the only one text may use), a `-bg` tint and a `-line` border.'],
  ['Chart series - order is load-bearing', (k) => /^--chart-/.test(k), ''],
  ['Panel accents - decoration, never state', (k) => /^--a\d$/.test(k), 'Five, spaced across the one hue window that clears every status by 45°.'],
  ['Shape', (k) => /^--(r-|border-w|disabled-opacity|rest-opacity)/.test(k), ''],
  ['Type scale', (k) => /^--(fs|lh|tr|fw)-|^--label-tracking$/.test(k), 'Closed: nine steps in rem, each with its own leading and tracking. Use the three together.'],
  ['Spacing', (k) => /^--sp-/.test(k), 'A 4px grid with 2px and 6px half-steps, in rem. `--sp-2_5` is 2.5 steps.'],
  ['Icons', (k) => /^--icon-/.test(k), 'Mirrored as `ICON` in `components/ui/Icon.tsx`.'],
  ['Interaction', (k) => /^--(hit|ring-w|ring-offset|press-scale|press-scale-wide|surface-press)$/.test(k), '`--hit` is 2.75rem (44px) under `(pointer: coarse)`.'],
  ['Motion', (k) => /^--(dur|ease|spring|stagger|loop|press-dur)/.test(k), 'Mirrored in `lib/motion.ts` for framer-motion; the check asserts they agree. Springs are for dialogs, menus and drag only.'],
  ['Elevation and materials', (k) => /^--(shadow|scrim|mat-)/.test(k), 'Four steps with fixed meanings: 1 rest, 2 raised, 3 popover, 4 modal. A theme sets only `--shadow-color`, `--shadow-hairline` and `--scrim`.'],
  ['Scroll', (k) => /^--(scroll|scrollbar)/.test(k), ''],
  ['Reading', (k) => /^--(read|rd)-/.test(k), 'The rendered-document scale in Files.'],
  ['Families and layout', (k) => /^--(font|mono|font-serif|wrap)$/.test(k), ''],
];

const cell = (v) => `\`${v.replace(/\|/g, '\\|')}\``;
const trim = (v) => (v.length > 70 ? `${v.slice(0, 67)}...` : v);

export function render(css) {
  const dark = {};
  for (const [k, v] of Object.entries(tokens(css, ':root'))) dark[k] = v;
  const light = tokens(css, ":root[data-theme='light']");
  const coarse = /@media \(pointer: coarse\)\s*\{\s*:root\s*\{\s*--hit:\s*([^;]+);/.exec(css)?.[1];
  const lines = [
    '# Token reference',
    '',
    '_Generated from `apps/bothy-web/web/src/index.css` by',
    '`apps/bothy-web/web/scripts/gen-tokens-doc.mjs`. Do not edit by hand:',
    'change the token (and the comment beside it, which is the "Role" column),',
    'then re-run the script. `checks/design-tokens.mjs` fails when this page and',
    'the code disagree._',
    '',
    'Contrast rules, the theme contract and the reasoning behind each choice are in',
    '[foundations/colour.md](../foundations/colour.md),',
    '[typography](../foundations/typography.md), [motion](../foundations/motion.md) and',
    '[shape-and-elevation](../foundations/shape-and-elevation.md).',
    '',
  ];
  const used = new Set();
  for (const [title, pick, note] of GROUPS) {
    const keys = Object.keys(dark).filter((k) => pick(k) && !used.has(k));
    if (!keys.length) continue;
    keys.forEach((k) => used.add(k));
    const hasLight = keys.some((k) => light[k] && light[k].value !== dark[k].value);
    lines.push(`## ${title}`, '');
    if (note) lines.push(note, '');
    lines.push(hasLight ? '| Token | Dark | Light | Role |' : '| Token | Value | Role |');
    lines.push(hasLight ? '|---|---|---|---|' : '|---|---|---|');
    for (const k of keys) {
      const d = cell(trim(dark[k].value));
      let role = dark[k].note || light[k]?.note || '';
      if (k === '--hit' && coarse) role = `${role ? `${role}; ` : ''}${coarse.trim()} under a coarse pointer`;
      if (hasLight) lines.push(`| \`${k}\` | ${d} | ${light[k] ? cell(trim(light[k].value)) : 'same'} | ${role} |`);
      else lines.push(`| \`${k}\` | ${d} | ${role} |`);
    }
    lines.push('');
  }
  const rest = Object.keys(dark).filter((k) => !used.has(k));
  if (rest.length) {
    lines.push('## Other', '', '| Token | Value |', '|---|---|');
    for (const k of rest) lines.push(`| \`${k}\` | ${cell(trim(dark[k].value))} |`);
    lines.push('');
  }
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const css = readFileSync(join(here, '..', 'src', 'index.css'), 'utf8');
  const out = join(here, '..', '..', '..', '..', 'docs', 'brand', 'reference', 'tokens.md');
  writeFileSync(out, render(css));
  console.log(`wrote ${out}`);
}
