// The sky spike (public/sky-spike/) is plain files, not part of the React build, so its guards live here:
// provenance (every image has a CC0 entry that matches the bytes), the byte budgets, no outside origin,
// and the hour table being continuous. Run with the rest of `npm test`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sky-spike');
const read = (f: string) => readFileSync(join(dir, f));
const KB = 1024;

type Keys = {
  KEYS: { h: number }[];
  sample: (h: number) => Record<string, number | number[] | string>;
  bodies: (h: number, d?: Date) => { sun: { elev: number }; moon: { elev: number }; phase: number };
  fmt: (h: number) => string;
};
const keys = (await import(pathToFileURL(join(dir, 'sky-keys.js')).href)) as Keys;

interface Asset {
  key: string;
  licence: string;
  licenceUrl: string;
  pageUrl: string;
  authors: Record<string, string>;
  files: { file: string; bytes: number; sha256: string }[];
}
const assets = JSON.parse(read('ASSETS.json').toString('utf8')) as { photos: Asset[] };

test('every sky image has a CC0 entry whose bytes and hash match', () => {
  assert.equal(assets.photos.length, 3);
  for (const p of assets.photos) {
    assert.equal(p.licence, 'CC0-1.0', p.key);
    assert.match(p.licenceUrl, /^https:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/$/);
    assert.match(p.pageUrl, /^https:\/\/polyhaven\.com\/a\//);
    assert.ok(Object.keys(p.authors).length > 0);
    assert.equal(p.files.length, 4);
    for (const f of p.files) {
      const b = read(f.file);
      assert.equal(b.length, f.bytes, f.file);
      assert.equal(createHash('sha256').update(b).digest('hex'), f.sha256, f.file);
    }
  }
});

test('no sky image is shipped without a provenance entry', () => {
  const listed = new Set(assets.photos.flatMap((p) => p.files.map((f) => f.file)));
  const onDisk = readdirSync(join(dir, 'img')).map((f) => `img/${f}`);
  assert.ok(onDisk.length > 0);
  for (const f of onDisk) assert.ok(listed.has(f), `${f} has no ASSETS.json entry`);
});

test('byte budgets: first paint, phone, total sky, script', () => {
  const size = (f: string) => statSync(join(dir, f)).size;
  for (const k of ['day', 'dusk', 'night']) {
    assert.ok(size(`img/${k}-desk.avif`) <= 60 * KB, `${k} desktop AVIF over 60 KB`);
    assert.ok(size(`img/${k}-desk.webp`) <= 60 * KB, `${k} desktop WebP over 60 KB`);
    assert.ok(size(`img/${k}-phone.avif`) <= 30 * KB, `${k} phone AVIF over 30 KB`);
    assert.ok(size(`img/${k}-phone.webp`) <= 30 * KB, `${k} phone WebP over 30 KB`);
  }
  const total = ['day', 'dusk', 'night'].reduce((a, k) => a + size(`img/${k}-desk.avif`), 0);
  assert.ok(total <= 250 * KB, `all three desktop skies ${total} bytes`);
  const code = ['sky.js', 'sky-keys.js'].reduce((a, f) => a + gzipSync(read(f), { level: 9 }).length, 0);
  assert.ok(code <= 30 * KB, `shader and script ${code} bytes gzipped`);
});

test('nothing is fetched from another origin; the headline is a real h1', () => {
  for (const f of ['index.html', 'sky.js', 'sky-keys.js']) {
    const t = read(f).toString('utf8');
    assert.doesNotMatch(t, /https?:\/\//, `${f} names an outside origin`);
  }
  assert.match(read('index.html').toString('utf8'), /<h1>BothyBox<\/h1>/);
});

test('the hour table is continuous, wraps at midnight and keeps the photo mix a partition of one', () => {
  const nums = (o: Record<string, number | number[] | string>) =>
    Object.entries(o)
      .filter(([k]) => k !== 'hour' && k !== 'name')
      .flatMap(([, v]) => (Array.isArray(v) ? v : [v as number]));
  const step = 0.01;
  for (let h = 0; h < 24; h += step) {
    const a = nums(keys.sample(h));
    const b = nums(keys.sample(h + step));
    a.forEach((x, i) =>
      assert.ok(Math.abs(x - (b[i] as number)) < 0.12 * (1 + Math.abs(x)), `jump at ${h.toFixed(2)} field ${i}`),
    );
    const w = keys.sample(h).w as number[];
    assert.ok(Math.abs(w[0]! + w[1]! + w[2]! - 1) < 1e-9);
    assert.ok(w.every((x) => x >= -1e-9));
  }
  assert.deepEqual(nums(keys.sample(0)), nums(keys.sample(24)));
  assert.deepEqual(nums(keys.sample(-1)), nums(keys.sample(23)));
});

test('sun by day, moon by night, a real phase, and HH:MM formatting', () => {
  const d = new Date(Date.UTC(2026, 10, 18));
  assert.ok(keys.bodies(12, d).sun.elev > 0.9);
  assert.ok(keys.bodies(0, d).sun.elev < 0);
  assert.ok(keys.bodies(0, d).moon.elev > 0.3);
  assert.ok(keys.bodies(12, d).moon.elev < 0);
  const p = keys.bodies(12, d).phase;
  assert.ok(p >= 0 && p < 1);
  assert.equal(keys.fmt(17.5), '17:30');
  assert.equal(keys.fmt(24), '00:00');
});
