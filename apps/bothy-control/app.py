#!/usr/bin/env python3
"""bothy-control - three verbs on a container, and nothing else.

    POST /control/restart   {"container": "grafana"}
    POST /control/stop      {"container": "grafana"}
    POST /control/start     {"container": "grafana"}

The response shape is `ActionResult` in apps/portal-next/web/src/lib/actions.ts,
which was written before either side of it existed and is the contract this file
satisfies rather than one it proposes:

    {ok, container, verb, from, to, tookMs}

`from` and `to` are the container's state before and after, so the result reads
as a TRANSITION. That is the reason both inspects are here rather than left to
the client: a UI that has to poll to find out what its own action did will show
a spinner during the gap and will guess wrong about a container that was already
in the target state. `from == to` is a complete and honest answer, and one the
client cannot compute for itself.

── no third-party dependencies ──────────────────────────────────────────────

Standard library only, on portal-files' reasoning rather than by preference.
That service refuses dependencies because it holds read-write mounts on two git
repositories; this one refuses them because it holds a path to the Docker
daemon, which is the same argument with a higher ceiling. A dependency here is
something that can ship a vulnerability into a process whose one capability is
to act on containers.

The cost is real and it is small: talking to a socket proxy is http.client
against a plain HTTP port, and the whole client is forty lines below.

── it authenticates NOBODY ──────────────────────────────────────────────────

Authorisation happens at the edge: Traefik's forwardAuth asks oauth2-proxy
`/oauth2/auth?allowed_groups=operator`, and a request that fails never reaches
this process. Putting authz here as well would mean two places to get it right
and two places to get it wrong.

So the rule the socket proxy taught and both editing tiers repeat holds here
too: **reachability IS authorisation.** This publishes no host port and sits on
`controlnet`, which holds two containers - Traefik and this.

Identity headers are for ATTRIBUTION, not permission. X-Auth-Request-Email names
the actor in the audit line. If it were spoofable the worst case is a wrong name
in a log, not an unauthorised restart, because the decision was already made
upstream - and the edge strips client-supplied X-Auth-Request-* anyway.

── the two proxies, and why there are two ───────────────────────────────────

Fully argued in compose.yml. The short version, because it shapes every request
below: the READ proxy has POST=0 and can therefore never mutate anything, and
the WRITE proxy has CONTAINERS=0 and can therefore never reach /containers/create
or read a container's Env. Neither one alone is dangerous, which is why the
inspects and the action go to different addresses instead of to one proxy that
can do both.

── what this deliberately cannot do ─────────────────────────────────────────

`exec`, `create`, `rm`, image pulls, volume operations, anything under /build.
Those are `just` recipes and a Tailscale SSH session and they stay there. The
honest note, which docs/plans/first-party-stack.md also makes: Portainer could
exec into a container from a browser and this never will. That is a real
regression for anyone who used it, and the replacement is `docker exec` over
Tailscale SSH.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import guard

PORT = int(os.environ.get("PORT", "8097"))

# The two socket proxies, by compose service name. Split on purpose - see the
# module docstring and compose.yml.
DOCKER_READ = os.environ.get("DOCKER_READ", "http://bothy-control-socket-read:2375")
DOCKER_WRITE = os.environ.get("DOCKER_WRITE", "http://bothy-control-socket-write:2375")

# Pinned rather than negotiated. The daemon accepts a version prefix and falls
# back to its own when the requested one is newer; pinning means the paths this
# service builds are the paths the socket proxy's regexes were read against,
# which is the thing that would otherwise drift silently under an engine
# upgrade. 1.41 is the floor for everything used here (inspect, start, stop,
# restart) and has been stable since Docker 20.10.
API = "/v1.41"

# ── timeouts ────────────────────────────────────────────────────────────────
#
# Two of them, because the two calls have nothing in common.
#
# An inspect is a local read and should never take a second; 10s is already
# generous and a hang there means the proxy is wedged, which is worth failing
# fast about.
#
# An ACTION is not bounded by this service at all. `stop` sends SIGTERM and then
# waits for the container's own StopTimeout before SIGKILL - 10s by default, and
# this box has services configured higher. `restart` pays that and then a start.
# So the ceiling here has to be well above anything a container can legitimately
# take, or a slow-but-successful stop gets reported as a failure while the
# daemon goes on and does it anyway. That specific lie - "it failed" followed by
# the thing having happened - is worse than waiting.
#
# The number comes from a measurement rather than a guess. `docker restart` on a
# plain `alpine sleep 300` takes 10.3 SECONDS, because PID 1 has no default
# SIGTERM handler installed by the kernel, so the daemon waits out the whole
# StopTimeout and then SIGKILLs. A container that ignores SIGTERM is the common
# case, not the exotic one - checks/transition.py times it every run.
#
# Note what is NOT sent: no `t=` parameter on stop or restart. The container's
# own StopTimeout is a property of the container, declared in its compose file
# by whoever knows what it needs to flush; overriding it from here would mean
# this service quietly deciding that Postgres has ten seconds to shut down.
INSPECT_TIMEOUT = 10
ACTION_TIMEOUT = 180

AUDIT_PATH = os.environ.get("AUDIT_LOG", "/audit/actions.log")
_AUDIT_LOCK = threading.Lock()

# A body here is a verb in the path and one container name. 8 KB is already
# absurd for that, and the ceiling is small on purpose: there is no endpoint
# on this service with a reason to accept a file-sized body.
MAX_BODY = 8_192


class DaemonError(Exception):
    """The daemon or a proxy said no. Carries the status to report it with."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


