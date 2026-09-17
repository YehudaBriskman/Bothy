"""The Kube half of bothy-ops - OpenShift-console verbs on two namespaces, and nothing else.

    GET  /kube/catalog                       the catalog, for the UI (app.py routes it)
    GET  /kube/<read id>?namespace=&<target>=&<params>
    POST /kube/<change id>  {"namespace", "<target>", <params>, "confirm"?}

The ids, their targets and their params are catalog.toml; the list there is
the list here (HANDLERS), one hand-written function per id.

What may be asked is catalog.toml; what may happen is HANDLERS below, written out
by hand; what the cluster will let happen is k8s/rbac/bothy-kube.yaml. Each is a
separate lock, and the service refuses to start when the first two disagree.

── the three locks, from the outside in ─────────────────────────────────────

  1. the EDGE     one exact Path() per action, sso-viewer on reads and
                  sso-operator on changes (edge/dynamic/bothy-ops.yml)
  2. this SERVICE guard.py: namespace enum, name rule, declared params with
                  bounds, image registry allowlist, ConfigMap key allowlist
                  with per-key value patterns, job templates from files only,
                  type-name confirmation, CSRF
  3. the CLUSTER  a ServiceAccount whose Role, in each of the two namespaces
                  only, is GENERATED from the catalog's `rbac` declarations.
                  No pods/exec, attach or portforward, no secrets, no watch,
                  no ClusterRole; ConfigMaps limited by resourceNames.

Lock 3 holds if 1 and 2 are both wrong - and says honestly what that leaves: a
total compromise of this process yields a token that can patch deployments
(including their images, to anything), create Jobs, delete pods and jobs, and
patch the `thales` ConfigMap, in two dev namespaces. That is the power to run
code there. It is not a shell from the browser, not a Secret's value through
the API, and not the cluster: no namespace, node, RBAC or cluster-scoped object.
The registry and key allowlists are lock 2's alone.

── the cluster is OPTIONAL, and that is a property of this module ───────────

minikube's `thales-scc` network exists only while the cluster does, so bothy-ops
joins it through an overlay (compose.cluster.yml) that `just up-apps` adds only
when the network exists. Without it - or with the token missing, or the
apiserver down - every kube verb answers 503 "cluster unavailable" and the
Control half is untouched. Nothing here calls the apiserver at startup, and
/healthz never does: a stopped minikube must read as a 503 on a request, never
as a crash-looping container that takes container actions down with it.

── no third-party dependencies, and no kubectl ──────────────────────────────

The apiserver is HTTPS with a bearer token; http.client and ssl with the cluster
CA pinned is the whole client. kubectl speaks the entire API - exec included -
and putting it in a container whose token cannot exec would leave the next
person one RBAC edit away from a browser shell with the tool already installed.
"""

from __future__ import annotations

import http.client
import json
import os
import socket
import ssl
import sys
import threading
import time
import tomllib
from datetime import datetime, timezone
from urllib.parse import parse_qsl, quote, urlparse

import guard
from bothy_common.audit import AuditLog

KUBE_API = os.environ.get("KUBE_API", "https://192.168.49.2:8443")
TOKEN_FILE = os.environ.get("KUBE_TOKEN_FILE", "/secrets/token")
CA_FILE = os.environ.get("KUBE_CA_FILE", "/secrets/ca.crt")
CATALOG_FILE = os.environ.get("CATALOG", os.path.join(os.path.dirname(os.path.abspath(__file__)), "catalog.toml"))
# The job templates run-template may create from. In the image they are COPY'd
# to /app/job-templates at build time (compose additional_contexts); in a
# checkout they are the repository's k8s/job-templates.
_HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_DIR = os.environ.get("JOB_TEMPLATES") or next(
    (d for d in (os.path.join(_HERE, "job-templates"),
                 os.path.join(_HERE, os.pardir, os.pardir, "k8s", "job-templates")) if os.path.isdir(d)),
    os.path.join(_HERE, "job-templates"))

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
# REFUSES `Accept: text/plain` with a 406. kubectl sends */*. Found against the
# live cluster; checks/api.py's stand-in refuses text/plain the same way.
LOG_ACCEPT = "*/*"

LOG = AuditLog(os.environ.get("AUDIT_LOG", "/audit/actions.log"))
_STREAMS = threading.BoundedSemaphore(MAX_STREAMS)


