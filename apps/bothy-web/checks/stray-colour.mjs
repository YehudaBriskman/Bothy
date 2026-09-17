// Every colour in this app must come from a token.
//
// WHY THIS EXISTS. Four separate colour bugs were found in one afternoon while
// preparing the app for named themes, and all four shared a shape: a colour that
// had stopped following the palette, in a way that throws nothing and logs
// nothing. `STATUS_VAR` pointed at `--ok/--warn/--down/--off/--unk` after the
// tokens were renamed to `--st-*`, so every status glyph silently inherited body
// text. `cssVar('--primary')` named a token that never existed, so three point
// lights and the rack emissive stayed on the accent colour from before the
// palette was replaced. The whole SVG topology inlined the 3D scene's hex mirror
// and could not re-theme at all. Two `color: #fff` rules painted white text on a
// light-mode accent gradient.
//
// None of those are visible in a diff, and none are visible on the theme you
// happen to be using. They are only visible on the OTHER one - which is exactly
// the thing nobody looks at. So the rule gets a test rather than a paragraph.
//
// THE RULE. A colour literal - hex, rgb(), hsl(), or a named CSS colour - may
// appear only:
//   1. in a file that DEFINES tokens (index.css, the theme files, the syntax
//      palette) or that genuinely cannot read them (the 3D material constants);
//   2. inside a mask, where black and white are alpha and not colour;
//   3. on a line carrying a `stray-colour-ok:` marker with a reason.
//
// The marker is deliberately ugly and deliberately requires prose. It is not an
// escape hatch, it is a place to write down why this one is not a token - and if
// that reason is hard to write, the honest answer was a token.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '..', 'web', 'src');

// ── files exempt in full, each with the reason it is exempt ──────────────────
//
// Kept as a list with reasons rather than a glob: an exemption nobody can
// explain is an exemption that should not exist, and a glob hides how many
// there are. Four is a number you can hold in your head; if it reaches ten,
// something has gone wrong with the idea rather than with the list.
const EXEMPT = new Map([
  ['index.css',
    'defines the tokens. This is the palette; it is where the literals live.'],
  ['hl.css',
    'defines the five --hl-* syntax tokens for both themes. Same job as '
    + 'index.css. Its own file rather than part of the Files shell because a '
    + 'second surface - the theme editor CSS pane - renders code on a route '
    + 'that must not load that shell, and the alternative was a second copy of '
    + 'these eight hexes, which is the bug this check exists to catch.'],
  ['components/three/webgl.ts',
    'the ScenePalette and the STATUS_HEX mirror. The 3D scene paints with real '
    + 'materials and cannot resolve a CSS variable into a mesh colour, so its '
    + 'palette is data. statusHexes() reads the live tokens where it can.'],
  ['components/three/StackScene.tsx',
    'TYPE_TINT, the glow-sprite gradient and the nameplate canvas. Canvas 2D '
    + 'and material constants, none of which has a CSS equivalent.'],
]);

// A theme is a full token set by definition, so the whole directory is a
// definition site. Matched by prefix rather than listed, because the point of
// the theme format is that adding one is adding a file.
const EXEMPT_DIR = 'themes/';

