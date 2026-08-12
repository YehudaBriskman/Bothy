set dotenv-load := true

# List recipes
default:
    @just --list

# Create the shared docker networks (idempotent)
network:
    -docker network create devnet 2>/dev/null || true
    # socketnet holds exactly two containers: traefik + portal-socket-proxy.
    # docker-socket-proxy has NO auth, so network reachability IS authorisation —
    # on devnet, any of ~20 containers (incl. third-party wiki.js, kafka-ui) could
    # read the docker socket through it. Keep the blast radius at two.
    -docker network create socketnet 2>/dev/null || true

# Bring up EVERYTHING
up: network up-edge up-auth up-monitoring up-data up-mgmt up-apps
    @echo "All stacks up. Run 'just urls' for access."

# Edge: Traefik — the single front door on :80, routes *.test by Host header.
# Must come up before anything that expects to be routed.
up-edge: network
    docker compose -f edge/compose.yml up -d

# SSO: oauth2-proxy, guards the dashboards that have no login of their own.
# Must be up before the routers that reference its middleware.
up-auth: network
    docker compose -f auth/compose.yml up -d

# Observability: grafana, prometheus, loki, cadvisor, node-exporter
up-monitoring: network
    docker compose -f monitoring/compose.yml up -d

# Data services: postgres, redis, kafka (+ their exporters)
up-data: network
    docker compose -f data/postgres/compose.yml up -d
    docker compose -f data/redis/compose.yml up -d
    docker compose -f data/kafka/compose.yml up -d

# Management UIs: portainer, dozzle
up-mgmt: network
    docker compose -f mgmt/compose.yml up -d

# Apps: the portal homepage + the docs site.
#
# apps/portal is the RETIRED pure-HTML portal — its nginx carries
# traefik.enable=false, but its compose file also owns portal-socket-proxy, which
# the live portal's Docker API depends on. So it stays up; do not remove it.
# apps/portal-next is what actually serves dev.test.
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
    # superseded by apps/docs — kept so an older deployment still gets cleaned up
    -docker compose -f apps/wiki/compose.yml down
    -docker compose -f mgmt/compose.yml down
    -docker compose -f data/kafka/compose.yml down
    -docker compose -f data/redis/compose.yml down
    -docker compose -f data/postgres/compose.yml down
    -docker compose -f monitoring/compose.yml down

# Stop everything AND delete all data volumes (DESTRUCTIVE)
# Sits one keystroke from `down` in the recipe list and deletes all seven data
# volumes: postgres, redis, kafka, prometheus, grafana, loki, portainer.
nuke:
    @printf "This deletes ALL data volumes. Type yes to continue: " && read ans && [ "$ans" = yes ] || (echo aborted; exit 1)
    -docker compose -f auth/compose.yml down -v
    -docker compose -f edge/compose.yml down -v
    -docker compose -f apps/portal-next/compose.yml down -v
    -docker compose -f apps/docs/compose.yml down -v
    -docker compose -f apps/portal/compose.yml down -v
    -docker compose -f apps/wiki/compose.yml down -v
    -docker compose -f mgmt/compose.yml down -v
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

# Back up postgres/redis/grafana/portainer now (nightly timer also runs this)
backup:
    @bash scripts/backup.sh

# Follow a container's logs, e.g. `just logs grafana`
logs service:
    docker logs -f --tail 100 {{service}}

# Open a psql shell on the dev database
psql:
    docker exec -it postgres psql -U ${POSTGRES_USER:-dev} -d ${POSTGRES_DB:-dev}

# Open a redis-cli shell
redis:
    docker exec -it redis redis-cli

# Regenerate the portal's read-only Prometheus route (edge/dynamic/portal-prom.yml).
#
# That file carries the basic-auth header the edge injects on the portal's
# behalf, so it is GITIGNORED and generated from .env rather than committed.
# Run this on a fresh clone, and again after changing DEV_LOGIN_*. Traefik
# watches ./dynamic, so no restart is needed.
portal-prom-route:
    ./scripts/gen-portal-prom-route.sh

# Print access URLs. Pure-IP-over-tailscale model (2026-08-08): every service
# has a published host port on this node's tailnet IP. Traefik Host-name routing
# (*.dev.test) is DORMANT until a DNS layer returns — see edge/dynamic/auth.yml.
urls:
    #!/usr/bin/env bash
    # Identity is read from tailscale at run time and never stored in this repo:
    # the node name/IP identify the owner's tailnet, and this repo is public.
    IP=$(tailscale ip -4 2>/dev/null | head -1); IP=${IP:-<this-node-ip>}
    HOST=$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // ""' | sed 's/\.$//'); HOST=${HOST:-<this-node>}
    echo "This box is a tailnet node: $HOST / $IP — reachable directly."
    echo "Access is by IP:port ($HOST:<port> also works — MagicDNS is free)."
    echo ""
    echo "  ⭐ START HERE   http://$IP/             (the portal — index of everything)"
    echo ""
    echo "  Stack services:"
    echo "    Grafana       http://$IP:3000         (unified dev login)"
    echo "    Prometheus    http://$IP:9090"
    echo "    Dozzle        http://$IP:8080         (live container logs)"
    echo "    Kafka-UI      http://$IP:8081"
    echo "    cAdvisor      http://$IP:8082"
    echo "    Docs          http://$IP:8085         (MkDocs, auto-rebuilt)"
    echo "    Portainer     http://$IP:9000         (unified dev login)"
    echo "    node-exporter http://$IP:9100"
    echo "    Loki          http://$IP:3100         (API only; 404 at / is normal)"
    echo "    Wiki.js       http://$IP:3001         (stack currently down)"
    echo "    Tilt          http://$IP:10350        (when tilt up --host=0.0.0.0 runs)"
    echo ""
    echo "  Windows-host mirrors via portproxy: http://100.93.197.10:<port> from the"
    echo "  tailnet, or localhost:<port> on the host. Same ports; LAN is NOT served."
    echo ""
    echo "  Logins: one unified dev login everywhere a login exists — username is"
    echo "  the owner gmail, password = DEV_LOGIN_PASSWORD in the gitignored .env."
    echo ""
    echo "  <name>.dev.test routing + the Traefik dashboard are DORMANT (no DNS)."
    echo "  Route data is still live at http://$IP/-/api/traefik/http/routers"
    echo ""
    echo "Databases stay off the network (loopback-bound). Reach via ssh tunnel:"
    echo "  ssh -L 5432:localhost:5432 -L 6379:localhost:6379 -L 9092:localhost:9092 $USER@$IP"
    echo ""
    echo "If the tailnet IP serves headers but bodies stall, or SSH hangs at KEX:"
    echo "  that is the large-packet blackhole — restart tailscaled ON THIS BOX."
    echo "  See docs/kb/incidents/2026-08-08-wsl-node-large-packet-blackhole.md."
