#!/usr/bin/env python3
"""The HTTP surface, against a stand-in apiserver over real TLS.

Run: python3 checks/api.py

Needs nothing running - no cluster, no docker. Needs `openssl` on PATH, to mint a
throwaway certificate: the stand-in speaks HTTPS and the service verifies it
against a CA file exactly as it verifies minikube's, so the TLS path is the
production path rather than a switch that turns it off for tests.

The stand-in COUNTS what reaches it, so every refusal is a positive assertion:
the request was refused AND nothing arrived at the "cluster".

── what it asserts ─────────────────────────────────────────────────────────

  rollout-restart   strategic-merge PATCH of the template annotation, nothing else
  scale             merge PATCH of the /scale subresource; a no-op reports from == to
  events            only the deployment, its ReplicaSets and its pods
  logs              the deployment's pods only; tail passed through; SSE follow
                    ends at its deadline even when the pod is silent
  delete-completed  only phase Succeeded, re-checked per pod, UID precondition
  refusals          kube-system, secrets, unknown action, traversal, CSRF,
                    repeated params, type-name without confirm - none reach it
  failures          apiserver 403 -> 502 naming the Role; no token -> 503
  streams           the concurrent-follow cap answers 429
  audit             one TSV line per request, seven fields, the right outcome
  startup           a catalog with an unhandled id refuses to start (exit 2)
                    ... or a job template the image does not carry
  catalog           GET /kube/catalog is the catalog, and asks the apiserver nothing
  deployments       list, rollout-status, rollout-history (only its own RS, by uid)
  rollback          JSON patch replacing the template, resourceVersion tested,
                    pod-template-hash stripped; a docker.io revision is refused
  pause/resume      merge patch of spec.paused
  set-image         strategic merge of one container; unknown container refused
  pods              owners resolved through the ReplicaSet to the Deployment
  delete-pod        only a Deployment's or a Job's pod, UID precondition
  jobs              list, logs (only the job's pods), delete Background
  run-template      the body is the FILE; the image is the backend's; never input
  configmap         view, patch-key (resourceVersion precondition), and-restart
                    restarts exactly the deployments that read the ConfigMap
  views             services, routes, ingresses, PVCs, netpols, quotas, limits,
                    namespace events
"""
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)

TMP = tempfile.mkdtemp(prefix="bothy-ops-api-kube-")
AUDIT = os.path.join(TMP, "actions.log")
TOKEN = os.path.join(TMP, "token")
CERT = os.path.join(TMP, "tls.crt")
KEY = os.path.join(TMP, "tls.key")
os.environ["AUDIT_LOG"] = AUDIT
os.environ["KUBE_TOKEN_FILE"] = TOKEN
os.environ["KUBE_CA_FILE"] = CERT

import app  # noqa: E402
import kube  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


if not shutil.which("openssl"):
    print("  SKIP  openssl not found - cannot mint a test certificate")
    sys.exit(1)
subprocess.run(
    ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", KEY, "-out", CERT,
     "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
    check=True, capture_output=True)
with open(TOKEN, "w") as fh:
    fh.write("test-token\n")

# ── the stand-in apiserver ──────────────────────────────────────────────────

SEEN: list[tuple[str, str, dict | None, str]] = []
MODE = {"forbid": False}
REPLICAS = {"algorithm": 1, "frontend": 1}
ANNOT: dict[str, str] = {}
GEN = {"frontend": 7}


def deployment(name: str) -> dict:
    """A deployment as the apiserver would answer it. The template is the live
    shape of the Thales deployments: one container named after the deployment,
    envFrom the `thales` ConfigMap, a revision annotation."""
    image = IMAGES.setdefault(name, {name: f"thales/{name}:0.1.7"})
    return {"metadata": {"name": name, "uid": f"uid-{name}", "generation": GEN.get(name, 1),
                         "resourceVersion": str(RV.get(name, 100)),
                         "annotations": {"deployment.kubernetes.io/revision": str(REV.get(name, 5))},
                         "creationTimestamp": "2026-09-16T00:00:00Z"},
            "spec": {"replicas": REPLICAS.get(name, 1), "paused": PAUSED.get(name, False),
                     "selector": {"matchLabels": {"app.kubernetes.io/name": name}},
                     "template": {"metadata": {"labels": {"app.kubernetes.io/name": name}},
                                  "spec": {"containers": [
                                      {"name": c, "image": i,
                                       **({"envFrom": [{"configMapRef": {"name": "thales"}}]} if name != "postgres" else {})}
                                      for c, i in image.items()]}}},
            "status": {"replicas": REPLICAS.get(name, 1), "updatedReplicas": REPLICAS.get(name, 1),
                       "readyReplicas": REPLICAS.get(name, 1), "availableReplicas": REPLICAS.get(name, 1),
                       "observedGeneration": GEN.get(name, 1)}}


PODS = {
    "frontend": [
        {"metadata": {"name": "frontend-6d9-old", "creationTimestamp": "2026-09-01T00:00:00Z", "uid": "u1"},
         "status": {"phase": "Running"}, "spec": {"containers": [{"name": "nginx"}]}},
        {"metadata": {"name": "frontend-6d9-new", "creationTimestamp": "2026-09-17T00:00:00Z", "uid": "u2"},
         "status": {"phase": "Running"}, "spec": {"containers": [{"name": "nginx"}, {"name": "sidecar"}]}},
    ],
}
COMPLETED = [
    {"metadata": {"name": "migrate-1", "uid": "c1"}, "status": {"phase": "Succeeded"}},
    {"metadata": {"name": "migrate-2", "uid": "c2"}, "status": {"phase": "Succeeded"}},
    # The stand-in ignores the field selector on purpose, so this proves the
    # service re-checks phase itself instead of trusting the list.
    {"metadata": {"name": "postgres-0", "uid": "c3"}, "status": {"phase": "Running"}},
]
EVENTS = [
    {"involvedObject": {"kind": "Deployment", "name": "frontend"}, "reason": "ScalingReplicaSet",
     "message": "Scaled up", "lastTimestamp": "2026-09-17T10:00:00Z", "type": "Normal"},
    {"involvedObject": {"kind": "ReplicaSet", "name": "frontend-6d9"}, "reason": "SuccessfulCreate",
     "message": "Created pod", "lastTimestamp": "2026-09-17T10:00:01Z", "type": "Normal"},
    {"involvedObject": {"kind": "Pod", "name": "frontend-6d9-new"}, "reason": "BackOff",
     "message": "Back-off", "lastTimestamp": "2026-09-17T10:00:02Z", "type": "Warning"},
    {"involvedObject": {"kind": "Pod", "name": "frontend2-abc"}, "reason": "Other", "message": "no",
     "lastTimestamp": "2026-09-17T10:00:03Z"},
    {"involvedObject": {"kind": "Pod", "name": "backend-abc"}, "reason": "Other", "message": "no",
     "lastTimestamp": "2026-09-17T10:00:04Z"},
    {"involvedObject": {"kind": "Secret", "name": "frontend-tls"}, "reason": "Other", "message": "no",
     "lastTimestamp": "2026-09-17T10:00:05Z"},
]


RV: dict[str, int] = {}
REV: dict[str, int] = {"backend": 5}
PAUSED: dict[str, bool] = {}
IMAGES: dict[str, dict[str, str]] = {"postgres": {"postgres": "postgres:16-alpine"}}
TEMPLATE_SET: dict[str, dict] = {}
REPLICAS.update({"backend": 1, "postgres": 1})


def rs(name: str, rev: int, image: str, owner_uid: str = "uid-backend", hash_: str = "h") -> dict:
    return {"metadata": {"name": name, "uid": f"uid-{name}", "creationTimestamp": f"2026-09-1{rev}T00:00:00Z",
                         "annotations": {"deployment.kubernetes.io/revision": str(rev)},
                         "ownerReferences": [{"kind": "Deployment", "name": "backend", "uid": owner_uid,
                                              "controller": True}]},
            "spec": {"template": {"metadata": {"labels": {"app.kubernetes.io/name": "backend",
                                                          "pod-template-hash": hash_}},
                                  "spec": {"containers": [{"name": "backend", "image": image}]}}},
            "status": {"replicas": 1 if rev == 5 else 0, "readyReplicas": 1 if rev == 5 else 0}}


