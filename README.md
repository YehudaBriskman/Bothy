# dev-box

**A self-hosted developer environment on a private WireGuard tailnet.** Docker
Compose stacks for routing, observability, dev data services and management
UIs — fronted by a homepage that discovers what is running instead of listing it.

> **Access model: plain `http://<node-ip>:<port>`.** The name-based layer this
> repo was built around (`*.dev.test` wildcard DNS + SSO) went dormant on
> 2026-08-08 and was **deleted on 2026-08-12** — every `Host()` router removed,
> the Traefik router table down from 22 to 6, none of them Host-based. `just urls`
> prints the live port table. Sections below that describe names or SSO document a
> **retired** design, kept because the problem it solved is real;
> [`docs/kb/dns.md`](docs/kb/dns.md) records what would be involved in rebuilding
> it, which is considerably more than flipping a switch.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![docker compose](https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white)
![just](https://img.shields.io/badge/just-task%20runner-EF5A29)
![Traefik](https://img.shields.io/badge/Traefik-v3.7-24A1C1?logo=traefikproxy&logoColor=white)
![Grafana](https://img.shields.io/badge/Grafana-observability-F46800?logo=grafana&logoColor=white)
![React 19](https://img.shields.io/badge/React%2019-%2B%20Vite-61DAFB?logo=react&logoColor=000)
![WSL2](https://img.shields.io/badge/WSL2-Ubuntu%2024.04-E95420?logo=ubuntu&logoColor=white)

<p align="center">
  <img src="docs/assets/portal-overview.png"
       alt="The portal Overview page: a hero reading N / M services up with a status bar, grouped Projects / Stack / Infrastructure cards, and panels for services needing attention, open UIs, disk usage and recent activity."
       width="860">
  <br><br>
  <img src="docs/assets/portal-topology.png"
       alt="The portal Topology page: a 3D rack view of the box, with the Traefik edge at the top connected by animated cables down to racks of running containers."
       width="860">
</p>

---

## What this is

One person's reproducible development box, in git. It provides the things a
project *doesn't* ship — routing, DNS, dashboards, log aggregation, backups — and
it does so for every project on the machine at once. Every non-obvious line in
these compose files carries a comment explaining **why** it is there, usually
because the alternative broke something.

## What this is not

Not a production platform, and not a template to deploy anywhere public:

- **Plaintext HTTP everywhere.** It is safe here only because the transport is a
  WireGuard tailnet. On a LAN or the internet, it is not.
- **Dev credentials.** `.env.example` ships `devpass` / `admin`. Redis has no
  password at all; that is why it binds loopback only.
- **Single node, single user.** Access control is tailnet membership plus one
  shared dev login on the dashboards (the GitHub SSO is parked). There is no HA,
  no TLS, no multi-tenancy, and backups sit on the disk they protect.
- **A helper, not a dependency.** A project keeps its own Postgres so it stays
  self-contained. If Traefik is down, your project still runs — you just lose the
  pretty hostname.

---

## The two ideas worth stealing

### 1. Nothing publishes a port. Everything gets a name. — RETIRED 2026-08-12

> **This idea is no longer implemented here.** It is kept, honestly labelled,
> because the problem it solves is real and because how it ended is the more
> useful half of the story.

Host ports are a flat global namespace with no allocator, so every project reaches
for 3000/8080/5432 and collides with whatever squatted there first — and the
collision surfaces as a bind failure that doesn't name the culprit.

The answer was to have Traefik own `:80` and route by `Host` header, making it the
**only** container in the repo publishing a browser-facing port. Names are
infinite; ports are 65535 and everyone picks the same dozen. Adding a service was
two labels and a name — no DNS entry, no port allocation, nothing restarted — and
the namespace nested (`s3.<project>.dev.test` under `<project>.dev.test`) so the
hierarchy told you what owned what. A wildcard `address=/test/` in dnsmasq meant a
new name at any depth needed no DNS work at all.

**Why it is gone.** Two steps:

1. **2026-08-08** — the tailnet split-DNS route was removed, so no client could
   resolve `.test` any more. The routers survived, labelled "dormant, re-enable
   later".
2. **2026-08-12** — "dormant" proved more expensive than it saved. Dead routers
   are configuration that *looks* live: they taught every new service the wrong
   pattern, they needed a caveat in every document, and one of them — the Traefik
   dashboard — was quietly serving `api@internal` unauthenticated, where
   `/api/rawdata` dumped the merged config **including a live
   `Authorization: Basic` header** that a `customRequestHeaders` middleware
   injected for Prometheus. They were deleted.

Deleting them cost nothing measurable. The router table went from **22 routers to
6** — four host-less exact-`Path()` routes for the portal's `/-/api/*` data plane,
the portal's catch-all, and Traefik's internal metrics route — with **zero `Host()`
rules remaining**. Nothing became unreachable, because every browser-facing service
had kept its published port all along, and a 20-check verification harness passed
20/20 afterwards. The only functional loss was the Traefik dashboard UI.

**What replaced it.** A browser-facing service publishes a host port and is reached
at `http://<node-ip>:<port>`; `just urls` prints the table and is the only
allocator there is. Host processes bind `0.0.0.0` on their own port. If a service
genuinely needs a Traefik route, the one supported shape is a **host-less exact
`` Path(`…`) ``** rule at priority 100 — see `edge/dynamic/project.example.yml`
for the annotated template and `edge/dynamic/portal-api.yml` for the live example.
**Do not write a `Host()` rule:** with no name layer it registers as `enabled` and
then matches nothing, forever, which is worse than an error.

The lesson worth stealing is the one that survived: **either keep a layer working
or delete it — parked configuration is the expensive middle.**

### 2. The portal discovers what is running. It is never a hand-written list.

The portal — Traefik's catch-all on `:80`, and since 2026-08-12 the only non-API
router on the box — is a React 19 + Vite app served as a static build. Its service links navigate by
published port on whichever host you opened it from, so they work identically
via tailnet IP, MagicDNS name or localhost. It renders by joining
**two read-only APIs**, both proxied under its own origin so there is zero CORS:

| Path | Backend | Gives |
|---|---|---|
| `/-/api/traefik/*` | Traefik's `api@internal` | every route, including host processes, and its target |
| `/-/api/docker/containers/json` | `docker-socket-proxy` | ports, health, images, compose labels, mounted volumes |
| `/-/api/docker/system/df` | `docker-socket-proxy` | per-volume / image / container disk sizes |

**Traefik is the skeleton; Docker is enrichment.** Either can die and the page
still renders — that is the design, not a nicety. The join walks
`router → service → server URL → devnet IP → container`, and falls back to the
container's own Traefik labels if the Traefik-side IP is stale.

Containers are then classified with no lookup table anywhere: their
`com.docker.compose.project.config_files` label says whether they belong to this
repo (a stack service) or to a project, and **hostname nesting beats it** — so
`s3.myproject.dev.test` grouped under `myproject` even when it was a host process
with no container at all. (Since the name layer was deleted on 2026-08-12 there are
no hostnames left to nest, so that branch is retained but dormant; classification
falls through to `config_files`.) Optional `dev.portal.*` labels add an icon, a
description or a display name. If the page ever *needs* a label to be correct, the
defaults are wrong.

The test of the whole thesis: **start any container and it appears on the portal
within 10 seconds, with no edit to the portal.** Stop it and its dot goes red just
as fast.

> **The security boundary is the Traefik rule, not the proxy config.**
> `docker-socket-proxy` gates by endpoint *family*, so `CONTAINERS=1` also permits
> `/containers/{id}/json` — whose body contains every container's `Env`, i.e. real
> passwords. What actually prevents that is the router in
> `edge/dynamic/portal-api.yml`, where every rule is an exact `` Path(`…`) `` and
> exactly two Docker endpoints are routed. **Never widen it to `PathPrefix`.**
> The proxy also holds the socket read-only, sets `POST=0`, publishes no port, and
> lives alone with Traefik on a separate `socketnet` — it has no authentication of
> its own, so network reachability *is* authorisation.

---

## Quick start

**Prerequisites**

- Linux with systemd (built and run on WSL2 / Ubuntu 24.04) and Docker Engine 25+
  with the Compose plugin. Traefik must be **≥ v3.6** — older builds hardcode
  Docker API v1.24 and silently load zero routes against a modern daemon.
- [`just`](https://github.com/casey/just), plus `jq` and `curl` for `just doctor`.
- Nothing else. The retired name layer needed a resolver answering `*.test` and a
  GitHub OAuth App; neither is required to run this today.

```sh
cp .env.example .env      # fill in DEV_LOGIN_* and WIKI_DB_PASSWORD (OAUTH2_* only for the parked SSO)
just up                   # bring everything up, in dependency order
just urls                 # print every address
just doctor               # health-check the whole box
```

Then open **`http://<this-node's-tailnet-IP>/`** — `just urls` prints every address.

> **Always use `just`, never `docker compose` directly.** `just` loads the root
> `.env` via `set dotenv-load`. `docker compose` looks for a `.env` beside the
> compose file it was handed, finds none, and either falls back to insecure
> defaults or aborts on a required variable.

---

## Repo map

| Path | What lives there |
|---|---|
| `edge/` | **Traefik** on `:80`: serves the portal catch-all and the `/-/api/*` data plane, and nothing else — Host-name routing was deleted 2026-08-12, as was the dashboard (`--api=true`, not `--api.dashboard=true`). Also exports Prometheus metrics on an internal entrypoint with no host port. |
| `edge/dynamic/` | Watched file-provider routes: `portal-api.yml` (the portal's read-only data plane — the security boundary, read it in full), `project.example.yml` (the annotated template, entirely commented out on purpose), `auth.yml` (the parked SSO chain), `host-services.yml` (now declares no routes). |
| `auth/` | **oauth2-proxy** — GitHub SSO, **parked** and being replaced by Keycloak; it still carries a stale `Host(auth.dev.test)` label. Treat as in flight, not final. |
| `monitoring/` | Prometheus, Grafana, Loki + Promtail, cAdvisor, node-exporter. `provisioning/` wires datasources, dashboards and email alert rules; `dashboards/` holds six provisioned dashboards; `rules/` is for Prometheus rules. |
| `data/postgres/`, `data/redis/`, `data/kafka/` | Each datastore plus its Prometheus exporter. Kafka is single-node KRaft. All three bind **loopback only** and are never routed by name. |
| `mgmt/` | Portainer and Dozzle. |
| `apps/portal-next/` | The live portal on `:80` — React 19 + Vite + TypeScript, built by a multi-stage image and served static by nginx. Owns `portal-next-fallback`, the catch-all. Pages: Overview, Services, Ports, Routes, Topology (a lazy-loaded react-three-fiber 3D rack view). |
| `apps/portal/` | The retired pure-HTML portal, kept as a one-line rollback — **and the owner of `portal-socket-proxy`**, which the live portal still depends on. Do not `compose down` this directory. |
| `apps/docs/` | MkDocs Material rendering every markdown file on the box, kept in sync by an rsync sidecar. Read-only; edits to the source files show up within ~15s. |
| `apps/wiki/` | Wiki.js — superseded by `apps/docs/`; currently stopped, kept until its content is migrated. |
| `host/` | Copies of the host configuration git cannot see: dnsmasq, `daemon.json`, `wsl.conf`, the systemd units, and the Windows keepalive task. Required to rebuild the box. See [`host/README.md`](host/README.md). |
| `scripts/` | `backup.sh` and `doctor.sh`. |
| `justfile` | Every operation. Start here. |

---

## Architecture

_As it actually is, verified 2026-08-12. Traffic goes browser →
`http://<node-ip>:<port>` straight to each service; only the portal and its data
plane pass through Traefik._

```mermaid
flowchart TB
  subgraph client["Any device on the tailnet"]
    B["Browser<br/>http://&lt;node-ip&gt;:&lt;port&gt;"]
  end

  B -->|":3000 :9090 :8080 :8081 :8085 :9000 …"| SVC
  B -->|":80"| T

  subgraph box["The dev box"]
    SVC["Grafana · Prometheus · Loki<br/>Dozzle · Portainer · Kafka-UI · Docs<br/><i>each on its own published port</i>"]

    T["<b>Traefik</b> :80<br/>6 routers, zero Host rules<br/>catch-all (prio 1) + 4 exact Path() (prio 100)"]

    T -->|"PathPrefix(/) — answers everything"| PORTAL["<b>Portal</b> — React, served static"]
    T -->|"exact Path /-/api/traefik/…"| TAPI["Traefik API<br/>api@internal · dashboard OFF"]
    T -->|"exact Path /-/api/docker/…"| SP["docker-socket-proxy<br/>read-only · no auth · socketnet only"]
    T -->|"exact Path /-/api/loki, /-/api/prom"| OBS2["Loki · Prometheus"]
    SP --> SOCK[("/var/run/docker.sock :ro")]

    DATA[("Postgres · Redis · Kafka<br/>loopback only, never routed")]
  end

  TAPI -.->|"routes"| PORTAL
  SP -.->|"containers, health, disk"| PORTAL
  OBS2 -.->|"logs, metrics"| PORTAL
```

Retired from this picture on 2026-08-12: wildcard `*.dev.test` DNS, every `Host()`
router, and the browsable Traefik dashboard. oauth2-proxy is parked, pending
Keycloak.

Two Docker networks, deliberately:

- **`devnet`** — the shared external network everything joins. Traefik pins its
  discovery to it (`--providers.docker.network=devnet`) so it can never pick the
  wrong container IP from a project-local network.
- **`socketnet`** — holds exactly two containers, Traefik and
  `portal-socket-proxy`. The proxy has no authentication, so keeping the blast
  radius at two members is the control.

### Single sign-on

> **Parked since 2026-08-08, and being replaced** — the OAuth callback is pinned
> to a name that no longer exists. In its place every dashboard runs its own login
> with one shared dev credential (`DEV_LOGIN_*` in `.env`): Grafana, Portainer,
> Dozzle, Kafka-UI and Prometheus (basic auth, carried by its self-scrape and the
> Grafana datasource too). A Keycloak-based replacement is in progress, so
> `auth/` is in flight rather than final. What follows documents the parked design.
>
> **One thing that shipped with it is a general warning.** Prometheus' basic-auth
> credential is injected by a Traefik `customRequestHeaders` middleware so the
> portal can query it. On 2026-08-12 that credential was found readable by anyone
> on the tailnet, because the Traefik dashboard served `api@internal`
> unauthenticated and `/api/rawdata` dumps the merged config verbatim. **A headers
> middleware hides a secret from the browser, not from the config dump.** The
> dashboard router was deleted and `--api.dashboard=true` became `--api=true`
> (the API itself must stay on — the portal's `/-/api/traefik/*` routes use
> `api@internal`).

Services with no login of their own — Dozzle, Kafka-UI, Prometheus, the docs, the
Traefik dashboard and the portal — sit behind GitHub SSO via oauth2-proxy as a
Traefik `forwardAuth` target. The session cookie is scoped to `.dev.test`, so one
sign-in covers all of them, and only one GitHub account is permitted.

Portainer is behind SSO too, because it holds a read-write Docker socket: its UI
exposes container environment variables and container exec, which is root on the
box. Grafana and Wiki.js keep their own logins.

GitHub rather than Google as the provider for one concrete reason: Google rejects
`http://` redirect URIs, which would force TLS, and TLS on `*.dev.test` means
installing a private CA on every device.

---

## The `just` recipes worth knowing

```sh
just up          # everything, in dependency order (edge → auth → monitoring → data → mgmt → apps)
just up-edge     # or bring up one group: up-auth, up-monitoring, up-data, up-mgmt, up-apps
just down        # stop everything, keep the data
just nuke        # stop everything AND delete every volume — destructive, prompts first
just ps          # what is running
just doctor      # containers, Prometheus targets, k8s node, disk/memory, backup freshness
just backup      # what the 03:00 timer runs
just urls        # every address, plus the ssh tunnel command
just logs NAME   # follow a container's logs
just psql        # a psql shell on the dev database
just redis       # a redis-cli shell
just network     # create the devnet + socketnet networks (idempotent; every up- depends on it)
```

`just nuke` sits one keystroke away from `just down` in the recipe list and
deletes all seven data volumes, which is why it is the one recipe that asks for
confirmation.

Bringing up a group is safe and independent: the edge must be up before anything
expects to be routed, and auth before the routers that reference its middleware,
but nothing else has an ordering requirement.

---

## DNS: how `*.test` names resolved — RETIRED

> **Dormant 2026-08-08, retired 2026-08-12.** The tailnet split-DNS route was
> removed first, so no client resolved `.test` any more; the Traefik `Host()`
> routers it fed were deleted four days later. dnsmasq itself still runs — it is
> the box's own resolver, and its `address=/test/` line is harmless — so `.test`
> still resolves **on the box and nowhere else**. Do not read that as names
> working: the portal catch-all answers every request on `:80` with a 200
> regardless. Re-adding the console route would restore resolution but route
> nothing, because there are no Host routers left to author against.

A local dnsmasq is authoritative for `.test` and answers a wildcard at **any
depth**, so a brand-new name at any level needs no DNS work at all — only a
Traefik rule.

```conf
# /etc/dnsmasq.d/dev.conf
bind-dynamic                 # not bind-interfaces: the tailnet iface may not exist yet at boot
listen-address=<this-node>   # only the tailnet IP; systemd-resolved owns 127.0.0.53
no-resolv                    # authoritative for .test, forwards nothing
address=/test/<this-node>    # wildcard at ANY depth
domain-needed                # dotless names NXDOMAIN instantly — see below
```

Tailscale **split DNS** (admin console → DNS → Nameservers) then routes `test`
queries to this node, so every device on the tailnet resolves `*.dev.test`
directly. Nothing is published to the LAN or the internet, and the tailnet is
WireGuard, so plain `http://` here is still encrypted in transit. A device that is
not on the tailnet gets `NXDOMAIN` — that is the first thing to check when a name
"stops working".

Three things that are load-bearing here:

- **`.test`, never `.dev`.** `.dev` is a real gTLD and is HSTS-preloaded, so
  browsers force `https://` and plain HTTP never loads. `.test` is reserved by
  RFC 6761, can never become a real TLD, and nothing preloads it.
- **`domain-needed` is not cosmetic.** Without it, a dotless name that leaks out
  of a container into a host process (`tempo`, `redis`, any bare compose service
  name) is forwarded upstream to a resolver that drops it silently rather than
  answering NXDOMAIN. Lookups then hang ~40s each — and since `getaddrinfo` runs
  on libuv's four-thread pool, a handful of them starve *every other lookup in
  the process*. That presents as unrelated database timeouts, which is a very
  expensive way to learn about DNS.
- **`local=/test/`** makes dnsmasq answer AAAA for `.test` with an immediate
  NODATA. A plain `curl http://x.dev.test` that hangs while `curl -4` works
  instantly is always something answering AAAA with silence instead.

Databases are deliberately **not** routed by name. Reach them over SSH:

```sh
ssh -L 5432:localhost:5432 -L 6379:localhost:6379 -L 9092:localhost:9092 \
    <user>@<this-node>.<your-tailnet>.ts.net
```

---

## Backups

`stacks-backup.timer` runs `scripts/backup.sh` at 03:00 daily, keeping the newest
14 of each: the Postgres dump, the Redis snapshot, the Grafana and Portainer
databases, and `.env` — which is gitignored and exists in exactly one place on
earth, so losing it loses every credential on the box.

The script is deliberately **not** `set -e`: one failed service must not skip the
other four. It waits for Postgres to accept connections before dumping, verifies
every artifact is non-empty before keeping it, and exits non-zero if any step
failed. All three of those are scar tissue — it previously produced 20-byte empty
dumps for six days while reporting success, because the timer is
`Persistent=true` and a schedule missed while the box was off fires at the next
boot, which is exactly when Postgres is still starting.

`just doctor` therefore checks backup **age and size**, not existence: a failed
`pg_dumpall` still leaves behind a perfectly valid gzip of nothing.

Backups sit on the same disk they protect. Copying them off the box is not solved.

---

## Things that will catch you

- **The box must stay awake.** WSL2 destroys the VM 60 seconds after the last
  Windows-side client disconnects, taking Docker and every container with it. A
  Windows scheduled task holds it open — see [`host/README.md`](host/README.md).
  `restart: unless-stopped` is inert if the daemon never starts.
- **Traefik's `edge/dynamic` mount goes stale after `git checkout`.** A bind mount
  pins the host inode at container-creation time and checkout recreates
  directories, so Traefik keeps reading an orphaned copy and silently serves its
  last in-memory config — `--providers.file.watch=true` stops meaning anything.
  Fix: `docker compose -f edge/compose.yml up -d --force-recreate`.
- **Listing `networks:` on a service silently drops it off the compose default
  network.** Always `[default, devnet]`, or the service loses its own database.
- **`/etc/resolv.conf` is immutable on purpose.** WSL rewrites it whenever
  Windows' DNS configuration changes. `sudo chattr -i` to edit, `+i` when done.
- **`systemctl reload dnsmasq` does not re-read the config.** SIGHUP re-reads
  `/etc/hosts` and clears the cache, nothing more. A config edit needs a restart.
- **A route that misbehaves** → the router table is served at
  `http://<node-ip>/-/api/traefik/http/routers`; it shows exactly which routers
  are registered. There is no Traefik dashboard to check instead — it was deleted
  2026-08-12 because it leaked a credential.
- **A `Host()` rule added today registers as `enabled` and matches nothing.**
  There is no name layer. Publish a port, or use a host-less exact
  `` Path(`…`) `` rule — `edge/dynamic/project.example.yml` is the template.
- **Tunnel pings pong but pages stall, or SSH hangs at key exchange** — the
  large-packet blackhole. Restart tailscaled on the box; recipe in
  [`docs/kb/incidents/2026-08-08-wsl-node-large-packet-blackhole.md`](docs/kb/incidents/2026-08-08-wsl-node-large-packet-blackhole.md).

---

## Deeper docs

- **Docs on `:8085`** — MkDocs Material, rendering every markdown file on the box,
  auto-synced.
- [`docs/kb/`](docs/kb/README.md) — the operational knowledge base: topology,
  access paths, runbooks, incident files and the lessons they paid for.
- **The compose files themselves.** Every non-obvious setting has a comment
  explaining what broke without it — `edge/compose.yml`, `auth/compose.yml` and
  `edge/dynamic/portal-api.yml` are the three worth reading in full.
- [`host/README.md`](host/README.md) — the host-level configuration that git
  cannot see, and what each copy is for.

## Contributing, security, licence

This is a personal box published as a reference, so issues and questions are more
welcome than pull requests — but both are read.

- [SECURITY.md](SECURITY.md) — the threat model, and what "safe on a tailnet"
  does and does not mean
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [LICENSE](LICENSE) — MIT
