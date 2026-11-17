// Post-build guard: nothing private reached the output.
//   1. every rendered repository document is on the allowlist (and the allowlist has nothing private);
//   2. no file under dist/ matches a leak pattern (tailnet address, credential shapes, the owner's machine).
// Shares leak-patterns.json with the build, so the two cannot disagree.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const fails = [];

const allow = JSON.parse(readFileSync(join(root, 'docs-allowlist.json'), 'utf8')).files.map((f) => `docs/${f.file}`);
const rendered = JSON.parse(readFileSync(join(root, 'dist-prerender/docs-rendered.json'), 'utf8')).rendered;
for (const r of rendered) if (!allow.includes(r)) fails.push(`${r} was rendered but is not on the allowlist`);
for (const a of allow) {
  if (/(^|\/)(kb|claude-notes|\.claude|secrets?|credentials?)(\/|$)/i.test(a))
    fails.push(`allowlist names a private path: ${a}`);
}

const patterns = JSON.parse(readFileSync(join(root, 'leak-patterns.json'), 'utf8')).patterns.map((p) => ({
  name: p.name,
  re: new RegExp(p.source, `${p.flags}g`),
}));
const TEXT = /\.(html|json|js|css|txt|xml|svg|map)$|^CNAME$/;
let scanned = 0;
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (TEXT.test(name)) {
      scanned += 1;
      const text = readFileSync(p, 'utf8');
      for (const { name: n, re } of patterns) {
        for (const m of text.matchAll(re)) fails.push(`${p.slice(root.length + 1)}: ${n}: ${m[0].slice(0, 60)}`);
      }
    }
  }
})(dist);

if (fails.length) {
  for (const f of fails) console.error(`::error::check-public: ${f}`);
  process.exit(1);
}
console.log(`check-public: ${rendered.length} rendered docs all allowlisted; ${scanned} output files clean`);