class KubeError(Exception):
    """The apiserver said no, or could not be reached."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


def audit(who: str, outcome: str, action: str, where: str,
          params: object = None, took_ms: int | None = None) -> None:
    """One TSV line per request, in the same log as the Control half.

        time  email  ACTED|REFUSED|FAILED|ERROR  action  namespace/target  params-json  Nms

    Reads are logged too: "who read the pre-prod logs" is a question worth being
    able to answer. The params column is JSON, which is what tells a kube line
    from a container line in the shared actions.log.
    """
    pj = json.dumps(params if params is not None else {}, sort_keys=True, separators=(",", ":"))
    fields: list[object] = [who, outcome, action, where, pj]
    if took_ms is not None:
        fields.append(f"{took_ms}ms")
    LOG.write(*fields)


def unavailable(why: str) -> KubeError:
    """503, worded so the UI and a curl both say the same thing."""
    return KubeError(f"cluster unavailable - {why}", status=503)


# ── the apiserver ───────────────────────────────────────────────────────────

def _token() -> str:
    # Read per request, so `just kube-token` rotates without a restart - and a
    # token written after bothy-ops started is picked up with no recreate.
    try:
        with open(TOKEN_FILE, encoding="utf-8") as fh:
            tok = fh.read().strip()
    except OSError:
        tok = ""
    if not tok:
        raise unavailable("no cluster token mounted - run `just kube-token`, "
                          "then `just up-apps` so the cluster overlay mounts it")
    return tok


def _connect(timeout: float) -> http.client.HTTPSConnection:
    u = urlparse(KUBE_API)
    if u.scheme != "https":
        raise KubeError("KUBE_API must be https", status=500)
    try:
        ctx = ssl.create_default_context(cafile=CA_FILE)
    except (OSError, ssl.SSLError) as e:
        raise unavailable(f"cluster CA unreadable ({type(e).__name__}) - run `just kube-token`") from e
    # Hostname checking stays ON. The minikube serving cert carries the node IP
    # as an IP SAN, so verifying 192.168.49.2 against it works.
    return http.client.HTTPSConnection(u.hostname or "", u.port or 443, timeout=timeout, context=ctx)


def _unreachable(e: BaseException) -> KubeError:
    # OSError covers every "the network is not there" shape: no route (the
    # thales-scc overlay is absent), refused (apiserver down), timed out
    # (minikube paused), and a DNS failure. All of them mean the same thing to
    # the operator, and none of them is this service's bug.
    return unavailable(f"cannot reach the apiserver ({type(e).__name__})")


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
    except ssl.SSLError as e:
        # A TLS failure is NOT "unavailable": something answered and it was not
        # the apiserver whose CA this token was issued with. 502, loudly.
        raise KubeError(f"apiserver TLS verification failed ({type(e).__name__})") from e
    except (OSError, http.client.HTTPException) as e:
        raise _unreachable(e) from e
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
        # was revoked. Not the caller's fault and not a 403 of the "you lack the
        # role" kind, which only the edge produces.
        raise KubeError(
            f"the cluster refused bothy-ops ({status}): {msg} - its token or its Role "
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
        raise KubeError("deployment uses matchExpressions; bothy-ops only follows matchLabels",
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
                 params: dict[str, object], http_handler, who: str) -> None:
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
    previous = bool(c.params.get("previous"))
    if previous and c.params.get("follow"):
        # A previous instance has exited; there is nothing to follow.
        raise guard.Refused("previous and follow cannot be combined - a previous log is finished", status=400)
    pod, container, pods, containers = _log_source(c)
    guard.valid_name(pod, "pod")
    guard.valid_name(container, "container")
    if c.params.get("follow"):
        base = (f"/api/v1/namespaces/{c.ns}/pods/{pod}/log?container={container}"
                f"&tailLines={int(c.params['tail'])}")  # type: ignore[arg-type]
        _follow(c, base + "&follow=true", pod, container)
        return None
    lines = _read_log(c.ns, pod, container, int(c.params["tail"]), previous)  # type: ignore[arg-type]
    return {"pod": pod, "container": container, "pods": pods, "containers": containers,
            "previous": previous, "lines": lines}


def _follow(c: Ctx, path: str, pod: str, container: str) -> None:
    """Server-sent events, for at most `seconds`, then an `end` event and close.

    The bound is enforced by the SOCKET TIMEOUT, re-armed before every read to
    whatever is left of the budget. So a quiet pod cannot hold the stream past
    its deadline. The connection is never read again after a timeout -
    http.client's chunked state is not safe to resume.
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
        try:
            conn.request("GET", path, headers={"Authorization": f"Bearer {_token()}",
                                               "Accept": LOG_ACCEPT})
            resp = conn.getresponse()
        except (OSError, http.client.HTTPException) as e:
            raise _unreachable(e) from e
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
        # propagates to handle(), which answers in JSON and audits it FAILED.
        if started:
            audit(c.who, "ACTED", c.action.id, f"{c.ns}/{c.target}",
                  {**c.params, "pod": pod, "container": container, "lines": lines},
                  int((time.monotonic() - t0) * 1000))
            c.http.close_connection = True


