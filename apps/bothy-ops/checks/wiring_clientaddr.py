#!/usr/bin/env python3
"""The edge half of the trusted client address (s1.9a), held statically.

Run: python3 checks/wiring_clientaddr.py      (needs PyYAML - the system python3 has it)

There is no live Traefik here; this is the part that CAN be proved from files:

  ENTRYPOINTS  edge/compose.yml gives no entrypoint any forwardedHeaders option (trustedIPs, insecure) and
               no proxyProtocol. Traefik then trusts no one: it discards a client-sent X-Forwarded-For and
               writes the connecting peer, which is the one value bothy-ops will honour.
  MIDDLEWARE   edge/dynamic/bothy-v1-client.yml defines `v1-client-address`: deletions only (empty values,
               so no secret for /api/rawdata to print), no router, no Host(), and it covers the look-alike
               client-address headers.
  ROUTERS      every router that carries a bearer (a /v1 route with no sso gate), whether installed in
               edge/dynamic/ or rendered by gen-ops-v1.py for an op exposed to "token", lists it.
  SERVICE      bothy-ops trusts only the traefik container by name (never a wildcard), on opsnet, where
               traefik is the only other member; the default of the code is "never honour".
"""
import importlib.util
import glob
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(SVC))
sys.path.insert(0, SVC)

try:
    import yaml
except ImportError:
    print("  FAIL  PyYAML is not importable - run with the system python3 (python3-yaml)")
    sys.exit(1)

fails: list[str] = []


def ok(cond, label):
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def load(rel):
    return yaml.safe_load(open(os.path.join(REPO, rel), encoding="utf-8"))


MW = "v1-client-address"
LOOKALIKES = {"forwarded", "x-real-ip", "x-client-ip", "x-real-client", "true-client-ip"}

print("── ENTRYPOINTS: nobody is trusted to set forwarded headers ──────")
cmd = [str(c) for c in load("edge/compose.yml")["services"]["traefik"]["command"]]
ok(any(c.startswith("--entrypoints.web.address") for c in cmd), "(control: the web entrypoint is configured in this command list)")
bad = [c for c in cmd if re.search(r"forwardedheaders|proxyprotocol|trustedips", c, re.I)]
ok(not bad, f"no forwardedHeaders / trustedIPs / insecure / proxyProtocol on any entrypoint: {bad}")
for f in glob.glob(os.path.join(REPO, "edge", "*.y*ml")) + glob.glob(os.path.join(REPO, "edge", "dynamic", "*.y*ml")):
    body = re.sub(r"(?m)^\s*#.*$", "", open(f, encoding="utf-8").read())
    ok(not re.search(r"forwardedHeaders|trustedIPs", body), f"{os.path.relpath(f, REPO)}: no static forwardedHeaders block")

print()
print("── MIDDLEWARE: deletions only, no router ────────────────────────")
doc = load("edge/dynamic/bothy-v1-client.yml")
mws = doc["http"]["middlewares"]
hdr = mws.get(MW, {}).get("headers", {}).get("customRequestHeaders", {})
ok(MW in mws, f"{MW} is defined")
ok(hdr and all(v == "" for v in hdr.values()), "every value is empty: it deletes headers and carries no secret")
ok(LOOKALIKES <= {k.lower() for k in hdr}, f"it deletes the look-alike client-address headers {sorted(LOOKALIKES)}")
ok("routers" not in doc["http"] and "services" not in doc["http"], "the file defines no router (inert until a router names it)")
ok("host(" not in open(os.path.join(REPO, "edge/dynamic/bothy-v1-client.yml")).read().lower().replace("hostname", ""), "no Host() anywhere in it")

print()
print("── ROUTERS: a bearer route always carries it ────────────────────")
gate = re.compile(r"^sso-(viewer|operator|editor)$")
for f in sorted(glob.glob(os.path.join(REPO, "edge", "dynamic", "*.y*ml"))):
    for name, r in ((load(os.path.relpath(f, REPO)) or {}).get("http", {}).get("routers") or {}).items():
        if "/-/api/v1" in r.get("rule", ""):
            mw = r.get("middlewares", [])
            ok(MW in mw or any(gate.match(m) for m in mw),
               f"{os.path.basename(f)}: {name} (a /v1 route) is gated by a session or carries {MW}")
spec = importlib.util.spec_from_file_location("genv1", os.path.join(REPO, "scripts", "gen-ops-v1.py"))
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)
fake = {"endpoints": {"discover": {"id": "discover", "http": "GET /-/api/v1/discover", "exposure": ["socket"], "role": "viewer"}},
        "ops": {"a.b": {"id": "a.b", "http": "GET /-/api/v1/x", "exposure": ["token"], "role": "viewer"},
                "c.d": {"id": "c.d", "http": "GET /-/api/v1/y", "exposure": ["socket", "token"], "role": "viewer"},
                "e.f": {"id": "e.f", "http": "GET /-/api/v1/z", "exposure": ["session"], "role": "viewer"}}}
routers = (yaml.safe_load(gen.render_routers(fake)) or {}).get("http", {}).get("routers", {})
ok(set(routers) == {"bothy-ops-v1-a-b", "bothy-ops-v1-c-d", "bothy-ops-v1-e-f"}, f"(control: the generator rendered three routers: {sorted(routers)})")
ok(MW in routers["bothy-ops-v1-a-b"]["middlewares"] and MW in routers["bothy-ops-v1-c-d"]["middlewares"],
   "a generated router for an op exposed to a token carries v1-client-address")
ok(MW not in routers["bothy-ops-v1-e-f"]["middlewares"], "(a session-only router does not need it: it is gated, and keys no bearer limit)")
mids = routers["bothy-ops-v1-a-b"]["middlewares"]
ok(mids.index("bothy-ops-strip") < mids.index(MW) < mids.index("ops-deidentify"), "it runs after the strip and before the identity deletion")

print()
print("── SERVICE: only traefik, by name; the default is never ─────────")
env = load("apps/bothy-ops/compose.yml")["services"]["bothy-ops"]["environment"]
ok(env.get("BOTHY_TRUSTED_PROXIES") == "@traefik", f"bothy-ops trusts exactly the traefik container by name: {env.get('BOTHY_TRUSTED_PROXIES')!r}")
src = open(os.path.join(SVC, "clientaddr.py"), encoding="utf-8").read()
ok("if not (_nets or _names):\n        return False" in src, "with nothing configured trusted() is False for every peer")
ok("_nets: list = []" in src and "_names: list[str] = []" in src, "the module starts with no trusted entries")
ok("clientaddr.configure(os.environ.get(\"BOTHY_TRUSTED_PROXIES\"))" in open(os.path.join(SVC, "app.py"), encoding="utf-8").read(),
   "app.py configures it from the environment only")
ok("clientaddr.source(peer, h.headers)" in open(os.path.join(SVC, "v1api.py"), encoding="utf-8").read(),
   "v1api keys the limiter on clientaddr.source, not on the raw peer")
ok("clientaddr.py" in open(os.path.join(SVC, "Dockerfile"), encoding="utf-8").read(), "clientaddr.py is COPY'd into the image")

print()
print(f"{len(fails)} failed" if fails else "all passed")
sys.exit(1 if fails else 0)
