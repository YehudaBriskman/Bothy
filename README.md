# ~/stacks — the dev box

Docker stacks for a self-hosted development box: observability, dev data
services, management UIs and a couple of small apps, all behind one reverse
proxy, reachable by name from anywhere on the tailnet, driven by `just`.

## Quick start

```sh
just up        # bring everything up, in dependency order
just urls      # print every address
just ps        # what is running
just doctor    # health check the whole box
just backup    # run the backup that the 03:00 timer also runs
just down      # stop everything, keep the data
just nuke      # stop everything AND delete every volume — destructive
```

**Always use `just`, not `docker compose` directly.** `just` loads the root
`.env` via `set dotenv-load`; `docker compose` looks for a `.env` beside the
compose file it was handed, finds none, and silently falls back to the insecure
defaults — or aborts on a required variable.

## How you reach things

Traefik owns port 80 and routes by `Host` header. Every service has a name
under `*.dev.test`; none of them needs a port number.

| | |
|---|---|
| **Portal** | http://dev.test — the index, discovers what is running |
| Grafana | http://grafana.dev.test |
| Prometheus | http://prometheus.dev.test |
| Dozzle | http://dozzle.dev.test — live container logs |
| Portainer | http://portainer.dev.test |
| Kafka-UI | http://kafka.dev.test |
| Wiki.js | http://wiki.dev.test |
| Traefik | http://traefik.dev.test — which routes are registered |

Those names resolve because dnsmasq on this box is authoritative for `.test`,
and Tailscale **split DNS** routes `test` queries to it for every device on the
tailnet. Nothing is published to the LAN or the internet, and the tailnet is
WireGuard, so plain `http://` here is encrypted in transit.

A device that is not connected to the tailnet gets `NXDOMAIN` — that is the
first thing to check when a name "stops working".

Databases are not routed by name. Reach them over SSH:

```sh
ssh -L 5432:localhost:5432 -L 6379:localhost:6379 -L 9092:localhost:9092 \
    devssh@<this-node>.<your-tailnet>.ts.net
```

## Authentication

Services with no login of their own — Dozzle, Kafka-UI, Prometheus, the Traefik
dashboard and the portal — sit behind **GitHub SSO** (oauth2-proxy as a Traefik
`forwardAuth` target). One sign-in covers all of them, since the cookie is
scoped to `.dev.test`, and only one GitHub account is permitted.

Portainer is also behind SSO because it mounts the Docker socket read-write:
its UI exposes container environment variables and container exec, which is
root on this box. Grafana and Wiki.js keep their own logins.

## Layout

| Directory | What it is |
|---|---|
| `edge/` | Traefik — the only container that publishes :80. `edge/dynamic/` holds routes for things that have no container labels. |
| `auth/` | oauth2-proxy, the SSO layer Traefik defers to. |
| `monitoring/` | Prometheus, Grafana, Loki + Promtail, cAdvisor, node-exporter. Datasources and dashboards are auto-provisioned. |
| `data/` | Postgres, Redis, Kafka — each with a Prometheus exporter. |
| `mgmt/` | Portainer and Dozzle. |
| `apps/` | The portal homepage and Wiki.js. |
| `host/` | Copies of the host configuration that is not in any container — see `host/README.md`. Required to rebuild this box. |
| `scripts/` | `backup.sh` and `doctor.sh`. |

Adding a service means two Traefik labels and a name. It does not mean picking a
port: ports are a flat namespace of 65535 that everyone collides in, names are
unlimited.

## Credentials

Everything lives in `.env`, which is gitignored. `.env.example` lists every
variable, including the ones without which `just up` will not complete
(`WIKI_DB_PASSWORD`, and the `OAUTH2_*` values for SSO).

`.env` exists in exactly one place, so it is included in the backup.

## Backups

`stacks-backup.timer` runs `scripts/backup.sh` at 03:00 daily, keeping the
newest 14 of each: the Postgres dump, the Redis snapshot, the Grafana and
Portainer databases, and `.env`.

The script waits for Postgres to accept connections before dumping, verifies
every artifact is non-empty before keeping it, and exits non-zero if any step
failed. That is deliberate: it previously produced 20-byte empty dumps for six
days while reporting success, because the timer is `Persistent=true` and a
schedule missed while the box was off fires at the next boot — exactly when
Postgres is still starting.

Backups sit on the same disk they protect. Copying them off the box is not
solved yet.

## Things that will catch you

**The box must stay awake.** WSL2 destroys the VM 60 seconds after the last
Windows-side client disconnects, which takes docker and every container with it.
A Windows scheduled task holds it open — see `host/README.md`. This is why the
box used to appear to work only while somebody was connected over SSH.

**Traefik's `edge/dynamic` mount goes stale after `git checkout`.** A bind mount
pins the host inode at container creation, and checkout recreates directories,
so Traefik silently keeps serving its last in-memory config and
`--providers.file.watch=true` stops meaning anything:

```sh
docker compose -f edge/compose.yml up -d --force-recreate
```

**`/etc/resolv.conf` is immutable on purpose.** WSL rewrites it whenever Windows'
DNS configuration changes. `sudo chattr -i` to edit, `+i` when done.

**A plain `curl http://x.dev.test` that hangs while `curl -4` works** means
something is answering AAAA queries with silence instead of NODATA. dnsmasq is
configured with `local=/test/` to prevent exactly that.
