#!/usr/bin/env bash
# Every generated diagram still matches the mermaid it was generated from.
#
# ── what breaks without this ─────────────────────────────────────────────────
#
# docs/ARCHITECTURE.md used to carry six mermaid fences. GitHub renders those;
# Bothy's own docs reader cannot, because md.tsx builds React elements and never
# an HTML string - the property that lets it render arbitrary repo content with
# no sanitiser - so it showed Bothy's own architecture as six code blocks.
#
# The fix moved the mermaid out to docs/diagrams/*.mmd and put an <img> in the
# document, which both readers understand. That buys a NEW failure: the source
# and the picture are now two files, and the picture is the one everybody looks
# at. Edit the .mmd, forget `just diagrams`, and the document confidently shows
# the OLD architecture - a wrong diagram that looks perfectly healthy, which is
# worse than the code block it replaced.
#
# ── why it hashes instead of rendering ───────────────────────────────────────
#
# The renderer is headless Chromium out of ~/.cache/ms-playwright (see
# scripts/gen-diagrams.py for why that one). A GitHub runner has no such cache,
# and installing a browser to re-render seven pictures would turn a one-second
# tree check into a several-minute job that can fail for network reasons.
#
# So gen-diagrams.py writes the sha256 of the SOURCE into the SVG as an XML
# comment, and this compares it with the sha256 of the source on disk. Pure
# tree, no daemon, no browser - which is what puts it in CI tier 0 beside
# version.sh rather than anywhere that needs something running.
#
# NEWLINES ARE NORMALISED before hashing, matching gen-diagrams.py: a checkout
# with core.autocrlf on would otherwise report all seven stale on a machine that
# had changed nothing.
#
# ── the two other ways it goes wrong ─────────────────────────────────────────
#
#   · a source with no SVG at all - somebody added a .mmd and never rendered it,
#     so the document links an image that 404s.
#   · an SVG with no source - a diagram was deleted or renamed and the artefact
#     was left behind, which is how a picture nothing generates any more ends up
#     being maintained by hand.
#
# apps/portal-files/policy.toml flags **/*.svg as `caution` on write, which is
# right for an SVG somebody might hand-edit and exactly wrong for these: they are
# machine output. This check is what makes that safe to ignore for these seven -
# a hand edit to the SVG does not change the recorded hash, but any hand edit to
# the SOURCE without a re-render shows up here immediately.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

SRC_DIR=docs/diagrams
OUT_DIR=docs/assets/diagrams
STAMP=bothy-mermaid-sha256

fails=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s  %s\n' "$1" "${2:-}"; fails=$((fails+1)); }

[ -d "$SRC_DIR" ] || { echo "FAIL  no $SRC_DIR - where did the mermaid sources go?"; exit 1; }

# `shasum -a 256` rather than sha256sum: macOS has the former and not the latter,
# and this repo's shell layer is checked for bash 3.2 compatibility for the same
# reason (scripts/checks/bash32.sh).
if command -v sha256sum >/dev/null 2>&1; then
  hash_of() { tr -d '\r' < "$1" | sha256sum | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  hash_of() { tr -d '\r' < "$1" | shasum -a 256 | cut -d' ' -f1; }
else
  echo "FAIL  neither sha256sum nor shasum is installed - cannot verify anything"
  exit 1
fi

found=0
for src in "$SRC_DIR"/*.mmd; do
  [ -e "$src" ] || continue
  found=$((found+1))
  name=$(basename "$src" .mmd)
  svg="$OUT_DIR/$name.svg"

  if [ ! -f "$svg" ]; then
    fail "$name" "no $svg - run \`just diagrams\`"
    continue
  fi

  want=$(hash_of "$src")
  # One line, one field: the stamp gen-diagrams.py writes just after the <svg>
  # open tag. `head` bounds the read so a 45 KB single-line SVG is not scanned
  # end to end for a marker that is always near the front.
  got=$(head -c 4000 "$svg" | sed -n "s/.*$STAMP: \([0-9a-f]\{64\}\).*/\1/p" | head -1)

  if [ -z "$got" ]; then
    fail "$name" "$svg carries no $STAMP stamp - it was not made by gen-diagrams.py"
  elif [ "$got" != "$want" ]; then
    fail "$name" "the source changed since the SVG was rendered - run \`just diagrams\`"
  else
    pass "$name"
  fi
done

if [ "$found" -eq 0 ]; then
  echo "FAIL  no *.mmd under $SRC_DIR - this check would pass vacuously"
  exit 1
fi

# ── an artefact with nothing behind it ──────────────────────────────────────
for svg in "$OUT_DIR"/*.svg; do
  [ -e "$svg" ] || continue
  name=$(basename "$svg" .svg)
  [ -f "$SRC_DIR/$name.mmd" ] || fail "$name" "$svg has no $SRC_DIR/$name.mmd - delete it or restore the source"
done

# ── README.md, until its rewrite lands ──────────────────────────────────────
#
# README still carries its diagram as a mermaid fence, deliberately: a separate
# change is rewriting that file and swapping the fence for the image is its call
# to make, not this one's. docs/diagrams/readme-overview.mmd and its SVG exist
# and are ready for it.
#
# Which leaves the fence and the .mmd as two copies of one diagram, so they are
# compared here. SELF-RETIRING: when the fence goes, this arm goes quiet on its
# own rather than needing anyone to remember to delete it.
readme_src=$SRC_DIR/readme-overview.mmd
if [ -f "$readme_src" ] && grep -q '^```mermaid' README.md 2>/dev/null; then
  if awk '/^```mermaid$/{on=1;next} /^```$/{on=0} on' README.md \
     | diff -q - "$readme_src" >/dev/null 2>&1; then
    pass "readme-overview matches the fence still in README.md"
  else
    fail "readme-overview" "README.md's mermaid fence and $readme_src have drifted"
  fi
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "ok - $found diagram(s), every SVG matches its source"
else
  echo "$fails problem(s). The .mmd is the source; the .svg is output."
  echo "\`just diagrams\` re-renders whatever is stale."
fi
exit $((fails > 0 ? 1 : 0))
