#!/usr/bin/env python3
"""bothy-kube - a handful of OpenShift-console verbs on two namespaces, and nothing else.

    POST /kube/rollout-restart        {"namespace", "deployment"}
    POST /kube/scale                  {"namespace", "deployment", "replicas", "confirm"}
    GET  /kube/events?namespace=&deployment=[&limit=]
    GET  /kube/logs?namespace=&deployment=[&tail=&pod=&container=&follow=&seconds=]
    POST /kube/delete-completed-pods  {"namespace"}

What may be asked is catalog.toml; what may happen is HANDLERS below, written out
by hand; what the cluster will let happen is k8s/rbac/bothy-kube.yaml. Each is a
separate lock, and the service refuses to start when the first two disagree.

── the three locks, from the outside in ─────────────────────────────────────

  1. the EDGE     one exact Path() per action, sso-viewer on reads and
                  sso-operator on changes (edge/dynamic/bothy-kube.yml)
  2. this SERVICE guard.py: namespace enum, name regex, declared params with
                  bounds, type-name confirmation, CSRF
  3. the CLUSTER  a ServiceAccount whose Role, in each of the two namespaces
                  only, grants exactly the verbs the handlers call. No
                  pods/exec, no pods/portforward, no secrets, no ClusterRole.

Lock 3 is the one that holds if 1 and 2 are both wrong. A total compromise of
this process yields a token that can restart, scale and read logs in two dev
namespaces - not a shell, not a secret, not the cluster.

── no third-party dependencies, and no kubectl ──────────────────────────────

Standard library only, on bothy-control's reasoning: this process holds a
credential that acts on running workloads, and every dependency is something
that can ship a vulnerability into it. The apiserver is HTTPS with a bearer
token; http.client and ssl with the cluster CA pinned is the whole client.

No kubectl binary either. kubectl speaks the entire API - exec included - and
putting it in a container whose token cannot exec would leave the next person
one RBAC edit away from a browser shell with the tool already installed.

── it authenticates NOBODY ──────────────────────────────────────────────────

Same rule as every other tier here: reachability IS authorisation. No host
port; the only ways in are `kubenet` (traefik + this) and, for the apiserver
the other way, `thales-scc` (minikube's own network). X-Auth-Request-Email is
for the audit line, never for a decision - the edge strips client copies.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import socket
import ssl
import sys
import threading
import time
import tomllib
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, quote, urlparse

import guard

PORT = int(os.environ.get("PORT", "8098"))
KUBE_API = os.environ.get("KUBE_API", "https://192.168.49.2:8443")
TOKEN_FILE = os.environ.get("KUBE_TOKEN_FILE", "/secrets/token")
CA_FILE = os.environ.get("KUBE_CA_FILE", "/secrets/ca.crt")
CATALOG_FILE = os.environ.get("CATALOG", os.path.join(os.path.dirname(os.path.abspath(__file__)), "catalog.toml"))
AUDIT_PATH = os.environ.get("AUDIT_LOG", "/audit/actions.log")

MAX_BODY = 8_192
API_TIMEOUT = 15
# Concurrent log follows. Each holds a thread here and a watch on the apiserver
# for up to `seconds` (<= 300); four is plenty for one operator with a few tabs,
# and a fifth is told so rather than queued.
MAX_STREAMS = int(os.environ.get("MAX_STREAMS", "4"))
# A single log answer (non-follow) is capped in bytes as well as lines, because
# 500 lines of a minified JSON logger is not a small response.
LOG_LIMIT_BYTES = 512 * 1024
# The log endpoint answers text/plain, but the apiserver's content negotiation
# REFUSES `Accept: text/plain` with a 406 ("only application/json,
# application/yaml, application/vnd.kubernetes.protobuf"). kubectl sends */*.
# Found against the live cluster on the first run; checks/api.py's stand-in now
# refuses text/plain the same way.
LOG_ACCEPT = "*/*"

_AUDIT_LOCK = threading.Lock()
_STREAMS = threading.BoundedSemaphore(MAX_STREAMS)


class KubeError(Exception):
    """The apiserver said no, or could not be reached."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


