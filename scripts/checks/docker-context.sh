#!/usr/bin/env bash
# Every file an apps/ Dockerfile COPYs must be on apps/.dockerignore's allowlist.
#
# WHY THIS EXISTS. apps/.dockerignore is an allowlist ("*" then "!file" lines) so the
# build context never carries node_modules, audit logs or a cluster token. The cost is
# that a NEW module copied by a Dockerfile but not listed fails only in the image build,
# in CI, with "not found". That happened twice in a row (v1api.py, then caller.py).
# This turns it into a fast, local check.
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 - <<'PY'
import glob, sys
allow = {l[1:].strip() for l in open("apps/.dockerignore") if l.startswith("!")}
bad = []
for df in sorted(glob.glob("apps/*/Dockerfile")):
    app = df.split("/")[1]
    for line in open(df):
        parts = line.split()
        if not parts or parts[0] != "COPY" or any(p.startswith("--from") for p in parts):
            continue
        for src in parts[1:-1]:
            if src.startswith("--"):
                continue
            if "/" not in src or not src.startswith("bothy-"):
                continue  # not from the apps/ context (e.g. a build of its own directory)
            if src.endswith("/bothy_common"):
                src = src + "/*.py"
            if src not in allow:
                bad.append(f"{df}: {src}")
if bad:
    print("FAIL  COPY source not on apps/.dockerignore's allowlist:")
    for b in bad: print("  " + b)
    sys.exit(1)
print("PASS  every apps/ Dockerfile COPY source is on the allowlist")
PY
