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

TMP = tempfile.mkdtemp(prefix="bothy-kube-api-")
AUDIT = os.path.join(TMP, "actions.log")
TOKEN = os.path.join(TMP, "token")
CERT = os.path.join(TMP, "tls.crt")
KEY = os.path.join(TMP, "tls.key")
os.environ["AUDIT_LOG"] = AUDIT
os.environ["KUBE_TOKEN_FILE"] = TOKEN
os.environ["KUBE_CA_FILE"] = CERT

import app  # noqa: E402

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
    return {"metadata": {"name": name, "generation": GEN.get(name, 1)},
            "spec": {"replicas": REPLICAS.get(name, 1),
                     "selector": {"matchLabels": {"app.kubernetes.io/name": name}}}}


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
        if parts[:3] == ["apis", "apps", "v1"] and len(parts) >= 6 and parts[5] == "deployments":
            name = parts[6]
            if name not in REPLICAS:
                return self._json(404, {"message": f'deployments.apps "{name}" not found'})
            if len(parts) == 8 and parts[7] == "scale":
                if method == "PATCH":
                    REPLICAS[name] = body["spec"]["replicas"]
                return self._json(200, {"spec": {"replicas": REPLICAS[name]}})
            if method == "PATCH":
                ANNOT[name] = body["spec"]["template"]["metadata"]["annotations"][
                    "kubectl.kubernetes.io/restartedAt"]
                GEN[name] = GEN.get(name, 1) + 1
            return self._json(200, deployment(name))
        if parts[:2] == ["api", "v1"] and len(parts) >= 5:
            kind = parts[4]
            if kind == "events":
                return self._json(200, {"items": EVENTS})
            if kind == "pods" and len(parts) == 5:
                if "labelSelector" in q:
                    app_name = q["labelSelector"][0].split("=", 1)[1]
                    return self._json(200, {"items": PODS.get(app_name, [])})
                return self._json(200, {"items": COMPLETED})
            if kind == "pods" and len(parts) == 6 and method == "DELETE":
                return self._json(200, {"status": "Success"})
            if kind == "pods" and len(parts) == 7 and parts[6] == "log":
                if self.headers.get("Accept") == "text/plain":
                    # What the real apiserver does - see app.LOG_ACCEPT.
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


fake = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
fake.daemon_threads = True
sctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
sctx.load_cert_chain(CERT, KEY)
fake.socket = sctx.wrap_socket(fake.socket, server_side=True)
threading.Thread(target=fake.serve_forever, daemon=True).start()

app.KUBE_API = f"https://127.0.0.1:{fake.server_address[1]}"
app.CATALOG = app.load()
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
                                         "replicas": 1, "confirm": "algorithm"})
d = js(b)
ok(st == 200 and d.get("from") == 1 and d.get("to") == 1, f"no-op scale reports 1 -> 1 ({st} {d})")
ok(any(s[0] == "PATCH" and s[1].endswith("/deployments/algorithm/scale")
       and s[3] == "application/merge-patch+json" for s in SEEN), "merge PATCH on /scale")
ok(not any(s[0] == "PATCH" and s[1].endswith("/deployments/algorithm") for s in SEEN),
   "the deployment spec itself is never patched")
st, _, b = call("POST", "/kube/scale", {"namespace": "thales-dev", "deployment": "algorithm",
                                         "replicas": 2, "confirm": "algorithm"})
ok(st == 200 and js(b).get("from") == 1 and js(b).get("to") == 2, "scale 1 -> 2")
REPLICAS["algorithm"] = 1
untouched("scale without confirm", lambda: ok(
    call("POST", "/kube/scale", {"namespace": "thales-dev", "deployment": "algorithm", "replicas": 1})[0] == 400,
    "scale without type-name confirm -> 400"))
untouched("scale to 4", lambda: ok(
    call("POST", "/kube/scale", {"namespace": "thales-dev", "deployment": "algorithm", "replicas": 4,
                                 "confirm": "algorithm"})[0] == 400, "scale to 4 -> 400"))

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

app._STREAMS = __import__("threading").BoundedSemaphore(1)
app._STREAMS.acquire()
st, _, _ = call("GET", "/kube/logs?namespace=thales-dev&deployment=frontend&follow=true&seconds=5")
ok(st == 429, f"the concurrent-follow cap answers 429 ({st})")
app._STREAMS.release()

print()
print("── delete-completed-pods ────────────────────────────────────────")
SEEN.clear()
st, _, b = call("POST", "/kube/delete-completed-pods", {"namespace": "thales-dev"})
d = js(b)
dels = [s for s in SEEN if s[0] == "DELETE"]
ok(st == 200 and d.get("deleted") == ["migrate-1", "migrate-2"], f"only Succeeded pods deleted: {d.get('deleted')}")
ok(d.get("skipped") == ["postgres-0"], "a Running pod in the list is skipped, not deleted")
ok(all(s[2] and s[2].get("preconditions", {}).get("uid") for s in dels) and len(dels) == 2,
   "every delete carries a UID precondition")
ok(any("fieldSelector=status.phase%3DSucceeded" in s[1] for s in SEEN), "listed with the phase field selector")

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
app.audit("a@b\n2026-01-01T00:00:00Z\tforged@x\tACTED", "ACTED", "scale", "thales-dev/x",
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

print()
if fails:
    print(f"FAILED: {len(fails)}")
    for f in fails:
        print("   -", f)
    sys.exit(1)
print("api: all passed")
