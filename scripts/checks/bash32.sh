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
# A parameter name as bash accepts it before `,,` or `^^`: an identifier, a
# POSITIONAL parameter, or $@/$*. The first version accepted only identifiers, so
# `${1,,}` was invisible to it - and lowercasing an argument is the most likely
# place anyone reaches for this in a CLI. Found by planting `${1,,}` to test
# something else and watching the check stay green.
VAR='([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*])'
# Assembled with SINGLE quotes around every literal part. Spelling it as one
# double-quoted string looks tidier and is wrong: in double quotes bash turns
# `\$` into a bare `$`, which grep -E then reads as end-of-line, and the two
# case-conversion patterns silently stop matching anything. The check kept
# printing "ok" with `${name,,}` sitting in the file - a check that cannot fail,
# which is the one failure this whole directory exists to prevent.
RE='\$\{'"$VAR"'(\[[^]]*\])?,,\}|\$\{'"$VAR"'(\[[^]]*\])?\^\^\}|^[^#]*\bdeclare -A|^[^#]*\breadarray\b|^[^#]*\bmapfile\b'

# EVERY SHELL SCRIPT, not every file named *.sh. `scripts/bothy` is the CLI, it
# is bash, and it had no extension - so this check and CI's shellcheck step both
# walked straight past the one file where a bash 4 construct is worst. macOS
# ships bash 3.2 and `${x,,}` is a PARSE error there, so the script does not run
# at all and the message names a line that looks fine. A glob that decides what
# to check by filename is a glob that stops checking the moment somebody drops an
# extension, which is exactly what happened. Shebang, not suffix.
hits=$(find scripts apps/*/checks -type f \( -name '*.sh' -o -exec sh -c 'head -1 "$1" | grep -qE "^#!.*(ba)?sh"' _ {} \; \) -print0 \
  | xargs -0 grep -HnE "$RE" \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)

if [ -n "$hits" ]; then
  echo "bash 4 only, and a SYNTAX ERROR on the bash 3.2 macOS ships:"
  echo "$hits"
  exit 1
fi
echo "ok - nothing here needs bash 4"