def h_delete_completed_pods(c: Ctx) -> dict:
    """Delete pods whose phase is Succeeded - and ONLY those, checked twice.

    The list is field-selected by the apiserver, then every item's phase is
    checked again here, and each delete carries a UID precondition. So a pod
    replaced by a running one of the same name between the list and the delete
    is refused by the apiserver rather than deleted.
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


# ── shared reads ────────────────────────────────────────────────────────────

REVISION = "deployment.kubernetes.io/revision"
RESTARTED_AT = "kubectl.kubernetes.io/restartedAt"
TEMPLATE_LABEL = "bothy.dev/template"
IMAGE_FROM = "bothy.dev/image-from"


def _items(path: str) -> list[dict]:
    return kube("GET", path).get("items") or []


def _m(o: dict) -> dict:
    return o.get("metadata") or {}


def _revision(o: dict) -> int | None:
    raw = (_m(o).get("annotations") or {}).get(REVISION)
    return int(raw) if isinstance(raw, str) and raw.isdigit() else None


def _images(pod_spec: dict) -> list[dict]:
    return [{"container": x.get("name", ""), "image": x.get("image", "")}
            for x in (pod_spec.get("containers") or [])]


def _configmaps_of(pod_spec: dict) -> list[str]:
    """Every ConfigMap a pod template reads - env, envFrom, volumes, projected."""
    found: set[str] = set()
    for x in (pod_spec.get("containers") or []) + (pod_spec.get("initContainers") or []):
        for ef in x.get("envFrom") or []:
            if (ef.get("configMapRef") or {}).get("name"):
                found.add(ef["configMapRef"]["name"])
        for ev in x.get("env") or []:
            ref = ((ev.get("valueFrom") or {}).get("configMapKeyRef") or {}).get("name")
            if ref:
                found.add(ref)
    for v in pod_spec.get("volumes") or []:
        if (v.get("configMap") or {}).get("name"):
            found.add(v["configMap"]["name"])
        for src in (v.get("projected") or {}).get("sources") or []:
            if (src.get("configMap") or {}).get("name"):
                found.add(src["configMap"]["name"])
    return sorted(found)


def _conditions(status: dict) -> list[dict]:
    return [{"type": x.get("type", ""), "status": x.get("status", ""), "reason": x.get("reason", ""),
             "message": (x.get("message") or "")[:300]} for x in (status.get("conditions") or [])]


def _owned_by(o: dict, uid: str) -> bool:
    return any(r.get("uid") == uid and r.get("controller") for r in (_m(o).get("ownerReferences") or []))


def _controller(o: dict) -> dict | None:
    return next((r for r in (_m(o).get("ownerReferences") or []) if r.get("controller")), None)


def _replicasets_of(ns: str, dep: dict) -> list[dict]:
    """The ReplicaSets whose CONTROLLER is this deployment (by uid, not by name)."""
    sel = quote(_selector(dep), safe="")
    uid = _m(dep).get("uid", "")
    rss = _items(f"/apis/apps/v1/namespaces/{ns}/replicasets?labelSelector={sel}")
    return [r for r in rss if _owned_by(r, uid)]


def _check_images(pod_spec: dict, what: str) -> None:
    """Every image a template would run passes the same allowlist set-image does.
    A rollback may not restore what set-image would refuse."""
    pol = CATALOG.policy if isinstance(CATALOG, guard.Catalog) else guard.Policy()
    for x in (pod_spec.get("containers") or []) + (pod_spec.get("initContainers") or []):
        guard.valid_image(x.get("image"), pol.image_registries, f"{what} image of {x.get('name', '?')}")


def _event_rows(items: list[dict]) -> list[dict]:
    out = []
    for e in items:
        obj = e.get("involvedObject") or {}
        last = (e.get("lastTimestamp") or e.get("eventTime")
                or _m(e).get("creationTimestamp") or "")
        out.append({"type": e.get("type") or "Normal", "reason": e.get("reason") or "",
                    "message": (e.get("message") or "")[:1000],
                    "object": f"{obj.get('kind') or ''}/{obj.get('name') or ''}",
                    "count": e.get("count") or 1, "lastSeen": last})
    out.sort(key=lambda x: x["lastSeen"], reverse=True)
    return out


def _read_log(ns: str, pod: str, container: str, tail: int, previous: bool) -> list[str]:
    guard.valid_name(pod, "pod")
    guard.valid_name(container, "container")
    path = (f"/api/v1/namespaces/{ns}/pods/{pod}/log?container={container}&tailLines={tail}"
            f"&limitBytes={LOG_LIMIT_BYTES}" + ("&previous=true" if previous else ""))
    headers = {"Authorization": f"Bearer {_token()}", "Accept": LOG_ACCEPT}
    conn = _connect(API_TIMEOUT)
    try:
        conn.request("GET", path, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
    except (OSError, http.client.HTTPException) as e:
        raise _unreachable(e) from e
    finally:
        conn.close()
    if resp.status != 200:
        if resp.status == 400 and previous:
            # "previous terminated container ... not found" - a pod that never
            # restarted has no previous log, and that is an answer, not a fault.
            raise KubeError(f"{container} in {pod} has no previous instance to read", status=404)
        _answer(resp.status, raw)
    return raw.decode("utf-8", "replace").splitlines()


# ── deployments ─────────────────────────────────────────────────────────────

def h_deployments(c: Ctx) -> dict:
    out = []
    for d in _items(f"/apis/apps/v1/namespaces/{c.ns}/deployments"):
        spec, st = d.get("spec") or {}, d.get("status") or {}
        tspec = (spec.get("template") or {}).get("spec") or {}
        out.append({
            "name": _m(d).get("name", ""),
            "replicas": spec.get("replicas", 1),
            "readyReplicas": st.get("readyReplicas", 0),
            "updatedReplicas": st.get("updatedReplicas", 0),
            "availableReplicas": st.get("availableReplicas", 0),
            "paused": bool(spec.get("paused")),
            "generation": _m(d).get("generation"),
            "observedGeneration": st.get("observedGeneration"),
            "revision": _revision(d),
            "images": _images(tspec),
            "selector": ((spec.get("selector") or {}).get("matchLabels") or {}),
            "templateLabels": (((spec.get("template") or {}).get("metadata") or {}).get("labels") or {}),
            "configmaps": _configmaps_of(tspec),
            "createdAt": _m(d).get("creationTimestamp", ""),
            "conditions": _conditions(st),
        })
    out.sort(key=lambda x: x["name"])
    return {"deployments": out}


def _rollout_status(d: dict) -> dict:
    """kubectl rollout status, as one answer instead of a watch."""
    spec, st, meta = d.get("spec") or {}, d.get("status") or {}, _m(d)
    want = spec.get("replicas", 1)
    upd, ready = st.get("updatedReplicas", 0), st.get("readyReplicas", 0)
    avail, total = st.get("availableReplicas", 0), st.get("replicas", 0)
    name = meta.get("name", "")
    done = False
    if (meta.get("generation") or 0) > (st.get("observedGeneration") or 0):
        msg = "Waiting for the deployment spec update to be observed."
    elif any(x.get("type") == "Progressing" and x.get("reason") == "ProgressDeadlineExceeded"
             for x in st.get("conditions") or []):
        msg = f"{name} exceeded its progress deadline."
    elif spec.get("paused"):
        msg = f"{name} is paused; it will not roll out until it is resumed."
    elif upd < want:
        msg = f"Waiting for rollout to finish: {upd} of {want} new replicas have been updated."
    elif total > upd:
        msg = f"Waiting for rollout to finish: {total - upd} old replicas are pending termination."
    elif avail < upd:
        msg = f"Waiting for rollout to finish: {avail} of {upd} updated replicas are available."
    else:
        msg, done = f"{name} successfully rolled out.", True
    return {"done": done, "message": msg, "replicas": want, "updatedReplicas": upd,
            "readyReplicas": ready, "availableReplicas": avail, "paused": bool(spec.get("paused")),
            "generation": meta.get("generation"), "observedGeneration": st.get("observedGeneration"),
            "revision": _revision(d)}


def h_rollout_status(c: Ctx) -> dict:
    return _rollout_status(kube("GET", _deploy_path(c.ns, c.target)))


def h_rollout_history(c: Ctx) -> dict:
    dep = kube("GET", _deploy_path(c.ns, c.target))
    current = _revision(dep)
    rows = []
    for rs in _replicasets_of(c.ns, dep):
        rev = _revision(rs)
        if rev is None:
            continue
        rows.append({"revision": rev, "replicaset": _m(rs).get("name", ""),
                     "images": _images(((rs.get("spec") or {}).get("template") or {}).get("spec") or {}),
                     "replicas": (rs.get("status") or {}).get("replicas", 0),
                     "readyReplicas": (rs.get("status") or {}).get("readyReplicas", 0),
                     "createdAt": _m(rs).get("creationTimestamp", ""),
                     "current": rev == current})
    rows.sort(key=lambda r: r["revision"], reverse=True)
    return {"current": current, "revisions": rows}


def h_rollback_to_revision(c: Ctx) -> dict:
    """`kubectl rollout undo --to-revision`: the ReplicaSet's template, back on the deployment.

    A JSON patch that REPLACES spec.template (a strategic merge would keep env
    entries and volumes the old revision did not have) and TESTS resourceVersion
    first, so a deployment changed between our read and our write is a 409, not
    a silent overwrite of somebody else's change.
    """
    dep = kube("GET", _deploy_path(c.ns, c.target))
    want = int(c.params["revision"])  # type: ignore[arg-type]
    current = _revision(dep)
    match = [rs for rs in _replicasets_of(c.ns, dep) if _revision(rs) == want]
    if not match:
        raise KubeError(f"{c.target} has no revision {want} - see its history", status=404)
    template = json.loads(json.dumps((match[0].get("spec") or {}).get("template") or {}))
    labels = (template.get("metadata") or {}).get("labels") or {}
    labels.pop("pod-template-hash", None)
    tspec = template.get("spec") or {}
    if want == current:
        return {"fromRevision": current, "toRevision": want, "images": _images(tspec), "skipped": True}
    _check_images(tspec, f"revision {want}")
    patch = [
        {"op": "test", "path": "/metadata/resourceVersion", "value": _m(dep).get("resourceVersion", "")},
        {"op": "replace", "path": "/spec/template", "value": template},
    ]
    after = kube("PATCH", _deploy_path(c.ns, c.target), patch, ctype="application/json-patch+json")
    return {"fromRevision": current, "toRevision": want, "images": _images(tspec),
            "skipped": False, "generation": _m(after).get("generation")}


def _set_paused(c: Ctx, paused: bool) -> dict:
    before = kube("GET", _deploy_path(c.ns, c.target))
    after = kube("PATCH", _deploy_path(c.ns, c.target), {"spec": {"paused": paused}},
                 ctype="application/merge-patch+json")
    return {"from": bool((before.get("spec") or {}).get("paused")),
            "to": bool((after.get("spec") or {}).get("paused"))}


def h_pause(c: Ctx) -> dict:
    return _set_paused(c, True)


def h_resume(c: Ctx) -> dict:
    return _set_paused(c, False)


def h_set_image(c: Ctx) -> dict:
    """One container's image. The image passed guard.valid_image (registry
    allowlist); the container must already be in the template - this never adds
    a container, which a strategic merge on an unknown name would do."""
    dep = kube("GET", _deploy_path(c.ns, c.target))
    containers = (((dep.get("spec") or {}).get("template") or {}).get("spec") or {}).get("containers") or []
    name, image = str(c.params["container"]), str(c.params["image"])
    cur = next((x for x in containers if x.get("name") == name), None)
    if cur is None:
        raise guard.Refused(f"container {name!r} is not in {c.target} - it has "
                            + ", ".join(x.get("name", "") for x in containers), status=404)
    patch = {"spec": {"template": {"spec": {"containers": [{"name": name, "image": image}]}}}}
    kube("PATCH", _deploy_path(c.ns, c.target), patch, ctype="application/strategic-merge-patch+json")
    return {"container": name, "from": cur.get("image", ""), "to": image}


# ── pods ────────────────────────────────────────────────────────────────────

def _pod_status(p: dict) -> str:
    if _m(p).get("deletionTimestamp"):
        return "Terminating"
    for cs in (p.get("status") or {}).get("containerStatuses") or []:
        st = cs.get("state") or {}
        if (st.get("waiting") or {}).get("reason"):
            return st["waiting"]["reason"]
        if (st.get("terminated") or {}).get("reason") and (p.get("status") or {}).get("phase") != "Running":
            return st["terminated"]["reason"]
    phase = (p.get("status") or {}).get("phase") or "Unknown"
    return "Completed" if phase == "Succeeded" else phase


def _owner_of(p: dict, rs_owner: dict[str, dict]) -> dict | None:
    """Deployment for a ReplicaSet's pod (through the ReplicaSet), else the controller."""
    ref = _controller(p)
    if ref is None:
        return None
    if ref.get("kind") == "ReplicaSet":
        up = rs_owner.get(ref.get("uid", ""))
        if up is not None and up.get("kind") == "Deployment":
            return {"kind": "Deployment", "name": up.get("name", "")}
    return {"kind": ref.get("kind", ""), "name": ref.get("name", "")}


