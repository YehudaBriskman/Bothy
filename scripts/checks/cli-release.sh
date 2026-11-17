#!/usr/bin/env bash
# The CLI release path must build the same bytes twice, run, and REFUSE tampering.
#
# Four claims, each one a way a release can quietly be wrong:
#   1. scripts/build-cli.sh is reproducible - two builds, identical checksums.txt.
#      (A binary that changes by itself cannot be rebuilt and compared.)
#   2. the archive extracts to one file that runs and reports VERSION and the commit.
#   3. `sh scripts/bothy.sh --binary` installs it when the pinned checksum matches.
#   4. it installs NOTHING when: the archive is tampered, checksums.txt is
#      replaced (pin mismatch), no checksum is pinned, or the target is the
#      shell-script CLI. A verification that cannot refuse is not one
#      (same argument as mutants.sh and the installer job in install.yml).
#
# Builds three targets, not six, to stay quick. Needs go, python3 and GNU tar;
# SKIPs out loud without them. Linux hosts only for the run steps.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

for c in go python3 curl; do
  command -v "$c" >/dev/null 2>&1 || { echo "SKIP  $c is not installed - cannot test the CLI release path"; exit 0; }
done
tar --version 2>/dev/null | grep -q 'GNU tar' || { echo "SKIP  GNU tar is not installed"; exit 0; }

fails=0
check() { if [ "$2" = ok ]; then printf 'PASS  %s\n' "$1"; else printf 'FAIL  %s  %s\n' "$1" "$3"; fails=$((fails+1)); fi; }

W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
V=$(tr -d '[:space:]' < VERSION)
TARGETS="linux/amd64 linux/arm64 windows/amd64"

# ── 1. reproducible ─────────────────────────────────────────────────────────
bash scripts/build-cli.sh --out "$W/a" --targets "$TARGETS" >"$W/a.log" 2>&1 || { tail "$W/a.log"; check "build 1" no "failed"; exit 1; }
# Second build from a different working directory: paths must not leak in.
(cd "$W" && bash "$OLDPWD/scripts/build-cli.sh" --out "$W/b" --targets "$TARGETS") >"$W/b.log" 2>&1 || { tail "$W/b.log"; check "build 2" no "failed"; exit 1; }
if cmp -s "$W/a/checksums.txt" "$W/b/checksums.txt"; then
  check "two builds give an identical checksums.txt ($(wc -l < "$W/a/checksums.txt") archives)" ok
else
  check "two builds give an identical checksums.txt" no "$(diff "$W/a/checksums.txt" "$W/b/checksums.txt" | head -4)"
fi
for t in linux_amd64.tar.gz linux_arm64.tar.gz windows_amd64.zip; do
  [ -f "$W/a/bothy_${V}_$t" ] && check "bothy_${V}_$t exists" ok || check "bothy_${V}_$t exists" no "missing"
done
(cd "$W/a" && { sha256sum -c checksums.txt >/dev/null 2>&1 || shasum -a 256 -c checksums.txt >/dev/null 2>&1; }) \
  && check "checksums.txt verifies with sha256sum -c" ok || check "checksums.txt verifies with sha256sum -c" no "mismatch"

# ── 2. it runs ──────────────────────────────────────────────────────────────
if [ "$(uname -s)" != Linux ]; then
  echo "SKIP  run and install steps need a Linux host"
  exit $((fails > 0 ? 1 : 0))
fi
case "$(uname -m)" in x86_64) A=amd64 ;; aarch64) A=arm64 ;; *) echo "SKIP  unsupported host arch"; exit 0 ;; esac
ARCHIVE="bothy_${V}_linux_${A}.tar.gz"
mkdir "$W/x" && tar -xzf "$W/a/$ARCHIVE" -C "$W/x"
[ "$(ls "$W/x")" = bothy ] && check "the archive holds exactly one file, bothy" ok || check "the archive holds exactly one file, bothy" no "$(ls "$W/x")"
out=$("$W/x/bothy" version 2>&1 || true)
commit=$(git rev-parse HEAD 2>/dev/null || echo)
case "$out" in
  *"bothy $V (commit ${commit:0:12},"*) check "bothy version shows $V and the commit" ok ;;
  *) check "bothy version shows $V and the commit" no "$out" ;;
