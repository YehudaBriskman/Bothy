set dotenv-load := true

# List recipes
default:
    @just --list

# Create the shared docker network (idempotent)
network:
    -docker network create devnet 2>/dev/null || true

# Bring up EVERYTHING
up: network up-monitoring up-data up-mgmt
    @echo "All stacks up. Run 'just urls' for access."

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

# Stop everything (keeps volumes/data)
down:
    -docker compose -f mgmt/compose.yml down
    -docker compose -f data/kafka/compose.yml down
    -docker compose -f data/redis/compose.yml down
    -docker compose -f data/postgres/compose.yml down
    -docker compose -f monitoring/compose.yml down

# Stop everything AND delete all data volumes (DESTRUCTIVE)
nuke:
    -docker compose -f mgmt/compose.yml down -v
    -docker compose -f data/kafka/compose.yml down -v
    -docker compose -f data/redis/compose.yml down -v
    -docker compose -f data/postgres/compose.yml down -v
    -docker compose -f monitoring/compose.yml down -v

# Show running containers
ps:
    docker ps

# Follow a container's logs, e.g. `just logs grafana`
logs service:
    docker logs -f --tail 100 {{service}}

# Open a psql shell on the dev database
psql:
    docker exec -it postgres psql -U ${POSTGRES_USER:-dev} -d ${POSTGRES_DB:-dev}

# Open a redis-cli shell
redis:
    docker exec -it redis redis-cli

# Print the direct dashboard URLs (no tunnel — Windows port-proxy forwards to WSL)
urls:
    @echo "Direct access from your laptop — no tunnel. Use whichever host reaches you:"
    @echo "  Tailscale (anywhere): 100.93.197.10   |   LAN: 192.168.68.57"
    @echo ""
    @echo "  Grafana      http://100.93.197.10:3000   (admin / admin)"
    @echo "  Prometheus   http://100.93.197.10:9090"
    @echo "  Portainer    http://100.93.197.10:9000   (set password on first visit)"
    @echo "  Dozzle       http://100.93.197.10:8080   (live container logs)"
    @echo "  Kafka-UI     http://100.93.197.10:8081"
    @echo ""
    @echo "Databases are NOT port-proxied (kept off the network). Reach via ssh tunnel:"
    @echo "  ssh -L 5432:localhost:5432 -L 6379:localhost:6379 -L 9092:localhost:9092 devssh@100.93.197.10"
