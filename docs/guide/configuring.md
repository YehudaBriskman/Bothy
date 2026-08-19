# The files you will actually edit

Bothy is a set of Docker Compose stacks, a Traefik file-provider directory, two
policy files and one `.env`. This page maps "I want to change X" onto the file
that decides it, and says what has to happen before the change is live - because
in nearly every case here, **saving the file is not applying it**.

The reasoning for individual settings lives in the compose files themselves.
Every non-obvious line in them carries a comment explaining what broke without
it, and those comments are the primary source. This page is the index.

## The rule that comes first

Use `just`. The justfile does `set dotenv-load`, so recipes see the root `.env`.
`docker compose` looks for a `.env` beside the compose file it was handed, finds
none, and either falls back to an insecure default or aborts on a required
variable. Every group has a recipe:

| Recipe | Compose file |
|---|---|
| `just up-edge` | `edge/compose.yml` |
| `just up-data` | `data/postgres/compose.yml` |
| `just up-auth` | `auth/compose.yml` |
| `just up-monitoring` | `monitoring/compose.yml` |
| `just up-apps` | `apps/bothy/compose.yml`, plus the config and control tiers |

`apps/bothy/compose.yml` is a stub that pulls three fragments together with
`include:` - the web tier, the editor tier and the socket proxy. It is
`include:` and not repeated `-f` for a specific reason worth knowing before you
reach for the shorter form: with repeated `-f`, every relative path in every
file resolves against the **first** file's directory. That built the editor tier
from the web tier's Dockerfile, so `portal-files` came up as nginx and
crash-looped, and its audit-log bind mount silently moved somewhere nothing
looks.

## `.env`

One file, gitignored, and the only place several values exist on earth. The
comments in [`.env.example`](../../.env.example) are the reference; these are the
keys people actually go looking for.

| Key | What it decides |
|---|---|
| `BOX_IP` | the address this box answers on. Read **directly** by `auth/compose.yml` in five places - Keycloak's hostname, the realm's redirect URI, the OIDC issuer, oauth2-proxy's redirect and its cookie whitelist |
| `DEV_LOGIN_USER` / `DEV_LOGIN_PASSWORD` | the one shared credential every service with a native login uses, and the Keycloak admin password |
| `NOTES_ROOT`, `PROJECTS_ROOT`, `HOME_ROOT`, `STATE_ROOT` | where the four things that live **outside** the repository are. Every one has a default; set one only if your layout differs |
| `PUID` / `PGID` | who the three writing services run as. Left blank on purpose - `just bootstrap` fills them in from your own uid |

Two things about `BOX_IP` that cost time if you learn them the hard way. It is
the value most likely to be wrong in a way nothing reports: Keycloak advertises
whatever it is told, oauth2-proxy independently validates that issuer, and if
the two disagree by so much as a port the symptom is **an infinite redirect
loop, not an error**. And nothing in `.env` is live until the stack that reads
it is brought up again - for this key specifically, `just up-auth`.

Never write a second spelling of that address. The internal shortcut
`http://keycloak:8080` is deliberately unused in the OIDC configuration, because
a second spelling *is* the bug.

## Compose: adding a service

The whole recipe, for the overwhelmingly common case:

1. add the service to a compose file, or give it one of its own;
2. **publish a host port** - there is no name layer, so this is how it is
   reached;
3. put it on `[default, devnet]`;
4. add it to `just urls`, which is a human-maintained list and not a registry;
5. `docker compose -f <file> up -d`, then confirm on `http://<node-ip>/` that
   Bothy noticed it.

That last step is the test of the whole design: **start any container and it
appears on the Overview within ten seconds with no edit to Bothy.** If it does
not appear, the problem is the container, not the console.

> [!warning] Listing `networks:` on a service drops it off the compose default network
> Always `[default, devnet]`. With `devnet` alone, the service silently loses
> its own project's database.

