#!/bin/sh
# The Bothy installer - the half of the CLI you cannot get by having the repo.
#
#   curl -fsSL https://raw.githubusercontent.com/YehudaBriskman/Bothy/main/scripts/bothy.sh -o bothy.sh
#   less bothy.sh          # it is short, and it names every path it writes
#   sh bothy.sh
#
# The pipe works too - `curl -fsSL … | sh` - and it is the convenience, not the
# documented path. That order is deliberate: this ends with a program that holds
# a Docker socket, and SECURITY.md spends a section on exactly how large that
# blast radius is.
#
# ── what it does, and pointedly what it does not ────────────────────────────
#
# scripts/bothy is the CLI. It is excellent at everything AFTER you have a
# checkout, and unreachable before - which is the chicken-and-egg its own header
# says it exists to break, and which it cannot break on its own because you have
# to clone the repo to get it. This file is the missing first step and NOTHING
# MORE:
#
#   clone at a pinned release  ->  verify the commit  ->  put `bothy` on PATH
#
# It does not start a container, generate a secret, install `just`, or write
# outside $HOME. `bothy init` does all of that, and this script PRINTS that
# command rather than running it. See "why it stops" below - that is the single
# most consequential decision in this file.
#
# ── POSIX sh, and why `set -o pipefail` is missing ──────────────────────────
#
# The house pattern in scripts/ is `set -uo pipefail`, and it is wrong here.
# `curl … | sh` runs this under whatever /bin/sh is, which on Debian and Ubuntu
# is dash - and dash answers `set -o pipefail` with
#
#   set: Illegal option -o pipefail
#
# and exits 2 on LINE ONE. An installer that dies on its first line, with a
# message about an option nobody typed, is the worst possible first contact.
# So: `set -u` only, no bashisms at all, and every command whose failure matters
# is checked explicitly rather than by a shell option. The same rule that makes
# scripts/bothy avoid bash 4 syntax (macOS ships bash 3.2) applies here twice
# over - shellcheck runs this file as `sh`, which is what keeps it honest.
set -u

# ── the pin ─────────────────────────────────────────────────────────────────
#
# THIS IS THE VERIFICATION. Two lines, and scripts/checks/installer-pin.sh
# refuses to let them drift from VERSION and the tag.
#
# WHY A COMMIT SHA AND NOT A CHECKSUM, which is what the issue first asked for:
#
#   · The published release carries ZERO assets. There is no tarball of ours to
#     checksum, so a SHA-256 line here would have to be computed over something
#     GitHub generates.
#   · GitHub's auto-generated source tarballs are NOT byte-stable. They are
#     produced by `git archive` on demand, and its output has changed with git
#     versions and with the default compression - projects that published a
#     checksum for one have had it go wrong under them without a single commit
#     landing. A checksum that changes by itself is worse than none: it trains
#     everyone to skip the verification.
#   · A git commit id IS a checksum, over the whole tree and its history, and
#     git verifies it on every object it writes. `git rev-parse "$VER^{commit}"`
#     against a value baked in here is therefore the same guarantee, computed by
#     the tool rather than by us.
#   · It costs no new dependency. `bothy init` already requires git, so cloning
#     adds nothing to the prerequisite list.
#
# WHAT IT DOES AND DOES NOT PROVE. It proves the tree you are about to run is
# the exact tree this file was published against - a substituted or rewritten
# tag cannot match. It proves nothing about whether THIS FILE is genuine; that
# is what reading it before running it is for.
BOTHY_PIN_VERSION="v2026.8.1"
BOTHY_PIN_SHA="25d6ef4fcdac878fcadd497097d30e2d7f75cab8"

# ── settings ────────────────────────────────────────────────────────────────
#
# Every one of these is an override for an existing default, so the no-argument
# path is the whole documented install.
#
#   BOTHY_VERSION   pin to another release, e.g. BOTHY_VERSION=v2026.8.1
#   BOTHY_SHA       the commit to require for it (see resolve_version)
#   BOTHY_DIR       where the checkout goes. Must be inside $HOME
#   BOTHY_REPO_URL  the clone source. CI points this at a local path
REPO_URL="${BOTHY_REPO_URL:-https://github.com/YehudaBriskman/Bothy.git}"
DIR="${BOTHY_DIR:-$HOME/bothy}"
BIN_DIR="$HOME/.local/bin"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/bothy/config"

