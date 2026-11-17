"""GET /-/api/v1/* - the one control plane's network API, slice 1: READ-ONLY.

docs/plans/thin-bothy/cli-and-control-plane.md sections 1.3, 1.6 and 6. The eight operations and
the discover endpoint are declared in operations.toml and nowhere else; this file is the thin
ADAPTER layer under them. It plans nothing and decides nothing about updates: every answer is
what updates.py (the allow-listed read of what the host wrote) already serves, wrapped in the
envelope. Where an op adds a fact it says so (update.plan's `scope`, the own-code `unreleased`).

── the envelope ─────────────────────────────────────────────────────────────

    {"ok": true,  "request_id": "r_<16 hex>", "data": {...}, "warnings": []}
    {"ok": false, "request_id": "r_<16 hex>", "error": {"code", "message", "details", "hint"}}

and on every answer the headers  Bothy-Server: <version> api=1 min-client=<x>  and  X-Request-Id.

── error codes (stable, dotted, never reworded) ─────────────────────────────

    auth.unauthenticated 401   auth.forbidden 403        request.invalid 400
    request.not-found 404      unavailable.source 503    internal.error 500

The first two and the dotted style are the plan's (1.3). The last four are NEW in slice 1: the
plan's list had no code for a malformed query, an unknown id, an unwired data source or a bug.

── authorisation: where it is and where it is not ───────────────────────────

Like every bothy-ops route, role gating is the EDGE's (a router with sso-viewer); this process
authenticates nobody and reachability is authorisation (SECURITY.md rule 2). What this layer
adds, because the plan's T3 asks for it and a router can be mis-edited: (1) EVERY method but GET
on /v1/* is refused auth.forbidden, whatever the path, role or body, before the path is even
looked up - there is no write route to find, in the catalog or here; (2) every request becomes a
`Caller` (caller.py, decision D41), an op whose `exposure` (decision D42) does not list the Caller's
kind is refused auth.forbidden, and so is one whose role the Caller does not hold (a bearer token is verified
against tokenstore.py, D43; with no store configured every bearer is auth.unauthenticated, and a token is
also held to its record's op allow-list and client kind); (3) CSRF on a GET is the same
Sec-Fetch-Site rule as every route.

── what no field here may be ────────────────────────────────────────────────

A secret VALUE (settings.get reads metadata only), and a string that carries third-party text
untyped: opscatalog.wrap_untrusted types exactly the fields the schema marks, opscatalog.sanitize
strips control characters and ANSI escapes from every string, here, at the boundary.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import time
import types
from urllib.parse import urlparse

import caller as callers
import opscatalog
import updates
from bothy_common.http import Refused

HERE = os.path.dirname(os.path.abspath(__file__))
PREFIX = "/-/api"          # Traefik strips this (bothy-ops-strip); the catalog states the public path

CATALOG: dict | None = None
# The settings reader: anything with get_meta(module, key) -> an object with .module .key .is_secret
# .set .version .updated_at .updated_by .fingerprint and, for a NON-secret, .value (this is
# bothy_settings.Store). NOT wired in slice 1: the service holds neither the master key nor the state
# directory, and the plan gives decryption to the host alone. Unwired -> unavailable.source, said
# out loud, rather than an empty answer that reads as "no such setting".
SETTINGS = None

new_request_id = lambda: "r_" + secrets.token_hex(8)  # noqa: E731  (a check pins it)


class ApiError(Exception):
    def __init__(self, code: str, status: int, message: str, details: dict | None = None, hint: str | None = None):
        super().__init__(message)
        self.code, self.status, self.message = code, status, message
        self.details, self.hint = details or {}, hint


def load() -> dict:
    global CATALOG
    CATALOG = opscatalog.load()
    return CATALOG


def set_settings_reader(reader) -> None:
    global SETTINGS
    SETTINGS = reader


def server_version() -> str:
    v = os.environ.get("BOTHY_VERSION")
    if v:
        return v.strip()[:40]
    for p in (os.path.join(HERE, "VERSION"), os.path.join(HERE, os.pardir, os.pardir, "VERSION")):
        try:
            with open(p, encoding="utf-8") as fh:
                return fh.read().strip()[:40]
        except OSError:
            continue
    return "unknown"


# ── the adapters: one function per op, over code that already exists ─────────

def _need_updates() -> None:
    if updates.CATALOG is None:
        raise ApiError("unavailable.source", 503, "the update catalog is not loaded")


def _refusal(e: Refused) -> ApiError:
    code = {400: "request.invalid", 404: "request.not-found", 403: "auth.forbidden"}.get(e.status)
    if code is None:
        return ApiError("unavailable.source" if e.status in (502, 503) else "internal.error", e.status, str(e))
    return ApiError(code, e.status, str(e))


def _shim(path: str) -> types.SimpleNamespace:
    """What plan_read / job_read take: only `.path` is read, to find the one parameter."""
    return types.SimpleNamespace(path=path)


def op_status(caller: callers.Caller, _p: dict) -> dict:
    _need_updates()
    st = updates.status(updates.CATALOG)
    s = st["summary"]
    attention = []
    for cid, p in sorted(updates._auto_state()["paused"].items()):
        attention.append({"kind": "paused", "component": cid, "detail": p["reason"]})
    for r in st["components"]:
        d = r["discovered"]
        if d and d["error"]:
            attention.append({"kind": "discovery-error", "component": r["id"], "detail": d["error"]})
    seen: set[str] = set()
    for j in st["history"]:                       # newest first: only a component's LATEST job counts
        if j["component"] in seen:
            continue
        seen.add(j["component"])
        if j["state"] in ("failed", "rolled_back", "aborted"):
            attention.append({"kind": "update-failed", "component": j["component"], "detail": j["error"]})
    job = st["job"]
    return {"server": {"version": server_version(), "apiVersion": CATALOG["api"]["version"]},
            "updates": {k: s[k] for k in ("components", "updates", "behind", "drift", "toApply", "configDrift",
                                          "groups")} | {"errors": s["errors"]},
            "discovery": st["discovery"], "applying": st["applying"],
            "job": {"id": job["id"], "component": job["component"], "state": job["state"],
                    "error": job["error"]} if job else None,
            "needsAttention": attention[:50]}


def op_module_list(caller: callers.Caller, _p: dict) -> dict:
    _need_updates()
    by: dict[str, list] = {}
    for c in updates.CATALOG.components.values():
        by.setdefault(c.apply, []).append(c)
    mods = []
    for recipe, comps in sorted(by.items()):
        name = recipe.split(" ", 1)[-1]
        mods.append({"id": name[3:] if name.startswith("up-") else name, "recipe": recipe,
                     "runtime": "k3s" if all(c.cls == "cluster" for c in comps) else "compose",
                     "components": sorted(c.id for c in comps)})
    return {"source": "update-catalog", "modules": mods}


def op_update_status(caller: callers.Caller, _p: dict) -> dict:
    _need_updates()
    return updates.status(updates.CATALOG)


# The riskiest wins (doc 4.5: "its class is the union of its members'"). Only classes a group can
# hold are ranked: groups.py refuses cluster, own-code and boundary members.
_CLASS_RISK = ("stateless", "timeseries", "app-db", "database")


def _scope(cid: str, component_plan: dict | None) -> dict | None:
    """The structured `scope.group-available` refusal of doc 4.5, or None.

    Present exactly when the HOST would refuse to apply `cid` alone because its compose recipe also
    recreates other services, AND a deployable group plan exists that carries all of them - the same
    fact the page draws as "apply it with its group" (status rows' `applyWithGroup`). Built from the
    group plan the host wrote; nothing is recomputed here.
    """
    if component_plan is None:
        return None
    for g in updates._group_rows(updates.CATALOG):
        if not g["deployable"] or cid not in g["candidates"]:
            continue
        gp = g["plan"]
        others = sorted(m["component"] for m in gp["members"] if m["component"] != cid)
        classes = [m["class"] for m in gp["members"] if m["class"] in _CLASS_RISK]
        return {
            "code": "scope.group-available",
            "message": f"Applying {cid} would also recreate {' and '.join(others)} (same compose recipe).",
            "details": {"component": cid, "recipe": gp["recipe"], "would_recreate": others, "group": g["group"],
                        "group_class": max(classes, key=_CLASS_RISK.index) if classes else "stateless",
                        "group_confirm": gp["confirm"], "group_plan_id": gp["id"], "rollback": "all-or-nothing"},
            "hint": f"bothy update plan --group {g['group']}"}
    return None


def op_update_plan(caller: callers.Caller, p: dict) -> dict:
    _need_updates()
    try:
        if "group" in p:
            body, _ = updates.group_read(None, p["group"])
            return {"target": "group", **body, "scope": None}
        body, _ = updates.plan_read(_shim(f"/updates/plan?component={p['component']}"))
    except Refused as e:
        raise _refusal(e) from None
    return {"target": "component", **body, "scope": _scope(p["component"], body["plan"])}


def op_update_history(caller: callers.Caller, p: dict) -> dict:
    _need_updates()
    jobs = updates._history(1000)
    if "component" in p:
        jobs = [j for j in jobs if j["component"] == p["component"] or p["component"] in j["members"]]
    return {"jobs": jobs[:p["limit"]]}


def op_job_get(caller: callers.Caller, p: dict) -> dict:
    _need_updates()
    try:
        body, _ = updates.job_read(_shim(f"/updates/job?id={p['id']}"))
    except Refused as e:
        raise _refusal(e) from None
    return body


def _event(j: dict) -> dict:
    return {"id": f"e_{j['id']}_{j['state']}", "ts": j["endedAt"] or j["startedAt"] or j["requestedAt"],
            "type": "job", "component": j["component"], "job_id": j["id"], "state": j["state"], "text": j["error"]}


def op_events_query(caller: callers.Caller, p: dict) -> dict:
    _need_updates()
    evs = [_event(j) for j in reversed(updates._history(1000))]      # oldest first
    start = 0
    if "since" in p:
        ids = [e["id"] for e in evs]
        if p["since"] not in ids:
            raise ApiError("request.invalid", 400, "that cursor is not in the event history (it may have rotated "
                           "out)", {"reason": "cursor-expired"}, "omit `since` to read from the start")
        start = ids.index(p["since"]) + 1
    page = evs[start:start + p["limit"]]
    return {"events": page, "cursor": page[-1]["id"] if page else p.get("since"),
            "more": start + len(page) < len(evs)}


def op_settings_get(caller: callers.Caller, p: dict) -> dict:
    if SETTINGS is None:
        raise ApiError("unavailable.source", 503, "the settings store is not connected to this service",
                       {"slice": 1}, "settings are read on the host: `bothy settings get` (slice 2 wires this route)")
    try:
        m = SETTINGS.get_meta(p["module"], p["key"])
    except Exception as e:  # noqa: BLE001 - by NAME: this module must not import the library (a dependency)
        if type(e).__name__ == "NotFound":
            raise ApiError("request.not-found", 404, f"{p['module']}.{p['key']} is not a registered setting") from None
        raise
    # Explicit fields only, never `vars(m)`: a secret's Meta must not be able to smuggle a value through.
    out = {"module": m.module, "key": m.key, "secret": bool(m.is_secret), "set": bool(m.set),
           "version": m.version, "updated_at": m.updated_at, "updated_by": m.updated_by,
           "fingerprint": m.fingerprint if m.is_secret else None}
    if not m.is_secret and m.set:
        v = m.value
        out["value_type"] = ("null" if v is None else "boolean" if isinstance(v, bool)
                             else "number" if isinstance(v, (int, float)) else "string" if isinstance(v, str)
                             else "object" if isinstance(v, dict) else "array")
        out["value"] = v
    return out


ADAPTERS = {"status": op_status, "module.list": op_module_list, "update.status": op_update_status,
            "update.plan": op_update_plan, "update.history": op_update_history, "job.get": op_job_get,
            "events.query": op_events_query, "settings.get": op_settings_get}


def op_discover(caller: callers.Caller, _p: dict) -> dict:
    cat = CATALOG
    ops = []
    for o in cat["ops"].values():
        ops.append({"id": o["id"], "title": o["title"], "method": o["method"], "path": o["path"], "role": o["role"],
                    "effect": o["effect"], "confirm": o["confirm"], "callers": o["callers"],
                    "idempotent": o["idempotent"], "audit": o["audit"], "cli": o.get("cli", ""),
                    "mcp": o.get("mcp"), "exposure": o["exposure"], "input": o["input"]})
    return {"serverVersion": server_version(), "apiVersion": cat["api"]["version"], "minClient": cat["api"]["min_client"],
            "ops": ops,
            # "A request is a component id from a closed catalog, never a string" (doc 1.3): the closed set,
            # served so a client can complete and refuse before it asks.
            "enums": {"component": sorted(updates.CATALOG.components) if updates.CATALOG else []}}


# ── the request ──────────────────────────────────────────────────────────────

def _send(h, code: int, payload: dict, rid: str) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    h.send_response(code)
    h.send_header("Content-Type", "application/json; charset=utf-8")
    h.send_header("Content-Length", str(len(body)))
    h.send_header("Cache-Control", "no-store")
    h.send_header("X-Content-Type-Options", "nosniff")
    h.send_header("X-Request-Id", rid)
    api = (CATALOG or {}).get("api", {"version": 1, "min_client": "0.0.0"})
    h.send_header("Bothy-Server", f"{server_version()} api={api['version']} min-client={api['min_client']}")
    h.end_headers()
    h.wfile.write(body)


def _error(h, rid: str, e: ApiError, who: str, kind: str, t0: float) -> None:
    _audit(who, "REFUSED" if e.status < 500 else "ERROR", kind, f"{e.code}", t0)
    _send(h, e.status, {"ok": False, "request_id": rid,
                        "error": {"code": e.code, "message": opscatalog.sanitize(e.message),
                                  "details": opscatalog.sanitize_deep(e.details), "hint": e.hint}}, rid)


def _audit(who: str, outcome: str, kind: str, detail: str, t0: float) -> None:
    # `detail` is a code or an id this layer built - never a setting value, never request text.
    updates.LOG.write(who, outcome, kind, detail, f"{int((time.monotonic() - t0) * 1000)}ms")


def resolve_caller(h, op: dict) -> callers.Caller:
    """The Caller for this request, built by an adapter; the role never comes from a request field."""
    try:
        peer = (getattr(h, "client_address", None) or ("-",))[0]
        return callers.from_request(h.headers, op["role"], peer)
    except callers.Unauthenticated as e:
        raise ApiError("auth.unauthenticated", 401, str(e)) from None


def handle(h, method: str) -> None:
    """Every request under /v1/. `h` is bothy-ops' JsonHandler."""
    t0 = time.monotonic()
    rid = new_request_id()
    who = h.actor()
    cat = CATALOG
    if cat is None:
        return _error(h, rid, ApiError("unavailable.source", 503, "the operation catalog is not loaded"), who,
                      "v1.unknown", t0)
    # (1) THE READ-ONLY GATE. First, before the path is looked up: a write to a path that does not
    # exist and a write to one that does get the same answer, so nothing here can be probed.
    if method != "GET":
        return _error(h, rid, ApiError("auth.forbidden", 403, "this API is read-only in this version: no write "
                                       "operation exists", {"method": method}), who, "v1.write-refused", t0)
    url = urlparse(h.path)
    op = cat["routes"].get(PREFIX + url.path)
    if op is None:
        return _error(h, rid, ApiError("request.not-found", 404, "no such operation",
                                       hint="GET /-/api/v1/discover lists them"), who, "v1.unknown", t0)
    kind = op["audit"]
    try:
        try:
            h.check_csrf("GET")
        except Refused as e:
            raise ApiError("auth.forbidden", 403, str(e)) from None
        who_is = resolve_caller(h, op)
        if who_is.kind == "token":
            who = f"token:{who_is.token_id}"        # the audit line names the credential, never its secret
        if who_is.kind not in op["exposure"]:
            raise ApiError("auth.forbidden", 403, "this operation is not offered on this channel",
                           {"channel": who_is.kind, "exposure": op["exposure"]})
        if not opscatalog.role_allows(cat, who_is.role, op["role"]):
            raise ApiError("auth.forbidden", 403, f"this operation needs the {op['role']} role",
                           {"required": op["role"]})
        if who_is.kind == "token":
            # D43: a token reaches an op only if the op is offered to its client kind AND its record
            # lists the op (or "*"). Both are the record's, never a request field's.
            if who_is.token_kind not in op["callers"]:
                raise ApiError("auth.forbidden", 403, "this operation is not offered to this kind of token")
            if "*" not in who_is.scopes and op["id"] not in who_is.scopes:
                raise ApiError("auth.forbidden", 403, "this token is not allowed this operation")
        try:
            params = opscatalog.parse_query(op, url.query)
        except opscatalog.InvalidInput as e:
            raise ApiError("request.invalid", 400, str(e), e.details) from None
        if op["id"] == "discover":
            data = op_discover(who_is, params)
        else:
            data = ADAPTERS[op["id"]](who_is, params)
        data = opscatalog.sanitize_deep(opscatalog.wrap_untrusted(op["output"], data))
        detail = f"{params.get('module')}.{params.get('key')}" if op["id"] == "settings.get" else "ok"
        _audit(who, "READ", kind, detail, t0)
        return _send(h, 200, {"ok": True, "request_id": rid, "data": data, "warnings": []}, rid)
    except ApiError as e:
        return _error(h, rid, e, who, kind, t0)
    except updates.UpdatesError as e:
        return _error(h, rid, ApiError("unavailable.source", e.status, str(e)), who, kind, t0)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"ERROR /v1{url.path}: {type(e).__name__}: {e}\n")
        return _error(h, rid, ApiError("internal.error", 500, "internal error"), who, kind, t0)
