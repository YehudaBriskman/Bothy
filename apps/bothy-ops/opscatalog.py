"""The operation catalog (operations.toml): load it, check it, and everything that is a pure function of it.

Standard library only, and no import of the rest of bothy-ops, so that BOTH the service (v1api.py)
and the generator (scripts/gen-ops-v1.py) read the catalog through the same code and cannot
disagree about what it says. docs/plans/thin-bothy/cli-and-control-plane.md section 1.

What lives here, and nothing else:

  load(path)            parse and VALIDATE: an unknown key, a second method, a write effect, a
                        duplicate path or tool name, or a malformed schema refuses to load - a
                        catalog nobody could review is not served
  parse_query(op, qs)   a query string against an op's `input` table, to typed params or a refusal
  validate(schema, v)   a value against an `output` schema (used by the contract checks)
  wrap_untrusted(...)   the TRUST TYPING: only the schema decides which strings are wrapped
  sanitize(...)         control characters and ANSI escapes, at the API boundary

SLICE 1 IS READ-ONLY. `READ_ONLY_SLICE` is the one switch that says so; the loader refuses any op
whose effect is not `read` or whose method is not GET while it is true, so adding a write op to
the file by accident (or by prompt injection into a PR) is a load error, not a route.
"""

from __future__ import annotations

import json
import os
import re
import tomllib
from urllib.parse import parse_qsl

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG_FILE = os.environ.get("OPERATIONS_CATALOG", os.path.join(HERE, "operations.toml"))

READ_ONLY_SLICE = True

EFFECTS = ("read", "tighten", "loosen", "destructive", "host-only")
CONFIRMS = ("none", "click", "type-name", "host")
CALLERS = ("web", "cli", "mcp", "system")
EXPOSURES = ("socket", "session", "token")     # D42; caller.py names the same closed set
DEFAULT_EXPOSURE = ["socket"]
SCHEMA_TYPES = ("string", "integer", "number", "boolean", "object", "array", "untrusted", "null")
INPUT_TYPES = ("string", "integer", "boolean")

_OP_KEYS = {"title", "http", "role", "effect", "confirm", "callers", "mcp", "cli", "audit", "idempotent",
            "input", "output", "exposure"}
_ENDPOINT_KEYS = _OP_KEYS
_INPUT_KEYS = {"type", "required", "pattern", "enum", "min", "max", "default", "one_of"}
_SCHEMA_KEYS = {"type", "nullable", "required", "properties", "items", "enum", "source"}
_HTTP = re.compile(r"([A-Z]+) (/-/api/v1/[a-z][a-z-]{0,30}(?:/[a-z][a-z-]{0,30}){0,3})")
_OP_ID = re.compile(r"[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*")
_TOOL = re.compile(r"bothy_[a-z][a-z_]{0,60}")
_AUDIT = re.compile(r"v1\.[a-z][a-z0-9.]{0,60}")
_VERSION = re.compile(r"\d{1,5}\.\d{1,5}\.\d{1,5}")


class CatalogError(Exception):
    pass


def _unknown(where: str, d: dict, allowed: set[str]) -> None:
    extra = sorted(set(d) - allowed)
    if extra:
        raise CatalogError(f"{where}: unknown key(s) {extra}")


def _check_schema(where: str, s: object, sources: list[str]) -> None:
    if not isinstance(s, dict):
        raise CatalogError(f"{where}: a schema is a table")
    _unknown(where, s, _SCHEMA_KEYS)
    t = s.get("type")
    types = t if isinstance(t, list) else [t]
    if not types or any(x not in SCHEMA_TYPES for x in types):
        raise CatalogError(f"{where}: type {t!r} is not one of {SCHEMA_TYPES}")
    if "untrusted" in types:
        if types != ["untrusted"] or s.get("source") not in sources:
            raise CatalogError(f"{where}: an untrusted field names its `source`, one of {sources}")
    elif "source" in s:
        raise CatalogError(f"{where}: `source` belongs to type = \"untrusted\" only")
    for k, v in (s.get("properties") or {}).items():
        _check_schema(f"{where}.{k}", v, sources)
    if "items" in s:
        _check_schema(f"{where}[]", s["items"], sources)
    if not isinstance(s.get("required", []), list):
        raise CatalogError(f"{where}: required is a list of keys")


