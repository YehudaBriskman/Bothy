#!/bin/sh
# One-way mirror: real source dirs -> content/ (MkDocs reads it, read-only).
# Excludes dependency/cache junk. --delete keeps the mirror in step with sources
# (removed source files disappear here too). Regenerates the landing page each run.
set -f
rsync -a --delete --prune-empty-dirs \
  --exclude=node_modules --exclude=.git --exclude=.venv --exclude=.cache \
  --exclude=dist --exclude=build --exclude=__pycache__ --exclude=.pytest_cache \
  --exclude=site-packages --exclude=.next --exclude=coverage --exclude='apps/docs' \
  --include='*/' --include='*.md' --exclude='*' \
  /src/projects /src/claude-notes /src/stacks /dest/

# Landing page. Write it only when ABSENT or CHANGED — rewriting it every cycle
# churns its mtime, and MkDocs' live-reload then fires a full page refresh every
# sync (~15s). (rsync --delete would drop a source-less file, so it lives here.)
NEW=$(cat <<'EOF'
# Dev Box Docs

Every markdown document on this box, rendered live. Edit the source files and the
change shows up here within seconds.

## Sections

- **projects/** — Tals & CVOps: architecture, plans, reports, task specs
- **claude-notes/** — the box's own notes (machine · network · stack · projects)
- **stacks/** — the shared dev-stack docs

Use the search box (top) or the navigation on the left.
EOF
)
if [ ! -f /dest/index.md ] || [ "$(cat /dest/index.md 2>/dev/null)" != "$NEW" ]; then
  printf '%s\n' "$NEW" > /dest/index.md
fi
