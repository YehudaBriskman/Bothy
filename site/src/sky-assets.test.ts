// Runs scripts/check-assets.mjs under `npm test`, and proves it fails on the faults it exists to catch.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// @ts-expect-error plain .mjs without types
import { checkAssets } from '../scripts/check-assets.mjs';

const check = checkAssets as (dir?: string) => string[];
const real = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sky');
const copy = () => {
  const d = mkdtempSync(join(tmpdir(), 'sky-assets-'));
  cpSync(real, d, { recursive: true });
  return d;
};

test('public/sky is sound: provenance, hashes, budgets', () => {
  assert.deepEqual(check(), []);
});

test('an image with no provenance entry fails', () => {
  const d = copy();
  writeFileSync(join(d, 'stray.webp'), 'x');
  assert.match(check(d).join('\n'), /stray\.webp: image without a CC0 provenance entry/);
});

test('a changed file fails the hash', () => {
  const d = copy();
  writeFileSync(join(d, 'day-phone.avif'), 'tampered');
  assert.match(check(d).join('\n'), /day-phone\.avif: .*(sha256|bytes)/);
});

test('an oversized file fails the budget', () => {
  const d = copy();
  writeFileSync(join(d, 'day-phone.webp'), Buffer.alloc(30 * 1024));
  assert.match(check(d).join('\n'), /over its .* budget/);
});
