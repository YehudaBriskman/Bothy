"""The Admin half of bothy-ops - four READS for the Settings area, and nothing else.

    GET /admin/users         Keycloak users and their realm roles
    GET /admin/credentials   where every credential lives - never a value
    GET /admin/backups       backup sets: newest, count, size
    GET /admin/audit         the four audit logs, filtered and paged

Every one is `operator` at the edge (edge/dynamic/bothy-admin.yml): each says
more than a viewer needs - who the accounts are, where every secret on the box
sits, and who did what. Every request writes one line to /audit/admin.log,
refusals included, and none of them changes anything.

── users: a client that can only look ────────────────────────────────────────

Keycloak's admin REST API, with a client-credentials token for the confidential
client `bothy-admin` (scripts/keycloak-admin-client.sh). Its service account
holds realm-management `view-users` and nothing else: not `view-clients`, which
would let this process read every client secret in the realm, and not
`manage-users`. Keycloak is reached at the address oauth2-proxy uses -
http://<BOX_IP>:8090, the single spelling (auth/compose.yml) - because it lives
on devnet, and this container must never join devnet (SECURITY.md rule 2).

Everything Keycloak returns is copied field by field into an allow-listed shape.
A credential entry keeps `type` and `createdDate` and nothing else, whatever the
API version sends beside them.

── credentials and backups: served, not computed ─────────────────────────────

inventory.py runs ON THE HOST and writes metadata-only JSON; this module reads
that file and re-filters every row to an allow-list of keys. Reading .env or
~/backups here would put every password on the box inside the process that can
already stop the databases. See inventory.py's header.

── audit: append-only TSV, read backwards ────────────────────────────────────

Four logs, all mounted read-only except this service's own: actions.log
(container and cluster actions), admin.log (these reads), and bothy-files'
writes.log and patches.log. Only the last MAX_AUDIT_BYTES of each are read - the
page is about recent history, and a year of writes must not become a 50 MB JSON
answer.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import sys
import threading
import time
from urllib.parse import parse_qsl, urlencode, urlparse

import guard
from bothy_common.audit import AuditLog

ENDPOINTS = ("users", "credentials", "backups", "audit")

LOG = AuditLog(os.environ.get("ADMIN_AUDIT_LOG", "/audit/admin.log"))

KEYCLOAK_URL = os.environ.get("KEYCLOAK_URL", "").rstrip("/")
KEYCLOAK_REALM = os.environ.get("KEYCLOAK_REALM", "devbox")
KEYCLOAK_CLIENT_ID = os.environ.get("KEYCLOAK_CLIENT_ID", "bothy-admin")
KEYCLOAK_SECRET_FILE = os.environ.get("KEYCLOAK_SECRET_FILE", "/secrets/keycloak-admin-client-secret")
KC_TIMEOUT = 10
MAX_USERS = 200

INVENTORY_FILE = os.environ.get("INVENTORY_FILE", "/inventory/inventory.json")
# The timer runs every five minutes; three missed runs is worth saying out loud.
INVENTORY_STALE_S = 15 * 60
MAX_INVENTORY_BYTES = 2 * 1024 * 1024

AUDIT_LOGS = {
    "ops": os.environ.get("AUDIT_LOG", "/audit/actions.log"),
    "admin": os.environ.get("ADMIN_AUDIT_LOG", "/audit/admin.log"),
    "files": os.environ.get("FILES_AUDIT_LOG", "/audit-files/writes.log"),
    "config": os.environ.get("CONFIG_AUDIT_LOG", "/audit-files/patches.log"),
}
MAX_AUDIT_BYTES = 4 * 1024 * 1024
MAX_PAGE = 200

_TS = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_TOOK = re.compile(r"\d+ms")
# A filter value is matched, never interpolated anywhere, but it is still bounded:
# a megabyte of "who" is not a question anybody is asking.
_FILTER = re.compile(r"[\w@.+:/ -]{0,128}")


class AdminError(Exception):
    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


def audit(who: str, outcome: str, endpoint: str, detail: str = "", took_ms: int | None = None) -> None:
    """time  who  READ|REFUSED|FAILED|ERROR  admin-<endpoint>  [detail]  [Nms]"""
    fields: list[object] = [who, outcome, f"admin-{endpoint}"]
    if detail:
        fields.append(detail)
    if took_ms is not None:
        fields.append(f"{took_ms}ms")
    LOG.write(*fields)


def _iso(ms: object) -> str | None:
    if not isinstance(ms, (int, float)) or ms <= 0:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ms / 1000))


# ══ users ════════════════════════════════════════════════════════════════════

_token_lock = threading.Lock()
_token: dict = {"value": None, "exp": 0.0, "secret": None}


def _secret() -> str:
    # Re-read per token fetch, so --rotate needs no restart.
    try:
        with open(KEYCLOAK_SECRET_FILE, encoding="utf-8") as fh:
            s = fh.read().strip()
    except FileNotFoundError:
        raise AdminError("users unavailable - no Keycloak admin client secret on this box; "
                         "run `just admin-client`", status=503) from None
    except OSError as e:
        raise AdminError(f"users unavailable - the client secret is unreadable ({type(e).__name__})",
                         status=503) from None
    if not s:
        raise AdminError("users unavailable - the client secret file is empty", status=503)
    return s


def _kc(method: str, path: str, body: bytes | None = None, headers: dict | None = None) -> tuple[int, bytes]:
    if not KEYCLOAK_URL:
        raise AdminError("users unavailable - KEYCLOAK_URL is not configured "
                         "(apps/bothy-ops/compose.admin.yml sets it)", status=503)
    u = urlparse(KEYCLOAK_URL)
    if u.scheme != "http" or not u.hostname:
        raise AdminError("users unavailable - KEYCLOAK_URL must be http://host:port", status=503)
    conn = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=KC_TIMEOUT)
    try:
        conn.request(method, path, body=body, headers={"Accept": "application/json", **(headers or {})})
        r = conn.getresponse()
        return r.status, r.read(4 * 1024 * 1024)
    except (OSError, http.client.HTTPException) as e:
        raise AdminError(f"users unavailable - cannot reach Keycloak ({type(e).__name__})", status=503) from None
    finally:
        conn.close()


def _access_token() -> str:
    secret = _secret()
    with _token_lock:
        if _token["value"] and _token["secret"] == secret and time.time() < _token["exp"]:
            return _token["value"]
        form = urlencode({"grant_type": "client_credentials", "client_id": KEYCLOAK_CLIENT_ID,
                          "client_secret": secret}).encode()
        status, raw = _kc("POST", f"/realms/{KEYCLOAK_REALM}/protocol/openid-connect/token", form,
                          {"Content-Type": "application/x-www-form-urlencoded"})
        if status != 200:
            # Keycloak's error body can echo the client id; it never echoes the
            # secret, but it is not forwarded anyway - the status is the message.
            raise AdminError(f"Keycloak refused client {KEYCLOAK_CLIENT_ID} ({status}) - "
                             "re-run `just admin-client`", status=502)
        try:
            j = json.loads(raw)
            tok, ttl = str(j["access_token"]), int(j.get("expires_in", 60))
        except (ValueError, KeyError, TypeError):
            raise AdminError("Keycloak's token answer was not understood", status=502) from None
        _token.update(value=tok, exp=time.time() + max(5, ttl - 30), secret=secret)
        return tok


def _kc_json(path: str) -> object:
    tok = _access_token()
    status, raw = _kc("GET", f"/admin/realms/{KEYCLOAK_REALM}{path}", None,
                      {"Authorization": f"Bearer {tok}"})
    if status == 401:
        with _token_lock:
            _token["value"] = None
    if status in (401, 403):
        raise AdminError(f"Keycloak refused the admin client on {path.split('?')[0]} ({status}) - "
                         "it needs realm-management view-users; re-run `just admin-client`", status=502)
    if status != 200:
        raise AdminError(f"Keycloak answered {status} on {path.split('?')[0]}", status=502)
    try:
        return json.loads(raw)
    except ValueError:
        raise AdminError("Keycloak answered something that is not JSON", status=502) from None


ROLES = ("viewer", "editor", "operator", "shell")


def _user(u: dict) -> dict | None:
    uid = u.get("id")
    if not isinstance(uid, str) or not _UUID.fullmatch(uid):
        return None  # never interpolated into a URL unless it is exactly a UUID
    mapped = _kc_json(f"/users/{uid}/role-mappings/realm")
    realm_roles = sorted(str(r.get("name")) for r in mapped if isinstance(r, dict) and r.get("name")) \
        if isinstance(mapped, list) else []
    creds = _kc_json(f"/users/{uid}/credentials")
    creds = creds if isinstance(creds, list) else []
    pw = [c.get("createdDate") for c in creds if isinstance(c, dict) and c.get("type") == "password"]
    sessions = _kc_json(f"/users/{uid}/sessions")
    sessions = sessions if isinstance(sessions, list) else []
    last = max((s.get("lastAccess") or 0 for s in sessions if isinstance(s, dict)), default=0)
    return {
        "id": uid,
        "username": str(u.get("username") or ""),
        "email": str(u.get("email") or "") or None,
        "enabled": bool(u.get("enabled")),
        "emailVerified": bool(u.get("emailVerified")),
        "createdAt": _iso(u.get("createdTimestamp")),
        "requiredActions": [str(a) for a in (u.get("requiredActions") or []) if isinstance(a, str)],
        "roles": [r for r in ROLES if r in realm_roles],
        "otherRoles": [r for r in realm_roles if r not in ROLES],
        # Allow-listed down to the two facts the page shows. A credential
        # representation may carry credentialData / secretData depending on the
        # Keycloak version; neither is ever copied.
        "credentials": sorted({str(c.get("type")) for c in creds if isinstance(c, dict) and c.get("type")}),
        "passwordSetAt": _iso(max((p for p in pw if isinstance(p, (int, float))), default=0)),
        "otp": any(isinstance(c, dict) and c.get("type") == "otp" for c in creds),
        "sessions": len(sessions),
        "lastSeenAt": _iso(last),
    }


def users() -> dict:
    raw = _kc_json(f"/users?{urlencode({'first': 0, 'max': MAX_USERS + 1, 'briefRepresentation': 'false'})}")
    if not isinstance(raw, list):
        raise AdminError("Keycloak's user list was not a list", status=502)
    out = [x for x in (_user(u) for u in raw[:MAX_USERS] if isinstance(u, dict)) if x]
    return {"realm": KEYCLOAK_REALM, "client": KEYCLOAK_CLIENT_ID, "fetchedAt": _iso(time.time() * 1000),
            "truncated": len(raw) > MAX_USERS, "users": sorted(out, key=lambda x: x["username"])}


# ══ credentials and backups (the host inventory) ══════════════════════════════

# The second lock. Whatever inventory.py writes, only these keys are served.
ENV_KEY_FIELDS = ("key", "set", "credential", "placeholder", "usedBy", "purpose", "rotate")
FILE_FIELDS = ("id", "path", "purpose", "usedBy", "rotate", "present", "expectMode", "actualMode",
               "changed", "bytes", "error")
CLIENT_FIELDS = ("id", "purpose", "realm", "where", "set", "changed", "changedScope")
ENV_FIELDS = ("path", "present", "mode", "expectMode", "changed", "bytes", "error")
BACKUP_FIELDS = ("root", "present", "keep", "command", "error")
TIMER_FIELDS = ("unit", "active", "last", "next")
SET_FIELDS = ("name", "managed", "what", "readable", "mode", "count", "bytes", "newest", "oldest")
POINT_FIELDS = ("name", "at", "bytes")


def _pick(d: object, keys: tuple[str, ...]) -> dict:
    if not isinstance(d, dict):
        return {}
    out = {}
    for k in keys:
        if k in d:
            v = d[k]
            # Scalars and lists of strings only - a nested object smuggled into
            # an allowed key is dropped rather than passed through.
            if isinstance(v, (str, int, float, bool)) or v is None:
                out[k] = v
            elif isinstance(v, list):
                out[k] = [x for x in v if isinstance(x, str)]
    return out


def _inventory() -> tuple[dict, dict]:
    try:
        st = os.stat(INVENTORY_FILE)
        if st.st_size > MAX_INVENTORY_BYTES:
            raise AdminError("the inventory file is implausibly large - refusing to serve it", status=502)
        with open(INVENTORY_FILE, encoding="utf-8") as fh:
            doc = json.load(fh)
    except FileNotFoundError:
        raise AdminError("inventory not generated yet - run `just admin-inventory` on the host "
                         "(host/systemd/bothy-inventory.timer keeps it fresh)", status=503) from None
    except (OSError, ValueError) as e:
        raise AdminError(f"the inventory file could not be read ({type(e).__name__})", status=502) from None
    if not isinstance(doc, dict) or doc.get("version") != 1:
        raise AdminError("the inventory file has an unknown shape - regenerate it", status=502)
    age = max(0, int(time.time() - st.st_mtime))
    meta = {"generatedAt": doc.get("generatedAt") if isinstance(doc.get("generatedAt"), str) else None,
            "ageSeconds": age, "stale": age > INVENTORY_STALE_S}
    return doc, meta


def credentials() -> dict:
    doc, meta = _inventory()
    c = doc.get("credentials") if isinstance(doc.get("credentials"), dict) else {}
    env = c.get("env") if isinstance(c.get("env"), dict) else {}
    return {
        **meta,
        "env": {**_pick(env, ENV_FIELDS),
                "keys": [_pick(k, ENV_KEY_FIELDS) for k in env.get("keys", []) if isinstance(k, dict)]},
        "files": [_pick(f, FILE_FIELDS) for f in c.get("files", []) if isinstance(f, dict)],
        "clients": [_pick(x, CLIENT_FIELDS) for x in c.get("clients", []) if isinstance(x, dict)],
    }


def backups() -> dict:
    doc, meta = _inventory()
    b = doc.get("backups") if isinstance(doc.get("backups"), dict) else {}
    sets = []
    for s in b.get("sets", []):
        if not isinstance(s, dict):
            continue
        row = _pick(s, SET_FIELDS)
        for k in ("newest", "oldest"):
            if isinstance(s.get(k), dict):
                row[k] = _pick(s[k], POINT_FIELDS)
        sets.append(row)
    return {**meta, **_pick(b, BACKUP_FIELDS), "timer": _pick(b.get("timer"), TIMER_FIELDS), "sets": sets}


# ══ audit ══════════════════════════════════════════════════════════════════════

def _tail(path: str) -> tuple[list[str], bool]:
    """The last MAX_AUDIT_BYTES of a log as lines, and whether it was cut."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            start = max(0, size - MAX_AUDIT_BYTES)
            fh.seek(start)
            data = fh.read()
    except FileNotFoundError:
        return [], False
    lines = data.decode("utf-8", "replace").split("\n")
    if start > 0 and lines:
        lines = lines[1:]  # the first is a fragment of a line cut in half
    return [ln for ln in lines if ln], start > 0


