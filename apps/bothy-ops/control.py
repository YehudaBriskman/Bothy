"""The Control half of bothy-ops - three verbs on a container, and nothing else.

    POST /control/restart   {"container": "grafana"}
    POST /control/stop      {"container": "grafana"}
    POST /control/start     {"container": "grafana"}

The response shape is `ActionResult` in apps/bothy-web/web/src/lib/actions.ts:

    {ok, container, verb, from, to, tookMs}

`from` and `to` are the container's state before and after, so the result reads
as a TRANSITION. That is why both inspects are here rather than left to the
client: a UI that has to poll to find out what its own action did shows a
spinner during the gap and guesses wrong about a container that was already in
the target state. `from == to` is a complete and honest answer.

── the two proxies, and why there are two ───────────────────────────────────

Fully argued in apps/bothy/socket-proxy.yml. The short version, because it
shapes every request below: the READ proxy has POST=0 and can therefore never
mutate anything, and the WRITE proxy has CONTAINERS=0 and can therefore never
reach /containers/create or read a container's Env. Neither alone is dangerous,
which is why the inspects and the action go to different addresses.

── what this deliberately cannot do ─────────────────────────────────────────

`exec`, `create`, `rm`, image pulls, volume operations, anything under /build.
Those are `just` recipes and a Tailscale SSH session and they stay there.
Portainer could exec into a container from a browser and this never will; the
replacement is `docker exec` over Tailscale SSH.
"""

from __future__ import annotations

import http.client
import json
import os
import sys
import time
from urllib.parse import urlparse

import guard
from bothy_common.audit import AuditLog

# The two socket proxies, by container name. Split on purpose - see above.
DOCKER_READ = os.environ.get("DOCKER_READ", "http://bothy-socket-read:2375")
DOCKER_WRITE = os.environ.get("DOCKER_WRITE", "http://bothy-socket-write:2375")

# Pinned rather than negotiated, so the paths this builds are the paths the
# socket proxy's regexes were read against - the thing that would otherwise
# drift silently under an engine upgrade. 1.41 covers inspect, start, stop and
# restart and has been stable since Docker 20.10.
API = "/v1.41"

# ── timeouts ────────────────────────────────────────────────────────────────
#
# An inspect is a local read; a hang there means the proxy is wedged.
#
# An ACTION is not bounded by this service at all. `stop` sends SIGTERM and then
# waits for the container's own StopTimeout before SIGKILL, and `restart` pays
# that and then a start. So the ceiling must be well above anything a container
# can legitimately take, or a slow-but-successful stop is reported as a failure
# while the daemon goes on and does it anyway. Measured: `docker restart` on a
# plain `alpine sleep 300` takes 10.3 SECONDS, because PID 1 has no SIGTERM
# handler - the common case, not the exotic one (checks/transition.py times it).
#
# No `t=` is sent on stop or restart: StopTimeout is a property of the
# container, declared by whoever knows what it needs to flush.
INSPECT_TIMEOUT = 10
ACTION_TIMEOUT = 180

# A verb in the path and one container name. 8 KB is already absurd for that.
MAX_BODY = 8_192

LOG = AuditLog(os.environ.get("AUDIT_LOG", "/audit/actions.log"))


