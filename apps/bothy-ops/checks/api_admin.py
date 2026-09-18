#!/usr/bin/env python3
"""The admin HTTP surface, against a stand-in Keycloak that COUNTS what reaches it.

Run: python3 checks/api_admin.py

Starts the REAL bothy-ops handler (app.py) on a loopback port and drives
GET /admin/{users,credentials,backups,audit} with urllib, so every assertion goes
through the request parsing, the CSRF gate and the allow-lists a browser reaches.

── what it asserts ─────────────────────────────────────────────────────────

  users        the allow-listed shape; the four roles split from Keycloak's own;
               credential secretData/credentialData never copied; a user id that
               is not a UUID is never put in a URL; the client secret appears in
               no response, no audit line, and no request except the token POST
  refusals     unknown endpoint 404, parameters 400, POST 404, cross-site 403 -
               with ZERO requests reaching Keycloak
  failure      no secret file / no KEYCLOAK_URL -> 503; Keycloak refusing the
               client or the admin call -> 502, worded, token cache dropped on 401
  audit        four logs parsed, newest first, filtered by who/outcome/action,
               paged, malformed lines skipped, a cut window reported
  inventory    absent -> 503 with the command; old -> stale; served otherwise
  logging      every request, refusals included, writes one admin.log line
"""
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)
sys.path.insert(0, os.path.join(os.path.dirname(SVC), "bothy-common"))

TMP = tempfile.mkdtemp(prefix="bothy-ops-api-admin-")
SECRET = "S3cr3tSENTINEL-client-9f8e7d"
SECRET_FILE = os.path.join(TMP, "secrets", "keycloak-admin-client-secret")
os.makedirs(os.path.dirname(SECRET_FILE))
with open(SECRET_FILE, "w") as fh:
    fh.write(SECRET + "\n")

AUD = os.path.join(TMP, "audit")
AUDF = os.path.join(TMP, "audit-files")
os.makedirs(AUD)
os.makedirs(AUDF)
os.environ.update({
    "AUDIT_LOG": os.path.join(AUD, "actions.log"),
    "ADMIN_AUDIT_LOG": os.path.join(AUD, "admin.log"),
    "FILES_AUDIT_LOG": os.path.join(AUDF, "writes.log"),
    "CONFIG_AUDIT_LOG": os.path.join(AUDF, "patches.log"),
    "INVENTORY_FILE": os.path.join(TMP, "inventory", "inventory.json"),
    "KEYCLOAK_SECRET_FILE": SECRET_FILE,
    "KEYCLOAK_REALM": "devbox",
    "KEYCLOAK_CLIENT_ID": "bothy-admin",
})

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


# ── the stand-in Keycloak ───────────────────────────────────────────────────
U1 = "11111111-2222-3333-4444-555555555555"
U2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
HASH_SENTINEL = "HASHSENTINEL$2a$10$notarealhash"
SEEN: list[tuple[str, str, str]] = []   # (method, path, body)
MODE = {"token": 200, "users": 200}


class FakeKC(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, payload):
        b = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode()
        SEEN.append(("POST", self.path, body))
        if self.path != "/realms/devbox/protocol/openid-connect/token":
            return self._json(404, {})
        form = dict(urllib.parse.parse_qsl(body))
        if MODE["token"] != 200 or form.get("client_secret") != SECRET or form.get("grant_type") != "client_credentials":
            return self._json(MODE["token"] if MODE["token"] != 200 else 401, {"error": "unauthorized_client"})
        return self._json(200, {"access_token": "tok-123", "expires_in": 300})

    def do_GET(self):
        SEEN.append(("GET", self.path, ""))
        if self.headers.get("Authorization") != "Bearer tok-123":
            return self._json(401, {})
        p = self.path.split("?")[0]
        if p == "/admin/realms/devbox/users":
            if MODE["users"] != 200:
                return self._json(MODE["users"], {"error": "forbidden"})
            return self._json(200, [
                {"id": U1, "username": "devssh", "email": "dev@example.com", "enabled": True,
                 "emailVerified": True, "createdTimestamp": 1_755_000_000_000, "requiredActions": [],
                 "attributes": {"secretish": [HASH_SENTINEL]}, "access": {"manage": True}},
                {"id": U2, "username": "viewer-only", "enabled": False, "emailVerified": False,
                 "createdTimestamp": 1_756_000_000_000, "requiredActions": ["UPDATE_PASSWORD"]},
                {"id": "../../clients", "username": "traversal"},
            ])
        if p == f"/admin/realms/devbox/users/{U1}/role-mappings/realm":
            return self._json(200, [{"name": "viewer"}, {"name": "editor"}, {"name": "operator"},
                                    {"name": "default-roles-devbox"}])
        if p == f"/admin/realms/devbox/users/{U2}/role-mappings/realm":
            return self._json(200, [{"name": "viewer"}])
        if p.endswith("/credentials"):
            return self._json(200, [
                {"id": "c1", "type": "password", "createdDate": 1_757_000_000_000,
                 "secretData": json.dumps({"value": HASH_SENTINEL, "salt": "SALTSENTINEL"}),
                 "credentialData": json.dumps({"hashIterations": 27500, "algorithm": "pbkdf2-sha512"})},
                {"id": "c2", "type": "otp", "createdDate": 1_757_100_000_000, "secretData": HASH_SENTINEL},
            ] if U1 in p else [])
        if p.endswith("/sessions"):
            return self._json(200, [{"id": "s1", "lastAccess": 1_758_000_000_000, "ipAddress": "100.1.2.3"}]
                              if U1 in p else [])
        return self._json(404, {})


