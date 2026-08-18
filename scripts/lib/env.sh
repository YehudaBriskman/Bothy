# Where things are, and what this box is called. Sourced, never executed.
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
  set -a
  # shellcheck disable=SC1091  # path is computed, shellcheck cannot follow it
  . "$BOTHY_ROOT/.env"
  set +a
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
