# Security Policy

This repository is the configuration for a **personal, self-hosted development
box**: a set of Docker Compose stacks behind one Traefik reverse proxy, driven by
a `justfile`. It is published so the design can be read and reused, not because
it is a hardened product.

Most of what follows is not generic advice. Several choices in this repo look
like style and are actually the security boundary - a well-meaning
"simplification" of any of them turns a read-only status page into a credential
leak or a remote root shell. Those are listed under
[Load-bearing design rules](#load-bearing-design-rules). Read that section before
touching `edge/dynamic/bothy-api.yml`, `edge/dynamic/bothy-prom.yml`,
`apps/bothy/compose.socket-proxy.yml`, `apps/bothy-ops/compose.yml`,
`edge/dynamic/bothy-gates.yml`,
`edge/dynamic/auth.yml` or `auth/`.

---

## Threat model

**What this is.** One developer's workstation on a **private Tailscale
tailnet**. Services are reached at `tailnet-IP:port` (published host ports);
Traefik on `:80` serves the portal and its read-only data plane.

**The name layer and the SSO in front of it are gone, not dormant** (updated
2026-08-12). The name layer went dormant on 2026-08-08 when the split-DNS route
was removed, and its configuration was **deleted on 2026-08-12**: Traefik holds
zero `Host()` rules, and the Traefik dashboard router was deleted with them.
Identity was rebuilt on Keycloak + oauth2-proxy and **now enforces on the tiers
that can change things**: fourteen routers across three files carry a role
requirement - `viewer` to read a file or a config field, `editor` to write one,
`operator` to restart, stop or start a service or change a cluster workload.
Everything else is still reached
without passing an edge auth boundary, so "SSO is running" must not be read as
"everything is behind SSO".

**Who can reach it.** Only devices on that tailnet. The tailnet is WireGuard, so
the transport is encrypted even though every URL is plain `http://`. A device not
joined to the tailnet cannot route to the box at all; the Windows-host port
mirrors bind `127.0.0.1` + the host's tailnet IP only, so nothing is exposed to
the LAN or to the internet.

**The current control, stated plainly.** Four things stand between a tailnet
device and the box, and edge auth covers only the last of them:

| Control | Covers |
|---|---|
| The tailnet itself | Everything. It is the outer perimeter and, today, very nearly the only one |
| Each service's own login, using the shared `DEV_LOGIN_*` credential | Grafana, Prometheus |
| Keycloak roles at the edge (`forwardAuth`) | The tiers that change things: `viewer`/`editor` on the file and config routes (`edge/dynamic/bothy-files.yml`, `bothy-config.yml`), `operator`/`viewer` on container and cluster actions (`bothy-ops.yml`); the gates are defined in `bothy-gates.yml`. The only places a role is enforced today. `shell` is defined and gated on nothing |
| A dedicated `oauth2-proxy-headlamp` (Keycloak client `headlamp`, `--allowed-group=viewer`), in front of a ServiceAccount bound to the built-in `view` ClusterRole | Headlamp, the read-only cluster console on `:8110` (`apps/headlamp/compose.yml`). The proxy is the only published port; Headlamp itself has none. Every viewer is the same cluster identity, `bothy/bothy-browse`, which cannot read Secrets, exec, attach, port-forward or write anything (`k8s/rbac/bothy-browse.yaml`; `just headlamp-token` prints the can-i table). Verified live 2026-09-17: through a real login, Secrets, a dry-run ConfigMap create, `pods/exec` and `pods/portforward` all answered 403 from the apiserver |
| The exact `Path()` rules in `edge/dynamic/bothy-api.yml` and `bothy-prom.yml` | The portal's data plane - the only reachable slice of the Docker socket, Loki, Prometheus and the Traefik API |

The portal itself has **no** login for browsing its own pages. That is accepted,
not overlooked - but note the asymmetry that is *not* accepted and has been
closed: the file API underneath it requires `viewer` for every read and `editor`
for every write, because its roots cover the whole home directory.

**What is therefore in scope.**

- Anything reachable from the tailnet without authenticating (a dashboard that
  lost its login, or a router rule that matches more than it should).
- Anything that discloses a secret to a party who *has* authenticated - the
  container-`Env` leak described below is the canonical example.
- Anything that converts read access into write access on the Docker socket,
  which is root-equivalent on this box.
- Secrets committed to the repository.

**What is out of scope.**

- An attacker who already has a shell on the box, or an authorised tailnet
  device. Both are inside the trust boundary by construction.
- Plaintext HTTP. This is deliberate - see [Accepted risks](#accepted-risks).
- Denial of service against a single-user development box.
- The disclosure surface the portal *intentionally* publishes to any tailnet
  device: container names, images, ports, health, compose labels, volume names
  and disk sizes, plus every Prometheus metric and label value. That is
  home-directory-layout disclosure, judged acceptable on a personal tailnet -
  and **not** acceptable the moment the box reaches beyond one.
- The absence of edge authentication on the **dashboards** (Grafana, Prometheus).
  Each carries its own login; putting them behind the edge is
  planned, recorded under [Accepted risks](#accepted-risks) - not a finding. A
  *regression* on the editor tier, which is enforced, very much is one.

**If you fork this and expose it beyond a private tailnet, the model above stops
holding.** Plaintext HTTP, an unauthenticated portal and data plane, and
loopback-only databases were all chosen against the assumption that the network
itself is the outer perimeter.

---

## Reporting a vulnerability

Please report privately, **not** as a public issue.

Use **GitHub private security advisories** on this repository:
**Security → Advisories → Report a vulnerability**
(<https://github.com/YehudaBriskman/Bothy/security/advisories/new>).

Include:

- the file and line that is wrong (e.g. a router rule, a compose env var);
- what an attacker on the tailnet - or, if you believe the boundary can be
  crossed, off it - could obtain;
- ideally, the one-line `curl` that demonstrates it.

Expect an acknowledgement within about a week. This is a personal project run by
one maintainer, so there is no formal SLA and no bounty. Fixes land as ordinary
commits; a credited advisory is published for anything that would have leaked a
credential or granted socket access.

**Please do not report:** the absence of TLS, the sample credentials in
`.env.example`, or the fact that the dashboards sit behind their own logins rather
than the edge - all three are documented decisions, below. Traefik's unauthenticated dashboard was a
real finding and **was fixed on 2026-08-12** by deleting the router; a report
that it is still exposed is out of date, and a report that it has *returned* is
very much wanted.

---

## Load-bearing design rules

Every rule here has a reason written next to it in the source. Changing one is a
security change, and should be reviewed as one.

### 1. SSO enforces on the tiers that change things, and nowhere else yet

> **Status: ENFORCED, narrowly.** Fourteen role-gated routers, in three files
> (counted 2026-09 from `edge/dynamic/*.yml`):
> `edge/dynamic/bothy-files.yml` (four: `viewer` for reads and downloads,
> `editor` for writes and deletes), `bothy-config.yml` (two: the same pair over
> config fields) and `bothy-ops.yml` (eight: `operator` on the three container
> verbs and the three cluster changes, `viewer` on cluster events and logs). The
> gates themselves - `sso-viewer`, `sso-editor`, `sso-operator` - are defined
> once, in `edge/dynamic/bothy-gates.yml`, and in no router file. The fourth role,
> `shell`, is defined in the realm and referenced by no router at all - see
> [A shell in the browser](#a-shell-in-the-browser-90-before-it-exists).
> Every *other* service is still reachable from the tailnet without passing an
> auth boundary; their control is each dashboard's native login with the shared
> `DEV_LOGIN_*` credential, plus the tailnet itself. Do not widen that gap without
> widening this section.

**What happened.** The original design was oauth2-proxy against GitHub, with the
OAuth callback pinned to `http://<service>.<base-domain>/oauth2/callback`. When the name
layer went dormant on 2026-08-08 the callback stopped resolving and the whole
flow broke - an authentication layer with a single-point dependency on a DNS
setting. On 2026-08-12 identity moved to a **local Keycloak** (`auth/compose.yml`,
host port `8090`) so the callback is an IP:port URL and depends on no name.

`edge/dynamic/auth.yml` defines two Traefik middlewares:

- `sso` - a `forwardAuth` to `/oauth2/auth`; 202 passes, 401 means no session;
- `sso-errors` - an `errors` middleware that catches that 401 and serves the
  sign-in page in its place, at the URL the user actually asked for.

**Defining a middleware does not enforce it** - that takes a router referencing
it, which is the distinction this section existed to make while nothing did.
Fourteen routers do now, across three files - `edge/dynamic/bothy-files.yml`
(four), `bothy-config.yml` (two) and `bothy-ops.yml` (eight) - using
`sso-viewer`, `sso-editor` and `sso-operator`: the same `forwardAuth`, differing
only in `?allowed_groups=`. (The statement this replaces said "nine routers
across three files" and went stale the day the cluster tier added five more in a
fourth file.) Since 2026-09 all three gates live in
`edge/dynamic/bothy-gates.yml`: before that each was defined inside the first
tier file that needed it and borrowed by the others, so deleting one tier file
would have errored another tier's routers. The auth stack also owns `oauth2-endpoints`
(`PathPrefix(/oauth2/)`, priority 100, host-less), so the login flow and its
callback are reachable at all - oauth2-proxy publishes no host port.

Verified with a role the user does **not** hold: `allowed_groups=editor` → 202,
`allowed_groups=shell` → 403, `allowed_groups=<junk>` → 403. It fails closed, and
`just files-check` re-runs that probe.

**Why it is being rolled out one router at a time, not all at once.** Attaching
auth is the step that can lock you out of the box, and the tools you would use to
unlock it - the portal, Grafana - are exactly what you would have just
put behind the broken login. Worse, `sso` **fails closed**: if oauth2-proxy is
down, every router carrying it returns 500 to everyone. That is correct for an
auth boundary and it is precisely why you do not attach it to the thing you need
in order to fix it. Verify the flow end to end against one low-stakes router
first.

**When attaching them, order matters - `sso-errors@file,sso@file`.** The request
passes through `sso-errors` on the way in and the 401 travels back out through
it. Get the order wrong and a signed-out user receives a blank 401 with no way
forward.

**What still needs it, in rough priority order:** Prometheus first (it accepts
`POST /-/quit`), then the portal and its data-plane routers, and the catch-all fallback router -
that last one because it answers every request matching no other rule, so leaving
it open is a hole in exactly that shape.

The editor tier is the proof that the mechanism works: `sso-viewer` and
`sso-editor` are one word apart in the middleware, and extending the pattern to
anything above is YAML, not new infrastructure.

**A trap that already cost a session (2026-08-12).** Traefik renders every file
in `edge/dynamic/` as a **Go template before parsing the YAML, and does not skip
comments**. A doubled brace anywhere in one of those files - including inside a
comment, such as a `docker inspect -f` format string - is evaluated as a template
action, fails, and silently takes out the **whole file**: no routers, no
middlewares, while the file on disk looks perfect. Keep doubled braces out of
`edge/dynamic/` entirely.

### 2. docker-socket-proxy: network reachability *is* authorisation

`apps/bothy/compose.socket-proxy.yml` runs `tecnativa/docker-socket-proxy` twice so that
nothing else - not nginx, not bothy-ops - ever touches `/var/run/docker.sock`,
which is root-equivalent on this box. **Only the proxies hold the socket, and
read and write are split:** `bothy-socket-read` (`CONTAINERS=1 SYSTEM=1
POST=0`) and `bothy-socket-write` (`CONTAINERS=0 POST=1`, only restart/start/stop
via `ALLOW_*`). No proxy may hold `POST=1` with `CONTAINERS=1` - that pair grants
`/containers/create`. Five properties keep this safe, and all are load-bearing:

- **They have no authentication of any kind.** There is no token, no password.
  Anything that can open a TCP connection to one gets whatever it permits.
  Therefore:
- **Neither lives on `devnet`.** `socketnet` holds exactly two containers -
  Traefik and `bothy-socket-read`. `controlsocknet` holds `bothy-ops` and both
  proxies, and Traefik is not on it, so the edge cannot reach the write proxy.
  `devnet` holds around twenty,
  including third-party images (Keycloak, Grafana, project images) that could
  simply `curl` it. The network *is* the access-control list. (`just network`
  creates them, with that reasoning inline.)
- **`POST: 0` on the read proxy.** Without it, `CONTAINERS=1` also grants
  `/containers/{id}/kill|stop|restart`, and `SYSTEM=1` would grant every
  mutating `/system` call. Every other endpoint family is explicitly `0` - the
  image denies by default, but a socket proxy is the last place to trust a
  default surviving an image bump, so each one is written out. `EXEC: 0` in
  particular: container exec is root on this box.
- **`CONTAINERS: 0` on the write proxy.** With `POST=1`, that is the only thing
  refusing `/containers/create`; the three verbs pass on their own `ALLOW_*`
  rules. `kill` rides in on `ALLOW_RESTARTS` and is refused by
  `apps/bothy-ops/guard.py`'s `VERBS`. `apps/bothy-ops/checks/grants.py` asserts
  all of this statically and sweeps every compose file in the repo for the
  dangerous pair.
- **The image is pinned to an exact tag, never `:latest`,** and it publishes
  **no `ports:`** - ever. It must not be reachable from the host network.

The socket is mounted `:ro`. That is the second lock, not the first: the proxy
is the real boundary, but a writable socket would leave `POST: 0` as the *only*
thing standing between the tailnet and root.

Because the proxy is not on `devnet`, Traefik's Docker provider cannot see it -
which is exactly why its service is declared in the file provider
(`edge/dynamic/bothy-api.yml`, `http://bothy-socket-read:2375`) rather than by
container labels.

**The same rule for every Bothy backend, and the table it produces.** None of
the services authenticates anybody - authorisation is the role gate at the edge
- so each one's inbound network holds Traefik and that service only.
Consolidated from eight containers to five on 2026-09; the boundaries above were
kept, not merged away:

| Container | Inbound (who can reach it) | Outbound | Power |
|---|---|---|---|
| `bothy-web` | `devnet` (Traefik's catch-all) | - | none: static nginx |
| `bothy-files` | `filesnet` (Traefik only) | - | read-write on the stack repo and the notes, read-only on `$HOME` and `~/projects`; the config forms (`/-/api/config/*`) since 2026-09 |
| `bothy-ops` | `opsnet` (Traefik only) | `controlsocknet`; `thales-scc` only via `apps/bothy-ops/compose.cluster.yml` | container restart/stop/start through the proxies; five cluster actions with a namespaced token |
| `bothy-socket-read` | `socketnet` (Traefik), `controlsocknet` (bothy-ops) | the docker socket, `:ro` | `CONTAINERS=1 SYSTEM=1 POST=0` |
| `bothy-socket-write` | `controlsocknet` (bothy-ops only) | the docker socket, `:ro` | `CONTAINERS=0 POST=1`, three verbs (plus `kill`, refused in code) |

**The dependency doctrine, relaxed once and on purpose.** Every backend was
standard-library-only, on the argument that a process holding write mounts, a
socket path or a token should not import code that can ship a vulnerability into
that position. `bothy-ops` and `apps/bothy-common` still are. **`bothy-files` is
not, since 2026-09:** merging the config forms in brought `ruamel.yaml` with them
(`apps/bothy-files/requirements.txt`) - pinned exactly, pure Python with no C
accelerator, installed `--only-binary`, and imported only by `yamlpatch.py` on the
config-form path, which `safepath.resolve_config()` narrows to YAML files in one
root. The trade was one container, one network and one copy of `safepath.py`
instead of a drifting derivative; it is a deliberate relaxation, and the next
dependency proposed for `bothy-files` has to make its own case rather than cite
this one.

### 3. The `/-/api/*` routers use exact `Path()`. Never `PathPrefix()`. This is THE control.

**`CONTAINERS=1` does not mean "only `/containers/json`".** docker-socket-proxy
gates by endpoint *family*, so it will happily serve `/containers/{id}/json` -
and **that response body contains `Env`**. On this box that is the Postgres
password and the Grafana admin password, verified by reading them out of it.

The socket-proxy environment variables **do not** prevent this. The only thing
that prevents it is that every rule in `edge/dynamic/bothy-api.yml` is an
**exact `Path()`**. There are exactly two Docker paths routed:

```
Path(`/-/api/docker/containers/json`) || Path(`/-/api/docker/system/df`)
```

A single `PathPrefix` there would publish every container's environment -
i.e. every password on the box - to anyone who can sign in.

Rules that follow from this:

- **Never widen an API router to `PathPrefix`.** This is the credential leak.
- **Add a Docker endpoint only as a new exact `Path()`**, and only after
  confirming its response body carries no `Env`. That check *is* the whole
  review. (`/system/df` passed it: it returns the same categories already
  exposed by `/containers/json` - names, images, labels, command, mounts - plus
  size numbers, and no `Env`. Only `/system/df` is routed, so `/system/info`,
  `/system/events` and the rest stay unreachable through the edge even with the
  family enabled.)
- **Regression test after any change to that file - assert the content type,
  never the status code.** Rewritten 2026-08-12. The old form asserted `404`,
  and that assertion can no longer fail: the portal's catch-all
  `PathPrefix(`/`)` router at priority 1 answers every unrouted path with the
  SPA, so a blocked endpoint returns **200 `text/html`**. A leak and a block are
  indistinguishable by status. Both lines below were verified on 2026-08-12:

  ```sh
  BOX=127.0.0.1                       # or the tailnet IP - there is no name
  CID=$(docker ps -q | head -1)

  # BLOCKED - must print text/html (the portal SPA, not a container body)
  curl -s -o /dev/null -w '%{content_type}\n' \
    http://$BOX/-/api/docker/containers/$CID/json

  # ALLOWED - must print application/json
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
  the attacker's `Host` and so never receives the `.<base-domain>`-scoped session
  cookie. That reasoning is void as of 2026-08-12: there is no name, no
  name-scoped cookie, and no name left to rebind - only an IP. Nor is the portal's
  data plane role-gated the way the editor tier is: the exact `Path()` rules are
  its entire control, alone, and should be reviewed as if they were the only line
  of defence, because they are.
- **The Traefik API is reachable only through four exact paths, and that now
  matters more than it did.** The dashboard router that served the whole of
  `api@internal` was deleted on 2026-08-12 - see
  [Accepted risks](#accepted-risks) for what it leaked. Never route
  `/api/rawdata`.

Host bind paths and container `Command` (argv) are deliberately **not** rendered
by the portal even though they are present in the payload - home-directory and
argv disclosure with no UI payoff. Named volumes *are* surfaced, on purpose, for
the disk panel.

### 4. Databases publish on loopback only

`data/postgres` binds its host port to
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

- `.env` is in `.gitignore`, first entry, under the comment *"Secrets - never
  commit real credentials"*. So are `backups/`, `*.rdb`, `*.sql`, `*.sql.gz`.
- `.env.example` carries **placeholders only** and is the file that gets
  committed. The OAuth entries are blank; `WIKI_DB_PASSWORD` is a literal
  `changeme` that `just up` refuses to start without.
- Compose files reference secrets as `${VAR}` and use `${VAR:?message}` for the
  ones that must never fall back to a default - the three oauth2-proxy values do
  exactly that, so a missing client secret aborts the stack instead of silently
  starting an auth layer with no credentials.
- **Always use `just`, not `docker compose` directly.** `just` loads the root
  `.env` via `set dotenv-load`; `docker compose` looks for a `.env` beside the
  compose file it was handed, finds none, and silently falls back to the
  insecure defaults.
- Do not add a secret to a `command:` array - argv is visible in
  `/containers/json`-adjacent surfaces and in `ps`. Use `environment:` with a
  `${VAR}` reference.
- **A secret that has to live in an edge config file is generated, never
  committed.** `edge/dynamic/bothy-prom.yml` carries a basic-auth header for
  Prometheus, so it is written from the environment by
  `scripts/gen-bothy-prom-route.sh` (`just bothy-prom-route`), gitignored, and
  a **comments-only** example is committed beside it. Two things were learned
  the hard way, both recorded 2026-08-12:
  - The first version of that example was *live YAML* declaring the same router
    and middleware names as the real file. Traefik's file provider merges every
    file in the directory, so the example overwrote the real credential with its
    placeholder - every query returned 401 while the router still reported
    `enabled`. An example in a watched directory must be comments only.
  - A `customRequestHeaders` middleware is rendered verbatim by Traefik's
    `/api/rawdata`. The dashboard router that served it was deleted for exactly
    this reason. Never route a Traefik API path that echoes middleware config.

If a credential is ever committed, treat it as compromised: rotate it first,
then rewrite history. Removing it in a follow-up commit is not a fix.

### 6. The cluster tier (in `bothy-ops`) is three locks, and the innermost is the cluster's

`apps/bothy-ops` (the `kube.py` half; `bothy-kube` was its own container until
2026-09) gives the web UI an OpenShift-console subset on the local Kubernetes
cluster, only in the namespaces `thales-dev` and `thales-pre-prod`, and backs the
Cluster page (`/control/cluster`). Since 2026-09-17 that is 29 actions:

| Group | Reads (`viewer`) | Changes (`operator`, confirm) |
|---|---|---|
| Deployments | `deployments`, `rollout-status`, `rollout-history`, `events`, `logs` (tail <= 500, `previous`, `container`, SSE follow <= 300 s) | `rollout-restart` (click), `pause`/`resume` (click), `scale` 0..3 (type-name), `set-image` (type-name), `rollback-to-revision` (type-name) |
| Pods | `pods` (namespace or one deployment) | `delete-pod` (click), `delete-completed-pods` (click) |
| Jobs | `jobs`, `job-logs` | `delete-job` (click), `run-template` (type-name) |
| ConfigMap `thales` | `configmap` | `patch-key`, `patch-key-and-restart` (type the KEY) |
| Views | `services`, `routes`, `ingresses`, `persistentvolumeclaims`, `networkpolicies`, `resourcequotas`, `limitranges`, `namespace-events` (polled) | - |

It is built so that any one lock failing still leaves the other two:

| Lock | What it enforces | Where |
|---|---|---|
| **Edge** | One exact `Path()` per action plus one for `GET /-/api/kube/catalog` - no `PathPrefix`, no `Host()`. Reads behind `sso-viewer`, changes behind `sso-operator` (both defined in `bothy-gates.yml`). Client `X-Auth-Request-*` stripped. | `edge/dynamic/bothy-ops.yml` (`bothy-ops-kube-*`, generated) |
| **Service** | Catalog ids must map 1:1 to hard-coded handlers, and every catalog job template must be in the image, or the service **refuses to start**. Namespace enum; RFC 1123 names (`fullmatch`, no dots, no slashes); declared params with bounds; `image` params must be an OCI reference with a tag or digest **and** start with `thales/` or `localhost:5000/thales/` (a rollback may not restore what set-image would refuse); ConfigMap actions name only `thales`, change only `LOG_LEVEL`, `DB_POOL_MAX`, `JOB_MAX_WORKERS`, each value fullmatching its own pattern; `run-template` names one of `migrate`, `seed-identity`, `seed-reference` and the Job body is a file baked into the image - a request that carries a body or an image is refused; `delete-pod` only deletes a pod whose controller chain (walked on the apiserver, by uid) ends at a Deployment or a Job; `type-name` checked server-side; JSON-only POST; cross-site `Sec-Fetch-Site` refused; one TSV audit line per request, including refusals. | `apps/bothy-ops/{guard.py,catalog.toml,kube.py}`, `k8s/job-templates/`, `apps/bothy-common/bothy_common/{http,names,audit}.py` |
| **Cluster** | ServiceAccount `bothy/bothy-kube` with a Role in **each target namespace only**, **generated** from the `rbac` each action declares: deployments get/list/patch, deployments/scale get/patch, replicasets get/list, pods get/list/delete, pods/log get, jobs get/list/create/delete, configmaps get/patch **by resourceNames `thales` only**, and list on events, services, routes, ingresses, persistentvolumeclaims, networkpolicies, resourcequotas, limitranges. **No** pods/exec, pods/attach, pods/portforward, secrets, watch, update, deletecollection, escalate, bind, impersonate, wildcard, namespace, or ClusterRole. | `k8s/rbac/bothy-kube.yaml` |

**One hand-written file.** `apps/bothy-ops/catalog.toml` is the only place the
actions, their roles, their params, the allowlists and the grants are written.
`scripts/gen-ops-wiring.py` (`just ops-wiring`) generates the edge routers, the
Role, the `just kube-token` can-i rows and the UI's dev catalog from it, and
`guard.load_catalog` refuses - before anything is generated - an `rbac`
declaration of secrets, exec, attach, portforward, watch, escalate, bind,
impersonate, a wildcard, a namespace, `create` on anything but jobs, `delete` on
anything but pods and jobs, or `patch` on anything but deployments(/scale) and
configmaps. `checks/wiring.py` re-runs the generator and fails on drift, and
asserts the same refusals on the generated Role itself; CI runs `--check`. The UI
no longer carries a copy: it reads `GET /-/api/kube/catalog`.
`checks/api_kube.py` drives the real handlers against a stand-in apiserver over
real TLS that counts requests, so every refusal is shown to reach nothing.

**What lock 3 alone leaves, stated plainly.** Before 2026-09-17 a total
compromise of this process yielded restart, scale and logs. It now yields: patch
any deployment's pod template (image included) and create Jobs, in two dev
namespaces. **That is the power to run code there**, with whatever those
namespaces' pods can reach - including the `thales` Secret, which the Thales pods
and the templated Jobs mount as files. The registry, key and template allowlists
are lock 2 only; the Role cannot express "only this image". What lock 3 still
guarantees: no shell from a browser (no exec, attach, portforward), no Secret
value through the API (no secrets verb at all, and the Job pods get no
service-account token), no ConfigMap but `thales`, no RBAC change, nothing
outside the two namespaces and nothing cluster-scoped. `deployments: patch` was
already granted before (rollout-restart), so the widening is `jobs: create`,
`configmaps: patch` and what the service now chooses to send.

**The cluster is optional, and its absence is a 503, not an outage.** minikube's
`thales-scc` network and the token mount live in
`apps/bothy-ops/compose.cluster.yml`, which `just up-apps` adds only when that
network exists (`just up-kube` is gone). Declared in `compose.yml` itself, a
missing external network would fail the whole `bothy` project - the file editor
and container actions with it. Without the overlay, or with the apiserver down or
the token absent, every kube verb answers **503 "cluster unavailable"**; no
request is sent anywhere, `/healthz` never calls the apiserver, and the container
half is unaffected. (`GET /-/api/kube/catalog` still answers: it is static data
from the image.) A TLS verification failure is deliberately NOT folded into
that 503: something answered that is not the apiserver the token was issued for,
and that is a 502.

**The credential.** A long-lived ServiceAccount token Secret
(`bothy/bothy-kube-token`), written by `just kube-token` to
`apps/bothy-ops/secrets/` (mode 600 inside a 700 directory, gitignored, and
outside the image build context by `apps/.dockerignore`'s allowlist) and mounted
read-only by the overlay. The in-cluster identity keeps the name
`bothy/bothy-kube`: renaming it with the container would have revoked a live
token to re-issue identical grants under a new name. It is long-lived rather than a bound `kubectl create token
--duration` token because this box runs unattended: an expiry nobody is watching
fails silently, and a Secret token can be revoked exactly and at once
(`just kube-token --revoke`, or `--rotate`). The trade is that a leaked copy
stays valid until someone rotates it. What it can do is bounded by the Role, not
by its lifetime.

**The networks.** `opsnet` holds traefik and bothy-ops and nothing else (the
way in; it replaced `kubenet` and `controlnet` in 2026-09). `thales-scc` is
minikube's own network (the way out, to `https://192.168.49.2:8443`, TLS verified
against the cluster CA). Traefik is **not** on `thales-scc`, nor on
`controlsocknet`. There is no published port.

**The deletes.** `pods: delete` can delete a running pod. `delete-completed-pods`
only deletes pods the apiserver lists with `status.phase=Succeeded`, re-checks
the phase per pod, and sends a UID precondition. `delete-pod` deletes one pod
only after walking pod -> ReplicaSet -> Deployment (or pod -> Job) on the
apiserver and matching uids at each step, with a UID precondition - a bare pod,
a StatefulSet's pod, or a pod whose owner reference lies is refused. A controller
recreates what either deletes, so the worst case is a restart. `delete-job` uses
`propagationPolicy: Background` and a UID precondition.

**Verified against the live cluster, 2026-09-17** (the generated Role applied,
a throwaway bothy-ops built from the branch on `thales-scc` with the live token,
driven from a second throwaway container): rollout-history, rollback of
`thales-dev/frontend` to the previous revision and back (pods Ready each time),
pause/resume, set-image to the same image, delete-pod on the frontend pod (a new
Ready pod in 8 s), run-template `migrate` (Complete, its logs, then delete-job),
patch-key `LOG_LEVEL` to its current value, and every view. Refused before
reaching the cluster: `kube-system`, an action named `secrets`, ConfigMaps other
than `thales`, the key `DEMO_LOGINS`, `LOG_LEVEL=trace`, an image from
`docker.io`, a template named `../migrate` or `seed-scenario`, and `exec`. The
can-i table (101 rows) matched: every granted verb yes; exec, attach and
portforward (as real `--subresource` probes), secrets, watch, `create namespaces`,
escalate, bind and impersonate no.

**A trap in the verification itself.** `kubectl auth can-i get pods/exec` does
NOT ask about the exec subresource: it reads `TYPE/NAME` and asks about a pod
*named* `exec`, so it answers `yes` for any account that may get pods. The old
hand-written rows (`create pods/exec`, `get pods/log`, `patch
deployments.apps/scale`) passed without asking what they printed. The generated
rows pass `--subresource`; `scripts/gen-headlamp-token.sh` had the same bug and
was fixed with it.

To repeat it: `just kube-token` applies the Role and prints the can-i table (it
exits non-zero if any row is unexpected), `just ops-wiring check` proves the
generated files match the catalog, and `apps/bothy-ops/checks/run.sh --offline`
(`just ops-check offline`) runs the offline suite.

### 7. The Settings admin reads (in `bothy-ops`) disclose metadata, never a secret

Added 2026-09-17 with Settings v2 (`docs/plans/settings-v2.md`). Four exact
`Path() && Method(GET)` routers in the hand-written `edge/dynamic/bothy-admin.yml`,
all behind `sso-operator` - not `viewer`, because each says more than reading the
box needs: `/-/api/admin/users`, `/credentials`, `/backups` and `/audit`. Every
request, refusals included, is a line in `apps/bothy-ops/audit/admin.log`.

- **Users** come from Keycloak's admin REST API through the confidential client
  `bothy-admin` (`scripts/keycloak-admin-client.sh`, `just admin-client`), whose
  service account holds realm-management **`view-users` only** - the script removes
  any other realm-management role it finds. Not `view-clients`: that can read every
  client secret in the realm. Not `manage-users`: there are no user writes. Its
  secret is a file in `apps/bothy-ops/secrets/` (denied to Files), mounted only by
  `apps/bothy-ops/compose.admin.yml`. Keycloak is reached at `http://BOX_IP:8090`,
  the address oauth2-proxy already uses, because Keycloak lives on `devnet` and
  bothy-ops must not (rule 2). Every field is copied into an allow-listed shape;
  credential entries keep `type` and `createdDate` only. Verified live: the token
  gets 200 on `/users` and 403 on `/clients`, `/roles` and `POST /users`.
- **Credentials and backups are computed on the host**, not in the container.
  `apps/bothy-ops/inventory.py` (a systemd timer, `host/systemd/bothy-inventory.*`)
  reads `.env` to learn only key names, "is it set" and "is it a public
  placeholder", stats the credential files and `~/backups`, and writes
  metadata-only JSON, mode 600, to `~/.local/state/bothy/inventory/`. bothy-ops
  mounts that directory read-only and re-filters every row to an allow-list. `.env`
  and `~/backups` are never mounted into a container, so bothy-ops - which can
  already stop the databases - does not also hold every password.
  `checks/test_inventory.py` feeds a `.env` of sentinel values and asserts no
  8-byte piece of one reaches the file or the response, including after a
  generator adds a `value` field. Verified live against the real `.env`: zero hits
  for every credential value in all six responses.
- **Audit** reads bothy-files' `writes.log` and `patches.log` from a read-only
  mount; bothy-files stays their only writer.

Rotation from the interface is not built: the page shows the command. User writes
(role grants, password resets) are not built either; they need their own
operator routes, a type-the-name confirmation and a `manage-users` client first.

### 8. Updates: the browser asks, the host decides, and only for what `main` pins

Added 2026-09-19 (build steps 3, 4 and 7 of `docs/plans/updates.md`). Five exact
`Path() && Method()` routers in the hand-written `edge/dynamic/bothy-updates.yml`
(kept out of the generated `bothy-ops.yml`): `GET /-/api/updates/status`, `/plan`
and `/job` behind `sso-viewer`, and `POST /-/api/updates/request` and
`POST /-/api/updates/unpause` behind **`sso-operator`**. Every request, refusals included, is a line in
`apps/bothy-ops/audit/admin.log`.

- **Discovery and plans run on the host**, not in a container:
  `apps/bothy-ops/discover_updates.py` (a systemd timer,
  `host/systemd/bothy-updates-discover.*`, every 6 h). It reads the pins from the
  repo, runs `docker inspect`, `kubectl get` and `helm list` (all read-only), and
  asks the public registries with **anonymous** pull tokens, GitHub's releases
  API unauthenticated and the helm index. It holds no credential and pulls
  nothing. It writes `~/.local/state/bothy/updates/available.json` and one
  `plans/<component>.json` per component (600 in 700), which bothy-ops mounts
  **read-only** and re-filters to an allow-list, and a node-exporter textfile
  (`~/.local/state/bothy/textfile`, 755/644 because node-exporter runs as
  `nobody`, mounted read-only on a dedicated directory).
- **Applying is SECURITY.md "shape 3", reached through "shape 1".** The request
  route makes bothy-ops write ONE file into `~/.local/state/bothy/updates/spool`
  - its only read-write mount besides its audit dir (`checks/wiring_updates.py`
  asserts both) - and answer 202. It runs nothing. The host's
  `bothy-updater.path` starts `bothy-updater.service` (devssh, oneshot,
  `NoNewPrivileges`), which takes a global `flock` and treats the spool as
  hostile: only a regular `<32 hex>.json` of at most 4 KiB, opened
  `O_NOFOLLOW`, with an exact key set; anything else is removed; a request is
  unlinked before it runs (at most once). It then **re-validates against
  `updates.toml` and a plan it recomputes itself**, and refuses unless the plan id
  matches. Every command is a fixed argv list; nothing from the request reaches
  one except as a catalog lookup key.
- **What a total compromise of bothy-ops can make the host do** - the honest
  statement, since devssh is in the `docker` group and so root-equivalent over
  Docker whatever runs as it: for a component of class `stateless` or
  `timeseries` in `updates.toml`, **deploy the image the checked-out `main`
  already pins** - reviewed, merged and on `origin/main` - which `just up` would
  deploy anyway, at a moment of its choosing, and only through the same
  pre-flight (fresh backup, disk, health and canaries green, the recipe touching
  nothing else). It cannot choose a version, an image, a file, a recipe or a
  command: the plan id is a hash the host computed from files the host reads. Its
  remaining levers are timing (a Loki snapshot stops Loki for seconds), disk (a
  pre-update snapshot, kept 3 per component, behind a free-space check) and
  noise (a refused request is a history line). It can edit none of the records:
  `status.json`, `history.jsonl` and the executor's `audit.log` sit in the
  directory it mounts read-only.
- **The one write to the tree** is a rollback's: the old image goes back on the
  pin line, a single-line edit that aborts unless the line still reads exactly
  what the plan recorded, left uncommitted so the next `just up` keeps the
  working version.
- **The policy is code, not catalog.** `updates.load_catalog()` refuses `auto` on
  a one-way component, on the auth boundary, and on any class outside
  `AUTO_CLASSES` (stateless, time-series); `effective_channel()` makes a minor of
  an auto component `notify` and any major `manual`. The updater's own classes
  (`updater/classes.py`) are a separate, code-reviewed list: one-way classes,
  the boundary, own code and the cluster are refused at plan time.
- **The automatic channel (step 7) is a host timer, not a new power.**
  `bothy-updater-auto.timer` (03:30, `Persistent=false`) runs
  `updater/auto.py` as devssh on the host. Inside the `[policy]` window, after
  tonight's `stacks-backup.service` succeeded (unit result AND a fresh dump), it
  writes at most ONE request a night into the spool - the exact schema bothy-ops
  writes, with the actor `auto`, for an `auto`-channel component's **patch** plan
  - and the unchanged executor re-validates it like any other. bothy-ops refuses
  to write the actor `auto` itself (403), so the name in every record is the
  system's only when the system wrote it. A `rolled_back` or `failed` job pauses
  auto for that component in `~/.local/state/bothy/updates/auto.json` (600, in
  the directory bothy-ops mounts read-only): bothy-ops can SHOW a pause and
  cannot clear one. `POST /-/api/updates/unpause` (operator, audited) only drops
  `unpause-<id>.json` into the spool - an exact key set, the actor never `auto`,
  read `O_NOFOLLOW` - and the executor's loop clears the pause itself. The worst a
  compromised bothy-ops gains from this route is lifting a pause, after which the
  night job is still held to the window, the backup, doctor, one a night and the
  executor's whole pre-flight; `just update-unpause` is the shell path.

---

## Accepted risks

These are decisions, not oversights. They are listed here so that a reader can
judge them, and so nobody "fixes" one without understanding what it buys.

- **No authentication at the edge for anything that only reads.** SSO is
  attached to the file, config and control tiers and to nothing else. The
  tailnet plus each service's own `DEV_LOGIN_*` login are the remaining
  controls; the portal's own pages, the docs site and the read-only `/-/api/*`
  data plane have neither. This is a *time-boxed* state, not a permanent design
  - it is listed here so it is judged rather than discovered, and the rollout
  order is in [rule 1](#1-sso-enforces-on-the-tiers-that-change-things-and-nowhere-else-yet).
- **Plain HTTP everywhere.** TLS would mean a private CA installed on every
  device. The tailnet is already WireGuard, so the wire is encrypted regardless.
  Safe *only* because the tailnet is the transport - revisit the moment anything
  here is reachable from outside it. Under the name layer this also forced
  `--cookie-secure=false` and GitHub-over-Google as the SSO provider (Google
  rejects `http://` redirect URIs); with an IP:port callback, the plain-HTTP
  constraint still applies to whatever identity provider replaces it.
- **The Traefik API is exposed at four read-only paths under `/-/api/traefik/`**
  (routers, services, overview, version), unauthenticated. The old justification
  - "the dashboard already serves it" - no longer holds, because the dashboard
  is gone; these four paths are now the only reachable slice, which is the
  point. They return route and service names, no credential.
- **`.test`, never `.dev`** - kept as a rule for any future name layer. `.dev`
  is HSTS-preloaded; browsers force HTTPS and a plain-HTTP page never loads at
  all. Nothing on the box relies on a name today.
- **The portal publishes an inventory of the box** to any tailnet device: names,
  images, ports, health, labels, volumes, disk sizes, and every Prometheus
  metric and label value. Not `Env`, and not the metrics credential.
- **Sample credentials in `.env.example` are weak on purpose** - they are
  placeholders for a local dev box, and the file says so.

### Fixed, not accepted

Recorded 2026-08-12 so nobody re-files it and nobody reintroduces it.

| Was | Why it was a real finding | Fix |
|---|---|---|
| The Traefik dashboard router served `api@internal` unauthenticated | `/api/rawdata` renders middleware configuration verbatim, including the live `Authorization: Basic` header that `bothy-prom.yml`'s `customRequestHeaders` middleware injects. A read-only dashboard was handing out a credential | Router deleted; `--api.dashboard=true` became `--api=true`. `api@internal` survives only as the backend for four exact `Path()` rules |

---

## A shell in the browser (#90), before it exists

Issue #90 asks for a terminal in the portal. **None of it is built.** This
section is written first, on its own, so that a change to the boundary can be
read and argued with before any capability exists to point at as already done -
the ordering `docs/plans/all-open-issues.md` §C3 asks for.

### What the boundary is today

Two socket proxies run here (three until 2026-09, when the portal's read-only
proxy and bothy-control's read proxy merged into `bothy-socket-read`), both in
`apps/bothy/compose.socket-proxy.yml`, and neither can exec:

| Proxy | Grants | Refuses |
|---|---|---|
| `bothy-socket-read` (`:104`) | `CONTAINERS: 1` (`:107`), `SYSTEM: 1` (`:108`) | `POST: 0` (`:113`), `EXEC: 0` (`:114`), and every other family written out as `0` |
| `bothy-socket-write` (`:162`) | `POST: 1` (`:165`), `ALLOW_RESTARTS`/`ALLOW_START`/`ALLOW_STOP` `1` | `CONTAINERS: 0` (`:172`), `EXEC: 0` (`:173`) |

The read/write split is the one the merge deliberately kept: no proxy holds
`POST: 1` with `CONTAINERS: 1`. `EXEC: 0` appears on both, stated rather than left
to a default, each with the comment *"container exec == root on this box"*.
`apps/bothy-ops/checks/grants.py` asserts that the variable is written down at
all and that its value is `0`, and sweeps every compose file in the repo for a
proxy holding the dangerous pair. `apps/bothy-ops/control.py`'s header lists exec
first among what it *"deliberately cannot do"*, and names the replacement:
*"`docker exec` over Tailscale SSH"*. `just urls` prints the same sentence.

Above the proxies, the verb set is a three-element tuple:
`apps/bothy-ops/guard.py:61` - `VERBS = ("restart", "stop", "start")`.
`kill` is absent, and `checks/grants.py:218` asserts it stays absent, because
the write proxy's `ALLOW_RESTARTS` regex grants `kill` alongside `stop` and
`restart` and no configuration can separate them. `guard.SEVERING`
(`guard.py:119`) refuses those verbs by container *name* for the four containers
on the request path - Traefik, `bothy-ops`, `bothy-socket-read` and
`bothy-socket-write` - and `checks/grants.py:207` asserts
`len(guard.SEVERING) == 4`, so that list cannot quietly grow or shrink.

Container names are checked with `fullmatch` (`apps/bothy-common/bothy_common/names.py`).
Until 2026-09 `bothy-control`'s guard used `^...$` with `.match()`, and Python's
`$` matches before a trailing newline, so `"grafana\n"` passed the name rule. The
audit writer flattened it and the daemon would 404 on it, so nothing was
reachable through it - but a name rule that accepts a newline is not the rule it
claims to be. Both guards now share one `fullmatch` helper, and
`checks/test_guard_control.py` carries `"grafana\n"` as a case.

And the `shell` role, which is the thing #90 would spend:

- it exists in the realm, non-composite, described as *"HIGH PRIVILEGE:
  arbitrary terminal. Keep composite=false and never nest it in another role"* -
  `auth/realm-devbox.json:37-39`;
- the interface says the same: *"An arbitrary terminal. Granted to nobody, on
  purpose."* (`apps/bothy-web/web/src/lib/me.ts:29`), rendered as **Granted to
  nobody** rather than as an ordinary "Not held"
  (`apps/bothy-web/web/src/pages/Settings.tsx:260`);
- it is granted to nobody. The seeding step grants `viewer editor operator` and
  says why it stops there - *"`shell` is DELIBERATELY NOT GRANTED"*,
  `auth/compose.yml:428-434`;
- **no router references it.** There are three `allowed_groups=` values in
  `edge/dynamic/`, all in `bothy-gates.yml`, and none is `shell`: `viewer`
  (`:60`), `editor` (`:70`) and `operator` (`:81`). The only occurrences of the
  word in that directory are two comments using it as the negative control of an
  authorisation probe - `allowed_groups=shell -> 403 (nobody has it)`
  (`bothy-files.yml:40`, `bothy-gates.yml:37`) - which
  `apps/bothy-files/checks/authz_probe.py:84` re-runs against the live edge.

So the role is a **name with no route and no holder**, and that is exactly what
makes it a safe thing to gate a new route on: oauth2-proxy fails closed on a
group nobody holds, so a route carrying `allowed_groups=shell` refuses everybody
until somebody grants it on purpose. It fails in the safe direction while the
feature is half-built.

One consequence to know before the code PR: **the realm import is first-boot
only** (`auth/compose.yml:213-215` - *"If the realm already exists the import is
silently skipped, so editing that file and restarting does nothing"*). Anything
the shell needs from Keycloak - a role grant, an authentication flow, a client
attribute - must land in the `keycloak-init` one-shot, which re-runs on every
`just up-auth` (`auth/compose.yml:386-392`), or it will be correct on new
installs and silently absent on every existing one.

### What a browser shell would actually require

As a concrete diff, not as a capability in the abstract. Which rows apply
depends on which of #90's three shapes lands:

| Shape (#90's own ordering) | Proxy change | Route | Role | What it widens |
|---|---|---|---|---|
| 1 · allowlisted command generator | none | one new exact `` Path() `` under `/-/api/` | `operator` would do | the verb set, and whatever composes the commands. No socket grant moves |
| 2 · PTY as an unprivileged user in a throwaway container | `EXEC: 1`, **or** `POST: 1` together with `CONTAINERS: 1` | new exact `` Path() ``, plus a websocket upgrade | `shell` | everything - see below |
| 3 · PTY on the host as the operator's own account | none. It does not go through Docker at all | new exact `` Path() ``, plus a websocket, into a host-side process | `shell` | the edge becomes a way to run host commands. The socket boundary is untouched; the boundary that moves is "the portal cannot run code" |

The row that must not be misread is **shape 2**, which sounds like the contained
option and costs the most:

- **`EXEC: 1` on any proxy is root.** The proxy gates by endpoint family; an
  exec into a container that already holds a host mount - and all three proxies
  hold `/var/run/docker.sock` - is a host root shell. Two compose files say so
  on three lines, in the same six words.
- **Creating the throwaway container instead is worse, not better.**
  `apps/bothy/compose.socket-proxy.yml`'s header reads the haproxy rule text out of
  `tecnativa/docker-socket-proxy:0.3.0`: the granular `ALLOW_*` lines are
  `allow` rules, the broad `^/containers` line sits below them, and there is
  **no deny in between** - so `POST=1` with `CONTAINERS=1` permits every POST
  under `/containers`, `/containers/create` included, and *"`/containers/create`
  with a bind mount of `/` is root on this box"*. `CONTAINERS: 0` on the write
  proxy (`:172`) is the only thing refusing that today, and its own comment says
  setting it to `1` *"would silently grant `/containers/create` … and nothing
  would look different"*.

Shape 2 therefore does not need one new grant; it needs precisely the pair that
the proxies were split into two containers to avoid, and that the 2026-09
consolidation kept split on purpose. Putting it on a **third, dedicated proxy**
does not fix that, it relocates it: the dedicated proxy would itself be a
create-a-privileged-container endpoint defended only by the Python in front of
it, which is the design the split rejected - *"a total compromise of bothy-ops
still cannot create a privileged container"* (`apps/bothy/compose.socket-proxy.yml`).

Shape 3 is the honest one about what it gives away: everything the operator's
own account can already do on the host, and no socket grant at all. Shape 1
gives away the least and is the only one needing no new role.

### The blast radius

Docker socket access is root-equivalent on this box, and the path from a route
to root is four steps. Take shape 2 with the grants it needs:

1. A request reaches the shell route. Three things could produce one: a
   signed-in holder of the role; **a mistake in the route rule** - a
   `PathPrefix` where a `` Path() `` was meant, the failure
   [rule 3](#3-the--api-routers-use-exact-path-never-pathprefix-this-is-the-control)
   exists for and which has to be re-argued for every new route; or anything
   that can reach the service directly, since these services have no auth of
   their own and the network is the authorisation (`README.md:115-121`).
2. The service asks its proxy to create a container.
3. The create body carries `Binds: ["/:/host"]` and `Privileged: true`. **The
   proxy gates by path, never by body.**
4. The result is a root shell over the host filesystem: every `.env` on the box,
   the Postgres and Grafana credentials, the Keycloak database that decides who
   holds which role, the operator's SSH directory, and the tailnet key that
   makes this node a member of the tailnet at all.

Step 3 is the one to keep in view, because it generalises. Every control in this
repository is a control over **which path** is reachable - exact `` Path() ``
rules, endpoint families, container names. Not one of them reads a request body.
A proxy that permits `/containers/create` permits the whole of it.

The two-member networks are what keep that unreachable today, and a shell adds
members. `socketnet` holds exactly Traefik and the socket proxy because *"the
proxy has no authentication, so keeping the blast radius at two members is the
control"* (`README.md:272-274`, `justfile:41-45`,
`apps/bothy/compose.socket-proxy.yml`). `controlsocknet` holds `bothy-ops` and the two
proxies, and Traefik is deliberately **not** on it: *"'It is not configured to'
is weaker than 'it cannot', and the network is what makes it the second"*
(`apps/bothy/compose.socket-proxy.yml`). Since 2026-09 `bothy-socket-read` sits on both
`socketnet` and `controlsocknet`; that adjacency is safe only because it is
`POST: 0`. A shell service needs its own pair on
that precedent, never a seat on an existing one, and never `devnet`.

One more thing the evidence forces, and #90 should hear it plainly.
`guard.SEVERING` guarantees that the control tier cannot stop the container
serving the page you are typing into. **A real PTY cannot inherit that
guarantee.** A shell can `docker stop` from inside itself, or `kill -9` its own
parent, and no name-keyed refusal list can see it - `SEVERING` is a property of
*buttons*, not of a terminal. #90's requirement that "you must not be able to
stop the container serving the page you are typing into" is therefore
satisfiable by shape 1 and by nothing else. That is not an argument against the
feature; it is a statement that the requirement has to be rewritten honestly as
*"the shell can break its own session, and the recovery is Tailscale SSH"*.

### The conditions under which it is acceptable

The maintainer's position is explicit and it is right about the box it
describes: this is real developer tooling for one person's workstation, it ships
instructions and warnings, and somebody who edits a compose file and runs it
owns the result.

The stronger form of that argument, and the one this section is prepared to
make, is narrower and better evidenced: **on this box the shell grants no new
capability to the person it is for.** The operator already reaches the box over
Tailscale SSH, and `docker exec -it <name> sh` is what the box itself tells them
to use (`justfile:405-407`). Every credential in the blast radius above is
already readable from that session. A browser shell is therefore not a new
privilege; it is **a second front door onto a privilege that already exists**.
The security question is not "should this power exist here" - it already does -
but "is the new door as strong as the old one".

It is not, and that is the whole of the risk. The old door is Tailscale SSH: one
account, key material held by the tailnet rather than by anything a person types
or a browser stores. The new door is a session cookie in a browser, on a
plain-HTTP origin whose pages need no login to browse. Same capability, weaker
credential.

The argument holds exactly while all of the following are true, and each is a
line at which it stops holding:

| Condition | What breaks when it stops being true |
|---|---|
| **One operator** | A second person with a portal login has host root without ever having been handed SSH. The role gate becomes the only thing between them and it, and a role grant is one `kcadm add-roles` away, with no review and no record in this repository |
| **A tailnet ACL admitting only that operator's devices** | Widening it for a colleague, a CI runner, or a device somebody else also uses silently widens the shell. Nothing in this repository can see that change |
| **No published host port; reachable only through Traefik** | The moment a shell service publishes a port, the network stops being the authorisation and there is no second control behind it. That is the failure `socketnet` exists to prevent, at a higher stake |
| **Nothing reachable off the tailnet** | Plain HTTP is accepted here *only* because the tailnet is WireGuard. A shell session cookie in cleartext off the tailnet is a root credential on the wire |
| **The operator's browser is not shared, and not carrying hostile extensions** | An XSS or a malicious extension on the portal origin inherits the session |

The last row is genuinely new and deserves its own sentence. The portal has no
login for browsing its own pages - accepted, above - so anything executing on
that origin is already inside the portal. Today the most it can reach is a
role-gated API, where it gets a file write that leaves a diff or a restart that
leaves an audit line. A shell route changes what an ambient session is worth
from "an inconvenience with a paper trail" to "the box", and it does so at
precisely the point where this repository has knowingly accepted its weakest
control.

### The mitigations that must ship with it

A checklist a future PR can be held to. The ones marked **non-negotiable** are
those without which the argument in the previous section does not hold.

1. **Non-negotiable - no new socket grant.** `EXEC` stays `0` on every proxy,
   and no proxy holds `POST: 1` and `CONTAINERS: 1` at once.
   `apps/bothy-ops/checks/grants.py` asserts both, for every proxy declared
   anywhere in the repository, so a third one cannot be added without meeting
   the rule.
2. **Non-negotiable - the route is an exact `` Path() ``, never `PathPrefix`,**
   under [rule 3](#3-the--api-routers-use-exact-path-never-pathprefix-this-is-the-control).
   A websocket upgrade is still a path.
3. **Non-negotiable - gate it on `allowed_groups=shell`, and leave the role
   ungranted.** `keycloak-init` keeps granting `viewer editor operator` and not
   `shell` (`auth/compose.yml:432-434`), so installing Bothy never installs a
   working terminal. Granting it stays a deliberate act by the box's owner, and
   the fork checklist below says so.
4. **Non-negotiable - its own network, holding exactly two.** Traefik and the
   shell service; a second network for any privileged leg. Never `devnet`, where
   about twenty containers including third-party images would inherit the reach.
5. **Non-negotiable - an audit line per session, and per command where the shape
   permits one.** `apps/bothy-common/bothy_common/audit.py` (every tier's writer
   since 2026-09) is the model, and its
   properties are the requirement: append-only, one tab-separated line, recording
   what was *asked* rather than only what succeeded so refusals are logged too,
   bind-mounted so it survives `up --build`, and swallowing its own errors so a
   full disk cannot block a legitimate action. A log recording only that a
   session opened is not an audit trail.
6. **Non-negotiable - strip client-supplied `X-Auth-Request-*`.** Copy
   `ops-deidentify` (`edge/dynamic/bothy-ops.yml:132`). Its own
   reasoning applies with more force here: a forged name on a file write leaves a
   diff somebody can read; a forged name on a shell session leaves a log that is
   worse than none.
7. **Step-up re-authentication - and this is the recommendation the issue does
   not make.** It is already half-written. The realm carries
   `acr.loa.map = {"standard":1,"stepup":2}` (`auth/realm-devbox.json:16`),
   `realm-devbox.json:38` tells the reader to expect it, and
   `auth/compose.yml:257-274` writes out the five remaining steps: copy the
   built-in `browser` flow to `browser-stepup`; add a subflow conditioned on
   `loa-condition-level=2` containing an OTP form; bind it as the realm's browser
   flow; set the same map as a client attribute; and send `acr_values=stepup` on
   the authorize request - *"which in practice means a SECOND oauth2-proxy
   instance dedicated to that route, since `--acr-values` is per instance and
   this one is shared by everything"*. Keycloak then stamps `acr=stepup` into the
   id_token, so the guard verifies that a step-up happened instead of trusting
   the role claim alone. **This is the mitigation that answers the actual risk**
   named above - that the new door is a browser cookie while the old one is a
   tailnet key. Without it, an ambient session is a root shell. It is real work
   because of that second oauth2-proxy instance, and it belongs in the shell PR
   rather than behind it.
8. **A statement in the UI of what the session can do,** naming Tailscale SSH as
   the equal-privilege alternative. The box already tells the truth about this in
   `just urls` (`justfile:405-407`); if a shell ships, that text changes, and so
   does this section.
9. **An idle timeout and an explicit end-session.** A PTY held open under a
   closed laptop lid is a credential with no expiry.
10. **Recommended - build shape 1 first, and if that is not enough, jump to
    shape 3.** #90's own ordering already puts the allowlisted generator first;
    it is the only shape that keeps `guard.SEVERING`'s guarantee intact, needs no
    new role, and moves no grant. If what is really wanted is a real terminal,
    ship **shape 3** - a host PTY as the operator's own unprivileged account -
    and not shape 2, because a container-creating proxy is the one thing on this
    box that nothing is allowed to have.

**What this section does not license.** It is an argument for a shell on a
single-operator tailnet box, with the mitigations above. It is not an argument
that `EXEC: 1` is ever acceptable here, that any proxy may hold `POST: 1` and
`CONTAINERS: 1` together, or that rules 2, 3 or 4 may be relaxed to make a shell
easier to build. If the shell needs one of those, it is the shell that is the
wrong shape.

---

## If you fork this

Nothing in this repo is safe to run with the values it ships with. Before your
first `just up`:

1. **Create your own `.env` from `.env.example`.** Never commit it; confirm
   `git check-ignore -v .env` prints the rule.
2. **Rotate the sample Postgres credentials.** `POSTGRES_PASSWORD=devpass` is a
   placeholder. Change `POSTGRES_USER`/`POSTGRES_DB` too if you like - they flow
   into the exporter's DSN automatically.
3. **Change the Grafana admin password** from the `admin`/`admin` sample, set
   your own `DEV_LOGIN_*` values, and set a real `WIKI_DB_PASSWORD` in place of
   `changeme`.
4. **Assume nothing is authenticated until you attach it yourself.** As shipped,
   the role gates cover the file, config and control tiers and nothing else -
   every dashboard and the read-only data plane are reached without passing an
   auth boundary. Read
   [rule 1](#1-sso-enforces-on-the-tiers-that-change-things-and-nowhere-else-yet)
   before you assume any dashboard here is behind a login, and attach
   `sso-errors@file,sso@file` one router at a time - starting with a router you
   do not need in order to fix a mistake.
5. **Generate `edge/dynamic/bothy-prom.yml`, never commit it.** Run
   `just bothy-prom-route`. It carries a credential; `git check-ignore -v
   edge/dynamic/bothy-prom.yml` must print the rule.
6. **Keep it on a private tailnet.** If you put this behind a public address, at
   minimum you need TLS, real authentication in front of every route, the
   portal's Docker API removed or re-reviewed, and the databases moved off any
   published port at all. The port model in particular assumes an outer
   perimeter that a public address does not have.
7. **Re-run the boundary test** after any change under `edge/dynamic/` -
   the `curl` pair in
   [rule 3](#3-the--api-routers-use-exact-path-never-pathprefix-this-is-the-control)
   must print `text/html` for the blocked path and `application/json` for the
   allowed one. Check the content type; the status code cannot fail.
8. **Do not commit real hostnames, tailnet IPs or account identifiers.** The
   `just urls` recipe reads them from `tailscale` at run time precisely so they
   never land in the repo. Keep it that way.
9. **Leave the `shell` role ungranted, and do not grant it to a box that more
   than one person reaches.** As shipped there is no terminal: `shell` is gated
   on zero routes and `keycloak-init` grants `viewer editor operator` and stops.
   If a browser shell ever exists here, granting that role hands its holder
   everything an SSH session on the box would give them - which is the argument
   *for* the feature on a one-operator box and the argument against it on any
   other. Read
   [A shell in the browser](#a-shell-in-the-browser-90-before-it-exists)
   before granting it, and in particular the table of conditions under which the
   argument stops holding.