Pick a free port with care. `just urls` lists the *stack's* ports; a project's
claims live in its own manifest and nothing reconciles the two. Keycloak was
once published on a port a stopped project had already declared - the collector
TCP-probed the declared port, found something listening, and reported a service
nobody had started as up. Check `ss -ltn` **and** the project manifests.

The full checklist, including the cases for a container nothing browses, a host
process and a database, is
[`docs/ARCHITECTURE.md` § 7](../ARCHITECTURE.md).

## `edge/dynamic/` - the Traefik file provider

Traefik watches this directory and **merges every `.yml` in it into one
namespace**. That single fact explains most of the shape of what is in there.

What is committed:

| File | What it declares |
|---|---|
| `portal-api.yml` | the portal's read-only data plane. The security boundary - read it in full before touching it |
| `auth.yml` | the `sso` and `sso-errors` middlewares, and the host-less `/oauth2/` router that makes the login flow reachable at all |
| `portal-files.yml` | four role-gated routers for the file tier, and the `sso-viewer` / `sso-editor` middlewares |
| `bothy-config.yml` | two role-gated routers for the config tier. It **borrows** the middlewares above |
| `bothy-control.yml` | three role-gated routers, one per verb, and `sso-operator` |
| `project.example.yml` | the annotated template, entirely commented out |
| `portal-prom.example.yml` | the template for the generated Prometheus route |

`portal-prom.yml` itself is gitignored and generated by
`just portal-prom-route`, because it carries the basic-auth header the edge
injects on the portal's behalf.

### Why there are zero `Host()` rules

The `.test` name layer was retired on 2026-08-12 - deleted, not dormant. A
`Host()` rule written today registers with status `enabled` and then matches
nothing, forever. `just verify` asserts the count of them is zero, and that zero
is the invariant; the total number of routers moves as tiers are added.

If a route is genuinely needed, the only shape that still works is a **host-less
exact `Path()` rule**. Be aware of what that means: with no host to scope it,
the route answers on every address this box has at once, in a shared global path
namespace - so a generic path like `/api` will collide with the next project
that wants `/api`. Prefix it with something unmistakably yours.
[`edge/dynamic/project.example.yml`](../../edge/dynamic/project.example.yml) is
the template, and it is commented out on purpose: the file provider merges
everything here, so an example with live YAML is not an example, it is
configuration. That is not hypothetical - an example file once declared the same
router and middleware *names* as a real generated file, and the merge silently
replaced a live credential with the example's placeholder. Every request 401'd
while the router still reported "enabled".

### `Path()`, never `PathPrefix()`

Every rule in the tiers that can change something is an exact `Path()`, with the
variable part in the query string or the JSON body. This is a security control
and not a style preference: a prefix rule covers every endpoint the service
grows **later**, including one nobody meant to expose. With exact paths a new
endpoint is unreachable until somebody edits a rule here, which is the correct
default for services holding write handles on two git repositories and a path to
the Docker daemon.

### The trap that voids a whole file

> [!caution] A doubled brace anywhere in `edge/dynamic/`, comments included, voids the file
> Traefik renders every file in that directory as a **Go template before it
> parses the YAML**, and it does not skip comments. A doubled brace - the usual
> way in is a `docker inspect -f` format string in a comment - is evaluated as a
> template action, fails, and takes out the entire file: no routers, no
> middlewares, silently, while the file on disk looks perfect. Traefik keeps
> serving its last good configuration, so nothing looks wrong until the next
> restart, when every file-provider router disappears at once. Use the `jq`
> form. `just verify` check 5b exists to catch exactly this.

And one more that is not a syntax error at all:

> [!warning] The `edge/dynamic` bind mount goes stale after `git checkout`
> A bind mount pins the host inode at container-creation time, and checkout
> deletes and recreates directories. Traefik then keeps reading an orphaned copy
> and `--providers.file.watch=true` stops meaning anything. It ran that way for
> five days once, with every edit having no effect. After any branch switch:
> `docker compose -f edge/compose.yml up -d --force-recreate`.

### Attaching a login to a router

