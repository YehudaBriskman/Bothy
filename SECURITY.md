# Security Policy

This repository is the configuration for a **personal, self-hosted development
box**: a set of Docker Compose stacks behind one Traefik reverse proxy, driven by
a `justfile`. It is published so the design can be read and reused, not because
it is a hardened product.

Most of what follows is not generic advice. Several choices in this repo look
like style and are actually the security boundary — a well-meaning
"simplification" of any of them turns a read-only status page into a credential
leak or a remote root shell. Those are listed under
[Load-bearing design rules](#load-bearing-design-rules). Read that section before
touching `edge/dynamic/portal-api.yml`, `edge/dynamic/portal-prom.yml`,
`apps/portal/compose.yml`, `edge/dynamic/auth.yml` or `auth/`.

---

## Threat model

**What this is.** One developer's workstation on a **private Tailscale
tailnet**. Services are reached at `tailnet-IP:port` (published host ports);
Traefik on `:80` serves the portal and its read-only data plane.

**The name layer and the SSO in front of it are gone, not dormant** (updated
2026-08-12). `*.dev.test` went dormant on 2026-08-08 when the split-DNS route
was removed, and its configuration was **deleted on 2026-08-12**: Traefik holds
zero `Host()` rules, and the Traefik dashboard router was deleted with them.
Identity is being rebuilt on Keycloak + oauth2-proxy — the `sso@file` and
`sso-errors@file` middlewares are **defined and attached to no router**, so
**no request to this box is authenticated at the edge today**. Sections below
that describe the SSO design describe what is being rebuilt, and say so.

**Who can reach it.** Only devices on that tailnet. The tailnet is WireGuard, so
the transport is encrypted even though every URL is plain `http://`. A device not
joined to the tailnet cannot route to the box at all; the Windows-host port
mirrors bind `127.0.0.1` + the host's tailnet IP only, so nothing is exposed to
the LAN or to the internet.

**The current control, stated plainly.** With no edge auth, three things and
nothing else stand between a tailnet device and the box:

| Control | Covers |
|---|---|
| The tailnet itself | Everything. It is the outer perimeter and, today, very nearly the only one |
| Each service's own login, using the shared `DEV_LOGIN_*` credential | Grafana, Portainer, Dozzle, Kafka-UI, Prometheus |
| The exact `Path()` rules in `edge/dynamic/portal-api.yml` and `portal-prom.yml` | The portal's data plane — the only reachable slice of the Docker socket, Loki, Prometheus and the Traefik API |

The portal itself and the docs site have **no** login. That is accepted, not
overlooked.

**What is therefore in scope.**

- Anything reachable from the tailnet without authenticating (a dashboard that
  lost its login, or a router rule that matches more than it should).
- Anything that discloses a secret to a party who *has* authenticated — the
  container-`Env` leak described below is the canonical example.
- Anything that converts read access into write access on the Docker socket,
  which is root-equivalent on this box.
- Secrets committed to the repository.

**What is out of scope.**

- An attacker who already has a shell on the box, or an authorised tailnet
  device. Both are inside the trust boundary by construction.
- Plaintext HTTP. This is deliberate — see [Accepted risks](#accepted-risks).
- Denial of service against a single-user development box.
- The disclosure surface the portal *intentionally* publishes to any tailnet
  device: container names, images, ports, health, compose labels, volume names
  and disk sizes, plus every Prometheus metric and label value. That is
  home-directory-layout disclosure, judged acceptable on a personal tailnet —
  and **not** acceptable the moment the box reaches beyond one.
- The absence of edge authentication as of 2026-08-12. It is a known,
  time-boxed state while identity is rebuilt, recorded under
  [Accepted risks](#accepted-risks) — not a finding.

**If you fork this and expose it beyond a private tailnet, the model above stops
holding.** Plaintext HTTP, an unauthenticated portal and data plane, and
loopback-only databases were all chosen against the assumption that the network
itself is the outer perimeter.

---

## Reporting a vulnerability

Please report privately, **not** as a public issue.

Use **GitHub private security advisories** on this repository:
**Security → Advisories → Report a vulnerability**
(<https://github.com/YehudaBriskman/dev-box/security/advisories/new>).

Include:

- the file and line that is wrong (e.g. a router rule, a compose env var);
- what an attacker on the tailnet — or, if you believe the boundary can be
  crossed, off it — could obtain;
- ideally, the one-line `curl` that demonstrates it.

Expect an acknowledgement within about a week. This is a personal project run by
one maintainer, so there is no formal SLA and no bounty. Fixes land as ordinary
commits; a credited advisory is published for anything that would have leaked a
credential or granted socket access.

**Please do not report:** the absence of TLS, the sample credentials in
`.env.example`, or the absence of edge authentication as of 2026-08-12 — all
three are documented decisions, below. Traefik's unauthenticated dashboard was a
real finding and **was fixed on 2026-08-12** by deleting the router; a report
that it is still exposed is out of date, and a report that it has *returned* is
very much wanted.

---

## Load-bearing design rules

Every rule here has a reason written next to it in the source. Changing one is a
security change, and should be reviewed as one.

### 1. SSO is being rebuilt, and is attached to nothing

> **Status 2026-08-12: NOT ENFORCED.** The middlewares exist; no router carries
> them. Every service on this box is reachable from the tailnet without passing
> through an auth boundary. Interim control: each dashboard's native login with
> the shared `DEV_LOGIN_*` credential, plus the tailnet itself.

**What happened.** The original design was oauth2-proxy against GitHub, with the
OAuth callback pinned to `http://auth.dev.test/oauth2/callback`. When the name
layer went dormant on 2026-08-08 the callback stopped resolving and the whole
flow broke — an authentication layer with a single-point dependency on a DNS
setting. On 2026-08-12 identity moved to a **local Keycloak** (`auth/compose.yml`,
host port `8090`) so the callback is an IP:port URL and depends on no name.

`edge/dynamic/auth.yml` defines two Traefik middlewares:

- `sso` — a `forwardAuth` to `/oauth2/auth`; 202 passes, 401 means no session;
- `sso-errors` — an `errors` middleware that catches that 401 and serves the
  sign-in page in its place, at the URL the user actually asked for.

**Defining them does not enforce them.** It makes `sso@file` and `sso-errors@file`
resolvable names in Traefik and nothing more. The one router the auth stack does
own is `oauth2-endpoints` (`PathPrefix(/oauth2/)`, priority 100, host-less), which
exists so the login flow and its callback are reachable at all — oauth2-proxy
publishes no host port.

**Why it is being rolled out one router at a time, not all at once.** Attaching
auth is the step that can lock you out of the box, and the tools you would use to
unlock it — the portal, Grafana, Dozzle — are exactly what you would have just
put behind the broken login. Worse, `sso` **fails closed**: if oauth2-proxy is
down, every router carrying it returns 500 to everyone. That is correct for an
auth boundary and it is precisely why you do not attach it to the thing you need
in order to fix it. Verify the flow end to end against one low-stakes router
first.

**When attaching them, order matters — `sso-errors@file,sso@file`.** The request
passes through `sso-errors` on the way in and the 401 travels back out through
it. Get the order wrong and a signed-out user receives a blank 401 with no way
forward.

**What will need the pair, in rough priority order when it returns:** Portainer
first (it mounts the Docker socket **read-write** and its UI grants container
`exec`, which is root on this box), then Prometheus (it accepts `POST /-/quit`),
Dozzle (every container's logs), Kafka-UI (`DYNAMIC_CONFIG_ENABLED`), the portal
and its data-plane routers, the docs site, and the catch-all fallback router —
that last one because it answers every request matching no other rule, so
leaving it open is a hole in exactly that shape.

**A trap that already cost a session (2026-08-12).** Traefik renders every file
in `edge/dynamic/` as a **Go template before parsing the YAML, and does not skip
comments**. A doubled brace anywhere in one of those files — including inside a
comment, such as a `docker inspect -f` format string — is evaluated as a template
action, fails, and silently takes out the **whole file**: no routers, no
middlewares, while the file on disk looks perfect. Keep doubled braces out of
`edge/dynamic/` entirely.

### 2. docker-socket-proxy: network reachability *is* authorisation

`apps/portal/compose.yml` runs `tecnativa/docker-socket-proxy` so that nginx
never has to touch `/var/run/docker.sock` — which is root-equivalent on this
box. Four properties keep that safe, and all four are load-bearing:

- **It has no authentication of any kind.** There is no token, no password.
  Anything that can open a TCP connection to it gets whatever the proxy permits.
  Therefore:
- **It lives on `socketnet`, not `devnet`.** `socketnet` holds exactly two
  containers — Traefik and the socket proxy. `devnet` holds around twenty,
  including third-party images (Keycloak, Kafka-UI, Portainer, project images)
  that could simply `curl` it. The network *is* the access-control list; keep
  the blast radius at two. (`just network` creates both, with that reasoning
  inline.)
- **`POST: 0`.** Without it, `CONTAINERS=1` also grants
  `/containers/{id}/kill|stop|restart`, and `SYSTEM=1` would grant every
  mutating `/system` call. Every other endpoint family is explicitly `0` — the
  image denies by default, but a socket proxy is the last place to trust a
  default surviving an image bump, so each one is written out. `EXEC: 0` in
  particular: container exec is root on this box.
- **The image is pinned to an exact tag, never `:latest`,** and it publishes
  **no `ports:`** — ever. It must not be reachable from the host network.

The socket is mounted `:ro`. That is the second lock, not the first: the proxy
is the real boundary, but a writable socket would leave `POST: 0` as the *only*
thing standing between the tailnet and root.

Because the proxy is not on `devnet`, Traefik's Docker provider cannot see it —
which is exactly why its service is declared in the file provider
(`edge/dynamic/portal-api.yml`) rather than by container labels.

### 3. The `/-/api/*` routers use exact `Path()`. Never `PathPrefix()`. This is THE control.

**`CONTAINERS=1` does not mean "only `/containers/json`".** docker-socket-proxy
gates by endpoint *family*, so it will happily serve `/containers/{id}/json` —
and **that response body contains `Env`**. On this box that is the Postgres
password and the Grafana admin password, verified by reading them out of it.

The socket-proxy environment variables **do not** prevent this. The only thing
that prevents it is that every rule in `edge/dynamic/portal-api.yml` is an
**exact `Path()`**. There are exactly two Docker paths routed:

```
Path(`/-/api/docker/containers/json`) || Path(`/-/api/docker/system/df`)
```

A single `PathPrefix` there would publish every container's environment —
i.e. every password on the box — to anyone who can sign in.

Rules that follow from this:

- **Never widen an API router to `PathPrefix`.** This is the credential leak.
- **Add a Docker endpoint only as a new exact `Path()`**, and only after
  confirming its response body carries no `Env`. That check *is* the whole
  review. (`/system/df` passed it: it returns the same categories already
  exposed by `/containers/json` — names, images, labels, command, mounts — plus
  size numbers, and no `Env`. Only `/system/df` is routed, so `/system/info`,
  `/system/events` and the rest stay unreachable through the edge even with the
  family enabled.)
- **Regression test after any change to that file — assert the content type,
  never the status code.** Rewritten 2026-08-12. The old form asserted `404`,
  and that assertion can no longer fail: the portal's catch-all
  `PathPrefix(`/`)` router at priority 1 answers every unrouted path with the
  SPA, so a blocked endpoint returns **200 `text/html`**. A leak and a block are
  indistinguishable by status. Both lines below were verified on 2026-08-12:

  ```sh
  BOX=127.0.0.1                       # or the tailnet IP — there is no name
  CID=$(docker ps -q | head -1)

  # BLOCKED — must print text/html (the portal SPA, not a container body)
  curl -s -o /dev/null -w '%{content_type}\n' \
    http://$BOX/-/api/docker/containers/$CID/json

  # ALLOWED — must print application/json
  curl -s -o /dev/null -w '%{content_type}\n' \
    http://$BOX/-/api/docker/containers/json
  ```

  If the blocked line ever prints `application/json`, a rule has been widened
  and every container's `Env` is on the tailnet.

- The API routers carry **no `Host()` rule**. That was originally so they would
  work from the bare IP as well as from every name; since 2026-08-12 it is the
  only shape available, because no name layer exists. They answer on every
  address the box has at once. `/-/` is therefore a reserved prefix on every
  address this box serves; do not mount anything else under it.
- **Nothing else guards these routes.** This section used to add that the `sso`
  middleware also closed a DNS-rebinding hole, because a rebound request carries
  the attacker's `Host` and so never receives the `.dev.test`-scoped session
  cookie. That reasoning is void as of 2026-08-12: there is no name, no
  name-scoped cookie, `sso@file` is attached to no router, and there is no name
  left to rebind — only an IP. The exact `Path()` rules are the entire control,
  alone, and should be reviewed as if they were the only line of defence,
  because they are.
- **The Traefik API is reachable only through four exact paths, and that now
  matters more than it did.** The dashboard router that served the whole of
  `api@internal` was deleted on 2026-08-12 — see
  [Accepted risks](#accepted-risks) for what it leaked. Never route
  `/api/rawdata`.

Host bind paths and container `Command` (argv) are deliberately **not** rendered
by the portal even though they are present in the payload — home-directory and
argv disclosure with no UI payoff. Named volumes *are* surfaced, on purpose, for
the disk panel.

### 4. Databases publish on loopback only

`data/postgres`, `data/redis` and `data/kafka` bind their host ports to
`127.0.0.1` explicitly:

```yaml
ports:
  - "127.0.0.1:5432:5432"
```

Dropping the `127.0.0.1:` prefix binds `0.0.0.0` and hands the whole tailnet a
database. This matters most for Redis, which runs with **no `requirepass` at
all**, and for Kafka, whose `EXTERNAL` listener advertises `localhost:9092` and
was only ever usable from the box or through an SSH tunnel.

Containers reach these services **by name over `devnet`** and never touch the
published port, so the loopback binding costs nothing. Human access is by SSH
tunnel:

```sh
ssh -L 5432:localhost:5432 -L 6379:localhost:6379 -L 9092:localhost:9092 \
    <user>@<this-node>.<your-tailnet>.ts.net
```

No database is routed through Traefik and none should be. Traefik owns HTTP on
`:80`; a database behind an HTTP router is a category error.

### 5. Secrets live in a gitignored `.env`

- `.env` is in `.gitignore`, first entry, under the comment *"Secrets — never
  commit real credentials"*. So are `backups/`, `*.rdb`, `*.sql`, `*.sql.gz`.
- `.env.example` carries **placeholders only** and is the file that gets
  committed. The OAuth entries are blank; `WIKI_DB_PASSWORD` is a literal
  `changeme` that `just up` refuses to start without.
- Compose files reference secrets as `${VAR}` and use `${VAR:?message}` for the
  ones that must never fall back to a default — the three oauth2-proxy values do
  exactly that, so a missing client secret aborts the stack instead of silently
  starting an auth layer with no credentials.
- **Always use `just`, not `docker compose` directly.** `just` loads the root
  `.env` via `set dotenv-load`; `docker compose` looks for a `.env` beside the
  compose file it was handed, finds none, and silently falls back to the
  insecure defaults.
- Do not add a secret to a `command:` array — argv is visible in
  `/containers/json`-adjacent surfaces and in `ps`. Use `environment:` with a
  `${VAR}` reference.
- **A secret that has to live in an edge config file is generated, never
  committed.** `edge/dynamic/portal-prom.yml` carries a basic-auth header for
  Prometheus, so it is written from the environment by
  `scripts/gen-portal-prom-route.sh` (`just portal-prom-route`), gitignored, and
  a **comments-only** example is committed beside it. Two things were learned
  the hard way, both recorded 2026-08-12:
  - The first version of that example was *live YAML* declaring the same router
    and middleware names as the real file. Traefik's file provider merges every
    file in the directory, so the example overwrote the real credential with its
    placeholder — every query returned 401 while the router still reported
    `enabled`. An example in a watched directory must be comments only.
  - A `customRequestHeaders` middleware is rendered verbatim by Traefik's
    `/api/rawdata`. The dashboard router that served it was deleted for exactly
    this reason. Never route a Traefik API path that echoes middleware config.

If a credential is ever committed, treat it as compromised: rotate it first,
then rewrite history. Removing it in a follow-up commit is not a fix.

---

## Accepted risks

These are decisions, not oversights. They are listed here so that a reader can
judge them, and so nobody "fixes" one without understanding what it buys.

- **No authentication at the edge, as of 2026-08-12.** SSO is defined and
  attached to nothing while identity is rebuilt on Keycloak. The tailnet plus
  each service's own `DEV_LOGIN_*` login are the controls; the portal, the docs
  site and the `/-/api/*` data plane have neither. This is a *time-boxed* state,
  not a permanent design — it is listed here so it is judged rather than
  discovered, and the plan is in [rule 1](#1-sso-is-being-rebuilt-and-is-attached-to-nothing).
- **Plain HTTP everywhere.** TLS would mean a private CA installed on every
  device. The tailnet is already WireGuard, so the wire is encrypted regardless.
  Safe *only* because the tailnet is the transport — revisit the moment anything
  here is reachable from outside it. Under the old name layer this also forced
  `--cookie-secure=false` and GitHub-over-Google as the SSO provider (Google
  rejects `http://` redirect URIs); with an IP:port callback, the plain-HTTP
  constraint still applies to whatever identity provider replaces it.
- **The Traefik API is exposed at four read-only paths under `/-/api/traefik/`**
  (routers, services, overview, version), unauthenticated. The old justification
  — "the dashboard already serves it" — no longer holds, because the dashboard
  is gone; these four paths are now the only reachable slice, which is the
  point. They return route and service names, no credential.
- **`.test`, never `.dev`** — kept as a rule for any future name layer. `.dev`
  is HSTS-preloaded; browsers force HTTPS and a plain-HTTP page never loads at
  all. Nothing on the box relies on a name today.
- **The portal publishes an inventory of the box** to any tailnet device: names,
  images, ports, health, labels, volumes, disk sizes, and every Prometheus
  metric and label value. Not `Env`, and not the metrics credential.
- **Sample credentials in `.env.example` are weak on purpose** — they are
  placeholders for a local dev box, and the file says so.

### Fixed, not accepted

Recorded 2026-08-12 so nobody re-files it and nobody reintroduces it.

| Was | Why it was a real finding | Fix |
|---|---|---|
| The Traefik dashboard router served `api@internal` unauthenticated | `/api/rawdata` renders middleware configuration verbatim, including the live `Authorization: Basic` header that `portal-prom.yml`'s `customRequestHeaders` middleware injects. A read-only dashboard was handing out a credential | Router deleted; `--api.dashboard=true` became `--api=true`. `api@internal` survives only as the backend for four exact `Path()` rules |

---

## If you fork this

Nothing in this repo is safe to run with the values it ships with. Before your
first `just up`:

1. **Create your own `.env` from `.env.example`.** Never commit it; confirm
   `git check-ignore -v .env` prints the rule.
2. **Rotate the sample Postgres credentials.** `POSTGRES_PASSWORD=devpass` is a
   placeholder. Change `POSTGRES_USER`/`POSTGRES_DB` too if you like — they flow
   into the exporter's DSN automatically.
3. **Change the Grafana admin password** from the `admin`/`admin` sample, set
   your own `DEV_LOGIN_*` values, and set a real `WIKI_DB_PASSWORD` in place of
   `changeme`.
4. **Assume nothing is authenticated until you attach it yourself.** As shipped
   (2026-08-12) `sso@file` and `sso-errors@file` are defined and attached to no
   router. Read
   [rule 1](#1-sso-is-being-rebuilt-and-is-attached-to-nothing) before you
   assume any dashboard here is behind a login, and attach the pair one router
   at a time — starting with a router you do not need in order to fix a mistake.
5. **Generate `edge/dynamic/portal-prom.yml`, never commit it.** Run
   `just portal-prom-route`. It carries a credential; `git check-ignore -v
   edge/dynamic/portal-prom.yml` must print the rule.
6. **Keep it on a private tailnet.** If you put this behind a public address, at
   minimum you need TLS, real authentication in front of every route, the
   portal's Docker API removed or re-reviewed, and the databases moved off any
   published port at all. The port model in particular assumes an outer
   perimeter that a public address does not have.
7. **Re-run the boundary test** after any change under `edge/dynamic/` —
   the `curl` pair in
   [rule 3](#3-the--api-routers-use-exact-path-never-pathprefix-this-is-the-control)
   must print `text/html` for the blocked path and `application/json` for the
   allowed one. Check the content type; the status code cannot fail.
8. **Do not commit real hostnames, tailnet IPs or account identifiers.** The
   `just urls` recipe reads them from `tailscale` at run time precisely so they
   never land in the repo. Keep it that way.
