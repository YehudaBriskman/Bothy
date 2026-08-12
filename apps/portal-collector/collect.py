#!/usr/bin/env python3
"""Portal collector — turns project declarations + host truth into projects.json.

WHY THIS EXISTS
---------------
The portal (dev.test) is a static SPA. It can only render what is served to it,
and what is served to it is the live Docker container list and the Traefik router
table. That means it can only see a project once the project is already running
as a container or already routed through the edge — so:

  * a project that is switched OFF is invisible (nothing to discover), and
  * a project made of plain host processes (a `just dev` / `tilt up` harness) is
    invisible even while it runs, because it is neither a container nor a route.

It also means the portal has no notion of INTENT. It observes "not running" and
has no way to tell "somebody stopped this on purpose" from "this crashed", which
is why five deliberately-stopped containers used to render as five alerts.

This collector fixes both by running where the truth is — on the host. It reads
each project's own `project.dev.yml` (identity + what the project expects to be
running), probes host ports directly, reads container exit codes and restart
counts, and writes a single projects.json the portal fetches.

STATES
------
Per service:
  up       — running, and healthy if it declares a healthcheck
  starting — health reported as starting
  stopped  — off cleanly: exited(0), created, paused, or a declared host port
             with nothing listening. NOT an alert.
  stuck    — exited non-zero, restart-looping, unhealthy, or OOM-killed.
  unknown  — declared, but nothing could be observed either way.

Per project (rollup): live / degraded / stopped / stuck / unknown.
The rule that matters: `stopped` is a state, not a failure. Only `stuck` and
`degraded` are alerts.
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import time
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


def find_declarations() -> list[Path]:
    found: list[Path] = []
    for root in PROJECT_ROOTS:
        if not root.is_dir():
            continue
        for depth in range(1, SCAN_DEPTH + 1):
            found.extend(root.glob("/".join(["*"] * depth) + f"/{DECL_NAME}"))
    return sorted(set(found))


def docker_state() -> dict[str, dict[str, Any]]:
    """Container name -> state fields. Empty dict if docker is unreachable."""
    fmt = (
        "{{.Name}}\t{{.State.Status}}\t{{.State.ExitCode}}\t{{.RestartCount}}"
        "\t{{.State.OOMKilled}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}"
    )
    try:
        names = subprocess.run(
            ["docker", "ps", "-a", "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout.split()
        if not names:
            return {}
        out = subprocess.run(
            ["docker", "inspect", "--format", fmt, *names],
            capture_output=True, text=True, timeout=15, check=True,
        ).stdout
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return {}

    states: dict[str, dict[str, Any]] = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 6:
            continue
        name, status, exit_code, restarts, oom, health = parts[:6]
        states[name.lstrip("/")] = {
            "status": status,
            "exitCode": int(exit_code) if exit_code.lstrip("-").isdigit() else None,
            "restarts": int(restarts) if restarts.isdigit() else 0,
            "oomKilled": oom == "true",
            "health": health or None,
        }
    return states


def port_open(port: int) -> bool:
    """TCP-connect probe. A listening socket is the only proof a host process is
    actually serving — a live PID that has not bound yet is not up."""
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

VAR_RE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}")


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


# ── state machine ────────────────────────────────────────────────────────────

# Docker states that mean "off on purpose" vs "something went wrong". `exited`
# is decided by its exit code, so it is in neither list.
CLEAN_STATES = {"created", "paused", "exited"}
STUCK_STATES = {"restarting", "dead", "removing"}

# Exit codes that mean "a signal Docker itself sent", not "the program failed":
# 143 = 128+SIGTERM (what `docker stop` sends), 137 = 128+SIGKILL (what it sends
# when the stop timeout expires). Whether a clean stop lands on 0 or on 143 is a
# property of the *application's* shutdown code, not of whether anything went
# wrong — redis installs a SIGTERM handler and exits 0, the Keycloak JVM does not
# and exits 143. Judging them differently made a stopped project read as broken.
# An OOM kill is also 137 but is classified above via `oomKilled`, so a 137
# reaching this set is a stop-timeout, not a memory kill.
SIGNAL_EXITS = {137, 143}


def service_state(svc: dict[str, Any], containers: dict[str, dict[str, Any]]) -> dict[str, Any]:
    name = str(svc.get("name") or "service")
    container_name = svc.get("container")
    port = as_port(svc.get("host_port"))

    state = "unknown"
    detail = "nothing to observe"

    if container_name:
        c = containers.get(str(container_name))
        if c is None:
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
            # Stopped by signal. Not a failure, but say which — a 137 means the
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
            state, detail = "up", f"listening on :{port}"
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
    }


def log_source(svc: dict[str, Any], project_stream: str | None) -> dict[str, Any] | None:
    """Where to find this service's logs in Loki.

    Two shapes, because the box has two kinds of service:
      * container — promtail's docker_sd already ships it under {container="…"},
        and Loki keeps it after the container stops, which `docker logs` cannot.
      * host process — no container to scrape, so the project tees its output to
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
    something wrong while it is meant to be up gets an alerting state."""
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
    if all(s == "stopped" for s in states):
        return "stopped"
    return "unknown"


# ── main ─────────────────────────────────────────────────────────────────────


def collect_project(decl_path: Path, containers: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
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

    stream = raw.get("log_stream")
    services = []
    for svc in services_raw:
        if not isinstance(svc, dict):
            continue
        resolved = {k: resolve(v, vars) for k, v in svc.items()}
        entry = service_state(resolved, containers)
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
    containers = docker_state()
    projects = []
    for decl in find_declarations():
        got = collect_project(decl, containers)
        if got:
            projects.append(got)
    projects.sort(key=lambda p: p["name"].lower())

    payload = {
        "generatedAt": int(time.time()),
        "source": "portal-collector",
        "dockerReachable": bool(containers),
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
        print(f"\nwrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