def _check_input(where: str, name: str, spec: object) -> None:
    if not isinstance(spec, dict):
        raise CatalogError(f"{where}.{name}: an input is a table")
    _unknown(f"{where}.{name}", spec, _INPUT_KEYS)
    if spec.get("type") not in INPUT_TYPES:
        raise CatalogError(f"{where}.{name}: type must be one of {INPUT_TYPES}")
    if "pattern" in spec:
        re.compile(spec["pattern"])
        if spec["type"] != "string":
            raise CatalogError(f"{where}.{name}: a pattern is for a string")
    if spec.get("required") and "one_of" in spec:
        raise CatalogError(f"{where}.{name}: required and one_of are two ways to say the same thing")


def _route(where: str, d: dict, roles: list[str], sources: list[str], seen_paths: set[str],
           seen_tools: set[str]) -> dict:
    _unknown(where, d, _OP_KEYS)
    for k in ("title", "http", "role", "effect", "confirm", "callers", "audit", "idempotent", "output"):
        if k not in d:
            raise CatalogError(f"{where}: missing {k!r}")
    m = _HTTP.fullmatch(d["http"])
    if not m:
        raise CatalogError(f"{where}: http must be 'METHOD /-/api/v1/<exact path>' (no parameters in the path: "
                           f"notes rule 1), got {d['http']!r}")
    method, path = m.groups()
    if path in seen_paths:
        raise CatalogError(f"{where}: path {path} is declared twice")
    seen_paths.add(path)
    if d["role"] not in roles:
        raise CatalogError(f"{where}: role {d['role']!r} is not one of {roles}")
    if d["effect"] not in EFFECTS or d["confirm"] not in CONFIRMS:
        raise CatalogError(f"{where}: effect/confirm not in {EFFECTS} / {CONFIRMS}")
    if READ_ONLY_SLICE and (d["effect"] != "read" or method != "GET" or d["confirm"] != "none"):
        raise CatalogError(f"{where}: slice 1 is read-only - an op must be effect=read, GET, confirm=none "
                           "(decision D28)")
    if d["effect"] != "read" and d["role"] == "viewer":
        raise CatalogError(f"{where}: a viewer op must be effect=read")
    if (d["effect"] in ("loosen", "destructive")) and d["confirm"] == "none":
        raise CatalogError(f"{where}: a loosen or destructive op needs a confirmation tier")
    cs = d["callers"]
    if not isinstance(cs, list) or not cs or any(c not in CALLERS for c in cs):
        raise CatalogError(f"{where}: callers must be a non-empty subset of {CALLERS}")
    ex = d.get("exposure", DEFAULT_EXPOSURE)
    if not isinstance(ex, list) or not ex or any(x not in EXPOSURES for x in ex) or len(set(ex)) != len(ex):
        raise CatalogError(f"{where}: exposure must be a non-empty list of distinct values from {EXPOSURES}")
    if "session" in ex and "token" in ex:
        raise CatalogError(f"{where}: exposure lists session and token: they need different routers "
                           "(a cookie gate cannot admit a bearer token); one channel per edge route until slice 2")
    if not _AUDIT.fullmatch(d["audit"]):
        raise CatalogError(f"{where}: audit kind must look like v1.<name>")
    if not isinstance(d["idempotent"], bool):
        raise CatalogError(f"{where}: idempotent is a boolean")
    mcp = d.get("mcp")
    if mcp is not None:
        if not isinstance(mcp, dict) or set(mcp) != {"tool", "scope"} or not _TOOL.fullmatch(str(mcp["tool"])):
            raise CatalogError(f"{where}: mcp = {{ tool = 'bothy_...', scope = ... }}")
        if mcp["scope"] != "read" or d["effect"] != "read":
            raise CatalogError(f"{where}: an MCP tool is scope=read in slice 1, and only for an effect=read op")
        if "mcp" not in cs:
            raise CatalogError(f"{where}: has an mcp tool but `mcp` is not in callers")
        if mcp["tool"] in seen_tools:
            raise CatalogError(f"{where}: tool {mcp['tool']} is declared twice")
        seen_tools.add(mcp["tool"])
    elif "mcp" in cs:
        raise CatalogError(f"{where}: callers lists `mcp` but there is no mcp = {{ tool, scope }}")
    inputs = d.get("input", {})
    if not isinstance(inputs, dict):
        raise CatalogError(f"{where}: input is a table of tables")
    for n, spec in inputs.items():
        _check_input(where, n, spec)
    _check_schema(f"{where}.output", d["output"], sources)
    if d["output"].get("type") != "object":
        raise CatalogError(f"{where}: an output is an object")
    return {**d, "method": method, "path": path, "input": inputs, "exposure": list(ex)}


