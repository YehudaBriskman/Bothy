set dotenv-load := true

# List recipes
default:
    @just --list

# Create the shared docker networks (idempotent)
network:
    -docker network create devnet 2>/dev/null || true
    # socketnet holds exactly two containers: traefik + portal-socket-proxy.
    # docker-socket-proxy has NO auth, so network reachability IS authorisation -
    # on devnet, any of ~20 containers (incl. third-party wiki.js, kafka-ui) could
    # read the docker socket through it. Keep the blast radius at two.
    -docker network create socketnet 2>/dev/null || true

# Bring up EVERYTHING
up: network up-edge up-auth up-monitoring up-data up-mgmt up-apps
    @echo "All stacks up. Run 'just urls' for access."

# Edge: Traefik - the single front door on :80. It no longer routes anything by
# Host header (the name layer was deleted 2026-08-12); what it still owns is the
# portal's host-less /-/api/* data plane and the catch-all that serves the portal
# on the bare IP. Must come up before anything that expects to be routed.
up-edge: network
    docker compose -f edge/compose.yml up -d

# Identity: Keycloak (the IdP) + oauth2-proxy (what Traefik's forwardAuth asks).
#
# One `up -d` brings the whole chain up in order, because the compose file
# expresses the ordering itself: the database bootstrap must EXIT SUCCESSFULLY
# before Keycloak starts, and Keycloak must be HEALTHY before oauth2-proxy and
# the post-import fixes run. So this blocks for as long as that takes - a minute
# or two on first boot, while Keycloak builds and creates its schema.
#
# Nothing here enforces anything yet: it defines the `sso@file` middleware,
# it does not attach it to any router. See edge/dynamic/auth.yml.
up-auth: network
    #!/usr/bin/env bash
    set -euo pipefail
    docker compose -f auth/compose.yml up -d
    IP=$(tailscale ip -4 2>/dev/null | head -1); IP=${IP:-$BOX_IP}
    echo ""
    echo "  Keycloak admin   http://$IP:8090/admin  (admin / DEV_LOGIN_PASSWORD in .env - the shared dev login)"
    echo "  OIDC discovery   http://$IP:8090/realms/devbox/.well-known/openid-configuration"
    echo ""
    echo "  The 'issuer' in that document must equal oauth2-proxy's"
    echo "  --oidc-issuer-url exactly. If they ever differ, the symptom is a"
    echo "  redirect loop, not an error. Check it after changing BOX_IP:"
    echo "    curl -s http://$IP:8090/realms/devbox/.well-known/openid-configuration | jq -r .issuer"

# Observability: grafana, prometheus, loki, cadvisor, node-exporter
up-monitoring: network
    docker compose -f monitoring/compose.yml up -d

# Data services: postgres (+ its exporter).
#
# redis and kafka were RETIRED 2026-08-12 and are no longer started here. Both
# were measured completely idle - redis `DBSIZE` = 0, kafka `--list` = zero
# topics - while together holding ~1,140 MB of the box's 4,678 MB of container
# memory. Their compose files are kept on disk (same precedent as apps/wiki)
# and are still referenced by `down` and `nuke` below, so an older deployment
# still gets cleaned up.
#
# THEIR DATA IS GONE. An earlier version of this comment said the volumes were
# "PRESERVED, not deleted" - that was true for about twenty minutes. The
# `kafka_data` and `redis_data` volumes were removed afterwards, along with the
# images (apache/kafka, kafbat/kafka-ui, danielqsj/kafka-exporter, redis:8-alpine,
# oliver006/redis_exporter). Verified 2026-08-12: neither name appears in
# `docker volume ls`. So the commands below do NOT restore anything - they pull
# fresh images and start an EMPTY broker / an EMPTY keyspace:
#   docker compose -f data/redis/compose.yml up -d   # new, empty
#   docker compose -f data/kafka/compose.yml up -d   # new, empty
# Nothing that was in them comes back. (Nothing was in them, which is why they
# went; the point is that the instruction must not promise otherwise.)
#
# postgres stays: it is in active use - Keycloak's database lives there.
up-data: network
    docker compose -f data/postgres/compose.yml up -d

# Management UIs: portainer, dozzle
up-mgmt: network
    docker compose -f mgmt/compose.yml up -d

# Apps: the portal homepage + the docs site.
#
# apps/portal is the RETIRED pure-HTML portal - its nginx carries
# traefik.enable=false, but its compose file also owns portal-socket-proxy, which
# the live portal's Docker API depends on. So it stays up; do not remove it.
# apps/portal-next is what actually serves the portal, on the bare IP.
# apps/wiki (Wiki.js) was superseded by apps/docs and is no longer started; its
# compose file is kept so `just down` can still clean up an old deployment.
up-apps: network
    docker compose -f apps/portal/compose.yml up -d
    docker compose -f apps/portal-next/compose.yml up -d
    docker compose -f apps/docs/compose.yml up -d

