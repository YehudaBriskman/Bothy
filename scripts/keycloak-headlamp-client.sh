#!/usr/bin/env bash
# Make the Keycloak client `headlamp` exist, in the `devbox` realm, exactly as
# apps/headlamp/compose.yml's oauth2-proxy-headlamp expects it. Idempotent: run
# it as often as you like; `just up-headlamp` runs it every time.
#
#   scripts/keycloak-headlamp-client.sh
#
# ── why a script and not only the realm file ────────────────────────────────
#
# auth/realm-devbox.json is imported at Keycloak's FIRST BOOT ONLY (see the
# volume comment in auth/compose.yml). The `headlamp` client is declared there
# too, for fresh installs - but on this box, and on every box that already has a
# realm, that entry is silently skipped. This script is the half that is correct
# on an old box and a new one alike.
#
# The realm file declares the client DISABLED and with no secret, so Keycloak
# generates a random one nobody knows. It becomes usable only when this script
# sets the secret from .env and enables it. A fresh install that never runs
# `just up-headlamp` therefore has a client that cannot be used, rather than one
# whose secret is a placeholder from a public repository.
#
# ── what it does ────────────────────────────────────────────────────────────
#
#  1. .env: generates HEADLAMP_OAUTH2_CLIENT_SECRET (hex 32) and
#     HEADLAMP_OAUTH2_COOKIE_SECRET (url-safe base64 of 32 bytes - oauth2-proxy
#     refuses anything that does not decode to 16/24/32 bytes) when blank or
#     absent, in the same way scripts/bootstrap.sh does. Values are never printed.
#  2. Keycloak, through kcadm INSIDE the running `keycloak` container (admin
#     API on localhost:8080, the master-realm admin, password = DEV_LOGIN_PASSWORD
#     - the same credential keycloak-init uses):
#       - create the client if absent, else update it to the declared shape;
#       - re-assert its secret from .env and enabled=true;
#       - add the realm-roles-as-groups mapper if it is missing. Without it the
#         token has no flat `groups` claim and --allowed-group=viewer refuses
#         everybody, including users who hold `viewer`.
#  3. Reads the secret back and checks it equals .env.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# ENV_FILE exists for running from a git worktree against the real checkout's
# .env; normally it is the repo's own.
env_file="${ENV_FILE:-$root/.env}"
port="${HEADLAMP_PORT:-8110}"

[ -f "$env_file" ] || { echo "no $env_file - run 'just bootstrap' first" >&2; exit 1; }

# `|| true`: an ABSENT key is an ordinary answer (empty), not an error - without
# it grep's exit 1 plus pipefail kills the script on the first optional key.
env_value() { { grep -E "^$1=" "$env_file" || true; } | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//; s/[[:space:]]*$//'; }
env_set() {
  # awk with an exact prefix and an environment handoff, as bootstrap.sh does:
  # no metacharacter in the value is ever re-interpreted. `cat >` rather than
  # `mv` so the file keeps its mode (600) and owner.
  local tmp; tmp="$(mktemp "$env_file.XXXXXX")"
  K="$1" V="$2" awk '
    BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    !done && index($0, k "=") == 1 { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$env_file" > "$tmp"
  cat "$tmp" > "$env_file"
  rm -f "$tmp"
}

for k in HEADLAMP_OAUTH2_CLIENT_SECRET HEADLAMP_OAUTH2_COOKIE_SECRET; do
  case "$(env_value "$k")" in
    ''|changeme|change-me)
      case "$k" in
        *CLIENT_SECRET) v="$(openssl rand -hex 32 | tr -d '\n')" ;;
        *COOKIE_SECRET) v="$(openssl rand -base64 32 | tr -- '+/' '-_' | tr -d '\n')" ;;
      esac
      env_set "$k" "$v"
      echo "  $k generated in $env_file" ;;
    *) echo "  $k already set - left alone" ;;
  esac
done

box_ip="$(env_value BOX_IP)"
[ -n "$box_ip" ] || { echo "BOX_IP is not set in $env_file" >&2; exit 1; }

