import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKS, cameraAt, progressAt, stageAt } from './camera.ts';

test('the camera starts neutral and every curve is continuous', () => {
  const c0 = cameraAt(0);
  assert.deepEqual([c0.pan, c0.cross, c0.rise, c0.sea], [0, 0, 0, 0]);
  assert.equal(c0.zoom, 1);
  assert.equal(c0.glow, 1);
  let prev = cameraAt(0);
  for (let i = 1; i <= 1000; i++) {
    const c = cameraAt(i / 1000);
    for (const k of Object.keys(c) as (keyof typeof c)[])
      assert.ok(Math.abs(c[k] - prev[k]) < 0.02, `${k} jumps at ${i}`);
    prev = c;
  }
});

test('stages follow the story in order', () => {
  assert.equal(stageAt(0), 'clear height');
  assert.equal(stageAt(0.2), 'cloud layer');
  assert.equal(stageAt(0.4), 'sea of cloud');
  assert.equal(stageAt(0.6), 'horizon glow');
  assert.equal(stageAt(0.8), 'warm light');
  assert.equal(stageAt(1), 'low sun');
});

test('scroll maps to progress through the chapter tops and ends at 1', () => {
  const tops = [0, 900, 1800, 2700, 3800, 5200, 6500];
  assert.equal(progressAt(0, tops, 7500), 0);
  assert.equal(progressAt(900, tops, 7500), MARKS[1]);
  assert.equal(progressAt(7500, tops, 7500), 1);
  assert.equal(progressAt(-20, tops, 7500), 0);
  let prev = 0;
  for (let y = 0; y <= 7500; y += 50) {
    const p = progressAt(y, tops, 7500);
    assert.ok(p >= prev - 1e-9);
    prev = p;
  }
  assert.equal(progressAt(100, [], 0), 0);
});
