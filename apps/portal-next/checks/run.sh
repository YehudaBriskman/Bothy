#!/usr/bin/env bash
# Compile the dependency-free modules and run their truth tables against them:
# the status classifier and the dependency graph out of discover.ts, the retired
# URLs out of pages/control/redirects.ts, plus a pass over the box's real
# container list.
#
# There is no test runner in this app on purpose - one 13-case truth table did
# not justify pulling vitest into a static SPA's toolchain. Both modules import
# NOTHING, which is what makes these one-liners possible, and it is why anything
# worth checking here gets written as a module that imports nothing. If that ever
# stops being true, that is the moment to add a real runner.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB="$HERE/../web"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

# One invocation per module, not one with two inputs: with two, tsc's rootDir
# becomes their common ancestor and it reproduces the source tree's directories
# under --outDir, so the outputs stop being where the checks import them from.
(cd "$WEB" && npx tsc src/lib/discover.ts --ignoreConfig \
  --module esnext --target es2022 --moduleResolution bundler --outDir "$OUT" >/dev/null)
mv "$OUT/discover.js" "$OUT/discover.mjs"
(cd "$WEB" && npx tsc src/pages/control/redirects.ts --ignoreConfig \
  --module esnext --target es2022 --moduleResolution bundler --outDir "$OUT" >/dev/null)
mv "$OUT/redirects.js" "$OUT/redirects.mjs"
cp "$HERE/status-classifier.mjs" "$HERE/relations.mjs" "$HERE/redirect-table.mjs" "$OUT/"

echo "── truth table ─────────────────────────────────────────"
node "$OUT/status-classifier.mjs"

echo
echo "── relations ───────────────────────────────────────────"
node "$OUT/relations.mjs"

echo
echo "── redirects ───────────────────────────────────────────"
node "$OUT/redirect-table.mjs"

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

echo
echo "── the CSP and the inline script must agree ────────────"
# Needs web/dist, so it runs after a build. Skipped rather than failed when there
# is none: an unbuilt tree is not a broken policy.
if [ -f "$HERE/../web/dist/index.html" ]; then
  node "$HERE/csp_hash.mjs"
else
  echo "  SKIP: no web/dist - run npm run build first"
fi
