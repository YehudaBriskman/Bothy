// The theme contract: the rules a palette must satisfy, and the colour maths
// they are stated in.
//
// THIS MODULE IMPORTS NOTHING, on the lib/discover.ts and lib/config.ts pattern
// and for the same reason - a module with no imports is one that can be compiled
// and exercised on its own. Here that is not a convenience, it is the whole
// point: checks/run.sh compiles this file in isolation so checks/theme-contract.mjs
// can import it under node, and the custom-theme editor imports it in the
// browser. TWO CONSUMERS, ONE SET OF RULES. A rule that lives in the check and a
// rule that lives in the editor drift apart, and the drift is invisible - the
// editor says a colour is fine, the check says it is not, and whichever one you
// happened to run is the answer you believe.
//
// The numbers below are not preferences. index.css records the measurements, the
// bands, the orderings and the two historical bugs that produced them; this is
// that prose turned into something that can be executed.
//
// What is NOT here: reading files, parsing stylesheets, discovering themes. That
// stays in checks/theme-contract.mjs, because it is node's job and the browser
// has no stylesheet to read - it has a token map the user is editing.

// ── colour ──────────────────────────────────────────────────────────────────

export type RGBA = { r: number; g: number; b: number; a: number };
export type OKLCH = { L: number; C: number; H: number };

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Parse the value forms that actually appear in these files: #rgb, #rrggbb,
 *  #rrggbbaa, rgb()/rgba() in both comma and space syntax. Returns
 *  {r,g,b,a} in 0..1, or null for anything else (a var(), a gradient, a
 *  shadow recipe) - callers decide whether "not a flat colour" is a failure. */
export function parseColour(v: string): RGBA | null {
  const s = String(v).trim();
  const hex = s.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  const fn = s.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const parts = fn[1].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (p: string) => (p.endsWith('%') ? parseFloat(p) / 100 * 255 : parseFloat(p));
    const alpha = (p: string | undefined) =>
      (p == null ? 1 : p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p));
    const [r, g, b] = parts.slice(0, 3).map(num);
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r: r / 255, g: g / 255, b: b / 255, a: alpha(parts[3]) };
  }
  return null;
}

/** Flatten a translucent colour onto an opaque one. --line and the shadow
 *  recipes are alpha over a surface, and comparing them un-composited would
 *  measure a colour that is never on screen. */
export const over = (fg: RGBA, bg: RGBA): RGBA => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});

export const luminance = (c: RGBA) =>
  0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);

export function contrast(a: RGBA, b: RGBA) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Contrast of a foreground on a ground, compositing first when the foreground
 *  is translucent. Every ratio in the contract is measured this way. */
export const contrastOn = (fg: RGBA, bg: RGBA) => contrast(fg.a < 1 ? over(fg, bg) : fg, bg);

/** sRGB → OKLCH. The accent-legality rule is stated in OKLCH (hue degrees and
 *  chroma), and index.css records every accent's coordinates in a comment, so
 *  this is the space the contract is written in. */