kc = ThreadingHTTPServer(("127.0.0.1", 0), FakeKC)
threading.Thread(target=kc.serve_forever, daemon=True).start()
os.environ["KEYCLOAK_URL"] = f"http://127.0.0.1:{kc.server_address[1]}"

import admin  # noqa: E402
import app  # noqa: E402

srv = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}"


def get(path: str, headers: dict | None = None, method: str = "GET"):
    req = urllib.request.Request(BASE + path, method=method,
                                 headers={"X-Auth-Request-Email": "op@example.com", **(headers or {})},
                                 data=b"{}" if method == "POST" else None)
    if method == "POST":
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def admin_log() -> list[str]:
    try:
        return open(os.environ["ADMIN_AUDIT_LOG"]).read().splitlines()
    except FileNotFoundError:
        return []


# ── users ───────────────────────────────────────────────────────────────────
print("── users: allow-listed, and the secret goes to one place only ───")
st, body = get("/admin/users")
ok(st == 200 and body.get("ok") is True, f"200 ok ({st})")
users = {u["username"]: u for u in body.get("users", [])}
ok(set(users) == {"devssh", "viewer-only"}, f"the non-UUID user is skipped: {sorted(users)}")
d = users.get("devssh", {})
ok(set(d) == {"id", "username", "email", "enabled", "emailVerified", "createdAt", "requiredActions", "roles",
              "otherRoles", "credentials", "passwordSetAt", "otp", "sessions", "lastSeenAt"},
   f"exactly the allow-listed fields: {sorted(d)}")
ok(d.get("roles") == ["viewer", "editor", "operator"] and d.get("otherRoles") == ["default-roles-devbox"],
   "the four roles are split from Keycloak's own")
ok(d.get("otp") is True and d.get("sessions") == 1
   and d.get("passwordSetAt") == time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(1_757_000_000)),
   "password age, OTP and sessions are read")
ok(users.get("viewer-only", {}).get("requiredActions") == ["UPDATE_PASSWORD"], "required actions are passed")
raw = json.dumps(body)
ok(HASH_SENTINEL not in raw and "SALTSENTINEL" not in raw and "pbkdf2" not in raw and "100.1.2.3" not in raw,
   "no credential data, attribute or session IP is copied")
ok(SECRET not in raw, "the client secret is not in the response")
ok(not any("clients" in p for _, p, _ in SEEN), "a non-UUID id never reached a URL")
posts = [b for m, _, b in SEEN if m == "POST"]
ok(len(posts) == 1 and SECRET in posts[0], "the secret was sent once, in the token request body")
ok(not any(SECRET in p for _, p, _ in SEEN), "the secret never appears in a request path")
before = len([x for x in SEEN if x[0] == "POST"])
get("/admin/users")
ok(len([x for x in SEEN if x[0] == "POST"]) == before, "the token is cached across requests")
ok(all(SECRET not in ln for ln in admin_log()), "the secret is in no audit line")