RSS = [
    rs("backend-aaa", 3, "thales/backend:0.1.5", hash_="aaa"),
    rs("backend-bbb", 4, "thales/backend:0.1.6", hash_="bbb"),
    rs("backend-ccc", 5, "thales/backend:0.1.7", hash_="ccc"),
    rs("backend-old", 2, "docker.io/library/node:22", hash_="old"),
    # Same labels, same revision number, another owner: must never be listed or used.
    rs("backend-foreign", 4, "thales/evil:1", owner_uid="uid-someone-else", hash_="zzz"),
    {"metadata": {"name": "frontend-6d9", "uid": "uid-rs-frontend",
                  "ownerReferences": [{"kind": "Deployment", "name": "frontend", "uid": "uid-frontend",
                                       "controller": True}]}},
    {"metadata": {"name": "orphan-rs", "uid": "uid-rs-orphan"}},
]


def pod(name: str, owner: tuple[str, str, str] | None, phase: str = "Running", restarts: int = 0,
        waiting: str | None = None) -> dict:
    meta: dict = {"name": name, "uid": f"uid-{name}", "creationTimestamp": "2026-09-17T00:00:00Z"}
    if owner:
        meta["ownerReferences"] = [{"kind": owner[0], "name": owner[1], "uid": owner[2], "controller": True}]
    state = {"waiting": {"reason": waiting}} if waiting else {"running": {}}
    return {"metadata": meta, "spec": {"containers": [{"name": "main", "image": "thales/x:1"}], "nodeName": "n1"},
            "status": {"phase": phase, "containerStatuses": [
                {"name": "main", "ready": phase == "Running" and not waiting, "restartCount": restarts,
                 "state": state}]}}


POD_OBJS = {
    "frontend-6d9-new": pod("frontend-6d9-new", ("ReplicaSet", "frontend-6d9", "uid-rs-frontend")),
    "migrate-abc-x1": pod("migrate-abc-x1", ("Job", "thales-migrate-abc", "uid-job-migrate"), "Succeeded"),
    "bare-pod": pod("bare-pod", None),
    "db-0": pod("db-0", ("StatefulSet", "db", "uid-sts-db")),
    "orphaned-rs-pod": pod("orphaned-rs-pod", ("ReplicaSet", "orphan-rs", "uid-rs-orphan")),
    "lying-pod": pod("lying-pod", ("ReplicaSet", "frontend-6d9", "uid-not-that-rs")),
    "crashy": pod("crashy", ("ReplicaSet", "frontend-6d9", "uid-rs-frontend"), restarts=7, waiting="CrashLoopBackOff"),
}
ALL_PODS = list(POD_OBJS.values())
RESTARTED_PODS = {"crashy"}
JOBS = {
    "thales-migrate-abc": {
        "metadata": {"name": "thales-migrate-abc", "uid": "uid-job-migrate", "creationTimestamp": "2026-09-17T01:00:00Z",
                     "labels": {"bothy.dev/template": "migrate"}},
        "spec": {"template": {"spec": {"containers": [{"name": "migrate", "image": "thales/backend:0.1.7"}]}}},
        "status": {"succeeded": 1, "startTime": "2026-09-17T01:00:00Z", "completionTime": "2026-09-17T01:00:09Z",
                   "conditions": [{"type": "Complete", "status": "True"}]}},
    "seed-failed": {
        "metadata": {"name": "seed-failed", "uid": "uid-job-seed", "creationTimestamp": "2026-09-16T01:00:00Z"},
        "spec": {"template": {"spec": {"containers": [{"name": "seed", "image": "thales/backend:0.1.7"}]}}},
        "status": {"failed": 1, "conditions": [{"type": "Failed", "status": "True"}]}},
    "empty-job": {"metadata": {"name": "empty-job", "uid": "uid-job-empty"}, "spec": {}, "status": {}},
}
JOB_PODS = {"uid-job-migrate": [POD_OBJS["migrate-abc-x1"],
                                # labelled like the job's pod but owned by something else
                                pod("impostor", ("Job", "other", "uid-other-job"))]}
CREATED: list[dict] = []
DELETED: list[tuple[str, dict | None]] = []
CM = {"data": {"LOG_LEVEL": "info", "DB_POOL_MAX": "10", "JOB_MAX_WORKERS": "2",
               "DATABASE_HOST": "postgres", "DEMO_LOGINS": "true"}, "rv": 700}
VIEWS = {
    "services": [{"metadata": {"name": "frontend"}, "spec": {"type": "ClusterIP", "clusterIP": "10.0.0.1",
                  "ports": [{"name": "http", "port": 8080, "targetPort": 8080, "protocol": "TCP"}],
                  "selector": {"app": "frontend"}}}],
    "routes": [{"metadata": {"name": "thales"}, "spec": {"host": "thales.example", "to": {"kind": "Service", "name": "frontend"},
                "port": {"targetPort": "http"}, "tls": {"termination": "edge"}}}],
    "ingresses": [{"metadata": {"name": "web"}, "spec": {"ingressClassName": "nginx", "rules": [
        {"host": "a.example", "http": {"paths": [{"path": "/", "backend": {"service": {"name": "frontend",
                                                                                    "port": {"number": 8080}}}}]}}],
        "tls": [{"hosts": ["a.example"]}]}}],
    "persistentvolumeclaims": [{"metadata": {"name": "postgres"}, "spec": {"accessModes": ["ReadWriteOnce"],
        "resources": {"requests": {"storage": "10Gi"}}, "storageClassName": "standard", "volumeName": "pvc-1"},
        "status": {"phase": "Bound", "capacity": {"storage": "10Gi"}}}],
    "networkpolicies": [{"metadata": {"name": "db-only-backend"}, "spec": {
        "podSelector": {"matchLabels": {"app": "postgres"}}, "policyTypes": ["Ingress"],
        "ingress": [{"from": [{"podSelector": {"matchLabels": {"app": "backend"}}}], "ports": [{"port": 5432}]}]}}],
    "resourcequotas": [{"metadata": {"name": "compute"}, "spec": {"hard": {"pods": "20"}},
                        "status": {"hard": {"pods": "20"}, "used": {"pods": "6"}}}],
    "limitranges": [{"metadata": {"name": "defaults"}, "spec": {"limits": [
        {"type": "Container", "default": {"cpu": "500m"}, "defaultRequest": {"cpu": "100m"}}]}}],
}


