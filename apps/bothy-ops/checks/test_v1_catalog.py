#!/usr/bin/env python3
"""The operation catalog (operations.toml) and what is generated from it - T1, plus the loader's refusals.

Run: python3 checks/test_v1_catalog.py        (stdlib only, no network, no docker)

  T1 DRIFT   scripts/gen-ops-v1.py renders the router entries, the OpenAPI document, the MCP tool list
             and the CLI verb table; the committed apps/bothy-ops/generated/* equal that render, and a
             catalog edit that is not regenerated makes `--check` exit 1 (shown on a copy).
  EIGHT      exactly the eight ops of slice 1, each with the full contract: id, verbs, method, exact
             path, input and output schema, audit kind, trust typing, role.
  READ-ONLY  every op is GET / read / confirm none / viewer; a write op, a second method, a duplicate
             path, a Host() style path, an unknown key or a bad schema each REFUSE TO LOAD.
  PATHS      exact, under /-/api/v1/, no prefix, no wildcard, no Host; the generated routers are
             exact Path() rules with the role's gate, and contain no template braces.
  EXPOSURE   D42: `exposure` defaults to ["socket"] and is a closed, non-empty set (unknown refused);
             the generator routes ONLY an op that lists "session" or "token": with the shipped
             catalog (all socket) the router file has no router at all; a fixture catalog that lists
             "session" for one op generates exactly ONE exact Path() router with that op's
             sso-<role> and never a Host(); discover lists every op's exposure.
  CALLER     D41: caller.py's adapters; the role is never a request header; a bearer with no token store configured refuses (tokens: test_tokens.py).
  UNTRUSTED  every free-text field the output schemas carry is typed `untrusted` with a known source.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SVC))
sys.path.insert(0, SVC)

import opscatalog  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


GEN = os.path.join(ROOT, "scripts", "gen-ops-v1.py")
TOML = os.path.join(SVC, "operations.toml")
EIGHT = ["status", "module.list", "update.status", "update.plan", "update.history", "job.get", "events.query",
         "settings.get"]

print("── THE CATALOG: eight ops, each the full contract ───────────────")
cat = opscatalog.load()
ok(list(cat["ops"]) == EIGHT, f"the eight ops of slice 1, in order: {list(cat['ops'])}")
for oid, o in cat["ops"].items():
    full = all(k in o for k in ("id", "title", "http", "role", "effect", "confirm", "callers", "audit", "input",
                                "output", "idempotent"))
    ok(full and o["audit"] == f"v1.{oid}", f"{oid}: id, verbs, method+path, schemas, audit kind v1.{oid}, role")
    method, path = o["http"].split(" ", 1)
    ok(method == "GET" and o["effect"] == "read" and o["confirm"] == "none" and o["role"] == "viewer",
       f"{oid}: GET, read, no confirmation, viewer")
    ok(re.fullmatch(r"/-/api/v1/[a-z/]+", path) is not None, f"{oid}: an exact path, no prefix, wildcard or Host: {path}")
ok(sorted(cat["routes"]) == sorted({o["http"].split(" ", 1)[1] for o in list(cat["ops"].values())
                                    + [cat["endpoints"]["discover"]]}), "the route table is exactly the declared paths")
ok(len(cat["routes"]) == 9, "eight ops plus discover = nine routes")
ok(all(o.get("cli") for o in cat["ops"].values()) and all(o.get("mcp") for o in cat["ops"].values()),
   "every op has a CLI verb and an MCP tool")
ok(all(o["mcp"]["scope"] == "read" for o in cat["ops"].values()), "every MCP tool is scope read")

print()
print("── T1: the generated files are what the catalog says ────────────")
r = subprocess.run([sys.executable, GEN, "--check"], capture_output=True, text=True)
ok(r.returncode == 0, "gen-ops-v1.py --check passes on the committed generated files")
tmp = tempfile.mkdtemp(prefix="bothy-v1-catalog-")
gen = os.path.join(tmp, "generated")
r = subprocess.run([sys.executable, GEN, "--out", gen], capture_output=True, text=True)
ok(r.returncode == 0 and sorted(os.listdir(gen)) == sorted(os.listdir(os.path.join(SVC, "generated"))),
   "--out writes the same four files elsewhere")
# the drift: one generated file edited, and one catalog edit not regenerated
with open(os.path.join(gen, "mcp-tools.v1.json"), "a") as fh:
    fh.write(" ")
r = subprocess.run([sys.executable, GEN, "--check", "--out", gen], capture_output=True, text=True)
ok(r.returncode == 1 and "mcp-tools.v1.json" in r.stdout, "an edited generated file fails --check, naming the file")
shutil.rmtree(gen)
subprocess.run([sys.executable, GEN, "--out", gen], check=True, capture_output=True)
src = open(TOML, encoding="utf-8").read()
alt = os.path.join(tmp, "operations.toml")
open(alt, "w", encoding="utf-8").write(src.replace('tool = "bothy_job_get"', 'tool = "bothy_job_fetch"'))
r = subprocess.run([sys.executable, GEN, "--check", "--out", gen], capture_output=True, text=True,
                   env={**os.environ, "OPERATIONS_CATALOG": alt})
ok(r.returncode == 1 and "bothy_job_fetch" in r.stdout, "a catalog edit that is not regenerated fails --check")
files = {n: open(os.path.join(SVC, "generated", n), encoding="utf-8").read() for n in os.listdir(os.path.join(SVC, "generated"))}
ok("{{" not in "".join(files.values()), "no doubled curly brace in any generated file (the Go template trap)")
routers = files["edge-routers.v1.yml"]
rules = re.findall(r'rule: "([^"]+)"', routers)
ok(all(o["exposure"] == ["socket"] for o in [*cat["ops"].values(), *cat["endpoints"].values()]),
   "every shipped op and endpoint is socket-only (the default, written nowhere)")
ok(rules == [] and "http:" not in routers and "routers:" not in routers,
   "so the generated edge file holds NO router (nine routes, none at the edge): comment-only")
ok("Host(" not in routers and "PathPrefix" not in routers, "no Host() and no PathPrefix anywhere in the routers")
ok(not os.path.exists(os.path.join(ROOT, "edge", "dynamic", "bothy-ops-v1.yml")),
   "the generated routers are inert: not installed in edge/dynamic/")
mcp = json.loads(files["mcp-tools.v1.json"])
ok([t["name"] for t in mcp["tools"]] == ["bothy_" + o.replace(".", "_") for o in EIGHT],
   "the MCP list is the eight tools")
ok(all(t["annotations"]["readOnlyHint"] and not t["annotations"]["destructiveHint"] for t in mcp["tools"]),
   "every MCP tool is annotated read-only")
oa = json.loads(files["openapi.v1.json"])
ok(sorted(oa["paths"]) == sorted(cat["routes"]) and all(list(v) == ["get"] for v in oa["paths"].values()),
   "OpenAPI documents the nine paths and only GET")
verbs = json.loads(files["cli-verbs.v1.json"])["verbs"]
ok(len(verbs) == 9 and all(v["method"] == "GET" for v in verbs), "the CLI verb table: nine GET verbs")

print()
print("── EXPOSURE: the generator routes only what is exposed at the edge ──")
# `status` is the viewer op; list "session" for it ONLY, in a copy of the catalog, and regenerate.
SESSION = src.replace('audit = "v1.status"', 'audit = "v1.status"\nexposure = ["session"]', 1)
assert SESSION != src
alt2 = os.path.join(tmp, "session.toml")
open(alt2, "w", encoding="utf-8").write(SESSION)
gen2 = os.path.join(tmp, "gen2")
r = subprocess.run([sys.executable, GEN, "--out", gen2], capture_output=True, text=True,
                   env={**os.environ, "OPERATIONS_CATALOG": alt2})
ok(r.returncode == 0, f"a catalog listing session for one op generates: {r.stderr.strip()[:80]}")
r2 = open(os.path.join(gen2, "edge-routers.v1.yml"), encoding="utf-8").read()
rules2 = re.findall(r'rule: "([^"]+)"', r2)
ok(rules2 == ["Path(`/-/api/v1/status`)"], f"exactly ONE router, one exact Path(): {rules2}")
ok(len(re.findall(r"^    bothy-ops-v1-", r2, re.M)) == 1 and "bothy-ops-v1-status:" in r2, "named for that op, and only that op")
ok("middlewares: [bothy-ops-strip, ops-deidentify, sso-viewer, sso-errors]" in r2, "with the op's role gate (sso-viewer)")
ok("Host(" not in r2 and "PathPrefix" not in r2 and "{{" not in r2, "and never a Host() rule, a prefix or a template brace")
r = subprocess.run([sys.executable, GEN, "--check", "--out", gen2], capture_output=True, text=True,
                   env={**os.environ, "OPERATIONS_CATALOG": alt2})
ok(r.returncode == 0, "the drift check holds a catalog that has an edge-exposed op")
OPR = SESSION.replace('role = "viewer"\neffect = "read"\nconfirm = "none"\ncallers = ["web", "cli", "mcp", "system"]\nmcp = { tool = "bothy_status"',
                      'role = "operator"\neffect = "read"\nconfirm = "none"\ncallers = ["web", "cli", "mcp", "system"]\nmcp = { tool = "bothy_status"', 1)
ok(OPR != SESSION, "(fixture: the same op at the operator role)")
alt3 = os.path.join(tmp, "operator.toml")
open(alt3, "w", encoding="utf-8").write(OPR)
r = subprocess.run([sys.executable, GEN, "--out", os.path.join(tmp, "gen3")], capture_output=True, text=True,
                   env={**os.environ, "OPERATIONS_CATALOG": alt3})
r3 = open(os.path.join(tmp, "gen3", "edge-routers.v1.yml"), encoding="utf-8").read()
ok("sso-operator" in r3 and "sso-viewer" not in r3, "an operator-role op is routed behind sso-operator, not sso-viewer")
TOK = src.replace('audit = "v1.status"', 'audit = "v1.status"\nexposure = ["token"]', 1)
alt4 = os.path.join(tmp, "token.toml")
open(alt4, "w", encoding="utf-8").write(TOK)
subprocess.run([sys.executable, GEN, "--out", os.path.join(tmp, "gen4")], capture_output=True, text=True,
               env={**os.environ, "OPERATIONS_CATALOG": alt4})
r4 = open(os.path.join(tmp, "gen4", "edge-routers.v1.yml"), encoding="utf-8").read()
ok(len(re.findall(r'rule: "Path\(`/-/api/v1/status`\)"', r4)) == 1 and "sso-viewer" not in r4 and "[bothy-ops-strip, v1-client-address, ops-deidentify, sso-errors]" in r4,
   "a token op is one exact Path() router with no cookie gate (the service verifies the bearer)")
oa2 = json.loads(open(os.path.join(gen2, "openapi.v1.json"), encoding="utf-8").read())
ok(oa2["paths"]["/-/api/v1/status"]["get"]["x-bothy"]["exposure"] == ["session"]
   and oa["paths"]["/-/api/v1/status"]["get"]["x-bothy"]["exposure"] == ["socket"], "OpenAPI states each op's exposure")

print()
print("── THE LOADER REFUSES what slice 1 must not serve ───────────────")


def refuses(label: str, edit, needle: str = "") -> None:
    text = edit(src)
    assert text != src, f"edit did not apply: {label}"
    p = os.path.join(tmp, "bad.toml")
    open(p, "w", encoding="utf-8").write(text)
    try:
        opscatalog.load(p)
        ok(False, label)
    except opscatalog.CatalogError as e:
        ok(needle in str(e), f"{label}: {e}")


refuses("a write effect", lambda s: s.replace('effect = "read"', 'effect = "tighten"'), "slice 1 is read-only")
refuses("a POST method", lambda s: s.replace('http = "GET /-/api/v1/job"', 'http = "POST /-/api/v1/job"', 1), "")
refuses("a viewer op that is not a read", lambda s: s.replace('effect = "read"', 'effect = "tighten"'), "")
refuses("a confirm of click", lambda s: s.replace('confirm = "none"', 'confirm = "click"', 1), "")
refuses("a duplicate path", lambda s: s.replace("/-/api/v1/modules", "/-/api/v1/status", 1), "")
refuses("a trailing-slash (prefix-style) path", lambda s: s.replace('GET /-/api/v1/events"', 'GET /-/api/v1/events/"', 1), "http must be")
refuses("a path parameter", lambda s: s.replace('GET /-/api/v1/job"', 'GET /-/api/v1/job/{id}"', 1), "http must be")
refuses("an unknown key", lambda s: s.replace('audit = "v1.job.get"', 'audit = "v1.job.get"\nsecret_hatch = true', 1), "")
refuses("a duplicate MCP tool", lambda s: s.replace('tool = "bothy_job_get"', 'tool = "bothy_status"', 1), "")
refuses("a write-scoped MCP tool", lambda s: s.replace('scope = "read"', 'scope = "write"', 1), "")
refuses("an untrusted source that is not declared", lambda s: s.replace('source = "ci"', 'source = "mystery"', 1), "")

def with_exposure(v: str):
    return lambda s: s.replace('audit = "v1.status"', f'audit = "v1.status"\nexposure = {v}', 1)


refuses("an unknown exposure", with_exposure('["socket", "carrier-pigeon"]'), "exposure must be")
refuses("an empty exposure", with_exposure("[]"), "exposure must be")
refuses("a string exposure", with_exposure('"socket"'), "exposure must be")
refuses("a repeated exposure", with_exposure('["socket", "socket"]'), "exposure must be")
refuses("session and token together", with_exposure('["session", "token"]'), "session and token")
p = os.path.join(tmp, "ok.toml")
open(p, "w", encoding="utf-8").write(with_exposure('["socket", "session"]')(src))
ok(opscatalog.load(p)["ops"]["status"]["exposure"] == ["socket", "session"], "control: a valid list loads, in order")
opscatalog.READ_ONLY_SLICE = False
try:
    p = os.path.join(tmp, "w.toml")
    open(p, "w", encoding="utf-8").write(src.replace('effect = "read"', 'effect = "tighten"', 1))
    opscatalog.load(p)
    loaded = True
except opscatalog.CatalogError:
    loaded = False
opscatalog.READ_ONLY_SLICE = True
ok(loaded, "the read-only switch is the ONE thing standing between the file and a write op (control: off loads)")

print()
print("── UNTRUSTED: every free-text field is typed, with a source ─────")
for oid, o in cat["ops"].items():
    for path, src_ in opscatalog.untrusted_paths(o["output"]):
        ok(src_ in cat["api"]["untrusted_sources"], f"{oid}: {path} is untrusted ({src_})")


def strings(schema: dict, prefix: str = ""):
    """Every plain `string` field with no enum/pattern - i.e. free text if the data were hostile."""
    t = schema.get("type")
    if t == "string" and "enum" not in schema and "pattern" not in schema:
        yield prefix
    for k, sub in (schema.get("properties") or {}).items():
        yield from strings(sub, f"{prefix}.{k}" if prefix else k)
    if "items" in schema:
        yield from strings(schema["items"], prefix + "[]")


# Free-text names: a field whose NAME says it holds prose, a message, a path or a reason must be untrusted.
SERVER_AUTHORED = {"update.plan:scope.message"}   # built by v1api from catalog ids (closed set), never from input
PROSE = re.compile(r"(error|reason|note|detail|message|text|drift|why|value|log)", re.I)
leaks = [f"{oid}:{p}" for oid, o in cat["ops"].items() for p in strings(o["output"])
         if PROSE.search(p.split(".")[-1]) and f"{oid}:{p}" not in SERVER_AUTHORED]
ok(not leaks, f"no prose-named field is a plain string in any output schema: {leaks}")

print()
print("── CALLER: one identity object, one adapter per credential kind ─")
import caller  # noqa: E402

H_EDGE = {"X-Auth-Request-Email": "v@example.com"}
c = caller.from_request({}, "viewer")
ok(c == caller.Caller("socket", "viewer", (), None), f"no credential: the local channel is kind socket, a viewer: {c}")
c = caller.from_request(H_EDGE, "operator")
ok(c.kind == "session" and c.role == "operator" and c.token_id is None, f"an edge identity is kind session, at the role the edge gated: {c}")
for hostile in ({"X-Bothy-Role": "operator"}, {"X-Role": "operator"}, {"X-Auth-Request-Groups": "operator"},
                {"X-Auth-Request-Role": "operator"}, {"Role": "operator"}, {"X-Forwarded-Role": "operator"}):
    ok(caller.from_request(hostile, "viewer").role == "viewer"
       and caller.from_request({**H_EDGE, **hostile}, "viewer").role == "viewer",
       f"the role is never a request field: {list(hostile)[0]}: operator is ignored by the socket and session adapters")
for h in ({"Authorization": "Bearer abc"}, {"Authorization": "Basic Zm9vOmJhcg=="}, {**H_EDGE, "Authorization": "Bearer abc"}):
    try:
        caller.from_request(h, "viewer")
        ok(False, f"a bearer with no store refuses: {list(h)}")
    except caller.Unauthenticated:
        ok(True, f"the token adapter with no store configured refuses (and an edge identity beside it is ambiguous): {sorted(h)}")
try:
    caller.session({}, "viewer")
    ok(False, "a session adapter with no edge identity refuses")
except caller.Unauthenticated:
    ok(True, "a session adapter with no edge identity refuses")
ok(caller.system("viewer") == caller.Caller("system", "viewer") and caller.from_request({}, "viewer").kind != "system",
   "system exists for in-process host code and is never what a request becomes")
ok(set(caller.EXPOSURES) == set(opscatalog.EXPOSURES) and "system" not in caller.EXPOSURES
   and set(caller.KINDS) == set(caller.EXPOSURES) | {"system"}, "the exposure vocabulary is the Caller kinds minus system, in both modules")
try:
    caller.Caller("socket", "viewer").role = "operator"
    ok(False, "a Caller is immutable")
except Exception:  # noqa: BLE001  (FrozenInstanceError)
    ok(True, "a Caller is immutable: an operation cannot raise its own role")

shutil.rmtree(tmp)
print()
print(f"{len(fails)} failed" if fails else "all passed")
sys.exit(1 if fails else 0)
