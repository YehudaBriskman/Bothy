# shellcheck shell=bash
# Where things are, and what this box is called. Sourced, never executed.
#
# That directive is not a suppression - it answers the question the linter asks.
# This file has no shebang BECAUSE it is sourced, and with no shell to assume the
# linter reports SC2148 as an ERROR and then analyses nothing else in the file.
#
# Note the wording: a comment line may not BEGIN with the linter's own name, or
# it is read as a directive and fails to parse. That is how the first version of
# this very comment broke the build it was explaining.
#
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/env.sh"
#
# WHY THIS EXISTS. Four scripts each worked out the repo root, each read .env
# their own way, and two of them simply hardcoded a path under one person's home
# directory. That is four places to be wrong and four places to fix, and it is
# the reason `just verify` could only ever be run by its author.
#
# Everything here has a DEFAULT. `cp .env.example .env && just up` has to work
# without editing any of it, so a missing value is never an error - it is the
# ordinary case.

# The repo root, DERIVED and never configured. A declared root is a value that
# can disagree with reality after a `mv`; this one cannot. `..` twice because
# this file is scripts/lib/env.sh.
BOTHY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export BOTHY_ROOT

# The repo's own .env, if there is one. `set -a` exports everything it declares
# so a child process sees it too, which is what the compose files and the python
# checks expect.
if [ -f "$BOTHY_ROOT/.env" ]; then
  # THE ENVIRONMENT WINS OVER THE FILE, which is the opposite of what
  # `set -a; . .env` does and the reason that is not used here.
  #
  # Sourcing overwrites anything already exported, so `BOX_IP=x just verify`
  # silently did nothing - the file put its own value back. Docker Compose
  # resolves it the other way (a variable already in the environment beats
  # .env), and having the shell scripts disagree with the compose files about
  # the same file is a difference nobody would think to look for.
  #
  # Read, do not source: `.` on a file of KEY=value also EXECUTES anything in
  # it, so a value containing a backtick or $( ) would run. That is a real
  # hazard for a file this repo tells people to paste secrets into.
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    key=${line%%=*}
    val=${line#*=}
    case "$key" in *[!A-Za-z0-9_]*|'') continue ;; esac
    # Strip one layer of surrounding quotes, which .env files commonly carry.
    case "$val" in
      \"*\") val=${val#\"}; val=${val%\"} ;;
      \'*\') val=${val#\'}; val=${val%\'} ;;
    esac
    # `:=` only assigns when unset or empty, so the environment keeps its value.
    eval ": \"\${$key:=\$val}\"" 2>/dev/null && eval "export $key" 2>/dev/null
  done < "$BOTHY_ROOT/.env"
fi

# The same names, and the same defaults, that apps/portal-files/compose.yml
# uses. Written twice - once there for compose, once here for shell - and that
# duplication is real. It is guarded by scripts/checks/portability.sh rather
# than by machinery, because a variable indirection between a compose file and a
# shell script costs more to read than the two lines it saves.
: "${NOTES_ROOT:=$HOME/claude-notes}"
: "${PROJECTS_ROOT:=$HOME/projects}"
: "${HOME_ROOT:=$HOME}"
: "${STATE_ROOT:=$HOME/.local/state}"
: "${BACKUP_ROOT:=$HOME/backups}"
export NOTES_ROOT PROJECTS_ROOT HOME_ROOT STATE_ROOT BACKUP_ROOT
