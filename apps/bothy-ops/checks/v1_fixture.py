#!/usr/bin/env python3
"""The fixed fixture behind the v1 goldens - and the goldens' generator.

    python3 checks/v1_fixture.py --write    regenerate checks/golden/v1/*.json
    (imported by api_v1_contract.py, which regenerates in memory and DIFFS)

THE POINT (doc 6.5, "biggest risk: contract drift between the Python that writes JSON and the Go
that reads it"): the Go client and MCP server are tested against THESE files, so they must be what
the Python really says for one fixed world, byte for byte, with nothing in them that changes
between runs. That is why the world is built from REAL code, not typed by hand:

  * the planner is the real one. updater.plans.write_all() and updater.groups.write_all() run in a
    throwaway git repository (a bare origin and a clone, fixed commit dates) with `docker inspect`
    and `docker compose config --hash` replaced by tables - the same seam test_groups.py uses - and
    write plans/*.json and groups/*.json. bothy-ops then serves THEM. update.plan's golden is
    therefore the planner's own output through the allow-list, not a copy of what we think it says.
  * the own-code `unreleased` fact is the real owncode.write_unreleased() on a fixture repository
    that is 5 commits past a tag.
  * the HTTP is real: app.Handler on a loopback port, requests by urllib.

THE WORLD (a stateless, a database and a grouped component, as T7 asks):
  solo      stateless, its own recipe                     -> an ordinary click-confirm plan
  grafana   class app-db, one-way, its own recipe         -> the "database" case: type-the-name
  web, loki two components of ONE recipe `just up-mon`    -> `web` has scope.group-available
  bothy     own-code                                      -> a refusal plan, and `unreleased`

DEVIATION, stated: there is no `postgres` (class database) in the world. Its plan kind is the
guided Postgres major (updater/pgmajor.py), whose planner needs docker volumes and a dump reader
the seam above does not fake; `grafana` (app-db, one-way, type-name) is the data-bearing case the
planner can run honestly. Settings values are fixed by a fake reader with the library's Meta shape.
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
GOLDEN = os.path.join(HERE, "golden", "v1")
sys.path.insert(0, SVC)
sys.path.insert(0, os.path.join(os.path.dirname(SVC), "bothy-common"))

NOW = 1795000000                 # 2026-11-18T11:06:40Z - every file and every clock in the fixture
GEN = "2026-11-18T09:00:00Z"     # discovery's `generatedAt`; jobs ended before it, so no plan is "outgrown"
VERSION = "2026.11.0"
RID = "r_0000000000000000"
REQUEST_IDS = iter(())           # unused; the id is pinned to RID below

J_RUN = "a" * 32
J_OK = "b" * 32
J_RB = "c" * 32
J_FAIL = "d" * 32


def D(c: str) -> str:
    return "sha256:" + c * 64


CATALOG = """
[policy]
window_start = "03:30"
window_end = "05:00"
require_backup = "stacks-backup.service"
require_doctor = true
max_auto_per_night = 1
pause_on_failure = true
discover_every_hours = 6

[components.solo]
title = "Solo"
class = "stateless"
source = "image"
pins = ["other.yml:solo"]
apply = "just up-solo"
dependants = []
changelog = "https://example.invalid/solo/v{version}"
channel = "auto"
one_way = false
verify = ["body says solo"]

[components.grafana]
title = "Grafana"
class = "app-db"
source = "image"
pins = ["graf.yml:grafana"]
apply = "just up-graf"
dependants = []
changelog = "https://example.invalid/grafana/v{version}"
channel = "notify"
one_way = true
one_way_why = "grafana.db's schema migrates on first start and cannot be downgraded"
verify = ["health"]

[components.web]
title = "Web"
class = "stateless"
source = "image"
pins = ["compose.yml:web"]
apply = "just up-mon"
dependants = []
changelog = "https://example.invalid/web/v{version}"
channel = "auto"
one_way = false
verify = ["body says web"]

[components.loki]
title = "Loki"
class = "timeseries"
source = "image"
pins = ["compose.yml:loki"]
apply = "just up-mon"
dependants = []
changelog = "https://example.invalid/loki/{version}"
channel = "auto"
one_way = false
verify = ["ready"]

