#!/usr/bin/env python3
"""Step 4's routes through the REAL bothy-ops handler: plan, request, job.

Run: python3 checks/api_updates_apply.py

Starts app.Handler on a loopback port with the real updates.toml, a state dir
written here in the host's shapes (available.json, plans/, status.json,
history.jsonl) and an empty spool, and asserts:

  plan      the host's plan is served through an allow-list (a hostile field is
            dropped); a refusal is served as its reason; no plan file says what
            to run; one parameter exactly, a catalog id, same-origin only
  request   202 writes EXACTLY one spool file, mode 600, exact keys, the actor
            from oauth2-proxy's header - and nothing else happens. Refused: not
            JSON (415), cross-site (403), a malformed or extra-keyed body (400),
            an oversized body (413), an unknown component (404), no deployable
            plan / a stale plan id / a plan older than the last discovery / a
            duplicate (409), a full queue (429), no spool (503), and a confirm
            that is not the plan's. Every refusal writes no file.
  job       queued (from the spool), running (status.json, with steps),
            finished (history.jsonl); unknown 404; malformed 400
  status    carries the plan summary per row, the job, the history, `applying`
  audit     one admin.log line per request, refusals included

Roles are NOT checked here, because the service checks none: `viewer` on the
three reads and `operator` on the request are the edge's (wiring_updates.py
asserts the routers), and reachability is authorisation (SECURITY.md rule 2).
"""
import json
import os
import stat
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)
sys.path.insert(0, os.path.join(os.path.dirname(SVC), "bothy-common"))

TMP = tempfile.mkdtemp(prefix="bothy-ops-api-apply-")
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


def log_lines() -> list[str]:
    try:
        return open(os.environ["ADMIN_AUDIT_LOG"]).read().splitlines()
    except FileNotFoundError:
        return []


def D(c: str) -> str:
    return "sha256:" + c * 64


GEN = "2026-09-19T10:00:00Z"
PID = "0123456789abcdef01234567"
SENT = "ZqX9SENTINEL"


def write(rel: str, doc: object) -> None:
    with open(os.path.join(UPD, rel), "w") as fh:
        fh.write(doc if isinstance(doc, str) else json.dumps(doc))


def loki_plan(pid: str = PID, discovered: str = GEN, **extra) -> dict:
    return {"version": 1, "component": "loki", "ok": True, "plan": {
        "id": pid, "component": "loki", "title": "Loki", "class": "timeseries", "createdAt": GEN,
        "discoveredAt": discovered, "level": "patch", "confirm": "click",
        "from": {"image": "grafana/loki:3.7.6", "tag": "3.7.6", "version": "3.7.6", "digest": D("a"),
                 "imageId": "sha256:" + "1" * 64, "container": "loki"},
        "to": {"image": "grafana/loki:3.7.7", "tag": "3.7.7", "version": "3.7.7", "digest": D("b")},
        "pin": {"file": "monitoring/compose.yml", "service": "loki", "line": 228, "text": "    image: x",
                "commit": "c" * 40},
        "changelog": "https://github.com/grafana/loki/releases/tag/v3.7.7",
        "oneWay": False, "oneWayWhy": None, "restarts": ["loki", "alloy", "grafana"],
        "recipe": "just up-monitoring", "downtime": "~30-60 s", "signedOut": "nobody",
        "snapshot": {"kind": "loki", "what": "Loki stopped and tarred", "dir": "~/backups/pre-update/<time>-loki/",
                     "estimateBytes": 25_000_000},
        "preflight": ["backups"], "verify": ["Loki: /ready says `ready`"], "rollback": "the old image", **extra}}


write("available.json", {"version": 1, "generatedAt": GEN, "components": {}})
write("plans/loki.json", loki_plan(secret=SENT))
write("plans/grafana.json", {"version": 1, "component": "grafana", "ok": False,
                             "reason": "class app-db is not handled by the updater yet", "createdAt": GEN})

print("── plan: the host's plan, allow-listed ──────────────────────────")
st, b = call("/updates/plan?component=loki")
p = b.get("plan") or {}
ok(st == 200 and p.get("id") == PID and p["from"]["image"] == "grafana/loki:3.7.6" and p["to"]["digest"] == D("b"),
   f"200: the plan, old and new tag@digest ({st})")
ok(SENT not in json.dumps(b) and "imageId" not in p["from"] and "text" not in p["pin"],
   "fields outside the allow-list (a sentinel, the image id, the raw line) are dropped")
