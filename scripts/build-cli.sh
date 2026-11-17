#!/usr/bin/env bash
# build-cli.sh - build the `bothy` CLI release archives, reproducibly.
#
#   scripts/build-cli.sh                     all targets into ./dist
#   scripts/build-cli.sh --out DIR           somewhere else (must not exist, or be empty)
#   scripts/build-cli.sh --targets "linux/amd64 darwin/arm64"
#
# Produces, per target, dist/bothy_<version>_<os>_<arch>.tar.gz (.zip on
# windows) holding ONE file - `bothy` (`bothy.exe`) - and dist/checksums.txt in
# `sha256sum -c` format. <version> is VERSION without the `v`, the way
# GoReleaser, `mise` and `ubi` expect it (docs/plans/thin-bothy/
# cli-and-control-plane.md, D22 and D27).
#
# WHY A SCRIPT AND NOT GORELEASER. Six targets, one binary, one checksum file:
# about a page of shell, no tool to pin, and it runs offline on a laptop - which
# is what lets a person rebuild a release and compare it with the published one.
# GoReleaser earns its keep with packages (nfpm, brew, scoop), which are LATER.
#
# REPRODUCIBLE, and checked (scripts/checks/cli-release.sh builds twice):
#   * CGO_ENABLED=0 -trimpath -buildvcs=false: no host paths, no VCS stamp, no libc;
#   * version and commit come in through -ldflags -X, never from the environment
#     of the build host;
#   * every archive timestamp is SOURCE_DATE_EPOCH (default: the commit's time),
#     entries sorted, owner 0, no gzip name/mtime header, zip date fixed.
# Needs GNU tar (the CI runner and WSL have it; macOS ships bsdtar - use `gtar`).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

OUT=dist
TARGETS="linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64"

die() { echo "build-cli: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || die "--out needs a directory"; OUT=$2; shift ;;
    --targets) [ $# -ge 2 ] || die "--targets needs a list"; TARGETS=$2; shift ;;
    -h|--help) sed -n 2,12p "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

command -v go >/dev/null 2>&1 || die "go is not on PATH"
command -v python3 >/dev/null 2>&1 || die "python3 is needed for the zip archives"
tar --version 2>/dev/null | grep -q 'GNU tar' || die "GNU tar is needed (--sort, --mtime); on macOS use gtar"

[ -f VERSION ] || die "no VERSION file"
VERSION=$(tr -d '[:space:]' < VERSION)
case "$VERSION" in
  [0-9][0-9][0-9][0-9].[0-9]*.[0-9]*) ;;
  *) die "VERSION '$VERSION' is not YYYY.M.PATCH" ;;
esac

COMMIT=${BOTHY_COMMIT:-$(git rev-parse HEAD 2>/dev/null || true)}
[ -n "$COMMIT" ] || die "no commit: not a git checkout and BOTHY_COMMIT is unset"
EPOCH=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct "$COMMIT" 2>/dev/null || true)}
[ -n "$EPOCH" ] || die "no timestamp: set SOURCE_DATE_EPOCH"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  die "$OUT exists and is not empty; remove it or pass --out"
fi
mkdir -p "$OUT" || die "cannot create $OUT"
OUT=$(cd "$OUT" && pwd)
STAGE=$(mktemp -d) || die "mktemp failed"
trap 'rm -rf "$STAGE"' EXIT

LDFLAGS="-s -w -X main.version=$VERSION -X main.commit=$COMMIT"

for t in $TARGETS; do
  os=${t%/*}
  arch=${t#*/}
  [ "$os" != "$t" ] || die "bad target '$t' (want os/arch)"
  bin=bothy
  [ "$os" = windows ] && bin=bothy.exe
  d="$STAGE/$os-$arch"
  mkdir -p "$d"
  echo "== $os/$arch"
  # CGO_ENABLED, GOOS, GOARCH, GOFLAGS and GOWORK are set for this one command;
  # nothing from the caller's environment can change the output. GOTOOLCHAIN is
  # left alone: the toolchain is cli/go.mod's business.
  (cd cli && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" GOFLAGS=-mod=readonly GOWORK=off \
     go build -trimpath -buildvcs=false -ldflags "$LDFLAGS" -o "$d/$bin" ./cmd/bothy) \
    || die "go build failed for $os/$arch"
  chmod 0755 "$d/$bin"
  touch -d "@$EPOCH" "$d/$bin"

  name="bothy_${VERSION}_${os}_${arch}"
  if [ "$os" = windows ]; then
    python3 -I - "$d/$bin" "$OUT/$name.zip" "$EPOCH" "$bin" <<'PY' || die "zip failed for $os/$arch"
import sys, time, zipfile
src, dst, epoch, arc = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
y, mo, d, h, mi, s = time.gmtime(max(epoch, 315532800))[:6]
zi = zipfile.ZipInfo(arc, (y, mo, d, h, mi, s - s % 2))
zi.compress_type = zipfile.ZIP_DEFLATED
zi.external_attr = 0o755 << 16
zi.create_system = 3
with zipfile.ZipFile(dst, "w") as z, open(src, "rb") as f:
    z.writestr(zi, f.read(), compresslevel=9)
PY
  else
    (cd "$d" && tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner \
        --format=gnu -cf - "$bin" | gzip -n -9 > "$OUT/$name.tar.gz") \
      || die "tar failed for $os/$arch"
  fi
done

# Sorted by file name and in `sha256sum -c` format, so the checksum file is as
# reproducible as the archives it lists. Relative names, no paths.
(cd "$OUT" && sha256 bothy_"${VERSION}"_* | LC_ALL=C sort -k2 > checksums.txt) || die "checksums failed"
echo "== $OUT"
cat "$OUT/checksums.txt"