CLIENT_SECRET="$(env_value HEADLAMP_OAUTH2_CLIENT_SECRET)"
REDIRECT_URI="http://$box_ip:$port/oauth2/callback"
KC_ADMIN_USER="$(env_value KEYCLOAK_ADMIN_USER)"; KC_ADMIN_USER="${KC_ADMIN_USER:-admin}"
KC_ADMIN_PASSWORD="$(env_value DEV_LOGIN_PASSWORD)"
[ -n "$KC_ADMIN_PASSWORD" ] || { echo "DEV_LOGIN_PASSWORD is not set in $env_file" >&2; exit 1; }
export CLIENT_SECRET REDIRECT_URI KC_ADMIN_USER KC_ADMIN_PASSWORD

[ "$(docker inspect -f '{{.State.Health.Status}}' keycloak 2>/dev/null || true)" = healthy ] || {
  echo "the keycloak container is not running and healthy - run 'just up-auth' first" >&2; exit 1; }

# `-e NAME` with no value copies it from this environment, so no secret appears
# on the docker command line. (Inside the container kcadm still takes the admin
# password as an argument, exactly as keycloak-init does.)
docker exec -i \
  -e CLIENT_SECRET -e REDIRECT_URI -e KC_ADMIN_USER -e KC_ADMIN_PASSWORD \
  keycloak bash -s <<'IN_CONTAINER'
set -euo pipefail
cfg="$(mktemp /tmp/kcadm-headlamp.XXXXXX)"
trap 'rm -f "$cfg"' EXIT
kc() { /opt/keycloak/bin/kcadm.sh "$@" --config "$cfg"; }

kc config credentials --server http://localhost:8080 --realm master \
  --user "$KC_ADMIN_USER" --password "$KC_ADMIN_PASSWORD" >/dev/null

# The declared shape. Mirrors the `oauth2-proxy` client in realm-devbox.json:
# confidential, standard flow only, PKCE S256 required. Both values interpolated
# here are a hex string and a URL built from an IP and a port - nothing that
# needs JSON escaping.
body=$(cat <<JSON
{
  "clientId": "headlamp",
  "name": "Headlamp (read-only cluster browser)",
  "description": "oauth2-proxy-headlamp in front of Headlamp on its own port. Admits the viewer role. Managed by scripts/keycloak-headlamp-client.sh.",
  "enabled": true,
  "protocol": "openid-connect",
  "publicClient": false,
  "bearerOnly": false,
  "standardFlowEnabled": true,
  "implicitFlowEnabled": false,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": false,
  "frontchannelLogout": true,
  "clientAuthenticatorType": "client-secret",
  "secret": "$CLIENT_SECRET",
  "redirectUris": ["$REDIRECT_URI"],
  "webOrigins": ["+"],
  "attributes": {
    "pkce.code.challenge.method": "S256",
    "post.logout.redirect.uris": "+"
  }
}
JSON
)

id="$(kc get clients -r devbox -q clientId=headlamp --fields id --format csv --noquotes | head -1)"
if [ -z "$id" ]; then
  printf '%s' "$body" | kc create clients -r devbox -f - >/dev/null
  id="$(kc get clients -r devbox -q clientId=headlamp --fields id --format csv --noquotes | head -1)"
  echo "  keycloak: created client headlamp"
else
  printf '%s' "$body" | kc update "clients/$id" -r devbox -f - >/dev/null
  echo "  keycloak: client headlamp already existed - updated to the declared shape"
fi

if kc get "clients/$id/protocol-mappers/models" -r devbox --fields name --format csv --noquotes \
     | grep -qx realm-roles-as-groups; then
  echo "  keycloak: realm-roles-as-groups mapper present"
else
  kc create "clients/$id/protocol-mappers/models" -r devbox -f - >/dev/null <<'MAPPER'
{
  "name": "realm-roles-as-groups",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-usermodel-realm-role-mapper",
  "consentRequired": false,
  "config": {
    "multivalued": "true",
    "claim.name": "groups",
    "jsonType.label": "String",
    "id.token.claim": "true",
    "access.token.claim": "true",
    "userinfo.token.claim": "true"
  }
}
MAPPER
  echo "  keycloak: realm-roles-as-groups mapper added"
fi

got="$(kc get "clients/$id/client-secret" -r devbox --fields value --format csv --noquotes)"
[ "$got" = "$CLIENT_SECRET" ] || { echo "  keycloak: the stored secret does not match .env" >&2; exit 1; }
redir="$(kc get "clients/$id" -r devbox --fields redirectUris --format csv --noquotes)"
echo "  keycloak: secret matches .env; redirect URI $redir"
IN_CONTAINER