def parse_line(log: str, line: str) -> dict | None:
    """One TSV record into {at, who, outcome, action, target, detail, tookMs, log}."""
    f = line.split("\t")
    if len(f) < 3 or not _TS.fullmatch(f[0]):
        return None
    at, who, outcome = f[0], f[1], f[2]
    rest = f[3:]
    took = None
    if rest and _TOOK.fullmatch(rest[-1]):
        took = int(rest[-1][:-2])
        rest = rest[:-1]
    if log == "files":
        # time  who  WROTE|DELETED|NOSNAPSHOT|DELETE-REFUSED  root/path   N bytes[   extra]
        body = rest[0] if rest else ""
        target, _, detail = body.partition("   ")
        action = "delete" if outcome.startswith("DELETE") else "write"
        return {"log": log, "at": at, "who": who, "outcome": outcome, "action": action,
                "target": target, "detail": detail.strip(), "tookMs": took}
    if log == "config":
        # time  who  PATCHED|NOSNAPSHOT  root/relpath  service  field  ['old' -> 'new']
        target = rest[0] if rest else ""
        detail = " · ".join(x for x in rest[1:] if x)
        return {"log": log, "at": at, "who": who, "outcome": outcome, "action": "patch",
                "target": target, "detail": detail, "tookMs": took}
    if log == "admin":
        # time  who  READ|REFUSED|FAILED|ERROR  admin-<endpoint>  [detail]
        return {"log": log, "kind": "admin", "at": at, "who": who, "outcome": outcome,
                "action": rest[0] if rest else "", "target": "",
                "detail": " · ".join(x for x in rest[1:] if x), "tookMs": took}
    # ops: time  who  OUTCOME  action  target  [detail...]
    action = rest[0] if rest else ""
    target = rest[1] if len(rest) > 1 else ""
    detail = " · ".join(x for x in rest[2:] if x)
    kind = "kube" if len(rest) > 2 and rest[2].startswith("{") else "container"
    return {"log": log, "kind": kind, "at": at, "who": who, "outcome": outcome, "action": action,
            "target": target, "detail": detail, "tookMs": took}


