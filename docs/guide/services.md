# Adding a service to the stack

This is for something **Bothy itself runs** - a container in this repository's
compose files. For something you run in `~/projects`, see
[Declaring a project](projects.md); the two are different mechanisms and mixing
them up double-counts everything.

## The rule that comes first

**Access is `IP:port`. There is no name layer.** A browser-facing service
publishes a host port and is reached at `http://<node-ip>:<port>`.

A `Host()` rule in Traefik will register happily and then **match nothing,
forever**, because there is no name for it to match on. That failure is silent:
the router appears in the router table, `docker ps` looks right, and the URL
simply never resolves. It is the single most expensive mistake available here.

## A container a browser reaches

Pick a free port, publish it, join `devnet`, and add it to `just urls`:

```yaml
services:
  myapp:
    image: myorg/myapp
    networks: [default, devnet]      # BOTH - see the warning below
    ports:
      - "8099:8080"                  # HOST:CONTAINER. Check the port is free first.
    labels:
      # Optional. Discovery works with zero labels.
      - dev.portal.name=My App
      - dev.portal.desc=What it does.

networks:
  devnet:
    external: true
```

> [!warning] Listing `networks:` silently drops the service off the compose default network
> Always write `[default, devnet]`. With `[devnet]` alone the service loses its
> own database, and nothing warns you.

Then, in order:

| Step | Why |
|---|---|
| Run `just urls` and `docker ps --format '{{.Ports}}'` **before** choosing the number | Ports are a flat namespace with no allocator. This check is the cost of the model and there is no way around it |
| Add the port to the `urls` recipe in the `justfile` | `just urls` is the only inventory. A service missing from it is a service nobody finds |
| Give it a login | It is on the tailnet with nothing in front of it. Use the shared `DEV_LOGIN_*` credential from `.env`, the way Grafana, Prometheus and the rest do |
| **Do not** write a `Host()` rule | See above |
| **Do not** attach the SSO middlewares | They are defined and attached to nothing on purpose. Attaching one router at a time is a rollout plan, not a per-service decision |

## A container nothing browses

Publish nothing. Join `devnet` and let other containers reach it by service
name. This is the correct default for exporters, sidecars and proxies -
`bothy-socket-proxy`, `oauth2-proxy`, `portal-files` and every `*-exporter` do
exactly this.

## A database

Bind loopback explicitly and route nothing:

```yaml
ports:
  - "127.0.0.1:5432:5432"
```

Containers reach it by name over `devnet`; humans reach it over an SSH tunnel.
A bare `5432:5432` publishes it to the whole tailnet.

## A host process

Reach it on its own port - Tilt at `<node-ip>:10350`, and so on. There is no
routing to set up.

> [!warning] The process must bind `0.0.0.0`
> `127.0.0.1` is reachable only from this box - not from a container, and not
> from any other device on the tailnet. For Tilt that is
> `tilt up --host=0.0.0.0 --port=10350`. This is the usual cause of a connection
> refused from a laptop that can otherwise reach the box.

## How the console finds it, with no list to maintain

You do not register a service anywhere. Classification comes from where its
compose file lives, which a container carries as a label:

| Where the compose file is | Filed as |
|---|---|
| under `apps/` in this repository - Bothy's own tiers | **infra** |
| elsewhere in this repository | **stack** (`edge` is **infra**, by name - it is not under `apps/`) |
| anywhere else | **project** |
| missing entirely | **unmanaged / infra** |

**Infra is a place on disk, not a list of names.** It used to be five project
names in the source and the list had already gone stale. A name test is also
unsafe, because compose project names are global to the Docker daemon and belong
to whoever claimed one first - a checkout at `~/projects/portal` was being
declared part of Bothy.

### The polish labels

Everything above works with **zero labels**. If the page ever *needs* a label to
be correct, the defaults are wrong and the defaults are the bug.

| Label | Effect |
|---|---|
| `dev.portal.project` | display name for the whole compose project - one label fixes every breadcrumb, panel title and card |
| `dev.portal.name` | this service's display name |
| `dev.portal.icon` | emoji |
| `dev.portal.desc` | card body text |
| `dev.portal.group` / `.groupKind` | force which panel it lands in. **Display only** |
| `dev.portal.hidden=true` | drop from Services. Still listed in Ports and Routes |
| `dev.portal.path` | deep link, e.g. `/targets` |
| `dev.portal.order` | sort order within a panel |

`dev.portal.group` being display-only is load-bearing. Every node carries two
group fields: `system` is **what a service is** (derived, and no label can move
it), `group` is **where it is shown**. That separation is what lets you regroup
the page without 404-ing the bookmark somebody took of the old URL, or
reshuffling the accent colours - the colour is hashed from the identity, not
from the display group.

## The checklist

| | |
|---|---|
| A free port | checked against `just urls` and `docker ps` **first** |
| Listed in `just urls` | otherwise it is invisible |
| On `devnet` | as `[default, devnet]`, so Prometheus and the console see it |
| A login | the shared `DEV_LOGIN_*` credential. Nothing else is guarding it |
| Loopback if it is a database | `127.0.0.1:PORT:PORT`, never a bare `PORT:PORT` |
| No `Host()` rule | there is no name layer to match |
| No SSO middleware | defined, deliberately unattached |
| Verified | on its **own port**, checking the bytes as well as the status code |

That last line is not pedantry. The console answers **every** unrouted request
on port 80 with its own page, from any address - so a 200 from `http://<node-ip>/`
proves nothing about your service. Check the port you published, and check that
what came back is yours.

## Related

- [Declaring a project](projects.md) - for things you run outside this repository
- [The files you will actually edit](configuring.md) - what applies a saved change, and when
- [Monitoring](monitoring.md) - what a service on `devnet` gets for free
- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) - the request path and the networks, in full
