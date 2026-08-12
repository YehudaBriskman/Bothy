# portal-collector

Turns each project's `project.dev.yml` into `projects.json` for the portal.

## Why it exists

The portal discovers two things: **Traefik routers** and **Docker containers**.
Everything it knows comes from one of those, which leaves two blind spots:

- **A project that is switched off has nothing to discover.** It doesn't show as
  "off" - it disappears from the box entirely.
- **A project made of host processes is invisible even while running.** A
  `just dev` / `tilt up` harness on ordinary ports is neither a container nor,
  unless somebody hand-wrote a file-route, a Traefik service.

And a third problem underneath both: the portal only ever recorded **observed
facts, never intent**. It saw "not running" and could not tell *somebody stopped
this* from *this crashed* - which is why five deliberately-stopped containers
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

1. Scans `~/projects` (3 levels deep - repos are grouped, not flat) for
   `project.dev.yml`.
2. Resolves `${VAR}` in the declaration against the project's own `ports_file`,
   so a harness that picks free ports at runtime is followed rather than probed
   at a stale address.
3. Determines each service's state - `docker inspect` for `container`, and for
   `host_port` the ownership ladder below (**not** a bare TCP connect).
4. Writes `projects.json` atomically (the portal polls it and must never read a
   half-written file).

Run by `portal-collector.timer` (user systemd) every 30s. The portal polls its
own data every 10s, so a project starting or stopping surfaces while you are
still looking at the page.

    systemctl --user status portal-collector.timer
    python3 collect.py          # run once by hand; prints a table when on a tty

## The declaration

`project.dev.yml` lives at a repo root - the project owns it, it travels with a
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

## A port is an address, not an identity

This collector used to decide a declared host service was up by TCP-connecting
to its declared port. That probe **cannot fail in the way it claims to**: it
answers *is anything listening*, and the answer was reported as *is my service
listening*.

On **2026-08-12** the stack published Keycloak on 8083. `Shvil TV` declares
`tv-player-web` on 8083 and the project was **stopped**. The collector connected,
found somebody home, and wrote:

    tv-player-web: state=up, detail="listening on :8083"

which promoted the whole project from `stopped` to `degraded`. The portal then
told the user in good faith that a service nobody had started was running.
Keycloak has since moved to 8090, which removes the symptom and not the bug.

So the probe now **identifies the listener** instead of merely reaching it. It
runs on the host as `devssh` in the `docker` group, so it can see far more than a
`connect()` result. Strongest evidence first:

| # | Question | Evidence | Verdict |
|---|---|---|---|
| 1 | Is the port published by a **container**? | the container is named by this declaration; or its `com.docker.compose.project.working_dir` is inside the project root; or its `com.docker.compose.project` matches the project's key / dir name / name | match → `up`, otherwise → **`collision`** |
| 2 | Is a **host process** holding it? | `ss -ltnp` gives the PID (for processes `devssh` owns - which is what a `just dev` harness is), then `/proc/<pid>/{cmdline,exe,cwd}`: the cmdline names the project root or the service, or the process was launched inside the repo | match → `up`; positively located elsewhere → **`collision`** |
| 3 | Neither could name it | - | **`unverified`** |

Rung 3 is the honest floor. `unverified` is a statement about *the collector's
knowledge*, not about the service, and **it is never a pass**. A listener whose
PID belongs to another user (root) is invisible to an unprivileged `ss`, and a
`collision` is only ever claimed when the holder was positively identified -
guessing "collision" would be the same class of error as the `up` it replaced.

`port_open()` still runs first and still probes IPv4 **and** IPv6; it is now the
*gate* ("is anything there at all"), never the verdict. A port with nothing
listening is still plain `stopped`.

The same reasoning was applied one layer over: if `docker` itself is unreachable,
a declared container reports `unverified` rather than "container does not exist" -
an empty container list because Docker never answered is not evidence of absence.

## States

Per service:

| State | Meaning |
|---|---|
| `up` | running, and healthy if it has a healthcheck |
| `starting` | healthcheck reported starting |
| `stopped` | exited(0), created, paused, or a declared port with nothing listening |
| `stuck` | exited non-zero, restart loop, unhealthy, OOM-killed |
| `collision` | the declared port is held by something **provably not this service**. The service is not running, and the port is not free either. |
| `unverified` | something is listening (or docker is unreachable) and the collector **could not identify it**. Not up, not down: unmeasured. |
| `unknown` | declared, nothing observable either way |

Per project: `live` / `degraded` / `stopped` / `stuck` / `unknown` - **deliberately
unchanged**, so the portal never meets a project state it has no word for. In the
rollup, `collision` folds in with `stopped` (a port held by somebody else is
positive evidence this service is *not* running, so the project really is off -
which is exactly the false promotion to `degraded` that this rework removes), and
`unverified` folds in with unknown.

**`stopped` is a state, not an alert.** Only `stuck` and `degraded` are alerts,
and **a squatted port never manufactures one**. The portal maps `stuck` onto its
own `down` and mirrors the same rule - see
`portal-next/web/src/lib/projects.ts` and the truth table in
`portal-next/checks/`.

### The `collision` field

Alongside the `collision` **state**, a colliding service carries a `collision`
**object** naming the culprit - the state alone is not actionable:

```json
{
  "name": "tv-player-web",
  "port": 8083,
  "state": "collision",
  "detail": ":8083 held by container portcheck-squatter (no compose project)",
  "collision": {
    "port": 8083,
    "kind": "container",          // "container" | "process"
    "holder": "portcheck-squatter",
    "composeProject": null,        // the OTHER project, when it has one
    "pid": null,                   // set when kind == "process"
    "evidence": "held by container portcheck-squatter (no compose project)"
  }
}
```

The key is **always present**, and `null` when there is no collision, so the shape
never varies.

**Both additions are safe for a portal that does not know about them yet**, which
is why they take this shape:

- the `collision` object is an *extra key* - a consumer that does not read it
  ignores it, as JSON consumers do;
- the two new `state` values fall through the portal's existing
  `STATE_TO_STATUS[svc.state] ?? 'unknown'` guard, so they render as `unknown`
  (which the portal already renders honestly) rather than crashing or, worse,
  defaulting to `up`. Because the portal only offers a UI link when the mapped
  status is `up`, neither state can ever produce a link to a port this project
  does not own.

A declaration **wins over discovery** for the same container: `mpeg-redis` and
`mpeg-keycloak` are started by `docker run` with no compose labels, so discovery
files them under `unmanaged` infra. The declaration knows better, and keeping
both copies would double-count them in every total.

## Notes

- A missing `projects.json` is a supported state, not an error - the portal
  silently renders nothing extra, and the absence is never surfaced as a warning.
- **Two host processes cannot be told apart by port alone** - which is why the
  collector no longer tries. This used to read "a port that is listening is up
  even if the wrong thing is listening on it; that is the accepted limit of a
  connect probe". It was not an acceptable limit: it is the 2026-08-12 incident
  above, and the standing rule here is that **every probe must be able to fail,
  and must distinguish the thing it claims to distinguish**. The limit that
  remains is narrower and is reported rather than assumed away - a listener owned
  by another user is invisible to an unprivileged `ss`, and that case is
  `unverified`, not `up`.
- "Not listening" is reported as `stopped`, never `stuck`. From outside there is
  no way to distinguish "not started" from "crashed", and guessing "crashed" is
  the exact mistake that made every idle project an alert.
