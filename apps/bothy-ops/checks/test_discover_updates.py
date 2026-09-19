#!/usr/bin/env python3
"""discover_updates.py against a FAKE registry - no network, no docker.

Run: python3 checks/test_discover_updates.py

One http.server plays every upstream at once, and COUNTS what reaches it:

  /v2/...          a Docker Registry v2 that answers 401 + WWW-Authenticate until
                   it is shown the anonymous token from /token; paginates tags/list
                   with a Link header; answers HEAD manifests with a digest
  /hub/...         Docker Hub's tag API (docker.io digests come from here first)
  /gh/...          GitHub's releases API
  /charts/...      a helm repository index.yaml, with an ETag

and a throwaway repo holds the compose files, manifest, script and VERSION the
catalog points at. `docker inspect` is replaced by a table.

  TAGS     classification per level; pre-releases and other shapes ignored;
           pagination followed; the token dance done once per repository
  DRIFT    running != pinned, three ways: a different tag running, a digest pin
           running something else, and a tag re-published upstream
  FLOATS   a moved floating tag is an update, not drift; the running release is
           identified among the float's family
  LIMITS   a 429 fuses the host for the run, the other components still finish,
           and a cached answer is served stale rather than nothing
  CACHE    a second run inside the TTL makes no request at all
  OUTPUT   available.json mode 600 in a 700 dir, atomically; the textfile carries
           bothy_update_available{component,level} and no half-written file
"""
import json
import os
import stat
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)
os.environ.setdefault("ADMIN_AUDIT_LOG", os.devnull)

import discover_updates as du  # noqa: E402
import updates  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def D(ch: str) -> str:
    return "sha256:" + ch * 64


# repo -> {tag: digest}
REG = {
    "library/app": {"1.2.2": D("1"), "1.2.3": D("2"), "1.2.4": D("3"), "1.2.10": D("4"), "1.3.0": D("5"),
                    "1.3.0-rc1": D("6"), "2.0.0": D("7"), "latest": D("7"), "1.2.3-alpine": D("8")},
    "x/drifty": {"2.0.0": D("a"), "2.0.1": D("b")},
    "x/stale": {"0.9.0": D("c"), "1.0.0": D("d")},
    "x/pinned": {"v0.17.0": D("e"), "v0.18.0": D("f"), "v0.18.1": D("0")},
    "library/floaty": {"v3.7": D("9"), "v3.7.1": D("8"), "v3.7.2": D("9"), "v3.8": D("a"), "v3.8.0": D("a")},
    "x/limited": {"1.0.0": D("1")},
    # postgres' shape: a one-part float whose releases have TWO parts.
    "library/pg": {"17": D("b"), "17.5": D("a"), "17.6": D("b"), "18": D("c"), "18.0": D("c"), "17-alpine": D("d")},
}
SEEN: list[tuple[str, str]] = []
TOKENS_ISSUED: list[str] = []
LIMITED = {"x/limited"}


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, obj, headers=None):
        self._send(code, json.dumps(obj).encode(), {"Content-Type": "application/json", **(headers or {})})

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urlsplit(self.path)
        SEEN.append((self.command, u.path))
        q = parse_qs(u.query)
        base = f"http://127.0.0.1:{self.server.server_address[1]}"
        if u.path == "/token":
            scope = q.get("scope", [""])[0]
            TOKENS_ISSUED.append(scope)
            return self._json(200, {"token": f"tok:{scope}"})
        if u.path.startswith("/v2/"):
            rest = u.path[4:]
            repo, kind, ref = (rest.rsplit("/", 2) + ["", ""])[:3] if "/manifests/" in rest else \
                (rest[:-len("/tags/list")], "tags", "")
            if repo in LIMITED:
                return self._json(429, {"errors": [{"code": "TOOMANYREQUESTS"}]}, {"Retry-After": "3600"})
            if self.headers.get("Authorization") != f"Bearer tok:repository:{repo}:pull":
                return self._json(401, {}, {"WWW-Authenticate":
                                            f'Bearer realm="{base}/token",service="fake",scope="repository:{repo}:pull"'})
            tags = REG.get(repo)
            if tags is None:
                return self._json(404, {})
            if kind == "tags":
                names = sorted(tags)
                last = q.get("last", [""])[0]
                page = [t for t in names if t > last][:4]
                more = [t for t in names if t > (page[-1] if page else "")]
                hdr = {"Link": f'</v2/{repo}/tags/list?n=4&last={page[-1]}>; rel="next"'} if page and more else {}
                return self._json(200, {"name": repo, "tags": page}, hdr)
            if ref in tags:
                return self._send(200, b"{}", {"Docker-Content-Digest": tags[ref],
                                               "Content-Type": "application/vnd.oci.image.index.v1+json"})
            return self._json(404, {})
        if u.path.startswith("/hub/v2/namespaces/"):
            parts = u.path.split("/")  # /hub/v2/namespaces/<ns>/repositories/<name>/tags/<tag>
            repo, tag = f"{parts[4]}/{parts[6]}", parts[8]
            if tag in REG.get(repo, {}):
                return self._json(200, {"name": tag, "digest": REG[repo][tag], "tag_last_pushed": "2026-09-01T00:00:00Z"})
            return self._json(404, {})
        if u.path == "/gh/repos/o/bothy/releases":
            return self._json(200, [
                {"tag_name": "v2026.9.0", "draft": False, "prerelease": False, "published_at": "2026-09-18T00:00:00Z"},
                {"tag_name": "v2026.10.0", "draft": True, "prerelease": False},
                {"tag_name": "v2027.1.0-rc", "draft": False, "prerelease": True},
                {"tag_name": "v2026.8.1", "draft": False, "prerelease": False},
            ])
        if u.path == "/charts/index.yaml":
            if self.headers.get("If-None-Match") == '"idx-1"':
                return self._send(304, b"", {"ETag": '"idx-1"'})
            body = ("apiVersion: v1\nentries:\n  ksm:\n  - appVersion: 2.21.0\n    version: 8.6.0\n"
                    "  - version: 8.5.1\n  - version: 8.5.0\n  other:\n  - version: 99.0.0\n").encode()
            return self._send(200, body, {"ETag": '"idx-1"'})
        return self._json(404, {})


srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}"

# ── a throwaway repository ────────────────────────────────────────────────────
TMP = tempfile.mkdtemp(prefix="bothy-discover-")
REPO = os.path.join(TMP, "repo")
os.makedirs(os.path.join(REPO, "k8s"))


def w(rel: str, text: str) -> None:
    p = os.path.join(REPO, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as fh:
        fh.write(text)


w("compose.yml", f"""services:
  app:
    image: app:1.2.3     # docker.io, official
    container_name: app
  drifty:
    image: quay.io/x/drifty:2.0.0
    container_name: drifty
  stale:
    image: quay.io/x/stale:1.0.0
    container_name: stale
  pinned:
    image: quay.io/x/pinned@{D("f")}
    container_name: pinned
  floaty:
    image: floaty:v3.7
    container_name: floaty
  limited:
    image: ghcr.io/x/limited:1.0.0
    container_name: limited
  pg:
    image: pg:17
    container_name: pg
""")
w("k8s/ds.yaml", "spec:\n  template:\n    spec:\n      containers:\n        - name: side\n          image: busybox:1\n"
  "        - name: app\n          args: [run]\n          image: app:1.2.3\n")
w("install.sh", 'KSM="8.5.0"   # pinned\n')
w("VERSION", "2026.8.1\n")

RUNNING = {
    "app": {"name": "app", "image": "app:1.2.3", "digest": D("2"), "state": "running"},
    "drifty": {"name": "drifty", "image": "quay.io/x/drifty:2.0.0", "digest": D("5"), "state": "running"},
    "stale": {"name": "stale", "image": "quay.io/x/stale:0.9.0", "digest": D("c"), "state": "running"},
    "pinned": {"name": "pinned", "image": f"quay.io/x/pinned@{D('f')}", "digest": D("e"), "state": "running"},
    "floaty": {"name": "floaty", "image": "floaty:v3.7", "digest": D("8"), "state": "running"},
    "pg": {"name": "pg", "image": "pg:17", "digest": D("a"), "state": "running"},
}


def comp(cid, pins, **extra):
    c = {"title": cid, "class": "stateless", "source": "image", "pins": pins, "apply": "just up",
         "dependants": [], "changelog": "https://example.com/{version}", "channel": "auto", "one_way": False,
         "verify": ["answers"]}
    c.update(extra)
    return cid, c


CAT = updates.load_catalog({
    "policy": {"window_start": "03:30", "window_end": "05:00", "require_backup": "stacks-backup.service",
               "require_doctor": True, "max_auto_per_night": 1, "pause_on_failure": True, "discover_every_hours": 6},
    "components": dict([
        comp("app", ["compose.yml:app"]),
        comp("drifty", ["compose.yml:drifty"]),
        comp("stale", ["compose.yml:stale"]),
        comp("pinned", ["compose.yml:pinned"]),
        comp("floaty", ["compose.yml:floaty"]),
        comp("limited", ["compose.yml:limited"]),
        comp("pg", ["compose.yml:pg"], **{"class": "database"}, channel="manual"),
        comp("in-cluster", ["k8s/ds.yaml:app"], source="manifest", workload="monitoring/daemonset/app",
             **{"class": "cluster"}, channel="notify"),
        comp("ksm", ["install.sh:KSM"], source="helm", chart="ksm", chart_repo=f"{BASE}/charts".replace("http://", "https://"),
             release="monitoring/ksm", **{"class": "cluster"}, channel="notify"),
        comp("bothy", ["VERSION"], source="github", repo="o/bothy", **{"class": "own-code"}, channel="notify"),
    ]),
})
# chart_repo must be https in the catalog; the fake is plain http. Swap it back
# on the parsed object, which is what a test double is for.
object.__setattr__(CAT.components["ksm"], "chart_repo", f"{BASE}/charts")

# ghcr.io is the rate-limited one, and is served as `localhost` so that fusing it
# fuses a different host than everything else - as it would be in real life.
LOCAL = f"http://localhost:{srv.server_address[1]}"
REGS = {"docker.io": BASE, "quay.io": BASE, "gcr.io": BASE, "ghcr.io": LOCAL}


def run(cache=None, **kw):
    net = du.Net(cache if cache is not None else {}, registries=REGS, hub=f"{BASE}/hub", github=f"{BASE}/gh", **kw)
    d = du.Discoverer(CAT, net, repo=REPO, running=lambda n: RUNNING.get(n),
                      kube=lambda wl: ["app:1.2.2"], helm=lambda rel, chart: "8.5.0")
    return d.run(), net


doc, net = run(cache := {})
C = doc["components"]

print("── TAGS: levels, shapes, pagination, tokens ─────────────────────")
a = C["app"]
ok(a["error"] is None, f"app checked without error ({a['error']})")
ok({k: v["tag"] for k, v in a["candidates"].items()} == {"patch": "1.2.10", "minor": "1.3.0", "major": "2.0.0"},
   f"newest per level; 1.3.0-rc1, 1.2.3-alpine and latest ignored: {a['candidates']}")
ok(a["latest"]["tag"] == "2.0.0" and a["latest"]["level"] == "major", "latest is the major")
ok(a["candidates"]["minor"]["digest"] == D("5"), "the target digest is resolved")
ok(a["drift"] is None, "running == pinned: no drift")
ok(any(p.startswith("/hub/v2/namespaces/library/repositories/app/tags/") for _, p in SEEN)
   and not any(m == "HEAD" and "/v2/library/app/manifests/" in p for m, p in SEEN),
   "docker.io digests come from Hub's tag API, not a quota-counted HEAD")
tag_pages = [p for m, p in SEEN if p == "/v2/library/app/tags/list"]
ok(len(tag_pages) >= 3, f"tags/list pagination followed ({len(tag_pages)} requests, 4 tags a page)")
ok(TOKENS_ISSUED.count("repository:library/app:pull") == 1, "one anonymous token per repository per run")

print()
print("── DRIFT: running != pinned ─────────────────────────────────────")
ok(C["stale"]["drift"] and "stale runs quay.io/x/stale:0.9.0" in C["stale"]["drift"],
   f"a different tag running is drift: {C['stale']['drift']}")
ok(C["drifty"]["drift"] and "different image" in C["drifty"]["drift"],
   f"same tag, different digest (re-published) is drift: {C['drifty']['drift']}")
ok(C["drifty"]["latest"]["tag"] == "2.0.1" and C["drifty"]["latest"]["level"] == "patch", "…and still has its patch")
p = C["pinned"]
ok(p["drift"] and "the pin is" in p["drift"], f"a digest pin running another digest is drift: {p['drift']}")
ok(p["current"].get("identifiedAs") == "v0.18.0" and p["current"]["version"] == "0.18.0",
   f"a digest-only pin is identified among the newest releases: {p['current']}")
ok(p["latest"] and p["latest"]["tag"] == "v0.18.1", "…and offered the patch above it")
ok(C["in-cluster"]["drift"] and "the cluster runs app:1.2.2" in C["in-cluster"]["drift"],
   f"a manifest the cluster does not run is drift: {C['in-cluster']['drift']}")
ok(C["app"]["running"][0]["digest"] == D("2"), "the running digest is recorded")

print()
print("── FLOATS: a moved float is an update, not drift ────────────────")
f = C["floaty"]
ok(f["current"]["float"] is True and f["floatMoved"] is True, "v3.7 now names a newer image than the one running")
ok(f["drift"] is None, "…which is not drift")
ok(f.get("runningVersion") == "3.7.1" and f["current"].get("floatTarget") == "v3.7.2",
   f"running v3.7.1, the float now v3.7.2: {f.get('runningVersion')} / {f['current'].get('floatTarget')}")
ok(f["candidates"]["minor"]["tag"] == "v3.8" and f["candidates"]["patch"]["tag"] == "v3.7",
   f"v3.8 is the minor; the moved float is the patch: {f['candidates']}")

pg = C["pg"]
ok(pg["floatMoved"] is True and pg.get("runningVersion") == "17.5" and pg["current"].get("floatTarget") == "17.6",
   f"a one-part float's family has two parts (postgres): running 17.5, the float now 17.6: {pg['current']}")
ok(pg["candidates"]["major"]["tag"] == "18" and pg["candidates"]["minor"]["version"] == "17.6",
   f"18 is the major; the moved float is a minor step to 17.6: {pg['candidates']}")

print()
print("── LIMITS: a 429 fuses the host and nothing else ────────────────")
ok(C["limited"]["error"] and "rate limit" in C["limited"]["error"], f"the 429 is said: {C['limited']['error']}")
ok(net.blocked == {f"localhost:{srv.server_address[1]}"}, f"that host, and only it, is fused for the run: {net.blocked}")
ok(all(C[k]["error"] is None for k in ("app", "drifty", "stale", "pinned", "floaty", "pg", "in-cluster", "ksm", "bothy")),
   "every other component finished")
LIMITED.clear()
stale_cache = {"tags": {"ghcr.io/x/limited": {"at": 0, "v": ["1.0.0", "1.1.0"]}},
               "digests": {"ghcr.io/x/limited:1.1.0": {"at": 0, "v": [D("3"), None]},
                           "ghcr.io/x/limited:1.0.0": {"at": 0, "v": [D("1"), None]}}}
LIMITED.add("x/limited")
net2 = du.Net(stale_cache, registries=REGS, hub=None, github=f"{BASE}/gh")
e = {"current": {}, "running": [], "candidates": {}, "latest": None, "drift": None, "error": None}
du.Discoverer(CAT, net2, repo=REPO, running=lambda n: None).image(CAT.components["limited"], e)
ok(e["latest"] and e["latest"]["tag"] == "1.1.0", "after a 429, an expired cached answer is served rather than none")

print()
print("── helm and our own code ────────────────────────────────────────")
k = C["ksm"]
ok(k["current"]["tag"] == "8.5.0" and k["latest"]["tag"] == "8.6.0" and k["latest"]["level"] == "minor"
   and k["latest"].get("appVersion") == "2.21.0", f"the chart: 8.5.0 -> 8.6.0 (app 2.21.0): {k['latest']}")
ok(k["candidates"]["patch"]["tag"] == "8.5.1" and k["drift"] is None, "…with its patch, installed as pinned")
b = C["bothy"]
ok(b["current"]["version"] == "2026.8.1" and b["latest"]["tag"] == "v2026.9.0" and b["latest"]["level"] == "minor",
   f"our release tags against VERSION; drafts and pre-releases skipped: {b['latest']}")

print()
print("── CACHE: a rerun inside the TTL asks nobody ────────────────────")
LIMITED.clear()
n0 = len(SEEN)
doc2, net3 = run(cache)
ok(SEEN[n0:] and all(p.startswith("/v2/x/limited") or p == "/token" for _, p in SEEN[n0:]),
   f"only the repository that failed last time is asked again ({len(SEEN) - n0} requests)")
n1 = len(SEEN)
_, net4 = run(cache)
ok(len(SEEN) == n1 and net4.calls == 0, f"a third run, nothing having failed, asks nobody ({net4.calls} calls)")
ok(doc2["components"]["app"]["latest"] == doc["components"]["app"]["latest"], "the cached answer is the same answer")

print()
print("── OUTPUT: modes, atomicity, the textfile ───────────────────────")
state = os.path.join(TMP, "state", "bothy", "updates")
tf = os.path.join(TMP, "state", "bothy", "textfile")
out, prom = du.write(doc, state, tf)
ok(stat.S_IMODE(os.stat(out).st_mode) == 0o600 and stat.S_IMODE(os.stat(state).st_mode) == 0o700,
   "available.json is 600 in a 700 directory")
ok(stat.S_IMODE(os.stat(prom).st_mode) == 0o644 and stat.S_IMODE(os.stat(tf).st_mode) == 0o755,
   "the textfile is 644 in a 755 directory (node-exporter runs as nobody)")
ok(sorted(os.listdir(state)) == ["available.json"] and sorted(os.listdir(tf)) == ["bothy_updates.prom"],
   "no temp file left behind")
text = open(prom).read()
ok('bothy_update_available{component="app",level="major"} 1' in text
   and 'bothy_update_available{component="app",level="patch"} 1' in text, "per-level availability series")
ok('bothy_update_drift{component="stale"} 1' in text and 'bothy_update_drift{component="app"} 0' in text,
   "drift series, 0 and 1")
ok('bothy_update_check_error{component="limited"} 1' in text, "a component that could not be checked says so")
ok(all(ln.startswith("#") or ln.startswith("bothy_update_") for ln in text.strip().splitlines()),
   "every line is a comment or a bothy_update_* sample")
back = json.load(open(out))
ok(back["version"] == 1 and set(back["components"]) == set(CAT.components), "the document round-trips")

print()
print("── what bothy-ops serves from it ────────────────────────────────")
updates.AVAILABLE_FILE = out
updates.CATALOG = CAT
st = updates.status(CAT)
rows = {r["id"]: r for r in st["components"]}
ok(rows["app"]["level"] == "major" and rows["app"]["effectiveChannel"] == "manual" and rows["app"]["behind"],
   "an auto component's major is served as manual")
ok(rows["drifty"]["effectiveChannel"] == "auto", "an auto component's patch stays auto")
ok(st["summary"]["drift"] == 4 and st["summary"]["errors"] >= 1, f"the summary counts drift and errors: {st['summary']}")

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("discover: all passed")
