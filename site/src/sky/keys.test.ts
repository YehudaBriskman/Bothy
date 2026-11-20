// The hour table the live sky grades by: daylight only, dawn to sunset, clamped at both ends (there is no night sky).
// Pure data, so a node test holds it: continuity at every key, the photograph mix summing to one, the clamp, and every
// key naming an hour class that styles/sky-still.css actually defines (so the still and the live sky agree).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DAY_END, DAY_START, KEYS, bodies, daylight, fmt, sample, wrapHour } from './keys.ts';

const close = (a: number[], b: number[], eps: number) => a.every((x, i) => Math.abs(x - b[i]!) <= eps);
const luma = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

test('the table is continuous across every key', () => {
  for (const k of KEYS) {
    const a = sample(k.h - 0.01);
    const b = sample(k.h + 0.01);
    assert.ok(close(a.w, b.w, 0.03), `mix near ${k.h}`);
    assert.ok(close(a.gain, b.gain, 0.03), `gain near ${k.h}`);
  }
  assert.equal(wrapHour(25), 1);
  assert.equal(wrapHour(-1), 23);
});

test('the sky is clamped to daylight: before dawn is dawn, after sunset is sunset, never dark', () => {
  for (const h of [0, 1, 3, 5, 6, DAY_START]) assert.deepEqual(sample(h).top, sample(DAY_START).top, `at ${h}`);
  for (const h of [DAY_END, 19, 20.5, 22, 23.99]) assert.deepEqual(sample(h).top, sample(DAY_END).top, `at ${h}`);
  assert.equal(daylight(3), DAY_START);
  assert.equal(daylight(23), DAY_END);
  assert.equal(sample(2).name, 'dawn');
  assert.equal(sample(22).name, 'sunset');
  // light and warm at every hour of the clock: only the day and dusk photographs, and a sky that stays bright
  for (let h = 0; h < 24; h += 0.25) {
    const g = sample(h);
    assert.equal(g.w.length, 2, 'only the day and dusk photographs');
    assert.ok(luma(g.bot) >= 110, `bottom of the sky at ${h}`);
    assert.ok(luma(g.top) >= 70, `top of the sky at ${h}`);
    assert.ok(g.exp >= 0.7, `exposure at ${h}`);
  }
});

test('every hour mixes the two photographs to exactly one', () => {
  for (let h = 0; h < 24; h += 0.25) {
    const w = sample(h).w;
    assert.ok(Math.abs(w[0]! + w[1]! - 1) < 1e-9, `mix at ${h}`);
  }
});

test('every key is a hour class of the CSS still, and none is a night class', () => {
  const css = readFileSync(fileURLToPath(new URL('../styles/sky-still.css', import.meta.url)), 'utf8');
  for (const k of KEYS) assert.ok(css.includes(`[data-hour='${k.n}']`), `${k.n} has no CSS hour class`);
  for (const n of ['night', 'predawn', 'dusk', 'twilight']) assert.ok(!css.includes(`[data-hour='${n}']`), n);
  assert.ok(!css.includes('night-desk') && !css.includes('night-phone'));
});

test('the sun rises and sets on its arc, and the clock formats', () => {
  assert.ok(bodies(12).sun.elev > 0.9);
  // outside daylight the sun sits at its nearest end of the arc, low and visible, never below the horizon
  for (const h of [0, 3, 22, 23.5]) assert.ok(bodies(h).sun.elev >= 0, `sun at ${h}`);
  assert.ok(bodies(3).sun.x < 0.2 && bodies(22).sun.x > 0.8);
  assert.equal(fmt(18.5), '18:30');
  assert.equal(fmt(24), '00:00');
});
