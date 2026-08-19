#!/usr/bin/env bash
# Compile the dependency-free modules and run their truth tables against them:
# the status classifier and the dependency graph out of discover.ts, the retired
# URLs out of pages/control/redirects.ts, the two Files URLs out of
# pages/files/routes.ts and the document titles out of pages/files/titles.ts,
# plus a pass over the box's real container list.
#
# There is no test runner in this app on purpose - one 13-case truth table did
# not justify pulling vitest into a static SPA's toolchain. Both modules import
# NOTHING, which is what makes these one-liners possible, and it is why anything
# worth checking here gets written as a module that imports nothing. If that ever
# stops being true, that is the moment to add a real runner.
set -euo pipefail

# `--offline` drops the one section that needs a docker daemon. Everything else
# here is a truth table over compiled, dependency-free modules and reads only the
# source tree, which is what lets CI run 290-odd assertions in a job that starts
# no containers. Without the flag the whole file was unusable there: one `curl`
# against /var/run/docker.sock at the end failed the run and took every passing
# check with it.
OFFLINE=0
[ "${1:-}" = "--offline" ] && OFFLINE=1

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
(cd "$WEB" && npx tsc src/pages/files/routes.ts --ignoreConfig \
  --module esnext --target es2022 --moduleResolution bundler --outDir "$OUT" >/dev/null)
mv "$OUT/routes.js" "$OUT/files-routes.mjs"
(cd "$WEB" && npx tsc src/pages/files/titles.ts --ignoreConfig \
  --module esnext --target es2022 --moduleResolution bundler --outDir "$OUT" >/dev/null)
mv "$OUT/titles.js" "$OUT/titles.mjs"
(cd "$WEB" && npx tsc src/lib/contract.ts --ignoreConfig \
  --module esnext --target es2022 --moduleResolution bundler --outDir "$OUT" >/dev/null)
mv "$OUT/contract.js" "$OUT/contract.mjs"
(cd "$WEB" && npx tsc src/lib/customThemes.ts --ignoreConfig \
  --module esnext --target es2022 --moduleResolution bundler --outDir "$OUT" >/dev/null)
mv "$OUT/customThemes.js" "$OUT/user-themes-mod.mjs"
# tree.ts is the one module here that is not import-free: it carries a TYPE-only
# import, which tsc erases from the output but still uses to compute rootDir - so
# this one lands at $OUT/pages/files/ rather than at the top. Moved rather than
# forced with --rootDir, which makes tsc error on the very import it is about to
# erase.
(cd "$WEB" && npx tsc src/pages/files/tree.ts --ignoreConfig \
  --module esnext --target es2022 --moduleResolution bundler --outDir "$OUT" >/dev/null)
mv "$OUT/pages/files/tree.js" "$OUT/wikilinks-mod.mjs"
cp "$HERE/status-classifier.mjs" "$HERE/relations.mjs" "$HERE/redirect-table.mjs" \
   "$HERE/titles-table.mjs" "$HERE/theme-contract.mjs" "$HERE/user-themes.mjs" \
   "$HERE/wikilinks.mjs" "$HERE/repo-roots.mjs" "$OUT/"

echo "── truth table ─────────────────────────────────────────"
node "$OUT/status-classifier.mjs"

echo
echo "── relations ───────────────────────────────────────────"
node "$OUT/relations.mjs"

echo
echo "── redirects and the two Files URLs ────────────────────"
node "$OUT/redirect-table.mjs"

echo
echo "── document titles ─────────────────────────────────────"
node "$OUT/titles-table.mjs"

echo
echo "── where this repo is, asked of docker not assumed ─────"
# The two functions that replaced a hardcoded home directory. Every case here is
# a SECOND MACHINE - a different checkout path, a sibling directory that is a
# prefix of it, nothing mounted yet - which is precisely what could not be tested
# while the value was a literal.
node "$OUT/repo-roots.mjs"

echo
echo "── this box, right now ─────────────────────────────────"
if [ "$OFFLINE" = 1 ]; then
  # SAID OUT LOUD rather than silently skipped. A suite that quietly drops a
  # section reads as "everything passed" in a log, which is the failure mode
  # this repo keeps rediscovering.
  echo "  SKIPPED (--offline): needs a docker daemon"
