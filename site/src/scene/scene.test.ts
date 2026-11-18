// The hills scene (S6): deterministic markup, the mock's copies in step with the source, a byte budget, no outside
// origin, and a window that is dim by day and lit by night. Run with the rest of `npm test`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..', '..');
const read = (p: string) => readFileSync(join(site, p), 'utf8');

type Sample = Record<string, number | number[] | string>;
const core = (await import(pathToFileURL(join(here, 'scene-core.js')).href)) as {
  sceneMarkup: () => string;
  sceneVars: (s: Sample) => Record<string, string>;
  windowGlow: (s: Sample) => number;
  ridgeY: (layer: number, x: number) => number;
  LAYERS: unknown[];
  VIEW_H: number;
};
const keys = (await import(pathToFileURL(join(site, 'public', 'sky-spike', 'sky-keys.js')).href)) as {
  sample: (h: number) => Sample;
};

test('the markup is deterministic and has four ridges, three mist bands, one window', () => {
  const a = core.sceneMarkup();
  assert.equal(a, core.sceneMarkup());
  assert.equal((a.match(/class="scene-ridge /g) ?? []).length, 4);
  assert.equal((a.match(/class="scene-mist /g) ?? []).length, 3);
  assert.equal((a.match(/class="scene-glass"/g) ?? []).length, 1);
  assert.doesNotMatch(a, /https?:\/\//);
  assert.doesNotMatch(a, /<image|<script|data:/);
});

test('vector only and small: the whole scene is under 40 KB raw and 14 KB gzipped', () => {
  const m = Buffer.from(core.sceneMarkup());
  assert.ok(m.length < 40 * 1024, `${m.length} bytes`);
  assert.ok(gzipSync(m).length < 14 * 1024, `${gzipSync(m).length} bytes gzipped`);
});

test('ridges stay on the canvas and each is nearer (lower) than the one behind at the hut', () => {
  for (let l = 0; l < core.LAYERS.length; l++) {
    for (let x = -80; x <= 1680; x += 40) {
      const y = core.ridgeY(l, x);
      assert.ok(y > 120 && y < core.VIEW_H, `layer ${l} x ${x} y ${y}`);
    }
  }
  for (let l = 1; l < core.LAYERS.length; l++) assert.ok(core.ridgeY(l, 905) > core.ridgeY(l - 1, 905));
});

test('the window is a hint by day, lit by dusk, full at night', () => {
  const g = (h: number) => core.windowGlow(keys.sample(h));
  assert.ok(g(12) < 0.15, `noon ${g(12)}`);
  assert.ok(g(19.7) > 0.5, `dusk ${g(19.7)}`);
  assert.ok(g(23) > 0.95, `night ${g(23)}`);
  assert.ok(g(12) > 0, 'a hint remains by day');
});

test('every hour yields every colour variable the stylesheet reads, and farther ridges are paler', () => {
  const css = read('src/styles/scene.css');
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  for (let h = 0; h < 24; h += 0.5) {
    const v = core.sceneVars(keys.sample(h));
    for (const name of used)
      if (!/^--(px|py|par|dur|delay)$/.test(name as string)) assert.ok(name! in v, `${name} at ${h}`);
    const lum = (c: string) => (c.match(/\d+/g) ?? []).map(Number).reduce((a, b) => a + b, 0);
    if (h >= 8 && h <= 17)
      for (let i = 1; i < 4; i++) assert.ok(lum(v[`--c${i}`]!) < lum(v[`--c${i - 1}`]!), `layer ${i} at ${h}`);
  }
});

test('the mock page serves byte-identical copies of the source and is noindex', () => {
  assert.equal(read('public/scene-mock/scene-core.js'), read('src/scene/scene-core.js'));
  assert.equal(read('public/scene-mock/scene.css'), read('src/styles/scene.css'));
  assert.match(read('public/scene-mock/index.html'), /<meta name="robots" content="noindex, nofollow"/);
  assert.doesNotMatch(read('public/scene-mock/index.html') + read('public/scene-mock/mock.js'), /https?:\/\//);
});