esac
file "$W/x/bothy" 2>/dev/null | grep -q 'statically linked' && check "the binary is statically linked" ok \
  || { command -v file >/dev/null 2>&1 && check "the binary is statically linked" no "$(file "$W/x/bothy")"; }

# ── 3 and 4. the installer ──────────────────────────────────────────────────
SUMS=$(sha256sum "$W/a/checksums.txt" | cut -d' ' -f1)
inst() { # inst <home> <extra env as KEY=VAL...> -- <args>; prints output, returns rc
  h=$1; shift
  env HOME="$h" XDG_CONFIG_HOME="$h/.config" BOTHY_RELEASE_URL="file://$REL" "$@"
}
REL="$W/a"
H="$W/home with space"; mkdir -p "$H"

out=$(inst "$H" BOTHY_CHECKSUMS_SHA256="$SUMS" BOTHY_VERSION="v$V" sh scripts/bothy.sh --binary 2>&1) && rc=0 || rc=$?
if [ "$rc" = 0 ] && [ -x "$H/.local/bin/bothy" ] && cmp -s "$H/.local/bin/bothy" "$W/x/bothy"; then
  check "--binary installs the verified binary, byte for byte" ok
else
  check "--binary installs the verified binary, byte for byte" no "rc=$rc $out"
fi
[ -z "$(find "$H" -mindepth 1 -not -path "$H/.local*" | head -1)" ] \
  && check "it wrote only under ~/.local/bin" ok || check "it wrote only under ~/.local/bin" no "$(find "$H" -mindepth 1 | head -5)"

refuse() { # refuse <label> <dir that must stay empty> <expected text> -- cmd...
  label=$1; dir=$2; want=$3; shift 3
  o=$("$@" 2>&1) && r=0 || r=$?
  if [ "$r" != 0 ] && printf '%s' "$o" | grep -q "$want" && [ ! -e "$dir/.local/bin/bothy" ]; then
    check "refused: $label" ok
  else
    check "refused: $label" no "rc=$r installed=$([ -e "$dir/.local/bin/bothy" ] && echo yes || echo no) :: $(printf '%s' "$o" | tail -3)"
  fi
}