print()
print("── refusals reach nothing ───────────────────────────────────────")
n = len(SEEN)
for path, want in (("/admin/nope", 404), ("/admin/users?max=9999", 400), ("/admin/credentials?x=1", 400),
                   ("/admin/audit?log=all&log=ops", 400), ("/admin/audit?limit=500", 400),
                   ("/admin/audit?log=../../etc", 400), ("/admin/audit?who=" + "x" * 300, 400),
                   ("/admin/audit?bogus=1", 400)):
    st, b = get(path)
    ok(st == want and "error" in b, f"{path[:48]} -> {want} ({st})")
st, _ = get("/admin/users", {"Sec-Fetch-Site": "cross-site"})
ok(st == 403, f"cross-site GET -> 403 ({st})")
st, _ = get("/admin/users", method="POST")
ok(st == 404, f"POST /admin/users -> 404 ({st}); the service has no admin POST")
ok(len(SEEN) == n, f"zero requests reached Keycloak during refusals ({len(SEEN) - n})")
refused = [ln for ln in admin_log() if "\tREFUSED\t" in ln]
ok(len(refused) >= 9, f"each refusal wrote an audit line ({len(refused)})")

print()
print("── failure modes are 503 or 502, and say what to do ─────────────")
admin._token.update(value=None, exp=0.0, secret=None)
MODE["token"] = 401
st, b = get("/admin/users")
ok(st == 502 and "admin-client" in b.get("error", ""), f"Keycloak refusing the client -> 502 ({st} {b})")
MODE["token"] = 200
MODE["users"] = 403
st, b = get("/admin/users")
ok(st == 502 and "view-users" in b.get("error", ""), f"Keycloak refusing the admin call -> 502 naming view-users ({st})")
MODE["users"] = 200
os.rename(SECRET_FILE, SECRET_FILE + ".away")
admin._token.update(value=None, exp=0.0, secret=None)
st, b = get("/admin/users")
ok(st == 503 and "just admin-client" in b.get("error", ""), f"no secret file -> 503 with the command ({st})")
os.rename(SECRET_FILE + ".away", SECRET_FILE)
saved = admin.KEYCLOAK_URL
admin.KEYCLOAK_URL = ""
st, b = get("/admin/users")
ok(st == 503 and "KEYCLOAK_URL" in b.get("error", ""), f"no KEYCLOAK_URL -> 503 ({st})")
admin.KEYCLOAK_URL = "http://127.0.0.1:9"  # nothing listens on discard
admin._token.update(value=None, exp=0.0, secret=None)
st, b = get("/admin/users")
ok(st == 503 and "cannot reach" in b.get("error", ""), f"Keycloak down -> 503 ({st})")
admin.KEYCLOAK_URL = saved
ok(all(SECRET not in ln for ln in admin_log()), "still no secret in any audit line")

print()
print("── inventory: absent, stale, served ─────────────────────────────")
st, b = get("/admin/credentials")
ok(st == 503 and "just admin-inventory" in b.get("error", ""), f"absent -> 503 with the command ({st})")
st, b = get("/admin/backups")
ok(st == 503, f"backups absent -> 503 ({st})")
inv = os.environ["INVENTORY_FILE"]
os.makedirs(os.path.dirname(inv))
with open(inv, "w") as fh:
    json.dump({"version": 1, "generatedAt": "2026-09-17T08:00:00Z",
               "credentials": {"env": {"path": ".env", "present": True, "mode": "600", "expectMode": "600",
                                       "keys": [{"key": "POSTGRES_PASSWORD", "set": True, "credential": True,
                                                 "placeholder": False, "usedBy": ["auth/compose.yml"],
                                                 "purpose": "p", "rotate": "r"}]},
                               "files": [], "clients": []},
               "backups": {"root": "~/backups", "present": True, "keep": 14, "command": "just backup",
                           "timer": {"unit": "stacks-backup.timer", "active": "active"},
                           "sets": [{"name": "env", "count": 2, "bytes": 10,
                                     "newest": {"name": "env-1", "at": "2026-09-17T00:00:00Z", "bytes": 5}}]}}, fh)
st, b = get("/admin/credentials")
ok(st == 200 and b["env"]["keys"][0]["key"] == "POSTGRES_PASSWORD" and b["stale"] is False,
   f"served, fresh ({st})")
old = time.time() - 3600
os.utime(inv, (old, old))
st, b = get("/admin/backups")
ok(st == 200 and b["stale"] is True and b["sets"][0]["newest"]["name"] == "env-1", f"an hour old -> stale ({st})")
with open(inv, "w") as fh:
    fh.write('{"version": 2}')