ok(p["restarts"] == ["loki", "alloy", "grafana"] and p["snapshot"]["kind"] == "loki" and p["confirm"] == "click",
   "restarts, snapshot and confirm are served")
st, b = call("/updates/plan?component=grafana")
ok(st == 200 and b["plan"] is None and "not handled" in b["reason"], "a refusal is served as its reason")
st, b = call("/updates/plan?component=alloy")
ok(st == 200 and b["plan"] is None and "just updates-discover" in b["reason"], "no plan file: what to run")
for q, want, label in (("", 400, "no parameter"), ("?component=loki&component=alloy", 400, "two parameters"),
                       ("?id=loki", 400, "the wrong parameter"), ("?component=../x", 400, "a path for an id"),
                       ("?component=nope", 404, "an id not in the catalog")):
    st, _ = call("/updates/plan" + q)
    ok(st == want, f"{label} -> {want} ({st})")
st, _ = call("/updates/plan?component=loki", headers={"Sec-Fetch-Site": "cross-site"})
ok(st == 403, f"a cross-site read -> 403 ({st})")
st, _ = call("/updates/plan?component=loki", method="POST", body={})
ok(st == 404, f"a POST to a read -> 404 ({st})")

print()
print("── request: one spool file, and nothing else ────────────────────")
GOOD = {"component": "loki", "plan_id": PID, "confirm": True}
n = len(log_lines())
cases = [
    (dict(body=GOOD, ctype="text/plain"), 415, "text/plain (a CORS-simple request)"),
    (dict(body=GOOD, headers={"Sec-Fetch-Site": "cross-site"}), 403, "cross-site"),
    (dict(raw=b"{not json"), 400, "not JSON"),
    (dict(body=[1, 2]), 400, "not an object"),
    (dict(raw=b" " * 3000), 413, "an oversized body (the limit is 2 KiB: a maintenance note fits, a payload does not)"),
    (dict(body={**GOOD, "image": "evil:latest"}), 400, "an extra key (a client cannot name an image)"),
    (dict(body={"component": "loki", "plan_id": PID}), 400, "a missing key"),
    (dict(body={**GOOD, "component": "Loki;rm"}), 400, "a malformed component"),
    (dict(body={**GOOD, "plan_id": "../../x"}), 400, "a malformed plan id"),
    (dict(body={**GOOD, "component": "nope"}), 404, "an unknown component"),
    (dict(body={**GOOD, "component": "grafana"}), 409, "a component with no deployable plan"),
    (dict(body={**GOOD, "component": "alloy"}), 404, "a component with no plan file"),
    (dict(body={**GOOD, "plan_id": "f" * 24}), 409, "a TAMPERED plan id (well-formed, not current)"),
    (dict(body={**GOOD, "confirm": False}), 400, "confirm false"),
    (dict(body={**GOOD, "confirm": "loki"}), 400, "a typed name on a click plan"),
]
for kw, want, label in cases:
    st, b = call("/updates/request", method="POST", **kw)
    ok(st == want and spool() == [], f"{label} -> {want}, no file ({st}: {b.get('error', '')[:70]})")
write("plans/loki.json", loki_plan(discovered="2026-09-19T04:00:00Z"))
st, b = call("/updates/request", method="POST", body=GOOD)
ok(st == 409 and "discovery ran again" in b.get("error", "") and spool() == [],
   f"a plan older than the last discovery -> 409 ({st})")
write("plans/loki.json", loki_plan())
os.chmod(SPOOL, 0o500)
st, b = call("/updates/request", method="POST", body=GOOD)
ok(st == 503 and "spool" in b.get("error", ""), f"an unwritable spool -> 503 ({st})")
os.chmod(SPOOL, 0o700)
st, _ = call("/updates/request")
ok(st == 404, f"a GET to the request -> 404 ({st})")
refusals = [ln.split("\t")[2] for ln in log_lines()[n:]]
ok(len(refusals) == len(cases) + 2 and set(refusals) == {"REFUSED", "FAILED"},
   f"every refusal is one admin.log line ({len(refusals)})")