# ── the audit log ───────────────────────────────────────────────────────────

def audit(who: str, outcome: str, verb: str, container: str,
          detail: str = "", took_ms: int | None = None) -> None:
    """Append-only record of every action this service is ASKED to perform.

    Asked, not performed: a refusal is an outcome and gets a line. An operator
    reading this log wants "who tried to stop traefik and got told no" as much
    as they want the restarts that worked, and a log that only records successes
    cannot answer the first question at all.

    One line, tab-separated, `tail`-able, no rotation logic to get wrong and no
    format anything else has to parse. Same shape as the editor tier's, on
    purpose - two audit logs on this box should be readable by the same eye.

    A failure to LOG must never fail the action - losing the record of a restart
    is bad, refusing a legitimate restart because the log is full is worse - so
    this swallows its own errors and reports them to stderr.
    """
    # Every field is flattened to one line before it is written.
    #
    # The log is tab-separated, one record per line, so a newline in ANY field
    # forges a record: a container name containing
    #   "\n<timestamp>\tsomeone@else\tACTED\tstop\t..."
    # produces a syntactically perfect entry attributing a stop to another user.
    #
    # The CONTAINER NAME is the vector and it comes straight off a request body.
    # guard.valid_name() already refuses newlines, so this is the second lock
    # rather than the first - but it also covers the fields that never went
    # through the guard: `who`, which is a header, and `detail`, which can carry
    # a daemon error string this service did not write.
    def flat(v: object) -> str:
        return re.sub(r"[\r\n\t]+", " ", str(v)).strip()

    line = (f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\t{flat(who)}\t"
            f"{flat(outcome)}\t{flat(verb)}\t{flat(container)}")
    if detail:
        line += f"\t{flat(detail)}"
    if took_ms is not None:
        line += f"\t{took_ms}ms"
    sys.stderr.write(line + "\n")
    try:
        with _AUDIT_LOCK:
            os.makedirs(os.path.dirname(AUDIT_PATH), exist_ok=True)
            with open(AUDIT_PATH, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
    except OSError as e:
        sys.stderr.write(f"AUDIT LOG UNWRITABLE ({e}) - the action itself was fine\n")


# ── the daemon, through a proxy ─────────────────────────────────────────────

def _call(base: str, method: str, path: str, timeout: int) -> tuple[int, bytes]:
    """One request to one socket proxy. No retries, deliberately.

    A retry on a POST would be a second stop, and `stop` is not idempotent in
    the way that matters: the first one may have succeeded and the response been
    lost, in which case the retry acts on a container the operator has already
    changed. The failure mode of not retrying is an error message; the failure
    mode of retrying is an action nobody asked for twice.
    """
    u = urlparse(base)
    conn = http.client.HTTPConnection(u.hostname or "", u.port or 80, timeout=timeout)
    try:
        conn.request(method, path, headers={"Host": u.hostname or "docker",
                                            "Accept": "application/json"})
        resp = conn.getresponse()
        return resp.status, resp.read()
    except (OSError, http.client.HTTPException) as e:
        # Named by which proxy, because "connection refused" alone would send
        # somebody looking at the daemon when the answer is that one 32 MB
        # haproxy is down.
        raise DaemonError(f"cannot reach {u.hostname}: {type(e).__name__}") from e
    finally:
        conn.close()


def inspect(container: str) -> tuple[str, str]:
    """(canonical name, state) for a container, through the READ proxy.

    Returns the daemon's own name for it rather than the caller's string, and
    that is load-bearing rather than tidy. The Docker API accepts a name OR a
    64-character id OR any unambiguous id prefix, so a deny list checked against
    the caller's string is trivially sidestepped by naming traefik by its id.
    Canonicalising first means the deny check in act() runs against the one
    identity the daemon agrees on, and the subsequent POST is then issued
    against that same identity rather than the caller's - so there is no window
    in which the checked thing and the acted-on thing are different strings.
    """
    status, body = _call(DOCKER_READ, "GET", f"{API}/containers/{container}/json",
                         INSPECT_TIMEOUT)
    if status == 404:
        raise DaemonError(f"no container named {container!r}", status=404)
    if status != 200:
        raise DaemonError(f"inspect failed ({status})", status=502)
    try:
        data = json.loads(body)
        # Docker reports the name with a leading slash - a legacy of the links
        # namespace - and every other API surface wants it without.
        name = str(data["Name"]).lstrip("/")
        state = str(data["State"]["Status"])
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        raise DaemonError(f"inspect returned something unexpected ({e})") from e
    # Re-validated even though it came from the daemon, because the next thing
    # that happens to it is being interpolated into a URL. A Docker name cannot
    # contain a slash, so this can never fire - which is exactly the condition
    # under which a check is cheap and the day it fires is the day it mattered.
    return guard.valid_name(name), state


def perform(container: str, verb: str) -> tuple[int, int]:
    """Do the thing. Returns (docker status, milliseconds the daemon took).

    The clock wraps ONLY this call. The contract says tookMs is "milliseconds
    the daemon took", and the two inspects around it are this service's
    bookkeeping - charging the operator's restart for them would make a fast
    restart look slow and would make the number mean something different from
    what the field says.
    """
    t0 = time.monotonic()
    status, body = _call(DOCKER_WRITE, "POST", f"{API}/containers/{container}/{verb}",
                         ACTION_TIMEOUT)
    took = int((time.monotonic() - t0) * 1000)

    # 204: done. 304: already in that state - the daemon's way of saying the
    # request was a no-op, and NOT an error. It is reported as ok with from == to,
    # which is the whole reason the contract carries both: "start something that
    # was already running" has a truthful answer and it is not a failure.
    if status in (204, 304):
        return status, took
    if status == 404:
        raise DaemonError(f"no container named {container!r}", status=404)
    if status == 403:
        # The WRITE proxy refused it. This should be unreachable - guard.VERBS
        # is a subset of what that proxy grants - so if it ever fires, the
        # proxy's grants and this service's allowlist have diverged and the
        # message should say so rather than blaming the daemon.
        raise DaemonError(
            f"the socket proxy refused {verb} - its grants and this service's "
            "allowlist have diverged", status=502)
    detail = body.decode("utf-8", "replace")[:200].strip()
    raise DaemonError(f"docker refused {verb} ({status}): {detail}",
                      status=409 if status == 409 else 502)


def act(container: str, verb: str, who: str) -> dict:
    """The whole of it: check, read, do, read, log, answer."""
    guard.valid_name(container)

    # A first deny check on the CALLER's string, before touching the daemon.
    # Redundant with the canonical check below and kept anyway: it makes the
    # common case (somebody clicks stop on the Traefik card) a refusal that
    # costs no daemon round-trip, and it means the refusal still happens if the
    # read proxy is the thing that is down.
    reason = guard.severed(container, verb)
    if reason:
        audit(who, "REFUSED", verb, container, reason)
        raise guard.Refused(reason, status=409)

    name, before = inspect(container)

    # THE check. Against the daemon's canonical name, so naming traefik by its
    # container id gets the same answer as naming it by its name.
    reason = guard.severed(name, verb)
    if reason:
        audit(who, "REFUSED", verb, name, reason)
        raise guard.Refused(reason, status=409)

    try:
        _, took_ms = perform(name, verb)
    except DaemonError as e:
        audit(who, "FAILED", verb, name, str(e))
        raise

    # `to` is read back rather than assumed. Assuming it would be right almost
    # always and wrong in the cases worth knowing about: a container whose
    # entrypoint exits immediately reports `exited` here a moment after a
    # successful start, and a UI told "running" because the API returned 204
    # would show a green dot on a dead service.
    try:
        _, after = inspect(name)
    except DaemonError:
        # The action succeeded; only the read-back failed. Say `unknown` rather
        # than lying in either direction, and let the line above stand as the
        # record that the action happened.
        after = "unknown"

    audit(who, "ACTED", verb, name, f"{before} -> {after}", took_ms)
    return {"ok": True, "container": name, "verb": verb,
            "from": before, "to": after, "tookMs": took_ms}


# ── HTTP ────────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = "bothy-control"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # noqa: A003
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self) -> None:  # noqa: N802
        if urlparse(self.path).path == "/healthz":
            # No route at the edge for this - see edge/dynamic/bothy-control.yml.
            # It is reached by the container's own HEALTHCHECK on 127.0.0.1.
            return self._send(200, {"ok": True, "verbs": list(guard.VERBS),
                                    "severing": sorted(guard.SEVERING)})
        return self._send(404, {"error": "no such endpoint"})

    def do_POST(self) -> None:  # noqa: N802
        route = urlparse(self.path).path
        if not route.startswith("/control/"):
            return self._send(404, {"error": "no such endpoint"})
        verb = route[len("/control/"):]

        who = "unknown"
        try:
            # ── CSRF ────────────────────────────────────────────────────────
            #
            # Same shape as the editor and config tiers, and needed for the same
            # reason: the oauth2-proxy session cookie is sent to every port on
            # this host, so a page on the sandbox origin (:8100) is SAME-SITE
            # with the portal and SameSite=lax does not block a POST from there
            # to here.
            #
            # Requiring JSON is the load-bearing half. This handler would
            # otherwise accept a text/plain POST - a CORS-"simple" request,
            # which skips the preflight entirely. Demanding application/json
            # forces a preflight cross-origin, and the preflight fails because
            # this service sends no CORS headers at all.
            #
            # It matters more here than in either editing tier. A forged write
            # leaves a diff somebody can read and revert; a forged `stop
            # postgres` is over before anyone reads anything.
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                return self._send(415, {"error": "Content-Type must be application/json"})
            site = self.headers.get("Sec-Fetch-Site")
            if site and site not in ("same-origin", "none"):
                return self._send(403, {
                    "error": f"cross-origin actions are refused (Sec-Fetch-Site: {site})"})

            guard.check_verb(verb)

            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                return self._send(413, {"error": "body missing or too large"})
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                return self._send(400, {"error": "body must be a JSON object"})

            # Attribution only. Falls back rather than failing: a missing header
            # means a misconfigured edge, and losing the actor's name is not a
            # reason to refuse a legitimate restart.
            who = (self.headers.get("X-Auth-Request-Email")
                   or self.headers.get("X-Auth-Request-User") or "unknown")

            return self._send(200, act(body.get("container"), verb, who))

        except guard.Refused as e:
            # No `needsRole` on anything this service emits, and the omission is
            # correct rather than an oversight. ActionRefusal carries that field
            # so the UI can offer sign-in instead of an apology - but a request
            # that reaches this process has ALREADY passed sso-operator, so the
            # only 403 that means "you lack the role" is produced by oauth2-proxy
            # at the edge, which does not speak this JSON. See the note in
            # edge/dynamic/bothy-control.yml; the client's act() falls back to
            # the status code and degrades correctly.
            return self._send(e.status, {"error": str(e)})
        except DaemonError as e:
            return self._send(e.status, {"error": str(e)})
        except json.JSONDecodeError:
            return self._send(400, {"error": "body must be JSON"})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"ERROR {route}: {type(e).__name__}: {e}\n")
            audit(who, "ERROR", verb, "-", f"{type(e).__name__}")
            return self._send(500, {"error": "internal error"})


def main() -> None:
    sys.stderr.write(
        f"bothy-control on :{PORT} - verbs {list(guard.VERBS)}, "
        f"read {DOCKER_READ}, write {DOCKER_WRITE}\n")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
