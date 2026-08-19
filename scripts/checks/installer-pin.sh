#!/usr/bin/env bash
# The installer's pinned release must be THIS release.
#
# scripts/bothy.sh is a `curl … | sh` installer, and its whole verification
# story is two lines near the top:
#
#   BOTHY_PIN_VERSION="v2026.8.1"
#   BOTHY_PIN_SHA="25d6ef4…"
#
# It clones, resolves that tag to a commit, and refuses to install anything if
# the commit is not that one. Which makes those two lines a THIRD copy of a fact
# already written down twice - in VERSION and in the git tag - and
# scripts/checks/version.sh exists because two copies can disagree. Three can
# disagree in more ways, and every one of them is silent:
#
#   · The SHA is stale or mistyped. Every install fails at the verify step, for
#     everybody, and the failure blames the repository ("the tag has been
#     moved") rather than this file. Nothing in the tree looks wrong.
#   · A release is cut and the pin is not updated. `curl | sh` keeps installing
#     the OLD release, indefinitely and silently - the install succeeds, verifies
#     and is simply not what the project ships. This is the drift that matters,
#     because nothing anywhere fails.
#   · The pin is bumped ahead of VERSION. The installer distributes a release the
#     tree does not claim to be.
#
# WHY IT IS A SIBLING OF cli-commands.sh AND NOT PART OF IT. That check skips
# itself, out loud, when `just` is absent, because it cannot resolve recipes
# without it. This one needs nothing but git and must never be skipped for a
# reason that has nothing to do with what it guards.
#
# THE ORDER THIS ASSUMES, which is the release procedure with one step added:
#   1. edit VERSION, commit          (version.sh: "a release is pending")
#   2. `just release` tags it        (version.sh: they now match)
#   3. update the pin here, commit   (this check: they now match)
# Between 2 and 3 this check is RED on purpose - that is the window in which the
# installer serves the wrong release, and it is meant to be short and loud.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

INSTALLER=scripts/bothy.sh
fails=0
check() { if [ "$2" = ok ]; then printf 'PASS  %s\n' "$1"; else printf 'FAIL  %s  %s\n' "$1" "$3"; fails=$((fails+1)); fi; }

[ -f "$INSTALLER" ] || { echo "FAIL  $INSTALLER is missing"; exit 1; }
[ -f VERSION ]      || { echo "FAIL  no VERSION file at the repo root"; exit 1; }

v=$(tr -d '[:space:]' < VERSION)
pin_version=$(sed -n 's/^BOTHY_PIN_VERSION="\(.*\)"$/\1/p' "$INSTALLER" | head -1)
pin_sha=$(sed -n 's/^BOTHY_PIN_SHA="\(.*\)"$/\1/p' "$INSTALLER" | head -1)

# READ, NOT SOURCED. `.` on the installer would run it - it ends in `main "$@"`,
# which clones a repository into $HOME. A check must not be able to install
# anything.
if [ -z "$pin_version" ] || [ -z "$pin_sha" ]; then
  echo "FAIL  could not read BOTHY_PIN_VERSION / BOTHY_PIN_SHA out of $INSTALLER"
  echo "      They must stay one plain assignment per line - this check parses them."
  exit 1
fi

# Shape first. A malformed pin makes every comparison below confusing, and a
# truncated SHA would compare unequal for a reason nobody would guess.
case "$pin_version" in
  v[0-9][0-9][0-9][0-9].[0-9]*.[0-9]*) check "the pinned version is vYYYY.M.PATCH" ok ;;
  *) check "the pinned version is vYYYY.M.PATCH" no "got '$pin_version'" ;;
esac
case "$pin_sha" in
  # 40 hex, lower case: `git rev-parse` prints it that way, so an upper-case or
  # abbreviated value would never match at run time however correct it looks.
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) \
    check "the pinned commit is a full 40-hex sha" ok ;;
  *) check "the pinned commit is a full 40-hex sha" no "got '$pin_sha'" ;;
esac

# ── the pin against VERSION ─────────────────────────────────────────────────
#
# NOT EQUALITY, for the reason version.sh gives: VERSION is bumped in one commit
# and tagged in the next, so requiring them equal would fail the very commit that
# starts a release. AHEAD is the fault - a pin naming a release newer than the
# tree claims to be means somebody edited this pin without bumping VERSION.
top=$(printf '%s\n%s\n' "$pin_version" "v$v" | sort -V | tail -1)
if [ "$top" = "v$v" ]; then
  check "the pin is not ahead of VERSION ($v)" ok
else
  check "the pin is not ahead of VERSION ($v)" no "pin is $pin_version, VERSION is $v"
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo
  echo "not a git checkout - the pin says $pin_version, and there is no tag to resolve it against."
  exit $((fails > 0 ? 1 : 0))
fi

# ── the pin against the tags ────────────────────────────────────────────────
tagged=$(git rev-parse --quiet --verify "$pin_version^{commit}" 2>/dev/null)
if [ -z "$tagged" ]; then
  if [ -z "$(git tag)" ]; then
    # A checkout with no tags at all is a shallow clone, not a broken pin. Said
    # out loud rather than passed silently: a check that quietly stops checking
    # is the failure this repo has a whole file (mutants.sh) about.
    echo "NOTE  no tags in this checkout - cannot resolve $pin_version. Fetch tags to check the sha."
  else
    check "$pin_version exists as a tag" no "the installer pins a tag this repo does not have"
  fi
else
  if [ "$tagged" = "$pin_sha" ]; then
    check "the pinned sha is the commit $pin_version names" ok
  else
    check "the pinned sha is the commit $pin_version names" no "$pin_version is $tagged, the pin says $pin_sha"
  fi

  # Has a release been cut that the installer does not serve? The tag for
  # VERSION existing is what makes step 3 of the procedure overdue rather than
  # pending - before that there is nothing to pin to.
  if [ "$pin_version" != "v$v" ]; then
    if git rev-parse --quiet --verify "v$v^{commit}" >/dev/null 2>&1; then
      check "the pin serves the released VERSION" no "v$v is tagged but the installer still serves $pin_version"
    else
      echo "NOTE  VERSION is $v and the installer serves $pin_version - a release is pending;"
      echo "      update the pin after \`just release\` tags v$v"
    fi
  else
    check "the pin serves the released VERSION" ok
  fi
fi

# ── the claim the installer's own header makes ──────────────────────────────
#
# "It never uses sudo" is in the usage text people read before piping this into
# a shell, and it is the one property that cannot be walked back later without
# somebody noticing. Matched at COMMAND position only - the word appears four
# times in that file explaining why it is absent, and a check that cannot tell a
# sentence about sudo from a call to it would be un-passable.
if grep -nE '(^|[;&|(]|&&|\|\|)[[:space:]]*sudo[[:space:]]' "$INSTALLER" >/dev/null 2>&1; then
  check "the installer calls no sudo" no "$(grep -nE '(^|[;&|(]|&&|\|\|)[[:space:]]*sudo[[:space:]]' "$INSTALLER" | head -1)"
else
  check "the installer calls no sudo" ok
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "ok - the installer serves $pin_version"
else
  echo "$fails problem(s). scripts/bothy.sh is what \`curl | sh\` runs; a stale pin"
  echo "there installs the wrong release, or nothing at all, and says so to nobody."
fi
exit $((fails > 0 ? 1 : 0))