st, b = call("/updates/request", method="POST", body=GOOD)
jid = b.get("jobId", "")
files = spool()
ok(st == 202 and len(jid) == 32 and files == [f"{jid}.json"], f"202, and exactly one file: {files}")
f = os.path.join(SPOOL, files[0]) if files else ""
req = json.load(open(f)) if f else {}
ok(set(req) == {"v", "jobId", "component", "planId", "confirm", "requestedBy", "requestedAt"} and req["v"] == 1
   and req["component"] == "loki" and req["planId"] == PID and req["confirm"] is True and req["requestedBy"] == WHO,
   "the file carries exactly the request and who asked - no image, no command")
ok(f and stat.S_IMODE(os.stat(f).st_mode) == 0o600, "mode 600")
last = log_lines()[-1].split("\t")
ok(last[1:4] == [WHO, "REQUESTED", "updates-request"] and jid in last[4], f"admin.log: REQUESTED, with the job: {last[1:5]}")
st, b = call("/updates/request", method="POST", body=GOOD)
ok(st == 409 and "already queued" in b.get("error", "") and len(spool()) == 1, f"a duplicate -> 409 ({st})")
for i in range(7):
    with open(os.path.join(SPOOL, f"{i:x}" * 32 + ".json"), "w") as fh:
        json.dump({"jobId": f"{i:x}" * 32, "component": "cadvisor"}, fh)
write("plans/node-exporter.json", {"version": 1, "component": "node-exporter", "ok": True,
                                   "plan": {**loki_plan()["plan"], "component": "node-exporter"}})
st, b = call("/updates/request", method="POST", body={**GOOD, "component": "node-exporter"})
ok(st == 429 and len(spool()) == 8, f"a full queue -> 429 ({st})")
for n_ in spool():
    if n_ != f"{jid}.json":
        os.unlink(os.path.join(SPOOL, n_))

print()
print("── one-way (app-db, step 5): type the name, two pins ────────────")
KID = "fedcba9876543210fedcba98"
kc = loki_plan(pid=KID)
kc["component"] = "keycloak"
kc["plan"].update({
    "component": "keycloak", "title": "Keycloak", "class": "app-db", "confirm": "type-name", "level": "patch",
    "from": {"image": "quay.io/keycloak/keycloak:26.7.3-0", "tag": "26.7.3-0", "version": "26.7.3",
             "digest": D("c"), "container": "keycloak"},
    "to": {"image": "quay.io/keycloak/keycloak:26.7.4-0", "tag": "26.7.4-0", "version": "26.7.4", "digest": D("d")},
    "pin": {"file": "auth/compose.yml", "service": "keycloak", "line": 90, "text": "    image: x", "commit": "c" * 40},
    "pins": [{"file": "auth/compose.yml", "service": "keycloak", "line": 90, "text": "    image: x",
              "container": "keycloak"},
             {"file": "auth/compose.yml", "service": "keycloak-init", "line": 150, "text": "    image: x",
              "container": "keycloak-init"}],
    "oneWay": True, "oneWayWhy": "Keycloak migrates its database on first start.",
    "restarts": ["keycloak", "keycloak-init", "oauth2-proxy"], "recipe": "just up-auth",
    "downtime": "~1-2 min: logins are unavailable; every gated route FAILS CLOSED meanwhile",
    "signedOut": "nobody: Keycloak 26 persists user sessions", "rollback": "ONE-WAY: the dump is restored first",
    "snapshot": {"kind": "keycloak", "what": "pg_dump -Fc", "dir": "~/backups/pre-update/<time>-keycloak/",
                 "estimateBytes": 1_000_000}})
write("plans/keycloak.json", kc)
st, b = call("/updates/plan?component=keycloak")
p = b.get("plan") or {}
ok(st == 200 and p.get("confirm") == "type-name" and p.get("oneWay") is True and p["snapshot"]["kind"] == "keycloak"
   and p["class"] == "app-db", f"a one-way plan is served: type-name, the keycloak snapshot ({st})")
ok([(q["service"], q["line"]) for q in p.get("pins", [])] == [("keycloak", 90), ("keycloak-init", 150)]
   and all("text" not in q and "container" not in q for q in p["pins"]),
   f"…with BOTH pin lines, file/service/line only: {p.get('pins')}")
ok("FAILS CLOSED" in p.get("downtime", "") and "persists" in p.get("signedOut", ""),
   "…and what the plan says about downtime and sessions")