def load(path: str | None = None) -> dict:
    """The validated catalog: {api, roles, sources, ops: {id: op}, endpoints: {id: ep}, routes: {path: op}}."""
    with open(path or CATALOG_FILE, "rb") as fh:
        doc = tomllib.load(fh)
    _unknown("catalog", doc, {"api", "ops", "endpoints"})
    api = doc.get("api") or {}
    _unknown("[api]", api, {"version", "min_client", "base", "untrusted_sources", "roles"})
    if api.get("version") != 1 or not _VERSION.fullmatch(str(api.get("min_client"))) \
            or api.get("base") != "/-/api/v1":
        raise CatalogError("[api] needs version = 1, min_client = 'x.y.z' and base = '/-/api/v1'")
    sources = api.get("untrusted_sources")
    roles = api.get("roles")
    if not isinstance(sources, list) or not sources or not isinstance(roles, list) or not roles:
        raise CatalogError("[api] needs untrusted_sources and roles")
    seen_paths: set[str] = set()
    seen_tools: set[str] = set()
    ops: dict[str, dict] = {}
    for oid, d in (doc.get("ops") or {}).items():
        if not _OP_ID.fullmatch(oid):
            raise CatalogError(f"op id {oid!r} is not dotted lowercase")
        ops[oid] = {"id": oid, **_route(f"ops.{oid}", d, roles, sources, seen_paths, seen_tools)}
    endpoints: dict[str, dict] = {}
    for eid, d in (doc.get("endpoints") or {}).items():
        endpoints[eid] = {"id": eid, **_route(f"endpoints.{eid}", d, roles, sources, seen_paths, seen_tools)}
    if "discover" not in endpoints:
        raise CatalogError("endpoints.discover is required: it is how a client learns what this server supports")
    routes = {o["path"]: o for o in [*ops.values(), *endpoints.values()]}
    return {"api": api, "roles": roles, "sources": sources, "ops": ops, "endpoints": endpoints, "routes": routes}


def role_allows(catalog: dict, caller_role: str, needed: str) -> bool:
    roles = catalog["roles"]
    return caller_role in roles and roles.index(caller_role) >= roles.index(needed)


# ── the inputs ───────────────────────────────────────────────────────────────

class InvalidInput(Exception):
    def __init__(self, message: str, details: dict | None = None):
        super().__init__(message)
        self.details = details or {}


def parse_query(op: dict, query: str) -> dict:
    """The op's parameters from a raw query string: typed, defaulted, or InvalidInput."""
    spec = op["input"]
    try:
        pairs = parse_qsl(query, keep_blank_values=True, strict_parsing=True) if query else []
    except ValueError:
        raise InvalidInput("the query string is malformed") from None
    got: dict[str, str] = {}
    for k, v in pairs:
        if k not in spec:
            raise InvalidInput(f"unknown parameter {k!r}", {"allowed": sorted(spec)})
        if k in got:
            raise InvalidInput(f"parameter {k!r} is given twice")
        got[k] = v
    out: dict = {}
    for name, s in spec.items():
        if name not in got:
            if s.get("required"):
                raise InvalidInput(f"parameter {name!r} is required")
            if "default" in s:
                out[name] = s["default"]
            continue
        raw = got[name]
        if s["type"] == "integer":
            if not re.fullmatch(r"-?\d{1,9}", raw):
                raise InvalidInput(f"{name} must be an integer")
            val: object = int(raw)
            if ("min" in s and val < s["min"]) or ("max" in s and val > s["max"]):  # type: ignore[operator]
                raise InvalidInput(f"{name} must be between {s.get('min')} and {s.get('max')}")
        elif s["type"] == "boolean":
            if raw not in ("true", "false"):
                raise InvalidInput(f"{name} must be true or false")
            val = raw == "true"
        else:
            if "pattern" in s and not re.fullmatch(s["pattern"], raw):
                raise InvalidInput(f"{name} is not in the shape {s['pattern']}")
            if "enum" in s and raw not in s["enum"]:
                raise InvalidInput(f"{name} must be one of {s['enum']}")
            val = raw
        out[name] = val
    groups: dict[str, list[str]] = {}
    for name, s in spec.items():
        if "one_of" in s:
            groups.setdefault(s["one_of"], []).append(name)
    for g, names in groups.items():
        given = [n for n in names if n in out]
        if len(given) != 1:
            raise InvalidInput(f"give exactly one of {names}", {"one_of": names})
    return out


# ── the outputs ──────────────────────────────────────────────────────────────

def _types(s: dict) -> list[str]:
    t = s.get("type")
    return t if isinstance(t, list) else [t]


