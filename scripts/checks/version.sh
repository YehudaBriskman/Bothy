#!/usr/bin/env bash
# VERSION and the newest git tag must agree.
#
# WHY A FILE AND NOT JUST `git describe`. `git describe` needs a git checkout
# with tags. A tarball from the Releases page has neither, and that is exactly
# how somebody who is not a contributor gets Bothy - so the version has to be
# readable from the tree itself. The file is the source of truth; the tag is how
# git and GitHub find it.
#
# TWO COPIES MEANS THEY CAN DISAGREE, which is what this checks. The failure is
# quiet and nasty: `bothy version` reports 2026.8.1 while the box is running
# 2026.9.2, so a bug report names the wrong release and the maintainer looks at
# the wrong code.
#
# ── the scheme, and why ─────────────────────────────────────────────────────
#
# YYYY.M.PATCH, e.g. 2026.8.1. It is a date, which is what actually matters for
# something you install and run - "how old is this box" is the question people
# ask, and `v0.4.2` cannot answer it.
#
# It is ALSO valid semver (2026.8.1 parses), which keeps dependabot, GitHub and
# every tag-sorting tool happy without anyone having to care. Zero-padding the
# month would break that, which is why it is `8` and not `08`.
#
# Bothy has no API, so strict semver would be theatre: there is no consumer to
# break, and a major bump would communicate nothing.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

fails=0
check() { if [ "$2" = ok ]; then printf 'PASS  %s\n' "$1"; else printf 'FAIL  %s  %s\n' "$1" "$3"; fails=$((fails+1)); fi; }

[ -f VERSION ] || { echo "FAIL  no VERSION file at the repo root"; exit 1; }
v=$(tr -d '[:space:]' < VERSION)

# The shape, checked before anything is compared - a malformed version makes
# every later message confusing.
case "$v" in
  [0-9][0-9][0-9][0-9].[0-9]*.[0-9]*) check "VERSION is YYYY.M.PATCH" ok ;;
  *) check "VERSION is YYYY.M.PATCH" no "got '$v'"; echo; echo "$fails problem(s)"; exit 1 ;;
esac

# A leading zero in the month is valid CalVer and INVALID semver, and the whole
# point of this scheme is being both.
case "$v" in
  [0-9][0-9][0-9][0-9].0*) check "the month has no leading zero (semver would reject it)" no "got '$v'" ;;
  *) check "the month has no leading zero (semver would reject it)" ok ;;
esac

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo
  echo "not a git checkout - VERSION is $v, and there is no tag to compare it to."
  exit $((fails > 0 ? 1 : 0))
fi

# The newest tag by version order, not by date: a patch tagged late must not
# outrank a later release.
newest=$(git tag --sort=-v:refname | head -1)

if [ -z "$newest" ]; then
  # NOT A FAILURE. A repo that has never released is a legitimate state, and
  # failing on it would block the very change that introduces versioning.
  echo "NOTE  no release tags yet - VERSION is $v; \`just release\` cuts the first"
else
  # NOT EQUALITY - "VERSION >= newest tag". Requiring them equal fails every time
  # somebody bumps VERSION in one commit and tags in the next, which is the
  # documented order and the whole reason `just release` refuses to do both.
  #
  # BEHIND is the real fault: a tag exists for a version the tree does not claim,
  # so a checkout at that tag reports something older than itself.
  top=$(printf '%s\nv%s\n' "$newest" "$v" | sort -V | tail -1)
  if [ "$top" = "v$v" ]; then
    if [ "$newest" = "v$v" ]; then
      check "VERSION matches the newest tag ($newest)" ok
    else
      echo "NOTE  VERSION is $v, newest tag is $newest - a release is pending"
    fi
  else
    check "VERSION is not behind the newest tag" no "VERSION=$v but $newest exists"
  fi
fi

echo
if [ "$fails" -eq 0 ]; then echo "ok - version $v"; else
  echo "$fails problem(s). VERSION is the source of truth; the tag must match it."
fi
exit $((fails > 0 ? 1 : 0))