K = {"component": "keycloak", "plan_id": KID}
for conf, label in ((True, "a click on a type-name plan"), ("grafana", "another component's name"),
                    ("Keycloak", "the name in the wrong case"), ("", "an empty name")):
    st, b = call("/updates/request", method="POST", body={**K, "confirm": conf})
    ok(st == 400 and spool() == [f"{jid}.json"], f"{label} -> 400, no file ({st}: {b.get('error', '')[:60]})")
st, b = call("/updates/request", method="POST", body={**K, "confirm": "keycloak"})
kj = b.get("jobId", "")
kf = os.path.join(SPOOL, f"{kj}.json")
ok(st == 202 and os.path.exists(kf) and json.load(open(kf))["confirm"] == "keycloak",
   f"the typed name -> 202, and the spool file carries it for the executor to check again ({st})")
if os.path.exists(kf):
    os.unlink(kf)

print()
print("── the Postgres major (step 8): typed AND a maintenance note ────")
PGID = "abcabcabcabcabcabcabcabc"
pg = loki_plan(pid=PGID)
pg["component"] = "postgres"
pg["plan"].update({
    "component": "postgres", "title": "Postgres", "class": "database", "kind": "postgres-major",
    "confirm": "type-name", "requiresNote": True, "level": "major",
    "from": {"image": "postgres:17.10@" + D("e"), "tag": "17.10", "version": "17.10", "digest": D("e"),
             "container": "postgres", "volume": "postgres_postgres_data"},
    "to": {"image": "postgres:18.1@" + D("f"), "tag": "18.1", "version": "18.1", "digest": D("f")},
    "pin": {"file": "data/postgres/compose.yml", "service": "postgres", "line": 8, "text": "x", "commit": "c" * 40},
    "oneWay": True, "oneWayWhy": "A major cannot open the previous major's data directory.",
    "restarts": ["postgres", "keycloak", "oauth2-proxy", "postgres-exporter", "keycloak-db-init"],
    "recipe": "just up-data", "rollback": "back to the OLD volume, never deleted",
    "procedure": [f"step {i}" for i in range(1, 11)],
    "pgMajor": {"fromMajor": 17, "toMajor": 18, "oldVolume": "postgres_postgres_data",
                "newVolume": "postgres_postgres18_data", "oldMount": "/var/lib/postgresql/data",
                "newMount": "/var/lib/postgresql", "dataBytes": 123456, "databases": ["dev", "keycloak"],
                "keycloakDb": "keycloak", "stops": ["keycloak"], "deleteOld": "docker volume rm postgres_postgres_data",
                "secret": SENT},
    "snapshot": {"kind": "pg-dumpall", "what": "a pg_dumpall", "dir": "~/backups/pre-update/<time>-postgres/",
                 "estimateBytes": 123456}})
write("plans/postgres.json", pg)
st, b = call("/updates/plan?component=postgres")
p = b.get("plan") or {}
ok(st == 200 and p.get("kind") == "postgres-major" and p.get("requiresNote") is True and p["confirm"] == "type-name"
   and p["snapshot"]["kind"] == "pg-dumpall" and len(p.get("procedure", [])) == 10,
   f"the postgres-major plan is served: its kind, the note it needs, its ten-step procedure ({st})")
ok(p.get("pgMajor", {}).get("newVolume") == "postgres_postgres18_data" and SENT not in json.dumps(b),
   "…the two volumes, through the allow-list (a sentinel dropped)")
PG = {"component": "postgres", "plan_id": PGID}
NOTE = "moving Postgres to 18 - Keycloak is down ~3 min; team told in #ops"
for body, label in (({**PG, "confirm": True, "note": NOTE}, "a CLICK, even with a note"),
                    ({**PG, "confirm": "postgres"}, "the name typed but NO note"),
                    ({**PG, "confirm": "postgres", "note": "ok"}, "a note too short to say anything"),
                    ({**PG, "confirm": "postgres", "note": "x" * 501}, "a note over 500 characters"),
                    ({**PG, "confirm": "postgres", "note": "line one\nline two here"}, "a note of two lines"),
                    ({**PG, "confirm": "postgres", "note": 42}, "a note that is not text")):
    st, b = call("/updates/request", method="POST", body=body)
    ok(st == 400 and spool() == [f"{jid}.json"], f"{label} -> 400, no file ({st}: {b.get('error', '')[:60]})")
