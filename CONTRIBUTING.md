# Contributing

This is the configuration for one person's self-hosted development box, but
issues and pull requests are welcome - especially ones that catch a security
mistake or a wrong claim in a comment.

Two things to read before you change anything:

- **[SECURITY.md](SECURITY.md)** - several choices in this repo look like style
  and are actually the security boundary. Widening one `Path()` to a
  `PathPrefix()` publishes every container's environment variables.
- **[README.md](README.md)** - what the box is and how the pieces fit.

---

## Running it locally

**You need:** Linux (or WSL2), Docker Engine with the Compose plugin,
[`just`](https://github.com/casey/just). **No resolver, no DNS setup, no
hostnames** - access is `IP:port` and `just urls` prints the table. (`host/dnsmasq/`
still holds the configuration for the retired name layer; as of
2026-08-12 nothing depends on it.) Node 24 is only needed if you are working on
the portal front-end. `jq` and `tailscale` are optional; `just urls` degrades
gracefully without them.

```sh
cp .env.example .env      # then fill it in - see the fork checklist in SECURITY.md
just up                   # bring everything up, in dependency order
just urls                 # print every address
just doctor               # health check the whole box
```

`just up` is not a single `docker compose up`. It creates the two shared
networks and then brings the stacks up in an order that matters: `edge` (Traefik
must exist before anything expects to be routed) → `auth` (oauth2-proxy must
exist before routers reference its middleware) → `monitoring` → `data` → `mgmt`
→ `apps`. Each group also has its own recipe (`just up-edge`, `just up-data`, …)
so you can restart one thing without cycling the box.

**Always use `just`, never `docker compose` directly.** `just` loads the root
`.env` through `set dotenv-load`. `docker compose` looks for a `.env` beside the
compose file it was handed, finds none, and either silently falls back to the
insecure defaults or aborts on a required variable.

### The rest of the workflow

| Recipe | What it does |
|---|---|
| `just` | list every recipe |
| `just ps` | what is running |
| `just logs <service>` | follow one container's logs |
| `just psql` / `just redis` | a shell on the dev database / cache |
| `just backup` | run the backup the nightly timer also runs |
| `just doctor` | containers, Prometheus targets, k8s nodes, disk/memory, backup freshness |
| `just down` | stop everything, keep the volumes |
| `just nuke` | stop everything **and delete every data volume** |

`just nuke` sits one keystroke from `just down` in the recipe list and destroys
all seven data volumes. It prompts for a literal `yes`. Do not remove that
prompt.

### After any branch switch, recreate Traefik

Traefik file-provider routes live in `edge/dynamic/`, bind-mounted into the
container. A bind mount pins the host inode at container-creation time, and
`git checkout` deletes and recreates that directory - so after switching
branches, Traefik keeps reading an orphaned, empty directory and silently serves
a stale in-memory config. It ran that way for five days once. Every edit to
`edge/dynamic/` appears to have no effect.

```sh
docker compose -f edge/compose.yml up -d --force-recreate
```

Do this after every checkout that touches `edge/dynamic/`, and any time a route
change "doesn't apply".

---

## House rules

These are the conventions the whole box depends on. A change that breaks one of
them will be sent back.

### Add a browser-facing service with a published port and a `just urls` entry

> **Rewritten 2026-08-12.** This section used to teach a two-label recipe that
> gave a service a `<name>.<base-domain>` hostname and **no** published port. That
> recipe is dead: the name layer was deleted on 2026-08-12, Traefik holds zero
> `Host()` rules, and such a router would register, report `enabled`, and match
> nothing forever. If you find that recipe anywhere else, it is stale.

```yaml
services:
  myapp:
    image: myorg/myapp
    networks: [default, devnet]      # BOTH - see below
    ports:
      - "8099:8080"                  # HOST:CONTAINER - check the host port is free
    labels:
      # Optional. Portal discovery works with zero labels; these are polish.
      - dev.portal.name=My App
      - dev.portal.desc=What it does.
```

Then, in order:

| Step | Why |
|---|---|
| Check the port is free - `just urls`, then `docker ps` | Ports are a flat namespace of 65,535 with no allocator, and everyone reaches for 3000, 8080, 5432. This check is the price of the model |
| Add it to the `urls` recipe in the `justfile` | `just urls` is the only inventory of what is reachable. A service missing from it is a service nobody finds |
| Give it a login | Use the shared `DEV_LOGIN_*` credential from `.env`, the way Grafana and Prometheus do. There is no edge auth to fall back on |
| Join `devnet` as well as `default` | So Prometheus can scrape it and the portal can discover it |
| **Do not** add `traefik.http.routers.*.rule=Host(...)` | There is no name to match |
| **Do not** attach `sso-errors@file,sso@file` | See below |

`edge/compose.yml` is the only container that should ever publish `:80`.
Databases stay bound to `127.0.0.1` (see below).

**Listing `networks:` on a service silently drops it off the compose default
network.** Always `[default, devnet]`, or the service loses its own database.

**The cost is worth naming.** The name layer existed because ports collide and
names do not, and that argument was never wrong. It was abandoned because it had
a single point of failure - the Tailscale split-DNS route - whose loss killed
every address on the box at once while every container stayed healthy. Ports are
ugly and they always work. See
[docs/ARCHITECTURE.md § 4](docs/ARCHITECTURE.md#4-the-naming-convention-retired).

### Do not attach the SSO middleware pair

`sso@file` and `sso-errors@file` are **defined in `edge/dynamic/auth.yml` and
attached to no router**, deliberately, while identity is rebuilt on Keycloak.
Rolling them out is a planned one-router-at-a-time exercise, not a per-service
decision - `sso` fails closed, so if oauth2-proxy is down every router carrying
it returns 500, including whichever one you would need to fix it. Give your
service its own login instead. Details and the intended order in
[SECURITY.md](SECURITY.md#1-sso-is-being-rebuilt-and-is-attached-to-nothing).

### Never put a doubled brace in `edge/dynamic/`, not even in a comment

Traefik renders every file in that directory as a Go template before it parses
the YAML, and it does not skip comments. One doubled brace - a `docker inspect
-f` format string in a comment is the way this happens - is evaluated as a
template action, fails, and silently takes out the **whole file**: no routers,
no middlewares, while the file on disk looks perfect. Cost a session on
2026-08-12. Use the `jq` form instead. Single braces (Traefik's own `{url}`) are
fine.

### `.test`, never `.dev` - if a name layer ever returns

Nothing on this box uses a name today. Kept because it is the constraint any
replacement inherits: `.dev` is HSTS-preloaded, so browsers force HTTPS on it
and a plain-HTTP page never loads at all. `.test` is reserved by RFC 6761.

### Databases bind to `127.0.0.1` explicitly

`- "127.0.0.1:5432:5432"`, never `- "5432:5432"`. Containers reach them by name
over `devnet`; humans reach them by SSH tunnel.

### Pin images

No `:latest`, ever - least of all on the socket proxy or oauth2-proxy, which are
the two containers that *are* the boundary. Prefer an exact version tag, and a
digest for third-party images.

### Don't add a port to the Windows portproxy scripts

That layer under `host/windows/` is vestigial. Add a Traefik label instead.

### Secrets

Real values go in `.env`, which is gitignored. `.env.example` gets a
placeholder and, if the variable is mandatory, the compose file gets
`${VAR:?message}` so a missing value aborts the stack rather than starting an
auth layer with no credentials. Never put a secret in a `command:` array.

### Comments carry the *why*

Nearly every non-obvious line in this repo has a comment explaining the failure
that produced it - a boot race, a CSRF cookie thrown away by an errors
middleware, a bind-mount inode. Keep that up. If you change a line that has such
a comment, either the comment changes with it or you have probably reintroduced
the bug.

---

## Working on the portal

The portal - **Bothy**, served at `http://<node-ip>/` by the catch-all router -
is a Vite + React app in `apps/portal-next/web`, built to static files by a
multi-stage Docker image (Node builds, nginx serves `dist/`). It **discovers**
what is running from read-only APIs under `/-/api/*` - it is not a hand-written
list, and must never become one again.

Note (2026-08-12): with the name layer gone, Traefik reports seven routers
instead of twenty-two, so the Docker half of the discovery join carries nearly
all the weight and `extractHost()` returns `null` for every router. A service
that publishes a port but has no route still appears - it comes from
`/containers/json`, not from the route table.

Before you open a PR, both of these must pass:

```sh
cd apps/portal-next/web
npx tsc -b --noEmit
npm run build
```

Then rebuild and check it in a real browser:

```sh
docker compose -f apps/portal-next/compose.yml up -d --build
```

**Do not `docker compose down` the `bothy` project to restart the portal.** That
project also owns `bothy-socket-proxy`, the read-only Docker socket the portal
needs for `/-/api/docker`; take it down and the Overview enrichment goes blank
even after portal-next comes back. Act on the one service, as above.

(This paragraph used to warn about `apps/portal/`. That directory existed only
to hold the socket proxy and was deleted on 2026-08-18 - the fragment now lives
in `apps/bothy/socket-proxy.yml`. The retired pure-HTML nginx portal it also
described went on 2026-08-17.)

**A headless DOM cannot review a page.** jsdom has no layout, so "blank" and
"perfect" look identical to it. This repo has shipped a near-blank portal twice
because of an entrance animation that defaulted content to `opacity: 0`. Use a
real browser - Playwright plus a screenshot - for anything visual, and make
entrance animations animate *from* a visible resting state.

Useful checks:

```sh
BOX=127.0.0.1        # or the tailnet IP from `just urls` - there is no name

# data plane
curl -s http://$BOX/-/api/traefik/http/routers | jq length      # 7 as of 2026-08-12
curl -s http://$BOX/-/api/docker/containers/json | jq length

# the security gate - CHECK THE CONTENT TYPE, NOT THE STATUS.
# The catch-all answers every unrouted path with the SPA at 200, so a status
# assertion here can never fail. Blocked = text/html, allowed = application/json.
curl -s -o /dev/null -w '%{content_type}\n' \
  http://$BOX/-/api/docker/containers/$(docker ps -q | head -1)/json   # text/html
curl -s -o /dev/null -w '%{content_type}\n' \
  http://$BOX/-/api/docker/containers/json                             # application/json

# the thesis: a container appears with no portal edit at all
docker stop grafana   # its dot goes red within 10s; nothing was hand-edited
```

**A 200 with HTML is not success - it is the catch-all.** Every path on `:80`
that is not one of the exact `/-/api/*` rules returns the portal SPA. When a
data-plane curl looks wrong, check `%{content_type}` before anything else.

---

## Commits and branches

**Commit subjects are Conventional Commits**, lowercase, imperative, with an
optional scope:

```
feat(portal): reorganize dashboard around "systems" + disk usage
fix(portal): stop the dashboard lying, and rebuild the Overview around it
fix: bind databases to loopback only
chore: pin every floating image tag
docs: rewrite readme for traefik sso and tailnet
refactor: split portal into live discovery assets
```

Types in use: `feat`, `fix`, `chore`, `docs`, `refactor`. The scope, when
present, is the stack directory (`portal`, `monitoring`, `edge`, `data`).

The body is where the *why* goes - what broke, what was ruled out, what the
naive fix would have been. Several commits in this history are worth reading as
documentation; aim for that.

**Branch names** follow `<Author>/<Type>/<short-description>`, with the
description in kebab-case:

```
Claude-Bot/Fix/bind-databases-to-loopback-only
Claude-Bot/Feat/portal-react-rewrite
Claude-Bot/Chore/pin-floating-image-tags
Claude-Bot/Docs/rewrite-readme-for-current-architecture
```

Work happens on a branch and lands on `main` through a pull request - including
the maintainer's own. Do not commit directly to `main`.

### Pull requests

Keep one PR to one concern. In the description, say what broke and how you
confirmed the fix - a pasted command and its output beats a claim. If you
touched anything in
[SECURITY.md's load-bearing list](SECURITY.md#load-bearing-design-rules), say so
explicitly and include the boundary `curl` output.

Please **do not** open a public issue for a vulnerability; use a private
security advisory instead ([SECURITY.md](SECURITY.md#reporting-a-vulnerability)).

By contributing you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