class DaemonError(Exception):
    """The daemon or a proxy said no. Carries the status to report it with."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


def audit(who: str, outcome: str, verb: str, container: str,
          detail: str = "", took_ms: int | None = None) -> None:
    """Every action this service is ASKED to perform - refusals included.

        time  who  ACTED|REFUSED|FAILED|ERROR  verb  container  [detail]  [Nms]

    Asked, not performed: "who tried to stop traefik and got told no" is as much
    a question for this log as the restarts that worked.
    """
    fields: list[object] = [who, outcome, verb, container]
    if detail:
        fields.append(detail)
    if took_ms is not None:
        fields.append(f"{took_ms}ms")
    LOG.write(*fields)


def _call(base: str, method: str, path: str, timeout: int) -> tuple[int, bytes]:
    """One request to one socket proxy. No retries, deliberately.

    A retry on a POST would be a second stop, and the first may have succeeded
    with its response lost. Not retrying fails as an error message; retrying
    fails as an action nobody asked for twice.
    """
    u = urlparse(base)
    conn = http.client.HTTPConnection(u.hostname or "", u.port or 80, timeout=timeout)
    try:
        conn.request(method, path, headers={"Host": u.hostname or "docker",
                                            "Accept": "application/json"})
        resp = conn.getresponse()
        return resp.status, resp.read()
    except (OSError, http.client.HTTPException) as e:
        # Named by which proxy: "connection refused" alone sends somebody to the
        # daemon when the answer is that one 32 MB haproxy is down.
        raise DaemonError(f"cannot reach {u.hostname}: {type(e).__name__}") from e
    finally:
        conn.close()


def inspect(container: str) -> tuple[str, str]:
    """(canonical name, state) for a container, through the READ proxy.

    The daemon's own name, not the caller's string, and that is load-bearing.
    The API accepts a name OR an id OR any unambiguous id prefix, so a deny list
    checked against the caller's string is sidestepped by naming traefik by its
    id. Canonicalising first means the deny check and the POST both run against
    the one identity the daemon agrees on.
    """
    status, body = _call(DOCKER_READ, "GET", f"{API}/containers/{container}/json",
                         INSPECT_TIMEOUT)
    if status == 404:
        raise DaemonError(f"no container named {container!r}", status=404)
    if status != 200:
        raise DaemonError(f"inspect failed ({status})", status=502)
    try:
        data = json.loads(body)
        # A leading slash - a legacy of the links namespace.
        name = str(data["Name"]).lstrip("/")
        state = str(data["State"]["Status"])
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        raise DaemonError(f"inspect returned something unexpected ({e})") from e
    # Re-validated even though it came from the daemon, because the next thing
    # that happens to it is interpolation into a URL. Cheap exactly because it
    # can never fire - and the day it fires is the day it mattered.
    return guard.valid_container(name), state


def perform(container: str, verb: str) -> tuple[int, int]:
    """Do the thing. Returns (docker status, milliseconds the DAEMON took)."""
    t0 = time.monotonic()
    status, body = _call(DOCKER_WRITE, "POST", f"{API}/containers/{container}/{verb}",
                         ACTION_TIMEOUT)
    took = int((time.monotonic() - t0) * 1000)

    # 204: done. 304: already in that state - a no-op, NOT an error; reported as
    # ok with from == to, which is the whole reason the contract carries both.
    if status in (204, 304):
        return status, took
    if status == 404:
        raise DaemonError(f"no container named {container!r}", status=404)
    if status == 403:
        # Should be unreachable - guard.VERBS is a subset of the write proxy's
        # grant - so if it fires, the grants and the allowlist have diverged.
        raise DaemonError(
            f"the socket proxy refused {verb} - its grants and this service's "
            "allowlist have diverged", status=502)
    detail = body.decode("utf-8", "replace")[:200].strip()
    raise DaemonError(f"docker refused {verb} ({status}): {detail}",
                      status=409 if status == 409 else 502)


def act(container: object, verb: str, who: str) -> dict:
    """The whole of it: check, read, do, read, log, answer."""
    guard.valid_container(container)
    assert isinstance(container, str)

    # A first deny check on the CALLER's string, before touching the daemon: the
    # common case (a click on the Traefik card) costs no round-trip, and still
    # refuses if the read proxy is the thing that is down.
    reason = guard.severed(container, verb)
    if reason:
        audit(who, "REFUSED", verb, container, reason)
        raise guard.Refused(reason, status=409)

    name, before = inspect(container)

    # THE check, against the daemon's canonical name.
    reason = guard.severed(name, verb)
    if reason:
        audit(who, "REFUSED", verb, name, reason)
        raise guard.Refused(reason, status=409)

    try:
        _, took_ms = perform(name, verb)
    except DaemonError as e:
        audit(who, "FAILED", verb, name, str(e))
        raise

    # `to` is read back rather than assumed: a container whose entrypoint exits
    # immediately reports `exited` a moment after a successful start, and a UI
    # told "running" because the API returned 204 would show a green dot on a
    # dead service.
    try:
        _, after = inspect(name)
    except DaemonError:
        after = "unknown"  # the action happened; only the read-back failed

    audit(who, "ACTED", verb, name, f"{before} -> {after}", took_ms)
    return {"ok": True, "container": name, "verb": verb,
            "from": before, "to": after, "tookMs": took_ms}


def handle(h, verb: str) -> None:
    """POST /control/<verb>. `h` is the bothy-ops JsonHandler."""
    who = "unknown"
    try:
        h.check_csrf("POST")
        guard.check_verb(verb)
        body = h.read_json_object(MAX_BODY)
        who = h.actor()
        return h._send(200, act(body.get("container"), verb, who))
    except guard.Refused as e:
        # No `needsRole` here, correctly: a request that reaches this process has
        # ALREADY passed sso-operator, so the only 403 meaning "you lack the role"
        # comes from oauth2-proxy at the edge, which does not speak this JSON.
        # lib/http.ts refusalOf() falls back to the status code.
        return h._send(e.status, {"error": str(e)})
    except DaemonError as e:
        return h._send(e.status, {"error": str(e)})
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"ERROR /control/{verb[:64]}: {type(e).__name__}: {e}\n")
        audit(who, "ERROR", verb[:64], "-", type(e).__name__)
        return h._send(500, {"error": "internal error"})