def h_pods(c: Ctx) -> dict:
    dep_name = c.params.get("deployment")
    if dep_name:
        dep = kube("GET", _deploy_path(c.ns, str(dep_name)))
        sel = quote(_selector(dep), safe="")
        pods = _items(f"/api/v1/namespaces/{c.ns}/pods?labelSelector={sel}")
    else:
        pods = _items(f"/api/v1/namespaces/{c.ns}/pods")
    rs_owner: dict[str, dict] = {}
    if any((_controller(p) or {}).get("kind") == "ReplicaSet" for p in pods):
        for rs in _items(f"/apis/apps/v1/namespaces/{c.ns}/replicasets"):
            ref = _controller(rs)
            if ref is not None:
                rs_owner[_m(rs).get("uid", "")] = ref
    out = []
    for p in pods:
        st = p.get("status") or {}
        statuses = {x.get("name"): x for x in st.get("containerStatuses") or []}
        containers = []
        for x in (p.get("spec") or {}).get("containers") or []:
            s = statuses.get(x.get("name")) or {}
            state = s.get("state") or {}
            kind = next(iter(state), "")
            containers.append({"name": x.get("name", ""), "image": x.get("image", ""),
                               "ready": bool(s.get("ready")), "restartCount": s.get("restartCount", 0),
                               "state": kind, "reason": (state.get(kind) or {}).get("reason", "")})
        owner = _owner_of(p, rs_owner)
        out.append({
            "name": _m(p).get("name", ""), "phase": st.get("phase", ""), "status": _pod_status(p),
            "readyContainers": sum(1 for x in containers if x["ready"]), "totalContainers": len(containers),
            "restarts": sum(x["restartCount"] for x in containers), "owner": owner,
            "deletable": owner is not None and owner["kind"] in ("Deployment", "Job"),
            "containers": containers, "createdAt": _m(p).get("creationTimestamp", ""),
            "node": (p.get("spec") or {}).get("nodeName", ""),
        })
    out.sort(key=lambda x: (x["owner"]["name"] if x["owner"] else "", x["createdAt"]))
    return {"pods": out}


