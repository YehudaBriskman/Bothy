#!/usr/bin/env bash
# Checks for the config tier.
#
# EVERY ONE OF THESE RUNS WITH THE STACK DOWN. Nothing here needs docker, a
# network, a credential or a running edge - the parent integrates and deploys,
# and a check that cannot run before that is a check nobody runs first. The one
# thing they need is the YAML parser this service is built on, which is the whole
# point of the tier.
#
# Four layers, deliberately, because each catches what the others cannot:
#
#   noop_bytes.py         THE GATE. A patch that changes nothing changes no
#                         bytes, for every patchable value in every YAML file in
#                         the repository. If this fails, no field is safe to edit
#                         and nothing below it means anything - so it runs first
#                         and everything after it is skipped.
#   naive_dump_damage.py  The measurement behind the design: what load-and-dump
#                         would have done to these same files. It is what keeps
#                         yamlpatch.py's header from becoming a claim nobody
#                         checks after a dependency bump.
#   patch_one_line.py     A patch that DOES change something changes exactly one
#                         line, and every comment survives byte-identical.
#   test_safepath.py      The path boundary as a pure unit, with real planted
#                         symlinks. This service's safepath.py is a COPY of
#                         portal-files'; this is what notices when they drift.
#   api.py                The whole thing through HTTP, against the SHIPPED
#                         policy and a throwaway copy of the repo's real files:
#                         refusals, the 409, the snapshot, the audit line.
#
# The unit tests alone would pass with the API wide open; api.py alone would pass
# with the splice replaced by a round-tripper that quietly reformats. All of them
# have to run.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# `|| exit` is load-bearing, and none of these three files runs under `set -e`.
# Without it a failed cd is ignored and every check below runs against whatever
# directory the caller happened to be in - reading some other tree, or none, and
# reporting on it as if it were this service. A suite that passes in the wrong
# place is worse than one that errors.
cd "$HERE/.." || exit 1

# ── finding a python that can parse YAML ────────────────────────────────────
#
# The system python3 does not have ruamel and should not: this is a container's
# dependency, not the box's. Rather than fail with an ImportError, look for an
# interpreter that has it and make one if `uv` is available - which it is, since
# it is this box's declared Python tool.
#
# Never `pip install --user` into the system interpreter. That is how a check
# ends up depending on state nobody declared, and it is exactly the thing the
# pinned requirements.txt exists to avoid.
have_yaml() { "$1" -c 'import ruamel.yaml' >/dev/null 2>&1; }

PY=""
for candidate in "${PYTHON:-}" "$HERE/../.venv/bin/python" python3; do
  [ -n "$candidate" ] && command -v "$candidate" >/dev/null 2>&1 || continue
  if have_yaml "$candidate"; then PY="$candidate"; break; fi
done

if [ -z "$PY" ]; then
  if command -v uv >/dev/null 2>&1; then
    echo "── no interpreter here has ruamel.yaml; building ./.venv with uv ──"
    uv venv "$HERE/../.venv" >/dev/null 2>&1 || exit 1
    uv pip install --quiet --python "$HERE/../.venv/bin/python" \
      -r "$HERE/../requirements.txt" || exit 1
    PY="$HERE/../.venv/bin/python"
  else
    echo "FAIL: these checks need ruamel.yaml and no interpreter here has it."
    echo "      uv venv apps/bothy-config/.venv"
    echo "      uv pip install --python apps/bothy-config/.venv/bin/python \\"
    echo "          -r apps/bothy-config/requirements.txt"
    echo "      ...or set PYTHON=/path/to/one that already does."
    exit 1
  fi
fi
echo "python: $PY  ($("$PY" -c 'import ruamel.yaml as r; print("ruamel.yaml", ".".join(map(str, r.version_info)))'))"

fail=0

echo
echo "── THE GATE: a no-op patch must not change a byte ──────────────"
if ! "$PY" checks/noop_bytes.py; then
  echo
  echo "STOPPING. Every check below assumes the writer is byte-clean, so running"
  echo "them now would report passes that mean nothing."
  exit 1
fi

echo
echo "── the measurement behind refusing to re-serialise ─────────────"
"$PY" checks/naive_dump_damage.py || fail=1

echo
echo "── a real patch changes ONE line, and no comment ───────────────"
"$PY" checks/patch_one_line.py || fail=1

echo
echo "── path safety (unit, with real symlinks) ──────────────────────"
"$PY" checks/test_safepath.py || fail=1

echo
echo "── the API: refusals, the 409, the snapshot, the audit line ────"
"$PY" checks/api.py || fail=1

echo
if [ "$fail" = 0 ]; then
  echo "all checks passed"
else
  echo "FAILURES above"
fi
exit $fail
