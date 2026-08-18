#!/usr/bin/env bash
# Make a fresh clone able to start. `just bootstrap`, and `just up` runs it.
#
# README.md has promised `cp .env.example .env && just up` for a while, and it
# has never been true: four files the stack needs are gitignored and nothing
# creates them, five directories are assumed to exist, and Prometheus is started
# with --web.config.file pointing at one of the missing files. The failure is
# not a message, it is a container that will not come up.
#
# THREE PHASES, and the order is the point.
#
#   A. PREFLIGHT changes nothing. Every failure names its fix. A check that
#      says "something is wrong" and stops is only marginally better than the
#      crash it replaced.
#   B. CREATE the directories, with the right owner.
#   C. GENERATE the files, write-if-absent.
#
# IDEMPOTENT, and visibly so: every action prints `created` or `already
# present`, so a second run is SEEN to be a no-op rather than assumed to be one.
# Nothing is overwritten without --force.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
# shellcheck disable=SC1091
. scripts/lib/env.sh

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

bad=0
say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*"; bad=1; }

# ── A. preflight ─────────────────────────────────────────────────────────────
echo "== preflight =="

for c in docker just curl python3 openssl; do
  command -v "$c" >/dev/null 2>&1 || die "$c is not installed"
done
# jq's absence is called out separately because doctor.sh already learned the
# hard way that a missing jq reads as a clean bill of health rather than as a
# broken check.
command -v jq >/dev/null 2>&1 || warn "jq is not installed - doctor.sh will report less than it should"

if ! docker compose version >/dev/null 2>&1; then
  die "docker compose v2 is not available (this repo does not use docker-compose v1)"
fi

if [ ! -f .env ]; then
  die "no .env - run:  cp .env.example .env    then edit the values it lists"
  echo
  echo "  Nothing below can run without it, so stopping here."
  exit 1
fi

# PLACEHOLDERS ARE THE HIGH-VALUE CHECK. A copied .env produces a Keycloak whose
# admin password is literally `changeme`, and nothing anywhere says so - the
# stack comes up and looks healthy.
#
# BUT ONLY FOR KEYS THAT ARE ACTUALLY LOAD-BEARING, and the first version of
# this got that wrong in both directions on its first real run:
#
#   · GRAFANA_ADMIN_EMAIL=admin@localhost is not a placeholder at all. It is
#     the DEFAULT monitoring/compose.yml declares for itself, twice.
#   · WIKI_DB_PASSWORD=changeme is a placeholder for a service `just up` does
#     not start - apps/wiki is superseded and kept only so `down` cleans up an
#     older deployment.
#
# Failing on either stops a bootstrap that would have worked. So the hard list
# is the credentials that the services `up` DOES start will actually use, and
# everything else is a warning - which is also the honest signal, because a
# placeholder in an unused key is a fact rather than a problem.
REQUIRED_REAL="POSTGRES_PASSWORD DEV_LOGIN_PASSWORD OAUTH2_COOKIE_SECRET KEYCLOAK_DB_PASSWORD KEYCLOAK_OAUTH2_CLIENT_SECRET"
placeholder=0
while IFS='=' read -r k v; do
  case "$k" in ''|\#*) continue ;; esac
  case "$v" in
    changeme|change-me|changeme-generate-one|dev@example.com)
      if printf '%s ' $REQUIRED_REAL | grep -q " $k "; then
        die "$k is still the .env.example placeholder ($v)"; placeholder=1
      else
        # NO BACKTICKS IN A DOUBLE-QUOTED STRING. This line said `just up`
        # inside double quotes and bash COMMAND-SUBSTITUTED it: a warning
        # message started the whole stack, from a throwaway clone, against the
        # real docker daemon - which recreated traefik and keycloak from
        # /tmp because compose project names are global.
        warn "$k is still a placeholder ($v) - nothing that 'just up' starts reads it"
      fi ;;
  esac
done < .env
[ "$placeholder" = 0 ] && ok "every credential the stack actually uses is set"

for k in POSTGRES_PASSWORD DEV_LOGIN_USER DEV_LOGIN_PASSWORD BOX_IP; do
  v="$(grep -E "^$k=" .env | head -1 | cut -d= -f2-)"
  [ -n "$v" ] || die "$k is empty in .env"
done

# Keycloak has loginWithEmailAllowed and oauth2-proxy runs --email-domain=*;
# both assume the dev login looks like an address.
case "${DEV_LOGIN_USER:-}" in
  *@*) ok "DEV_LOGIN_USER looks like an email address" ;;
  *)   die "DEV_LOGIN_USER must be an email address - Keycloak logs in by email" ;;
esac

# uid/gid: three services run as 1000:1000 and write into bind mounts. If the
# installer is not 1000, docker creates root-owned directories and the services
# refuse to start - a failure that looks like a permissions bug in Bothy.
me_u=$(id -u); me_g=$(id -g)
if [ "$me_u" != "1000" ] || [ "$me_g" != "1000" ]; then
  warn "you are ${me_u}:${me_g}, and portal-files/bothy-config/bothy-control run as 1000:1000"
  say "  set PUID=$me_u and PGID=$me_g in .env once those services read them"
fi

addr=$(bash scripts/lib/box-addr.sh)
if [ "$addr" = "127.0.0.1" ]; then
  warn "no tailnet address and no BOX_IP - reachable only from this machine"
  say "  that is a supported way to run Bothy; nothing else on your network will reach it"
else
  ok "this box answers on $addr"
fi

