# Shared by apps/bothy-files/checks/run.sh and apps/bothy-ops/checks/run.sh.
# SOURCED, never run. bash 3.2-safe (scripts/checks/bash32.sh): no associative
# arrays, no ${x,,}, no mapfile.
#
# Why a shared harness at all: the four services' run.sh files had grown the
# same thirty lines four times - cd with `|| exit`, pick a python, run a gate,
# collect failures, print a verdict. Two backends need it twice; one copy of it
# cannot disagree with itself about what "passed" means.

# bothy_init <service dir>
#
# `|| exit` on the cd is load-bearing, and none of these harnesses runs under
# `set -e`. Without it a failed cd is ignored and every check runs against
# whatever directory the caller happened to be in - reporting on some other
# tree as if it were this service. A suite that passes in the wrong place is
# worse than one that errors.
bothy_init() {
  cd "$1" || exit 1
  BOTHY_COMMON="$(cd "$1/../bothy-common" && pwd)" || exit 1
  # Every check imports bothy_common; in the image it sits beside app.py, in a
  # checkout it is apps/bothy-common/bothy_common.
  PYTHONPATH="$BOTHY_COMMON${PYTHONPATH:+:$PYTHONPATH}"
  export PYTHONPATH
  PY="${PYTHON:-python3}"
  fail=0
}

# section <title>
section() {
  echo
  echo "── $* ──────────────────────────────────"
}

# check <cmd...>  - a failure is recorded and the run continues.
check() {
  "$@" || fail=1
}

# gate <cmd...>  - a failure STOPS the run. For the checks everything after them
# assumes: running the rest would report passes that mean nothing.
gate() {
  if ! "$@"; then
    echo
    echo "STOPPING. Everything below assumes this holds, so running it now would"
    echo "report passes that mean nothing."
    exit 1
  fi
}

# finish - the verdict and the exit code.
finish() {
  echo
  if [ "$fail" = 0 ]; then
    echo "all checks passed"
  else
    echo "FAILURES above"
  fi
  exit "$fail"
}

# bothy_yaml_python <requirements.txt> <venv dir>
#
# Sets YPY to an interpreter that can import ruamel.yaml, or returns 1.
#
# The system python3 does not have ruamel and should not: it is bothy-files'
# dependency, not the box's. So look for an interpreter that has it, and build a
# venv with uv (this box's declared Python tool) if none does. Never
# `pip install --user` into the system interpreter - that is how a check ends up
# depending on state nobody declared.
bothy_yaml_python() {
  YPY=""
  for candidate in "${PYTHON:-}" "$2/bin/python" python3; do
    [ -n "$candidate" ] && command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" -c 'import ruamel.yaml' >/dev/null 2>&1; then
      YPY="$candidate"
      return 0
    fi
  done
  if command -v uv >/dev/null 2>&1; then
    echo "── no interpreter here has ruamel.yaml; building $2 with uv ──"
    uv venv "$2" >/dev/null 2>&1 || return 1
    uv pip install --quiet --python "$2/bin/python" -r "$1" || return 1
    YPY="$2/bin/python"
    return 0
  fi
  echo "FAIL: the config checks need ruamel.yaml and no interpreter here has it."
  echo "      uv venv $2 && uv pip install --python $2/bin/python -r $1"
  echo "      ...or set PYTHON=/path/to/one that already does."
  return 1
}
