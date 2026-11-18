// The SEO table and the committed share images, without a build (build plan S10). The built pages are checked by
// scripts/check-seo.mjs from verify-dist.sh.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkImages, checkTable, imageSize } from '../../scripts/check-seo.mjs';
import { SEO, seoFor } from '../../src/seo.ts';

test('every row of src/seo.ts is in range, unique and has a card', () => {
  assert.deepEqual(checkTable(), []);
});

test('the share images and icons match public/og/PROVENANCE.json and their budgets', () => {
  assert.deepEqual(checkImages(), []);
});

test('the fixed pages all have a row', () => {
  for (const p of ['/', '/install/', '/docs/', '/about/', '/changelog/', '/404.html']) assert.ok(SEO[p], p);
});

test('a page with no row falls back, and a docs page gets the docs card', () => {
  const r = seoFor('/docs/new-page/', { title: 'T', description: 'D' });
  assert.deepEqual(r, { title: 'T', description: 'D', image: 'docs' });
});

test('imageSize reads a PNG header and rejects garbage', () => {
  const png = Buffer.alloc(32);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(1200, 16);
  png.writeUInt32BE(630, 20);
  assert.deepEqual(imageSize(png), { width: 1200, height: 630 });
  assert.equal(imageSize(Buffer.from('not an image at all, really')), null);
});