def audit_page(q: dict) -> dict:
    allowed = {"log", "who", "outcome", "action", "offset", "limit"}
    for k in q:
        if k not in allowed:
            raise guard.Refused(f"unknown parameter {k[:40]!r} - allowed: {', '.join(sorted(allowed))}", status=400)
    log = q.get("log", "all")
    if log != "all" and log not in AUDIT_LOGS:
        raise guard.Refused(f"log must be all or one of {', '.join(AUDIT_LOGS)}", status=400)
    for k in ("who", "outcome", "action"):
        if not _FILTER.fullmatch(q.get(k, "")):
            raise guard.Refused(f"{k} must be at most 128 plain characters", status=400)
    try:
        offset = int(q.get("offset", "0"))
        limit = int(q.get("limit", "50"))
    except ValueError:
        raise guard.Refused("offset and limit must be integers", status=400) from None
    if offset < 0 or not 1 <= limit <= MAX_PAGE:
        raise guard.Refused(f"offset must be >= 0 and limit 1..{MAX_PAGE}", status=400)

    entries: list[dict] = []
    logs = {}
    skipped = 0
    for name, path in AUDIT_LOGS.items():
        if log != "all" and name != log:
            continue
        lines, cut = _tail(path)
        present = os.path.exists(path)
        logs[name] = {"present": present, "truncated": cut, "lines": len(lines)}
        for ln in lines:
            e = parse_line(name, ln)
            if e is None:
                skipped += 1
            else:
                entries.append(e)
    # Newest first. The timestamps are fixed-width UTC, so a string sort is a time
    # sort; the index keeps lines written in the same second in file order.
    entries = [e for _, e in sorted(enumerate(entries), key=lambda p: (p[1]["at"], p[0]), reverse=True)]

    facets = {
        "who": sorted({e["who"] for e in entries})[:50],
        "outcome": sorted({e["outcome"] for e in entries}),
        "action": sorted({e["action"] for e in entries if e["action"]})[:100],
    }
    who, outcome, action = q.get("who", "").lower(), q.get("outcome", ""), q.get("action", "")
    if who:
        entries = [e for e in entries if who in e["who"].lower()]
    if outcome:
        entries = [e for e in entries if e["outcome"].lower() == outcome.lower()]
    if action:
        entries = [e for e in entries if e["action"] == action]
    return {"total": len(entries), "offset": offset, "limit": limit, "skipped": skipped,
            "logs": logs, "facets": facets, "entries": entries[offset:offset + limit]}