# Stop everything (keeps volumes/data)
down:
    -docker compose -f auth/compose.yml down
    -docker compose -f edge/compose.yml down
    -docker compose -f apps/portal-next/compose.yml down
    -docker compose -f apps/docs/compose.yml down
    -docker compose -f apps/portal/compose.yml down
    # superseded by apps/docs - kept so an older deployment still gets cleaned up
    -docker compose -f apps/wiki/compose.yml down
    -docker compose -f mgmt/compose.yml down
    # retired 2026-08-12 (idle: zero topics / zero keys) - no longer in `up-data`,
    # kept here so an older deployment still gets cleaned up
    -docker compose -f data/kafka/compose.yml down
    -docker compose -f data/redis/compose.yml down
    -docker compose -f data/postgres/compose.yml down
    -docker compose -f monitoring/compose.yml down

# Stop everything AND delete all data volumes (DESTRUCTIVE)
# Sits one keystroke from `down` in the recipe list and deletes every data
# volume that still exists: postgres, prometheus, grafana, loki, portainer.
# (redis_data and kafka_data were already deleted on 2026-08-12 - those two
# lines below are now no-ops on this box.)
nuke:
    @printf "This deletes ALL data volumes. Type yes to continue: " && read ans && [ "$ans" = yes ] || (echo aborted; exit 1)
    -docker compose -f auth/compose.yml down -v
    -docker compose -f edge/compose.yml down -v
    -docker compose -f apps/portal-next/compose.yml down -v
    -docker compose -f apps/docs/compose.yml down -v
    -docker compose -f apps/portal/compose.yml down -v
    -docker compose -f apps/wiki/compose.yml down -v
    -docker compose -f mgmt/compose.yml down -v
    # retired 2026-08-12 and their volumes already deleted, so `-v` here is a
    # no-op for them - kept only so an older deployment still gets cleaned up
    -docker compose -f data/kafka/compose.yml down -v
    -docker compose -f data/redis/compose.yml down -v
    -docker compose -f data/postgres/compose.yml down -v
    -docker compose -f monitoring/compose.yml down -v

# Show running containers
ps:
    docker ps

# One-glance health check of the whole environment
doctor:
    @bash scripts/doctor.sh

# Verify the access model still holds - run after ANY edge/routing change.
# `just verify selftest` additionally proves the template-error probe can fail,
# by voiding a dynamic file on purpose and cleaning it up again.
verify mode="":
    @VERIFY_SELFTEST={{ if mode == "selftest" { "1" } else { "" } }} bash scripts/verify-access.sh

# Back up postgres/redis/grafana/portainer now (nightly timer also runs this)
backup:
    @bash scripts/backup.sh

# Follow a container's logs, e.g. `just logs grafana`
logs service:
    docker logs -f --tail 100 {{service}}

# Open a psql shell on the dev database
psql:
    docker exec -it postgres psql -U ${POSTGRES_USER:-dev} -d ${POSTGRES_DB:-dev}

# `just redis` is GONE (2026-08-12) - redis was retired as idle (0 keys). A
# recipe that always fails is worse than a missing one: it looks like breakage.
# `docker compose -f data/redis/compose.yml up -d` starts a NEW, EMPTY redis:
# the redis_data volume and the images were deleted after the retirement, so
# there is nothing left to restore.

# Regenerate the portal's read-only Prometheus route (edge/dynamic/portal-prom.yml).
#
# That file carries the basic-auth header the edge injects on the portal's
# behalf, so it is GITIGNORED and generated from .env rather than committed.
# Run this on a fresh clone, and again after changing DEV_LOGIN_*. Traefik
# watches ./dynamic, so no restart is needed.
portal-prom-route:
    ./scripts/gen-portal-prom-route.sh

