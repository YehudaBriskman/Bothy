# Architecture - what actually runs inside the dev box

_Condensed from the 2026-07 audit (full detail: `C:\Users\yr055\dev-box-audit.md`).
Live tree: `~/stacks` in devssh's WSL distro, on `main`. Audit rule: **read the live box,
never trust `origin/main` to describe it** - see [lessons.md](lessons.md)._

## The front door - since 2026-08-12: direct ports, Traefik for the portal only

Primary access is **published ports on the tailnet IP** (table in [access.md](access.md)).
**Traefik v3.7** (`edge/`) still owns :80, but only for the portal (now **portal-next** -
the old `portal` container is `traefik.enable=false`) via its prio-1 fallback router,
plus the prio-100 Host-less `Path()` routers for `/-/api/{traefik,docker,loki,prom}/*`.

**The the name layer Host routers were deleted on 2026-08-12**, having been dormant
since 2026-08-08. Measured: the router table went **22 → 6**, and **zero `Host()`
rules remain**. Nothing became unreachable - every browser-facing service already
published a host port - and a 20-check verification harness passed 20/20 after the
change. [dns.md](dns.md) records what state each layer is in; restoring names is now
a **rebuild, not a switch**.

The router table, verified 2026-08-12:

| Router | Rule | Priority |
|---|---|---|
| `portal-api-docker@file` | 2 exact `Path()`s under `/-/api/docker/` | 100 |
| `portal-api-loki@file` | 2 exact `Path()`s under `/-/api/loki/` | 100 |
| `portal-api-prom@file` | 2 exact `Path()`s under `/-/api/prom/` | 100 |
| `portal-api-traefik@file` | 4 exact `Path()`s under `/-/api/traefik/` | 100 |
| `portal-next-fallback@docker` | `PathPrefix(/)` - the catch-all | 1 |
| `prometheus@internal` | `PathPrefix(/metrics)` on the internal `:8899` entrypoint | - |

**The Traefik dashboard was deleted in the same change** because it was leaking a
credential: `--api.dashboard=true` became `--api=true`. The API must stay on - the
four `portal-api-traefik` paths use `service: api@internal` - but it is no longer
browsable. Full write-up in [lessons.md](lessons.md).

**GitHub SSO (oauth2-proxy) is PARKED** - container down, `edge/dynamic/auth.yml`
fully commented. A 401 anywhere now indicates regression, not health. Grafana and
Portainer keep their own auth; dozzle, kafka-ui, prometheus and the portal API are
tailnet-open (known-issues). **Keycloak is replacing it in a separate change**, so
treat `auth/` as in flight rather than as the final shape.

## The portal

Live-discovery page: polls the Traefik API + docker container list every 10s
through `portal-socket-proxy` (tecnativa docker-socket-proxy, `CONTAINERS=1` +
`SYSTEM=1`, read-only socket, `POST=0`, no published port). Health display fixed in
PR #11 (`container.Health?.Status` - Health is an object, not a string).

Since 2026-08-12 the Traefik half of that join returns only six routers, none with a
hostname, so classification falls through to the compose `config_files` label. The
hostname-nesting logic is retained but is effectively dormant.

## Also on the box

- **cvops** project (5 containers, DBs on loopback, shifted ports 15432/16379)
- **minikube** (own systemd unit)
- **Backups** (`backup.sh`, systemd timer): postgres + redis + grafana + portainer + `.env`,
  with `pg_isready` wait, empty-artifact discard, non-zero exit on failure. `doctor.sh`
  fails loudly if the newest backup is `< 1000 bytes` or `> 48h` old - **that check is the
  single most important alarm on the box** (backups were silently empty for 6 days once).
- **Monitoring**: Prometheus (15d retention, 7 targets all up incl. docker-daemon :9323),
  Loki (7-day retention since PR #7), promtail (positions in a volume, not /tmp), Grafana.

## Traps that are DESIGNED IN (read before "fixing" anything)

| Trap | Reality |
|---|---|
| `edge/dynamic` bind mount goes **stale after `git checkout`** | Bind mounts pin the inode; checkout recreates the dir. Traefik then serves an old in-memory config while `watch=true` silently does nothing. **After any branch switch:** `docker compose -f edge/compose.yml up -d --force-recreate` |
| `docker compose` does **not** read `~/stacks/.env` | Only `just` loads it (`set dotenv-load`). Direct compose: `set -a; . ./.env; set +a` first - otherwise "required variable missing" |
| `portal-next-fallback` returns **200 for any request on :80** | Since 2026-08-12 it is the *only* non-API router, so **every** path and hostname returns the portal page. A 200 proves Traefik is alive and nothing else - verify on the service's own port, and check bytes as well as code |
| A `Host()` rule you add today registers as `enabled` and matches **nothing** | There is no name layer left. Publish a port; if you truly need a route, use a host-less exact `Path()` (`edge/dynamic/project.example.yml`) |
| The `POST` protection on the docker API is in the **socket-proxy env** (`POST: 0`), not in the `Path()` rules | The comment in `portal-api.yml` claiming otherwise was corrected; don't trim the env block |
| A headers middleware puts the secret **into the config**, where any admin-API dump serves it | This is what leaked a Prometheus credential on 2026-08-12 ([lessons.md](lessons.md)). Audit the proxy's own `/api/*` before injecting auth headers |
| oauth2-proxy image is **distroless** | No shell → any docker healthcheck on it hangs in `starting` forever. It has none, on purpose |
| `--skip-provider-button` + Traefik `errors` middleware | Incompatible (CSRF cookie dropped) - don't re-add the flag |

## State of hardening (as of PRs #1–#14, 2026-07-21/22)

Done: everything committed; backups real + validated; Kafka persistence
(`KAFKA_LOG_DIRS`); 13 images pinned (tag or digest, each verified resolvable first);
DBs bound to loopback; SSO everywhere that lacked auth; DNS-rebinding hole closed by SSO;
Loki retention; portal health + error rendering; doctor.sh hardened; README rewritten.

Open items → [known-issues.md](known-issues.md).
