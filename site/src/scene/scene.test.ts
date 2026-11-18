// The S6 sky-scene gallery (public/scene-mock/): plain files, so its guards live here. Photographs carry CC0 provenance
// inside the byte budgets, the shader is the approved sky's, every scene is complete, and the page is noindex and offline.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
// @ts-expect-error plain .mjs without types
import { checkAssets } from '../../scripts/check-assets.mjs';

const site = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mock = join(site, 'public', 'scene-mock');
const read = (p: string) => readFileSync(join(mock, p), 'utf8');

interface Scene {
  id: string;
  title: string;
  line: string;
  photo: string;
  depth: number[];
  home: number;
  sun: number;
  moon?: number;
  halo?: boolean;
}
const { SCENES } = (await import(pathToFileURL(join(mock, 'scenes.js')).href)) as { SCENES: Scene[] };

test('the gallery photographs have CC0 provenance, matching bytes and fit the byte budget', () => {
  const fails = (checkAssets as (d?: string) => string[])(join(mock, 'img'));
  assert.deepEqual(fails, []);
});

test('there are six to eight scenes, each complete, with a photograph that exists and is on record', () => {
  assert.ok(SCENES.length >= 6 && SCENES.length <= 8, `${SCENES.length} scenes`);
  const ids = new Set<string>();
  const recorded = new Set<string>();
  for (const dir of [join(mock, 'img'), join(site, 'public', 'sky')]) {
    const prov = JSON.parse(readFileSync(join(dir, 'PROVENANCE.json'), 'utf8')) as {
      photos: { files: { file: string }[] }[];
    };
    for (const p of prov.photos) for (const f of p.files) recorded.add(join(dir, f.file));
  }
  for (const s of SCENES) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.title.length > 2 && s.line.length > 20, s.id);
    assert.equal(s.depth.length, 3, s.id);
    assert.ok(s.home >= 0 && s.home < 24, s.id);
    assert.ok(s.sun === 0 || s.sun === 1, s.id);
    const file = join(mock, s.photo);
    assert.ok(existsSync(file), `${s.photo} missing`);
    assert.ok(recorded.has(file), `${s.photo} has no provenance entry`);
    assert.ok(statSync(file).size <= 40 * 1024, `${s.photo} over 40 KB`);
  }
});

test('the shader is the approved sky shader, byte for byte', () => {
  const spike = readFileSync(join(site, 'public', 'sky-spike', 'sky.js'), 'utf8');
  const a = spike.slice(
    spike.indexOf('const VS = `'),
    spike.indexOf('// ---------------------------------------------------------------- GL'),
  );
  const g = read('gallery.js');
  const start = g.indexOf('// ---------------------------------------------------------------- shader');
  const b = g.slice(
    g.indexOf('\n', start) + 1,
    g.indexOf('// ---------------------------------------------------------------- end shader'),
  );
  assert.ok(a.length > 5000, 'could not find the spike shader');
  assert.equal(b.trim(), a.trim());
});

test('the gallery stays out of the index, loads nothing from another origin and draws no ground', () => {
  const html = read('index.html');
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
  for (const f of ['index.html', 'gallery.js', 'scenes.js'])
    assert.doesNotMatch(read(f), /https?:\/\/(?!creativecommons)/, f);
  assert.doesNotMatch(read('scenes.js') + html, /hill|ridge|bothy hut|mist/i);
});