def h_delete_pod(c: Ctx) -> dict:
    """Delete ONE pod - only one a controller will replace.

    The chain is walked on the apiserver, by uid, not trusted from labels: the
    pod's controller must be a ReplicaSet whose controller is a Deployment that
    exists, or a Job that exists. A bare pod, a StatefulSet's or a DaemonSet's is
    refused - the first would simply be gone, and the others are not what this
    namespace runs. The delete carries the pod's uid as a precondition.
    """
    pod = kube("GET", f"/api/v1/namespaces/{c.ns}/pods/{c.target}")
    uid = _m(pod).get("uid", "")
    ref = _controller(pod) or {}
    owner = None
    if ref.get("kind") == "ReplicaSet":
        rs = kube("GET", f"/apis/apps/v1/namespaces/{c.ns}/replicasets/{guard.valid_name(ref.get('name'), 'replicaset')}")
        up = _controller(rs) or {}
        if rs.get("metadata", {}).get("uid") == ref.get("uid") and up.get("kind") == "Deployment":
            dep = kube("GET", _deploy_path(c.ns, guard.valid_name(up.get("name"), "deployment")))
            if _m(dep).get("uid") == up.get("uid"):
                owner = {"kind": "Deployment", "name": up.get("name", "")}
    elif ref.get("kind") == "Job":
        job = kube("GET", f"/apis/batch/v1/namespaces/{c.ns}/jobs/{guard.valid_name(ref.get('name'), 'job')}")
        if _m(job).get("uid") == ref.get("uid"):
            owner = {"kind": "Job", "name": ref.get("name", "")}
    if owner is None or not uid:
        raise guard.Refused(f"pod {c.target!r} is not managed by a deployment or a job - "
                            "deleting it would not replace it, so bothy-ops will not", status=403)
    kube("DELETE", f"/api/v1/namespaces/{c.ns}/pods/{c.target}",
         {"kind": "DeleteOptions", "apiVersion": "v1", "preconditions": {"uid": uid}})
    return {"deleted": c.target, "owner": owner}


# ── jobs ────────────────────────────────────────────────────────────────────

def _job_status(j: dict) -> str:
    conds = {x.get("type"): x.get("status") for x in (j.get("status") or {}).get("conditions") or []}
    if conds.get("Complete") == "True":
        return "Complete"
    if conds.get("Failed") == "True":
        return "Failed"
    if (j.get("spec") or {}).get("suspend"):
        return "Suspended"
    return "Running"


def h_jobs(c: Ctx) -> dict:
    out = []
    for j in _items(f"/apis/batch/v1/namespaces/{c.ns}/jobs"):
        st = j.get("status") or {}
        out.append({
            "name": _m(j).get("name", ""), "template": (_m(j).get("labels") or {}).get(TEMPLATE_LABEL),
            "status": _job_status(j), "active": st.get("active", 0), "succeeded": st.get("succeeded", 0),
            "failed": st.get("failed", 0), "startTime": st.get("startTime"),
            "completionTime": st.get("completionTime"), "createdAt": _m(j).get("creationTimestamp", ""),
            "images": _images((((j.get("spec") or {}).get("template") or {}).get("spec")) or {}),
        })
    out.sort(key=lambda x: x["createdAt"], reverse=True)
    return {"jobs": out}


def h_job_logs(c: Ctx) -> dict:
    job = kube("GET", f"/apis/batch/v1/namespaces/{c.ns}/jobs/{c.target}")
    uid = _m(job).get("uid", "")
    sel = quote(f"batch.kubernetes.io/controller-uid={uid}", safe="")
    pods = [p for p in _items(f"/api/v1/namespaces/{c.ns}/pods?labelSelector={sel}") if _owned_by(p, uid)]
    if not pods:
        raise KubeError(f"job {c.target} has no pods (yet, or any more)", status=404)
    pods.sort(key=lambda p: _m(p).get("creationTimestamp") or "", reverse=True)
    pod = pods[0]
    containers = [x.get("name", "") for x in (pod.get("spec") or {}).get("containers") or []]
    want = c.params.get("container")
    if want is not None and want not in containers:
        raise guard.Refused(f"container {want!r} is not in pod {_m(pod).get('name')}", status=404)
    container = str(want or containers[0])
    previous = bool(c.params.get("previous"))
    lines = _read_log(c.ns, _m(pod).get("name", ""), container, int(c.params["tail"]), previous)  # type: ignore[arg-type]
    return {"job": c.target, "pod": _m(pod).get("name", ""), "container": container,
            "pods": [_m(p).get("name", "") for p in pods], "containers": containers,
            "previous": previous, "lines": lines}