class Fake(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, code: int, doc: dict) -> None:
        b = json.dumps(doc).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _body(self) -> dict | None:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n)) if n else None

    def _handle(self, method: str) -> None:
        body = self._body()
        SEEN.append((method, self.path, body, self.headers.get("Content-Type") or ""))
        if self.headers.get("Authorization") != "Bearer test-token":
            return self._json(401, {"message": "Unauthorized"})
        if MODE["forbid"]:
            return self._json(403, {"message": 'deployments.apps "x" is forbidden'})
        u = urlparse(self.path)
        q = parse_qs(u.query)
        parts = u.path.strip("/").split("/")
        # /apis/apps/v1/namespaces/<ns>/deployments/<name>[/scale]
        if parts[:3] == ["apis", "apps", "v1"] and len(parts) >= 7 and parts[5] == "deployments":
            name = parts[6]
            if name not in REPLICAS:
                return self._json(404, {"message": f'deployments.apps "{name}" not found'})
            if len(parts) == 8 and parts[7] == "scale":
                if method == "PATCH":
                    REPLICAS[name] = body["spec"]["replicas"]
                return self._json(200, {"spec": {"replicas": REPLICAS[name]}})
            if method == "PATCH":
                ctype = self.headers.get("Content-Type") or ""
                if ctype == "application/json-patch+json":
                    test = next((o for o in body if o["op"] == "test"), None)
                    if test is None or test["value"] != str(RV.get(name, 100)):
                        return self._json(422, {"message": "the test operation failed"})
                    TEMPLATE_SET[name] = next(o["value"] for o in body if o["op"] == "replace")
                    RV[name] = RV.get(name, 100) + 1
                elif ctype == "application/merge-patch+json":
                    PAUSED[name] = body["spec"]["paused"]
                else:
                    tmpl = body["spec"]["template"]
                    ann = (tmpl.get("metadata") or {}).get("annotations") or {}
                    if "kubectl.kubernetes.io/restartedAt" in ann:
                        ANNOT[name] = ann["kubectl.kubernetes.io/restartedAt"]
                    for c in (tmpl.get("spec") or {}).get("containers") or []:
                        IMAGES[name][c["name"]] = c["image"]
                GEN[name] = GEN.get(name, 1) + 1
            return self._json(200, deployment(name))
        # /apis/apps/v1/namespaces/<ns>/replicasets[/<name>]
        if parts[:3] == ["apis", "apps", "v1"] and len(parts) >= 6 and parts[5] == "replicasets":
            if len(parts) == 7:
                one = next((r for r in RSS if r["metadata"]["name"] == parts[6]), None)
                return self._json(200, one) if one else self._json(404, {"message": "replicasets not found"})
            return self._json(200, {"items": RSS})
        if parts[:2] == ["apis", "apps"] and len(parts) == 6 and parts[5] == "deployments":
            return self._json(200, {"items": [deployment(n) for n in sorted(REPLICAS)]})
        # /apis/batch/v1/namespaces/<ns>/jobs[/<name>]
        if parts[:3] == ["apis", "batch", "v1"] and len(parts) >= 6 and parts[5] == "jobs":
            if len(parts) == 6 and method == "POST":
                CREATED.append(body)
                made = json.loads(json.dumps(body))
                made["metadata"]["name"] = made["metadata"]["generateName"] + "q7x2k"
                return self._json(201, made)
            if len(parts) == 6:
                return self._json(200, {"items": list(JOBS.values())})
            job = JOBS.get(parts[6])
            if job is None:
                return self._json(404, {"message": "jobs.batch not found"})
            if method == "DELETE":
                DELETED.append((self.path, body))
            return self._json(200, job)
        if parts[:3] == ["apis", "route.openshift.io", "v1"] and len(parts) == 6:
            return self._json(200, {"items": VIEWS["routes"]})
        if parts[:3] == ["apis", "networking.k8s.io", "v1"] and len(parts) == 6:
            return self._json(200, {"items": VIEWS[parts[5]]})
        if parts[:2] == ["api", "v1"] and len(parts) >= 5 and parts[4] in VIEWS:
            return self._json(200, {"items": VIEWS[parts[4]]})
        if parts[:2] == ["api", "v1"] and len(parts) >= 5 and parts[4] == "configmaps":
            if parts[5] != "thales":
                return self._json(404, {"message": "configmaps not found"})
            if method == "PATCH":
                if body["metadata"]["resourceVersion"] != str(CM["rv"]):
                    return self._json(409, {"message": "the object has been modified"})
                CM["data"].update(body["data"])
                CM["rv"] += 1
            return self._json(200, {"metadata": {"name": "thales", "resourceVersion": str(CM["rv"])},
                                    "data": dict(CM["data"])})
        if parts[:2] == ["api", "v1"] and len(parts) == 6 and parts[4] == "pods" and method == "DELETE":
            DELETED.append((self.path, body))
        if parts[:2] == ["api", "v1"] and len(parts) >= 5:
            kind = parts[4]
            if kind == "events":
                return self._json(200, {"items": EVENTS})
            if kind == "pods" and len(parts) == 5:
                if "labelSelector" in q:
                    key, app_name = q["labelSelector"][0].split("=", 1)
                    if key == "batch.kubernetes.io/controller-uid":
                        return self._json(200, {"items": JOB_PODS.get(app_name, [])})
                    return self._json(200, {"items": PODS.get(app_name, [])})
                if "fieldSelector" in q:
                    return self._json(200, {"items": COMPLETED})
                return self._json(200, {"items": ALL_PODS})
            if kind == "pods" and len(parts) == 6 and method == "GET":
                pod = POD_OBJS.get(parts[5])
                return self._json(200, pod) if pod else self._json(404, {"message": "pods not found"})
            if kind == "pods" and len(parts) == 6 and method == "DELETE":
                return self._json(200, {"status": "Success"})
            if kind == "pods" and len(parts) == 7 and parts[6] == "log":
                if self.headers.get("Accept") == "text/plain":
                    # What the real apiserver does - see kube.LOG_ACCEPT.
                    return self._json(406, {"message": "only the following media types are accepted"})
                if q.get("follow") == ["true"]:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/plain")
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    for i in range(3):
                        line = f"follow line {i}\n".encode()
                        self.wfile.write(f"{len(line):x}\r\n".encode() + line + b"\r\n")
                        self.wfile.flush()
                    time.sleep(30)  # a silent pod; the service must not wait for this
                    return
                if q.get("previous") == ["true"] and parts[5] not in RESTARTED_PODS:
                    return self._json(400, {"message": f'previous terminated container "x" in pod "{parts[5]}" not found'})
                n = int(q.get("tailLines", ["10"])[0])
                text = "".join(f"{parts[5]} line {i}\n" for i in range(n)).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(text)))
                self.end_headers()
                self.wfile.write(text)
                return
        return self._json(404, {"message": "no route"})

    def do_GET(self):  # noqa: N802
        self._handle("GET")

    def do_PATCH(self):  # noqa: N802
        self._handle("PATCH")

    def do_DELETE(self):  # noqa: N802
        self._handle("DELETE")

    def do_POST(self):  # noqa: N802
        self._handle("POST")


fake = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
fake.daemon_threads = True
sctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
sctx.load_cert_chain(CERT, KEY)
fake.socket = sctx.wrap_socket(fake.socket, server_side=True)
threading.Thread(target=fake.serve_forever, daemon=True).start()

kube.KUBE_API = f"https://127.0.0.1:{fake.server_address[1]}"
kube.CATALOG = kube.load()
svc = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
svc.daemon_threads = True
threading.Thread(target=svc.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{svc.server_address[1]}"


def call(method: str, path: str, body=None, headers=None, raw: bytes | None = None):
    h = {"Sec-Fetch-Site": "same-origin", "X-Auth-Request-Email": "op@example.test"}
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), e.read()


def js(b: bytes) -> dict:
    try:
        return json.loads(b)
    except json.JSONDecodeError:
        return {}


def untouched(label: str, fn) -> tuple:
    before = len(SEEN)
    res = fn()
    ok(len(SEEN) == before, f"{label}: nothing reached the apiserver")
    return res


print("── rollout-restart ──────────────────────────────────────────────")
SEEN.clear()
st, _, b = call("POST", "/kube/rollout-restart", {"namespace": "thales-dev", "deployment": "frontend"})
d = js(b)
ok(st == 200 and d.get("ok") is True, f"200 ok ({st})")
ok(d.get("fromGeneration") == 7 and d.get("toGeneration") == 8, "generation 7 -> 8 reported")
ok(ANNOT.get("frontend") == d.get("restartedAt"), "the template annotation carries restartedAt")
patches = [s for s in SEEN if s[0] == "PATCH"]
ok(len(patches) == 1 and patches[0][3] == "application/strategic-merge-patch+json",
   "exactly one strategic-merge PATCH")
ok(patches and set(patches[0][2]) == {"spec"} and set(patches[0][2]["spec"]) == {"template"},
   "the patch touches spec.template and nothing else")

