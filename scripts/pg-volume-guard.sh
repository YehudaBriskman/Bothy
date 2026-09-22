#!/usr/bin/env bash
# pg-volume-guard.sh <compose file> [service]  - run by `just up-data` before `up`.
#
# REFUSES to start Postgres on an EMPTY new data volume while an older one holds
# the data. That is the state right after a Postgres MAJOR is merged: main pins
# the new major AND a new volume name (postgres<major>_data), because a major
# cannot open the previous major's data directory. Moving the data is the host
# updater's guided, manual `postgres-major` procedure (docs/plans/updates.md,
# step 8) - dump, new volume, restore, compare, switch. A plain `just up` here
# would instead create the new volume empty and start on it: Keycloak would
# re-import its realm from the file, every user made since would look gone, and
# the dev database would be empty. Nothing is lost (the old volume is kept), but
# it looks exactly like loss, on the one service everything signs in through.
#
# What passes, silently:
#   * the volume compose will mount already exists (every ordinary `up`, and the
#     updater's own switch, which fills the new volume before it switches);
#   * no other postgres data volume of this project exists (a fresh box);
#   * the mount is not a named `<name>_data` volume (nothing to guard).
# BOTHY_PG_FRESH_VOLUME=1 overrides it, for a person who really wants an empty one.
set -euo pipefail

file="${1:?usage: pg-volume-guard.sh <compose file> [service]}"
svc="${2:-postgres}"
[ "${BOTHY_PG_FRESH_VOLUME:-}" = 1 ] && exit 0
[ -f "$file" ] || { echo "pg-volume-guard: no $file" >&2; exit 2; }

# The project name (`name:` at column 0) and the service's `- <key>:/path` mount.
# The same indentation scan as the updater's (services at 2, keys at 4, list at 6).
project="$(awk '/^name:[[:space:]]*/ { sub(/^name:[[:space:]]*/, ""); sub(/[[:space:]]*(#.*)?$/, ""); gsub(/["'\'']/, ""); print; exit }' "$file")"
key="$(awk -v svc="$svc" '
  /^services:/ { in_s = 1; next }
  /^[^ #]/ { in_s = 0 }
  in_s && $0 ~ "^  " svc ":[[:space:]]*(#.*)?$" { hit = 1; next }
  in_s && /^  [^ #]/ { hit = 0 }
  hit && /^      - [A-Za-z0-9][A-Za-z0-9_.-]*_data:\// { sub(/^      - /, ""); sub(/:.*/, ""); print; exit }
' "$file")"
[ -n "$project" ] && [ -n "$key" ] || exit 0

want="${project}_${key}"
docker volume inspect "$want" >/dev/null 2>&1 && exit 0
others="$(docker volume ls -q --filter "label=com.docker.compose.project=$project" \
  | grep -E "^${project}_postgres[0-9]*_data$" | grep -vx "$want" || true)"
[ -z "$others" ] && exit 0

cat >&2 <<EOF
REFUSING: $file mounts the volume $want, which does not exist yet,
while the data lives in: $(echo "$others" | tr '\n' ' ')
This is a Postgres MAJOR that main pins but the box has not moved to. Starting
now would put Postgres - and Keycloak's realm - on an EMPTY volume.

  Move the data:  Settings > Updates > Postgres (the guided postgres-major plan),
                  or \`just update-plan postgres\` to see it from a shell.
  Or stay put:    \`git log -p -- $file\` and run the previous pins by hand.

The old volume is never deleted by any of this. To start on an empty volume on
purpose: BOTHY_PG_FRESH_VOLUME=1 just up-data
EOF
exit 1
