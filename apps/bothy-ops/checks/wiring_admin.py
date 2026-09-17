#!/usr/bin/env python3
"""The admin reads are wired the way admin.py's header says.

Run: python3 checks/wiring_admin.py      (needs PyYAML - the system python3 has it)

Static. Kept apart from wiring.py on purpose: that file checks the catalog-driven
routers, which are generated; these are hand-written, and a check that has to
know which half of a file is generated is a check that drifts.

  EDGE     edge/dynamic/bothy-admin.yml: exactly one router per admin.ENDPOINTS,
           each `Path(exact) && Method(GET)`, no Host/PathPrefix/Regexp, no doubled
           brace; middlewares strip, deidentify, sso-operator, sso-errors; its own
           middlewares and service (nothing borrowed from bothy-ops.yml); no gate
           redefined; allow-listed in edge/dynamic/.gitignore
  COMPOSE  the inventory and bothy-files' audit are mounted READ-ONLY; the
           inventory is never auto-created; no .env and no backups directory is
           mounted anywhere in bothy-ops; the admin overlay adds only env and a
           read-only, never-created /secrets
  BUILD    admin.py is COPY'd and allow-listed; inventory.py is NOT (host-only)
  JUST     up-apps adds compose.admin.yml only when the secret exists, and creates
           the inventory directory; admin-client and admin-inventory exist
  UI       the web client calls exactly these four paths
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(SVC))
sys.path.insert(0, SVC)
sys.path.insert(0, os.path.join(os.path.dirname(SVC), "bothy-common"))

try:
    import yaml
except ImportError:
    print("  FAIL  PyYAML is not importable - run with the system python3 (python3-yaml)")
    sys.exit(1)

os.environ.setdefault("ADMIN_AUDIT_LOG", os.devnull)
import admin  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def read(rel: str) -> str:
    return open(os.path.join(REPO, rel), encoding="utf-8").read()


print("── EDGE: four exact GET paths behind sso-operator ───────────────")
src = read("edge/dynamic/bothy-admin.yml")
ok("{{" not in src and "}}" not in src, "no doubled brace anywhere")
edge = yaml.safe_load(src)["http"]
routers = edge["routers"]
ok(set(routers) == {f"bothy-admin-{e}" for e in admin.ENDPOINTS},
   f"one router per admin.ENDPOINTS and no other: {sorted(routers)}")
for name, r in routers.items():
    ep = name[len("bothy-admin-"):]
    ok(r["rule"] == f"Path(`/-/api/admin/{ep}`) && Method(`GET`)", f"{name}: exact Path and GET only")
    ok(not re.search(r"Host|PathPrefix|Regexp", r["rule"]), f"{name}: no Host, PathPrefix or Regexp")
    ok(r["middlewares"] == ["bothy-admin-strip", "admin-deidentify", "sso-operator", "sso-errors"],
       f"{name}: strip, deidentify, sso-operator, sso-errors")
    ok(r["service"] == "bothy-admin" and r.get("entryPoints") == ["web"], f"{name}: its own service, on web")
mws = edge.get("middlewares", {})
ok(set(mws) == {"bothy-admin-strip", "admin-deidentify"}, f"defines only its own middlewares: {sorted(mws)}")
ok(mws["bothy-admin-strip"] == {"stripPrefix": {"prefixes": ["/-/api"]}}, "strip removes /-/api only")
ok(set(mws["admin-deidentify"]["headers"]["customRequestHeaders"]) >=
   {"X-Auth-Request-Email", "X-Auth-Request-User", "X-Auth-Request-Groups"}, "client identity headers are stripped")
ok(edge["services"] == {"bothy-admin": {"loadBalancer": {"servers": [{"url": "http://bothy-ops:8097"}]}}},
   "one service, bothy-ops:8097 over opsnet")
others = {fn: read(f"edge/dynamic/{fn}") for fn in os.listdir(os.path.join(REPO, "edge/dynamic"))
          if fn.endswith(".yml") and fn != "bothy-admin.yml"}
for n in ("bothy-admin-strip", "admin-deidentify", "bothy-admin"):
    ok(not any(re.search(rf"^\s+{re.escape(n)}:\s*$", s, re.M) for s in others.values()),
       f"{n} is not defined in any other edge file")
ok(re.search(r"^!bothy-admin\.yml$", read("edge/dynamic/.gitignore"), re.M) is not None,
   "edge/dynamic/.gitignore allow-lists bothy-admin.yml (the directory denies `*`)")

print()
print("── COMPOSE: read-only, and no secret mounted ────────────────────")
svc = yaml.safe_load(read("apps/bothy-ops/compose.yml"))["services"]["bothy-ops"]
vols = svc["volumes"]
short = [v for v in vols if isinstance(v, str)]
longv = [v for v in vols if isinstance(v, dict)]
ok("../bothy-files/audit:/audit-files:ro" in short, "bothy-files' audit dir is mounted read-only")
inv = [v for v in longv if v.get("target") == "/inventory"]
ok(len(inv) == 1 and inv[0].get("read_only") is True and inv[0].get("bind", {}).get("create_host_path") is False
   and inv[0]["source"].endswith("/bothy/inventory"), "the inventory is read-only and never auto-created")
flat = " ".join(str(v) for v in vols)
ok(".env" not in flat and "backups" not in flat, "no .env and no backups directory is mounted")
env = svc.get("environment", {})
ok(env.get("INVENTORY_FILE") == "/inventory/inventory.json" and env.get("ADMIN_AUDIT_LOG") == "/audit/admin.log",
   "the service is told where the inventory and its log are")
ok("KEYCLOAK_URL" not in env, "KEYCLOAK_URL is set only by the admin overlay")
over = yaml.safe_load(read("apps/bothy-ops/compose.admin.yml"))
osvc = over["services"]["bothy-ops"]
ok(list(over["services"]) == ["bothy-ops"] and set(osvc) == {"environment", "volumes"},
   "the admin overlay touches bothy-ops' environment and volumes only (no network, no port)")
ok(str(osvc["environment"].get("KEYCLOAK_URL", "")).startswith("http://${BOX_IP") and
   str(osvc["environment"]["KEYCLOAK_URL"]).endswith(":8090"),
   "Keycloak is reached at the single spelling http://BOX_IP:8090")
sec = osvc["volumes"]
ok(len(sec) == 1 and sec[0].get("target") == "/secrets" and sec[0].get("read_only") is True
   and sec[0].get("source") == "../bothy-ops/secrets" and sec[0].get("bind", {}).get("create_host_path") is False,
   "the secret mount is read-only, never created, and the same one compose.cluster.yml uses")

print()
print("── BUILD: admin.py ships, inventory.py does not ─────────────────")
docker = read("apps/bothy-ops/Dockerfile")
dign = read("apps/.dockerignore")
ok(re.search(r"^COPY .*bothy-ops/admin\.py", docker, re.M) is not None, "Dockerfile COPYs admin.py")
ok("!bothy-ops/admin.py" in dign, "apps/.dockerignore allow-lists admin.py")
ok("inventory.py" not in docker and "inventory.py" not in dign, "inventory.py is host-only, not in the image")

print()
print("── JUST and host units ──────────────────────────────────────────")
just = read("justfile")
upapps = just.split("\nup-apps", 1)[1].split("\n\n", 1)[0]
ok("apps/bothy-ops/secrets/keycloak-admin-client-secret" in upapps and "compose.admin.yml" in upapps,
   "up-apps adds compose.admin.yml only when the client secret exists")
ok("bothy/inventory" in upapps and "inventory.py" in upapps, "up-apps creates the inventory dir and refreshes it")
ok(re.search(r"^admin-client \*args:", just, re.M) and re.search(r"^admin-inventory:", just, re.M),
   "`just admin-client` and `just admin-inventory` exist")
ok("bothy/inventory" in read("scripts/bootstrap.sh"), "bootstrap creates the inventory directory")
ok(os.path.exists(os.path.join(REPO, "host/systemd/bothy-inventory.timer")), "the inventory timer is in host/systemd")
ok(re.search(r"^apps/bothy-ops/secrets/$", read(".gitignore"), re.M) is not None,
   "the secret's directory is gitignored")

print()
print("── UI: the client calls exactly these paths ─────────────────────")
ts = read("apps/bothy-web/web/src/lib/admin.ts")
paths = set(re.findall(r"['`]/-/api/admin/([a-z]+)", ts))
ok(paths == set(admin.ENDPOINTS), f"lib/admin.ts paths == admin.ENDPOINTS: {sorted(paths)}")

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("wiring_admin: all passed")
