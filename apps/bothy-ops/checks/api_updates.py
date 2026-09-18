#!/usr/bin/env python3
"""GET /updates/status through the REAL bothy-ops handler.

Run: python3 checks/api_updates.py

Starts app.Handler on a loopback port with the real updates.toml and a
available.json written here, and asserts what a browser can get:

  absent     no available.json -> 200 with the catalog and discovery.present
             false, and the command that fixes it (the page is useful without it)
  merged     the discovered versions, levels and drift appear on their rows;
             effectiveChannel follows the policy table; the summary counts
  allow-list a hostile available.json - extra fields, nested objects, a bad
             level, a non-digest digest, an unknown component - is served with
             every one of those dropped (the admin.py "second lock")
  refusals   a query string 400, a POST 404, a cross-site GET 403, a malformed
             file 502, an oversized file 502 - all worded, none a traceback
  stale      a file older than two missed runs is flagged stale
  audit      every request, refusals included, writes one admin.log line
"""
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)
sys.path.insert(0, os.path.join(os.path.dirname(SVC), "bothy-common"))

TMP = tempfile.mkdtemp(prefix="bothy-ops-api-updates-")
os.makedirs(os.path.join(TMP, "audit"))
os.makedirs(os.path.join(TMP, "updates"))
AVAIL = os.path.join(TMP, "updates", "available.json")
os.environ.update({
    "AUDIT_LOG": os.path.join(TMP, "audit", "actions.log"),
    "ADMIN_AUDIT_LOG": os.path.join(TMP, "audit", "admin.log"),
    "UPDATES_AVAILABLE": AVAIL,
})

import app  # noqa: E402
import updates  # noqa: E402

updates.CATALOG = updates.load()

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


srv = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}"


def get(path: str = "/updates/status", headers: dict | None = None, method: str = "GET"):
    req = urllib.request.Request(BASE + path, method=method,
                                 headers={"X-Auth-Request-Email": "viewer@example.com", **(headers or {})},
                                 data=b"{}" if method == "POST" else None)
    if method == "POST":
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def log_lines() -> list[str]:
    try:
        return open(os.environ["ADMIN_AUDIT_LOG"]).read().splitlines()
    except FileNotFoundError:
        return []


def D(c: str) -> str:
    return "sha256:" + c * 64


def put(doc: dict) -> None:
    with open(AVAIL, "w") as fh:
        json.dump(doc, fh)


print("── absent: the catalog alone, and what to run ───────────────────")
st, body = get()
ok(st == 200 and body.get("ok") is True, f"200 without available.json ({st})")
ok(body["discovery"]["present"] is False and "just updates-discover" in (body["discovery"]["hint"] or ""),
   "discovery.present false, with the command")
ok(len(body["components"]) == len(updates.CATALOG.components) and all(r["discovered"] is None for r in body["components"]),
   "every catalog component is listed, none discovered")
ok(body["applying"] is False, "applying is plainly false - nothing in step 3 applies")
ok(body["policy"] == {"windowStart": "03:30", "windowEnd": "05:00", "requireBackup": "stacks-backup.service",
                      "requireDoctor": True, "maxAutoPerNight": 1, "pauseOnFailure": True, "discoverEveryHours": 6},
   "the policy is served as the catalog states it")
g = {r["id"]: r for r in body["components"]}["grafana"]
ok(g["changelog"] == "https://github.com/grafana/grafana/releases/", f"no version -> the releases list: {g['changelog']}")

print()
print("── merged: versions, levels, drift, channels ────────────────────")
now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
put({"version": 1, "generatedAt": now, "components": {
    "grafana": {"checkedAt": now, "image": "docker.io/grafana/grafana", "error": None,
                "current": {"tag": "13.2.2", "version": "13.2.2", "digest": None, "float": False},
                "running": [{"name": "grafana", "image": "grafana/grafana:13.1.4", "digest": D("1"), "state": "running"}],
                "drift": "grafana runs grafana/grafana:13.1.4, monitoring/compose.yml pins grafana/grafana:13.2.2",
                "latest": {"tag": "13.3.0", "version": "13.3.0", "level": "minor", "digest": D("2")},
                "candidates": {"minor": {"tag": "13.3.0", "version": "13.3.0", "level": "minor", "digest": D("2")},
                               "patch": {"tag": "13.2.3", "version": "13.2.3", "level": "patch", "digest": D("3")}}},
    "loki": {"checkedAt": now, "current": {"tag": "3.7.7", "version": "3.7.7"}, "running": [], "drift": None,
             "latest": {"tag": "3.7.8", "version": "3.7.8", "level": "patch"},
             "candidates": {"patch": {"tag": "3.7.8", "version": "3.7.8", "level": "patch"}}},
    "cadvisor": {"checkedAt": now, "current": {"tag": "v0.55.1", "version": "0.55.1"},
                 "latest": {"tag": "v1.0.0", "version": "1.0.0", "level": "major"},
                 "candidates": {"major": {"tag": "v1.0.0", "version": "1.0.0", "level": "major"}}},
    "traefik": {"checkedAt": now, "error": "RateLimited: registry-1.docker.io answered 429"},
}})
st, body = get()
rows = {r["id"]: r for r in body["components"]}
g = rows["grafana"]
ok(st == 200 and body["discovery"]["present"] is True and body["discovery"]["stale"] is False, "present and fresh")
ok(g["level"] == "minor" and g["behind"] is True and g["effectiveChannel"] == "notify", "grafana: a minor, notify, behind")
ok(g["discovered"]["drift"].startswith("grafana runs grafana/grafana:13.1.4"), "grafana: the drift is served")
ok(g["changelog"] == "https://github.com/grafana/grafana/releases/tag/v13.3.0", f"the changelog names the offer: {g['changelog']}")
ok(g["oneWay"] is True and "cannot be downgraded" in g["oneWayWhy"], "one-way, with why")
ok(rows["loki"]["effectiveChannel"] == "auto" and rows["loki"]["behind"] is False, "loki: a patch of an auto component is auto")
ok(rows["cadvisor"]["effectiveChannel"] == "manual", "cadvisor: an auto component's MAJOR is manual")
ok(rows["traefik"]["discovered"]["error"].startswith("RateLimited") and rows["traefik"]["level"] is None,
   "traefik: the error is served, and no level is invented")