def validate(schema: dict, value: object, path: str = "data") -> list[str]:
    """Problems with `value` against an output schema; [] when it conforms."""
    if value is None:
        if schema.get("nullable") or "null" in _types(schema):
            return []
        return [f"{path}: null where {_types(schema)} is declared"]
    errs: list[str] = []
    ts = _types(schema)
    if "untrusted" in ts:
        if not (isinstance(value, dict) and set(value) == {"text", "trust", "source"}
                and isinstance(value["text"], str) and value["trust"] == "untrusted"
                and value["source"] == schema["source"]):
            return [f"{path}: expected an untrusted-typed value from {schema['source']!r}, got {value!r:.80}"]
        return []
    kinds = {"string": str, "boolean": bool, "object": dict, "array": list}
    ok = False
    for t in ts:
        if t == "integer":
            ok = ok or (isinstance(value, int) and not isinstance(value, bool))
        elif t == "number":
            ok = ok or (isinstance(value, (int, float)) and not isinstance(value, bool))
        elif t in kinds:
            ok = ok or isinstance(value, kinds[t]) and not (t != "boolean" and isinstance(value, bool))
    if not ok:
        return [f"{path}: expected {ts}, got {type(value).__name__}"]
    if "enum" in schema and value not in schema["enum"]:
        errs.append(f"{path}: {value!r} is not one of {schema['enum']}")
    if isinstance(value, dict):
        for r in schema.get("required", []):
            if r not in value:
                errs.append(f"{path}.{r}: required and missing")
        for k, sub in (schema.get("properties") or {}).items():
            if k in value:
                errs += validate(sub, value[k], f"{path}.{k}")
    if isinstance(value, list) and "items" in schema:
        for i, it in enumerate(value):
            errs += validate(schema["items"], it, f"{path}[{i}]")
    return errs


def wrap_untrusted(schema: dict, value: object) -> object:
    """`value` with every field the schema types `untrusted` wrapped; nothing else is touched."""
    if value is None:
        return None
    if "untrusted" in _types(schema):
        text = value if isinstance(value, str) else json.dumps(value, sort_keys=True, ensure_ascii=False)
        return {"text": text, "trust": "untrusted", "source": schema["source"]}
    if isinstance(value, dict):
        props = schema.get("properties") or {}
        return {k: (wrap_untrusted(props[k], v) if k in props else v) for k, v in value.items()}
    if isinstance(value, list) and "items" in schema:
        return [wrap_untrusted(schema["items"], v) for v in value]
    return value


def untrusted_paths(schema: dict, prefix: str = "") -> list[tuple[str, str]]:
    """[(path, source)] of every untrusted-typed field of a schema, `[]` marking an array."""
    out: list[tuple[str, str]] = []
    if "untrusted" in _types(schema):
        return [(prefix, schema["source"])]
    for k, sub in (schema.get("properties") or {}).items():
        out += untrusted_paths(sub, f"{prefix}.{k}" if prefix else k)
    if "items" in schema:
        out += untrusted_paths(schema["items"], f"{prefix}[]")
    return out


# ── control characters and escapes, at the boundary ──────────────────────────
#
# What a terminal or a model would act on, removed from EVERY string the API serves
# (trusted ones too: it costs nothing and a mistake in the schema then still cannot
# put a clear-screen on somebody's terminal):
#   CSI  ESC [ ... final      colour, cursor, erase ("clear the screen", "move up and overwrite")
#   OSC  ESC ] ... BEL|ST     set the title, hyperlinks, clipboard (OSC 52)
#   DCS/APC/PM/SOS strings    ESC P ... ST
#   any other ESC pair, the 8-bit C1 forms, and every C0 control but \n and \t
#   bidi overrides and isolates (U+202A-202E, U+2066-2069): "trojan source" reordering
# The TEXT of an instruction ("ignore previous instructions") is not something a filter can
# remove; that is what the `trust: untrusted` wrapper is for.
_ANSI = re.compile(
    r"(?:\x1b\[[0-?]*[ -/]*[@-~])"               # CSI
    r"|(?:\x9b[0-?]*[ -/]*[@-~])"                # 8-bit CSI
    r"|(?:[\x1b\x9d]\][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$))"       # OSC
    r"|(?:\x1b[P_^X][^\x1b\x9c]*(?:\x1b\\|\x9c|$))"  # DCS, APC, PM, SOS
    r"|(?:\x1b[ -/]*[0-~])"                      # any other ESC sequence
)
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]")


def sanitize(text: str) -> str:
    return _CONTROL.sub("", _ANSI.sub("", text))


def sanitize_deep(value: object) -> object:
    if isinstance(value, str):
        return sanitize(value)
    if isinstance(value, list):
        return [sanitize_deep(v) for v in value]
    if isinstance(value, dict):
        return {k: sanitize_deep(v) for k, v in value.items()}
    return value
