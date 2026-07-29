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
touching `edge/dynamic/portal-api.yml`, `apps/portal/compose.yml` or `auth/`.

---

## Threat model

**What this is.** One developer's workstation. Every service listens inside
Docker networks; exactly one container (Traefik) publishes port 80 on the host.
Names under `*.dev.test` resolve through a local dnsmasq that is authoritative
for `.test`, published to a **private Tailscale tailnet** by split DNS.

**Who can reach it.** Only devices on that tailnet. The tailnet is WireGuard, so
the transport is encrypted even though every URL is plain `http://`. A device not
joined to the tailnet gets `NXDOMAIN` and cannot route to the box at all.
Nothing here is exposed to the LAN or to the internet.

**What is therefore in scope.**

- Anything reachable from the tailnet without authenticating (a dashboard that
  lost its SSO middleware, a router rule that matches more than it should).
- Anything that discloses a secret to a party who *has* authenticated — the
  container-`Env` leak described below is the canonical example.
- Anything that converts read access into write access on the Docker socket,
  which is root-equivalent on this box.
- Secrets committed to the repository.

**What is out of scope.**

- An attacker who already has a shell on the box, or an authorised tailnet
  device. Both are inside the trust boundary by construction.
- Plaintext HTTP on `*.dev.test`. This is deliberate — see
  [Accepted risks](#accepted-risks).
- Denial of service against a single-user development box.
- The disclosure surface the portal *intentionally* publishes to authenticated
  tailnet users: container names, images, ports, health, compose labels, volume
  names and disk sizes. That is home-directory-layout disclosure, judged
  acceptable on a personal tailnet — and **not** acceptable the moment `dev.test`
  reaches beyond one.

**If you fork this and expose it beyond a private tailnet, the model above stops
holding.** Plaintext cookies, `--cookie-secure=false`, an unauthenticated Traefik
dashboard and loopback-only databases were all chosen against the assumption that
the network itself is the outer perimeter.

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

**Please do not report:** the absence of TLS on `*.dev.test`, the sample
credentials in `.env.example`, or Traefik's dashboard being unauthenticated —
all three are documented decisions, below.

---

## Load-bearing design rules

Every rule here has a reason written next to it in the source. Changing one is a
security change, and should be reviewed as one.

### 1. Every dashboard sits behind oauth2-proxy SSO

`auth/compose.yml` runs [oauth2-proxy](https://github.com/oauth2-proxy/oauth2-proxy)
pinned to an exact version, because it is the authentication boundary.
`edge/dynamic/auth.yml` turns it into two Traefik middlewares:

- `sso` — a `forwardAuth` to `/oauth2/auth`; 202 passes, 401 means no session;
- `sso-errors` — an `errors` middleware that catches that 401 and serves the
  sign-in page in its place, at the URL the user actually asked for.

**Attach them in that order — `sso-errors@file,sso@file`.** The request passes
through `sso-errors` on the way in and the 401 travels back out through it. Get
the order wrong and a signed-out user receives a blank 401 with no way forward.

Every service that has no login of its own carries that middleware pair:
Prometheus (which accepts `POST /-/quit`), Dozzle (which serves every
container's logs), Kafka-UI (which runs with `DYNAMIC_CONFIG_ENABLED` and could
otherwise be used to mutate topic config), the Traefik dashboard (which exposes
`/api/rawdata`), the docs site, the portal, the portal's catch-all fallback
router, **and both portal API routers**. Portainer is behind it too even though
it has its own login, because it mounts the Docker socket read-write and its UI
exposes container environment variables and container `exec`.

Only one GitHub account is permitted, via `--github-user=`. Without that flag,
any GitHub user on earth who could reach the sign-in page would be let straight
through — `--email-domain=*` on its own authorises everyone.

The catch-all `PathPrefix(`/`)` fallback router is gated too. It is what answers
the bare host IP and any typo'd `*.test` name, so leaving it open would be a
hole in the shape of "every request that matched no other rule".

### 2. docker-socket-proxy: network reachability *is* authorisation

`apps/portal/compose.yml` runs `tecnativa/docker-socket-proxy` so that nginx
never has to touch `/var/run/docker.sock` — which is root-equivalent on this
box. Four properties keep that safe, and all four are load-bearing:

- **It has no authentication of any kind.** There is no token, no password.
  Anything that can open a TCP connection to it gets whatever the proxy permits.
  Therefore:
- **It lives on `socketnet`, not `devnet`.** `socketnet` holds exactly two
  containers — Traefik and the socket proxy. `devnet` holds around twenty,
  including third-party images (Wiki.js, Kafka-UI) that could simply `curl` it.
  The network *is* the access-control list; keep the blast radius at two.
  (`just network` creates both, with that reasoning inline.)
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
- **Regression test after any change to that file.** It must print `404` (a
  `401` is also a pass — it means the request fell through to the SSO fallback
  rather than to the socket proxy; either way it is not the container body):

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' \
    http://dev.test/-/api/docker/containers/$(docker ps -q | head -1)/json
  ```

- The API routers carry **no `Host()` rule** on purpose, so they work from the
  bare host IP as well as from every name. `/-/` is therefore a reserved prefix
  on every vhost on this box; do not mount anything else under it.
- The SSO middleware on those routers also closes the DNS-rebinding hole: a
  rebound request arrives with the attacker's `Host`, so the `.dev.test`-scoped
  session cookie is never sent and the router returns 401 instead of the
  container list.

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

If a credential is ever committed, treat it as compromised: rotate it first,
then rewrite history. Removing it in a follow-up commit is not a fix.

---

## Accepted risks

These are decisions, not oversights. They are listed here so that a reader can
judge them, and so nobody "fixes" one without understanding what it buys.

- **Plain HTTP on `*.dev.test`, and `--cookie-secure=false`.** TLS on internal
  `.test` names means a private CA installed on every device. The tailnet is
  already WireGuard, so the wire is encrypted regardless. A `Secure` cookie
  would never be sent back over `http://` and the login loop would never
  terminate. This is safe *only* because the tailnet is the transport — revisit
  the moment anything here is reachable from outside it. (GitHub is the SSO
  provider rather than Google for the same reason: Google rejects `http://`
  redirect URIs.)
- **`.test`, never `.dev`.** `.dev` is HSTS-preloaded; browsers force HTTPS and
  a plain-HTTP page never loads at all.
- **The Traefik API is exposed at four read-only paths under `/-/api/traefik/`**
  (routers, services, overview, version) behind SSO. The Traefik API is
  read-only by nature and the dashboard already serves it, so these paths grant
  no authority that was not already there.
- **The portal publishes an inventory of the box** to any authenticated tailnet
  user: names, images, ports, health, labels, volumes, disk sizes. Not `Env`.
- **Sample credentials in `.env.example` are weak on purpose** — they are
  placeholders for a local dev box, and the file says so.

---

## If you fork this

Nothing in this repo is safe to run with the values it ships with. Before your
first `just up`:

1. **Create your own `.env` from `.env.example`.** Never commit it; confirm
   `git check-ignore -v .env` prints the rule.
2. **Rotate the sample Postgres credentials.** `POSTGRES_PASSWORD=devpass` is a
   placeholder. Change `POSTGRES_USER`/`POSTGRES_DB` too if you like — they flow
   into the exporter's DSN automatically.
3. **Change the Grafana admin password** from the `admin`/`admin` sample, and
   set a real `WIKI_DB_PASSWORD` in place of `changeme`.
4. **Set up your own GitHub OAuth App** at
   <https://github.com/settings/developers>, callback
   `http://auth.dev.test/oauth2/callback`. Put the client ID and secret in
   `.env`, and generate a fresh cookie secret:
   ```sh
   openssl rand -base64 32 | tr -- '+/' '-_'
   ```
5. **Change `--github-user=` in `auth/compose.yml` to your own account.** If you
   leave it as the upstream value you have configured an SSO layer that admits
   somebody else and locks you out. Never delete the flag: `--email-domain=*`
   alone authorises every GitHub account in existence.
6. **Keep it on a private tailnet.** If you put this behind a public hostname,
   at minimum you need TLS, `--cookie-secure=true`, the portal's Docker API
   removed or re-reviewed, and the databases moved off any published port at
   all.
7. **Re-run the boundary test** after any change under `edge/dynamic/` —
   the `curl` in [rule 3](#3-the--api-routers-use-exact-path-never-pathprefix-this-is-the-control)
   must not return a container body.
8. **Do not commit real hostnames, tailnet IPs or account identifiers.** The
   `just urls` recipe reads them from `tailscale` at run time precisely so they
   never land in the repo. Keep it that way.
