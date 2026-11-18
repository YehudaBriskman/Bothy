/**
 * Text and background pairs in the console frame, held to WCAG 2.2 AA (4.5:1 for text, 3:1 for large text and UI
 * lines), offline: no browser, no sky. Two worlds, kept apart as in the rest of the frame:
 *
 *   the frame's own chrome (src/console/frame.css, `--cf-*`): tab labels, badge, the step captions, the sign-in,
 *   discover, detail, health and modules scenes of the demo. The glass bezel sits on the sky, so its tint is blended
 *   over BOTH extremes (pure white and pure black sky) and the text must pass on both.
 *   the console's tokens (generated console.css, `.console-frame`): the product's own palette, pairs of text token on
 *   surface token, as the product draws them.
 *
 * Add a pair here when you add a piece of text to the frame; a pair that fails is a bug in the colours, not the test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const frameCss = readFileSync(join(site, 'src/console/frame.css'), 'utf8');
const consoleCss = readFileSync(join(site, 'src/styles/console.css'), 'utf8');

type RGB = [number, number, number];

const hex = (h: string): RGB => {
  const s = h.replace('#', '');
  const f = s.length === 3 ? [...s].map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => Number.parseInt(f.slice(i, i + 2), 16)) as RGB;
};
const lum = ([r, g, b]: RGB) => {
  const c = [r, g, b].map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: RGB, b: RGB) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
const over = (fg: RGB, alpha: number, bg: RGB): RGB => fg.map((v, i) => v * alpha + bg[i]! * (1 - alpha)) as RGB;

/** `--name: #hex;` declarations in the CSS between a selector's `{` and its `}`. */
function tokens(css: string, selector: string, must: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(new RegExp(`^${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'gm'))) {
    if (!m[1]!.includes(must)) continue;
    for (const d of m[1]!.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{3,8})\s*;/gi)) out[d[1]!] = d[2]!;
  }
  return out;
}

const cf = tokens(frameCss, '.cf', '--cf-ink:');
const cfDemo = tokens(frameCss, '.cf', '--cf-win:');
const t = { ...cf, ...cfDemo };
const col = (name: string): RGB => {
  assert.ok(t[name], `frame token ${name} is not a plain hex colour in frame.css`);
  return hex(t[name]!);
};

function check(label: string, fg: RGB, bg: RGB, min: number) {
  const r = ratio(fg, bg);
  assert.ok(r >= min, `${label}: ${r.toFixed(2)}:1, needs ${min}:1`);
}

test('frame chrome: text on the glass bezel passes on a white and a black sky', () => {
  const m = /--cf-glass:\s*rgb\(var\(--glass-rgb,\s*([\d ]+)\)\s*\/\s*(\d+)%\)/.exec(frameCss);
  assert.ok(m, 'the --cf-glass tint is not in the form rgb(var(--glass-rgb, R G B) / N%)');
  const tint = m[1]!.trim().split(/\s+/).map(Number) as RGB;
  const alpha = Number(m[2]) / 100;
  // the lightest tint the engine can set (--glass-rgb is at most 0.16 * 255 + 5 per channel)
  const lightest: RGB = [46, 46, 46];
  for (const sky of [
    [255, 255, 255],
    [0, 0, 0],
  ] as RGB[])
    for (const g of [tint, lightest]) {
      // the sheen gradient adds up to 10% white on top
      const bezel = over([255, 255, 255], 0.1, over(g, alpha, sky));
      const where = `bezel ${bezel.map(Math.round)} over sky ${sky[0]}`;
      check(`tab label (--cf-ink) on ${where}`, col('--cf-ink'), bezel, 4.5);
      check(`badge and tab hover (--cf-ink) on ${where}`, col('--cf-ink'), bezel, 4.5);
      check(`selected tab (--cf-tab-on-fg) on ${where}`, col('--cf-tab-on-fg'), over([0, 0, 0], 0.3, bezel), 4.5);
    }
});

test('frame chrome: the step captions and indicator on their solid card', () => {
  const card = col('--cf-card');
  check('caption text (--cf-ink)', col('--cf-ink'), card, 4.5);
  check('step text (--cf-ink-muted)', col('--cf-ink-muted'), card, 4.5);
  check('step label (white)', [255, 255, 255], card, 4.5);
  // the indicator's bar is a 3px graphic: 3:1 for the state it carries
  check('indicator, current beat (white bar)', [255, 255, 255], card, 3);
  check('indicator, done beats (62% ink bar)', over(col('--cf-ink'), 0.62, card), card, 3);
});

test('demo scenes: text on the dark window and its cards', () => {
  const win = col('--cf-win');
  const win2 = col('--cf-win-2');
  for (const [name, bg] of [
    ['window', win],
    ['card', win2],
  ] as const) {
    check(`ink on ${name}`, col('--cf-win-ink'), bg, 4.5);
    check(`muted on ${name}`, col('--cf-win-muted'), bg, 4.5);
    check(`ok green on ${name}`, col('--cf-ok'), bg, 4.5);
  }
  check('sign-in button text on its fill', hex('#0f1217'), hex('#e8ebf0'), 4.5);
  check('sweep and sparkline (graphics) on the window', col('--cf-ok'), win, 3);
});

test("console tokens: the product's own text colours on its own surfaces", () => {
  const k = tokens(consoleCss, '.console-frame', '--bg:');
  const get = (n: string) => {
    assert.ok(k[n], `console token ${n} is not a plain hex colour`);
    return hex(k[n]!);
  };
  const surfaces = ['--bg', '--bg-2', '--surface-1', '--surface-2', '--surface-3'];
  const texts = [
    '--fg',
    '--fg-muted',
    '--fg-subtle',
    '--accent-fg',
    '--st-up-fg',
    '--st-warn-fg',
    '--st-down-fg',
    '--st-unknown-fg',
    '--st-off-fg',
  ];
  for (const s of surfaces) for (const f of texts) check(`${f} on ${s}`, get(f), get(s), 4.5);
});
