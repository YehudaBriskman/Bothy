#!/usr/bin/env bash
# Checks for bothy-settings - the settings and secrets store library.  `just settings-check`
#
# Runs with the stack DOWN and touches nothing outside a temp dir: every test makes
# its own state directory and GENERATES its own master key. No ~/stacks/.env, no
# real credential, no container, no network. (Reading a real credential file from a
# test of a secrets store is exactly the habit these tests exist to make impossible.)
#
#   test_primitives  the pieces alone: AES-GCM envelope and its associated data,
#                    nonce-reuse guard, key-file parsing and modes, name rules,
#                    filesystem refusals, the audit chain, fingerprints.
#   test_store       the store: set/get/list/delete, write-only secrets, the one
#                    decrypt path, optimistic versions, migrations and downgrade,
#                    every refusal (wrong key, tampered ciphertext, truncated DB).
#   test_rotation    KEK and DEK rotation, with a crash injected at every step -
#                    both a raised exception and a real os._exit in a child.
#   test_backup      the online backup API under a write loop; restore and every
#                    reason it must refuse, ending with "nothing changed".
#   test_export      the export document and the age bundle (real `age` if present,
#                    SKIPPED loudly if not; a stub proves what we pass it).
#   test_leaks       no value and no key byte in logs, exception texts, audit rows,
#                    reprs, or any file under the state directory.
#
# Dependency: `cryptography`, pinned with hashes in requirements.txt. The system
# python3 does not have it and should not (it is this library's dependency, not the
# box's), so this builds .venv with uv - the box's declared Python tool - the way
# bothy-files does for ruamel.yaml. Never `pip install --user`.
#
#   --only <test_name>   run one file (the mutation rows use this)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../bothy-common/checks/lib.sh"
bothy_init "$HERE/.."

ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:-}"; [ -n "$ONLY" ] || { echo "--only needs a name" >&2; exit 2; }; shift 2 ;;
    --offline) shift ;;   # accepted for symmetry with the other harnesses; nothing here needs a network
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

VENV="$HERE/../.venv"
WANT="$(sed -n 's/^cryptography==\([0-9][0-9.]*\).*/\1/p' requirements.txt | head -n 1)"
[ -n "$WANT" ] || { echo "FAIL: no 'cryptography==' pin in requirements.txt" >&2; exit 1; }

have_pinned() {
  [ -x "$VENV/bin/python" ] || return 1
  [ "$("$VENV/bin/python" -c 'import cryptography; print(cryptography.__version__)' 2>/dev/null)" = "$WANT" ]
}

if ! have_pinned; then
  if ! command -v uv >/dev/null 2>&1; then
    echo "FAIL: cryptography $WANT is needed and uv is not installed."
    echo "      uv venv $VENV && uv pip install --require-hashes --python $VENV/bin/python -r requirements.txt"
    exit 1
  fi
  echo "── building $VENV with uv (cryptography==$WANT, hashes required) ──"
  uv venv --quiet --allow-existing "$VENV" >/dev/null 2>&1 || { echo "FAIL: uv venv"; exit 1; }
  uv pip install --quiet --require-hashes --python "$VENV/bin/python" -r requirements.txt || { echo "FAIL: uv pip install"; exit 1; }
  have_pinned || { echo "FAIL: the venv does not hold cryptography==$WANT after installing"; exit 1; }
fi
PY="$VENV/bin/python"

# A real `age`, if the box has one: the bundle round trip is skipped without it.
# The test says so; this line says so too, so a green run is not read as "age was tested".
if [ -z "${BOTHY_AGE_BIN:-}" ] && ! command -v age >/dev/null 2>&1; then
  echo "note: no age binary on PATH (BOTHY_AGE_BIN unset) - the real-age round trip will SKIP"
fi

echo "python: $("$PY" -V), sqlite $("$PY" -c 'import sqlite3; print(sqlite3.sqlite_version)'), cryptography $WANT"

run_one() {
  section "$1"
  # -W error: a ResourceWarning (an unclosed file or connection) is a failure here.
  check "$PY" -W error "checks/$2.py"
}

want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

want test_primitives && run_one "primitives: envelope, key file, names, audit chain, filesystem" test_primitives
want test_store      && run_one "store: write-only secrets, one decrypt path, every refusal" test_store
want test_rotation   && run_one "rotation: KEK and DEK, a crash at every step" test_rotation
want test_backup     && run_one "backup and restore: consistent under writes, and refusals change nothing" test_backup
want test_export     && run_one "export: the document, and the age bundle" test_export
want test_leaks      && run_one "leaks: no value or key byte in logs, errors, audit or files" test_leaks
want test_hardening  && run_one "hardening: restore dry-decrypt and crash safety, audit head, versions, export, odd paths" test_hardening
want test_logging    && run_one "logging: the audit line reaches stdout with no logging configured" test_logging

if [ -n "$ONLY" ] && [ ! -f "checks/$ONLY.py" ]; then
  echo "unknown test: $ONLY" >&2
  exit 2
fi
finish
