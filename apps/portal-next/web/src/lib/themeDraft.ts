// A theme being edited: where its starting values come from, and how it turns
// into the file that gets written.
//
// THE PALETTE IS NEVER DUPLICATED HERE. The editor needs two things the browser
// already knows - which tokens exist, and what the current theme sets them to -
// and both are read back out of the live document rather than listed in a
// constant. A list would be a fourth copy of the palette (after index.css, the
// theme files, and the contract's own derivation), and the first one to go
// stale, silently, in a way that shows up as "the editor forgot a token".

import { requiredTokens } from './contract';

/** Custom properties on `:root` that are not palette tokens.
 *
 *  THE BUILD PUTS THEM THERE. lightningcss - Vite's CSS minifier - injects
 *  `--lightningcss-light` and `--lightningcss-dark` to implement `light-dark()`,
 *  with values of ` ` and `initial`. Neither contains `var(`, so the contract's
 *  own "is this derived" test says they are literal, and the editor duly
 *  demanded two tokens that do not exist and cannot be given a colour.
 *
 *  It could only ever show up here, which is why the check never caught it: the
 *  check reads index.css as SOURCE, and this reads the BUILT stylesheet through
 *  the CSSOM. Same rule, two inputs, and only one of them has been through a
 *  minifier. */
const IGNORE = /^--lightningcss-/;

/** The DECLARED values of every custom property on `:root`, read from the
 *  stylesheet rather than from computed style.
 *
 *  Declared, not computed, because `requiredTokens()` decides what a theme owes
 *  by asking whether a value contains `var(` - a derived token re-evaluates for
 *  free and must not be asked for. Computed style has already resolved those, so
 *  every token would look literal and the editor would demand sixteen values
 *  nobody should be setting. */
export function baseDeclarations(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    // A cross-origin stylesheet throws on .cssRules. There are none here - the
    // CSP allows only 'self' - but a browser extension can inject one, and an
    // editor that dies because somebody has a userstyle installed is a bad
    // editor.
    try { rules = sheet.cssRules; } catch { continue; }
    for (const raw of Array.from(rules)) {
      const rule = raw as CSSStyleRule;
      if (!rule.selectorText || rule.selectorText.trim() !== ':root') continue;
      for (let i = 0; i < rule.style.length; i++) {
        const prop = rule.style.item(i);
        if (!prop.startsWith('--') || IGNORE.test(prop)) continue;
        out[prop] = rule.style.getPropertyValue(prop).trim();
      }
    }
  }
  return out;
}

/** The tokens a theme must declare, as this build defines them. */
export const requiredNames = (): string[] => requiredTokens(baseDeclarations());

/** What the ACTIVE theme currently paints, for each name. This is what a new
 *  theme starts from - "begin with what you are looking at" needs no
 *  explanation and works for every theme including a user's own, whereas
 *  seeding from a hardcoded palette would silently start you on Bothy Dark
 *  while the screen showed something else. */
export function activeValues(names: readonly string[]): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = cs.getPropertyValue(n).trim();
    if (v) out[n] = v;
  }
  return out;
}

export interface Draft {
  id: string;
  name: string;
  note: string;
  appearance: 'dark' | 'light';
  tokens: Record<string, string>;
}

/** A filename, and therefore a CSS attribute selector, from whatever was typed.
 *
 *  Restrictive on purpose: the id lands inside `[data-bothy-theme='...']` and
 *  inside a URL, so "reject or normalise to something obviously safe" is a much
 *  smaller promise than "escape correctly in three grammars". Everything that is
 *  not a letter, digit or hyphen becomes a hyphen. */