[components.bothy]
title = "Bothy (web, files, ops)"
class = "own-code"
source = "github"
repo = "example/bothy"
pins = ["VERSION"]
apply = "just up-apps"
dependants = ["bothy-web", "bothy-files", "bothy-ops"]
changelog = "https://example.invalid/releases/tag/v{version}"
channel = "notify"
one_way = false
verify = ["it answers"]
"""

COMPOSE = {
    "compose.yml": "name: mon\nservices:\n  web:\n    image: example.invalid/web:1.0.1\n    container_name: t-web\n"
                   "  loki:\n    image: grafana/loki:3.7.7\n    container_name: t-loki\n",
    "graf.yml": "name: data\nservices:\n  grafana:\n    image: grafana/grafana:13.2.2\n"
                "    container_name: t-grafana\n",
    "other.yml": "name: solo\nservices:\n  solo:\n    image: example.invalid/solo:2.0.1\n    container_name: t-solo\n",
}
# container -> (image, imageId, digest, compose file)
RUNNING = {
    "t-web": ("example.invalid/web:1.0.0", "sha256:" + "1" * 64, D("a"), "compose.yml"),
    "t-loki": ("grafana/loki:3.7.6", "sha256:" + "2" * 64, D("c"), "compose.yml"),
    "t-grafana": ("grafana/grafana:13.1.4", "sha256:" + "7" * 64, D("7"), "graf.yml"),
    "t-solo": ("example.invalid/solo:2.0.0", "sha256:" + "4" * 64, D("9"), "other.yml"),
}
PROJECT = {"compose.yml": "mon", "graf.yml": "data", "other.yml": "solo"}


def available() -> dict:
    def comp(image: str, tag: str, resolved: str, running: str, latest: str | None = None,
             level: str | None = None) -> dict:
        d = {"checkedAt": GEN, "image": image, "error": None,
             "current": {"tag": tag, "version": tag, "float": False, "resolved": resolved},
             "running": [{"name": running, "image": RUNNING[running][0], "digest": RUNNING[running][2],
                          "state": "running"}], "drift": None}
        if latest:
            d["latest"] = {"tag": latest, "version": latest, "level": level, "digest": D("f")}
            d["candidates"] = {level: d["latest"]}
        return d
    return {"version": 1, "generatedAt": GEN, "components": {
        "web": comp("example.invalid/web", "1.0.1", D("b"), "t-web"),
        "loki": comp("docker.io/grafana/loki", "3.7.7", D("d"), "t-loki"),
        "grafana": comp("docker.io/grafana/grafana", "13.2.2", D("e"), "t-grafana", "13.3.0", "minor"),
        "solo": comp("example.invalid/solo", "2.0.1", D("8"), "t-solo"),
    }}


def _git(repo: str, *args: str) -> str:
    env = {**os.environ, "GIT_AUTHOR_DATE": f"@{NOW} +0000", "GIT_COMMITTER_DATE": f"@{NOW} +0000"}
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false",
                           "-c", "tag.gpgsign=false", *args], cwd=repo, check=True, capture_output=True, text=True,
                          env=env).stdout.strip()


class FakeStore:
    """bothy_settings.Store's read half, by shape: get_meta -> Meta-like. Secrets carry NO value;
    the hostile variant (value set on a secret) lives in api_v1_contract.py."""

    class NotFound(Exception):
        pass

    class Meta:
        def __init__(self, module, key, is_secret, set_, version=None, updated_at=None, updated_by=None,
                     fingerprint=None, value=None):
            self.module, self.key, self.is_secret, self.set = module, key, is_secret, set_
            self.version, self.updated_at, self.updated_by = version, updated_at, updated_by
            self.fingerprint, self.value = fingerprint, value

    ROWS = {("sso", "session_ttl"): ("s", 3600), ("sso", "banner"): ("s", "Welcome back"),
            ("sso", "client_secret"): ("secret", None), ("sso", "unset_note"): ("unset", None)}

    def get_meta(self, module, key):
        r = self.ROWS.get((module, key))
        if r is None:
            raise self.NotFound(f"{module}.{key} is not registered")
        kind, v = r
        if kind == "secret":
            return self.Meta(module, key, True, True, 4, "2026-11-17T08:00:00Z", "cli:devssh", "sha256:ab12cd34")
        if kind == "unset":
            return self.Meta(module, key, False, False)
        return self.Meta(module, key, False, True, 2, "2026-11-17T08:00:00Z", "cli:devssh", None, v)


FakeStore.NotFound.__name__ = "NotFound"


class World:
    pass


def build() -> World:
    """Build the fixed world; return the running server's base URL and the modules."""
    w = World()
    w.tmp = tmp = tempfile.mkdtemp(prefix="bothy-v1-fixture-")
    state = os.path.join(tmp, "state")
    for d in ("audit", "state/plans", "state/groups", "state/own", "spool"):
        os.makedirs(os.path.join(tmp, d))
    os.environ.update({
        "AUDIT_LOG": os.path.join(tmp, "audit", "actions.log"),
        "ADMIN_AUDIT_LOG": os.path.join(tmp, "audit", "admin.log"),
        "UPDATES_AVAILABLE": os.path.join(state, "available.json"),
        "UPDATES_DIR": state, "UPDATES_SPOOL": os.path.join(tmp, "spool"), "BOTHY_VERSION": VERSION,
    })
    real_time = time.time
    time.time = lambda: float(NOW)         # every clock in the process, for the life of the fixture
    w.real_time = real_time

    import updates
    import updater  # noqa: F401
    from updater import groups, hostio, owncode, plans
    from updater.config import Config

    # ── the git world: pins on main, plus a release tag and five commits for `bothy` ──
    origin, repo = os.path.join(tmp, "origin.git"), os.path.join(tmp, "repo")
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", origin], check=True)
    subprocess.run(["git", "clone", "-q", origin, repo], check=True, capture_output=True)
    _git(repo, "checkout", "-q", "-b", "main")
    for name, text in COMPOSE.items():
        open(os.path.join(repo, name), "w").write(text)
    open(os.path.join(repo, "updates.toml"), "w").write(CATALOG)
    open(os.path.join(repo, "VERSION"), "w").write("2026.10.0\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "pins")
    _git(repo, "tag", "-a", "v2026.10.0", "-m", "v2026.10.0")
    _git(repo, "push", "-q", "origin", "main", "v2026.10.0")
    for i in range(5):
        open(os.path.join(repo, "notes.txt"), "a").write(f"change {i}\n")
        _git(repo, "add", ".")
        _git(repo, "commit", "-q", "-m", f"change {i}")
    _git(repo, "push", "-q", "origin", "main")
    _git(repo, "fetch", "-q", "--tags", "origin")

    cfg = Config(repo=repo, catalog=os.path.join(repo, "updates.toml"), state=state,
                 backups=os.path.join(tmp, "backups"), textfile=None, own_fetch=False)
    catalog = updates.load(cfg.catalog)

    def fake_container(name):
        if name not in RUNNING:
            return None
        img, iid, _, f = RUNNING[name]
        return {"name": name, "image": img, "imageId": iid, "state": "running", "health": "healthy",
                "labels": {"com.docker.compose.project": PROJECT[f], "com.docker.compose.service": name[2:]}}

    def fake_image(ref):
        for img, iid, dg, _ in RUNNING.values():
            if ref == iid:
                repo_ = img.rsplit(":", 1)[0]
                if "/" in repo_ and "." not in repo_.split("/")[0]:
                    repo_ = "docker.io/" + repo_
                return {"id": iid, "repoDigests": [f"{repo_}@{dg}"], "size": 1000}
        return None

    def fake_project(repo_, name, pin_file, pin_service):
        f = os.path.basename(pin_file)
        svcs = [c[2:] for c, v in RUNNING.items() if v[3] == f]
        want = {s: f"want-{s}" for s in svcs}
        return {"project": PROJECT[f], "files": [os.path.join(repo_, f)], "wd": repo_, "want": want,
                "have": {s: f"old-{s}" for s in svcs}}

    hostio.container, hostio.image, hostio.compose_project = fake_container, fake_image, fake_project
    plans.write_all(cfg, catalog, available())
    owncode.write_unreleased(cfg)
    open(os.path.join(state, "available.json"), "w").write(json.dumps(available()))

    # ── the records the executor writes: one running job, three finished ──
    def job(jid, comp, state, **kw):
        return {"id": jid, "component": comp, "planId": "0" * 24, "state": state, "requestedBy": "ops@example.com",
                "requestedAt": "2026-11-18T01:00:00Z", "startedAt": "2026-11-18T01:00:05Z", "endedAt": None,
                "from": {"image": "example.invalid/solo:2.0.0", "version": "2.0.0"},
                "to": {"image": "example.invalid/solo:2.0.1", "version": "2.0.1"},
                "error": None, "snapshot": None, "note": None, "steps": [], **kw}

    steps = [{"name": "validate", "state": "ok", "startedAt": "2026-11-18T01:00:05Z",
              "endedAt": "2026-11-18T01:00:06Z", "detail": "the plan holds"},
             {"name": "pull", "state": "running", "startedAt": "2026-11-18T01:00:06Z", "endedAt": None,
              "detail": "pulling example.invalid/solo:2.0.1"},
             {"name": "apply", "state": "pending", "startedAt": None, "endedAt": None, "detail": None}]
    open(os.path.join(state, "status.json"), "w").write(json.dumps(
        {"version": 1, "job": job(J_RUN, "solo", "running", steps=steps)}))
    hist = [
        job(J_OK, "solo", "succeeded", endedAt="2026-11-18T01:30:00Z", durationMs=41000, failedStep=None,
            note="routine"),
        job(J_RB, "loki", "rolled_back", endedAt="2026-11-18T02:10:00Z", durationMs=98000, failedStep="verify",
            error="verify failed: loki /ready answered 503 after 90 s; the previous image was restored"),
        job(J_FAIL, "grafana", "failed", endedAt="2026-11-18T02:40:00Z", durationMs=3000, failedStep="preflight",
            error="preflight: no backup newer than 24 h"),
    ]
    with open(os.path.join(state, "history.jsonl"), "w") as fh:
        for h in hist:
            fh.write(json.dumps(h) + "\n")
    # discovery looked after every job ended, and one component is paused by the night job
    open(os.path.join(state, "auto.json"), "w").write(json.dumps({"version": 1, "paused": {
        "loki": {"since": "2026-11-18T02:10:00Z", "result": "rolled_back", "reason": "its last update was rolled back",
                 "jobId": J_RB, "requestedBy": "auto"}}, "last": None}))
    for root, _, files in os.walk(state):
        for f in files:
            os.utime(os.path.join(root, f), (NOW - 3600, NOW - 3600))

    import app
    import v1api
    updates.CATALOG = catalog
    v1api.load()
    v1api.set_settings_reader(FakeStore())
    w.orig_rid = v1api.new_request_id
    v1api.new_request_id = lambda: RID
    srv = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    w.base = f"http://127.0.0.1:{srv.server_address[1]}"
    w.srv, w.cfg, w.catalog, w.updates, w.v1api = srv, cfg, catalog, updates, v1api
    return w


def call(w: World, path: str, method: str = "GET", headers: dict | None = None, body: bytes | None = None):
    """(status, headers, parsed body) for one request to the real handler. `path` is the PUBLIC path."""
    assert path.startswith("/-/api/"), path
    req = urllib.request.Request(w.base + path[len("/-/api"):], method=method, data=body,
                                 headers=dict(headers or {}))
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, dict(r.headers), json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), json.loads(e.read() or b"{}")


