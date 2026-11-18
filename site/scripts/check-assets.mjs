// Guards the sky photographs in public/sky/ (build plan s9, slice S2).
//   - every image file has an entry in PROVENANCE.json, and every entry has a file;
//   - each entry is CC0 1.0 with a page URL, an author and a check date;
//   - bytes and sha256 match the file on disk;
//   - per-file and total byte budgets hold (all photographs: 300 KB).
// Run by `npm test` (twice: on its own first, then via src/sky-assets.test.ts) and by hand: `node scripts/check-assets.mjs`.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KB = 1024;
export const LIMITS = { total: 300 * KB, desk: 40 * KB, phone: 20 * KB };
const IMAGE = /\.(avif|webp|jpe?g|png|gif|svg)$/i;

/** Returns a list of problems, empty when the directory is sound. */
export function checkAssets(dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sky')) {
  const fails = [];
  let prov;
  try {
    prov = JSON.parse(readFileSync(join(dir, 'PROVENANCE.json'), 'utf8'));
  } catch (e) {
    return [`PROVENANCE.json unreadable: ${e.message}`];
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(prov.checked ?? '')) fails.push('checked date missing');
  const listed = new Map();
  for (const p of prov.photos ?? []) {
    if (p.licence !== 'CC0-1.0') fails.push(`${p.key}: licence is ${p.licence}, only CC0-1.0 is allowed`);
    if (p.licenceUrl !== 'https://creativecommons.org/publicdomain/zero/1.0/') fails.push(`${p.key}: licenceUrl`);
    if (!/^https:\/\/polyhaven\.com\/a\//.test(p.pageUrl ?? '')) fails.push(`${p.key}: pageUrl missing`);
    if (!Object.keys(p.authors ?? {}).length) fails.push(`${p.key}: no author`);
    if (!/^[0-9a-f]{64}$/.test(p.sourceSha256 ?? '')) fails.push(`${p.key}: sourceSha256 missing`);
    for (const f of p.files ?? []) listed.set(f.file, f);
  }
  let total = 0;
  const onDisk = readdirSync(dir).filter((f) => IMAGE.test(f));
  for (const f of onDisk) {
    const e = listed.get(f);
    if (!e) {
      fails.push(`${f}: image without a CC0 provenance entry`);
      continue;
    }
    const b = readFileSync(join(dir, f));
    total += b.length;
    if (b.length !== e.bytes) fails.push(`${f}: ${b.length} bytes on disk, ${e.bytes} recorded`);
    if (createHash('sha256').update(b).digest('hex') !== e.sha256)
      fails.push(`${f}: sha256 differs from PROVENANCE.json`);
    const limit = f.includes('-phone.') ? LIMITS.phone : LIMITS.desk;
    if (b.length > limit) fails.push(`${f}: ${b.length} bytes over its ${limit} budget`);
  }
  for (const f of listed.keys()) {
    if (!onDisk.includes(f) || !statSync(join(dir, f)).isFile()) fails.push(`${f}: listed but missing`);
  }
  if (total > LIMITS.total) fails.push(`photographs total ${total} bytes, budget ${LIMITS.total}`);
  return fails;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fails = checkAssets();
  if (fails.length) {
    for (const f of fails) console.error(`check-assets: ${f}`);
    process.exit(1);
  }
  console.log('check-assets: ok');
}