st, b = call("/updates/request", method="POST", body={**GOOD, "note": NOTE})
ok(st == 400 and spool() == [f"{jid}.json"], f"a note on a plan that does not ask for one -> 400 ({st})")
st, b = call("/updates/request", method="POST", body={**PG, "confirm": "postgres", "note": NOTE})
pj = b.get("jobId", "")
pf = os.path.join(SPOOL, f"{pj}.json")
preq = json.load(open(pf)) if os.path.exists(pf) else {}
ok(st == 202 and preq.get("confirm") == "postgres" and preq.get("note") == NOTE,
   f"typed AND noted -> 202, the spool file carries both for the executor to check again ({st})")
ok(NOTE in log_lines()[-1], "admin.log records the maintenance note with the request")
if os.path.exists(pf):
    os.unlink(pf)

print()
print("── job: queued, running, finished ───────────────────────────────")
st, b = call(f"/updates/job?id={jid}")
ok(st == 200 and b["job"]["state"] == "queued" and b["job"]["requestedBy"] == WHO, f"in the spool -> queued ({st})")
os.unlink(os.path.join(SPOOL, f"{jid}.json"))
running = {"id": jid, "component": "loki", "planId": PID, "state": "running", "requestedBy": WHO,
           "requestedAt": GEN, "startedAt": GEN, "endedAt": None, "from": {"image": "grafana/loki:3.7.6", "version": "3.7.6"},
           "to": {"image": "grafana/loki:3.7.7", "version": "3.7.7"}, "error": None, "snapshot": None, "note": None,
           "steps": [{"name": "validate", "state": "ok", "startedAt": GEN, "endedAt": GEN, "detail": "fine"},
                     {"name": "preflight", "state": "running", "startedAt": GEN, "endedAt": None, "detail": None},
                     {"name": "evil", "state": "ok"}, {"name": "pull", "state": "exploded"}],
           "token": SENT}
write("status.json", {"version": 1, "job": running})
st, b = call(f"/updates/job?id={jid}")
ok(st == 200 and b["job"]["state"] == "running" and [s["name"] for s in b["job"]["steps"]] == ["validate", "preflight"],
   "status.json -> running, with its steps (unknown names and states dropped)")
ok(SENT not in json.dumps(b), "…through the allow-list")
st, b = call("/updates/status")
ok(st == 200 and b["applying"] is True and b["job"]["id"] == jid, "status: applying, with the job")
rows = {r["id"]: r for r in b["components"]}
ok(rows["loki"]["plan"] == {"id": PID, "deployable": True, "from": "3.7.6", "to": "3.7.7", "level": "patch",
                            "createdAt": GEN}, f"status: the plan summary on the row: {rows['loki']['plan']}")
ok(rows["grafana"]["plan"]["deployable"] is False and "not handled" in rows["grafana"]["plan"]["reason"],
   "…and the reason on a row that has none")
done = {**{k: v for k, v in running.items() if k not in ("steps", "token")}, "state": "rolled_back",
        "endedAt": GEN, "durationMs": 81234, "failedStep": "verify", "error": "the canary said no",
        "note": "monitoring/compose.yml now pins grafana/loki:3.7.6 locally"}
write("history.jsonl", "not json\n" + json.dumps(done) + "\n")
write("status.json", {"version": 1, "job": {**running, "id": "e" * 32}})
st, b = call(f"/updates/job?id={jid}")
ok(st == 200 and b["job"]["state"] == "rolled_back" and b["job"]["steps"] == [] and "now pins" in b["job"]["note"],
   "history.jsonl -> finished, with its note (a bad line skipped)")
st, b = call("/updates/status")
ok(b["history"] and b["history"][0]["id"] == jid and b["history"][0]["durationMs"] == 81234
   and b["history"][0]["failedStep"] == "verify", "status: the history, newest first")
st, _ = call("/updates/job?id=" + "9" * 32)
ok(st == 404, f"an unknown job -> 404 ({st})")
st, _ = call("/updates/job?id=../../status")
ok(st == 400, f"a malformed id -> 400 ({st})")

print()
print("── auto (step 7): the actor, the pauses, the unpause request ────")
for n_ in spool():
    os.unlink(os.path.join(SPOOL, n_))
st, b = call("/updates/request", method="POST", body=GOOD, headers={"X-Auth-Request-Email": "auto"})
ok(st == 403 and "automatic channel" in b.get("error", "") and spool() == [],
   f"nobody may request as `auto`, the night job's actor ({st})")
