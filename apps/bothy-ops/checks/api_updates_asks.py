#!/usr/bin/env python3
"""The two asks of 2026-10-06 through the REAL bothy-ops handler: discover, autorun.

Run: python3 checks/api_updates_asks.py

Starts app.Handler on a loopback port with the real updates.toml, a state dir
written here in the host's shapes (available.json, asks.json) and an empty spool,
and asserts what a browser can and cannot make the host do:

  discover  202 writes EXACTLY one `discover-<32 hex>.json`, mode 600, exact keys,
            the actor from oauth2-proxy's header - and nothing else happens: no
            process, no registry, no plan. Refused: any body at all (400), not
            JSON (415), cross-site (403), an oversized body (413), a second ask
            while one waits (409), a discovery that ran moments ago (429, with the
            seconds left in the sentence), no spool (503), the actor `auto` (403).
  autorun   the same, plus the body being exactly {dry_run: bool} - a missing,
            extra or non-boolean key is 400 - and a REAL run refused while an
            update is queued or running (409), which a dry run is not.
  state     /updates/status carries `asks`: whether one waits, the rate limit, and
            the HOST's record of the last run of each kind, allow-listed - a
            hostile asks.json (an unknown outcome, a nested object, a bad
            component, a huge skipped list, extra fields) loses all of it.
  audit     one admin.log line per request, refusals included, naming the actor.

Roles are NOT checked here, because the service checks none: `operator` on both is
the edge's (wiring_updates.py asserts the routers), and reachability is
authorisation (SECURITY.md rule 2).

What a 202 must NOT do is the point of half of this file. bothy-ops holds no
registry credential, no docker socket and no path to the internet; the proof here
is negative - after every accepted ask, available.json is byte-identical and the
spool holds exactly one more small file.
"""
import json
import os
import stat
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

TMP = tempfile.mkdtemp(prefix="bothy-ops-api-asks-")
UPD = os.path.join(TMP, "updates")
SPOOL = os.path.join(TMP, "spool")
for d in ("audit", "updates/plans", "spool"):
    os.makedirs(os.path.join(TMP, d))