st, b = get("/admin/credentials")
ok(st == 502 and "unknown shape" in b.get("error", ""), f"an unknown version -> 502 ({st})")

print()
print("── audit: four logs, filtered and paged ─────────────────────────")
with open(os.environ["AUDIT_LOG"], "w") as fh:
    fh.write("2026-09-17T08:00:01Z\ta@x\tACTED\trestart\tgrafana\trunning -> running\t381ms\n")
    fh.write("2026-09-17T08:00:02Z\tb@x\tREFUSED\tstop\ttraefik\tthe request arrived through Traefik\n")
    fh.write('2026-09-17T08:00:03Z\ta@x\tACTED\tscale\tthales-dev/api\t{"replicas":2}\t120ms\n')
    fh.write("not a record\n")
with open(os.environ["FILES_AUDIT_LOG"], "w") as fh:
    fh.write("2026-09-17T08:00:04Z\ta@x\tWROTE\tstacks/README.md   12 bytes\n")
    fh.write("2026-09-17T08:00:05Z\tc@x\tDELETED\tnotes/x.md   53 bytes\n")
with open(os.environ["CONFIG_AUDIT_LOG"], "w") as fh:
    fh.write("2026-09-17T08:00:06Z\ta@x\tPATCHED\tstacks/edge/compose.yml\ttraefik\tdev.portal.project\t'A' -> 'B'\n")
st, b = get("/admin/audit?limit=200")
ents = b.get("entries", [])
ours = [e for e in ents if e["log"] != "admin"]
ok(st == 200 and len(ours) == 6, f"six records from three logs ({st}, {len(ours)})")
ok(b.get("skipped") == 1, f"the malformed line is skipped and counted ({b.get('skipped')})")
ok([e["at"] for e in ents] == sorted((e["at"] for e in ents), reverse=True), "newest first")
by_at = {e["at"]: e for e in ours}
ok(by_at["2026-09-17T08:00:01Z"]["tookMs"] == 381 and by_at["2026-09-17T08:00:01Z"]["kind"] == "container",
   "a container line: took parsed, kind container")
ok(by_at["2026-09-17T08:00:03Z"]["kind"] == "kube" and by_at["2026-09-17T08:00:03Z"]["target"] == "thales-dev/api",
   "a kube line is told apart by its JSON field")
ok(by_at["2026-09-17T08:00:04Z"]["target"] == "stacks/README.md" and by_at["2026-09-17T08:00:04Z"]["action"] == "write",
   "a file write: path and action")
ok(by_at["2026-09-17T08:00:05Z"]["action"] == "delete", "a file delete")
ok(by_at["2026-09-17T08:00:06Z"]["action"] == "patch" and "dev.portal.project" in by_at["2026-09-17T08:00:06Z"]["detail"],
   "a config patch: field and change in detail")
st, b = get("/admin/audit?log=ops&who=A%40X")
ok(st == 200 and b["total"] == 2 and all(e["who"] == "a@x" for e in b["entries"]),
   f"log + who filter, case-insensitive ({b.get('total')})")
st, b = get("/admin/audit?log=ops&outcome=refused")
ok(st == 200 and [e["target"] for e in b["entries"]] == ["traefik"], "outcome filter")
st, b = get("/admin/audit?action=write&log=files")
ok(st == 200 and b["total"] == 1, "action filter")
st, b = get("/admin/audit?log=ops&limit=1&offset=1")
ok(st == 200 and b["total"] == 3 and len(b["entries"]) == 1 and b["entries"][0]["action"] == "stop", "paging")
ok("REFUSED" in b["facets"]["outcome"] and "a@x" in b["facets"]["who"], "facets for the filter menus")
saved_max = admin.MAX_AUDIT_BYTES
admin.MAX_AUDIT_BYTES = 120
st, b = get("/admin/audit?log=ops")
ok(st == 200 and b["logs"]["ops"]["truncated"] is True and b["total"] < 3, "a cut window is reported, not hidden")
admin.MAX_AUDIT_BYTES = saved_max

print()
print("── every request left one line ──────────────────────────────────")
lines = admin_log()
reads = [ln for ln in lines if "\tREAD\t" in ln]
ok(len(reads) >= 10, f"READ lines written ({len(reads)})")
ok(all(ln.split("\t")[1] == "op@example.com" for ln in lines), "the actor is the edge's header")

kc.shutdown()
srv.shutdown()
print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("api_admin: all passed")