print()
print("── scale ────────────────────────────────────────────────────────")
SEEN.clear()
st, _, b = call("POST", "/kube/scale", {"namespace": "thales-dev", "deployment": "algorithm",
                                         "replicas": 1})
d = js(b)
ok(st == 200 and d.get("from") == 1 and d.get("to") == 1, f"no-op scale reports 1 -> 1 ({st} {d})")
ok(any(s[0] == "PATCH" and s[1].endswith("/deployments/algorithm/scale")
       and s[3] == "application/merge-patch+json" for s in SEEN), "merge PATCH on /scale")
ok(not any(s[0] == "PATCH" and s[1].endswith("/deployments/algorithm") for s in SEEN),
   "the deployment spec itself is never patched")
st, _, b = call("POST", "/kube/scale", {"namespace": "thales-dev", "deployment": "algorithm",
                                         "replicas": 2})
ok(st == 200 and js(b).get("from") == 1 and js(b).get("to") == 2, "scale 1 -> 2")
REPLICAS["algorithm"] = 1
# 0 is the escalated value (CL-4): the name is checked here, not only in the
# dialog, so the level means the same thing from curl.
untouched("scale to 0 without the name", lambda: ok(
    call("POST", "/kube/scale", {"namespace": "thales-dev", "deployment": "algorithm", "replicas": 0})[0] == 400,
    "scale to 0 without type-name confirm -> 400"))
untouched("scale to 0 with the wrong name", lambda: ok(
    call("POST", "/kube/scale", {"namespace": "thales-dev", "deployment": "algorithm", "replicas": 0,
                                 "confirm": "frontend"})[0] == 400, "scale to 0, wrong name -> 400"))
untouched("scale to 1 given a confirm", lambda: ok(
    call("POST", "/kube/scale", {"namespace": "thales-dev", "deployment": "algorithm", "replicas": 1,
                                 "confirm": "algorithm"})[0] == 400,
    "a click-level scale takes no confirm field -> 400"))
st, _, b = call("POST", "/kube/scale", {"namespace": "thales-dev", "deployment": "algorithm",
                                        "replicas": 0, "confirm": "algorithm"})
ok(st == 200 and js(b).get("to") == 0, f"scale to 0, confirmed by name ({st} {js(b)})")
REPLICAS["algorithm"] = 1
untouched("scale to 4", lambda: ok(
    call("POST", "/kube/scale", {"namespace": "thales-dev", "deployment": "algorithm", "replicas": 4})[0] == 400,
    "scale to 4 -> 400"))

print()
print("── events ───────────────────────────────────────────────────────")
st, _, b = call("GET", "/kube/events?namespace=thales-dev&deployment=frontend")
evs = js(b).get("events", [])
objs = [e["object"] for e in evs]
ok(st == 200 and objs == ["Pod/frontend-6d9-new", "ReplicaSet/frontend-6d9", "Deployment/frontend"],
   f"only the deployment, its ReplicaSet and its pod, newest first: {objs}")
st, _, b = call("GET", "/kube/events?namespace=thales-dev&deployment=nope")
ok(st == 404, f"events for a deployment that does not exist -> 404 ({st})")

print()
print("── logs ─────────────────────────────────────────────────────────")
SEEN.clear()
st, _, b = call("GET", "/kube/logs?namespace=thales-dev&deployment=frontend&tail=3")
d = js(b)
ok(st == 200 and d.get("pod") == "frontend-6d9-new" and d.get("container") == "nginx",
   f"newest running pod, first container ({d.get('pod')}/{d.get('container')})")
ok(d.get("lines") == [f"frontend-6d9-new line {i}" for i in range(3)], "tail=3 gives three lines")
ok(any("tailLines=3" in s[1] and "limitBytes=" in s[1] for s in SEEN), "tailLines and limitBytes passed")
st, _, b = call("GET", "/kube/logs?namespace=thales-dev&deployment=frontend&pod=frontend-6d9-old&container=nginx")
ok(st == 200 and js(b).get("pod") == "frontend-6d9-old", "a named pod of the deployment")
before = len([s for s in SEEN if "/log" in s[1]])
st, _, b = call("GET", "/kube/logs?namespace=thales-dev&deployment=frontend&pod=postgres-0")
ok(st == 404 and len([s for s in SEEN if "/log" in s[1]]) == before,
   f"a pod outside the deployment's selector -> 404, no log read ({st})")
st, _, b = call("GET", "/kube/logs?namespace=thales-dev&deployment=frontend&container=db")
ok(st == 404, f"a container not in the pod -> 404 ({st})")

t0 = time.monotonic()
st, ctype, b = call("GET", "/kube/logs?namespace=thales-dev&deployment=frontend&follow=true&seconds=5")
took = time.monotonic() - t0
text = b.decode()
ok(st == 200 and ctype.startswith("text/event-stream"), f"follow answers text/event-stream ({st} {ctype})")
ok("event: meta" in text and "data: follow line 2" in text and "event: end" in text,
   "meta, the lines, and an end event")
ok(4.5 <= took <= 9, f"a silent pod does not hold the stream past its deadline ({took:.1f}s for 5s)")

kube._STREAMS = __import__("threading").BoundedSemaphore(1)
kube._STREAMS.acquire()
st, _, _ = call("GET", "/kube/logs?namespace=thales-dev&deployment=frontend&follow=true&seconds=5")
ok(st == 429, f"the concurrent-follow cap answers 429 ({st})")
kube._STREAMS.release()

print()
print("── delete-completed-pods ────────────────────────────────────────")
SEEN.clear()
st, _, b = call("POST", "/kube/delete-completed-pods", {"namespace": "thales-dev", "confirm": "thales-dev"})
d = js(b)
dels = [s for s in SEEN if s[0] == "DELETE"]
ok(st == 200 and d.get("deleted") == ["migrate-1", "migrate-2"], f"only Succeeded pods deleted: {d.get('deleted')}")
ok(d.get("skipped") == ["postgres-0"], "a Running pod in the list is skipped, not deleted")
ok(all(s[2] and s[2].get("preconditions", {}).get("uid") for s in dels) and len(dels) == 2,
   "every delete carries a UID precondition")
ok(any("fieldSelector=status.phase%3DSucceeded" in s[1] for s in SEEN), "listed with the phase field selector")

print()
print("── catalog ──────────────────────────────────────────────────────")
SEEN.clear()
st, ctype, b = call("GET", "/kube/catalog")
d = js(b)
import guard  # noqa: E402
ok(st == 200 and ctype.startswith("application/json") and d == guard.catalog_json(kube.CATALOG),
   f"GET /kube/catalog is the catalog ({st}, {len(d.get('actions', []))} actions)")
ok(d.get("namespaces") == ["thales-dev", "thales-pre-prod"] and d.get("jobTemplates") == ["migrate", "seed-identity", "seed-reference"]
   and set(d.get("configmapKeys", {})) == {"LOG_LEVEL", "DB_POOL_MAX", "JOB_MAX_WORKERS"},
   "it carries the namespaces, templates and editable keys")
ok(not any("rbac" in a for a in d.get("actions", [])), "it does not publish the rbac declarations")
ok(len(SEEN) == 0, "the catalog asks the apiserver nothing")
st, _, _ = call("GET", "/kube/catalog", headers={"Sec-Fetch-Site": "cross-site"})
ok(st == 403, f"cross-site catalog read -> 403 ({st})")

NS = "namespace=thales-dev"

print()
print("── deployments: list, status, history ───────────────────────────")
st, _, b = call("GET", f"/kube/deployments?{NS}")
deps = {x["name"]: x for x in js(b).get("deployments", [])}
ok(st == 200 and {"frontend", "backend", "postgres"} <= set(deps), f"deployments listed ({st} {sorted(deps)})")
ok(deps.get("backend", {}).get("images") == [{"container": "backend", "image": "thales/backend:0.1.7"}]
   and deps["backend"]["configmaps"] == ["thales"] and deps["backend"]["revision"] == 5,
   "images, configmaps read and revision reported")