def h_delete_job(c: Ctx) -> dict:
    job = kube("GET", f"/apis/batch/v1/namespaces/{c.ns}/jobs/{c.target}")
    uid = _m(job).get("uid", "")
    # Background: the Job goes now and the garbage collector removes its pods.
    # (The API's default for a Job is Orphan, which would leave the pods behind.)
    kube("DELETE", f"/apis/batch/v1/namespaces/{c.ns}/jobs/{c.target}",
         {"kind": "DeleteOptions", "apiVersion": "v1", "propagationPolicy": "Background",
          "preconditions": {"uid": uid}})
    return {"deleted": c.target, "propagationPolicy": "Background"}


def template_path(ns: str, name: str) -> str:
    """k8s/job-templates/<ns>/<name>.yaml inside the image. Both parts were checked
    (namespace enum; template in the catalog allowlist AND a K8s name, so no
    slash and no dot) - and the resolved path must still be inside the directory."""
    guard.check_namespace(ns)
    guard.valid_name(name, "template")
    base = os.path.realpath(TEMPLATE_DIR)
    path = os.path.realpath(os.path.join(base, ns, name + ".yaml"))
    if os.path.dirname(os.path.dirname(path)) != base:
        raise guard.Refused("template path escapes the template directory", status=400)
    return path


def read_template(ns: str, name: str) -> dict:
    """A template file: YAML written as JSON (which YAML is a superset of) with
    whole-line `#` comments. Stdlib only - the image has no YAML parser, and a
    template that needs one is a template doing more than a Job should."""
    try:
        with open(template_path(ns, name), encoding="utf-8") as fh:
            text = "".join(ln for ln in fh if not ln.lstrip().startswith("#"))
    except OSError:
        raise KubeError(f"template {name} is not shipped for {ns}", status=404) from None
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as e:
        raise KubeError(f"template {name} for {ns} is malformed ({e.msg})", status=500) from None
    meta = doc.get("metadata") or {}
    if (doc.get("apiVersion"), doc.get("kind")) != ("batch/v1", "Job") or "name" in meta \
            or meta.get("namespace") not in (None, ns) \
            or not str(meta.get("generateName") or "").endswith("-") \
            or not isinstance((meta.get("annotations") or {}).get(IMAGE_FROM), str):
        raise KubeError(f"template {name} for {ns} is not a generateName Job with {IMAGE_FROM}", status=500)
    return doc


def h_run_template(c: Ctx) -> dict:
    """Create a Job from a file in the image - never from the request.

    The request names the template (already checked against the catalog). The
    body is the file. The image is the one the live deployment named in the
    template's bothy.dev/image-from annotation runs NOW, so a migration runs with
    the code that expects it - and it passes the registry allowlist like any
    other image. The name is generateName plus the apiserver's random suffix.
    """
    doc = read_template(c.ns, c.target)
    meta = doc.setdefault("metadata", {})
    src_dep, _, src_container = str(meta["annotations"][IMAGE_FROM]).partition("/")
    dep = kube("GET", _deploy_path(c.ns, guard.valid_name(src_dep, "image-from deployment")))
    containers = (((dep.get("spec") or {}).get("template") or {}).get("spec") or {}).get("containers") or []
    src = next((x for x in containers if x.get("name") == src_container), None)
    if src is None:
        raise KubeError(f"{src_dep} has no container {src_container!r} to take the image from", status=409)
    image = src.get("image", "")
    pol = CATALOG.policy if isinstance(CATALOG, guard.Catalog) else guard.Policy()
    guard.valid_image(image, pol.image_registries, f"{src_dep}'s image")
    meta["namespace"] = c.ns
    meta.setdefault("labels", {}).update({TEMPLATE_LABEL: c.target, "app.kubernetes.io/managed-by": "bothy"})
    pod_meta = doc["spec"]["template"].setdefault("metadata", {})
    pod_meta.setdefault("labels", {}).update({TEMPLATE_LABEL: c.target})
    for x in doc["spec"]["template"]["spec"].get("containers") or []:
        x["image"] = image
    created = kube("POST", f"/apis/batch/v1/namespaces/{c.ns}/jobs", doc)
    return {"job": _m(created).get("name", ""), "template": c.target, "image": image}


# ── configmaps ──────────────────────────────────────────────────────────────

def _cm_path(ns: str, name: str) -> str:
    return f"/api/v1/namespaces/{ns}/configmaps/{name}"


def h_configmap(c: Ctx) -> dict:
    cm = kube("GET", _cm_path(c.ns, c.target))
    keys = CATALOG.policy.configmap_keys if isinstance(CATALOG, guard.Catalog) else {}
    rows = []
    for k, v in sorted((cm.get("data") or {}).items()):
        row: dict[str, object] = {"key": k, "value": v, "editable": k in keys}
        if k in keys:
            row["pattern"], row["meaning"] = keys[k].source, keys[k].meaning
        rows.append(row)
    return {"configmap": c.target, "resourceVersion": _m(cm).get("resourceVersion", ""), "data": rows}


def _patch_key(c: Ctx) -> tuple[dict, dict]:
    key, value = str(c.params["key"]), str(c.params["value"])
    cm = kube("GET", _cm_path(c.ns, c.target))
    data = cm.get("data") or {}
    if key not in data:
        raise guard.Refused(f"{c.target} has no key {key!r} to change - bothy-ops edits keys, "
                            "it does not add them", status=404)
    # resourceVersion in a merge patch is a precondition: a ConfigMap changed
    # since the read above is a 409 instead of a lost update.
    patch = {"metadata": {"resourceVersion": _m(cm).get("resourceVersion", "")}, "data": {key: value}}
    kube("PATCH", _cm_path(c.ns, c.target), patch, ctype="application/merge-patch+json")
    return {"key": key, "from": data[key], "to": value}, cm


def h_patch_key(c: Ctx) -> dict:
    return _patch_key(c)[0]