else
curl -s --unix-socket /var/run/docker.sock "http://localhost/containers/json?all=1" > "$OUT/containers.json"
node --input-type=module -e "
import { statusOf } from '$OUT/discover.mjs';
import { readFileSync } from 'node:fs';
const cs = JSON.parse(readFileSync('$OUT/containers.json'));
const n = {};
for (const c of cs) { const s = statusOf(c); (n[s] ??= []).push(c.Names?.[0]?.replace(/^\//, '')); }
for (const [k, v] of Object.entries(n)) console.log(\`  \${k.padEnd(9)} \${v.length}  \${v.slice(0, 6).join(', ')}\`);
"
fi

echo
echo "── every theme keeps the palette's contract ────────────"
# Reads index.css, hl.css and src/themes/*.css directly. Runs against the two
# SHIPPED palettes as well as the named themes, on purpose: a rule that fails on
# Bothy's own colours is a wrong rule, and this is where that gets found out.
#
# The rules it applies come from lib/contract.ts, compiled above and shared with
# the in-app theme editor. This is the only check that reads the source tree, so
# it is run from $OUT (where the compiled contract is) and told where the tree
# is, rather than inferring a sibling that is not there.
node "$OUT/theme-contract.mjs" "$WEB/src"

echo
echo "── a theme dropped in by hand is read correctly ────────"
# lib/customThemes.ts parses a .css file somebody wrote into
# apps/portal-next/data/themes. Getting `appearance` wrong there is not cosmetic:
# it decides which base palette the pre-paint script stamps, so a light theme
# would render its first frame on the dark base.
node "$OUT/user-themes.mjs"

echo
echo "── a wikilink finds the right document ─────────────────"
# `[[dns]]` carries no directory and no extension, so resolving one is a SEARCH
# with a precedence order. Get the order wrong and the failure is not an error -
# it is a link that quietly opens the wrong note.
node "$OUT/wikilinks.mjs"

echo
echo "── every colour comes from a token ─────────────────────"
# Reads the source tree directly - no compile step, because it is looking at the
# text rather than at behaviour. Runs regardless of whether there is a build.
node "$HERE/stray-colour.mjs"

echo
echo "── what the markdown reader actually renders ───────────"
# THE ONE CHECK THAT CANNOT USE THE BARE-tsc TRICK. Every module above imports
# nothing, which is what makes a one-line compile possible. md.tsx imports React,
# lucide, the highlighter and the path resolver, and returns ELEMENTS - so this
# renders it for real with react-dom/server and asserts on the HTML string.
#
# Built with its own tsconfig because node_modules lives under web/ and this file
# does not, and INTO the project rather than /tmp, because node resolves `react`
# by walking up from the output. Then .js -> .mjs with relative specifiers
# rewritten, since node needs the extension and tsc does not emit it.
#
# No new dependency: react-dom is already here. The rule this repo set - "one
# 13-case truth table did not justify pulling vitest into a static SPA" - still
# holds; this is what it looks like to honour it and still test a component.
MDOUT="$WEB/.mdcheck-tmp"
rm -rf "$MDOUT"
(cd "$WEB" && npx tsc -p ../checks/tsconfig.md-render.json --outDir .mdcheck-tmp >/dev/null)
find "$MDOUT" -name '*.js' -exec bash -c 'mv "$1" "${1%.js}.mjs"' _ {} \;
find "$MDOUT" -name '*.mjs' -exec sed -i "s|from '\(\.\{1,2\}/[^']*\)'|from '\1.mjs'|g" {} \;
node "$MDOUT/checks/md-render.mjs"
rm -rf "$MDOUT"

echo
echo "── a brand asset is small, vector, and follows the theme ─"
# Reads web/public directly, so it needs no build. The logo that prompted this
# was 1467 KB of baked bitmap in an SVG wrapper, and half of it was hard white -
# invisible on a light theme. Both are invisible in a diff: the file is one line.
node "$HERE/brand-assets.mjs"

echo
echo "── the CSP and the inline script must agree ────────────"
# Needs web/dist, so it runs after a build. Skipped rather than failed when there
# is none: an unbuilt tree is not a broken policy.
if [ -f "$HERE/../web/dist/index.html" ]; then
  node "$HERE/csp_hash.mjs"
else
  echo "  SKIP: no web/dist - run npm run build first"
fi