os.environ.update({
    "AUDIT_LOG": os.path.join(TMP, "audit", "actions.log"),
    "ADMIN_AUDIT_LOG": os.path.join(TMP, "audit", "admin.log"),
    "UPDATES_AVAILABLE": os.path.join(UPD, "available.json"),
    "UPDATES_DIR": UPD,
    "UPDATES_SPOOL": SPOOL,
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
WHO = "operator@example.com"


def call(path: str, *, method: str = "GET", body: object = None, ctype: str = "application/json",
         headers: dict | None = None, raw: bytes | None = None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, method=method, data=data,
                                 headers={"X-Auth-Request-Email": WHO, **(headers or {})})
    if data is not None:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def spool() -> list[str]:
    return sorted(os.listdir(SPOOL))


def clear_spool() -> None:
    for n in spool():
        os.unlink(os.path.join(SPOOL, n))


def log_lines() -> list[str]:
    try:
        return open(os.environ["ADMIN_AUDIT_LOG"]).read().splitlines()
    except FileNotFoundError:
        return []


def write(rel: str, doc: object) -> None:
    with open(os.path.join(UPD, rel), "w") as fh:
        fh.write(doc if isinstance(doc, str) else json.dumps(doc))


def age_available(seconds: int) -> None:
    """available.json, as if discovery last ran `seconds` ago - the rate limit's input."""
    write("available.json", {"version": 1, "generatedAt": "2026-10-06T09:00:00Z", "components": {}})
    p = os.path.join(UPD, "available.json")
    os.utime(p, (time.time() - seconds, time.time() - seconds))


MIN = updates.DISCOVER_MIN_SECONDS
age_available(MIN + 60)

print("── discover: one spool file, and NOTHING else ───────────────────")
before = open(os.path.join(UPD, "available.json"), "rb").read()
n = len(log_lines())
st, b = call("/updates/discover", method="POST", body={})
files = spool()
ok(st == 202 and b.get("ok") is True and len(b["id"]) == 32, f"202 with an ask id ({st} {b})")
ok(len(files) == 1 and files[0] == f"discover-{b['id']}.json", f"exactly one file, named for the id: {files}")
doc = json.load(open(os.path.join(SPOOL, files[0])))
ok(set(doc) == {"v", "kind", "id", "requestedBy", "requestedAt"} and doc["kind"] == "discover"
   and doc["id"] == b["id"], f"the exact key set, and the kind: {sorted(doc)}")
ok(doc["requestedBy"] == WHO, "the actor is oauth2-proxy's header, not anything in the body")
ok(stat.S_IMODE(os.stat(os.path.join(SPOOL, files[0])).st_mode) == 0o600, "mode 600")
ok(open(os.path.join(UPD, "available.json"), "rb").read() == before,
   "available.json is byte-identical: this process discovered nothing, it asked")
ok(len(log_lines()) == n + 1 and "REQUESTED" in log_lines()[-1] and "updates-discover" in log_lines()[-1],
   f"one audit line, REQUESTED: {log_lines()[-1] if log_lines() else '(none)'}")

st, _ = call("/updates/discover", method="POST", body={})
ok(st == 409 and len(spool()) == 1, f"a second ask while one waits -> 409, and no second file ({st})")
clear_spool()

print()
print("── discover: every refusal, and not one file written ────────────")
cases = [
    (dict(body={"only": "a"}), 400, "a body with anything in it (discovery takes no parameters)"),
    (dict(body={}, ctype="text/plain"), 415, "text/plain (a CORS-simple POST)"),
    (dict(body={}, headers={"Sec-Fetch-Site": "cross-site"}), 403, "a forged cross-site POST"),
    (dict(raw=b"{not json"), 400, "not JSON"),
    (dict(body=[1, 2]), 400, "not an object"),
    (dict(raw=b" " * 2000), 413, "an oversized body (the limit is 512 bytes)"),
    (dict(body={}, headers={"X-Auth-Request-Email": updates.AUTO_ACTOR}), 403,
     f"the actor {updates.AUTO_ACTOR!r} - the night job's name, never a person's"),
]
for kw, want, label in cases:
    st, b = call("/updates/discover", method="POST", **kw)
    ok(st == want and not spool(), f"{label} -> {want}, no file ({st})")
    clear_spool()

age_available(5)
st, b = call("/updates/discover", method="POST", body={})
ok(st == 429 and not spool() and f"{MIN - 5}s" in b.get("error", ""),
   f"discovery five seconds ago -> 429 naming the seconds left ({st}: {b.get('error', '')[:70]})")
age_available(MIN + 60)

print()
print("── autorun: the body is exactly {dry_run: bool} ─────────────────")
for body, want, label in (({"dry_run": True}, 202, "a dry run"),
                          ({}, 400, "no dry_run"),
                          ({"dry_run": "yes"}, 400, "dry_run as a string"),
                          ({"dry_run": 1}, 400, "dry_run as 1 (a bool is not an int here)"),
                          ({"dry_run": True, "component": "loki"}, 400,
                           "an extra key (a client cannot name the component)")):
    clear_spool()
    st, b = call("/updates/autorun", method="POST", body=body)
    ok(st == want and len(spool()) == (1 if want == 202 else 0), f"{label} -> {want} ({st})")
    if want == 202:
        d = json.load(open(os.path.join(SPOOL, spool()[0])))
        ok(set(d) == {"v", "kind", "id", "dryRun", "requestedBy", "requestedAt"} and d["kind"] == "autorun"
           and d["dryRun"] is True and d["requestedBy"] == WHO and b["dryRun"] is True,
           f"the exact key set, the flag and the actor: {sorted(d)}")
clear_spool()

st, _ = call("/updates/autorun", method="POST", body={"dry_run": False})
ok(st == 202 and spool() and json.load(open(os.path.join(SPOOL, spool()[0])))["dryRun"] is False,
   "a real run is accepted too, with dryRun false")
st, _ = call("/updates/autorun", method="POST", body={"dry_run": True})
ok(st == 409 and len(spool()) == 1, f"a second night-job ask while one waits -> 409 ({st})")
clear_spool()

# The night job's own fourth gate, said early: it never queues behind a person's
# update. A DRY run is not a queue, so it is still allowed - the distinction the
# page needs in order to answer "why nothing tonight?" while something is running.
job = "f" * 32
with open(os.path.join(SPOOL, f"{job}.json"), "w") as fh:
    json.dump({"v": 1, "jobId": job, "component": "loki", "planId": "0" * 24, "confirm": True,
               "requestedBy": WHO, "requestedAt": "2026-10-06T09:00:00Z"}, fh)
st, b = call("/updates/autorun", method="POST", body={"dry_run": False})
ok(st == 409 and "never queues behind" in b.get("error", ""),
   f"a real run while an update is queued -> 409 ({st}: {b.get('error', '')[:60]})")
st, _ = call("/updates/autorun", method="POST", body={"dry_run": True})
ok(st == 202, f"…and a dry run is still allowed ({st})")
clear_spool()

for kw, want, label in (({"body": {"dry_run": True}, "ctype": "text/plain"}, 415, "text/plain"),
                        ({"body": {"dry_run": True}, "headers": {"Sec-Fetch-Site": "cross-site"}}, 403,
                         "a forged cross-site POST"),
                        ({"body": {"dry_run": True},
                          "headers": {"X-Auth-Request-Email": updates.AUTO_ACTOR}}, 403,
                         f"the actor {updates.AUTO_ACTOR!r}")):
    st, _ = call("/updates/autorun", method="POST", **kw)
    ok(st == want and not spool(), f"{label} -> {want}, no file ({st})")
    clear_spool()

print()
print("── neither ask answers a GET, and neither read takes a POST ─────")
for path in ("/updates/discover", "/updates/autorun"):
    st, _ = call(path)
    ok(st == 404 and not spool(), f"GET {path} -> 404 ({st})")
for path in ("/updates/status", "/updates/plan?component=loki", "/updates/job?id=" + "a" * 32):
    st, _ = call(path, method="POST", body={})
    ok(st == 404, f"POST {path} -> 404 ({st})")

print()
print("── status: the asks block, allow-listed ─────────────────────────")
st, b = call("/updates/status")
a = b.get("asks") or {}
ok(st == 200 and a.get("discoverMinSeconds") == MIN and a.get("discoverQueued") is False
   and a.get("autorunQueued") is False and a.get("discover") is None and a.get("autorun") is None,
   f"no asks.json: the rate limit, nothing queued, nothing recorded ({a})")

write("asks.json", {"version": 1,
                    "discover": {"at": "2026-10-06T09:10:00Z", "askedBy": "a@example.com", "outcome": "ok",
                                 "reason": "3 with a newer version", "tookMs": 4200, "secret": "ZqX9SENTINEL"},
                    "autorun": {"at": "2026-10-06T09:11:00Z", "askedBy": "a@example.com", "outcome": "skipped",
                                "reason": "outside the window", "tookMs": 12, "dryRun": True,
                                "component": "loki", "jobId": None,
                                "skipped": [{"component": "alloy", "why": "paused"},
                                            {"component": "../x", "why": "a path is not an id"},
                                            "not a dict"] + [{"component": "loki", "why": "x"}] * 40},
                    "extra": {"nested": {"deep": 1}}})
st, b = call("/updates/status")
a = b["asks"]
ok(a["discover"]["outcome"] == "ok" and a["discover"]["tookMs"] == 4200
   and a["discover"]["askedBy"] == "a@example.com", "the discover record is served")
ok("ZqX9SENTINEL" not in json.dumps(b) and "secret" not in a["discover"] and "extra" not in a,
   "fields outside the allow-list are dropped (the admin.py second lock)")
# 43 entries in, 18 out: the cap is applied to the RAW list and the junk is dropped
# after it, so a hostile asks.json cannot push 20 real rows through by padding. The
# count is asserted exactly, because "<= 20" would pass if the filter ran first.
ok(a["autorun"]["dryRun"] is True and a["autorun"]["component"] == "loki"
   and len(a["autorun"]["skipped"]) == 18
   and all(s["component"] != "../x" for s in a["autorun"]["skipped"]),
   f"the autorun record: the flag, the component, the first 20 of 43 minus the junk in them, "
   f"no path for an id ({len(a['autorun']['skipped'])})")

for doc, label in (({"version": 2, "discover": {"outcome": "ok"}}, "an unknown version"),
                   ({"version": 1, "discover": {"outcome": "whatever"}}, "an outcome off the list"),
                   ({"version": 1, "discover": "a string"}, "a record that is not an object"),
                   ("[]", "a document that is not an object"),
                   ("{not json", "not JSON at all")):
    write("asks.json", doc)
    st, b = call("/updates/status")
    ok(st == 200 and b["asks"]["discover"] is None, f"{label}: nothing recorded, and the page still draws ({st})")

write("asks.json", {"version": 1, "discover": {"at": "2026-10-06T09:10:00Z", "askedBy": "a@example.com",
                                               "outcome": "ok", "reason": "x", "tookMs": 1}})
with open(os.path.join(SPOOL, "discover-" + "b" * 32 + ".json"), "w") as fh:
    json.dump({"v": 1, "kind": "discover", "id": "b" * 32, "requestedBy": WHO,
               "requestedAt": "2026-10-06T09:00:00Z"}, fh)
st, b = call("/updates/status")
ok(b["asks"]["discoverQueued"] is True and b["asks"]["autorunQueued"] is False,
   "a waiting discovery shows as queued, and an autorun does not")
clear_spool()

print()
print("── no spool mounted: 503, and the page still reads ──────────────")
os.rename(SPOOL, SPOOL + ".gone")
for path, body in (("/updates/discover", {}), ("/updates/autorun", {"dry_run": True})):
    st, b = call(path, method="POST", body=body)
    ok(st == 503 and "just up-apps" in b.get("error", ""), f"{path} -> 503, naming the recipe ({st})")
st, _ = call("/updates/status")
ok(st == 200, f"…and /updates/status still answers ({st})")
os.rename(SPOOL + ".gone", SPOOL)

print()
print("── every request is a line in admin.log, with the actor ─────────")
lines = log_lines()
asks_lines = [ln for ln in lines if "updates-discover" in ln or "updates-autorun" in ln]
ok(len(asks_lines) >= 20, f"{len(asks_lines)} lines for the two asks")
ok(all(WHO in ln or updates.AUTO_ACTOR in ln for ln in asks_lines), "every one names the actor")
outcomes = {ln.split("\t")[2] for ln in asks_lines}
ok(outcomes <= {"REQUESTED", "REFUSED", "FAILED"} and {"REQUESTED", "REFUSED", "FAILED"} <= outcomes,
   f"accepted, refused and failed are all recorded, and nothing else: {sorted(outcomes)}")

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("api_updates_asks: all passed")