DRY_RUN=0
CREATED_DIR=0

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
say() { printf '%s\n' "$*"; }
die() {
  red "$*"
  # A half-finished install is worth saying out loud: the clone is the only
  # thing this script can leave behind, and a silent one is a directory the
  # next run refuses to reuse for reasons nobody can see.
  if [ "$CREATED_DIR" = 1 ] && [ -d "$DIR" ]; then
    say "The checkout at $DIR was left in place. Remove it if you are starting over."
  fi
  exit 1
}

usage() {
  cat <<'EOF'
bothy.sh - install the `bothy` CLI from a pinned release

  sh bothy.sh              clone the pinned release into ~/bothy and put
                           `bothy` in ~/.local/bin
  sh bothy.sh --dry-run    say exactly what that would do, and touch nothing
  sh bothy.sh --help       this

It never uses sudo, never writes outside $HOME, and never starts anything -
it prints the `bothy init` command instead of running it.

  BOTHY_VERSION   install another release tag (the commit is then unverified
                  unless BOTHY_SHA is given too)
  BOTHY_SHA       the commit that tag must resolve to
  BOTHY_DIR       where to put the checkout (default ~/bothy, must be in $HOME)
  BOTHY_REPO_URL  clone from somewhere else
EOF
}

# ── the prerequisites this script needs FOR ITSELF ──────────────────────────
#
# Three, not seven. The full list - docker with the compose plugin, git, curl,
# python3, openssl - lives in check_prereqs() in scripts/bothy, and this script
# DELEGATES to it (`bothy doctor --pre`) once the clone exists rather than
# repeating it here.
#
# That is the whole reason to clone before checking: a second copy of the list
# is the failure this repo has paid for repeatedly - four dead compose files,
# dependabot entries for deleted directories - and a prerequisite list that
# disagrees with itself sends people to install the wrong thing. The cost of the
# order is one clone (~20 MB, in $HOME, removable) on a box that turns out to
# have no docker, and the message says where it is.
#
# git, curl and bash are the exception because this script cannot do its own job
# without them: git to clone, curl because that is how you got this file and how
# `bothy init` fetches `just`, and bash because scripts/bothy is a bash script -
# running it under dash to ask for the rest of the list would fail on its
# `set -o pipefail` and report a prerequisite problem that is not one.
need_min() {
  missing=""
  for c in git curl bash; do
    command -v "$c" >/dev/null 2>&1 || missing="$missing $c"
  done
  [ -z "$missing" ] || die "missing:$missing - this installer needs git, curl and bash before it can fetch anything"
}

# ── which release ───────────────────────────────────────────────────────────
#
# THE DEFAULT IS THE PIN, NOT "whatever /releases/latest says today", and that
# is not laziness about an API call. Resolving "latest" at run time means
# installing a commit whose id this file cannot know, which is precisely the
# thing the pin exists to check - the verification would have to be dropped for
# the default path and kept only for the unusual one. So "latest" is baked in,
# and scripts/checks/installer-pin.sh is what keeps it latest: the moment
# VERSION names a release the pin does not, CI is red.
#
# An explicit BOTHY_VERSION is honoured for pinning to an older release. It is
# UNVERIFIED unless BOTHY_SHA is given with it, and it says so loudly - the
# alternative, silently skipping the check for any version but one, is a
# verification that reads as present and is not.
resolve_version() {
  VER="${BOTHY_VERSION:-$BOTHY_PIN_VERSION}"
  WANT_SHA="${BOTHY_SHA:-}"
  if [ -z "$WANT_SHA" ] && [ "$VER" = "$BOTHY_PIN_VERSION" ]; then
    WANT_SHA="$BOTHY_PIN_SHA"
  fi
}