write("auto.json", {"version": 1, "paused": {
    "loki": {"since": GEN, "jobId": jid, "result": "rolled_back", "reason": "rolled back: the canary said no",
             "requestedBy": "auto", "secret": SENT},
    "../x": {"since": GEN}}, "last": {"at": GEN, "outcome": "requested", "reason": "loki 3.7.6 -> 3.7.7",
                                     "component": "loki", "jobId": jid, "token": SENT}})
history_line = {**done, "id": "8" * 32, "requestedBy": "auto", "state": "succeeded"}
write("history.jsonl", json.dumps(history_line) + "\n")
st, b = call("/updates/status")
rows = {r["id"]: r for r in b["components"]}
ok(st == 200 and rows["loki"]["paused"] and rows["loki"]["paused"]["reason"].startswith("rolled back")
   and rows["loki"]["paused"]["jobId"] == jid and rows["alloy"]["paused"] is None,
   "status: the host's pause on its row, with the reason; none on the others")
ok(b["auto"] == {"enabled": True, "actor": "auto", "paused": ["loki"],
                 "last": {"at": GEN, "outcome": "requested", "reason": "loki 3.7.6 -> 3.7.7", "component": "loki",
                          "jobId": jid}}, f"status.auto: enabled, paused, the last night: {b.get('auto')}")
ok(SENT not in json.dumps(b), "auto.json is allow-listed too (a sentinel and a bad id dropped)")
ok(b["history"][0]["requestedBy"] == "auto", "the history carries the actor `auto`")
UGOOD = {"component": "loki"}
n = len(log_lines())
ucases = [
    (dict(body=UGOOD, ctype="text/plain"), 415, "text/plain"),
    (dict(body=UGOOD, headers={"Sec-Fetch-Site": "cross-site"}), 403, "cross-site"),
    (dict(body={**UGOOD, "by": "x"}), 400, "an extra key"),
    (dict(body={}), 400, "no component"),
    (dict(body={"component": "Loki;rm"}), 400, "a malformed component"),
    (dict(body={"component": "nope"}), 404, "an unknown component"),
    (dict(body={"component": "alloy"}), 409, "a component that is not paused"),
    (dict(body=UGOOD, headers={"X-Auth-Request-Email": "auto"}), 403, "the system actor"),
]
for kw, want, label in ucases:
    st, b = call("/updates/unpause", method="POST", **kw)
    ok(st == want and spool() == [], f"unpause: {label} -> {want}, no file ({st}: {b.get('error', '')[:60]})")
ok(len(log_lines()) - n == len(ucases), "every unpause refusal is one admin.log line")
st, b = call("/updates/unpause", method="POST", body=UGOOD)
files = spool()
rid = b.get("id", "")
ok(st == 202 and files == [f"unpause-{rid}.json"], f"202, and exactly one unpause file: {files}")
ureq = json.load(open(os.path.join(SPOOL, files[0]))) if files else {}
ok(ureq == {"v": 1, "kind": "unpause", "id": rid, "component": "loki", "requestedBy": WHO,
            "requestedAt": ureq.get("requestedAt")} and stat.S_IMODE(os.stat(os.path.join(SPOOL, files[0])).st_mode) == 0o600,
   "the file carries exactly {v, kind, id, component, requestedBy, requestedAt}, 600")
last = log_lines()[-1].split("\t")
ok(last[1:4] == [WHO, "REQUESTED", "updates-unpause"] and rid in last[4], f"admin.log: REQUESTED updates-unpause: {last[1:5]}")
ok(json.load(open(os.path.join(UPD, "auto.json")))["paused"].get("loki"), "the pause itself is untouched - the host clears it")
st, b = call("/updates/unpause", method="POST", body=UGOOD)
ok(st == 409 and "already waiting" in b.get("error", "") and len(spool()) == 1, f"a duplicate -> 409 ({st})")
st, b = call("/updates/status")
ok({r["id"]: r for r in b["components"]}["loki"]["unpauseQueued"] is True, "status: the row says an unpause is waiting")
st, b = call("/updates/request", method="POST", body=GOOD)
ok(st != 429 and "requests are already waiting" not in b.get("error", ""),
   "an unpause file does not count as an update request in the queue")
for n_ in spool():
    os.unlink(os.path.join(SPOOL, n_))
st, _ = call("/updates/unpause")
ok(st == 404, f"a GET to the unpause -> 404 ({st})")

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("api_updates_apply: all passed")
