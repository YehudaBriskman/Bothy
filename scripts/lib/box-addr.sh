#!/usr/bin/env bash
# What address does a browser use to reach this box? Prints it, or nothing.
#
# THE ORDER IS THE ARGUMENT, and each rung exists because the one below it is
# wrong in some real case:
#
#   1. $BOTHY_BASE_HOST   an explicit override. CI, a tunnel, a second address.
#   2. tailscale ip -4    the truth when tailscale is running, and it survives
#                         the address changing without anybody editing a file.
#   3. $BOX_IP from .env  the declared answer. Also what Keycloak's issuer and
#                         redirect URI are built from, so on a box with a stale
#                         tailscale this at least AGREES with the thing that
#                         will actually validate the login.
#   4. 127.0.0.1          not a fallback so much as an admission: no tailnet, no
#                         declared address, so the only honest answer is "here".
#
# BOX_IP KEEPS ITS NAME on purpose. auth/compose.yml spends thirty lines
# explaining that the issuer, the redirect URI and the cookie domain are all
# built from one value so they cannot drift apart, and introducing a second name
# for the same address is precisely the failure it warns about.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$here/env.sh"

if [ -n "${BOTHY_BASE_HOST:-}" ]; then
  printf '%s\n' "$BOTHY_BASE_HOST"
  exit 0
fi

# `tailscale status` first: `tailscale ip` answers even when the daemon is down
# or the node is logged out, and an address nothing is listening on is worse
# than no address, because every later failure looks like a service fault.
if command -v tailscale >/dev/null 2>&1 \
   && tailscale status --json >/dev/null 2>&1; then
  ip=$(tailscale ip -4 2>/dev/null | head -1)
  [ -n "$ip" ] && { printf '%s\n' "$ip"; exit 0; }
fi

if [ -n "${BOX_IP:-}" ]; then
  printf '%s\n' "$BOX_IP"
  exit 0
fi

printf '127.0.0.1\n'
