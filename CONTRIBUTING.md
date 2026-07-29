# Contributing

This is the configuration for one person's self-hosted development box, but
issues and pull requests are welcome — especially ones that catch a security
mistake or a wrong claim in a comment.

Two things to read before you change anything:

- **[SECURITY.md](SECURITY.md)** — several choices in this repo look like style
  and are actually the security boundary. Widening one `Path()` to a
  `PathPrefix()` publishes every container's environment variables.
- **[README.md](README.md)** — what the box is and how the pieces fit.

---

## Running it locally

**You need:** Linux (or WSL2), Docker Engine with the Compose plugin,
[`just`](https://github.com/casey/just), and — for the `*.dev.test` names to
resolve — a local resolver that is authoritative for `.test`. `host/dnsmasq/`
holds the configuration used here. Node 24 is only needed if you are working on
the portal front-end. `jq` and `tailscale` are optional; `just urls` degrades
gracefully without them.

```sh
cp .env.example .env      # then fill it in — see the fork checklist in SECURITY.md
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
`git checkout` deletes and recreates that directory — so after switching
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

### Add a service with two Traefik labels and a name — never a published port

Host ports are a flat namespace of 65,535 that every project collides in;
everyone reaches for 3000, 8080, 5432. Names are infinite. Traefik owns `:80`
and routes by `Host` header, so a new service publishes **no** host port:

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.<name>.rule=Host(`<name>.dev.test`)
  - traefik.http.routers.<name>.entrypoints=web
  - traefik.http.routers.<name>.service=<name>
  - traefik.http.services.<name>.loadbalancer.server.port=<container port>
  # if it has no login of its own:
  - traefik.http.routers.<name>.middlewares=sso-errors@file,sso@file
networks: [devnet]
```

`edge/compose.yml` is the only container that should ever publish `:80`.
Legitimate exceptions to the no-ports rule are databases bound to `127.0.0.1`
(see below) and a handful of pre-Traefik services that still carry a published
port for backwards compatibility — do not add to that list.

Naming nests: `<service>.dev.test` for a stack service, `<project>.dev.test` for
a project, `<sub>.<project>.dev.test` for a project's own pieces. This is not
cosmetic — the portal groups by hostname nesting, so `s3.cvops.dev.test` files
itself under CVOps automatically.

### `.test`, never `.dev`

`.dev` is HSTS-preloaded. Browsers force HTTPS on it and a plain-HTTP page never
loads at all.

### If it has no login of its own, it gets the SSO middleware pair

`sso-errors@file,sso@file`, in that order. See
[SECURITY.md](SECURITY.md#1-every-dashboard-sits-behind-oauth2-proxy-sso) for why
the order matters.

### Databases bind to `127.0.0.1` explicitly

`- "127.0.0.1:5432:5432"`, never `- "5432:5432"`. Containers reach them by name
over `devnet`; humans reach them by SSH tunnel.

### Pin images

No `:latest`, ever — least of all on the socket proxy or oauth2-proxy, which are
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
that produced it — a boot race, a CSRF cookie thrown away by an errors
middleware, a bind-mount inode. Keep that up. If you change a line that has such
a comment, either the comment changes with it or you have probably reintroduced
the bug.

---

## Working on the portal

The portal (`dev.test`) is a Vite + React app in `apps/portal-next/web`, built to
static files by a multi-stage Docker image (Node builds, nginx serves `dist/`).
It **discovers** what is running from two read-only APIs — it is not a
hand-written list, and must never become one again.

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

**Do not `docker compose down` `apps/portal`.** That compose file still owns
`portal-socket-proxy`, which the new portal needs for `/-/api/docker`. The old
pure-HTML nginx in there is retired via `traefik.enable=false`, kept as a
one-line rollback.

**A headless DOM cannot review a page.** jsdom has no layout, so "blank" and
"perfect" look identical to it. This repo has shipped a near-blank portal twice
because of an entrance animation that defaulted content to `opacity: 0`. Use a
real browser — Playwright plus a screenshot — for anything visual, and make
entrance animations animate *from* a visible resting state.

Useful checks:

```sh
# data plane
curl -s http://dev.test/-/api/traefik/http/routers | jq length
curl -s http://dev.test/-/api/docker/containers/json | jq length

# the security gate — MUST NOT return a container body (404, or 401 from SSO)
curl -s -o /dev/null -w '%{http_code}\n' \
  http://dev.test/-/api/docker/containers/$(docker ps -q | head -1)/json

# the thesis: two labels on any container and it appears, with no portal edit
docker stop grafana   # its dot goes red within 10s; nothing was hand-edited
```

Note that `curl`ing a `*.dev.test` name from a shell returns the **SSO sign-in
page**, not your data — a 200 with HTML is not success. Use a loopback port or
the container's `devnet` IP when you need the real response.

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

The body is where the *why* goes — what broke, what was ruled out, what the
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

Work happens on a branch and lands on `main` through a pull request — including
the maintainer's own. Do not commit directly to `main`.

### Pull requests

Keep one PR to one concern. In the description, say what broke and how you
confirmed the fix — a pasted command and its output beats a claim. If you
touched anything in
[SECURITY.md's load-bearing list](SECURITY.md#load-bearing-design-rules), say so
explicitly and include the boundary `curl` output.

Please **do not** open a public issue for a vulnerability; use a private
security advisory instead ([SECURITY.md](SECURITY.md#reporting-a-vulnerability)).

By contributing you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