// ── what counts as a colour ─────────────────────────────────────────────────
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const FUNC = /\b(?:rgba?|hsla?)\s*\(/;
// Named colours only in value position (after `:` or `,`) and not followed by a
// hyphen, so `white-space: nowrap` and `grayscale(1)` are not colours.
const NAMED = /(?<=[:,]\s*)(?:white|black|red|green|blue|yellow|orange|purple|gray|grey|silver|maroon|navy|teal|olive|lime|aqua|fuchsia|cyan|magenta|pink|brown|gold|beige|ivory|coral|salmon|khaki|violet|indigo|crimson|tomato|orchid|plum|tan|azure|linen|wheat|snow)\b(?!-)/;

// Black and white inside a mask are ALPHA, not colour: a mask reads the
// luminance channel and throws the hue away, so `#000` there means "hide" and
// `#fff` means "show". Re-theming them would be a category error, not a fix.
const MASK = /mask(?:-image)?\s*:/;
const MASK_SAFE = /^#(?:0{3,4}|0{6}|0{8}|f{3,4}|f{6}|f{8})$/i;

const MARKER = 'stray-colour-ok:';

// ── comment stripping ───────────────────────────────────────────────────────
//
// Blanked rather than removed, so line numbers survive into the report. A
// literal in a comment is prose - several of the comments in this app quote the
// very hexes that caused a bug - and prose is not a colour.
function stripComments(text, js) {
  const out = text.split('');
  let i = 0, block = false, line = false, quote = null;
  while (i < text.length) {
    const c = text[i], d = text[i + 1];
    if (block) {
      if (c === '*' && d === '/') { out[i] = out[i + 1] = ' '; i += 2; block = false; continue; }
      if (c !== '\n') out[i] = ' ';
      i++; continue;
    }
    if (line) {
      if (c === '\n') { line = false; i++; continue; }
      out[i] = ' '; i++; continue;
    }
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || (js && c === '`')) { quote = c; i++; continue; }
    if (c === '/' && d === '*') { out[i] = out[i + 1] = ' '; i += 2; block = true; continue; }
    if (js && c === '/' && d === '/') { out[i] = out[i + 1] = ' '; i += 2; line = true; continue; }
    i++;
  }
  return out.join('');
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(css|ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

// ── the pass ────────────────────────────────────────────────────────────────
const findings = [];
let scanned = 0, exempted = 0, marked = 0, masked = 0;

for (const file of walk(SRC).sort()) {
  const rel = relative(SRC, file).split('\\').join('/');
  if (EXEMPT.has(rel) || rel.startsWith(EXEMPT_DIR)) { exempted++; continue; }
  scanned++;

  const js = /\.tsx?$/.test(file);
  const raw = readFileSync(file, 'utf8').split('\n');
  const lines = stripComments(raw.join('\n'), js).split('\n');

  // The marker lives in a comment, and comments are blanked above - so it has to
  // be looked for in the RAW line, not the stripped one. A marker excuses the
  // line it sits on, or the first code line after the comment block it opens:
  // walk back over lines that are blank once stripped but not blank raw, which
  // is precisely the definition of "was a comment". That keeps the marker
  // attached to a specific declaration rather than to a line range someone has
  // to count.
  const excused = (n) => {
    if (raw[n]?.includes(MARKER)) return true;
    for (let i = n - 1; i >= 0; i--) {
      if (lines[i].trim() !== '' || raw[i].trim() === '') return false;
      if (raw[i].includes(MARKER)) return true;
    }
    return false;
  };

  lines.forEach((line, n) => {
    const hex = line.match(new RegExp(HEX, 'g')) ?? [];
    const other = FUNC.test(line) || NAMED.test(line);
    if (!hex.length && !other) return;

    if (excused(n)) { marked++; return; }
    if (MASK.test(line) && !other && hex.every((h) => MASK_SAFE.test(h))) { masked++; return; }

    findings.push({ rel, line: n + 1, text: line.trim().slice(0, 96) });
  });
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`  scanned ${scanned} files · ${exempted} exempt by name · `
  + `${marked} marked · ${masked} mask-alpha`);

for (const [rel, why] of EXEMPT) console.log(`  exempt  ${rel.padEnd(38)} ${why.slice(0, 60)}…`);

if (!findings.length) {
  console.log('  PASS: every colour outside the palette comes from a token');
  process.exit(0);
}

console.log(`\n  FAIL: ${findings.length} colour literal(s) outside the palette\n`);
for (const f of findings) console.log(`    ${f.rel}:${f.line}\n      ${f.text}`);
console.log(
  '\n  Each one is a colour that will not follow a theme. Use a token, or add\n'
  + `  a \`${MARKER} <reason>\` comment on the line saying why it cannot be one.`,
);
process.exit(1);
