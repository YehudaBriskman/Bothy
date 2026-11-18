import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SCENES, sceneOpacity } from './scenes.ts';

const pub = (p: string) => fileURLToPath(new URL(`../../public/${p}`, import.meta.url));
const css = readFileSync(fileURLToPath(new URL('../styles/story.css', import.meta.url)), 'utf8');

test('every scene fades in and out smoothly and never exceeds its maximum', () => {
  for (const s of SCENES) {
    assert.equal(sceneOpacity(s, 0), 0);
    assert.equal(sceneOpacity(s, 1), 0);
    let prev = 0;
    for (let i = 0; i <= 1000; i++) {
      const o = sceneOpacity(s, i / 1000);
      assert.ok(o >= 0 && o <= s.max + 1e-9);
      assert.ok(Math.abs(o - prev) < 0.02, `${s.id} jumps at ${i}`);
      prev = o;
    }
    assert.ok(Math.abs(sceneOpacity(s, (s.window[1] + s.window[2]) / 2) - s.max) < 1e-9);
  }
});

test('scenes are shown one after another with a hand-over, in chapter order', () => {
  for (let i = 1; i < SCENES.length; i++) assert.ok(SCENES[i]!.window[0] >= SCENES[i - 1]!.window[1]);
});

test('scene photographs exist, are small, and have a CC0 provenance entry', () => {
  const prov = JSON.parse(readFileSync(pub('scene-mock/img/PROVENANCE.json'), 'utf8')) as {
    photos: { files: { file: string; bytes: number }[]; licence: string }[];
  };
  for (const s of SCENES) {
    const name = s.file.split('/').pop()!;
    assert.ok(existsSync(pub(s.file)), `${s.file} missing`);
    const entry = prov.photos.find((p) => p.files.some((f) => f.file === name));
    assert.ok(entry, `${name}: no provenance`);
    assert.equal(entry.licence, 'CC0-1.0');
    assert.ok(entry.files.find((f) => f.file === name)!.bytes < 40 * 1024);
  }
});

test('the story stylesheet draws no hard edge between chapters', () => {
  // chapters carry no border or background of their own, and the stage layers are masked or faded
  assert.match(css, /\.story \.ch \{\s*background: none;\s*border: 0;/);
  assert.match(css, /\.sky-scene \{[^}]*mask-image/s);
  assert.doesNotMatch(css, /border-block-start: 1px/);
  // the veil is one long eased gradient: many stops, none fully opaque
  const veil = css.match(/\.story::before \{[^}]*\}/s)![0];
  const alphas = [...veil.matchAll(/--ground-rgb\) \/ ([0-9.]+)\)/g)].map((m) => +m[1]!);
  assert.ok(alphas.length >= 30, 'the veil needs many stops');
  assert.ok(Math.max(...alphas) < 0.8);
  for (let i = 1; i < alphas.length; i++) assert.ok(Math.abs(alphas[i]! - alphas[i - 1]!) < 0.06, `step at ${i}`);
});