ok(deps.get("postgres", {}).get("configmaps") == [], "a deployment that reads no ConfigMap says so")
st, _, b = call("GET", f"/kube/rollout-status?{NS}&deployment=backend")
ok(st == 200 and js(b).get("done") is True and "successfully rolled out" in js(b).get("message", ""),
   f"rollout-status done ({st} {js(b).get('message')})")
PAUSED["backend"] = True
st, _, b = call("GET", f"/kube/rollout-status?{NS}&deployment=backend")
ok(st == 200 and js(b).get("done") is False and "paused" in js(b).get("message", ""), "a paused deployment is not done")
PAUSED["backend"] = False
st, _, b = call("GET", f"/kube/rollout-history?{NS}&deployment=backend")
d = js(b)
revs = [r["revision"] for r in d.get("revisions", [])]
ok(st == 200 and revs == [5, 4, 3, 2] and d.get("current") == 5, f"history newest first, own ReplicaSets only: {revs}")
ok(not any(r["replicaset"] == "backend-foreign" for r in d.get("revisions", [])),
   "a ReplicaSet with the same labels and another owner is not history")
ok([r["current"] for r in d.get("revisions", [])] == [True, False, False, False], "the current revision is marked")
st, _, _ = call("GET", f"/kube/rollout-history?{NS}&deployment=nope")
ok(st == 404, f"history of a missing deployment -> 404 ({st})")

print()
print("── rollback-to-revision ─────────────────────────────────────────")
SEEN.clear()
RB = {"namespace": "thales-dev", "deployment": "backend"}
st, _, b = call("POST", "/kube/rollback-to-revision", {**RB, "revision": 4})
d = js(b)
patches = [x for x in SEEN if x[0] == "PATCH"]
ok(st == 200 and d.get("fromRevision") == 5 and d.get("toRevision") == 4 and d.get("skipped") is False,
   f"rolled back 5 -> 4 ({st} {d})")
ok(len(patches) == 1 and patches[0][3] == "application/json-patch+json"
   and [o["op"] for o in patches[0][2]] == ["test", "replace"] and patches[0][2][1]["path"] == "/spec/template",
   "one JSON patch: test resourceVersion, replace /spec/template")
ok(TEMPLATE_SET.get("backend", {}).get("spec", {}).get("containers") == [{"name": "backend", "image": "thales/backend:0.1.6"}],
   "the template is revision 4's, not the foreign ReplicaSet's")
ok("pod-template-hash" not in TEMPLATE_SET.get("backend", {}).get("metadata", {}).get("labels", {}),
   "pod-template-hash is stripped")
SEEN.clear()
st, _, b = call("POST", "/kube/rollback-to-revision", {**RB, "revision": 5})
ok(st == 200 and js(b).get("skipped") is True and not any(x[0] == "PATCH" for x in SEEN),
   f"rolling back to the current revision is a no-op ({st})")
SEEN.clear()
st, _, b = call("POST", "/kube/rollback-to-revision", {**RB, "revision": 2})
ok(st == 403 and "allowed registry" in js(b).get("error", "") and not any(x[0] == "PATCH" for x in SEEN),
   f"a revision running docker.io/library/node is refused, nothing patched ({st})")
st, _, b = call("POST", "/kube/rollback-to-revision", {**RB, "revision": 9})
ok(st == 404 and not any(x[0] == "PATCH" for x in SEEN), f"a revision that does not exist -> 404 ({st})")
RV["backend"] = 100
_real_kube = kube.kube


def _stale(method, path, body=None, **kw):
    # Somebody changed the deployment between the read and the patch.
    if method == "PATCH":
        RV["backend"] = 999
    return _real_kube(method, path, body, **kw)


kube.kube = _stale
st, _, b = call("POST", "/kube/rollback-to-revision", {**RB, "revision": 3})
kube.kube = _real_kube
RV["backend"] = 100
ok(st == 409, f"a deployment changed under the rollback -> 409, not an overwrite ({st})")
untouched("rollback given a confirm", lambda: ok(
    call("POST", "/kube/rollback-to-revision", {**RB, "revision": 4, "confirm": "backend"})[0] == 400,
    "a click-level rollback takes no confirm field -> 400"))

print()
print("── pause / resume ───────────────────────────────────────────────")
SEEN.clear()
st, _, b = call("POST", "/kube/pause", {"namespace": "thales-dev", "deployment": "backend"})
ok(st == 200 and js(b).get("from") is False and js(b).get("to") is True, f"pause false -> true ({st} {js(b)})")
ok([x[3] for x in SEEN if x[0] == "PATCH"] == ["application/merge-patch+json"]
   and [x[2] for x in SEEN if x[0] == "PATCH"] == [{"spec": {"paused": True}}], "a merge patch of spec.paused only")
st, _, b = call("POST", "/kube/resume", {"namespace": "thales-dev", "deployment": "backend"})
ok(st == 200 and js(b).get("from") is True and js(b).get("to") is False, f"resume true -> false ({st})")
untouched("pause in kube-system", lambda: ok(
    call("POST", "/kube/pause", {"namespace": "kube-system", "deployment": "coredns"})[0] == 403, "pause in kube-system -> 403"))

print()
print("── set-image ────────────────────────────────────────────────────")
SEEN.clear()
SI = {"namespace": "thales-dev", "deployment": "backend", "container": "backend"}
st, _, b = call("POST", "/kube/set-image", {**SI, "image": "thales/backend:0.1.7"})
d = js(b)
ok(st == 200 and d.get("from") == "thales/backend:0.1.7" and d.get("to") == "thales/backend:0.1.7",
   f"set-image to the same image ({st} {d})")
p = [x for x in SEEN if x[0] == "PATCH"]
ok(len(p) == 1 and p[0][3] == "application/strategic-merge-patch+json"
   and p[0][2] == {"spec": {"template": {"spec": {"containers": [{"name": "backend", "image": "thales/backend:0.1.7"}]}}}},
   "one strategic merge naming exactly one container")
st, _, b = call("POST", "/kube/set-image", {**SI, "image": "localhost:5000/thales/backend:0.1.8"})
ok(st == 200 and IMAGES["backend"]["backend"] == "localhost:5000/thales/backend:0.1.8", "the local registry spelling")
IMAGES["backend"]["backend"] = "thales/backend:0.1.7"
SEEN.clear()
st, _, b = call("POST", "/kube/set-image", {**SI, "container": "sidecar", "image": "thales/backend:0.1.7"})
ok(st == 404 and not any(x[0] == "PATCH" for x in SEEN), f"a container not in the template -> 404, nothing patched ({st})")
for img, want in (("docker.io/library/busybox:1.36", 403), ("busybox:1.36", 403), ("thales/backend", 400),
                  ("thales/../x:1", 400)):
    st, _, b = untouched(f"set-image {img}", lambda: call("POST", "/kube/set-image", {**SI, "image": img}))
    ok(st == want, f"set-image {img} -> {st} (want {want})")

print()
print("── pods and delete-pod ──────────────────────────────────────────")
st, _, b = call("GET", f"/kube/pods?{NS}")
pods = {x["name"]: x for x in js(b).get("pods", [])}
ok(st == 200 and pods.get("frontend-6d9-new", {}).get("owner") == {"kind": "Deployment", "name": "frontend"},
   f"a ReplicaSet's pod is owned by the Deployment ({pods.get('frontend-6d9-new', {}).get('owner')})")
ok(pods.get("migrate-abc-x1", {}).get("owner") == {"kind": "Job", "name": "thales-migrate-abc"}
   and pods["migrate-abc-x1"]["status"] == "Completed", "a Job's pod, Completed")
ok(pods.get("crashy", {}).get("status") == "CrashLoopBackOff" and pods["crashy"]["restarts"] == 7,
   "a crash-looping pod shows its reason and restarts")