def h_patch_key_and_restart(c: Ctx) -> dict:
    """patch-key, then a rollout restart of every deployment that reads the
    ConfigMap - found from the templates, not from a list: envFrom, env,
    volumes and projected volumes all count."""
    result, _ = _patch_key(c)
    stamp = _now()
    restarted = []
    for d in _items(f"/apis/apps/v1/namespaces/{c.ns}/deployments"):
        tspec = ((d.get("spec") or {}).get("template") or {}).get("spec") or {}
        if c.target not in _configmaps_of(tspec):
            continue
        name = guard.valid_name(_m(d).get("name"), "deployment")
        kube("PATCH", _deploy_path(c.ns, name),
             {"spec": {"template": {"metadata": {"annotations": {RESTARTED_AT: stamp}}}}},
             ctype="application/strategic-merge-patch+json")
        restarted.append(name)
    return {**result, "restarted": restarted, "restartedAt": stamp}


# ── read-only views ─────────────────────────────────────────────────────────

def h_services(c: Ctx) -> dict:
    out = []
    for s in _items(f"/api/v1/namespaces/{c.ns}/services"):
        spec = s.get("spec") or {}
        out.append({"name": _m(s).get("name", ""), "type": spec.get("type", ""),
                    "clusterIP": spec.get("clusterIP", ""),
                    "ports": [{"name": p.get("name", ""), "port": p.get("port"), "targetPort": p.get("targetPort"),
                               "protocol": p.get("protocol", "TCP"), "nodePort": p.get("nodePort")}
                              for p in spec.get("ports") or []],
                    "selector": spec.get("selector") or {}})
    return {"services": sorted(out, key=lambda x: x["name"])}


def h_routes(c: Ctx) -> dict:
    out = []
    for r in _items(f"/apis/route.openshift.io/v1/namespaces/{c.ns}/routes"):
        spec = r.get("spec") or {}
        ingress = (r.get("status") or {}).get("ingress")
        admitted = None
        if isinstance(ingress, list) and ingress:
            admitted = any(x.get("type") == "Admitted" and x.get("status") == "True"
                           for i in ingress for x in (i.get("conditions") or []))
        out.append({"name": _m(r).get("name", ""), "host": spec.get("host", ""), "path": spec.get("path", ""),
                    "service": (spec.get("to") or {}).get("name", ""),
                    "targetPort": (spec.get("port") or {}).get("targetPort"),
                    "tls": (spec.get("tls") or {}).get("termination"), "admitted": admitted})
    return {"routes": sorted(out, key=lambda x: x["name"])}


def h_ingresses(c: Ctx) -> dict:
    out = []
    for i in _items(f"/apis/networking.k8s.io/v1/namespaces/{c.ns}/ingresses"):
        spec = i.get("spec") or {}
        rules = []
        for rule in spec.get("rules") or []:
            for p in ((rule.get("http") or {}).get("paths") or []):
                svc = ((p.get("backend") or {}).get("service") or {})
                port = svc.get("port") or {}
                rules.append({"host": rule.get("host", ""), "path": p.get("path", "/"),
                              "service": svc.get("name", ""), "port": port.get("number") or port.get("name")})
        out.append({"name": _m(i).get("name", ""), "className": spec.get("ingressClassName"),
                    "rules": rules, "tlsHosts": sorted({h for t in spec.get("tls") or [] for h in t.get("hosts") or []})})
    return {"ingresses": sorted(out, key=lambda x: x["name"])}


def h_persistentvolumeclaims(c: Ctx) -> dict:
    out = []
    for p in _items(f"/api/v1/namespaces/{c.ns}/persistentvolumeclaims"):
        spec, st = p.get("spec") or {}, p.get("status") or {}
        out.append({"name": _m(p).get("name", ""), "phase": st.get("phase", ""),
                    "requested": ((spec.get("resources") or {}).get("requests") or {}).get("storage"),
                    "capacity": (st.get("capacity") or {}).get("storage"),
                    "accessModes": spec.get("accessModes") or [], "storageClass": spec.get("storageClassName"),
                    "volume": spec.get("volumeName")})
    return {"claims": sorted(out, key=lambda x: x["name"])}


def _peers(rules: list[dict], side: str) -> list[str]:
    """A NetworkPolicy rule as one readable line: who, on which ports."""
    lines = []
    for r in rules:
        who = []
        for peer in r.get(side) or []:
            if "ipBlock" in peer:
                who.append(f"cidr {peer['ipBlock'].get('cidr', '?')}")
                continue
            parts = []
            if "namespaceSelector" in peer:
                ml = (peer.get("namespaceSelector") or {}).get("matchLabels") or {}
                parts.append("namespaces " + (",".join(f"{k}={v}" for k, v in ml.items()) or "all"))
            if "podSelector" in peer:
                ml = (peer.get("podSelector") or {}).get("matchLabels") or {}
                parts.append("pods " + (",".join(f"{k}={v}" for k, v in ml.items()) or "all"))
            who.append(" & ".join(parts) or "?")
        ports = [f"{p.get('port', 'any')}/{p.get('protocol', 'TCP')}" for p in r.get("ports") or []]
        lines.append(("anyone" if not r.get(side) else "; ".join(who))
                     + (" on " + ", ".join(ports) if ports else " on any port"))
    return lines


def h_networkpolicies(c: Ctx) -> dict:
    out = []
    for n in _items(f"/apis/networking.k8s.io/v1/namespaces/{c.ns}/networkpolicies"):
        spec = n.get("spec") or {}
        out.append({"name": _m(n).get("name", ""),
                    "podSelector": (spec.get("podSelector") or {}).get("matchLabels") or {},
                    "policyTypes": spec.get("policyTypes") or [],
                    "ingress": _peers(spec.get("ingress") or [], "from"),
                    "egress": _peers(spec.get("egress") or [], "to")})
    return {"policies": sorted(out, key=lambda x: x["name"])}


def h_resourcequotas(c: Ctx) -> dict:
    out = [{"name": _m(q).get("name", ""), "hard": (q.get("status") or {}).get("hard") or (q.get("spec") or {}).get("hard") or {},
            "used": (q.get("status") or {}).get("used") or {}}
           for q in _items(f"/api/v1/namespaces/{c.ns}/resourcequotas")]
    return {"quotas": sorted(out, key=lambda x: x["name"])}


