#!/usr/bin/env bash
# Make a release self-consistent: put release-manifest.json's sha256 in checksums.txt.
#
#   append-manifest-checksum.sh <checksums.txt> <release-manifest.json>
#
# `bothy install` / `bothy update` (cli/internal/install VerifyManifest) accept a
# manifest only if its sha256 is a line of the release's checksums.txt, which the
# release attests. The `cli` job writes checksums.txt before the images and the
# manifest exist, so the release-manifest job calls this on the published file.
#
# The rewrite is a pure function of its inputs, so a re-run is safe:
#   - any existing release-manifest.json line is dropped, then the current one
#     is added (a re-run neither duplicates the line nor leaves a stale one);
#   - the result is sorted by file name, bytewise (LC_ALL=C), the same order
#     scripts/build-cli.sh uses, so the same inputs always give the same bytes
#     and therefore the same sha256 (the value BOTHY_PIN_CHECKSUMS_SHA256 pins);
#   - format is "<64 hex>  <name>", two spaces, which `sha256sum -c` and
#     scripts/bothy.sh --binary both read.
# Every existing line must already be in that format and file names must be
# unique: anything else is refused and the file is left untouched, because
# a checksums.txt we half understand is not one to attest.
# Prints the new file's sha256 on stdout; diagnostics go to stderr.
set -euo pipefail

die() { echo "append-manifest-checksum: $*" >&2; exit 1; }
[ "$#" -eq 2 ] || die "usage: $0 <checksums.txt> <release-manifest.json>"
sums=$1
manifest=$2
name=release-manifest.json

[ -f "$sums" ] || die "$sums: no such file"
[ -f "$manifest" ] || die "$manifest: no such file"
[ -s "$sums" ] || die "$sums is empty"
[ -s "$manifest" ] || die "$manifest is empty"

if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
else
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

tmp=$(mktemp "$(dirname "$sums")/.checksums.XXXXXX")
trap 'rm -f "$tmp" "$tmp.sorted"' EXIT

# Validate every line, drop any old manifest line, keep the rest.
n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  [[ "$line" =~ ^[0-9a-f]{64}\ \ [^[:space:]]+$ ]] \
    || die "$sums line $n is not '<64 hex>  <name>': $line"
  [ "${line:66}" = "$name" ] || printf '%s\n' "$line" >> "$tmp"
done < "$sums"
[ -s "$tmp" ] || die "$sums lists nothing but $name: refusing, the archives are missing"

printf '%s  %s\n' "$(sha "$manifest")" "$name" >> "$tmp"
LC_ALL=C sort -k2,2 "$tmp" > "$tmp.sorted"

dup=$(cut -d' ' -f3 "$tmp.sorted" | LC_ALL=C uniq -d | head -1)
[ -z "$dup" ] || die "$sums lists $dup twice: refusing"

chmod 644 "$tmp.sorted"
mv "$tmp.sorted" "$sums"
sha "$sums"
