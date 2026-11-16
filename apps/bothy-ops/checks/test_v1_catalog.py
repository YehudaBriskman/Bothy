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
ok(len(rules) == 9 and all(re.fullmatch(r"Path\(`/-/api/v1/[a-z/]+`\)", x) for x in rules),
   "nine routers, each ONE exact Path(), no Host, no PathPrefix")
ok("Host(" not in routers and "PathPrefix" not in routers, "no Host() and no PathPrefix anywhere in the routers")
ok(routers.count("sso-viewer") == 9 and "sso-operator" not in routers, "every router is behind sso-viewer")
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

shutil.rmtree(tmp)
print()
print(f"{len(fails)} failed" if fails else "all passed")
sys.exit(1 if fails else 0)
