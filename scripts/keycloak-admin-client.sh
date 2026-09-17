#!/usr/bin/env bash
# Make the Keycloak client `bothy-admin` exist in realm `devbox`, able to LIST
# USERS AND THEIR ROLES and nothing else, and put its secret where bothy-ops
# reads it. Idempotent; `just admin-client` runs it.
#
#   scripts/keycloak-admin-client.sh            create or re-assert
#   scripts/keycloak-admin-client.sh --rotate   new secret, in Keycloak and on disk
#   scripts/keycloak-admin-client.sh --revoke   disable the client, delete the file
#
# Modelled on scripts/keycloak-headlamp-client.sh, and different from it in two
# ways that matter:
#
#  1. The secret lives in a FILE, apps/bothy-ops/secrets/keycloak-admin-client-secret
#     (mode 600 in a 700 directory, gitignored, outside every build context), not
#     in .env. bothy-ops re-reads it per token fetch, so a rotation needs no
#     restart, and compose never has to interpolate it.
#  2. It is a SERVICE-ACCOUNT client - no browser flow, no redirect URI - and
#     the script ENFORCES the service account's grants, not just adds them:
#     exactly realm-management `view-users` (whose composites are query-users and
#     query-groups), and no other client role. `view-clients` in particular would
#     let a token read every client secret in the realm; if anything has granted
#     it, this removes it and says so.
#
# Authenticates the way keycloak-headlamp-client.sh does: kcadm INSIDE the
# running keycloak container, as the master-realm admin (password =
# DEV_LOGIN_PASSWORD). The secret is passed by `docker exec -e NAME` from this
# environment, so it never appears on a command line on the host.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${ENV_FILE:-$root/.env}"
secret_dir="${ADMIN_SECRET_DIR:-$root/apps/bothy-ops/secrets}"
secret_file="$secret_dir/keycloak-admin-client-secret"
mode="${1:-}"

case "$mode" in
  ''|--rotate|--revoke) ;;
  *) echo "usage: $0 [--rotate|--revoke]" >&2; exit 2 ;;
esac

