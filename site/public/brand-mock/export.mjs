// Writes svg/ from concepts.js, so the files are exactly what the gallery draws. Run: node export.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONCEPTS, iconSVG, wordmarkSVG, lockupSVG, PAPER, INK } from './concepts.js';

const out = join(dirname(fileURLToPath(import.meta.url)), 'svg');
mkdirSync(out, { recursive: true });
const put = (name, svg) => writeFileSync(join(out, name), `${svg}\n`);

for (const c of CONCEPTS) {
  put(`${c.id}.svg`, iconSVG(c, 'tile', { label: `BothyBox ${c.name} icon` }));
  put(`${c.id}-mono.svg`, iconSVG(c, 'mono', { label: `BothyBox ${c.name} icon` }));
  put(`${c.id}-touch.svg`, iconSVG(c, 'full', { label: `BothyBox ${c.name} icon` }));
}
put('wordmark.svg', wordmarkSVG({ fill: PAPER }));
put('wordmark-ink.svg', wordmarkSVG({ fill: INK }));
put('lockup-horizontal.svg', lockupSVG('hut', 'h', { standalone: true }));
put('lockup-stacked.svg', lockupSVG('hut', 'v', { standalone: true }));
put('lockup-horizontal-ink.svg', lockupSVG('hut', 'h', { fill: INK, standalone: true }));
console.log(`wrote ${CONCEPTS.length * 3 + 5} files to svg/`);