# name -> public path. The name is the golden's file name. Every one is a GET.
CASES = {
    "discover": "/-/api/v1/discover",
    "status": "/-/api/v1/status",
    "module.list": "/-/api/v1/modules",
    "update.status": "/-/api/v1/updates/status",
    "update.plan.stateless": "/-/api/v1/updates/plan?component=solo",
    "update.plan.database": "/-/api/v1/updates/plan?component=grafana",
    "update.plan.grouped": "/-/api/v1/updates/plan?component=web",
    "update.plan.group": "/-/api/v1/updates/plan?group=up-mon",
    "update.plan.refused": "/-/api/v1/updates/plan?component=bothy",
    "update.history": "/-/api/v1/updates/history",
    "update.history.component": "/-/api/v1/updates/history?component=loki&limit=5",
    "job.get.running": f"/-/api/v1/job?id={J_RUN}",
    "job.get.finished": f"/-/api/v1/job?id={J_RB}",
    "events.query": "/-/api/v1/events?limit=2",
    "events.query.page2": f"/-/api/v1/events?limit=2&since=e_{J_OK}_succeeded",
    "settings.get.value": "/-/api/v1/settings?module=sso&key=session_ttl",
    "settings.get.string": "/-/api/v1/settings?module=sso&key=banner",
    "settings.get.secret": "/-/api/v1/settings?module=sso&key=client_secret",
    "settings.get.unset": "/-/api/v1/settings?module=sso&key=unset_note",
    "error.not-found": f"/-/api/v1/job?id={'e' * 32}",
    "error.invalid": "/-/api/v1/updates/plan?component=solo&group=up-mon",
    "error.unknown-op": "/-/api/v1/nothing",
    "error.settings-unregistered": "/-/api/v1/settings?module=sso&key=nope",
}