export function oklch(c: RGBA): OKLCH {
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
export const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

// ── the rules ───────────────────────────────────────────────────────────────

export type Appearance = 'dark' | 'light';

export const STATUSES = ['up', 'warn', 'down', 'unknown', 'off'];
export const ACCENTS = ['--a1', '--a2', '--a3', '--a4', '--a5'];
export const CHARTS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'];

// Written into index.css as measurements, reproduced here as thresholds.
export const AA = 4.5;              // text
export const ACCENT_ON_SURFACE = 4.6; // --a1..--a5 are painted as 12px bold text
export const CHART_VS_CARD = 3.0;
export const CHROMATIC_C = 0.06;    // a status at or above this is "chromatic"
export const HUE_SEPARATION = 45;   // degrees, against a chromatic status
export const CHROMA_MARGIN = 0.06;  // against a near-grey status
export const BAND: Record<Appearance, [number, number]> = {
  dark: [0.48, 0.67],
  light: [0.43, 0.77],
};

// Three light-mode status FILLS sit below 3:1 on purpose: they are large solid
// areas beside a track, never small glyphs or 1px borders, and status is never
// encoded by colour alone. Recorded as an allowance WITH its reason so that a
// new theme cannot quietly widen it - the allowance is per token, not a blanket
// "fills are exempt".
export const FILL_ALLOWANCE: Record<string, string> = {
  '--st-up': 'large filled area beside a track; the -fg half carries any text',
  '--st-unknown': 'as --st-up',
  '--st-off': 'as --st-up, and deliberately the quietest thing on the page',
};

// Not colour, and shared by every theme - radii, motion, fonts, widths. A theme
// that omits these is not incomplete, it is just not restyling the furniture.
export const STRUCTURAL = new Set([
  '--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-full', '--border-w', '--wrap',
  '--scrollbar-w', '--dur-fast', '--dur', '--dur-slow', '--ease', '--font', '--mono',
  '--disabled-opacity', '--rest-opacity',
  // The reading scale. index.css says out loud that these are STRUCTURAL - "a
  // theme inherits these unless it opts in - the same treatment radii and motion
  // get" - and this list did not agree, so all eight were being demanded of every
  // theme as if they were colours. Nobody saw it because none of the three
  // shipped themes declares one and the check merged the base palette in before
  // asking (see checks/theme-contract.mjs). They are lengths and a ratio: a
  // colour rule cannot measure them and the editor cannot offer a swatch for
  // them, so "required" was never the right answer.
  '--read-measure', '--read-fs', '--read-lh', '--read-gap',
  '--read-h1', '--read-h2', '--read-h3', '--read-h4',
]);

/** What a theme owes, derived from the base palette rather than listed: every
 *  literal token in :root that is neither DERIVED (a color-mix over another
 *  token, on the same element, so it re-evaluates for free) nor STRUCTURAL.
 *
 *  Derived by reading rather than by a hand-maintained list, because the failure
 *  mode of a list is silence: a missing token inherits the base palette, which
 *  is how you get a Gruvbox page with one blue button on it. */
export function requiredTokens(base: Record<string, string>): string[] {
  return Object.keys(base)
    .filter((k) => !base[k].includes('var(') && !STRUCTURAL.has(k))
    .sort();
}

// ── the verdict ─────────────────────────────────────────────────────────────

// 'pass' and 'fail' are the two answers; 'allow' is a fill that is below the
// floor and permitted anyway, carrying the reason with it. It is reported rather
// than suppressed for the same reason FILL_ALLOWANCE has prose in it: an
// exemption nobody can see is an exemption nobody can argue with.
export type FindingLevel = 'pass' | 'fail' | 'allow';

/** One assertion, rendered as a PASS/FAIL line by the check and as a row by the
 *  editor. `id` is stable and machine-readable so a UI can key off it and point
 *  at the swatch that is wrong; `label` states the rule, `detail` the measured
 *  value - which is the part worth reading even when it passes. */
export type Finding = {
  id: string;
  level: FindingLevel;
  label: string;
  detail: string;
};

export type EvaluateOptions = {
  /** The tokens this theme must declare - `requiredTokens(base)` from whoever
   *  holds the base palette. Omitted, completeness is simply not asserted: a
   *  caller that does not know the base palette cannot honestly check it. */
  required?: readonly string[];
  /** What the theme's own file DECLARES, when that is not the same map as the
   *  one being measured.
   *
   *  The two are different questions and conflating them made the completeness
   *  rule vacuous. checks/theme-contract.mjs measures `merge(BASE, theme)`, and
   *  it is right to: that models what is actually painted after inheritance, and
   *  measuring a theme's contrast against tokens it does not paint would be
   *  measuring a page nobody sees. But `required` is by construction a subset of
   *  the base palette's own keys, so after that merge every required key is
   *  present by definition - the assertion could only ever fail in the editor,
   *  and a theme file could drop a token and stay green forever. That is the
   *  exact silence #98's "a rule so a new theme cannot forget it" is about.
   *
   *  So: measure the merged map, assert declaration against this one. Omitted,
   *  the two collapse back into `tokens`, which is what the editor wants - there
   *  the map being edited IS the file. */
  declared?: Record<string, string>;
  /** The theme's syntax palette (--hl-*), when it carries one. Optional as a
   *  GROUP - a theme may restyle no code at all - but see `syntaxBase` for why
   *  it is not optional token by token. */
  syntax?: Record<string, string> | null;
  /** The syntax palette the theme inherits when it declares none: shell.css's
   *  set for this appearance. Supplied so completeness can be asserted against
   *  what actually exists rather than against a list written out here, which
   *  would drift the first time shell.css gained a token and go quiet.
   *
   *  Omitted, the all-or-nothing rule is simply not applied - the same honesty
   *  `required` uses: a caller that does not know the base cannot check it. */
  syntaxBase?: Record<string, string> | null;
};

/** Every token whose value the rules below actually measure. Parsed up front so
 *  that a value which is not a flat colour is reported as such - in the check it
 *  cannot happen (index.css supplies a literal for all of them), but the editor
 *  is fed whatever the user has typed so far, and a crash there is not a review. */
const MEASURED = [
  '--surface-1', '--surface-2', '--bg-2',
  // --bg-glow carries no contrast rule; it is here so that a value which is
  // not a flat colour is REPORTED. index.css builds the page wash with
  // `radial-gradient(... var(--bg-glow) 0%, ...)`, so a gradient in this token
  // nests one gradient inside another's colour stop - invalid, silently
  // dropped, and the wash disappears with no error anywhere. Five ported
  // themes shipped with exactly that before this line existed.
  '--bg-glow',
  '--fg', '--fg-muted', '--fg-subtle',
  '--accent', '--accent-fg', '--on-accent',
  ...STATUSES.map((s) => `--st-${s}`),
  ...STATUSES.map((s) => `--st-${s}-fg`),
  ...ACCENTS,
  ...CHARTS,
];

/** Run the whole contract over one theme's tokens. The findings come back in
 *  the order they are asserted, which is the order the check prints them. */
export function evaluateTheme(
  tokens: Record<string, string>,
  appearance: Appearance,
  options: EvaluateOptions = {},
): Finding[] {
  const out: Finding[] = [];
  const say = (id: string, ok: boolean, label: string, detail = '') => {
    out.push({ id, level: ok ? 'pass' : 'fail', label, detail });
  };

  // 1. completeness - asserted against what the theme DECLARES, which is not
  //    always the map the rules below measure. See `declared` above.
  if (options.required) {
    const declared = options.declared ?? tokens;
    const missing = options.required.filter((k) => !(k in declared));
    say('tokens/complete', !missing.length, 'declares every required token',
      missing.length
        ? `missing ${missing.length}: ${missing.slice(0, 6).join(' ')}`
        : `${options.required.length} tokens`);
    // Bail only when the value is genuinely absent from what gets measured.
    // Half-measuring is worse than saying so - but an UNDECLARED token that
    // inherits a real value can still be measured, and reporting one failure and
    // hiding twenty findings behind it is how a completeness bug turns into a
    // blank review page.
    if (missing.some((k) => !(k in tokens))) return out;
  }

  // Nothing below can be measured on a value that is not a colour, and half-
  // measuring is worse than saying so.
  const parsed: Record<string, RGBA> = {};
  const unparsed: string[] = [];
  for (const k of MEASURED) {
    const p = parseColour(tokens[k]);
    if (p) parsed[k] = p; else unparsed.push(k);
  }
  if (unparsed.length) {
    for (const k of unparsed) {
      say(`value/${k}`, false, `${k} is a flat colour the contract can measure`,
        tokens[k] ?? '(missing)');
    }
    return out;
  }

  const C = (k: string) => parsed[k];
  const s1 = C('--surface-1'), s2 = C('--surface-2'), bg2 = C('--bg-2');
  const on = contrastOn;

  // A foreground is measured against every ground it is PAINTED on, not against
  // one canonical background. That distinction is not pedantry: the first thing
  // this check found was that the two quietest status foregrounds had been
  // measured on a card while being used mostly in the file explorer and the
  // reader's index, both of which sit on --bg-2 - a darker ground, so the real
  // ratios were ~0.35 lower than the ones written into index.css, and below AA.
  const GROUNDS: [string, RGBA][] = [['surface-1', s1], ['surface-2', s2], ['bg-2', bg2]];
  const worst = (fg: RGBA) => GROUNDS.reduce(
    (acc, [n, g]) => { const v = on(fg, g); return v < acc.v ? { n, v } : acc; },
    { n: '', v: Infinity },
  );

  // 2. foreground contrast
  for (const k of ['--fg', '--fg-muted', '--fg-subtle']) {
    const w = worst(C(k));
    say(`contrast/${k}`, w.v >= AA, `${k} >= ${AA}:1 on every ground it is painted on`,
      `worst ${w.v.toFixed(2)} on ${w.n}`);
  }
  {
    const a = on(C('--accent-fg'), s1);
    say('contrast/--accent-fg', a >= AA, `--accent-fg >= ${AA}:1 on surface-1`, a.toFixed(2));
    const o = on(C('--on-accent'), C('--accent'));
    say('contrast/--on-accent', o >= 3.0, '--on-accent >= 3:1 on --accent (button text)',
      o.toFixed(2));
  }

  // 3. status: -fg is the text-safe half, the fill is not asserted where the
  //    palette says out loud that it is a large area.
  for (const s of STATUSES) {
    const w = worst(C(`--st-${s}-fg`));
    say(`contrast/--st-${s}-fg`, w.v >= AA,
      `--st-${s}-fg >= ${AA}:1 on every ground it is painted on`,
      `worst ${w.v.toFixed(2)} on ${w.n}`);
  }
  for (const s of STATUSES) {
    const key = `--st-${s}`;
    const v = on(C(key), s1);
    if (key in FILL_ALLOWANCE) {
      out.push({
        id: `fill/${key}`,
        level: 'allow',
        label: `${key} fill at ${v.toFixed(2)}:1`,
        detail: FILL_ALLOWANCE[key],
      });
    } else {
      say(`fill/${key}`, v >= CHART_VS_CARD, `${key} fill >= 3:1 on surface-1`, v.toFixed(2));
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
    say('order/light-status-weight', ok,
      'light status weight runs down > warn > up > unknown > stopped',
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
    say(`accent/${k}`, !bad.length, `${k} is legal against every status`,
      bad.length ? bad.join('; ') : `L ${a.L.toFixed(2)} C ${a.C.toFixed(3)} H ${a.H.toFixed(0)}°`);
  }
  for (const k of ACCENTS) {
    const v = on(C(k), s2);
    say(`contrast/${k}`, v >= ACCENT_ON_SURFACE,
      `${k} >= ${ACCENT_ON_SURFACE}:1 on surface-2 (12px bold text)`, v.toFixed(2));
  }

  // 6. charts - band, and separation against the card. Slot ORDER is part of
  //    what was validated upstream, so the check reads them in order and never
  //    sorts them.
  const [lo, hi] = BAND[appearance];
  for (const k of CHARTS) {
    const c = oklch(C(k));
    say(`band/${k}`, c.L >= lo && c.L <= hi,
      `${k} inside the ${appearance} lightness band ${lo}-${hi}`, `L ${c.L.toFixed(3)}`);
  }
  for (const k of CHARTS) {
    const v = on(C(k), s1);
    say(`contrast/${k}-vs-card`, v >= CHART_VS_CARD, `${k} >= 3:1 on surface-1`, v.toFixed(2));
  }

  // 7. the syntax palette, when the theme carries one
  //
  // ALL OR NOTHING, and the reason is not tidiness. A theme declaring no
  // --hl-* is fine: code renders in shell.css's set, which was chosen for this
  // appearance. A theme declaring FOUR of the five is the bad case, because the
  // fifth silently comes from that other palette - so the reader gets four
  // colours picked to sit together and one picked to sit with something else,
  // against a background neither was measured on.
  //
  // It is not hypothetical: a mutation renaming `--hl-kw` in tokyo-night.css
  // passed every check this function had, which is how the rule got written.
  // scripts/checks/mutants.sh plants that exact mutation and requires a failure.
  const hl = options.syntax;
  if (hl && Object.keys(hl).length) {
    const base = options.syntaxBase;
    if (base) {
      for (const k of Object.keys(base)) {
        say(`syntax/${k}-declared`, k in hl,
          `a theme that restyles code must declare ${k}`,
          k in hl ? '' : 'missing - it would inherit a colour chosen for another palette');
      }
    }
    for (const [k, v] of Object.entries(hl)) {
      const c = parseColour(v);
      if (!c) continue; // --hl-com is var(--fg-subtle); already checked above
      const a = contrast(c, bg2);
      say(`syntax/${k}`, a >= AA, `${k} >= ${AA}:1 on --bg-2`, a.toFixed(2));
    }
  }

  return out;
}