[ -f "$env_file" ] || { echo "no $env_file - run 'just bootstrap' first" >&2; exit 1; }
env_value() { { grep -E "^$1=" "$env_file" || true; } | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//; s/[[:space:]]*$//'; }

KC_ADMIN_USER="$(env_value KEYCLOAK_ADMIN_USER)"; KC_ADMIN_USER="${KC_ADMIN_USER:-admin}"
KC_ADMIN_PASSWORD="$(env_value DEV_LOGIN_PASSWORD)"
[ -n "$KC_ADMIN_PASSWORD" ] || { echo "DEV_LOGIN_PASSWORD is not set in $env_file" >&2; exit 1; }

[ "$(docker inspect -f '{{.State.Health.Status}}' keycloak 2>/dev/null || true)" = healthy ] || {
  echo "the keycloak container is not running and healthy - run 'just up-auth' first" >&2; exit 1; }

# The directory is shared with the cluster token (gen-kube-token.sh creates it
# the same way). umask first, so nothing is ever briefly readable.
umask 077
mkdir -p "$secret_dir"
chmod 700 "$secret_dir"
new_secret_file=""
cleanup() { if [ -n "$new_secret_file" ]; then rm -f "$new_secret_file"; fi; }
# A rotation that fails part-way must not leave a stray candidate secret behind.
trap cleanup EXIT

if [ "$mode" = --rotate ] || [ ! -s "$secret_file" ]; then
  if [ "$mode" != --revoke ]; then
    tmp="$(mktemp "$secret_dir/.keycloak-admin.XXXXXX")"
    openssl rand -hex 32 | tr -d '\n' > "$tmp"
    chmod 600 "$tmp"
    new_secret_file="$tmp"
  fi
fi

if [ "$mode" = --revoke ]; then
  CLIENT_SECRET="" ACTION=revoke
else
  if [ -n "$new_secret_file" ]; then src="$new_secret_file"; else src="$secret_file"; fi
  CLIENT_SECRET="$(cat "$src")" ACTION=assert
fi
export CLIENT_SECRET ACTION KC_ADMIN_USER KC_ADMIN_PASSWORD

docker exec -i -e CLIENT_SECRET -e ACTION -e KC_ADMIN_USER -e KC_ADMIN_PASSWORD \
  keycloak bash -s <<'IN_CONTAINER'
set -euo pipefail
cfg="$(mktemp /tmp/kcadm-bothy-admin.XXXXXX)"
trap 'rm -f "$cfg"' EXIT
kc() { /opt/keycloak/bin/kcadm.sh "$@" --config "$cfg"; }
kc config credentials --server http://localhost:8080 --realm master \
  --user "$KC_ADMIN_USER" --password "$KC_ADMIN_PASSWORD" >/dev/null

id="$(kc get clients -r devbox -q clientId=bothy-admin --fields id --format csv --noquotes | head -1)"

if [ "$ACTION" = revoke ]; then
  if [ -n "$id" ]; then
    printf '{"enabled": false}' | kc update "clients/$id" -r devbox -f - >/dev/null
    echo "  keycloak: client bothy-admin DISABLED"
  else
    echo "  keycloak: no client bothy-admin - nothing to revoke"
  fi
  exit 0
fi

# Confidential, service account only. No browser flow, no direct grant, no
# redirect URI: the one thing it can do is the client-credentials grant.
body=$(cat <<JSON
{
  "clientId": "bothy-admin",
  "name": "Bothy Settings (read users and roles)",
  "description": "bothy-ops admin.py - GET /-/api/admin/users. Service account holds realm-management view-users ONLY. Managed by scripts/keycloak-admin-client.sh.",
  "enabled": true,
  "protocol": "openid-connect",
  "publicClient": false,
  "bearerOnly": false,
  "standardFlowEnabled": false,
  "implicitFlowEnabled": false,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": true,
  "frontchannelLogout": false,
  "clientAuthenticatorType": "client-secret",
  "secret": "$CLIENT_SECRET",
  "redirectUris": [],
  "webOrigins": []
}
JSON
)

if [ -z "$id" ]; then
  printf '%s' "$body" | kc create clients -r devbox -f - >/dev/null
  id="$(kc get clients -r devbox -q clientId=bothy-admin --fields id --format csv --noquotes | head -1)"
  echo "  keycloak: created client bothy-admin"
else
  printf '%s' "$body" | kc update "clients/$id" -r devbox -f - >/dev/null
  echo "  keycloak: client bothy-admin already existed - updated to the declared shape"
fi

sa="$(kc get "clients/$id/service-account-user" -r devbox --fields username --format csv --noquotes)"
[ -n "$sa" ] || { echo "  keycloak: no service-account user for bothy-admin" >&2; exit 1; }

# Exactly view-users from realm-management. Anything else granted to this
# service account from realm-management is REMOVED, not merely reported.
kc add-roles -r devbox --uusername "$sa" --cclientid realm-management --rolename view-users >/dev/null
extra="$(kc get-roles -r devbox --uusername "$sa" --cclientid realm-management --fields name --format csv --noquotes \
          | grep -vx view-users || true)"
for r in $extra; do
  kc remove-roles -r devbox --uusername "$sa" --cclientid realm-management --rolename "$r" >/dev/null
  echo "  keycloak: REMOVED unexpected realm-management role $r from $sa"
done
# And no realm role beyond Keycloak's own defaults: the service account must not
# hold viewer/editor/operator/shell, which would make its token pass a gate.
for r in viewer editor operator shell; do
  if kc get-roles -r devbox --uusername "$sa" --fields name --format csv --noquotes | grep -qx "$r"; then
    kc remove-roles -r devbox --uusername "$sa" --rolename "$r" >/dev/null
    echo "  keycloak: REMOVED realm role $r from $sa"
  fi
done
echo "  keycloak: $sa holds realm-management view-users and no other client role"

got="$(kc get "clients/$id/client-secret" -r devbox --fields value --format csv --noquotes)"
[ "$got" = "$CLIENT_SECRET" ] || { echo "  keycloak: the stored secret does not match the file" >&2; exit 1; }
echo "  keycloak: secret matches"
IN_CONTAINER

if [ "$mode" = --revoke ]; then
  rm -f "$secret_file"
  echo "  removed $secret_file"
  exit 0
fi

# Only now that Keycloak holds the new secret does the file change - a failed
# rotation leaves the old, still-working pair in place.
if [ -n "$new_secret_file" ]; then
  mv -f "$new_secret_file" "$secret_file"
  new_secret_file=""
  echo "  wrote $secret_file (mode 600)"
fi
chmod 600 "$secret_file"
echo "  bothy-ops re-reads it on the next token fetch; no restart needed."
echo "  (If bothy-ops runs without apps/bothy-ops/compose.admin.yml, run 'just up-apps' once.)"
