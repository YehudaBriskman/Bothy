// The hour table the live sky grades by, ported from the owner-approved spike. Pure data, so a node test holds it:
// continuity (17:59 looks like 18:01, 23:59 like 00:01), the photograph mix summing to one, and every key naming a
// hour class that styles/sky-still.css actually defines (so the still and the live sky agree).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KEYS, bodies, fmt, sample, wrapHour } from './keys.ts';

const close = (a: number[], b: number[], eps: number) => a.every((x, i) => Math.abs(x - b[i]!) <= eps);

test('the table wraps and is continuous across midnight and across every key', () => {
  for (const h of [0, 4.25, 6.4, 12, 18.7, 22.2]) {
    const a = sample(h - 0.01);
    const b = sample(h + 0.01);
    assert.ok(close(a.w, b.w, 0.03), `mix near ${h}`);
    assert.ok(close(a.gain, b.gain, 0.03), `gain near ${h}`);
  }
  assert.ok(close(sample(23.999).top, sample(0.001).top, 0.5));
  assert.equal(wrapHour(25), 1);
  assert.equal(wrapHour(-1), 23);
});

test('every hour mixes the three photographs to exactly one', () => {
  for (let h = 0; h < 24; h += 0.25) {
    const w = sample(h).w;
    assert.ok(Math.abs(w[0]! + w[1]! + w[2]! - 1) < 1e-9, `mix at ${h}`);
  }
});

test('every key is a hour class of the CSS still', () => {
  const css = readFileSync(fileURLToPath(new URL('../styles/sky-still.css', import.meta.url)), 'utf8');
  for (const k of KEYS) assert.ok(css.includes(`[data-hour='${k.n}']`), `${k.n} has no CSS hour class`);
});

test('sun, moon and the clock format behave', () => {
  assert.ok(bodies(12).sun.elev > 0.9);
  assert.ok(bodies(0).sun.elev < 0);
  assert.ok(bodies(0).moon.elev > 0.9 || bodies(1).moon.elev > 0);
  assert.equal(fmt(18.5), '18:30');
  assert.equal(fmt(24), '00:00');
});
