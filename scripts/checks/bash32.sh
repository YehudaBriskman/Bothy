#!/usr/bin/env bash
# Nothing here may need bash 4.
#
# macOS ships bash 3.2 - Apple froze it at the last GPLv2 release - and Bothy
# claims macOS as a target. `${var,,}` and friends are bash 4 and fail at PARSE
# time there, so the script does not run AT ALL and the error names a line that
# looks perfectly fine. That is exactly how scripts/verify-access.sh was
# unrunnable on a Mac without anyone noticing.
#
# GREP RATHER THAN A macOS RUNNER. This catches the whole class in a second. A
# macOS runner would catch the same thing in ten minutes, after installing a
# second container daemon whose quirks are not Bothy's behaviour. Revisit when
# the shell layer has been clean for a while.
#
# Extracted from .github/workflows/ci.yml so it can be run by hand and, more to
# the point, so scripts/checks/mutants.sh can plant a `${x,,}` and require this
# to catch it. A check that lives only inside a workflow step can only be tested
# by pushing.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

# -H so the filename is ALWAYS printed. Without it grep omits the prefix when
# handed exactly one file, and the comment filter below - which expects
# `file:line:` - silently stops working. That is a self-disabling check: it would
# keep passing while catching nothing.
#
# The second grep drops COMMENT lines. In a comment `${var,,}` is documentation;
# only in code is it a parse error. Without this, the note above explaining the
# rule would break the rule.
hits=$(find scripts apps/*/checks -name '*.sh' -print0 \
  | xargs -0 grep -HnE '\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?,,\}|\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?\^\^\}|^[^#]*\bdeclare -A|^[^#]*\breadarray\b|^[^#]*\bmapfile\b' \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)

if [ -n "$hits" ]; then
  echo "bash 4 only, and a SYNTAX ERROR on the bash 3.2 macOS ships:"
  echo "$hits"
  exit 1
fi
echo "ok - nothing here needs bash 4"
