# ~/stacks — Docker dev playground

One-command Docker environment: observability, dev data services, and management
UIs, all on a shared `devnet` network, driven by `just`.

## Quick start
```sh
just up        # bring up everything
just urls      # print dashboard URLs + the ssh tunnel to run from your laptop
just ps        # what's running
just down      # stop all (keeps data)
just nuke      # stop all AND wipe data volumes
```

## Layout
- `monitoring/` — Grafana, Prometheus, Loki+Promtail (logs), cAdvisor (containers),
  node-exporter (host). Grafana comes up with datasources auto-provisioned.
- `data/` — postgres, redis, kafka, each bundled with a Prometheus exporter so
  Grafana can see their health.
- `mgmt/` — Portainer (manage) + Dozzle (live logs).

## Access from a laptop (SSH tunnel)
`just urls` prints the exact `ssh -L ...` command. Open the tunnel, then browse
`localhost:<port>` as if the services were local.

| Service    | Port | Notes |
|------------|------|-------|
| Grafana    | 3000 | admin / admin |
| Prometheus | 9090 | |
| Portainer  | 9000 | set admin password on first visit |
| Dozzle     | 8080 | live container logs |
| Kafka-UI   | 8081 | |
| Postgres   | 5432 | dev / devpass |
| Redis      | 6379 | |
| Kafka      | 9092 | host clients use localhost:9092 |

## Notes
- Credentials live in `.env` (dev-only, not for production).
- Docker daemon is hardened in `/etc/docker/daemon.json`: log rotation
  (10m x 3) and metrics exposed on :9323 (scraped by Prometheus).
- "Grafana for everything": host + every container + DB/Kafka exporters +
  Docker daemon, plus all container logs searchable via Loki.