# ── the audit log ───────────────────────────────────────────────────────────

def audit(who: str, outcome: str, action: str, where: str,
          params: object = None, took_ms: int | None = None) -> None:
    """One TSV line per request, same shape as bothy-control's.

        time  email  ACTED|REFUSED|FAILED|ERROR  action  namespace/target  params-json  Nms

    Reads are logged too: "who read the pre-prod logs" is a question worth being
    able to answer. Every field is flattened, because a newline in any of them
    forges a record (see bothy-control's audit() for the worked example). A
    failure to log never fails the request.
    """
    def flat(v: object) -> str:
        return re.sub(r"[\r\n\t]+", " ", str(v)).strip()

    pj = json.dumps(params if params is not None else {}, sort_keys=True, separators=(",", ":"))
    line = (f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\t{flat(who)}\t"
            f"{flat(outcome)}\t{flat(action)}\t{flat(where)}\t{flat(pj)}")
    if took_ms is not None:
        line += f"\t{took_ms}ms"
    sys.stderr.write(line + "\n")
    try:
        with _AUDIT_LOCK:
            os.makedirs(os.path.dirname(AUDIT_PATH), exist_ok=True)
            with open(AUDIT_PATH, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
    except OSError as e:
        sys.stderr.write(f"AUDIT LOG UNWRITABLE ({e}) - the request itself was fine\n")


# ── the apiserver ───────────────────────────────────────────────────────────

def _token() -> str:
    # Read per request, so `just kube-token` rotates without a restart.
    try:
        with open(TOKEN_FILE, encoding="utf-8") as fh:
            tok = fh.read().strip()
    except OSError:
        tok = ""
    if not tok:
        raise KubeError("no cluster token mounted - run `just kube-token`", status=503)
    return tok


def _connect(timeout: float) -> http.client.HTTPSConnection:
    u = urlparse(KUBE_API)
    if u.scheme != "https":
        raise KubeError("KUBE_API must be https", status=500)
    try:
        ctx = ssl.create_default_context(cafile=CA_FILE)
    except (OSError, ssl.SSLError) as e:
        raise KubeError(f"cluster CA unreadable ({type(e).__name__}) - run `just kube-token`",
                        status=503) from e
    # Hostname checking stays ON. The minikube serving cert carries the node IP
    # as an IP SAN, so verifying 192.168.49.2 against it works - no reason to
    # relax the one check that says this token is going to the real apiserver.
    return http.client.HTTPSConnection(u.hostname or "", u.port or 443, timeout=timeout, context=ctx)


def kube(method: str, path: str, body: object = None, ctype: str = "application/json",
         timeout: float = API_TIMEOUT) -> dict:
    """One request, JSON in and out. No retries: a retried PATCH is a second action."""
    headers = {"Authorization": f"Bearer {_token()}", "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = ctype
    conn = _connect(timeout)
    try:
        conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
    except (OSError, http.client.HTTPException) as e:
        raise KubeError(f"cannot reach the apiserver ({type(e).__name__})") from e
    finally:
        conn.close()
    return _answer(resp.status, raw)


def _answer(status: int, raw: bytes) -> dict:
    try:
        doc = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        doc = {}
    if 200 <= status < 300:
        return doc
    msg = str(doc.get("message") or "")[:300]
    if status == 404:
        raise KubeError(msg or "not found", status=404)
    if status in (401, 403):
        # The Role and this service disagree about what it may do - or the token
        # was revoked. Either way it is not the caller's fault and not a 403 of
        # the "you lack the role" kind, which only the edge produces.
        raise KubeError(
            f"the cluster refused bothy-kube ({status}): {msg} - its token or its Role "
            "(k8s/rbac/bothy-kube.yaml) has diverged from the catalog", status=502)
    if status in (409, 422):
        raise KubeError(msg or "conflict", status=409)
    raise KubeError(f"apiserver answered {status}: {msg}", status=502)


# Every path is built from constant segments and names that passed
# guard.valid_name / guard.check_namespace. Nothing else is ever interpolated.
def _deploy_path(ns: str, name: str, sub: str = "") -> str:
    return f"/apis/apps/v1/namespaces/{ns}/deployments/{name}{sub}"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _selector(dep: dict) -> str:
    """labelSelector for a deployment's pods. matchLabels only, on purpose."""
    sel = (dep.get("spec") or {}).get("selector") or {}
    if sel.get("matchExpressions"):
        raise KubeError("deployment uses matchExpressions; bothy-kube only follows matchLabels",
                        status=409)
    labels = sel.get("matchLabels") or {}
    if not labels:
        raise KubeError("deployment has no matchLabels selector", status=409)
    return ",".join(f"{k}={v}" for k, v in sorted(labels.items()))


def _pods_of(ns: str, dep_name: str) -> list[dict]:
    dep = kube("GET", _deploy_path(ns, dep_name))
    sel = quote(_selector(dep), safe="")
    items = kube("GET", f"/api/v1/namespaces/{ns}/pods?labelSelector={sel}").get("items") or []
    # Newest first, running before not-running: "the logs" of a deployment means
    # the pod serving now, not one terminating from the last rollout.
    items.sort(key=lambda p: ((p.get("metadata") or {}).get("creationTimestamp") or ""), reverse=True)
    items.sort(key=lambda p: 0 if (p.get("status") or {}).get("phase") == "Running" else 1)
    return items


# ── the handlers. HARD-CODED; one per catalog id, and no generic dispatcher ──

class Ctx:
    def __init__(self, action: guard.Action, ns: str, target: str,
                 params: dict[str, object], http_handler: "Handler", who: str) -> None:
        self.action, self.ns, self.target, self.params = action, ns, target, params
        self.http, self.who = http_handler, who


def h_rollout_restart(c: Ctx) -> dict:
    """`kubectl rollout restart`: stamp the pod template, let the controller roll."""
    before = kube("GET", _deploy_path(c.ns, c.target))
    stamp = _now()
    patch = {"spec": {"template": {"metadata": {"annotations": {
        "kubectl.kubernetes.io/restartedAt": stamp}}}}}
    after = kube("PATCH", _deploy_path(c.ns, c.target), patch,
                 ctype="application/strategic-merge-patch+json")
    return {
        "restartedAt": stamp,
        "fromGeneration": (before.get("metadata") or {}).get("generation"),
        "toGeneration": (after.get("metadata") or {}).get("generation"),
        "replicas": (after.get("spec") or {}).get("replicas"),
    }


def h_scale(c: Ctx) -> dict:
    """Patch the scale subresource - never the deployment spec itself."""
    path = _deploy_path(c.ns, c.target, "/scale")
    before = kube("GET", path)
    want = c.params["replicas"]
    after = kube("PATCH", path, {"spec": {"replicas": want}}, ctype="application/merge-patch+json")
    return {"from": (before.get("spec") or {}).get("replicas", 0),
            "to": (after.get("spec") or {}).get("replicas", 0)}


def h_events(c: Ctx) -> dict:
    """Events about the deployment, its ReplicaSets and its pods, newest first.

    Core v1 events, listed in the namespace and filtered here by name: the
    Deployment itself, or a ReplicaSet/Pod whose name begins `<deployment>-`,
    which is how the controllers name what they create. A field selector cannot
    express a prefix, and the list is small.
    """
    kube("GET", _deploy_path(c.ns, c.target))  # 404 for a deployment that does not exist
    items = kube("GET", f"/api/v1/namespaces/{c.ns}/events?limit=500").get("items") or []
    prefix = c.target + "-"
    out = []
    for e in items:
        obj = e.get("involvedObject") or {}
        kind, name = obj.get("kind") or "", obj.get("name") or ""
        if not ((kind == "Deployment" and name == c.target)
                or (kind in ("ReplicaSet", "Pod") and name.startswith(prefix))):
            continue
        last = (e.get("lastTimestamp") or e.get("eventTime")
                or (e.get("metadata") or {}).get("creationTimestamp") or "")
        out.append({"type": e.get("type") or "Normal", "reason": e.get("reason") or "",
                    "message": (e.get("message") or "")[:1000], "object": f"{kind}/{name}",
                    "count": e.get("count") or 1, "lastSeen": last})
    out.sort(key=lambda x: x["lastSeen"], reverse=True)
    return {"events": out[: int(c.params["limit"])]}  # type: ignore[arg-type]


def _log_source(c: Ctx) -> tuple[str, str, list[str], list[str]]:
    pods = _pods_of(c.ns, c.target)
    if not pods:
        raise KubeError(f"{c.target} has no pods", status=404)
    names = [(p.get("metadata") or {}).get("name", "") for p in pods]
    want = c.params.get("pod")
    if want is not None:
        # Only a pod the deployment's selector returned. Naming any other pod in
        # the namespace - postgres, say - is refused rather than served.
        if want not in names:
            raise guard.Refused(f"pod {want!r} does not belong to {c.target}", status=404)
        pod = next(p for p in pods if (p.get("metadata") or {}).get("name") == want)
    else:
        pod = pods[0]
    pname = (pod.get("metadata") or {}).get("name", "")
    containers = [x.get("name", "") for x in ((pod.get("spec") or {}).get("containers") or [])]
    cwant = c.params.get("container")
    if cwant is not None and cwant not in containers:
        raise guard.Refused(f"container {cwant!r} is not in pod {pname}", status=404)
    return pname, str(cwant or containers[0]), names, containers


def h_logs(c: Ctx) -> dict | None:
    pod, container, pods, containers = _log_source(c)
    guard.valid_name(pod, "pod")
    guard.valid_name(container, "container")
    base = (f"/api/v1/namespaces/{c.ns}/pods/{pod}/log?container={container}"
            f"&tailLines={int(c.params['tail'])}")  # type: ignore[arg-type]
    if c.params.get("follow"):
        _follow(c, base + "&follow=true", pod, container)
        return None

    headers = {"Authorization": f"Bearer {_token()}", "Accept": LOG_ACCEPT}
    conn = _connect(API_TIMEOUT)
    try:
        conn.request("GET", base + f"&limitBytes={LOG_LIMIT_BYTES}", headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
    except (OSError, http.client.HTTPException) as e:
        raise KubeError(f"cannot reach the apiserver ({type(e).__name__})") from e
    finally:
        conn.close()
    if resp.status != 200:
        _answer(resp.status, raw)
    text = raw.decode("utf-8", "replace")
    return {"pod": pod, "container": container, "pods": pods, "containers": containers,
            "lines": text.splitlines()}


def _follow(c: Ctx, path: str, pod: str, container: str) -> None:
    """Server-sent events, for at most `seconds`, then an `end` event and close.

    The bound is enforced by the SOCKET TIMEOUT, re-armed before every read to
    whatever is left of the budget. So a quiet pod cannot hold the stream past
    its deadline: the read times out at the deadline, and a timeout here means
    exactly "time is up". The connection is never read again after a timeout,
    which matters - http.client's chunked state is not safe to resume.
    """
    if not _STREAMS.acquire(blocking=False):
        raise guard.Refused(f"{MAX_STREAMS} log streams are already open - close one first",
                            status=429)
    t0 = time.monotonic()
    deadline = t0 + int(c.params["seconds"])  # type: ignore[arg-type]
    conn = None
    lines = 0
    started = False
    try:
        conn = _connect(API_TIMEOUT)
        conn.request("GET", path, headers={"Authorization": f"Bearer {_token()}",
                                           "Accept": LOG_ACCEPT})
        resp = conn.getresponse()
        if resp.status != 200:
            _answer(resp.status, resp.read())

        h = c.http
        h.send_response(200)
        h.send_header("Content-Type", "text/event-stream; charset=utf-8")
        h.send_header("Cache-Control", "no-cache")
        h.send_header("X-Accel-Buffering", "no")
        h.send_header("X-Content-Type-Options", "nosniff")
        h.end_headers()
        started = True

        def send(event: str | None, data: str) -> None:
            chunk = ""
            if event:
                chunk += f"event: {event}\n"
            # SSE data cannot carry a raw newline; one line in, one data field out.
            chunk += "data: " + data.replace("\r", "").replace("\n", " ") + "\n\n"
            h.wfile.write(chunk.encode("utf-8"))
            h.wfile.flush()

        send("meta", json.dumps({"pod": pod, "container": container,
                                 "seconds": c.params["seconds"]}))
        sock = conn.sock
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            if sock is not None:
                sock.settimeout(left)
            try:
                raw = resp.readline(64 * 1024)
            except (socket.timeout, TimeoutError):
                break
            if not raw:
                break  # the container exited or the apiserver closed the watch
            send(None, raw.decode("utf-8", "replace").rstrip("\n"))
            lines += 1
        send("end", json.dumps({"lines": lines, "reason": "deadline"
                                if time.monotonic() >= deadline else "closed"}))
    except (BrokenPipeError, ConnectionResetError):
        pass  # the browser closed the tab; that is a normal end of a follow
    finally:
        if conn is not None:
            conn.close()
        _STREAMS.release()
        # Only once the stream really started. A failure BEFORE the headers
        # propagates to _dispatch, which answers in JSON and audits it FAILED.
        if started:
            audit(c.who, "ACTED", c.action.id, f"{c.ns}/{c.target}",
                  {**c.params, "pod": pod, "container": container, "lines": lines},
                  int((time.monotonic() - t0) * 1000))
            c.http.close_connection = True


def h_delete_completed_pods(c: Ctx) -> dict:
    """Delete pods whose phase is Succeeded - and ONLY those, checked twice.

    The list is field-selected by the apiserver, then every item's phase is
    checked again here, and each delete carries a UID precondition. So a pod
    that was replaced by a running one of the same name between the list and
    the delete is refused by the apiserver rather than deleted.
    """
    q = quote("status.phase=Succeeded", safe="")
    items = kube("GET", f"/api/v1/namespaces/{c.ns}/pods?fieldSelector={q}").get("items") or []
    deleted, skipped = [], []
    for p in items:
        meta = p.get("metadata") or {}
        name, uid = meta.get("name", ""), meta.get("uid", "")
        if (p.get("status") or {}).get("phase") != "Succeeded" or not uid:
            skipped.append(name)
            continue
        try:
            guard.valid_name(name, "pod")
        except guard.Refused:
            skipped.append(name)
            continue
        try:
            kube("DELETE", f"/api/v1/namespaces/{c.ns}/pods/{name}",
                 {"kind": "DeleteOptions", "apiVersion": "v1", "preconditions": {"uid": uid}})
            deleted.append(name)
        except KubeError as e:
            if e.status in (404, 409):
                skipped.append(name)
            else:
                raise
    return {"deleted": deleted, "skipped": skipped}


# THE HANDLER TABLE. A literal dict, written out. guard.check_handlers compares
# its keys with catalog.toml at startup and refuses to run on any difference.
HANDLERS = {
    "rollout-restart": h_rollout_restart,
    "scale": h_scale,
    "events": h_events,
    "logs": h_logs,
    "delete-completed-pods": h_delete_completed_pods,
}


def load() -> dict[str, guard.Action]:
    with open(CATALOG_FILE, "rb") as fh:
        catalog = guard.load_catalog(tomllib.load(fh))
    guard.check_handlers(catalog.keys(), HANDLERS.keys())
    return catalog


CATALOG: dict[str, guard.Action] = {}


# ── HTTP ────────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = "bothy-kube"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # noqa: A003
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self) -> None:  # noqa: N802
        if urlparse(self.path).path == "/healthz":
            # No edge route. Local only; deliberately does not call the
            # apiserver, so a stopped minikube reads as "cluster unreachable"
            # on a request rather than as a crash-looping container.
            return self._send(200, {"ok": True, "actions": sorted(CATALOG),
                                    "namespaces": list(guard.NAMESPACES),
                                    "token": os.path.exists(TOKEN_FILE)})
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def _dispatch(self, method: str) -> None:
        u = urlparse(self.path)
        if not u.path.startswith("/kube/"):
            return self._send(404, {"error": "no such endpoint"})
        aid = u.path[len("/kube/"):]
        who = (self.headers.get("X-Auth-Request-Email")
               or self.headers.get("X-Auth-Request-User") or "unknown")
        where, params_for_log = "-", {}
        t0 = time.monotonic()
        try:
            # ── CSRF, both halves, same as bothy-control ─────────────────────
            site = self.headers.get("Sec-Fetch-Site")
            if site and site not in ("same-origin", "none"):
                raise guard.Refused(f"cross-origin requests are refused (Sec-Fetch-Site: {site})")

            if method == "POST":
                ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                if ctype != "application/json":
                    raise guard.Refused("Content-Type must be application/json", status=415)
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > MAX_BODY:
                    raise guard.Refused("body missing or too large", status=413)
                try:
                    req = json.loads(self.rfile.read(length))
                except json.JSONDecodeError:
                    raise guard.Refused("body must be JSON", status=400) from None
                if not isinstance(req, dict):
                    raise guard.Refused("body must be a JSON object", status=400)
            else:
                pairs = parse_qsl(u.query, keep_blank_values=True, max_num_fields=16)
                req = {}
                for k, v in pairs:
                    if k in req:
                        # `?namespace=thales-dev&namespace=kube-system` - whichever
                        # one a parser keeps, somebody else keeps the other.
                        raise guard.Refused(f"parameter {k[:40]!r} given twice", status=400)
                    req[k] = v

            # What was ASKED, for a refusal's audit line - untrusted, truncated,
            # and flattened by audit(). Replaced by the checked values below.
            where = (f"{str(req.get('namespace', '-'))[:64]}/"
                     f"{str(req.get('deployment', req.get('namespace', '-')))[:64]}")
            action, ns, target, params = guard.check_request(CATALOG, aid, method, req)
            where, params_for_log = f"{ns}/{target}", params
            ctx = Ctx(action, ns, target, params, self, who)
            result = HANDLERS[action.id](ctx)
            if result is None:
                return  # a stream; it wrote its own response and its own audit line
            took = int((time.monotonic() - t0) * 1000)
            audit(who, "ACTED", action.id, where, params, took)
            return self._send(200, {"ok": True, "action": action.id, "namespace": ns,
                                    "target": target, "tookMs": took, **result})

        except guard.Refused as e:
            audit(who, "REFUSED", aid[:64], where, {"reason": str(e)[:200]},
                  int((time.monotonic() - t0) * 1000))
            return self._send(e.status, {"error": str(e)})
        except KubeError as e:
            audit(who, "FAILED", aid[:64], where, {**params_for_log, "error": str(e)[:200]},
                  int((time.monotonic() - t0) * 1000))
            return self._send(e.status, {"error": str(e)})
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"ERROR {aid}: {type(e).__name__}: {e}\n")
            audit(who, "ERROR", aid[:64], where, {"error": type(e).__name__})
            return self._send(500, {"error": "internal error"})


def main() -> None:
    global CATALOG
    try:
        CATALOG = load()
    except (guard.CatalogError, OSError, tomllib.TOMLDecodeError) as e:
        # Refuse to start. A service that ran with half a catalog would be a
        # service whose surface nobody reviewed.
        sys.stderr.write(f"bothy-kube REFUSES TO START: {e}\n")
        sys.exit(2)
    sys.stderr.write(
        f"bothy-kube on :{PORT} - actions {sorted(CATALOG)}, namespaces "
        f"{list(guard.NAMESPACES)}, apiserver {KUBE_API}\n")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