ok([n for n, x in sorted(pods.items()) if x["deletable"]] == ["crashy", "frontend-6d9-new", "migrate-abc-x1"],
   f"deletable is offered for Deployment and Job pods only: {[n for n, x in sorted(pods.items()) if x['deletable']]}")
st, _, b = call("GET", f"/kube/pods?{NS}&deployment=frontend")
ok(st == 200 and [x["name"] for x in js(b).get("pods", [])] == ["frontend-6d9-old", "frontend-6d9-new"]
   or [x["name"] for x in js(b).get("pods", [])] == ["frontend-6d9-new", "frontend-6d9-old"],
   f"pods of a deployment use its selector ({[x['name'] for x in js(b).get('pods', [])]})")
SEEN.clear()
DELETED.clear()
st, _, b = call("POST", "/kube/delete-pod", {"namespace": "thales-dev", "pod": "frontend-6d9-new"})
ok(st == 200 and js(b).get("owner") == {"kind": "Deployment", "name": "frontend"}, f"delete a deployment's pod ({st} {js(b)})")
ok(len(DELETED) == 1 and DELETED[0][1].get("preconditions") == {"uid": "uid-frontend-6d9-new"},
   "with the pod's uid as a precondition")
ok(any("/replicasets/frontend-6d9" in x[1] for x in SEEN) and any("/deployments/frontend" in x[1] for x in SEEN),
   "the chain pod -> ReplicaSet -> Deployment was walked on the apiserver")
DELETED.clear()
st, _, b = call("POST", "/kube/delete-pod", {"namespace": "thales-dev", "pod": "migrate-abc-x1"})
ok(st == 200 and js(b).get("owner", {}).get("kind") == "Job" and len(DELETED) == 1, f"delete a job's pod ({st})")
for name in ("bare-pod", "db-0", "orphaned-rs-pod", "lying-pod"):
    DELETED.clear()
    st, _, b = call("POST", "/kube/delete-pod", {"namespace": "thales-dev", "pod": name})
    ok(st == 403 and not DELETED, f"delete-pod {name} -> {st}, nothing deleted")
st, _, _ = call("POST", "/kube/delete-pod", {"namespace": "thales-dev", "pod": "nope"})
ok(st == 404, f"delete-pod of a pod that does not exist -> 404 ({st})")
untouched("delete-pod in kube-system", lambda: ok(
    call("POST", "/kube/delete-pod", {"namespace": "kube-system", "pod": "coredns-1"})[0] == 403, "delete-pod kube-system -> 403"))

print()
print("── logs: previous and container ─────────────────────────────────")
SEEN.clear()
st, _, b = call("GET", f"/kube/logs?{NS}&deployment=frontend&container=sidecar&pod=frontend-6d9-new&tail=2")
ok(st == 200 and js(b).get("container") == "sidecar" and js(b).get("previous") is False, f"a named container ({st})")
st, _, b = call("GET", f"/kube/logs?{NS}&deployment=frontend&previous=true&tail=2")
ok(st == 404 and "no previous instance" in js(b).get("error", ""), f"previous of a pod that never restarted -> 404 ({st})")
ok(any("previous=true" in x[1] for x in SEEN), "previous=true reaches the log endpoint")
untouched("previous + follow", lambda: ok(
    call("GET", f"/kube/logs?{NS}&deployment=frontend&previous=true&follow=true")[0] == 400, "previous with follow -> 400"))

print()
print("── jobs ─────────────────────────────────────────────────────────")
st, _, b = call("GET", f"/kube/jobs?{NS}")
jobs = {x["name"]: x for x in js(b).get("jobs", [])}
ok(st == 200 and jobs.get("thales-migrate-abc", {}).get("status") == "Complete"
   and jobs["thales-migrate-abc"]["template"] == "migrate" and jobs.get("seed-failed", {}).get("status") == "Failed",
   f"jobs with status and template ({st})")
ok([x["name"] for x in js(b).get("jobs", [])][:2] == ["thales-migrate-abc", "seed-failed"], "newest first")
st, _, b = call("GET", f"/kube/job-logs?{NS}&job=thales-migrate-abc&tail=3")
d = js(b)
ok(st == 200 and d.get("pod") == "migrate-abc-x1" and d.get("pods") == ["migrate-abc-x1"]
   and d.get("lines") == [f"migrate-abc-x1 line {i}" for i in range(3)],
   f"job logs from the job's own pod, never an impostor with its label ({d.get('pods')})")
st, _, _ = call("GET", f"/kube/job-logs?{NS}&job=empty-job")
ok(st == 404, f"a job with no pods -> 404 ({st})")
st, _, _ = call("GET", f"/kube/job-logs?{NS}&job=thales-migrate-abc&container=other")
ok(st == 404, f"job logs, a container not in the pod -> 404 ({st})")
DELETED.clear()
st, _, b = call("POST", "/kube/delete-job", {"namespace": "thales-dev", "job": "thales-migrate-abc",
                                             "confirm": "thales-migrate-abc"})
ok(st == 200 and len(DELETED) == 1 and DELETED[0][1].get("propagationPolicy") == "Background"
   and DELETED[0][1].get("preconditions") == {"uid": "uid-job-migrate"},
   f"delete-job: Background, uid precondition ({st})")
st, _, _ = call("POST", "/kube/delete-job", {"namespace": "thales-dev", "job": "nope", "confirm": "nope"})
ok(st == 404, f"delete a job that does not exist -> 404 ({st})")

print()
print("── run-template ─────────────────────────────────────────────────")
CREATED.clear()
IMAGES["backend"]["backend"] = "thales/backend:0.1.7"
st, _, b = call("POST", "/kube/run-template", {"namespace": "thales-dev", "template": "migrate", "confirm": "migrate"})
d = js(b)
ok(st == 200 and d.get("job") == "thales-migrate-q7x2k" and d.get("image") == "thales/backend:0.1.7",
   f"a Job created from the migrate template ({st} {d})")
body = CREATED[0] if CREATED else {}
with open(os.path.join(kube.TEMPLATE_DIR, "thales-dev", "migrate.yaml"), encoding="utf-8") as fh:
    filedoc = json.loads("".join(ln for ln in fh if not ln.lstrip().startswith("#")))
ok(body.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [{}])[0].get("command")
   == filedoc["spec"]["template"]["spec"]["containers"][0]["command"],
   "the command is the file's")
ok(body.get("metadata", {}).get("labels", {}).get("bothy.dev/template") == "migrate"
   and body["metadata"].get("namespace") == "thales-dev" and "name" not in body["metadata"],
   "labelled, namespaced, and named only by generateName")
ok(body.get("spec", {}).get("template", {}).get("spec", {}).get("automountServiceAccountToken") is False,
   "no service-account token in the Job's pod")
IMAGES["backend"]["backend"] = "docker.io/library/node:22"
CREATED.clear()
st, _, b = call("POST", "/kube/run-template", {"namespace": "thales-dev", "template": "seed-reference",
                                               "confirm": "seed-reference"})
ok(st == 403 and not CREATED, f"a backend running a non-allowlisted image -> 403, no Job ({st})")
IMAGES["backend"]["backend"] = "thales/backend:0.1.7"
for tpl, want in (("../migrate", 400), ("seed-scenario", 404), ("migrate.yaml", 400), ("..%2Fmigrate", 400)):
    st, _, _ = untouched(f"template {tpl}", lambda: call("POST", "/kube/run-template",
                                                         {"namespace": "thales-dev", "template": tpl, "confirm": tpl}))
    ok(st == want, f"run-template {tpl!r} -> {st} (want {want})")
st, _, _ = untouched("template with a body", lambda: call("POST", "/kube/run-template", {
    "namespace": "thales-dev", "template": "migrate", "confirm": "migrate",
    "spec": {"template": {"spec": {"containers": [{"name": "x", "image": "evil:1"}]}}}}))