case "$(uname -s)" in
  Linux)
    if [ -f /etc/docker/daemon.json ] && ! grep -q metrics-addr /etc/docker/daemon.json; then
      warn "/etc/docker/daemon.json has no metrics-addr - the docker-daemon Prometheus target will stay down"
      say "  see host/docker/daemon.json for the two lines it needs"
    fi ;;
  Darwin)
    # Docker Desktop only bind-mounts from a shared root, and a clone outside one
    # fails at mount time with an error that never mentions file sharing.
    case "$BOTHY_ROOT" in
      "$HOME"/*|/tmp/*|/private/*|/Volumes/*) ;;
      *) die "on macOS the repo must live under \$HOME, /tmp, /private or /Volumes for Docker Desktop to mount it" ;;
    esac ;;
esac

[ "$bad" = 0 ] || { echo; echo "  Fix the above and run again. Nothing was changed."; exit 1; }

# ── B. create ────────────────────────────────────────────────────────────────
echo
echo "== directories =="
mk() {
  if [ -d "$1" ]; then
    # A directory docker created before we got here is root-owned, and the
    # service that writes to it runs as a normal user. That is the exact failure
    # portal-files' compose comment warns about, and it is silent until start.
    if [ ! -w "$1" ]; then
      die "$1 exists but is not writable by you - sudo chown -R $me_u:$me_g '$1'"
    else
      say "already present  $1"
    fi
  else
    mkdir -p "$1" && ok "created          $1"
  fi
}
mk "$STATE_ROOT/bothy/trash"
mk "$STATE_ROOT/bothy/config-trash"
mk "$STATE_ROOT/devbox-logs"
mk "$BACKUP_ROOT/postgres"
mk "$PROJECTS_ROOT"
mk apps/portal-files/audit
mk apps/bothy-control/audit

# The notes root is a git REPO, not just a directory: portal-files mounts it
# read-write and policy.toml declares it, and the service fails closed without
# it. An empty one is better than a refusal to start, but it must be loud -
# nobody should conclude their notes vanished.
if [ -d "$NOTES_ROOT/.git" ]; then
  say "already present  $NOTES_ROOT (git)"
elif [ -d "$NOTES_ROOT" ]; then
  warn "$NOTES_ROOT exists but is not a git repo - history and the diff view will be empty"
else
  mkdir -p "$NOTES_ROOT" \
    && git -C "$NOTES_ROOT" init -q \
    && printf '# Notes\n\nBothy mounts this directory as the `notes` root.\n' > "$NOTES_ROOT/README.md" \
    && git -C "$NOTES_ROOT" add -A \
    && git -C "$NOTES_ROOT" -c user.email=bothy@localhost -c user.name=Bothy commit -qm "notes: an empty start" \
    && warn "created an EMPTY notes repo at $NOTES_ROOT - yours, if you have one, goes here (NOTES_ROOT in .env)"
fi

# ── C. generate ──────────────────────────────────────────────────────────────
echo
echo "== generated files =="
gen() {  # gen <path> <description> <command...>
  local path="$1" what="$2"; shift 2
  if [ -f "$path" ] && [ "$FORCE" = 0 ]; then
    say "already present  $path"
    return
  fi
  if "$@" > "$path.tmp" 2>/dev/null && [ -s "$path.tmp" ]; then
    mv "$path.tmp" "$path"
    ok "generated        $path  ($what)"
  else
    rm -f "$path.tmp"
    die "could not generate $path"
  fi
}

# Prometheus refuses to start without these two, and they are gitignored with no
# generator anywhere - the single clearest reason `just up` cannot work on a
# fresh clone.
prom_pass="${PROM_PASSWORD:-$DEV_LOGIN_PASSWORD}"
if [ -f monitoring/prom-password.txt ] && [ "$FORCE" = 0 ]; then
  say "already present  monitoring/prom-password.txt"
else
  printf '%s\n' "$prom_pass" > monitoring/prom-password.txt
  chmod 600 monitoring/prom-password.txt
  ok "generated        monitoring/prom-password.txt (the self-scrape password)"
fi

if [ -f monitoring/prometheus-web.yml ] && [ "$FORCE" = 0 ]; then
  say "already present  monitoring/prometheus-web.yml"
else
  hash=$(docker run --rm httpd:2.4-alpine htpasswd -nbB x "$prom_pass" 2>/dev/null | cut -d: -f2)
  if [ -n "$hash" ]; then
    {
      echo "# Prometheus web config. GITIGNORED - contains a password hash."
      echo "# Generated by scripts/bootstrap.sh from DEV_LOGIN_USER/DEV_LOGIN_PASSWORD."
      echo "basic_auth_users:"
      echo "  \"$DEV_LOGIN_USER\": \"$hash\""
    } > monitoring/prometheus-web.yml
    ok "generated        monitoring/prometheus-web.yml (bcrypt, from the dev login)"
  else
    die "could not run httpd:2.4-alpine to hash the Prometheus password"
  fi
fi

# The route that carries the Overview's graphs. There is already a generator for
# it; calling it beats reimplementing it, and it is cheap enough to always run
# because it is purely derived from .env.
if bash scripts/gen-portal-prom-route.sh >/dev/null 2>&1; then
  ok "generated        edge/dynamic/portal-prom.yml (the Prometheus data plane)"
else
  die "scripts/gen-portal-prom-route.sh failed"
fi

echo
if [ "$bad" = 0 ]; then
  echo "  Ready. \`just up\` will start the stack."
else
  echo "  Finished with problems above."
fi
exit "$bad"
