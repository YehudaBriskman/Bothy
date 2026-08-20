# Declaring a project

Bothy discovers two things by itself: **Traefik routers** and **Docker
containers**. That leaves two blind spots, and a declaration is how you fill
them.

- **A project that is switched off has nothing to discover.** It does not show
  as "off" - it disappears from the box entirely.
- **A project made of host processes is invisible even while running.** A
  `just dev` or `tilt up` harness on ordinary ports is neither a container nor,
  unless somebody hand-wrote a route, a Traefik service.

Underneath both is the real gap: discovery records **observed facts, never
intent**. It sees "not running" and cannot tell *somebody stopped this* from
*this crashed*.

## It is `project.dev.yml`, and it is YAML

Not TOML. The two `.toml` files on the box - `apps/portal-files/policy.toml` and
`apps/bothy-config/policy.toml` - are **access policy** for those services and
have nothing to do with declaring a project. Do not conflate them; they are
covered in [The files you will actually edit](configuring.md).

`project.dev.yml` lives at a repository root. The project owns it, it travels
with a re-clone, and deleting it only removes the project from the console.
**Nothing at runtime reads it** - only the collector does.

```yaml
name: Shvil TV
kind: project              # project | stack | infra
description: Five-service HLS pipeline.
start: just up             # shown on the card when the project is off
ports_file: .dev-ports.env # optional: KEY=VALUE source for ${VAR} below

services:
  - name: tv-player-web
    host_port: ${TV_PLAYER_WEB_PORT}   # probed, and identified
    type: web
    ui: true                           # offer a link when it is up
  - name: redis
    container: mpeg-redis              # docker-inspected
```

### Top-level keys

| Key | Meaning |
|---|---|
| `key` | stable id. Defaults to the directory name. |
| `name` | display name. Defaults to the directory name; also what it sorts by. |
| `kind` | `project` (default), `stack` or `infra` |
| `description` | one line, optional |
| `start` | the shell command shown on the card when the project is off |
| `ports_file` | a `KEY=VALUE` file, used to resolve `${VAR}` in service values |
| `log_stream` | maps to a Loki `{host_service="..."}` stream, for host processes |
| `services` | the list below |

### Per-service keys

| Key | Meaning |
|---|---|
| `name` | defaults to `"service"` |
| `description` | optional |
| `type` | `web`, `database`, `cache`, `queue`, `storage`, `observability`, `runtime` (default), `edge` |
| `ui` | offer a link when it is up |
| `container` | a container name, inspected with `docker inspect` |
| `host_port` | a port, or `${VAR}` resolved through `ports_file` |
| `log_filter` | narrows a shared host log stream |

A service may declare `container`, `host_port`, or both. **`container` wins for
state**; `host_port` still supplies the UI link.

`ports_file` is the key worth knowing about: a harness that picks free ports at
runtime writes them to a file, and the collector follows that file rather than
probing a stale address.

## A port is an address, not an identity

This is the most important thing on the page, because the obvious implementation
is wrong and Bothy shipped it once.

Deciding a declared host service is up by TCP-connecting to its port **cannot
fail in the way it claims to**. It answers *is anything listening*, and that
answer used to be reported as *is my service listening*. On 2026-08-12 the stack
published Keycloak on 8083, a stopped project declared a service on 8083, the
connect succeeded, and the console told its user in good faith that a service
nobody had started was running.

So the probe now **identifies the listener**. Strongest evidence first:

1. **Is the port published by a container?** It matches if the container is
   named by this declaration, or its compose working directory is inside the
   project root, or its compose project matches the project's key, directory or
   name. Match → `up`. Positively somebody else → `collision`.
2. **Is a host process holding it?** `ss -ltnp` gives the PID for processes the
   collector's own user owns - which is what a dev harness is - and then
   `/proc/<pid>/{cmdline,exe,cwd}` has to name the project root or the service.
   Match → `up`. Positively located elsewhere → `collision`.
3. **Neither could name it** → `unverified`.

Rung 3 is the honest floor. **`unverified` is a statement about the collector's
knowledge, not about your service, and it is never a pass.** A listener owned by
another user is invisible to an unprivileged `ss`, and guessing "collision"
there would be the same class of error as the `up` it replaced.

The same reasoning is applied one layer up: if Docker itself is unreachable, a
declared container reports `unverified` rather than "does not exist" - an empty
container list because Docker never answered is not evidence of absence.

## The states you will see

| State | Meaning |
|---|---|
| `up` | running, and healthy if it has a healthcheck |
| `starting` | the healthcheck says starting |
| `stopped` | exited cleanly, created, paused, or a declared port with nothing listening |
| `stuck` | exited non-zero, restart loop, unhealthy, or OOM-killed |
| `collision` | the port is held by something **provably not this service** |
| `unverified` | something is listening, or Docker is unreachable, and it could not be identified |
| `unknown` | declared, nothing observable either way |

The project as a whole rolls up to `live`, `degraded`, `stopped`, `stuck` or
`unknown`. In that rollup `collision` folds in with `stopped` - a port held by
somebody else is positive evidence this service is *not* running - and
`unverified` folds in with `unknown`.

**`stopped` is a state, not an alert.** Only `stuck` and `degraded` are alerts,
and a squatted port never manufactures one. This is why a box with several
deliberately-idle projects can still read as healthy.

A colliding service also carries a `collision` object naming the culprit - the
port, whether a container or a process holds it, its name, its compose project,
its PID - because the state alone is not actionable.

## How it runs

```
~/projects/**/project.dev.yml  ->  collect.py  ->  portal-next/data/projects.json
      (intent)                   (host truth)            (rendered)
```

`~/projects` is scanned three levels deep, because repositories are grouped
rather than flat. The collector runs **on the host** - that is what lets it read
`/proc` and container exit codes, neither of which a static page in a container
can do - on a user systemd timer, every 30 seconds. The console polls its own
data every 10 seconds, so a project starting or stopping surfaces while you are
still looking at the page.

```sh
systemctl --user status portal-collector.timer
python3 apps/portal-collector/collect.py    # run once by hand; prints a table on a tty
```

`projects.json` is written atomically, because the console must never read a
half-written file. A **missing** `projects.json` is a supported state: nothing
extra renders, and the absence is never reported as a warning.

## A declaration beats discovery

For the same container, the declaration wins. Containers started with
`docker run` and no compose labels are filed by discovery under unmanaged infra;
the declaration knows better, and keeping both copies would double-count them in
every total.

## Related

- [Adding a service to the stack](services.md) - the other half: things Bothy itself runs
- [Operating it from the console](the-console.md) - where a declared project appears, and what you may do to it
- [`apps/portal-collector/README.md`](../../apps/portal-collector/README.md) - the reference for all of the above
