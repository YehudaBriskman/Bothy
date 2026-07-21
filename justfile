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

# Apps: portal homepage (nginx) + wiki (Wiki.js)
up-apps: network
    docker compose -f apps/portal/compose.yml up -d
    docker compose -f apps/wiki/compose.yml up -d

# Stop everything (keeps volumes/data)
down:
    -docker compose -f auth/compose.yml down
    -docker compose -f edge/compose.yml down
    -docker compose -f apps/portal/compose.yml down
    -docker compose -f apps/wiki/compose.yml down
    -docker compose -f mgmt/compose.yml down
    -docker compose -f data/kafka/compose.yml down
    -docker compose -f data/redis/compose.yml down
    -docker compose -f data/postgres/compose.yml down
    -docker compose -f monitoring/compose.yml down

# Stop everything AND delete all data volumes (DESTRUCTIVE)
nuke:
    -docker compose -f auth/compose.yml down -v
    -docker compose -f edge/compose.yml down -v
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

# Print access URLs. Named services route through Traefik; *.test resolves via
# the local dnsmasq, published to the tailnet by Tailscale split DNS.
urls:
    @echo "This box is a tailnet node: <this-node> / <this-node-ip> — reachable directly,"
    @echo "no portproxy. Any *.test name resolves to it from any device on the tailnet."
    @echo ""
    @echo "  ⭐ START HERE   http://dev.test          (the portal — index of everything)"
    @echo ""
    @echo "  Stack services  <name>.dev.test:"
    @echo "    Grafana       http://grafana.dev.test      (admin / admin)"
    @echo "    Prometheus    http://prometheus.dev.test"
    @echo "    Dozzle        http://dozzle.dev.test       (live container logs)"
    @echo "    Portainer     http://portainer.dev.test    (set password on first visit)"
    @echo "    Kafka-UI      http://kafka.dev.test"
    @echo "    Wiki.js       http://wiki.dev.test         (login required)"
    @echo "    Traefik       http://traefik.dev.test      (which routes are registered)"
    @echo ""
    @echo "  Projects        <project>.dev.test — their pieces nest underneath:"
    @echo "    CVOps         http://cvops.dev.test        (run 'tilt up' in the repo first)"
    @echo "    CVOps · Tilt  http://tilt.cvops.dev.test   (needs 'tilt up --host=0.0.0.0')"
    @echo "    CVOps · S3    http://s3.cvops.dev.test     (garage; presigned URLs only)"
    @echo ""
    @echo "  Adding a service = 2 Traefik labels + a name, never a port."
    @echo "  See ~/claude-notes/dev-networking.md."
    @echo ""
    @echo "  The bare IP http://<this-node-ip> (and the legacy http://<legacy-portproxy-ip> via"
    @echo "  the Windows portproxy) still lands on the portal — Traefik catch-all route."
    @echo ""
    @echo "Databases stay off the network (loopback-bound). Reach via ssh tunnel:"
    @echo "  ssh -L 5432:localhost:5432 -L 6379:localhost:6379 -L 9092:localhost:9092 devssh@<this-node-ip>"
    @echo ""
    @echo "If *.test stops resolving: check 'systemctl status dnsmasq' and that Tailscale"
    @echo "split DNS (admin console → DNS → Nameservers) still points 'test' at <this-node-ip>."
