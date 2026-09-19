#!/usr/bin/env python3
"""Settings > Updates is wired the way updates.py's header says.

Run: python3 checks/wiring_updates.py      (needs PyYAML - the system python3 has it)

Static, and apart from wiring.py for wiring_admin.py's reason: these routers are
hand-written, those are generated.

  EDGE     edge/dynamic/bothy-updates.yml: exactly one router, `Path(exact) &&
           Method(GET)` on /-/api/updates/status, strip, deidentify, sso-viewer,
           sso-errors; its own middlewares and service; no gate redefined; no
           doubled brace; allow-listed in edge/dynamic/.gitignore; and NOT in the
           generated bothy-ops.yml
  COMPOSE  bothy-ops mounts the updates state dir READ-ONLY, never auto-created,
           and nothing read-write that step 4's spool would need; node-exporter
           has the textfile collector on a dedicated read-only directory
  BUILD    updates.py and updates.toml are COPY'd and allow-listed;
           discover_updates.py is NOT (host-only)
  JUST     updates-discover exists; up-apps creates the updates dir, up-monitoring
           the textfile dir; bootstrap creates both
  HOST     the service and timer exist, run discover_updates.py as the owner
  UI       lib/updates.ts calls exactly this path
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(SVC))

try:
    import yaml
except ImportError:
    print("  FAIL  PyYAML is not importable - run with the system python3 (python3-yaml)")
    sys.exit(1)

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def read(rel: str) -> str:
    return open(os.path.join(REPO, rel), encoding="utf-8").read()


print("── EDGE: one exact GET path behind sso-viewer ───────────────────")
src = read("edge/dynamic/bothy-updates.yml")
ok("{{" not in src and "}}" not in src, "no doubled brace anywhere")
edge = yaml.safe_load(src)["http"]
routers = edge["routers"]
ok(list(routers) == ["bothy-updates-status"], f"exactly one router: {sorted(routers)}")
r = routers["bothy-updates-status"]
ok(r["rule"] == "Path(`/-/api/updates/status`) && Method(`GET`)", "exact Path and GET only")
ok(not re.search(r"Host|PathPrefix|Regexp", r["rule"]), "no Host, PathPrefix or Regexp")
ok(r["middlewares"] == ["bothy-updates-strip", "updates-deidentify", "sso-viewer", "sso-errors"],
   "strip, deidentify, sso-viewer, sso-errors - in that order")
ok(r["service"] == "bothy-updates" and r.get("entryPoints") == ["web"], "its own service, on web")
mws = edge.get("middlewares", {})
ok(set(mws) == {"bothy-updates-strip", "updates-deidentify"}, f"defines only its own middlewares: {sorted(mws)}")
ok(mws["bothy-updates-strip"] == {"stripPrefix": {"prefixes": ["/-/api"]}}, "strip removes /-/api only")
ok(set(mws["updates-deidentify"]["headers"]["customRequestHeaders"]) >=
   {"X-Auth-Request-Email", "X-Auth-Request-User", "X-Auth-Request-Groups"}, "client identity headers are stripped")
ok(edge["services"] == {"bothy-updates": {"loadBalancer": {"servers": [{"url": "http://bothy-ops:8097"}]}}},
   "one service, bothy-ops:8097 over opsnet")
others = {fn: read(f"edge/dynamic/{fn}") for fn in os.listdir(os.path.join(REPO, "edge/dynamic"))
          if fn.endswith(".yml") and fn != "bothy-updates.yml"}
for n in ("bothy-updates-strip", "updates-deidentify", "bothy-updates", "sso-viewer", "sso-errors"):
    defined_here = re.search(rf"^\s+{re.escape(n)}:\s*$", src, re.M) is not None
    elsewhere = any(re.search(rf"^\s+{re.escape(n)}:\s*$", s, re.M) for s in others.values())
    if n.startswith("sso-"):
        ok(not defined_here and elsewhere, f"{n} is borrowed, never redefined here")
    else:
        ok(defined_here and not elsewhere, f"{n} is defined here and nowhere else")
ok(re.search(r"^!bothy-updates\.yml$", read("edge/dynamic/.gitignore"), re.M) is not None,
   "edge/dynamic/.gitignore allow-lists bothy-updates.yml (the directory denies `*`)")
ok("/-/api/updates" not in read("edge/dynamic/bothy-ops.yml"),
   "the generated bothy-ops.yml carries no updates router (gen-ops-wiring.py owns that file)")

print()
print("── COMPOSE: read-only state, a dedicated textfile dir ───────────")
svc = yaml.safe_load(read("apps/bothy-ops/compose.yml"))["services"]["bothy-ops"]
longv = [v for v in svc["volumes"] if isinstance(v, dict)]
upd = [v for v in longv if v.get("target") == "/updates"]
ok(len(upd) == 1 and upd[0].get("read_only") is True and upd[0].get("bind", {}).get("create_host_path") is False
   and upd[0]["source"] == "${STATE_ROOT:-${HOME}/.local/state}/bothy/updates",
   "the updates state dir is read-only, never auto-created, beside the inventory")
inv = [v for v in longv if v.get("target") == "/inventory"]
ok(inv and inv[0]["source"].rsplit("/", 1)[0] == upd[0]["source"].rsplit("/", 1)[0],
   "…and mounted from the same state root as the inventory")
rw = [v for v in svc["volumes"] if (isinstance(v, str) and v.endswith(":rw")) or
      (isinstance(v, dict) and not v.get("read_only"))]
ok(all("audit" in str(v) for v in rw), f"the only read-write mount is still the audit dir (no spool yet): {rw}")
ok(svc.get("environment", {}).get("UPDATES_AVAILABLE") == "/updates/available.json", "the service is told where the file is")
ne = yaml.safe_load(read("monitoring/compose.yml"))["services"]["node-exporter"]
ok("--collector.textfile.directory=/textfile" in ne["command"], "node-exporter has the textfile collector")
tf = [v for v in ne["volumes"] if isinstance(v, dict) and v.get("target") == "/textfile"]
ok(len(tf) == 1 and tf[0].get("read_only") is True and tf[0].get("bind", {}).get("create_host_path") is False
   and tf[0]["source"].endswith("/bothy/textfile"), "…on a dedicated, read-only, never-created directory")

print()
print("── BUILD: updates.py ships, discover_updates.py does not ────────")
docker = read("apps/bothy-ops/Dockerfile")
dign = read("apps/.dockerignore")
ok(re.search(r"^COPY .*bothy-ops/updates\.py bothy-ops/updates\.toml", docker, re.M) is not None,
   "Dockerfile COPYs updates.py and updates.toml")
ok("!bothy-ops/updates.py" in dign and "!bothy-ops/updates.toml" in dign, "apps/.dockerignore allow-lists both")
ok("discover_updates" not in re.sub(r"#.*", "", docker) and "discover_updates" not in dign,
   "discover_updates.py is host-only, not in the image")
app = read("apps/bothy-ops/app.py")
ok('route == "/updates/status"' in app and "updates.CATALOG = updates.load()" in app,
   "app.py routes GET /updates/status and refuses to start on a bad catalog")
ok("def do_POST" in app and "/updates" not in app.split("def do_POST", 1)[1].split("def main", 1)[0],
   "no POST route under /updates (nothing is applied in step 3)")

print()
print("── JUST, bootstrap and host units ───────────────────────────────")
just = read("justfile")
ok(re.search(r"^updates-discover \*args:\n    python3 apps/bothy-ops/discover_updates\.py", just, re.M) is not None,
   "`just updates-discover` runs the host program")
upapps = just.split("\nup-apps", 1)[1].split("\n\n", 1)[0]
ok('mkdir -p -m 700 "$state/bothy/updates"' in upapps, "up-apps creates the updates dir, 700")
upmon = just.split("\nup-monitoring", 1)[1].split("\n\n", 1)[0]
ok("bothy/textfile" in upmon and "mkdir -p -m 755" in upmon, "up-monitoring creates the textfile dir, 755")
boot = read("scripts/bootstrap.sh")
ok("bothy/updates" in boot and "bothy/textfile" in boot, "bootstrap creates both")
svcu = read("host/systemd/bothy-updates-discover.service")
tim = read("host/systemd/bothy-updates-discover.timer")
ok("apps/bothy-ops/discover_updates.py" in svcu and "Type=oneshot" in svcu and "User=devssh" in svcu,
   "the service runs discover_updates.py once, as the owner")
ok("OnUnitActiveSec=6h" in tim and "Persistent=true" in tim, "the timer runs it every six hours, catching up")

print()
print("── UI: the client calls exactly this path ───────────────────────")
ts = read("apps/bothy-web/web/src/lib/updates.ts")
paths = set(re.findall(r"['`](/-/api/updates/[a-z/-]+)", ts))
ok(paths == {"/-/api/updates/status"}, f"lib/updates.ts calls only /-/api/updates/status: {sorted(paths)}")

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("wiring_updates: all passed")
