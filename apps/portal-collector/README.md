# portal-collector

Turns each project's `project.dev.yml` into `projects.json` for the portal.

## Why it exists

The portal discovers two things: **Traefik routers** and **Docker containers**.
Everything it knows comes from one of those, which leaves two blind spots:

- **A project that is switched off has nothing to discover.** It doesn't show as
  "off" — it disappears from the box entirely.
- **A project made of host processes is invisible even while running.** A
  `just dev` / `tilt up` harness on ordinary ports is neither a container nor,
  unless somebody hand-wrote a file-route, a Traefik service.

And a third problem underneath both: the portal only ever recorded **observed
facts, never intent**. It saw "not running" and could not tell *somebody stopped
this* from *this crashed* — which is why five deliberately-stopped containers
rendered as five alerts, and why "needs a look" could never reach zero on a box
with anything idle.

The collector supplies the missing half. It runs **on the host**, where the truth
is: it can TCP-probe the ports a dev harness binds and read container exit codes,
neither of which a static SPA in a container can do.

## How it works

```
~/projects/**/project.dev.yml   →   collect.py   →   portal-next/data/projects.json
      (intent)                    (host truth)              (rendered)
```

1. Scans `~/projects` (3 levels deep — repos are grouped, not flat) for
   `project.dev.yml`.
2. Resolves `${VAR}` in the declaration against the project's own `ports_file`,
   so a harness that picks free ports at runtime is followed rather than probed
   at a stale address.
3. Determines each service's state — TCP connect for `host_port`, `docker
   inspect` for `container`.
4. Writes `projects.json` atomically (the portal polls it and must never read a
   half-written file).

Run by `portal-collector.timer` (user systemd) every 30s. The portal polls its
own data every 10s, so a project starting or stopping surfaces while you are
still looking at the page.

    systemctl --user status portal-collector.timer
    python3 collect.py          # run once by hand; prints a table when on a tty

## The declaration

`project.dev.yml` lives at a repo root — the project owns it, it travels with a
re-clone, and deleting it only removes the project from the portal. Nothing at
runtime reads it.

```yaml
name: Shvil TV
kind: project              # project | stack | infra
description: Five-service HLS pipeline.
start: just up             # shown on the card when the project is off
ports_file: .dev-ports.env # optional: KEY=VALUE source for ${VAR} below

services:
  - name: tv-player-web
    host_port: ${TV_PLAYER_WEB_PORT}   # TCP-probed
    type: web                          # web|database|cache|queue|storage|observability|runtime|edge
    ui: true                           # offer a link when it is up
  - name: redis
    container: mpeg-redis              # docker-inspected
```

A service may declare `container`, `host_port`, or both. `container` wins for
state; `host_port` still supplies the UI link.

## States

Per service:

| State | Meaning |
|---|---|
| `up` | running, and healthy if it has a healthcheck |
| `starting` | healthcheck reported starting |
| `stopped` | exited(0), created, paused, or a declared port with nothing listening |
| `stuck` | exited non-zero, restart loop, unhealthy, OOM-killed |
| `unknown` | declared, nothing observable either way |

Per project: `live` / `degraded` / `stopped` / `stuck` / `unknown`.

**`stopped` is a state, not an alert.** Only `stuck` and `degraded` are alerts.
The portal maps `stuck` onto its own `down` and mirrors the same rule — see
`portal-next/web/src/lib/projects.ts` and the truth table in
`portal-next/checks/`.

A declaration **wins over discovery** for the same container: `mpeg-redis` and
`mpeg-keycloak` are started by `docker run` with no compose labels, so discovery
files them under `unmanaged` infra. The declaration knows better, and keeping
both copies would double-count them in every total.

## Notes

- A missing `projects.json` is a supported state, not an error — the portal
  silently renders nothing extra, and the absence is never surfaced as a warning.
- Two host processes cannot be told apart by port alone. A port that is listening
  is "up" even if the wrong thing is listening on it; that is the accepted limit
  of a connect probe.
- "Not listening" is reported as `stopped`, never `stuck`. From outside there is
  no way to distinguish "not started" from "crashed", and guessing "crashed" is
  the exact mistake that made every idle project an alert.