ok(st == 400, f"run-template with a client-supplied body -> 400 ({st})")

print()
print("── configmap: view, patch-key, patch-key-and-restart ────────────")
st, _, b = call("GET", f"/kube/configmap?{NS}&configmap=thales")
rows = {r["key"]: r for r in js(b).get("data", [])}
ok(st == 200 and rows.get("LOG_LEVEL", {}).get("editable") is True and rows["LOG_LEVEL"].get("pattern") == "debug|info|warn|error"
   and rows.get("DEMO_LOGINS", {}).get("editable") is False, f"keys and values, editable marked ({st})")
untouched("configmap kube-root-ca", lambda: ok(
    call("GET", f"/kube/configmap?{NS}&configmap=kube-root-ca.crt")[0] == 400, "view kube-root-ca.crt -> 400"))
untouched("configmap other", lambda: ok(
    call("GET", f"/kube/configmap?{NS}&configmap=other")[0] == 403, "view another configmap -> 403"))
SEEN.clear()
PK = {"namespace": "thales-dev", "configmap": "thales", "key": "LOG_LEVEL", "confirm": "LOG_LEVEL"}
st, _, b = call("POST", "/kube/patch-key", {**PK, "value": "info"})
p = [x for x in SEEN if x[0] == "PATCH"]
ok(st == 200 and js(b) == {**js(b), "key": "LOG_LEVEL", "from": "info", "to": "info"}, f"patch-key to its current value ({st})")
ok(len(p) == 1 and p[0][3] == "application/merge-patch+json" and p[0][2]["data"] == {"LOG_LEVEL": "info"}
   and p[0][2]["metadata"]["resourceVersion"] == "700", "a merge patch of one key, with the resourceVersion read")
ok(not any("/deployments/" in x[1] and x[0] == "PATCH" for x in SEEN), "patch-key restarts nothing")
st, _, b = call("POST", "/kube/patch-key", {**PK, "value": "debug"})
ok(st == 200 and CM["data"]["LOG_LEVEL"] == "debug", "LOG_LEVEL info -> debug")
SEEN.clear()
ANNOT.clear()
st, _, b = call("POST", "/kube/patch-key-and-restart", {**PK, "value": "info"})
d = js(b)
ok(st == 200 and d.get("from") == "debug" and d.get("to") == "info" and sorted(d.get("restarted", [])) == ["algorithm", "backend", "frontend"],
   f"and-restart restarts exactly the deployments that read thales: {d.get('restarted')}")
ok(set(ANNOT) == {"algorithm", "backend", "frontend"} and all(v == d.get("restartedAt") for v in ANNOT.values()),
   "one restartedAt stamp, postgres untouched")
for body, want, label in (
    ({**PK, "value": "trace"}, 400, "a value outside the key's pattern"),
    ({**PK, "value": "info\ninjected: 1"}, 400, "a multi-line value"),
    ({**PK, "key": "DEMO_LOGINS", "confirm": "DEMO_LOGINS", "value": "false"}, 403, "a key not on the allowlist"),
    ({**PK, "key": "DATABASE_HOST", "confirm": "DATABASE_HOST", "value": "evil"}, 403, "an address key"),
    ({**PK, "confirm": "thales", "value": "info"}, 400, "confirmed with the configmap, not the key"),
    ({**PK, "configmap": "other", "value": "info"}, 403, "another configmap"),
    ({**PK, "namespace": "kube-system", "value": "info"}, 403, "kube-system"),
):
    st, _, b = untouched(f"patch-key {label}", lambda: call("POST", "/kube/patch-key", body))
    ok(st == want, f"patch-key {label} -> {st} (want {want})")
del CM["data"]["JOB_MAX_WORKERS"]
SEEN.clear()
st, _, b = call("POST", "/kube/patch-key", {**PK, "key": "JOB_MAX_WORKERS", "confirm": "JOB_MAX_WORKERS", "value": "2"})
ok(st == 404 and not any(x[0] == "PATCH" for x in SEEN), f"an allowlisted key the ConfigMap lacks is not added ({st})")
CM["data"]["JOB_MAX_WORKERS"] = "2"
CM["rv"] = 5000
_real_kube2 = kube.kube


def _race(method, path, body=None, **kw):
    if method == "PATCH" and "/configmaps/" in path:
        CM["rv"] += 1
    return _real_kube2(method, path, body, **kw)


kube.kube = _race
st, _, _ = call("POST", "/kube/patch-key", {**PK, "value": "warn"})
kube.kube = _real_kube2
ok(st == 409 and CM["data"]["LOG_LEVEL"] == "info", f"a ConfigMap changed under the patch -> 409, value kept ({st})")

print()
print("── read-only views ──────────────────────────────────────────────")
st, _, b = call("GET", f"/kube/services?{NS}")
ok(st == 200 and js(b).get("services", [{}])[0].get("ports", [{}])[0].get("port") == 8080, f"services ({st})")
st, _, b = call("GET", f"/kube/routes?{NS}")
ok(st == 200 and js(b).get("routes", [{}])[0] == {**js(b)["routes"][0], "host": "thales.example", "service": "frontend",
                                                     "tls": "edge"}, f"routes ({st})")
st, _, b = call("GET", f"/kube/ingresses?{NS}")
ok(st == 200 and js(b).get("ingresses", [{}])[0].get("rules") == [{"host": "a.example", "path": "/", "service": "frontend",
                                                                   "port": 8080}], f"ingresses ({st})")
st, _, b = call("GET", f"/kube/persistentvolumeclaims?{NS}")
ok(st == 200 and js(b).get("claims", [{}])[0].get("capacity") == "10Gi" and js(b)["claims"][0]["phase"] == "Bound",
   f"persistentvolumeclaims ({st})")
st, _, b = call("GET", f"/kube/networkpolicies?{NS}")
ok(st == 200 and js(b).get("policies", [{}])[0].get("ingress") == ["pods app=backend on 5432/TCP"],
   f"networkpolicies, summarised ({st} {js(b).get('policies', [{}])[0].get('ingress')})")
st, _, b = call("GET", f"/kube/resourcequotas?{NS}")
ok(st == 200 and js(b).get("quotas", [{}])[0].get("used") == {"pods": "6"}, f"resourcequotas ({st})")
st, _, b = call("GET", f"/kube/limitranges?{NS}")
ok(st == 200 and js(b).get("limitRanges", [{}])[0].get("limits", [{}])[0].get("default") == {"cpu": "500m"},
   f"limitranges ({st})")
st, _, b = call("GET", f"/kube/namespace-events?{NS}&limit=3")
evs = js(b).get("events", [])
ok(st == 200 and len(evs) == 3 and evs[0]["object"] == "Secret/frontend-tls", f"namespace events, newest first, limited ({st})")
ok(any("limit=500" in x[1] and "/events" in x[1] for x in SEEN) and not any("watch" in x[1] for x in SEEN),
   "events are listed, never watched")
for aid in ("services", "routes", "ingresses", "persistentvolumeclaims", "networkpolicies", "resourcequotas",
            "limitranges", "namespace-events", "deployments", "jobs", "pods"):
    st, _, _ = untouched(f"{aid} in kube-system", lambda: call("GET", f"/kube/{aid}?namespace=kube-system"))
    ok(st == 403, f"{aid} in kube-system -> {st}")
for aid in ("secrets", "secret-keys", "exec", "attach", "port-forward", "create-namespace"):
    st, _, _ = untouched(f"GET {aid}", lambda: call("GET", f"/kube/{aid}?{NS}"))
    ok(st == 404, f"no {aid} action -> {st}")