def _scrub(w: World, body):
    # The throwaway directory's random name is the one thing in a plan that differs per run.
    return json.loads(json.dumps(body).replace(w.tmp, "/fixture"))


def capture(w: World) -> dict[str, dict]:
    out = {}
    for name, path in CASES.items():
        st, hdr, body = call(w, path)
        out[name] = {"request": {"method": "GET", "path": path}, "status": st,
                     "server_header": hdr.get("Bothy-Server"), "body": _scrub(w, body)}
    # the one refusal that is not a GET: any method but GET, on any /v1 path
    st, hdr, body = call(w, "/-/api/v1/updates/plan?component=solo", method="POST", body=b"{}")
    out["error.write-refused"] = {"request": {"method": "POST", "path": "/-/api/v1/updates/plan?component=solo"},
                                  "status": st, "server_header": hdr.get("Bothy-Server"), "body": _scrub(w, body)}
    return out


def render(doc: dict) -> str:
    return json.dumps(doc, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    if "--write" not in sys.argv:
        sys.exit("usage: v1_fixture.py --write")
    world = build()
    docs = capture(world)
    os.makedirs(GOLDEN, exist_ok=True)
    for fn in os.listdir(GOLDEN):
        if fn.endswith(".json"):
            os.unlink(os.path.join(GOLDEN, fn))
    for name, d in docs.items():
        with open(os.path.join(GOLDEN, name + ".json"), "w", encoding="utf-8") as fh:
            fh.write(render(d))
    print(f"wrote {len(docs)} goldens to {GOLDEN}")
