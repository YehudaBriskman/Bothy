#!/usr/bin/env python3
"""One allowlisted compose value through the REAL bothy-ops handler.

Run: python3 checks/api_updates_config.py

THE LIVE REFUSAL TABLE. Starts app.Handler on a loopback port with the real
updates.toml (so the allowlist and the patterns are the SHIPPED ones), a state
dir written here in the host's shapes, and an empty spool. Everything below is
asserted against what the process actually answers and what it actually wrote -
"refused" is a positive assertion, not an absence.

  read      GET /updates/plan?config=<component>: the host's rows through an
            allow-list, a hostile field dropped, a LOCKED ROW CARRYING NO VALUE
            (key names, never values - SECURITY.md rule 7), one parameter
            exactly, same-origin only
  refusals  a key that is not on the allowlist -> 403; a value its pattern
            refuses -> 400; a forged Sec-Fetch-Site -> 403; the `auto` actor ->
            403; a stale plan id -> 409; the value it already has -> 409; and
            NO SPOOL FILE WRITTEN BY ANY OF THEM
  accepted  a valid operator request -> 202, with EXACTLY one spool file, mode
            600, the exact key set including `kind: "config"`, and one audit line
            naming who asked and what the value moves from and to

Roles are NOT checked here, because the service checks none: `operator` on the
request is the edge's (checks/wiring_updates.py asserts the routers, and the
anonymous refusal is oauth2-proxy's), and reachability is authorisation
(SECURITY.md rule 2).
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

TMP = tempfile.mkdtemp(prefix="bothy-ops-api-config-")
UPD = os.path.join(TMP, "updates")
SPOOL = os.path.join(TMP, "spool")
for d in ("audit", "updates/plans", "updates/configs", "spool"):
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
AUTO = "auto"


def call(path: str, *, method: str = "GET", body: object = None, ctype: str = "application/json",
         who: str = WHO, headers: dict | None = None, raw: bytes | None = None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, method=method, data=data,
                                 headers={"X-Auth-Request-Email": who, **(headers or {})})
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


def write(rel: str, doc: object) -> None:
    with open(os.path.join(UPD, rel), "w") as fh:
        fh.write(doc if isinstance(doc, str) else json.dumps(doc))


# The one key the SHIPPED catalog allowlists. Read from the catalog rather than
# retyped, so that allowlisting a second key does not quietly leave this check
# testing a key nobody ships.
CK = sorted(updates.CATALOG.config_keys.values(), key=lambda k: k.id)[0]
CID, KEY = CK.component, CK.key
GEN = "2026-10-11T10:00:00Z"
PID = "0123456789abcdef01234567"
SENT = "ZqX9SENTINEL"
# A value the shipped pattern accepts that is NOT the one that is live, so the
# request is a real change. Derived from the pattern's own alternatives.
import re  # noqa: E402

LIVE = next(v for v in ("/var/lib/grafana/dashboards/box-health.json",) if re.fullmatch(CK.pattern, v))
NEW = next(v for v in ("/var/lib/grafana/dashboards/traefik.json",)
           if re.fullmatch(CK.pattern, v) and v != LIVE)


def plan(pid: str = PID, value: str = LIVE) -> dict:
    return {"v": 1, "kind": "config", "id": pid, "component": CID, "class": "app-db",
            "container": CID, "project": "monitoring", "file": CK.file, "service": CK.service,
            "key": KEY, "from": {"value": value, "line": 196, "text": f"      {KEY}: {value}"},
            "image": "grafana/grafana:13.2.3", "imageId": "sha256:" + "1" * 64,
            "pattern": CK.pattern, "commit": "c" * 40, "recipe": "just up-monitoring",
            "title": f"{KEY} on Grafana", "meaning": CK.meaning, "createdAt": GEN,
            "discoveredAt": GEN, "pinnedIn": ["alloy", CID], "confirm": "click", "oneWay": False,
            "restarts": [CID], "downtime": "~20 s", "signedOut": "nobody",
            "revert": "AUTOMATIC, and it is the host's.", "secret": SENT,
            "preflight": ["x"], "verify": ["y"], "rollback": "z"}


def rows(pid: str = PID, value: str = LIVE) -> dict:
    return {"version": 1, "component": CID, "ok": True, "createdAt": GEN, "discoveredAt": GEN, "rows": [
        {"key": KEY, "service": CK.service, "file": CK.file, "editable": True, "value": value,
         "line": 196, "planId": pid, "pattern": CK.pattern, "meaning": CK.meaning,
         "plan": plan(pid, value)},
        {"key": "GF_SECURITY_ADMIN_PASSWORD", "service": CK.service, "file": CK.file,
         "editable": False, "value": "hunter2-" + SENT,
         "reason": {"name": "secret", "label": "A credential", "meaning": "it is one"}},
        {"key": "GF_USERS_ALLOW_SIGN_UP", "service": CK.service, "file": CK.file, "editable": False,
         "reason": {"name": "security", "label": "A security switch", "meaning": "it is one"}},
    ]}


write("available.json", {"version": 1, "generatedAt": GEN, "components": {}})
write(f"configs/{CID}.json", rows())

print("── read: the rows, allow-listed, and never a locked value ───────")
st, b = call(f"/updates/plan?config={CID}")
by = {r["key"]: r for r in (b.get("rows") or [])}
ok(st == 200 and len(by) == 3, f"200 with every row ({st}, {len(by)})")
ok(by[KEY]["editable"] is True and by[KEY]["planId"] == PID and by[KEY]["value"] == LIVE
   and by[KEY]["pattern"] == CK.pattern,
   "the editable row carries its value, its plan id and its bounded pattern")
ok(SENT not in json.dumps(b),
   "THE LOCKED ROW CARRIES NO VALUE: a sentinel written into one never reaches the answer")
ok("value" not in by["GF_SECURITY_ADMIN_PASSWORD"]
   and by["GF_SECURITY_ADMIN_PASSWORD"]["reason"]["label"] == "A credential",
   "…and it carries the sentence that says why instead - key names, never values (rule 7)")
ok(by["GF_USERS_ALLOW_SIGN_UP"]["reason"]["meaning"] != "it is one",
   "the sentence comes from THIS process's catalog, not from the host's file - a UI list that "
   "disagreed with the catalog is the drift this repo writes checks about")
ok(by[KEY]["pinnedIn"] and "revert" in by[KEY],
   "the editable row says how far one uncommitted line reaches, and whose the undo is")
for q, want, label in ((f"?config={CID}&config=alloy", 400, "two parameters"),
                       ("?config=../x", 400, "a path for an id"),
                       ("?config=nope", 404, "an id not in the catalog")):
    st, _ = call("/updates/plan" + q)
    ok(st == want, f"{label} -> {want} ({st})")
st, _ = call(f"/updates/plan?config={CID}", headers={"Sec-Fetch-Site": "cross-site"})
ok(st == 403, f"a cross-site read -> 403 ({st})")

print()
print("── THE REFUSAL TABLE: and no spool file written by any of them ──")
GOOD = {"component": CID, "key": KEY, "value": NEW, "plan_id": PID, "confirm": True}
n = len(log_lines())
cases = [
    (dict(body={**GOOD, "key": "GF_SECURITY_ADMIN_PASSWORD"}), 403,
     "A KEY THAT IS NOT ON THE ALLOWLIST (403, not 404: the key exists, the permission does not)"),
    (dict(body={**GOOD, "key": "GF_USERS_ALLOW_SIGN_UP"}), 403, "…a security switch, likewise"),
    (dict(body={**GOOD, "key": "WHATEVER"}), 403, "…and a key nobody has ever measured"),
    (dict(body={**GOOD, "value": "/etc/passwd"}), 400, "A VALUE ITS PATTERN REFUSES"),
    (dict(body={**GOOD, "value": "/var/lib/grafana/dashboards/cadvisor.json"}), 400,
     "…including a real file the pattern deliberately does not offer"),
    (dict(body={**GOOD, "value": "/var/lib/grafana/dashboards/traefik.json extra"}), 400,
     "…a value with a space, which could not be a plain scalar"),
    (dict(body={**GOOD, "value": "x" * 70}), 400, "…a value over the ceiling"),
    (dict(body={**GOOD, "value": ""}), 400, "…an empty value"),
    (dict(body={**GOOD, "value": 7}), 400, "…a value that is not a string"),
    (dict(body=GOOD, headers={"Sec-Fetch-Site": "cross-site"}), 403, "A FORGED Sec-Fetch-Site"),
    (dict(body=GOOD, who=AUTO), 403, "THE `auto` ACTOR - the night job's name, never a person's"),
    (dict(body={**GOOD, "plan_id": "f" * 24}), 409, "a TAMPERED plan id (well-formed, not current)"),
    (dict(body={**GOOD, "value": LIVE}), 409, "the value it ALREADY has - a no-op would restart it for nothing"),
    (dict(body={**GOOD, "component": "loki"}), 403, "a component with no editable key at all"),
    (dict(body={**GOOD, "component": "nope"}), 404, "a component that is not in the catalog"),
    (dict(body={**GOOD, "component": "No;pe"}), 400, "a component that is not even a catalog id"),
    (dict(body={**GOOD, "extra": "x"}), 400, "an extra key - the body is exact"),
    (dict(body={k: v for k, v in GOOD.items() if k != "value"}), 400, "no value at all"),
    (dict(body={**GOOD, "confirm": False}), 400, "confirm false"),
    (dict(body={**GOOD, "confirm": CID}), 400, "a typed name, which this plan never asks for"),
    (dict(body=GOOD, ctype="text/plain"), 415, "text/plain (a CORS-simple request)"),
    (dict(raw=b"{not json"), 400, "not JSON"),
]
for kw, want, label in cases:
    st, b = call("/updates/request", method="POST", **kw)
    ok(st == want and spool() == [], f"{label} -> {want}, NO FILE ({st}: {b.get('error', '')[:60]})")

write(f"configs/{CID}.json", {**rows(), "discoveredAt": "2026-10-11T04:00:00Z"})
st, b = call("/updates/request", method="POST", body=GOOD)
ok(st == 409 and "discovery ran again" in b.get("error", "") and spool() == [],
   f"rows older than the last discovery -> 409, no file ({st})")
write(f"configs/{CID}.json", {"version": 1, "component": CID, "ok": False, "reason": "nothing yet"})
st, b = call("/updates/request", method="POST", body=GOOD)
ok(st == 404 and spool() == [], f"no rows at all -> 404, no file ({st})")
write(f"configs/{CID}.json", rows())
os.chmod(SPOOL, 0o500)
st, b = call("/updates/request", method="POST", body=GOOD)
ok(st == 503 and "spool" in b.get("error", "") and spool() == [],
   f"an unwritable spool -> 503, no file ({st})")
os.chmod(SPOOL, 0o700)
refused = [ln.split("\t")[2] for ln in log_lines()[n:]]
ok(len(refused) == len(cases) + 3 and set(refused) <= {"REFUSED", "FAILED"},
   f"every refusal is one admin.log line and nothing else ({len(refused)})")

print()
print("── accepted: 202, ONE spool file, 600, exact keys, one line ─────")
n = len(log_lines())
st, b = call("/updates/request", method="POST", body=GOOD)
ok(st == 202 and b.get("key") == KEY and b.get("value") == NEW, f"202, naming the key and the value ({st})")
files = spool()
ok(len(files) == 1 and files[0] == f"{b['jobId']}.json", f"EXACTLY one spool file, named by the job: {files}")
path = os.path.join(SPOOL, files[0])
ok(stat.S_IMODE(os.stat(path).st_mode) == 0o600, "mode 600")
req = json.load(open(path))
import updater.spool as hspool  # noqa: E402  (the HOST's key set, not a copy of it)

ok(set(req) == hspool.CONFIG_KEYS and req["kind"] == "config",
   f"the exact key set the HOST validates, from the host's own module: {sorted(req)}")
ok(req["component"] == CID and req["key"] == KEY and req["value"] == NEW and req["planId"] == PID
   and req["confirm"] is True and req["requestedBy"] == WHO,
   "…and every field is what was asked for, with the actor from oauth2-proxy's header")
line = log_lines()[n:]
ok(len(line) == 1 and line[0].split("\t")[2] == "REQUESTED" and WHO in line[0]
   and NEW in line[0] and LIVE in line[0],
   f"ONE audit line, naming who asked and what the value moves from and to: {line}")
st, b = call("/updates/request", method="POST", body=GOOD)
ok(st == 409 and len(spool()) == 1, f"a second ask while one is queued -> 409, still one file ({st})")

print()
print(f"api config: {'all passed' if not fails else str(len(fails)) + ' FAILED'}")
srv.shutdown()
sys.exit(1 if fails else 0)
