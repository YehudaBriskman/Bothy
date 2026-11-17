#!/usr/bin/env bash
# scripts/append-manifest-checksum.sh on fixtures, plus its consumers: the
# installer's own line parser (scripts/bothy.sh --binary reads checksums.txt with
# an anchored sed, so the extra line must be inert) and `sha256sum -c`.
# Pure local. Claims: appends, sorts, is idempotent, replaces a stale line, and
# refuses (leaving the file byte-for-byte untouched) a missing file, an empty
# manifest and malformed or duplicated input.
# $? is read right after the [ ] it tests, on purpose; the grep pattern is literal.
# shellcheck disable=SC2319,SC2016,SC2181
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
S=scripts/append-manifest-checksum.sh
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
fails=0
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s  %s\n' "$1" "${2:-}"; fails=$((fails+1)); }
t()   { if [ "$2" = 0 ]; then ok "$1"; else bad "$1" "${3:-}"; fi; }

h() { printf '%064d' "$1"; }
fixture() { # two archives in build-cli.sh order
  printf '%s  bothy_9.9.9_linux_amd64.tar.gz\n%s  bothy_9.9.9_windows_amd64.zip\n' "$(h 1)" "$(h 2)" > "$1"
}
printf '{"schema":1}\n' > "$W/m.json"
MSHA=$(sha256sum "$W/m.json" | cut -d' ' -f1)

# appends, ordered, prints the hash of the final file
fixture "$W/c"
out=$(bash $S "$W/c" "$W/m.json" 2>&1); rc=$?
t "exits 0" "$rc" "$out"
want="$(h 1)  bothy_9.9.9_linux_amd64.tar.gz
$(h 2)  bothy_9.9.9_windows_amd64.zip
$MSHA  release-manifest.json"
[ "$(cat "$W/c")" = "$want" ]; t "manifest line appended after the archives, sorted" $? "$(cat "$W/c")"
[ "$out" = "$(sha256sum "$W/c" | cut -d' ' -f1)" ]; t "prints the sha256 of the FINAL checksums.txt" $? "$out"

# idempotent: byte-identical on later runs
cp "$W/c" "$W/c1"
bash $S "$W/c" "$W/m.json" >/dev/null
bash $S "$W/c" "$W/m.json" >/dev/null
cmp -s "$W/c" "$W/c1"; t "re-running is a byte-for-byte no-op (one line, same hash)" $? ""
[ "$(grep -c 'release-manifest.json$' "$W/c")" = 1 ]; t "exactly one manifest line" $? ""

# a changed manifest replaces its old line
printf '{"schema":1,"v":2}\n' > "$W/m2.json"
bash $S "$W/c" "$W/m2.json" >/dev/null
[ "$(grep -c 'release-manifest.json$' "$W/c")" = 1 ] && grep -q "^$(sha256sum "$W/m2.json" | cut -d' ' -f1)  release-manifest.json$" "$W/c"
t "a changed manifest replaces its old line" $? "$(cat "$W/c")"

# input order does not matter
printf '%s  bothy_9.9.9_windows_amd64.zip\n%s  bothy_9.9.9_linux_amd64.tar.gz\n' "$(h 2)" "$(h 1)" > "$W/r"
bash $S "$W/r" "$W/m.json" >/dev/null
[ "$(cat "$W/r")" = "$want" ]; t "unsorted input gives the same bytes" $? ""

# consumers. This sed is the one in scripts/bothy.sh install_binary.
grep -q 's/^\\\\(\[0-9a-f\]\\\\{64\\\\}\\\\)  \$name\\\$/\\\\1/p' scripts/bothy.sh
t "bothy.sh still has the line parser this test mirrors" $? "parser changed: update this test"
for n in bothy_9.9.9_linux_amd64.tar.gz bothy_9.9.9_windows_amd64.zip; do
  got=$(sed -n "s/^\\([0-9a-f]\\{64\\}\\)  $n\$/\\1/p" "$W/r" | wc -l)
  [ "$got" = 1 ]; t "the installer's sed finds exactly one line for $n" $? "$got"
done
got=$(sed -n "s/^\\([0-9a-f]\\{64\\}\\)  bothy_9.9.9_linux_amd64.tar.gz\$/\\1/p" "$W/r")
[ "$got" = "$(h 1)" ]; t "and it is the right hash" $? "$got"
mkdir "$W/dl"
cp "$W/m.json" "$W/dl/release-manifest.json"
cp "$W/r" "$W/dl/checksums.txt"
sed -i '/bothy_/d' "$W/dl/checksums.txt"
(cd "$W/dl" && sha256sum -c checksums.txt >/dev/null 2>&1)
t "sha256sum -c accepts the manifest line" $? ""

# refusals leave the file untouched
refuse() { # label file manifest
  before=$(cat "$2" 2>/dev/null || echo none)
  o=$(bash $S "$2" "$3" 2>&1); r=$?
  after=$(cat "$2" 2>/dev/null || echo none)
  if [ "$r" != 0 ] && [ "$before" = "$after" ]; then ok "refuses $1"; else bad "refuses $1" "rc=$r $o"; fi
}
refuse "a missing checksums.txt" "$W/nope" "$W/m.json"
fixture "$W/e"
refuse "a missing manifest" "$W/e" "$W/nope.json"
: > "$W/empty"
refuse "an empty checksums.txt" "$W/empty" "$W/m.json"
: > "$W/m0.json"
refuse "an empty manifest" "$W/e" "$W/m0.json"
printf 'not a checksum line\n' > "$W/bad"
refuse "a malformed line" "$W/bad" "$W/m.json"
printf '%s bothy_x.tar.gz\n' "$(h 1)" > "$W/bad1"
refuse "one space instead of two" "$W/bad1" "$W/m.json"
printf '%s  bothy_x.tar.gz\n%s  bothy_x.tar.gz\n' "$(h 1)" "$(h 2)" > "$W/dup"
refuse "a duplicated archive" "$W/dup" "$W/m.json"
printf '%s  release-manifest.json\n' "$(h 1)" > "$W/only"
refuse "a file with only the manifest line (no archives)" "$W/only" "$W/m.json"
printf '%s  bothy_x.tar.gz' "$(h 1)" > "$W/nonl"
bash $S "$W/nonl" "$W/m.json" >/dev/null
t "a last line without a newline is accepted" $? ""
bash $S >/dev/null 2>&1
[ $? != 0 ]; t "no arguments is an error" $? ""
[ -z "$(find "$W" -name '.checksums*')" ]; t "no temp files left behind" $? "$(find "$W" -name '.checksums*')"

echo
if [ "$fails" -eq 0 ]; then echo "ok - append-manifest-checksum"; else echo "$fails problem(s)."; fi
exit $((fails > 0 ? 1 : 0))
