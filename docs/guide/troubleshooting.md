# When something is wrong

Start with one command:

```sh
just doctor          # or: bothy doctor
```

It covers containers, published ports, Traefik routes, Prometheus targets, DNS,
disk, memory and backup freshness. **The failing line is often not the one you
expect**, which is why it reports on all of them rather than the one you asked
about.

It exits 0 by default even when it finds problems - the everyday use is a human
reading a report, and a non-zero exit makes it unusable in a shell with
`set -e`. Pass `--strict` when you want a verdict rather than a report.

## The traps that cost the most time

These are in rough order of how often they are the actual answer.

### A 200 proves nothing about routing

The console's catch-all answers **every** unmatched request on port 80 with its
own page - from any address, for any path no other rule matched. So a service
you believe you routed can be dead while `curl` reports a cheerful 200 and a
page full of somebody else's markup.

It is the most convincing false positive available on this machine.

**Assert on content, never on a status code.** Check the service on **its own
published port**, and check that the bytes that came back are its bytes. This is
exactly what `just verify` does.

### A `Host()` rule registers as enabled and matches nothing

There is no name layer. A `Host()` rule appears in the router table, looks
healthy, and never fires - forever. Publish a port instead. If you genuinely
need a Traefik route, it has to be a **host-less exact `Path()`** rule;
`edge/dynamic/project.example.yml` is the template.

### `edge/dynamic` goes stale after a `git checkout`

A bind mount pins the host inode when the container is created, and `git
checkout` deletes and recreates directories. So after switching branches Traefik
keeps reading an **orphaned** copy of `edge/dynamic/` and silently serves its
last in-memory config. `--providers.file.watch=true` stops meaning anything, and
every edit to a routing file appears to have no effect.

```sh
docker compose -f edge/compose.yml up -d --force-recreate
```

It ran that way for five days once.

### Listing `networks:` drops a service off the default network

Writing `networks: [devnet]` removes the compose default network, so the service
loses its own database. Always `[default, devnet]`. Nothing warns you.

### A dotless hostname in a host process

A bare compose service name - `tempo`, `redis` - leaking out of a container into
a host process is a landmine. Without DNS configured to refuse them outright,
each lookup hangs for tens of seconds, and because `getaddrinfo` runs on a small
thread pool a handful of them starve **every other lookup in the process**.

It presents as unrelated database timeouts on a healthy database. That is a very
expensive way to learn about DNS.

### `just urls` is not an authoritative port registry

It lists the **stack's** ports. A project's claims live in its own
`project.dev.yml`, and nothing reconciles the two. Check **both** `ss -ltn` and
the project manifests before publishing a port.

This is not hypothetical: the stack once published Keycloak on a port a stopped
project had already declared, the collector found something listening there, and
reported a service nobody had started as up. See
[Declaring a project](projects.md) for how that probe was fixed.

### A service is reachable from the box but not from a laptop

Almost always the process bound `127.0.0.1` rather than `0.0.0.0`. Loopback is
reachable only from this machine - not from a container, and not from any other
device on the tailnet.

## Reading the route table

There is **no Traefik dashboard** to check. It was deleted deliberately: its
`/api/rawdata` endpoint dumped the merged configuration and leaked a credential
that a headers middleware had injected. **A headers middleware hides a secret
from the browser, not from the config dump.**

The router table is served at `http://<node-ip>/-/api/traefik/http/routers`, and
rendered in the console under Control.

## Editing is not applying

A change that appears to do nothing usually did nothing *yet*:

| You changed | What applies it |
|---|---|
| a compose label or port | the container must be **recreated**, not restarted |
| `.env` | nothing is live until the stack is brought up again |
| a file in `edge/dynamic/` | picked up live - unless the mount is stale, above |
| a `policy.toml` | the service reloads it at start, and **fails closed** if it cannot parse it |

[The files you will actually edit](configuring.md) covers this properly,
including the doubled-brace trap that voids a whole routing file with no error.

## Logs

Every container's logs are in Loki with no per-service setup, labelled by
container name and compose project - see [Monitoring](monitoring.md). For one
container, quickly:

```sh
just logs <service>          # or: bothy logs <service>
docker logs --tail 100 <container>
```

## When the box will not answer at all

If nothing responds - not the console, not SSH - the problem is usually not the
services. Check in this order: is the machine awake, is the network path up, is
the Docker daemon running, and only then look at containers.

On a WSL2 host specifically, the VM is destroyed shortly after the last
Windows-side client disconnects, taking Docker and every container with it.
`restart: unless-stopped` is inert if the daemon never starts. `host/README.md`
covers keeping it alive.

> This guide stops at the general case on purpose. One machine's outage history,
> with real addresses and real incidents, lives in [`docs/kb/`](../kb/README.md)
> - it is correct, and it is that box's operational record rather than user
> documentation.

## Related

- [Backups](backups.md) - `doctor` checks their age and size, not their existence
- [The files you will actually edit](configuring.md) - what applies a change
- [Monitoring](monitoring.md) - where the logs and metrics already are
- [`README.md`](../../README.md) - the same traps, beside the repository map
