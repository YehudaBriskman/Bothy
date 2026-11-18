// Reference values for the maths in scripts/check-sky.mjs. The numbers are the published ones: WCAG 2.2 black on white
// 21:1 and #767676 on white 4.54:1 (the well-known AA grey); APCA black on white Lc 106.04, white on black Lc -107.88
// (SAPC 0.0.98G-4g, the values the APCA reference implementation prints).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FAST_HOURS,
  FLOORS,
  FULL_HOURS,
  apcaLc,
  apcaLuminance,
  tails,
  wcagLuminance,
  wcagRatio,
  worstCase,
} from '../../scripts/check-sky.mjs';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} is not within ${eps} of ${b}`);

test('WCAG luminance and ratio', () => {
  assert.equal(wcagLuminance([0, 0, 0]), 0);
  near(wcagLuminance([255, 255, 255]), 1, 1e-9);
  near(wcagRatio([0, 0, 0], [255, 255, 255]), 21, 1e-9);
  near(wcagRatio([255, 255, 255], [0, 0, 0]), 21, 1e-9, 'symmetric');
  near(wcagRatio([118, 118, 118], [255, 255, 255]), 4.54, 0.005);
  near(wcagRatio([119, 119, 119], [255, 255, 255]), 4.48, 0.005);
  near(wcagRatio([255, 0, 0], [255, 255, 255]), 3.998, 0.005);
  assert.equal(wcagRatio([10, 20, 30], [10, 20, 30]), 1);
});

test('APCA Lc on the reference pairs', () => {
  const bw = apcaLc(apcaLuminance([0, 0, 0]), apcaLuminance([255, 255, 255]));
  const wb = apcaLc(apcaLuminance([255, 255, 255]), apcaLuminance([0, 0, 0]));
  near(bw, 106.04, 0.05, 'black on white');
  near(wb, -107.88, 0.05, 'white on black');
  assert.equal(apcaLc(0.5, 0.5), 0);
  // a pair too close to read is clamped to zero, not a small number
  assert.equal(apcaLc(apcaLuminance([128, 128, 128]), apcaLuminance([130, 130, 130])), 0);
  // polarity: dark on light is positive, light on dark negative
  assert.ok(apcaLc(apcaLuminance([60, 60, 60]), apcaLuminance([230, 230, 230])) > 0);
  assert.ok(apcaLc(apcaLuminance([230, 230, 230]), apcaLuminance([60, 60, 60])) < 0);
});

test('tails are the means of the darkest and the brightest 5 percent', () => {
  const v = Array.from({ length: 100 }, (_, i) => i / 99);
  const t = tails(v, 0.05);
  near(t.dark, (0 + 1 + 2 + 3 + 4) / 5 / 99, 1e-12);
  near(t.light, (99 + 98 + 97 + 96 + 95) / 5 / 99, 1e-12);
  assert.deepEqual(tails([0.3]), { dark: 0.3, light: 0.3 });
});

test('worstCase takes the worse ink and the worse tail', () => {
  const ink = [247, 245, 239];
  const dark = [10, 12, 20];
  // a backdrop that is mostly dark with a bright 10 percent: the light tail is what fails
  const px = [...Array(90).fill(dark), ...Array(10).fill([240, 240, 240])];
  const w = worstCase([ink], px.map(wcagLuminance), px.map(apcaLuminance));
  near(w.wcag, wcagRatio(ink, [240, 240, 240]), 0.01);
  assert.ok(w.wcag < 1.2 && w.lc < 5);
  // the darker of two inks (the far side of a lit gradient) is the worse one on a light backdrop
  const light = Array(50).fill([200, 200, 200]);
  const two = worstCase([ink, [212, 216, 217]], light.map(wcagLuminance), light.map(apcaLuminance));
  const one = worstCase([[212, 216, 217]], light.map(wcagLuminance), light.map(apcaLuminance));
  assert.equal(two.wcag, one.wcag);
});

test('floors and hour sets', () => {
  assert.deepEqual(FLOORS, { large: { wcag: 3, lc: 45 }, body: { wcag: 4.5, lc: 60 } });
  assert.equal(FULL_HOURS.length, 48);
  assert.equal(FULL_HOURS[1], 0.5);
  assert.equal(FULL_HOURS[47], 23.5);
  assert.equal(FAST_HOURS.length, 8);
});