export function slugify(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

// The order the editor shows tokens in, and the only place that order is
// decided. Grouped by what they DO rather than alphabetically, because someone
// picking colours thinks "the surfaces are too light", never "the tokens
// beginning with s are too light".
//
// EVERY REQUIRED TOKEN MUST APPEAR IN EXACTLY ONE GROUP HERE. ThemeEditor.tsx
// renders a field only for tokens a group names, but `requiredNames()` derives
// what a theme owes from the live :root - so a required token in no group is a
// token the editor demands and gives you nowhere to type. It is not a cosmetic
// gap: `evaluateTheme` reports tokens/complete FAIL and RETURNS EARLY, so the
// page shows one failure, none of the other findings, and no field that would
// clear it. The reading scale spent a release in that state before it was
// classified STRUCTURAL, where it belonged.
export const GROUPS: { title: string; note: string; tokens: string[] }[] = [
  {
    title: 'Surfaces',
    note: 'The elevation ladder: the page, then insets, then cards, headers, hovers and popovers. Each step should read as lifted from the one below it.',
    tokens: ['--bg', '--bg-2', '--surface-1', '--surface-2', '--surface-3', '--surface-4', '--bg-glow'],
  },
  {
    title: 'Text',
    note: 'Held at 4.5:1 against every surface they are painted on. --on-accent is text sitting on a filled accent, so it is usually the opposite of --fg.',
    tokens: ['--fg', '--fg-muted', '--fg-subtle', '--on-accent'],
  },
  {
    title: 'Lines',
    note: 'Borders and dividers, as an alpha over the surface rather than a flat colour, so one value works on every step of the ladder.',
    tokens: ['--line', '--line-strong'],
  },
  {
    title: 'Accent',
    note: 'Chrome only - it never means a service is in some state. --accent-fg is the accent used as TEXT and needs more contrast than the fill does.',
    tokens: ['--accent', '--accent-2', '--accent-fg'],
  },
  {
    title: 'Brand',
    note: 'Bothy\'s own mark - the dot in the wordmark, and nothing else. Not chrome and not a status: the accent says "this is interactive", brand says "this is Bothy", so a theme that recolours every control may still want the mark to stay itself.',
    tokens: ['--brand'],
  },
  {
    title: 'Status',
    note: 'RESERVED. These five mean up, starting, down, unknown and stopped, and nothing decorative may share their hue. The -fg half is the text-safe variant.',
    tokens: [
      '--st-up', '--st-up-fg', '--st-warn', '--st-warn-fg', '--st-down', '--st-down-fg',
      '--st-unknown', '--st-unknown-fg', '--st-off', '--st-off-fg',
    ],
  },
  {
    title: 'Panel accents',
    note: 'Five decorative spines. They must stay clearly away from the status hues, or a coloured edge starts reading as an alert.',
    tokens: ['--a1', '--a2', '--a3', '--a4', '--a5'],
  },
  {
    title: 'Charts',
    note: 'Series colours, used in slot order and never reordered. A series colour says "this is the CPU line", never "this is bad".',
    tokens: ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'],
  },
  {
    title: 'Depth',
    note: 'Shadow recipes and the scroll fade. Composite values rather than plain colours, so these are edited as text.',
    tokens: ['--shadow-sm', '--shadow-md', '--shadow-lg', '--scroll-shade', '--hover-opacity'],
  },
];

/** True when a value is a plain `#rrggbb` and can therefore be edited with a
 *  colour well. Everything else - a gradient, an rgba(), a shadow recipe, an
 *  opacity - gets a text field, because a colour input would silently destroy
 *  it by rewriting it as a hex. */
export const isSimpleColour = (v: string): boolean => /^#[0-9a-f]{6}$/i.test(v.trim());

/** The file, generated from the draft. This is what gets written, and it is
 *  deliberately readable: somebody will open it in the editor later, or send it
 *  to a friend, and a minified blob would make both worse. */
export function toCss(d: Draft, order: readonly string[]): string {
  const sel = `[data-bothy-theme='${d.id}'][data-bothy-theme]`;
  const lines: string[] = [
    '/* bothy-theme',
    `   name: ${d.name}`,
    `   appearance: ${d.appearance}`,
    `   note: ${d.note}`,
    '*/',
    '',
    '/* Written by Bothy\'s theme editor. Safe to edit by hand - it is read back',
    '   the same way, and the header above is what names it in the picker.',
    '',
    '   Two selectors: the :root one wins on the page, the bare one lets the',
    '   picker paint this theme\'s swatches while you are looking at another. */',
    `:root${sel},`,
    `${sel} {`,
    `  color-scheme: ${d.appearance};`,
    '',
  ];
  // Grouped in the editor's own order, with the headings, so the file reads the
  // way the form does. A theme file is documentation as much as configuration.
  for (const g of GROUPS) {
    const present = g.tokens.filter((t) => d.tokens[t] != null && order.includes(t));
    if (!present.length) continue;
    lines.push(`  /* ── ${g.title.toLowerCase()} ${'─'.repeat(Math.max(0, 58 - g.title.length))} */`);
    const width = Math.max(...present.map((t) => t.length));
    for (const t of present) lines.push(`  ${t}:${' '.repeat(width - t.length + 1)}${d.tokens[t]};`);
    lines.push('');
  }
  // Anything the groups do not mention, so a token added to the palette later is
  // still written rather than quietly dropped on the next save.
  const known = new Set(GROUPS.flatMap((g) => g.tokens));
  const rest = order.filter((t) => !known.has(t) && d.tokens[t] != null);
  if (rest.length) {
    lines.push('  /* ── other ─────────────────────────────────────────────── */');
    for (const t of rest) lines.push(`  ${t}: ${d.tokens[t]};`);
    lines.push('');
  }
  lines.push('}', '');
  return lines.join('\n');
}

/** Read a theme file back into a draft, for editing one that already exists.
 *
 *  Tolerant by design: this parses files a person wrote by hand, not only files
 *  toCss() produced. It takes the first rule block's custom properties and the
 *  header comment if there is one, and it does not care about formatting. */
export function fromCss(id: string, css: string): Draft {
  const header = css.match(/\/\*\s*bothy-theme([\s\S]*?)\*\//i);
  const fields: Record<string, string> = {};
  if (header) {
    for (const line of header[1].split('\n')) {
      const kv = line.match(/^\s*([a-z-]+)\s*:\s*(.+?)\s*$/i);
      if (kv) fields[kv[1].toLowerCase()] = kv[2];
    }
  }
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) tokens[m[1]] = m[2].trim();

  const declared = fields.appearance?.toLowerCase();
  const scheme = body.match(/color-scheme\s*:\s*(dark|light)/i)?.[1].toLowerCase();
  return {
    id,
    name: fields.name || id,
    note: fields.note || '',
    appearance: (declared === 'light' || declared === 'dark' ? declared
      : scheme === 'light' ? 'light' : 'dark') as 'dark' | 'light',
    tokens,
  };
}