# Print access URLs. Pure-IP-over-tailscale model: every service has a published
# host port on this node's tailnet IP.
#
# Traefik Host-name routing (*.dev.test) is DELETED as of 2026-08-12 - not
# dormant, not waiting on a DNS layer. Zero Host() rules remain in the router
# table. A new service publishes a port; it does not declare a name.
urls:
    #!/usr/bin/env bash
    # Identity is read from tailscale at run time and never stored in this repo:
    # the node name/IP identify the owner's tailnet, and this repo is public.
    IP=$(tailscale ip -4 2>/dev/null | head -1); IP=${IP:-<this-node-ip>}
    HOST=$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // ""' | sed 's/\.$//'); HOST=${HOST:-<this-node>}
    echo "This box is a tailnet node: $HOST / $IP - reachable directly."
    echo "Access is by IP:port ($HOST:<port> also works - MagicDNS is free)."
    echo ""
    echo "  ⭐ START HERE   http://$IP/             (the portal - index of everything)"
    echo ""
    echo "  Stack services:"
    echo "    Grafana       http://$IP:3000         (unified dev login)"
    echo "    Prometheus    http://$IP:9090"
    echo "    Dozzle        http://$IP:8080         (live container logs)"
    echo "    cAdvisor      http://$IP:8082"
    echo "    Docs          http://$IP:8085         (MkDocs, auto-rebuilt)"
    echo "    Portainer     http://$IP:9000         (unified dev login)"
    echo "    node-exporter http://$IP:9100"
    echo "    Loki          http://$IP:3100         (API only; 404 at / is normal)"
    echo "    Keycloak      http://$IP:8090/admin   (identity - admin / shared dev login)"
    echo ""
    echo "  Not running right now - nothing was deleted, both come back:"
    echo "    Wiki.js       http://$IP:3001"
    echo "      A stack service, superseded by Docs (:8085) and dropped from"
    echo "      'just up-apps'. Its compose file AND its 'wiki' database in the"
    echo "      shared postgres are both intact, so this restores it WITH its"
    echo "      content - that is why it is still listed rather than deleted:"
    echo "        docker compose -f apps/wiki/compose.yml up -d"
    echo "    Tilt          http://$IP:10350"
    echo "      NOT a stack service - a per-project dev server under ~/projects"
    echo "      (CVOps, Tals) that you start by hand. Nothing is wrong when this"
    echo "      port is dead; that is its normal state between sessions:"
    echo "        tilt up --host=0.0.0.0"
    echo ""
    echo "  Reserved by projects (listed so the stack never picks them):"
    echo "    CVOps nginx   http://$IP:8086         (project edge, compose mode)"
    echo "    CVOps garage  http://$IP:3900         (S3 blobs - the BROWSER fetches"
    echo "                                           these directly, so it must stay"
    echo "                                           0.0.0.0-bound, not loopback)"
    echo "    Tals frontend http://$IP:5173         (ports in Tals' .ports.lock)"
    echo ""
    echo "  Retired 2026-08-12 - measured idle, then DELETED. Data NOT recoverable:"
    echo "    Kafka + Kafka-UI (was :8081)  zero topics      ~1,110 MB"
    echo "    Redis            (was :6379)  zero keys           ~30 MB"
    echo "    minikube         (local k8s)  zero user pods   ~1,046 MB"
    echo "      All three were first stopped and kept, then removed for real:"
    echo "      the kafka_data and redis_data volumes and every image are gone,"
    echo "      and 'minikube delete' ran at 13:56 (no profile remains)."
    echo "      The compose files survive, so these commands still WORK - but"
    echo "      each one builds something BRAND NEW AND EMPTY, it does not"
    echo "      resume anything:"
    echo "        docker compose -f data/kafka/compose.yml up -d   # empty broker"
    echo "        docker compose -f data/redis/compose.yml up -d   # empty keyspace"
    echo "        minikube start                                  # empty cluster"
    echo ""
    echo "  Windows-host mirrors via portproxy: http://100.93.197.10:<port> from the"
    echo "  tailnet, or localhost:<port> on the host. Same ports; LAN is NOT served."
    echo ""
    echo "  Logins: one unified dev login everywhere a login exists - username is"
    echo "  the owner gmail, password = DEV_LOGIN_PASSWORD in the gitignored .env."
    echo ""
    echo "  Name-based routing (<name>.dev.test) and the Traefik dashboard were"
    echo "  DELETED on 2026-08-12 - publish a port, never a Host() rule."
    echo "  Route data is still live at http://$IP/-/api/traefik/http/routers"
    echo ""
    echo "Databases stay off the network (loopback-bound). Reach via ssh tunnel:"
    echo "  ssh -L 5432:localhost:5432 $USER@$IP"
    echo "  (6379/redis and 9092/kafka were retired 2026-08-12 - nothing listens"
    echo "   on them now; add those -L flags back if you restart either stack.)"
    echo ""
    echo "If the tailnet IP serves headers but bodies stall, or SSH hangs at KEX:"
    echo "  that is the large-packet blackhole - restart tailscaled ON THIS BOX."
    echo "  See docs/kb/incidents/2026-08-08-wsl-node-large-packet-blackhole.md."