# ── nothing outside $HOME ───────────────────────────────────────────────────
#
# Not a style rule. This is a script people are invited to pipe into a shell,
# and "what can it touch" has to be answerable by reading it: three paths, all
# under $HOME, no sudo anywhere in the file. A BOTHY_DIR pointing at /opt or
# /usr/local would need a privilege this script deliberately never asks for, and
# would half-succeed - the clone as your user, then a permission error.
inside_home() {
  case "$1" in
    "$HOME"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# ── the download, and the check ─────────────────────────────────────────────
fetch_and_verify() {
  if [ -e "$DIR/.git" ]; then
    # Reusing a checkout rather than refusing: re-running the installer is the
    # documented way to refresh the CLI copy in ~/.local/bin, and the verify
    # below still has to pass, so a tampered-with reuse is caught rather than
    # trusted.
    say "== reusing the checkout at $DIR =="
    git -C "$DIR" fetch --quiet --tags origin || die "could not fetch from origin in $DIR"
  elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    die "$DIR exists and is not empty, and is not a git checkout. Set BOTHY_DIR to somewhere else."
  else
    say "== cloning $REPO_URL =="
    git clone --quiet "$REPO_URL" "$DIR" || die "clone failed"
    CREATED_DIR=1
  fi

  # `^{commit}` and not the bare tag: an annotated tag is its own object with
  # its own id, so comparing that id against a commit id fails for a tag that is
  # perfectly correct. v2026.8.1 is annotated (`just release` uses `git tag -a`),
  # which is exactly the case that would break.
  got=$(git -C "$DIR" rev-parse "$VER^{commit}" 2>/dev/null) \
    || die "$VER is not a tag in $REPO_URL - check BOTHY_VERSION"

  if [ -n "$WANT_SHA" ]; then
    if [ "$got" != "$WANT_SHA" ]; then
      # The clone is untrusted from here on, so it goes - but only if THIS run
      # created it. Deleting a directory the user already had, because a version
      # they asked for did not match, would be a data loss bug in an installer.
      if [ "$CREATED_DIR" = 1 ]; then
        rm -rf "$DIR"
        CREATED_DIR=0
      fi
      red "VERIFICATION FAILED"
      say "  $VER should be $WANT_SHA"
      say "  it is        $got"
      say ""
      say "Nothing was installed. Either this installer is out of date for the"
      say "repository it fetched, or the tag has been moved - do not run the"
      say "checkout until you know which."
      exit 1
    fi
    say "  verified $VER = $got"
  else
    say "  $VER = $got  (UNVERIFIED - no BOTHY_SHA given for a non-default version)"
  fi

  # Land the working tree ON the release, and stay on a branch while doing it.
  # `git checkout <tag>` would detach HEAD, and `bothy upgrade` then runs
  # `git pull --ff-only` against a detached HEAD and fails with "the checkout
  # has local changes or has diverged" - a message that names the wrong cause
  # and sends whoever reads it looking for a change they did not make.
  #
  # `checkout -B` and not `reset --hard`: on a reused checkout a hard reset
  # discards whatever the person had edited in it, silently, as a side effect of
  # re-running an installer. checkout refuses instead, and the refusal is the
  # correct outcome - it is their change, not ours to throw away.
  branch=$(git -C "$DIR" symbolic-ref --quiet --short HEAD 2>/dev/null)
  [ -n "$branch" ] || branch=main
  git -C "$DIR" checkout --quiet -B "$branch" "$got" \
    || die "could not put $DIR on $branch at $got - it may have uncommitted changes"
}

# ── the CLI ─────────────────────────────────────────────────────────────────
install_cli() {
  mkdir -p "$BIN_DIR" || die "cannot create $BIN_DIR"
  # A COPY, not a symlink into the checkout. A symlink would silently break the
  # `bothy` command the day somebody moves or deletes ~/bothy, and the error is
  # "command not found" for a program they can see in their PATH. The cost is
  # that `bothy upgrade` refreshes the checkout and not this copy; re-running
  # this installer is what refreshes the copy, and the summary below says so.
  cp "$DIR/scripts/bothy" "$BIN_DIR/bothy" || die "could not write $BIN_DIR/bothy"
  chmod +x "$BIN_DIR/bothy" || die "could not make $BIN_DIR/bothy executable"

  # The same warning ensure_just() prints in scripts/bothy, in the same words -
  # two different wordings for one situation is how somebody concludes they are
  # two different problems.
  case ":${PATH:-}:" in
    *":$BIN_DIR:"*) ;;
    *) say "  installed. Add ~/.local/bin to your PATH to keep it." ;;
  esac

  # `init` writes this too, and writing it here means the CLI can find the
  # checkout from any directory the moment it is installed. Without it,
  # `bothy version` from anywhere but inside ~/bothy answers "no checkout found"
  # one second after a successful install.
  mkdir -p "$(dirname "$CONFIG")" || die "cannot create $(dirname "$CONFIG")"
  printf 'BOTHY_HOME=%s\n' "$DIR" > "$CONFIG" || die "cannot write $CONFIG"
}

