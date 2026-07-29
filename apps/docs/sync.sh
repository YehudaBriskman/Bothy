#!/bin/sh
# One-way mirror: real source dirs -> content/ (MkDocs reads it, read-only).
# Excludes dependency/cache junk. --delete keeps the mirror in step with sources
# (removed source files disappear here too). Regenerates the landing page each run.
#
# SECRETS ARE EXCLUDED HERE, not just downstream. `credentials.md` holds live
# passwords and OAuth secrets; mirroring it copied them into this repo's working
# tree, where the only thing keeping them out of a PUBLIC repo was a single
# `content/` line in .gitignore. One `git add -f`, or one edit to that file, and
# they would have been published. Keep this exclusion first, and keep the
# defence-in-depth ignore in the root .gitignore.
set -f
# --delete-excluded, not just --delete: rsync PROTECTS excluded files on the
# receiving side, so adding an exclusion alone would leave anything already
# mirrored sitting there forever. Without this, excluding credentials.md would
# not have removed the copy that was already in the tree.
rsync -a --delete --delete-excluded --prune-empty-dirs \
  --exclude='credentials.md' --exclude='*secrets*' --exclude='*.env' \
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