def h_limitranges(c: Ctx) -> dict:
    out = [{"name": _m(lr).get("name", ""),
            "limits": [{"type": x.get("type", ""), "default": x.get("default") or {},
                        "defaultRequest": x.get("defaultRequest") or {}, "max": x.get("max") or {},
                        "min": x.get("min") or {}} for x in (lr.get("spec") or {}).get("limits") or []]}
           for lr in _items(f"/api/v1/namespaces/{c.ns}/limitranges")]
    return {"limitRanges": sorted(out, key=lambda x: x["name"])}


def h_namespace_events(c: Ctx) -> dict:
    """Polled. The Role has no `watch`, on purpose - see catalog.toml."""
    rows = _event_rows(_items(f"/api/v1/namespaces/{c.ns}/events?limit=500"))
    return {"events": rows[: int(c.params["limit"])]}  # type: ignore[arg-type]



# THE HANDLER TABLE. A literal dict, written out. guard.check_handlers compares
# its keys with catalog.toml at startup and refuses to run on any difference.
HANDLERS = {
    "deployments": h_deployments,
    "rollout-status": h_rollout_status,
    "rollout-history": h_rollout_history,
    "rollback-to-revision": h_rollback_to_revision,
    "pause": h_pause,
    "resume": h_resume,
    "set-image": h_set_image,
    "rollout-restart": h_rollout_restart,
    "scale": h_scale,
    "events": h_events,
    "logs": h_logs,
    "pods": h_pods,
    "delete-pod": h_delete_pod,
    "delete-completed-pods": h_delete_completed_pods,
    "jobs": h_jobs,
    "job-logs": h_job_logs,
    "delete-job": h_delete_job,
    "run-template": h_run_template,
    "configmap": h_configmap,
    "patch-key": h_patch_key,
    "patch-key-and-restart": h_patch_key_and_restart,
    "services": h_services,
    "routes": h_routes,
    "ingresses": h_ingresses,
    "persistentvolumeclaims": h_persistentvolumeclaims,
    "networkpolicies": h_networkpolicies,
    "resourcequotas": h_resourcequotas,
    "limitranges": h_limitranges,
    "namespace-events": h_namespace_events,
}


def load() -> guard.Catalog:
    """The catalog, checked against HANDLERS and against the shipped templates.

    A job template the catalog names but the image does not carry (or carries
    malformed) refuses the START, not the click: a Run button that can only ever
    answer 500 is a defect, and this is where the defect is cheap to see.
    """
    with open(CATALOG_FILE, "rb") as fh:
        catalog = guard.load_catalog(tomllib.load(fh))
    guard.check_handlers(catalog.keys(), HANDLERS.keys())
    for ns in guard.NAMESPACES:
        for name in catalog.policy.job_templates:
            try:
                read_template(ns, name)
            except KubeError as e:
                raise guard.CatalogError(f"job template {ns}/{name}: {e}") from None
    return catalog


def catalog_doc() -> dict:
    """GET /kube/catalog - static, from the image; never calls the apiserver."""
    return guard.catalog_json(CATALOG) if isinstance(CATALOG, guard.Catalog) else {}


CATALOG: guard.Catalog | dict[str, guard.Action] = {}


def health() -> dict:
    """For /healthz. Deliberately does NOT call the apiserver - see the header."""
    return {"actions": sorted(CATALOG), "namespaces": list(guard.NAMESPACES),
            "token": os.path.exists(TOKEN_FILE)}


def handle(h, method: str, aid: str) -> None:
    """GET or POST /kube/<aid>. `h` is the bothy-ops JsonHandler."""
    u = urlparse(h.path)
    who = h.actor()
    where, params_for_log = "-", {}
    t0 = time.monotonic()
    try:
        h.check_csrf(method)
        if method == "POST":
            req = h.read_json_object(MAX_BODY)
        else:
            try:
                pairs = parse_qsl(u.query, keep_blank_values=True, max_num_fields=16)
            except ValueError:
                raise guard.Refused("too many query parameters", status=400) from None
            req = {}
            for k, v in pairs:
                if k in req:
                    # `?namespace=thales-dev&namespace=kube-system` - whichever
                    # one a parser keeps, somebody else keeps the other.
                    raise guard.Refused(f"parameter {k[:40]!r} given twice", status=400)
                req[k] = v

        # What was ASKED, for a refusal's audit line - untrusted, truncated, and
        # flattened by the log. Replaced by the checked values below.
        where = (f"{str(req.get('namespace', '-'))[:64]}/"
                 f"{str(req.get('deployment', req.get('namespace', '-')))[:64]}")
        action, ns, target, params = guard.check_request(CATALOG, aid, method, req)
        where, params_for_log = f"{ns}/{target}", params
        result = HANDLERS[action.id](Ctx(action, ns, target, params, h, who))
        if result is None:
            return  # a stream; it wrote its own response and its own audit line
        took = int((time.monotonic() - t0) * 1000)
        audit(who, "ACTED", action.id, where, params, took)
        return h._send(200, {"ok": True, "action": action.id, "namespace": ns,
                             "target": target, "tookMs": took, **result})

    except guard.Refused as e:
        audit(who, "REFUSED", aid[:64], where, {"reason": str(e)[:200]},
              int((time.monotonic() - t0) * 1000))
        return h._send(e.status, {"error": str(e)})
    except KubeError as e:
        audit(who, "FAILED", aid[:64], where, {**params_for_log, "error": str(e)[:200]},
              int((time.monotonic() - t0) * 1000))
        return h._send(e.status, {"error": str(e)})
    except (BrokenPipeError, ConnectionResetError):
        return
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"ERROR /kube/{aid[:64]}: {type(e).__name__}: {e}\n")
        audit(who, "ERROR", aid[:64], where, {"error": type(e).__name__})
        return h._send(500, {"error": "internal error"})