# ── why it stops here ───────────────────────────────────────────────────────
#
# IT PRINTS `bothy init`; IT DOES NOT RUN IT. The tempting version of this
# script ends with a running box, and it is the wrong one:
#
#   · `bothy init` runs `just up`, which starts ~26 containers, one of which
#     reaches a Docker socket - root-equivalent on the machine, as SECURITY.md
#     says in the first line of its socket-proxy section. A pipe from a URL to
#     `sh` should not be able to reach that in one step.
#   · `init` also installs `just` by piping ANOTHER remote installer into bash.
#     One curl|sh implying a second, unmentioned one is exactly the property
#     that makes people distrust the pattern, and they are right.
#   · `just up` writes .env, generates five secrets, and creates docker volumes.
#     Undoing that is `just nuke`, which deletes data volumes. Everything this
#     script does is undone by deleting two paths.
#
# The stopping point is chosen so the destructive half is a command a person
# typed, on a machine where they can already read the code that will run - it is
# in ~/bothy by then, at a verified commit. That is a materially different act
# from a pipe, and it costs one line of typing.
next_steps() {
  say ""
  say "== installed =="
  say "  $BIN_DIR/bothy      the CLI"
  say "  $DIR                the checkout, at $VER"
  say "  $CONFIG"
  say ""
  say "Nothing is running yet, and nothing has been started for you. Next:"
  say ""
  say "  bothy init $DIR"
  say ""
  say "That installs \`just\`, writes .env, generates this box's secrets and"
  say "brings the stack up. Read $DIR/scripts/bothy first if you would rather"
  say "see what that means - it is now on disk, at a commit you have verified."
  say ""
  say "Re-run this installer to refresh $BIN_DIR/bothy after an upgrade."
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      -h|--help) usage; exit 0 ;;
      *) red "unknown option: $1"; say ""; usage; exit 1 ;;
    esac
    shift
  done

  [ -n "${HOME:-}" ] || die "HOME is not set - this installer writes only inside it and cannot find it"
  # `sudo sh bothy.sh` leaves root-owned files in the invoking user's
  # ~/.local/bin, and the next ordinary `bothy` cannot overwrite them. Refused
  # rather than warned: this script has no step that needs a privilege, so being
  # run with one means a misunderstanding worth stopping for.
  if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
    die "Do not run this with sudo. It writes only inside \$HOME and needs no privileges."
  fi

  need_min
  resolve_version

  inside_home "$DIR" || die "BOTHY_DIR must be inside \$HOME (got $DIR). This installer never writes elsewhere."

  if [ "$DRY_RUN" = 1 ]; then
    say "dry run - nothing will be written"
    say "  version     $VER"
    if [ -n "$WANT_SHA" ]; then say "  verify      $WANT_SHA"; else say "  verify      NO (no BOTHY_SHA for $VER)"; fi
    say "  clone from  $REPO_URL"
    say "  clone to    $DIR"
    say "  cli         $BIN_DIR/bothy"
    say "  config      $CONFIG"
    say "  then        prints \`bothy init $DIR\` - never runs it"
    exit 0
  fi

  fetch_and_verify

  # The full prerequisite list, from its ONE definition. Run from the checkout
  # rather than from the copy in ~/.local/bin because that copy does not exist
  # yet - and because a prerequisite failure should not leave a `bothy` on PATH
  # that cannot do anything.
  say ""
  say "== prerequisites =="
  # `bash`, explicitly, and never `sh`: scripts/bothy opens with
  # `set -uo pipefail`, which dash answers with "Illegal option -o pipefail" and
  # exit 2 - so `sh scripts/bothy` would report a prerequisite failure on a box
  # where every prerequisite is present.
  bash "$DIR/scripts/bothy" doctor --pre \
    || die "install what is missing above, then re-run this installer"

  say ""
  say "== the CLI =="
  install_cli
  next_steps
}

main "$@"