print()
print("── refusals that never reach the cluster ────────────────────────")
cases = [
    ("POST", "/kube/rollout-restart", {"namespace": "kube-system", "deployment": "coredns"}, None, 403, "kube-system"),
    ("GET", "/kube/logs?namespace=kube-system&deployment=coredns", None, None, 403, "logs in kube-system"),
    ("GET", "/kube/events?namespace=thales&deployment=frontend", None, None, 403, "the production-shaped namespace"),
    ("GET", "/kube/secrets?namespace=thales-dev&name=db", None, None, 404, "an action named secrets"),
    ("POST", "/kube/get-secret", {"namespace": "thales-dev", "deployment": "db"}, None, 404, "get-secret"),
    ("POST", "/kube/exec", {"namespace": "thales-dev", "deployment": "frontend"}, None, 404, "exec"),
    ("POST", "/kube/port-forward", {"namespace": "thales-dev", "deployment": "frontend"}, None, 404, "port-forward"),
    ("POST", "/kube/rollout-restart", {"namespace": "thales-dev", "deployment": "../../../api/v1/secrets"}, None, 400, "traversal in a name"),
    ("GET", "/kube/logs?namespace=thales-dev&deployment=frontend&pod=..%2F..%2Fsecrets", None, None, 400, "encoded traversal in pod"),
    ("GET", "/kube/logs?namespace=thales-dev&namespace=kube-system&deployment=x", None, None, 400, "repeated namespace"),
    ("GET", "/kube/scale?namespace=thales-dev&deployment=algorithm&replicas=0&confirm=algorithm", None, None, 405, "a change over GET"),
    ("POST", "/kube/rollout-restart", {"namespace": "thales-dev", "deployment": "frontend"},
     {"Sec-Fetch-Site": "cross-site"}, 403, "cross-site POST"),
    ("GET", "/kube/logs?namespace=thales-dev&deployment=frontend", None, {"Sec-Fetch-Site": "same-site"}, 403, "same-site GET"),
]
for method, path, body, hdrs, want, label in cases:
    st, _, b = untouched(label, lambda: call(method, path, body, hdrs))
    ok(st == want and "error" in js(b), f"{label} -> {st} (want {want})")

st, _, _ = untouched("text/plain POST", lambda: call(
    "POST", "/kube/rollout-restart", None, {"Content-Type": "text/plain"},
    raw=json.dumps({"namespace": "thales-dev", "deployment": "frontend"}).encode()))
ok(st == 415, f"text/plain POST -> 415 ({st})")
st, _, _ = untouched("oversized body", lambda: call(
    "POST", "/kube/rollout-restart", None, {"Content-Type": "application/json"}, raw=b"{" + b" " * 9000 + b"}"))
ok(st == 413, f"oversized body -> 413 ({st})")

print()
print("── failures are named, not guessed ──────────────────────────────")
MODE["forbid"] = True
st, _, b = call("POST", "/kube/rollout-restart", {"namespace": "thales-dev", "deployment": "frontend"})
ok(st == 502 and "Role" in js(b).get("error", ""), f"apiserver 403 -> 502 naming the Role ({st})")
MODE["forbid"] = False
os.rename(TOKEN, TOKEN + ".gone")
st, _, b = untouched("no token", lambda: call("GET", "/kube/events?namespace=thales-dev&deployment=frontend"))
ok(st == 503 and "kube-token" in js(b).get("error", ""), f"no token -> 503 pointing at just kube-token ({st})")
os.rename(TOKEN + ".gone", TOKEN)
st, _, b = call("GET", "/healthz")
ok(st == 200 and js(b).get("namespaces") == ["thales-dev", "thales-pre-prod"], "healthz lists the scope")

print()
print("── no cluster: the kube verbs say so, and nothing else breaks ───")
# bothy-ops joins minikube's network only through compose.cluster.yml, which
# `just up-apps` adds only when that network exists. So "the apiserver is not
# there" is an ordinary state for this process, and it must be a 503 per
# request - never a crash, never a 502 that reads like a bug, and never a reason
# the Control half stops answering.
_real_api = kube.KUBE_API
_dead = __import__("socket").socket()
_dead.bind(("127.0.0.1", 0))
kube.KUBE_API = f"https://127.0.0.1:{_dead.getsockname()[1]}"  # bound, never listening
_dead.close()
for method, path, body in (
        ("GET", "/kube/events?namespace=thales-dev&deployment=frontend", None),
        ("GET", "/kube/logs?namespace=thales-dev&deployment=frontend", None),
        ("POST", "/kube/rollout-restart", {"namespace": "thales-dev", "deployment": "frontend"})):
    st, _, b = call(method, path, body)
    ok(st == 503 and js(b).get("error", "").startswith("cluster unavailable"),
       f"{method} {path.split('?')[0]} with no apiserver -> 503 cluster unavailable ({st} {js(b)})")
st, _, b = call("GET", "/healthz")
ok(st == 200 and js(b).get("ok") is True, "healthz is still 200 with no apiserver (it never calls one)")
kube.KUBE_API = _real_api

print()
print("── the audit log ────────────────────────────────────────────────")
lines = open(AUDIT, encoding="utf-8").read().splitlines()
fields = [ln.split("\t") for ln in lines]
ok(all(len(f) == 7 for f in fields), f"every line has seven TSV fields ({len(lines)} lines)")
ok(all(f[1] == "op@example.test" for f in fields), "the actor comes from X-Auth-Request-Email")
outcomes = {f[2] for f in fields}
ok({"ACTED", "REFUSED", "FAILED"} <= outcomes, f"ACTED, REFUSED and FAILED all recorded: {sorted(outcomes)}")
ok(any(f[2] == "REFUSED" and f[3] == "rollout-restart" and f[4] == "kube-system/coredns"
       and "out of scope" in f[5] for f in fields),
   "the kube-system refusal is on record with what was asked and why")
ok(any(f[2] == "ACTED" and f[3] == "scale" and f[4] == "thales-dev/algorithm" and '"replicas":1' in f[5]
       for f in fields), "the scale is on record with namespace/target and params")
ok(any(f[2] == "ACTED" and f[3] == "logs" and '"follow":true' in f[5] for f in fields),
   "a finished follow is on record")
# Called directly: an HTTP client refuses to SEND a header with a newline in it,
# which says nothing about what a hostile hop might deliver.
kube.audit("a@b\n2026-01-01T00:00:00Z\tforged@x\tACTED", "ACTED", "scale", "thales-dev/x",
          {"replicas": "1\n2026-01-01T00:00:00Z\tforged"}, 1)
last = open(AUDIT, encoding="utf-8").read().splitlines()
ok(len(last) == len(lines) + 1, "a newline in the actor header cannot forge a second record")

print()
print("── startup refuses a catalog the handlers do not match ──────────")
bad = os.path.join(TMP, "bad.toml")
with open(os.path.join(SVC, "catalog.toml"), encoding="utf-8") as fh:
    src = fh.read()
with open(bad, "w", encoding="utf-8") as fh:
    fh.write(src + '\n[actions.exec]\ntitle = "x"\ntarget = "deployment"\nmethod = "POST"\n'
             'role = "operator"\nconfirm = "click"\nstream = false\n')
r = subprocess.run([sys.executable, os.path.join(SVC, "app.py")], env={**os.environ, "CATALOG": bad,
                   "PORT": "0"}, capture_output=True, text=True, timeout=10)
ok(r.returncode == 2 and "REFUSES TO START" in r.stderr and "exec" in r.stderr,
   f"an extra catalog id `exec` -> exit {r.returncode}")

empty = os.path.join(TMP, "no-templates")
os.makedirs(empty, exist_ok=True)
r = subprocess.run([sys.executable, os.path.join(SVC, "app.py")], env={**os.environ, "JOB_TEMPLATES": empty,
                   "PORT": "0"}, capture_output=True, text=True, timeout=10)
ok(r.returncode == 2 and "REFUSES TO START" in r.stderr and "migrate" in r.stderr,
   f"a catalog template missing from the image -> exit {r.returncode}")

print()
if fails:
    print(f"FAILED: {len(fails)}")
    for f in fails:
        print("   -", f)
    sys.exit(1)
print("api: all passed")
