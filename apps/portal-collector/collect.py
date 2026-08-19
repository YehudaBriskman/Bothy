#!/usr/bin/env python3
"""Portal collector - turns project declarations + host truth into projects.json.

WHY THIS EXISTS
---------------
The portal is a static SPA. It can only render what is served to it,
and what is served to it is the live Docker container list and the Traefik router
table. That means it can only see a project once the project is already running
as a container or already routed through the edge - so:

  * a project that is switched OFF is invisible (nothing to discover), and
  * a project made of plain host processes (a `just dev` / `tilt up` harness) is
    invisible even while it runs, because it is neither a container nor a route.

It also means the portal has no notion of INTENT. It observes "not running" and
has no way to tell "somebody stopped this on purpose" from "this crashed", which
is why five deliberately-stopped containers used to render as five alerts.

This collector fixes both by running where the truth is - on the host. It reads
each project's own `project.dev.yml` (identity + what the project expects to be
running), probes host ports directly, reads container exit codes and restart
counts, and writes a single projects.json the portal fetches.

A PORT IS AN ADDRESS, NOT AN IDENTITY
-------------------------------------
The first version of this file decided a declared host service was up by
TCP-connecting to its declared port. That probe cannot fail in the way it claims
to: it answers "is ANYTHING listening", and then reports the answer as "is MY
SERVICE listening".

On 2026-08-12 the stack published Keycloak on 8083. The stopped project `Shvil
TV` declares `tv-player-web` on 8083, so the collector connected, found
somebody home, and wrote `tv-player-web: up, "listening on :8083"` - promoting a
project nobody had started from `stopped` to `degraded`. Keycloak has since moved
to 8090, which removes the symptom and not the bug.

So the probe now IDENTIFIES the listener instead of merely reaching it. It runs
on the host as devssh, in the docker group, so it can see far more than a
connect() result. Strongest evidence first:

  1. Is the port published by a container? Then compare that container against
     the declaration - is it a container this project names, does its compose
     `working_dir` sit inside the project root, does its compose project match
     the project's own identity? Same project -> up. Different project ->
     COLLISION.
  2. Otherwise, is a host process holding it? `ss -ltnp` gives the PID for
     processes devssh owns (which is what a `just dev` harness is), and /proc
     gives its cmdline, exe and cwd. Referencing the project root or the service
     name -> up. Positively identified as something else -> COLLISION.
  3. Neither? Then the honest answer is `unverified`: something is listening and
     this collector cannot say what. That is a statement about the collector's
     knowledge, and it is never a pass.

STATES
------
Per service:
  up         - running, and healthy if it declares a healthcheck
  starting   - health reported as starting
  stopped    - off cleanly: exited(0), created, paused, or a declared host port
               with nothing listening. NOT an alert.
  stuck      - exited non-zero, restart-looping, unhealthy, or OOM-killed.
  collision  - the declared port is held, and held by something that is
               provably NOT this service. This service is therefore not
               running, and the port is not free either.
  unverified - the declared port is held by something this collector could not
               identify. Not up, not down: unmeasured.
  unknown    - declared, but nothing could be observed either way.

Per project (rollup): live / degraded / stopped / stuck / unknown - deliberately
unchanged, so the portal never meets a project state it has no word for.
`collision` counts as off (we have positive evidence the service is not running),
`unverified` counts as unmeasured.

The rule that matters: `stopped` is a state, not a failure. Only `stuck` and
`degraded` are alerts - and a squatted port never manufactures one.
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

# Where projects live. Scanned a few levels deep because repos are grouped
# (~/projects/army/monorepo-inherited), not flat.
PROJECT_ROOTS = [Path.home() / "projects"]
SCAN_DEPTH = 3
DECL_NAME = "project.dev.yml"

OUT = Path(
    os.environ.get(
        "PORTAL_COLLECTOR_OUT",
        str(Path.home() / "stacks/apps/portal-next/data/projects.json"),
    )
)

PROBE_TIMEOUT = float(os.environ.get("PORTAL_COLLECTOR_PROBE_TIMEOUT", "0.35"))

# ── host truth ───────────────────────────────────────────────────────────────


@dataclass
class HostTruth:
    """Everything observed about the box, gathered once per run.

    `containers` answers "what is this container doing"; `port_containers` and
    `listeners` answer the question the old probe could not: "who is holding this
    port". They are separate maps because they come from different authorities -
    Docker knows its own published ports, the kernel knows every listening socket.
    """

    containers: dict[str, dict[str, Any]] = field(default_factory=dict)
    # host port -> containers publishing it (a port can only really have one, but
    # v4 and v6 bindings both appear and a stale entry should not crash a probe).
    port_containers: dict[int, list[dict[str, Any]]] = field(default_factory=dict)
    # host port -> processes listening on it, as far as devssh is allowed to see.
    listeners: dict[int, list[dict[str, Any]]] = field(default_factory=dict)
    docker_ok: bool = False


def find_declarations() -> list[Path]:
    found: list[Path] = []
    for root in PROJECT_ROOTS:
        if not root.is_dir():
            continue
        for depth in range(1, SCAN_DEPTH + 1):
            found.extend(root.glob("/".join(["*"] * depth) + f"/{DECL_NAME}"))
    return sorted(set(found))


# One inspect pass carries both jobs: the per-container state the rollup needs,
# and the compose identity + published ports the port probe needs to tell "my
# service" from "somebody else's service on my port".
DOCKER_FMT = "\t".join([
    "{{.Name}}",
    "{{.State.Status}}",
    "{{.State.ExitCode}}",
    "{{.RestartCount}}",
    "{{.State.OOMKilled}}",
    "{{if .State.Health}}{{.State.Health.Status}}{{end}}",
    '{{index .Config.Labels "com.docker.compose.project"}}',
    '{{index .Config.Labels "com.docker.compose.service"}}',
    '{{index .Config.Labels "com.docker.compose.project.working_dir"}}',
    "{{json .NetworkSettings.Ports}}",
])


def docker_state() -> tuple[dict[str, dict[str, Any]], dict[int, list[dict[str, Any]]], bool]:
    """(container states, host port -> publishing containers, docker reachable).

    A missing compose label renders as an empty string, not an error, so a
    `docker run` container (mpeg-redis, mpeg-keycloak) simply has no compose
    identity - which is itself a fact the matcher uses.
    """
    try:
        names = subprocess.run(
            ["docker", "ps", "-a", "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout.split()
        if not names:
            # Docker answered; it simply has no containers. That is reachable.
            return {}, {}, True
        out = subprocess.run(
            ["docker", "inspect", "--format", DOCKER_FMT, *names],
            capture_output=True, text=True, timeout=15, check=True,
        ).stdout
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return {}, {}, False

    states: dict[str, dict[str, Any]] = {}
    ports: dict[int, list[dict[str, Any]]] = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 6:
            continue
        name, status, exit_code, restarts, oom, health = parts[:6]
        name = name.lstrip("/")
        states[name] = {
            "status": status,
            "exitCode": int(exit_code) if exit_code.lstrip("-").isdigit() else None,
            "restarts": int(restarts) if restarts.isdigit() else 0,
            "oomKilled": oom == "true",
            "health": health or None,
        }
        # Only a running container actually holds a port. A stopped one keeps its
        # port map in the inspect output and would otherwise claim ports it long
        # since released.
        if len(parts) < 10 or status != "running":
            continue
        compose_project, compose_service, working_dir, ports_json = parts[6:10]
        try:
            bindings = json.loads(ports_json) or {}
        except (ValueError, TypeError):
            continue
        owner = {
            "container": name,
            "composeProject": compose_project or None,
            "composeService": compose_service or None,
            "workingDir": working_dir or None,
        }
        for binds in (bindings or {}).values():
            for bind in binds or []:
                hp = as_port(bind.get("HostPort"))
                # Same container appears once per v4/v6 binding; record it once.
                if hp is not None and not any(
                    o["container"] == name for o in ports.setdefault(hp, [])
                ):
                    ports[hp].append(owner)
    return states, ports, True


# `ss -ltnp` prints the owning process only for sockets devssh is allowed to see
# - its own. That asymmetry is a feature here: a declared host service IS a
# devssh process, so "listening but no PID visible" is itself evidence that the
# listener is not this project's harness (though not enough to name it).
SS_PROC_RE = re.compile(r'\("([^"]+)",pid=(\d+),')


def listening_sockets() -> dict[int, list[dict[str, Any]]]:
    """Host port -> listening processes, enriched from /proc where readable."""
    try:
        out = subprocess.run(
            ["ss", "-ltnpH"], capture_output=True, text=True, timeout=5, check=True,
        ).stdout
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return {}

    found: dict[int, list[dict[str, Any]]] = {}
    for line in out.splitlines():
        cols = line.split()
        # State Recv-Q Send-Q Local:Port Peer:Port [users:(...)]
        if len(cols) < 4:
            continue
        local = cols[3]
        if ":" not in local:
            continue
        port = as_port(local.rsplit(":", 1)[1])
        if port is None:
            continue
        procs = found.setdefault(port, [])
        for comm, pid_s in SS_PROC_RE.findall(line):
            pid = int(pid_s)
            if any(p["pid"] == pid for p in procs):
                continue
            procs.append({"pid": pid, "comm": comm, **proc_details(pid)})
    return found


def proc_details(pid: int) -> dict[str, Any]:
    """cmdline / exe / cwd for a PID, each independently optional.

    /proc/<pid>/cmdline is world-readable; exe and cwd are not. Reading them
    separately means a process we can only half-see still contributes the half we
    can see, instead of collapsing to "unknown".
    """
    detail: dict[str, Any] = {"cmdline": None, "exe": None, "cwd": None}
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
        detail["cmdline"] = raw.replace(b"\0", b" ").decode("utf-8", "replace").strip() or None
    except OSError:
        pass
    for key in ("exe", "cwd"):
        try:
            detail[key] = os.readlink(f"/proc/{pid}/{key}")
        except OSError:
            pass
    return detail


def port_open(port: int) -> bool:
    """TCP-connect probe. A listening socket is the only proof a host process is
    actually serving - a live PID that has not bound yet is not up.

    This says something is REACHABLE, never that it is the right something; the
    identification is done by `port_verdict` below. Both address families are
    tried because a harness may bind only one of them."""
    for family, addr in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.settimeout(PROBE_TIMEOUT)
                if s.connect_ex((addr, port)) == 0:
                    return True
        except OSError:
            continue
    return False


# ── declaration parsing ──────────────────────────────────────────────────────

# Case-insensitive on purpose. A declaration's ${VAR} names a key in that
# project's OWN port file, so the collector must not dictate how the project
# spells it: Shvil TV's .dev-ports.env writes TV_PLAYER_WEB_PORT, while Thales'
# manifests/.ports.lock writes `frontend=5173`. Uppercase-only silently left
# `${frontend}` unsubstituted, as_port() then failed, and every host service in
# that project reported `unknown / nothing to observe` while it was running.
# Widening only ever matches more, so no existing declaration changes meaning.
VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def load_ports_file(base: Path, rel: str | None) -> dict[str, str]:
    """A project's port assignment (KEY=VALUE lines). Lets a declaration say
    ${TV_PLAYER_WEB_PORT} and follow a harness that picks free ports at runtime
    instead of hard-coding one that may have moved."""
    if not rel:
        return {}
    path = (base / rel).resolve()
    if not path.is_file():
        return {}
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        values[k.strip()] = v.strip().strip("'\"")
    return values


def resolve(value: Any, vars: dict[str, str]) -> Any:
    if not isinstance(value, str):
        return value
    missing = False

    def sub(m: re.Match[str]) -> str:
        nonlocal missing
        got = vars.get(m.group(1))
        if got is None:
            missing = True
            return ""
        return got

    out = VAR_RE.sub(sub, value)
    return None if missing else out


def as_port(value: Any) -> int | None:
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return port if 0 < port < 65536 else None


# ── identity: is this MY service on that port? ───────────────────────────────


def norm(value: Any) -> str:
    """Fold a name to a comparable token: 'Shvil TV' -> 'shvil-tv'."""
    return re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")


@dataclass
class Identity:
    """Everything that can vouch for a container or process belonging to a project.

    Built once per declaration. The point of collecting several independent
    signals is that any single one is defeatable - a compose project name can be
    overridden, a harness can be launched from anywhere - but a listener that
    matches NONE of them is genuinely someone else's.
    """

    root: Path
    tokens: set[str]                 # names this project answers to
    containers: set[str]             # container names this project declares


def project_identity(raw: dict[str, Any], base: Path, services_raw: list[Any]) -> Identity:
    try:
        root = base.resolve()
    except OSError:
        root = base
    tokens = {
        norm(base.name),
        norm(raw.get("key")),
        norm(raw.get("name")),
        norm(raw.get("log_stream")),
    }
    containers = {
        str(s["container"]) for s in services_raw
        if isinstance(s, dict) and s.get("container")
    }
    return Identity(root=root, tokens={t for t in tokens if t}, containers=containers)


def under(path: str | None, root: Path) -> bool:
    """Is `path` the project root or inside it? Compared on resolved paths so a
    symlinked checkout does not read as a stranger."""
    if not path:
        return False
    try:
        candidate = Path(path).resolve()
    except OSError:
        return False
    return candidate == root or root in candidate.parents


def container_verdict(owner: dict[str, Any], ident: Identity, svc_name: str) -> tuple[bool, str]:
    """(is it ours, why). Ordered strongest evidence first."""
    if owner["container"] in ident.containers:
        return True, f"container {owner['container']} is declared by this project"
    if under(owner["workingDir"], ident.root):
        return True, (
            f"container {owner['container']} was composed from {owner['workingDir']}, "
            "inside this project"
        )
    project = owner["composeProject"]
    if project and norm(project) in ident.tokens:
        return True, f"container {owner['container']} is in compose project '{project}'"
    if project and norm(owner["composeService"] or "") == norm(svc_name) \
            and norm(project) in ident.tokens:
        return True, f"container {owner['container']} is compose service '{svc_name}'"
    where = f"compose project '{project}'" if project else "no compose project"
    return False, f"held by container {owner['container']} ({where})"


def process_verdict(proc: dict[str, Any], ident: Identity, svc_name: str) -> tuple[bool | None, str]:
    """(ours / not ours / cannot tell, why).

    `None` is the important return: a process we can see the PID of but cannot
    characterise is NOT evidence of a collision, and must never be reported as
    one. Only a process we positively located somewhere else earns that.
    """
    cmdline, cwd, exe = proc.get("cmdline"), proc.get("cwd"), proc.get("exe")
    root = str(ident.root)

    # Strongest: the command line names the project root or the service itself.
    if cmdline and root in cmdline:
        return True, f"pid {proc['pid']} runs from {root}"
    if cmdline and norm(svc_name) and norm(svc_name) in norm(cmdline):
        return True, f"pid {proc['pid']} command line names {svc_name}"
    if cmdline and any(t in norm(cmdline) for t in ident.tokens):
        return True, f"pid {proc['pid']} command line names this project"
    # Weaker but the signature of a `just dev` harness: launched inside the repo.
    if under(cwd, ident.root):
        return True, f"pid {proc['pid']} ({proc['comm']}) has cwd inside {root}"
    if under(exe, ident.root):
        return True, f"pid {proc['pid']} executes a binary inside {root}"

    # Not ours by any signal. Only call it a collision if we actually located the
    # process somewhere else - otherwise we are guessing, and a wrong `collision`
    # is the same category of error as the wrong `up` this replaced.
    located = (cwd and not under(cwd, ident.root)) or (exe and not under(exe, ident.root))
    if located and cmdline:
        return False, f"held by pid {proc['pid']} ({proc['comm']}), unrelated to this project"
    return None, f"held by pid {proc['pid']} ({proc['comm']}), which could not be identified"


def port_verdict(
    port: int, svc_name: str, ident: Identity, truth: HostTruth,
) -> tuple[str, str, dict[str, Any] | None]:
    """(state, detail, collision) for a declared host port that IS listening.

    The ladder, strongest authority first: Docker knows what it published, the
    kernel knows what else is bound, and if neither can name the listener the
    answer is `unverified` rather than a pass.
    """
    # A port can have more than one listener - a v4 and a v6 process, or
    # SO_REUSEPORT siblings. Scan them ALL for a positive identification before
    # concluding anything negative: finding our own service is proof it is up,
    # whereas a stranger next to it only proves the port is shared.
    owners = truth.port_containers.get(port, [])
    verdicts = [(o, *container_verdict(o, ident, svc_name)) for o in owners]
    for owner, ours, why in verdicts:
        if ours:
            return "up", f"listening on :{port} - {why}", None
    if verdicts:
        owner, _, why = verdicts[0]
        return "collision", f":{port} {why}", {
            "port": port,
            "kind": "container",
            "holder": owner["container"],
            "composeProject": owner["composeProject"],
            "pid": None,
            "evidence": why,
        }

    procs = [(p, *process_verdict(p, ident, svc_name)) for p in truth.listeners.get(port, [])]
    for proc, ours, why in procs:
        if ours:
            return "up", f"listening on :{port} - {why}", None
    # No process here is ours. Prefer a positively-located stranger (a real
    # collision) over one we merely failed to characterise (`unverified`).
    for proc, ours, why in procs:
        if ours is False:
            return "collision", f":{port} {why}", {
                "port": port,
                "kind": "process",
                "holder": proc["comm"],
                "composeProject": None,
                "pid": proc["pid"],
                "evidence": why,
            }
    if procs:
        _, _, why = procs[0]
        return "unverified", f":{port} {why}", None

    # Something accepted a connection, yet neither Docker nor the kernel would
    # name it - the socket belongs to another user, or docker is unreachable.
    reason = (
        "no container publishes it and its process is not visible to this collector"
        if truth.docker_ok else
        "docker is unreachable and its process is not visible to this collector"
    )
    return "unverified", f"something is listening on :{port}, {reason}", None


# ── state machine ────────────────────────────────────────────────────────────

# Docker states that mean "off on purpose" vs "something went wrong". `exited`
# is decided by its exit code, so it is in neither list.
CLEAN_STATES = {"created", "paused", "exited"}
STUCK_STATES = {"restarting", "dead", "removing"}

# Exit codes that mean "a signal Docker itself sent", not "the program failed":
# 143 = 128+SIGTERM (what `docker stop` sends), 137 = 128+SIGKILL (what it sends
# when the stop timeout expires). Whether a clean stop lands on 0 or on 143 is a
# property of the *application's* shutdown code, not of whether anything went
# wrong - redis installs a SIGTERM handler and exits 0, the Keycloak JVM does not
# and exits 143. Judging them differently made a stopped project read as broken.
# An OOM kill is also 137 but is classified above via `oomKilled`, so a 137
# reaching this set is a stop-timeout, not a memory kill.
SIGNAL_EXITS = {137, 143}


def service_state(svc: dict[str, Any], truth: HostTruth, ident: Identity) -> dict[str, Any]:
    name = str(svc.get("name") or "service")
    container_name = svc.get("container")
    port = as_port(svc.get("host_port"))

    state = "unknown"
    detail = "nothing to observe"
    collision: dict[str, Any] | None = None

    if container_name:
        c = truth.containers.get(str(container_name))
        if c is None and not truth.docker_ok:
            # Same bug class as the port probe: an empty container list because
            # docker never answered is not evidence the container is absent.
            state, detail = "unverified", "docker is unreachable - container state unknown"
        elif c is None:
            state, detail = "stopped", "container does not exist"
        else:
            status, health = c["status"], c["health"]
            if status == "running":
                if health == "unhealthy":
                    state, detail = "stuck", "healthcheck failing"
                elif health == "starting":
                    state, detail = "starting", "healthcheck starting"
                else:
                    state, detail = "up", "running"
            elif c["oomKilled"]:
                state, detail = "stuck", "OOM-killed"
            elif status in STUCK_STATES:
                state, detail = "stuck", f"container {status}"
            elif status == "exited" and c["exitCode"] and c["exitCode"] not in SIGNAL_EXITS:
                state, detail = "stuck", f"exited with code {c['exitCode']}"
            # Stopped by signal. Not a failure, but say which - a 137 means the
            # container ignored SIGTERM until Docker's stop timeout ran out, which
            # is worth knowing without being worth an alert.
            elif status == "exited" and c["exitCode"] in SIGNAL_EXITS:
                sig = "SIGTERM" if c["exitCode"] == 143 else "SIGKILL after stop timeout"
                state, detail = "stopped", f"stopped by {sig}"
            elif status in CLEAN_STATES:
                state, detail = "stopped", "stopped cleanly"
            else:
                state, detail = "unknown", f"container {status}"
            # A crash loop reads as "running" between restarts; the counter is
            # the only thing that gives it away.
            if c["restarts"] >= 3 and state == "up":
                state, detail = "stuck", f"restarted {c['restarts']} times"

    elif port is not None:
        if port_open(port):
            # Reachable is not the same as ours. Ask who is actually holding it
            # before calling this service up - the whole point of this file.
            state, detail, collision = port_verdict(port, name, ident, truth)
        else:
            # A declared host process that is not listening is simply off. We
            # cannot distinguish "not started" from "crashed" from outside, and
            # guessing "crashed" is what turned every stopped project into an
            # alert in the first place.
            state, detail = "stopped", f"nothing listening on :{port}"

    return {
        "name": name,
        "description": svc.get("description"),
        "type": svc.get("type") or "runtime",
        "ui": bool(svc.get("ui")),
        "container": container_name,
        "port": port,
        "state": state,
        "detail": detail,
        # Additive: consumers that do not know the field ignore it, and the two
        # new `state` values fall through the portal's own `?? 'unknown'` guard.
        # Always emitted (null when there is none) so the shape never varies.
        "collision": collision,
    }


def log_source(svc: dict[str, Any], project_stream: str | None) -> dict[str, Any] | None:
    """Where to find this service's logs in Loki.

    Two shapes, because the box has two kinds of service:
      * container - promtail's docker_sd already ships it under {container="…"},
        and Loki keeps it after the container stops, which `docker logs` cannot.
      * host process - no container to scrape, so the project tees its output to
        ~/.local/state/devbox-logs/<stream>.log and promtail's host-processes job
        labels it {host_service="<stream>"}. One file usually carries several
        services (turbo prefixes each line), so `log_filter` narrows it.
    """
    if svc.get("container"):
        return {"kind": "container", "selector": f'{{container="{svc["container"]}"}}', "filter": None}
    if project_stream:
        return {
            "kind": "host",
            "selector": f'{{host_service="{project_stream}"}}',
            "filter": svc.get("log_filter") or None,
        }
    return None


def rollup(services: list[dict[str, Any]]) -> str:
    """Project state. Deliberately NOT worst-wins: a project with nothing running
    is `stopped`, which is a state and not an alert. Only a project that has
    something wrong while it is meant to be up gets an alerting state.

    The vocabulary is deliberately unchanged, so the portal never meets a project
    state it has no word for. `collision` folds in with `stopped`: a port held by
    somebody else is positive evidence that this service is NOT running, so the
    project really is off - which is exactly the promotion to `degraded` that the
    old connect-probe caused and this rework removes. `unverified` folds in with
    unknown, because that is what it is."""
    if not services:
        return "unknown"
    states = [s["state"] for s in services]
    running = sum(1 for s in states if s in ("up", "starting"))
    stuck = sum(1 for s in states if s == "stuck")

    if stuck and running:
        return "degraded"
    if stuck:
        return "stuck"
    if running == len(states):
        return "live"
    if running:
        return "degraded"
    if all(s in ("stopped", "collision") for s in states):
        return "stopped"
    return "unknown"


# ── main ─────────────────────────────────────────────────────────────────────


def collect_project(decl_path: Path, truth: HostTruth) -> dict[str, Any] | None:
    try:
        raw = yaml.safe_load(decl_path.read_text()) or {}
    except (OSError, yaml.YAMLError) as exc:
        return {
            "key": decl_path.parent.name,
            "name": decl_path.parent.name,
            "kind": "project",
            "root": str(decl_path.parent),
            "error": f"could not read {DECL_NAME}: {exc}",
            "state": "unknown",
            "services": [],
        }
    if not isinstance(raw, dict):
        return None

    base = decl_path.parent
    vars = load_ports_file(base, raw.get("ports_file"))
    services_raw = raw.get("services") or []
    ident = project_identity(raw, base, services_raw)

    stream = raw.get("log_stream")
    services = []
    for svc in services_raw:
        if not isinstance(svc, dict):
            continue
        resolved = {k: resolve(v, vars) for k, v in svc.items()}
        entry = service_state(resolved, truth, ident)
        entry["logs"] = log_source(resolved, stream)
        services.append(entry)

    return {
        "key": raw.get("key") or base.name,
        "name": raw.get("name") or base.name,
        "kind": raw.get("kind") or "project",
        "description": raw.get("description"),
        "root": str(base),
        "start": raw.get("start"),
        "state": rollup(services),
        "services": services,
    }


def main() -> int:
    containers, port_containers, docker_ok = docker_state()
    truth = HostTruth(
        containers=containers,
        port_containers=port_containers,
        listeners=listening_sockets(),
        docker_ok=docker_ok,
    )
    projects = []
    for decl in find_declarations():
        got = collect_project(decl, truth)
        if got:
            projects.append(got)
    projects.sort(key=lambda p: p["name"].lower())

    payload = {
        "generatedAt": int(time.time()),
        "source": "portal-collector",
        "dockerReachable": docker_ok,
        "projects": projects,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    # Atomic: the portal polls this file and must never read a half-written one.
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n")
    tmp.replace(OUT)

    if sys.stdout.isatty():
        for p in projects:
            counts = ", ".join(f"{s['name']}={s['state']}" for s in p["services"])
            print(f"{p['state']:9} {p['name']:20} {counts}")
            # A collision is somebody else's mistake landing on this project, so
            # say who - the state alone is not actionable.
            for s in p["services"]:
                if s.get("collision"):
                    print(f"{'':9} └─ {s['name']}: {s['detail']}")
        print(f"\nwrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