ok(rows["keycloak"]["discovered"] is None, "keycloak: not in the file -> not discovered, still listed")
ok(body["summary"] == {"components": len(rows), "updates": 3, "behind": 2, "drift": 1, "errors": 1},
   f"the summary: {body['summary']}")
lines = log_lines()
ok(lines and lines[-1].split("\t")[1:4] == ["viewer@example.com", "READ", "updates-status"],
   f"one admin.log line per read: {lines[-1:] }")

print()
print("── allow-list: a hostile file loses everything unexpected ───────")
SENT = "ZqX9SENTINEL"
put({"version": 1, "generatedAt": now, "secret": SENT, "components": {
    "grafana": {"checkedAt": now, "token": SENT, "current": {"tag": "13.2.2", "version": "13.2.2", "env": SENT,
                                                           "digest": "sha256:" + SENT},
                "running": [{"name": "grafana", "image": "x", "digest": D("1"), "state": "running", "env": {"PW": SENT}}],
                "drift": None, "latest": {"tag": "13.3.0", "version": "13.3.0", "level": "catastrophic", "note": SENT},
                "candidates": {"minor": {"tag": "13.3.0", "level": "minor", "x": SENT}, "sideways": {"tag": SENT}},
                "notes": [SENT]},
    "not-in-catalog": {"checkedAt": now, "latest": {"tag": SENT, "level": "major"}},
}})
st, body = get()
raw = json.dumps(body)
ok(st == 200 and SENT not in raw, "no sentinel byte from outside the allow-list is served")
g = {r["id"]: r for r in body["components"]}["grafana"]
ok(g["level"] is None and "level" not in g["discovered"]["latest"], "an unknown level is dropped, not passed")
ok(g["discovered"]["current"]["digest"] is None, "a digest that is not sha256:<64 hex> is dropped")
ok(set(g["discovered"]["candidates"]) == {"minor"}, "an unknown candidate level is dropped")
ok("not-in-catalog" not in {r["id"] for r in body["components"]}, "a component the catalog does not name is not served")

print()
print("── refusals: worded, and each one logged ────────────────────────")
n = len(log_lines())
st, body = get("/updates/status?component=grafana")
ok(st == 400 and "no parameters" in body.get("error", ""), f"a query string -> 400 ({st})")
st, _ = get(method="POST")
ok(st == 404, f"a POST -> 404, there is no write here ({st})")
st, body = get(headers={"Sec-Fetch-Site": "cross-site"})
ok(st == 403, f"a cross-site GET -> 403 ({st})")
with open(AVAIL, "w") as fh:
    fh.write("{not json")
st, body = get()
ok(st == 502 and "could not be read" in body.get("error", ""), f"a malformed file -> 502, worded ({st})")
put({"version": 2, "components": {}})
st, body = get()
ok(st == 502 and "unknown shape" in body.get("error", ""), f"an unknown version -> 502 ({st})")
with open(AVAIL, "w") as fh:
    fh.write(" " * (updates.MAX_AVAILABLE_BYTES + 1))
st, body = get()
ok(st == 502 and "implausibly large" in body.get("error", ""), f"an oversized file -> 502 ({st})")
outcomes = [ln.split("\t")[2] for ln in log_lines()[n:]]
ok(outcomes == ["REFUSED", "REFUSED", "FAILED", "FAILED", "FAILED"],
   f"every refusal and failure is one line (the POST never reaches this module): {outcomes}")

print()
print("── stale ─────────────────────────────────────────────────────────")
put({"version": 1, "generatedAt": now, "components": {}})
old = time.time() - 14 * 3600
os.utime(AVAIL, (old, old))
st, body = get()
ok(st == 200 and body["discovery"]["stale"] is True and body["discovery"]["ageSeconds"] >= 14 * 3600,
   "older than two missed 6h runs (+1h) -> stale")

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("api_updates: all passed")
