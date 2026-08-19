<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/wordmark-dark.svg">
  <img alt="Bothy" src="docs/brand/wordmark-light.svg" width="260">
</picture>


**A self-discovering console for one machine.** Bothy is the web application on
`:80`. It shows you what is running by **asking Docker**, never by reading a list
somebody remembered to update - and around it, Docker Compose stacks provide what
a project *doesn't* ship: an edge, identity, observability, a shared database,
backups.

A bothy is a small stone hut in the Scottish hills, left unlocked, that anyone
can shelter in. That is what this box is - one machine that quietly holds
everything, open to anyone on the tailnet, not a service anybody sells.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/release-v2026.8.1-4c1)](https://github.com/YehudaBriskman/Bothy/releases)
![docker compose](https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white)
![just](https://img.shields.io/badge/just-task%20runner-EF5A29)
![Traefik](https://img.shields.io/badge/Traefik-v3.7-24A1C1?logo=traefikproxy&logoColor=white)
![Grafana](https://img.shields.io/badge/Grafana-observability-F46800?logo=grafana&logoColor=white)
![React 19](https://img.shields.io/badge/React%2019-%2B%20Vite-61DAFB?logo=react&logoColor=000)
![WSL2](https://img.shields.io/badge/WSL2-Ubuntu%2024.04-E95420?logo=ubuntu&logoColor=white)

![The Bothy Overview: 25 up / 14 off across a status bar, then one card per system - Monitoring · Grafana, Identity · Keycloak, Bothy Control, Database · Postgres, Bothy Config - above live CPU, memory and network charts.](docs/assets/overview.png)

_Every card on that page was discovered by asking Docker. Nothing about it is a list._

---

## Install

```sh
git clone https://github.com/YehudaBriskman/Bothy.git && cd Bothy
cp .env.example .env
just up            # everything, in dependency order
just urls          # every address on this box
just doctor        # health-check the whole thing
```

Then open **`http://<node-ip>/`** - `just urls` prints the address.

**There is nothing to fill in before the first `just up`.** The five credentials
the stack actually uses - the two database passwords, the SSO cookie secret, the
OIDC client secret and your login password - are **generated** by `just
bootstrap`, which `just up` runs for you. It prints which keys it wrote, never
their values, and never touches a value you set yourself.

That is checked rather than claimed: every pull request clones this repository
into an empty directory, runs the first three lines above and nothing else, and
then runs every test suite in the tree against whatever came up. A nightly job
repeats it at a path with a space in it and at a deeply nested path, because
every portability bug this repository has had looked fine at exactly one path.

Two keys you may still want to set, neither of which blocks a first start:

| Key | Why |
|---|---|
| `BOX_IP` | The address this box answers on. Left alone, Bothy asks `tailscale` and falls back to `127.0.0.1` - which works, but only from this machine. **Keycloak's issuer is built from it**, so changing it later means re-running `just up-auth`. |
| `DEV_LOGIN_USER` | Your login, `dev@example.com` by default. It must be an email address: Keycloak logs in by email. |

Your password is `DEV_LOGIN_PASSWORD` in `.env`. **Back that file up** - the
generated secrets are not recoverable, and `POSTGRES_PASSWORD` and
`KEYCLOAK_DB_PASSWORD` are baked into their database volumes at first start.

### No checkout yet

```sh
curl -fsSL https://raw.githubusercontent.com/YehudaBriskman/Bothy/main/scripts/bothy.sh -o bothy.sh
less bothy.sh
sh bothy.sh
```

`curl … | sh` works too, and it is the convenience rather than the documented
path. Downloading first is deliberate, and the argument is in
[SECURITY.md](SECURITY.md): this ends with a program holding a Docker socket, so
the file is short, names every path it writes, and is meant to be read.

It does one thing - clone at a pinned release, verify the commit id against a
value baked into the script, and put [`scripts/bothy`](scripts/bothy) on your
`PATH`. It then **prints** `bothy init` rather than running it. The CLI is what
installs `just`, generates the secrets and brings the box up; being the thing
that removes `just` from the prerequisite list is most of why it exists.

### Prerequisites

Docker with the Compose v2 plugin, plus `git`, `curl`, `python3` and `openssl`.
That list has exactly one definition, in `check_prereqs()` in
[`scripts/bothy`](scripts/bothy), and `bothy doctor --pre` runs it before you have
a checkout. `just` is not on it if you take the installer path. `jq` is optional
and worth having: without it `just doctor` reports less than it should, and says
so - `doctor.sh` learned the hard way that a missing `jq` reads as a clean bill of
health. Tailscale is not required either; without it Bothy resolves its own
address to `127.0.0.1`, which works and is reachable only from the machine itself.

> **Always use `just`, never `docker compose` directly.** `just` loads the root
> `.env` via `set dotenv-load`. `docker compose` looks for a `.env` beside the
> compose file it was handed, finds none, and either falls back to insecure
> defaults or aborts on a required variable.

The long version, including what to keep and what to expect on a machine that has
never had it: [**Installing Bothy**](docs/guide/installing.md).

---

## What you get

Four surfaces, all of them at `http://<node-ip>/`, and the stack underneath them.

| Where | What it does |
|---|---|
| **Overview** (`/`) | Up, unknown and stopped against what is expected; then what is actually wrong; then one card per system; then CPU, memory and network. All of it discovered from Docker and Traefik, so a container you start appears within ten seconds with no edit to Bothy. |
| **Control** (`/control`) | Triage, then Services, Ports, Routes - the live Traefik router table - and a 3D rack view. Three verbs on a container: `restart`, `stop`, `start`, and nothing else. |
| **Bothy Files** (`/files`) | Four named roots - this repository, your notes, your projects, your home - rendered, searchable, with git history and diffs, and editable where the root allows it. |
| **Bothy Config** (`/settings`) | A form that changes one **declared** field in a compose file without destroying the file; plus who the session says you are, which roles you hold, and the theme picker. |

**Roles.** Four of them - `viewer`, `editor`, `operator` and `shell` - flat and
deliberately non-composite, because `shell` means an arbitrary terminal and must
never be reachable by holding one of the other three. Nine routers carry a role
requirement today; everything else on the box is protected by the tailnet plus,
where a service has one, its own login on a shared dev credential. **"SSO is
running" does not mean "this is behind SSO"** - see [Roles](docs/guide/roles.md).

**Themes.** Five ship - Bothy Dark, Bothy Light, Tokyo Night, Gruvbox and
Catppuccin Latte - and a theme you add is **one `.css` file in one directory**: no
rebuild, no npm, no restart, and it survives the image being replaced. It was
seven until two of them were measured in OKLCH against Tokyo Night and found to be
the same theme twice. See [Themes](docs/guide/themes.md).

**And there is no `exec`.** No shell in the browser, no `kill`, no `create`, no
`rm`, no image or volume or network management. `docker exec` is root on this box,
so `EXEC: 0` is written out explicitly on all three socket proxies rather than
left to a default, the verb list is a literal three-element tuple that is never
derived from the handlers, and a check asserts both. This is a real regression
against Portainer, which was deleted; the replacement is `docker exec` over
Tailscale SSH, and [SECURITY.md](SECURITY.md) spends a section on what a browser
shell would cost - written **before** any capability exists to point at as already
done.

---

## The guide

Seven pages, written for somebody who has **not** read the source. Everything
below this line in the README is reference material for somebody who has.

| If you want to | Read |
|---|---|
| get it running on a machine that has never had it | [Installing Bothy](docs/guide/installing.md) |
| know which YAML is load-bearing, and what happens when you save it | [The files you will actually edit](docs/guide/configuring.md) |
| use the thing - Overview, Control, the three verbs | [Operating it from the console](docs/guide/the-console.md) |
| read, search and edit the box's own files from a browser | [Bothy Files](docs/guide/files.md) |
| understand `viewer`, `editor`, `operator` and the role nobody holds | [Roles](docs/guide/roles.md) |
| pick a theme, or write one | [Themes](docs/guide/themes.md) |
| all of it, in order | [the guide index](docs/guide/index.md) |

![Bothy Files: the document tree on the left, this README rendered in the centre with its screenshots inline, and the page outline on the right.](docs/assets/files.png)

_Bothy Files, reading this README off the disk it lives on._

---

## What this is, and what it is not

One person's reproducible development box, in git. It provides the things a
project *doesn't* ship, for every project on the machine at once. Every
non-obvious line in these compose files carries a comment explaining **why** it is
there, usually because the alternative broke something.

It does **not** provide routing-by-name or DNS. Every browser-facing service
publishes its own port instead; `just urls` prints the table, and
[the configuring guide](docs/guide/configuring.md) argues why there are zero
`Host()` rules.

And it is not a production platform, nor a template to deploy anywhere public:

- **Plaintext HTTP everywhere.** It is safe here only because the transport is a
  WireGuard tailnet. On a LAN or the internet, it is not.
- **Dev credentials.** `.env.example` ships placeholders and every one of them is
  meant to be replaced. A missing `POSTGRES_PASSWORD` now aborts rather than
  silently defaulting - the fallback was removed after the superuser password on
  the live box was found to still be the published placeholder.
- **Single node, single user.** Access control is tailnet membership, plus one
  shared dev login on the dashboards, plus Keycloak roles on the three tiers that
  can change something. No HA, no TLS, no multi-tenancy, and backups sit on the
  disk they protect.
- **A helper, not a dependency.** A project keeps its own Postgres so it stays
  self-contained. If the edge is down, your project still runs on its own port -
  the only thing you lose is Bothy's view of it.

---

## The three ideas worth stealing

### 1. The console discovers what is running. It is never a hand-written list.

Bothy renders by joining **two read-only APIs**, both proxied under its own origin
so there is zero CORS: Traefik's `api@internal` gives every route and its target,
and a read-only Docker socket proxy gives ports, health, images, compose labels
and per-volume disk. **Traefik is the skeleton; Docker is enrichment.** Either can
die and the page still renders - that is the design, not a nicety.

Containers are then classified with no lookup table anywhere: their
`com.docker.compose.project.config_files` label says whether they belong to this
repo or to a project, and optional `dev.portal.*` labels add an icon, a
description or a display name. If the page ever *needs* a label to be correct, the
defaults are wrong.

The test of the whole thesis: **start any container and it appears within ten
seconds, with no edit to Bothy.** Stop it and its dot goes red just as fast.

> **The security boundary is the Traefik rule, not the proxy config.**
> `docker-socket-proxy` gates by endpoint *family*, so `CONTAINERS=1` also permits
> `/containers/{id}/json` - whose body contains every container's `Env`, i.e. real
> passwords. What actually prevents that is the router in
> `edge/dynamic/portal-api.yml`, where every rule is an exact `` Path(`…`) `` and
> exactly two Docker endpoints are routed. **Never widen it to `PathPrefix`.**

### 2. A service with no auth of its own is protected by exactly one thing: who can reach it

The socket proxy taught this and every tier since is built on it. `portal-files`
holds read-write bind mounts on two git repositories and authenticates nobody.
`bothy-config` can rewrite this box's compose files and edge routes, and
authenticates nobody. `bothy-control` can stop a running container, and
authenticates nobody. None of them publishes a host port, and each sits on a
network holding exactly two members - itself and the one thing allowed to talk to
it. Authorisation happens at the edge, in a `forwardAuth` middleware; anything
that can reach the service directly has already bypassed it.

Put any of them on `devnet` and about twenty containers - including third-party
images - inherit the capability. Nothing would warn you; the service would work
perfectly. That single sentence is why there are six networks rather than one.

### 3. Make one function own the walk, so the security check is not something a caller has to remember

The file API's `safepath.collect()` is the only way the application can learn a
set of paths. It applies the deny rules, resolves every path, refuses symlinks and
opens files safely - so a *new* endpoint gets those properties by calling it,
rather than by its author remembering to.

This was learned the expensive way twice. First a listing that did its own walk
paid for 30,093 refused files to serve 3,474. Then, when full-text search was
added, the same shortcut would have returned a matching **line** out of `.env` -
the deny-list would still have been correct, and the secret would still have been
on screen. `checks/search_denied.py` plants a credential-shaped token in three
kinds of denied file and requires that only the served one comes back.

The general form: **if a rule can be forgotten, it will be. Put it somewhere it
cannot be skipped, then write the test that proves it was not.**

---

## Repo map

| Path | What lives there |
|---|---|
| `edge/` | **Traefik v3.7** on `:80`, plus the `:8100` sandbox entrypoint that serves raw file bytes from a different origin. No Host-name routing and no dashboard (`--api=true`, never `--api.dashboard=true` - it served the merged config, credentials included). Exports Prometheus metrics on an internal entrypoint with no host port. Traefik must be **≥ v3.6**: older builds hardcode Docker API v1.24 and silently load zero routes against a modern daemon. |
| `edge/dynamic/` | Seven watched file-provider files. `portal-api.yml` is the security boundary and is worth reading in full; `portal-files.yml`, `bothy-config.yml` and `bothy-control.yml` carry the role-gated routers and the middlewares that gate them; `auth.yml` holds `sso` / `sso-errors` and the host-less `` PathPrefix(`/oauth2/`) `` router; `project.example.yml` and `portal-prom.example.yml` are annotated templates. |
| `auth/` | **Keycloak 26.7.1 + oauth2-proxy 7.15.3** - the local identity layer. Keycloak publishes `:8090` and stores its data in the shared Postgres under its own `keycloak` role; oauth2-proxy runs `--provider=oidc` and publishes no port. This compose file also carries the OIDC reasoning that could not live inside `auth/realm-devbox.json`. |
| `monitoring/` | Prometheus, Grafana, Loki + Promtail, cAdvisor, node-exporter. `provisioning/` wires datasources, dashboards and email alert rules; `dashboards/` holds the provisioned dashboards. |
| `data/postgres/` | Postgres 17 plus `postgres-exporter`. Binds **loopback only**. The dev database and Keycloak both live here. |
| `apps/bothy/` | The one compose project over Bothy's tiers, via `include:`. Also **owns `bothy-socket-proxy`**, the read-only Docker socket the `/-/api/docker` data plane goes through. |
| `apps/portal-next/` | The web tier - React 19 + Vite + TypeScript, built by a multi-stage image and served static by nginx. Owns `portal-next-fallback`, the catch-all on `:80`. |
| `apps/portal-files/` | Bothy Files - the read/write file API over four named roots, with full-text search. Its `policy.toml` declares the roots and what is never served. No published port. |
| `apps/bothy-config/` | Bothy Config - the service that changes one declared field in a YAML file without destroying the file. No published port. |
| `apps/bothy-control/` | Bothy Control - `restart`, `stop`, `start`, an audit log, and `guard.py`, whose three-element verb tuple is the only thing refusing `kill`. Two socket proxies of its own, on a network Traefik cannot reach. No published port. |
| `apps/portal-collector/` | Turns each project's `project.dev.yml` into `projects.json`, so a project that is switched off reads as *off* rather than absent, and a project made of host processes is visible at all. |
| `host/` | Copies of the host configuration git cannot see: dnsmasq, `daemon.json`, `wsl.conf`, the systemd units, the Windows keepalive task. Required to rebuild the box - see [`host/README.md`](host/README.md). |
| `scripts/` | [`bothy`](scripts/bothy) (the CLI) and `bothy.sh` (the installer that fetches it), plus `bootstrap.sh`, `backup.sh`, `doctor.sh`, `verify-access.sh`, `ci-install.sh`, two generators and `lib/`. `scripts/checks/` holds the tree-only checks CI runs first: links, diagrams, portability, recipe descriptions, the installer pin, bash 3.2 compatibility and the version. |
| `docs/` | [`guide/`](docs/guide/index.md) for people who have not read the source, [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the request path and the discovery join, [`kb/`](docs/kb/README.md) for this specific machine's operational history, `brand/` for the design system, `diagrams/` for the mermaid sources and `plans/` for the design arguments. |
| `justfile` | Every operation. Start here. |
| `VERSION` | `2026.8.1`, and `scripts/checks/installer-pin.sh` refuses to let the installer's pinned release and commit drift from it. |

---

## Architecture

_As it actually is. Traffic goes browser → `http://<node-ip>:<port>` straight to
each service; only Bothy, its data plane and the `/oauth2/` sign-in endpoints pass
through Traefik._

![Traefik on :80 fans out to the catch-all serving Bothy, to exact-Path data-plane routes for the Traefik API, the Docker socket proxy and Loki/Prometheus, and to the oauth2-proxy prefix. oauth2-proxy talks OIDC to Keycloak on :8090, which stores its realm in the loopback-only Postgres. Every other service is reached directly on its own published port.](docs/assets/diagrams/readme-overview.svg)

The picture is generated from `docs/diagrams/readme-overview.mmd` by `just
diagrams`, and it shows the **shape** rather than a census: it predates the config
and control tiers, and the router count drawn in it is a snapshot. Prefer the
counts below - and note what actually checks them. `just verify` asserts **zero
`Host()` routers**, and only that. Every other number on this page is prose, and
prose goes stale silently; this README has twice described services that had
already been deleted. That is the honest state rather than an aspiration.

**Nine routers require a role**, across three files, counted from the tree:

| File | Routers | Requires |
|---|---|---|
| `edge/dynamic/portal-files.yml` | `portal-files-read`, `portal-files-download` | `viewer` |
| `edge/dynamic/portal-files.yml` | `portal-files-write`, `portal-files-delete` | `editor` |
| `edge/dynamic/bothy-config.yml` | `bothy-config-read` | `viewer` |
| `edge/dynamic/bothy-config.yml` | `bothy-config-write` | `editor` |
| `edge/dynamic/bothy-control.yml` | `bothy-control-restart`, `-stop`, `-start` | `operator` |

`sso-viewer` and `sso-editor` are defined in `portal-files.yml`, `sso-operator` in
`bothy-control.yml` - each next to the tier it gates. `auth.yml` defines only `sso`
and `sso-errors`, and bare `sso` is attached to **no router at all**: defining a
middleware is not attaching it.

### Six networks, each holding the minimum

- **`devnet`** - the shared external network everything ordinary joins. Traefik
  pins its discovery to it (`--providers.docker.network=devnet`) so it can never
  pick the wrong container IP from a project-local network.
- **`socketnet`** - Traefik and `bothy-socket-proxy`, and nothing else.
- **`filesnet`** - Traefik and `portal-files`, which holds read-write handles on
  two git repositories.
- **`confignet`** - Traefik and `bothy-config`, which can rewrite this box's
  compose files and edge routes.
- **`controlnet`** and **`controlsocknet`** - the action tier, and the reason it is
  two networks and not one holding three: Traefik must not be *able* to reach a
  proxy that can mutate containers. The edge meets `bothy-control` on one network
  and `bothy-control` meets its two proxies on the other. Each holds exactly two
  members.

### Single sign-on

**Status: enforcing, on the three tiers that can change things.** Keycloak issues
the roles and oauth2-proxy answers Traefik's `forwardAuth`. It is deliberately not
yet on the dashboards, and that is a decision rather than a backlog item:
attaching auth is the step that can lock you out, and the tools you would use to
unlock it are the very things you would have just put behind the broken login. So
the middlewares were defined first, proven against the tier where being wrong
costs most, and only then considered for anything else.

    Traefik --forwardAuth--> oauth2-proxy --OIDC--> Keycloak

The role requirement lives in the **middleware**, not in the service.
`sso-viewer`, `sso-editor` and `sso-operator` are identical but for one word in a
query string (`?allowed_groups=`). That is the property that makes the design
worth having - adding a tier is four lines of YAML, not another container. It was
verified before it was trusted, with a role the user does **not** hold:
`allowed_groups=editor` → 202, `allowed_groups=shell` → 403, junk → 403. It fails
closed, and `just files-check` re-runs the probe rather than leaving it assumed.
To require a login on a further router, add **both, in this order**:
`middlewares: [sso-errors@file, sso@file]`. Reversed, a signed-out user gets a
blank 401 instead of a sign-in page.

Two rules that cost real time, both argued at length in `auth/compose.yml`.
Keycloak re-advertises its own address, so `http://${BOX_IP}:8090` appears exactly
once as a value and is used by the browser *and* by oauth2-proxy - **a second
spelling is the bug**, and its symptom is not an error but an infinite redirect
loop. And there is deliberately no cookie domain: every service is a different
*port* on the same host and cookies ignore the port, so single sign-on across the
whole box falls out for free.

Two dead ends recorded so nobody pays for them twice:

- **A `"_comment"` key in `realm-devbox.json` crashloops Keycloak.** JSON has no
  comments and Keycloak rejects unknown fields outright. The reasoning that would
  have been inline lives in `auth/compose.yml` instead.
- **A doubled brace anywhere in `edge/dynamic/*.yml`, including inside a comment,
  silently voids the whole file.** Traefik renders every file in that directory as
  a Go template before parsing the YAML, and it does not skip comments. The file
  on disk looks perfect while Traefik loads no routers and no middlewares from it.

The full request path, the discovery join and the checklist for adding a service
are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## The `just` recipes worth knowing

```sh
just up          # everything, in dependency order (edge → data → auth → monitoring → apps)
just up-edge     # or bring up one group: up-data, up-auth, up-monitoring, up-apps
just down        # stop everything, keep the data
just nuke        # stop everything AND delete every volume - destructive, prompts first
just ps          # what is running
just doctor      # containers, Prometheus targets, disk/memory, backup freshness
just verify      # prove the edge still routes - 23 checks against the running stack
just files-check # path safety, per-route role enforcement, a served-secrets scan
just urls        # every address, plus what is deliberately not running
just logs NAME   # follow a container's logs
just psql        # a psql shell on the dev database
just backup      # what the 03:00 timer runs
just portability # count the paths and addresses that exist on only one machine
just diagrams    # re-render docs/diagrams/*.mmd; the SVGs are output, never source
```

Bringing up a group is safe and independent: the edge must be up before anything
expects to be routed, and auth before any router that references its middlewares,
but nothing else has an ordering requirement. `just up` runs `just bootstrap`
first, and that is not decoration - on a fresh clone Prometheus starts with
`--web.config.file` pointing at a gitignored file nothing creates.

`just nuke` sits one keystroke away from `just down` in the recipe list, which is
why it is the one recipe that asks for confirmation.

**Retirements are visible rather than silent.** `just redis` was removed with
Redis itself, because a recipe that can only ever fail looks like breakage.
`up-mgmt` went the same way with `mgmt/`, when Portainer and Dozzle were deleted
and Bothy grew its own answer to both. `just doctor` prints minikube's absence as
a third state, `dim` - deliberately switched off, not broken - for the same
reason: if every retirement reads as a fault, the report cries wolf until nobody
reads it.

---

## Things that will catch you

- **A 200 proves nothing about routing.** Bothy's catch-all `` PathPrefix(`/`) ``
  answers *every* unmatched request on `:80` with its own HTML - from any
  hostname, from the bare IP, for any path no other rule matched. So a service you
  believe you routed can be dead while `curl` reports a cheerful 200 and a page
  full of someone else's markup. It is the most convincing false positive
  available on this machine. **Assert on content, never on a status code** - which
  is exactly what `just verify` does.
- **A `Host()` rule added today registers as `enabled` and matches nothing.**
  There is no name layer. Publish a port, or use a host-less exact
  `` Path(`…`) `` rule - `edge/dynamic/project.example.yml` is the template.
- **A dotless hostname in a host process is a landmine.** dnsmasq runs with
  `domain-needed`, and that is not cosmetic. Without it, a bare compose service
  name (`tempo`, `redis`) leaking out of a container into a host process hangs
  ~40s per lookup - and since `getaddrinfo` runs on libuv's four-thread pool, a
  handful of them starve *every other lookup in the process*. It presents as
  unrelated database timeouts, which is a very expensive way to learn about DNS.
- **The box must stay awake.** WSL2 destroys the VM 60 seconds after the last
  Windows-side client disconnects, taking Docker and every container with it. A
  Windows scheduled task holds it open - see [`host/README.md`](host/README.md).
  `restart: unless-stopped` is inert if the daemon never starts.
- **Traefik's `edge/dynamic` mount goes stale after `git checkout`.** A bind mount
  pins the host inode at container-creation time and checkout recreates
  directories, so Traefik keeps reading an orphaned copy and silently serves its
  last in-memory config - `--providers.file.watch=true` stops meaning anything.
  Fix: `docker compose -f edge/compose.yml up -d --force-recreate`.
- **Listing `networks:` on a service silently drops it off the compose default
  network.** Always `[default, devnet]`, or the service loses its own database.
- **`just urls` is not an authoritative port registry.** It lists the *stack's*
  ports; a project's claims live in its own `project.dev.yml`, and nothing
  reconciles the two. Keycloak was once published on `:8083`, which a stopped
  project had already declared - the collector TCP-probed the declared port, found
  something listening, and reported a service nobody had started as up. It moved
  to `:8090`. Check **both** `ss -ltn` and the project manifests before publishing
  a port.
- **A route that misbehaves** → the router table is served at
  `http://<node-ip>/-/api/traefik/http/routers`, and rendered at `/control`. There
  is no Traefik dashboard to check instead; it was deleted because `/api/rawdata`
  dumped the merged config and leaked a credential a `customRequestHeaders`
  middleware had injected. **A headers middleware hides a secret from the browser,
  not from the config dump.**
- **Tunnel pings pong but pages stall, or SSH hangs at key exchange** - the
  large-packet blackhole. Restart tailscaled on the box; recipe in
  [`docs/kb/incidents/2026-08-08-wsl-node-large-packet-blackhole.md`](docs/kb/incidents/2026-08-08-wsl-node-large-packet-blackhole.md).

Databases are deliberately not routed at all. Reach Postgres over SSH:

```sh
ssh -L 5432:localhost:5432 <user>@<this-node>.<your-tailnet>.ts.net
```

---

## Backups

`stacks-backup.timer` runs `scripts/backup.sh` at 03:00 daily, keeping the newest
14 of each: the Postgres dump - which carries Keycloak's realm, users and roles as
well as the dev database - the Grafana database, and `.env`, which is gitignored
and exists in exactly one place on earth, so losing it loses every credential on
the box.

The script is deliberately **not** `set -e`: one failed service must not skip the
others. It waits for Postgres to accept connections before dumping, verifies every
artifact is non-empty before keeping it, and exits non-zero if any step failed.
All three are scar tissue - it previously produced 20-byte empty dumps for six
days while reporting success, because the timer is `Persistent=true` and a
schedule missed while the box was off fires at the next boot, which is exactly
when Postgres is still starting. `just doctor` therefore checks backup **age and
size**, not existence: a failed `pg_dumpall` still leaves behind a perfectly valid
gzip of nothing.

Backups sit on the same disk they protect. Copying them off the box is not solved.

---

## Deeper docs

- [**The guide**](docs/guide/index.md) - installing, configuring, operating,
  files, roles, themes.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - the request path, the networks,
  the discovery join, and the checklist for adding a service.
- [`docs/kb/`](docs/kb/README.md) - the operational knowledge base for this
  specific machine: topology, access paths, runbooks, incident files and the
  lessons they paid for. Deliberately not user documentation.
- **The compose files themselves.** Every non-obvious setting has a comment
  explaining what broke without it - `edge/compose.yml`, `auth/compose.yml`,
  `edge/dynamic/auth.yml` and `edge/dynamic/portal-api.yml` are the four worth
  reading in full.
- [`host/README.md`](host/README.md) - the host-level configuration that git
  cannot see, and what each copy is for.

## Contributing, security, licence

This is a personal box published as a reference, so issues and questions are more
welcome than pull requests - but both are read.

- [SECURITY.md](SECURITY.md) - the threat model, and what "safe on a tailnet"
  does and does not mean
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [LICENSE](LICENSE) - MIT