# ══ the handler ════════════════════════════════════════════════════════════════

def handle(h, endpoint: str) -> None:
    """GET /admin/<endpoint>. `h` is the bothy-ops JsonHandler."""
    who = h.actor()
    t0 = time.monotonic()
    ep = endpoint[:32]
    try:
        h.check_csrf("GET")
        if endpoint not in ENDPOINTS:
            raise guard.Refused("no such endpoint", status=404)
        u = urlparse(h.path)
        try:
            pairs = parse_qsl(u.query, keep_blank_values=True, max_num_fields=16)
        except ValueError:
            raise guard.Refused("too many query parameters", status=400) from None
        q: dict[str, str] = {}
        for k, v in pairs:
            if k in q:
                raise guard.Refused(f"parameter {k[:40]!r} given twice", status=400)
            q[k] = v
        if endpoint != "audit" and q:
            raise guard.Refused(f"/admin/{endpoint} takes no parameters", status=400)

        if endpoint == "users":
            result = users()
            detail = f"{len(result['users'])} users"
        elif endpoint == "credentials":
            result = credentials()
            detail = f"{len(result['env']['keys'])} keys, {len(result['files'])} files"
        elif endpoint == "backups":
            result = backups()
            detail = f"{len(result['sets'])} sets"
        else:
            result = audit_page(q)
            detail = json.dumps({k: q[k] for k in sorted(q)}, separators=(",", ":")) if q else ""
        audit(who, "READ", ep, detail, int((time.monotonic() - t0) * 1000))
        return h._send(200, {"ok": True, **result})
    except guard.Refused as e:
        audit(who, "REFUSED", ep, str(e)[:200], int((time.monotonic() - t0) * 1000))
        return h._send(e.status, {"error": str(e)})
    except AdminError as e:
        audit(who, "FAILED", ep, str(e)[:200], int((time.monotonic() - t0) * 1000))
        return h._send(e.status, {"error": str(e)})
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"ERROR /admin/{ep}: {type(e).__name__}: {e}\n")
        audit(who, "ERROR", ep, type(e).__name__)
        return h._send(500, {"error": "internal error"})
