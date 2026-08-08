# Architecture — what actually runs inside the dev box

_Condensed from the 2026-07 audit (full detail: `C:\Users\yr055\dev-box-audit.md`).
Live tree: `~/stacks` in devssh's WSL distro, on `main`. Audit rule: **read the live box,
never trust `origin/main` to describe it** — see [lessons.md](lessons.md)._

## The front door — since 2026-08-08: direct ports, Traefik for the portal only

Primary access is **published ports on the tailnet IP** (table in [access.md](access.md)).
**Traefik v3.7** (`edge/`) still owns :80 and serves the portal (now **portal-next** —
the old `portal` container is `traefik.enable=false`) via its prio-1 fallback router,
plus the prio-100 Host-less `Path()` routers for `/-/api/{traefik,docker,loki}/*`.
Its Host-header routers (`*.dev.test`) are **dormant** — nothing resolves those names;
they wait for the future DNS phase. [dns.md](dns.md) is the re-enable manual.

**GitHub SSO (oauth2-proxy) is PARKED** — container down, `edge/dynamic/auth.yml`
fully commented with the re-enable recipe, GitHub OAuth app untouched. A 401 anywhere
now indicates regression, not health. Grafana, portainer keep their own auth; dozzle,
kafka-ui, prometheus and the portal API are tailnet-open (known-issues).

## The portal

Live-discovery page: `portal.js` polls the Traefik API + docker container list every 10s
through `portal-socket-proxy` (tecnativa docker-socket-proxy, `CONTAINERS=1` only,
read-only socket, no published port). Health display fixed in PR #11
(`container.Health?.Status` — Health is an object, not a string).

## Also on the box

- **cvops** project (5 containers, DBs on loopback, shifted ports 15432/16379)
- **minikube** (own systemd unit)
- **Backups** (`backup.sh`, systemd timer): postgres + redis + grafana + portainer + `.env`,
  with `pg_isready` wait, empty-artifact discard, non-zero exit on failure. `doctor.sh`
  fails loudly if the newest backup is `< 1000 bytes` or `> 48h` old — **that check is the
  single most important alarm on the box** (backups were silently empty for 6 days once).
- **Monitoring**: Prometheus (15d retention, 7 targets all up incl. docker-daemon :9323),
  Loki (7-day retention since PR #7), promtail (positions in a volume, not /tmp), Grafana.

## Traps that are DESIGNED IN (read before "fixing" anything)

| Trap | Reality |
|---|---|
| `edge/dynamic` bind mount goes **stale after `git checkout`** | Bind mounts pin the inode; checkout recreates the dir. Traefik then serves an old in-memory config while `watch=true` silently does nothing. **After any branch switch:** `docker compose -f edge/compose.yml up -d --force-recreate` |
| `docker compose` does **not** read `~/stacks/.env` | Only `just` loads it (`set dotenv-load`). Direct compose: `set -a; . ./.env; set +a` first — otherwise "required variable missing" |
| `portal-fallback` returns **200 for any typo'd host** | A wrong hostname looks healthy. A 200 from an unexpected name proves nothing |
| The `POST` protection on the docker API is in the **socket-proxy env** (`POST: 0`), not in the `Path()` rules | The comment in `portal-api.yml` claiming otherwise was corrected; don't trim the env block |
| Traefik router priorities 16–27 are **defaulted from rule-string length** | A future rule >100 chars silently outranks the prio-100 API routers |
| oauth2-proxy image is **distroless** | No shell → any docker healthcheck on it hangs in `starting` forever. It has none, on purpose |
| `--skip-provider-button` + Traefik `errors` middleware | Incompatible (CSRF cookie dropped) — don't re-add the flag |

## State of hardening (as of PRs #1–#14, 2026-07-21/22)

Done: everything committed; backups real + validated; Kafka persistence
(`KAFKA_LOG_DIRS`); 13 images pinned (tag or digest, each verified resolvable first);
DBs bound to loopback; SSO everywhere that lacked auth; DNS-rebinding hole closed by SSO;
Loki retention; portal health + error rendering; doctor.sh hardened; README rewritten.

Open items → [known-issues.md](known-issues.md).