Add **both middlewares, in this order**: `sso-errors@file`, then `sso@file`.
Reversed, a signed-out user gets a blank 401 instead of a sign-in page - the
request passes through `sso-errors` on the way in and the 401 travels back out
through it.

`sso` fails closed. If oauth2-proxy is down, every router carrying it returns
500 to everyone. That is correct for an auth boundary and it is precisely why
you do not attach it to the thing you would need in order to fix it.

Which role a router requires lives in the **middleware**, not the service:
`sso-viewer`, `sso-editor` and `sso-operator` are identical but for one word in
a query string. Adding a tier is four lines of YAML, not another container. See
[Roles](roles.md).

## The `dev.portal.*` labels

Everything on the Overview works with **zero labels**. If the page ever *needs*
a label to be correct, the defaults are wrong. The labels are polish, read in
`apps/portal-next/web/src/lib/discover.ts`:

| Label | Effect |
|---|---|
| `dev.portal.project` | display name for a whole compose project - one label fixes every breadcrumb and panel title |
| `dev.portal.name` | this service's display name |
| `dev.portal.icon` | an emoji |
| `dev.portal.desc` | the card's body text |
| `dev.portal.group`, `dev.portal.groupKind` | force which panel it lands in. Display only - what a service **is** cannot be moved by a label, so its accent colour and its old URL are unaffected |
| `dev.portal.hidden=true` | drop it from Services. Still listed under Ports and Routes |
| `dev.portal.path` | a deep link, such as `/targets` |
| `dev.portal.order` | sort order within a panel |

`dev.portal.project` on **any** container in a project names the whole project,
which is how `Edge · Traefik` and `Identity · Keycloak` get their titles. The
naming form is `Role · Vendor`, and the argument for it is in
`edge/compose.yml` beside the label: the Bothy prefix is earned by authorship,
not proximity. Traefik is not "Bothy Edge" - if it breaks at 03:00 it is not
Bothy's documentation you open.

Labels are fixed at container creation. Editing one and running `docker restart`
does nothing; the container has to be **recreated**.

## The two `policy.toml` files

Both are access policy expressed as data rather than as constants in Python,
both are read once at startup, and both **fail closed** - a missing file, a
parse error, or a declared root that does not exist stops the service starting.
There is no permissive fallback, because the only safe default is "nothing" and
a service that serves nothing looks broken in a way people work around.

**`apps/portal-files/policy.toml`** governs Bothy Files: which roots exist and
which are writable, which directories are never served at any depth, which files
are *labelled* sensitive, how many undo snapshots are kept, and what warning a
given path shows before you overwrite it. It is itself editable through the
explorer, and marked `critical` for the reason above - a bad edit here does not
produce a permissive service, it produces one that will not come back until
somebody repairs it from a shell on the box. See [Bothy Files](files.md).

**`apps/bothy-config/policy.toml`** governs the settings forms: one root, YAML
files only, and a named allowlist of fields a form may patch. `.toml` is
deliberately absent from its suffixes, so the file declaring what may be written
cannot be rewritten through the API it declares. It is a much smaller surface
than the file tier on purpose - a form that could set `volumes`, `privileged`,
`command` or `network_mode` would be arbitrary code on the box, and those are
edited as a diff by somebody who has read the comment above them.

## After you save, what actually applies it

| You changed | Live when |
|---|---|
| `edge/dynamic/*.yml` | immediately - Traefik watches the directory. Unless the mount is stale after a checkout |
| a compose `labels:` or `ports:` entry | after `docker compose -f <file> up -d` **recreates** the container. A restart is not enough |
| `.env` | after the stack that reads it is brought up again |
| a `policy.toml` | after that service restarts. If it will not start, the policy is why |
| a theme under `apps/portal-next/data/themes/` | on reload. Anything under `web/src/` needs a rebuild |

Then:

```sh
just verify     # 23 checks against the running edge, asserting on content
just doctor     # containers, Prometheus targets, disk, backup freshness
```

## Next

- [Operating it from the console](the-console.md)
- [Roles](roles.md)
