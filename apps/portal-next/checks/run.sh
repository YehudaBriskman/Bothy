#!/usr/bin/env bash
# Compile the (dependency-free) discover module and run the status truth table
# against it, plus a pass over the box's real container list.
#
# There is no test runner in this app on purpose — one 13-case truth table did
# not justify pulling vitest into a static SPA's toolchain. discover.ts imports
# nothing, which is what makes this one-liner possible; if that ever stops being
# true, that is the moment to add a real runner.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB="$HERE/../web"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

(cd "$WEB" && npx tsc src/lib/discover.ts --ignoreConfig \
  --module esnext --target es2022 --moduleResolution bundler --outDir "$OUT" >/dev/null)
mv "$OUT/discover.js" "$OUT/discover.mjs"
cp "$HERE/status-classifier.mjs" "$OUT/"

echo "── truth table ─────────────────────────────────────────"
node "$OUT/status-classifier.mjs"

echo
echo "── this box, right now ─────────────────────────────────"
curl -s --unix-socket /var/run/docker.sock "http://localhost/containers/json?all=1" > "$OUT/containers.json"
node --input-type=module -e "
import { statusOf } from '$OUT/discover.mjs';
import { readFileSync } from 'node:fs';
const cs = JSON.parse(readFileSync('$OUT/containers.json'));
const n = {};
for (const c of cs) { const s = statusOf(c); (n[s] ??= []).push(c.Names?.[0]?.replace(/^\//, '')); }
for (const [k, v] of Object.entries(n)) console.log(\`  \${k.padEnd(9)} \${v.length}  \${v.slice(0, 6).join(', ')}\`);
"