# The REAL release's checksums.txt is the final one: the archives plus a
# release-manifest.json line, added by scripts/append-manifest-checksum.sh. The
# pin is the hash of THAT file. The extra line must not disturb the installer,
# and the pin of the earlier, line-less file must no longer verify.
mkdir "$W/fin"; cp "$W/a"/* "$W/fin/"; printf '{"schema":1}\n' > "$W/fin/release-manifest.json"
bash scripts/append-manifest-checksum.sh "$W/fin/checksums.txt" "$W/fin/release-manifest.json" >/dev/null
FSUMS=$(sha256sum "$W/fin/checksums.txt" | cut -d' ' -f1)
(cd "$W/fin" && sha256sum -c checksums.txt >/dev/null 2>&1) \
  && check "the final checksums.txt (with the manifest line) verifies with sha256sum -c" ok \
  || check "the final checksums.txt (with the manifest line) verifies with sha256sum -c" no "mismatch"
HF="$W/hf"; mkdir "$HF"
out=$(env HOME="$HF" XDG_CONFIG_HOME="$HF/.config" BOTHY_RELEASE_URL="file://$W/fin" BOTHY_CHECKSUMS_SHA256="$FSUMS" BOTHY_VERSION="v$V" sh scripts/bothy.sh --binary 2>&1) && rc=0 || rc=$?
if [ "$rc" = 0 ] && cmp -s "$HF/.local/bin/bothy" "$W/x/bothy"; then
  check "--binary installs from a checksums.txt that carries the manifest line" ok
else
  check "--binary installs from a checksums.txt that carries the manifest line" no "rc=$rc $out"
fi
HG="$W/hg"; mkdir "$HG"
refuse "a pin of the earlier checksums.txt against the final one" "$HG" "VERIFICATION FAILED" \
  env HOME="$HG" XDG_CONFIG_HOME="$HG/.config" BOTHY_RELEASE_URL="file://$W/fin" BOTHY_CHECKSUMS_SHA256="$SUMS" BOTHY_VERSION="v$V" sh scripts/bothy.sh --binary

# tampered archive, checksums.txt untouched
mkdir "$W/t1"; cp "$W/a"/* "$W/t1/"; printf 'x' >> "$W/t1/$ARCHIVE"
H1="$W/h1"; mkdir "$H1"; REL="$W/t1"
refuse "a tampered archive" "$H1" "VERIFICATION FAILED" \
  env HOME="$H1" XDG_CONFIG_HOME="$H1/.config" BOTHY_RELEASE_URL="file://$W/t1" BOTHY_CHECKSUMS_SHA256="$SUMS" BOTHY_VERSION="v$V" sh scripts/bothy.sh --binary

# checksums.txt rewritten to match the tampered archive: the pin catches it
new=$(sha256sum "$W/t1/$ARCHIVE" | cut -d' ' -f1)
sed "s/^[0-9a-f]\{64\}  $ARCHIVE\$/$new  $ARCHIVE/" "$W/a/checksums.txt" > "$W/t1/checksums.txt"
H2="$W/h2"; mkdir "$H2"
refuse "checksums.txt that does not match the pin" "$H2" "VERIFICATION FAILED" \
  env HOME="$H2" XDG_CONFIG_HOME="$H2/.config" BOTHY_RELEASE_URL="file://$W/t1" BOTHY_CHECKSUMS_SHA256="$SUMS" BOTHY_VERSION="v$V" sh scripts/bothy.sh --binary

# nothing pinned for this version
H3="$W/h3"; mkdir "$H3"
refuse "a version with no pinned checksum" "$H3" "no CLI checksum is pinned" \
  env HOME="$H3" XDG_CONFIG_HOME="$H3/.config" BOTHY_RELEASE_URL="file://$W/a" BOTHY_VERSION="v$V.1" sh scripts/bothy.sh --binary

# will not overwrite the shell-script CLI
H4="$W/h4"; mkdir -p "$H4/.local/bin"; printf '#!/bin/bash\necho old\n' > "$H4/.local/bin/bothy"
o=$(env HOME="$H4" XDG_CONFIG_HOME="$H4/.config" BOTHY_RELEASE_URL="file://$W/a" BOTHY_CHECKSUMS_SHA256="$SUMS" BOTHY_VERSION="v$V" sh scripts/bothy.sh --binary 2>&1) && r=0 || r=$?
if [ "$r" != 0 ] && grep -q 'echo old' "$H4/.local/bin/bothy"; then check "refused: replacing the shell-script CLI" ok; else check "refused: replacing the shell-script CLI" no "rc=$r $o"; fi

# --bin-dir outside $HOME
o=$(env HOME="$H4" BOTHY_RELEASE_URL="file://$W/a" sh scripts/bothy.sh --binary --bin-dir /usr/local/bin 2>&1) && r=0 || r=$?
[ "$r" != 0 ] && check "refused: --bin-dir outside \$HOME" ok || check "refused: --bin-dir outside \$HOME" no "$o"

echo
if [ "$fails" -eq 0 ]; then echo "ok - the CLI release path builds reproducibly, runs, and refuses tampering"; else echo "$fails problem(s)."; fi
exit $((fails > 0 ? 1 : 0))
