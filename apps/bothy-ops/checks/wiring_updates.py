#!/usr/bin/env python3
"""Settings > Updates is wired the way updates.py's header says.

Run: python3 checks/wiring_updates.py      (needs PyYAML - the system python3 has it)

Static, and apart from wiring.py for wiring_admin.py's reason: these routers are
hand-written, those are generated.

  EDGE     edge/dynamic/bothy-updates.yml: exactly seven routers, each an exact
           `Path() && Method()`: status, plan and job are GET behind sso-viewer;
           request, unpause, discover and autorun are POST behind sso-OPERATOR; all
           strip, deidentify, then the
           gate, then sso-errors; its own middlewares and service; no gate
           redefined; no doubled brace; allow-listed in edge/dynamic/.gitignore;
           and NOT in the generated bothy-ops.yml
  ASKS     the two asks of 2026-10-06 (discover, autorun) are wired end to end: a
           router, a POST route in app.py, a writer in updates.py, a spool file
           kind the executor's loop does NOT remove as junk, a drain that claims
           it, ONE rate-limit constant read by both halves, and a button in the UI
  COMPOSE  bothy-ops mounts the updates state dir READ-ONLY and the spool - its
           ONLY read-write mount besides the audit dir - both never
           auto-created; node-exporter has the textfile collector on a
           dedicated read-only directory
  BUILD    updates.py and updates.toml are COPY'd and allow-listed;
           discover_updates.py and the updater package are NOT (host-only)
  JUST     updates-discover, update-plan, update-status exist; up-apps creates
           the updates dir and the spool, up-monitoring the textfile dir;
           bootstrap creates all three
  HOST     the discover service/timer and the updater path/service exist; the
           updater runs `python3 -m updater run` as the owner, from the path unit
           watching exactly the spool
  UI       lib/updates.ts calls exactly these five paths
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


print("── EDGE: seven exact paths, each with its method and its gate ─")
src = read("edge/dynamic/bothy-updates.yml")
ok("{{" not in src and "}}" not in src, "no doubled brace anywhere")
edge = yaml.safe_load(src)["http"]
routers = edge["routers"]
WANT = {  # router -> (path, method, gate)
    "bothy-updates-status": ("/-/api/updates/status", "GET", "sso-viewer"),
    "bothy-updates-plan": ("/-/api/updates/plan", "GET", "sso-viewer"),
    "bothy-updates-job": ("/-/api/updates/job", "GET", "sso-viewer"),
    "bothy-updates-request": ("/-/api/updates/request", "POST", "sso-operator"),
    "bothy-updates-unpause": ("/-/api/updates/unpause", "POST", "sso-operator"),
    # 2026-10-06: "check for updates now" and "run the night job now". Both make the
    # HOST run something, so both are POST behind operator - never viewer, which is
    # the mutation scripts/checks/mutants.sh plants.
    "bothy-updates-discover": ("/-/api/updates/discover", "POST", "sso-operator"),
    "bothy-updates-autorun": ("/-/api/updates/autorun", "POST", "sso-operator"),
}
# Derived, so the UI assertion below cannot drift from the router table above.
WANTED_PATHS = sorted(p.rsplit("/", 1)[-1] for p, _, _ in WANT.values())
ok(set(routers) == set(WANT), f"exactly seven routers: {sorted(routers)}")
for name, (path, method, gate) in WANT.items():
    r = routers.get(name, {})
    ok(r.get("rule") == f"Path(`{path}`) && Method(`{method}`)", f"{name}: exact Path and {method} only")
    ok(not re.search(r"Host|PathPrefix|Regexp", r.get("rule", "")), f"{name}: no Host, PathPrefix or Regexp")
    ok(r.get("middlewares") == ["bothy-updates-strip", "updates-deidentify", gate, "sso-errors"],
       f"{name}: strip, deidentify, {gate}, sso-errors - in that order")
    ok(r.get("service") == "bothy-updates" and r.get("entryPoints") == ["web"], f"{name}: its own service, on web")
WRITES = sorted(f"bothy-updates-{n}" for n in ("request", "unpause", "discover", "autorun"))
ok(sorted(n for n, r in routers.items() if "sso-operator" in r.get("middlewares", [])) == WRITES,
   "the FOUR routes that ask the host for anything are the only ones behind operator")
ok(all("POST" not in r["rule"] for n, r in routers.items() if n not in WRITES),
   "no read accepts a POST")
ok(all("GET" not in routers[n]["rule"] for n in WRITES), "no ask answers a GET")
mws = edge.get("middlewares", {})
ok(set(mws) == {"bothy-updates-strip", "updates-deidentify"}, f"defines only its own middlewares: {sorted(mws)}")
ok(mws["bothy-updates-strip"] == {"stripPrefix": {"prefixes": ["/-/api"]}}, "strip removes /-/api only")
ok(set(mws["updates-deidentify"]["headers"]["customRequestHeaders"]) >=
   {"X-Auth-Request-Email", "X-Auth-Request-User", "X-Auth-Request-Groups"}, "client identity headers are stripped")
ok(edge["services"] == {"bothy-updates": {"loadBalancer": {"servers": [{"url": "http://bothy-ops:8097"}]}}},
   "one service, bothy-ops:8097 over opsnet")
others = {fn: read(f"edge/dynamic/{fn}") for fn in os.listdir(os.path.join(REPO, "edge/dynamic"))
          if fn.endswith(".yml") and fn != "bothy-updates.yml"}
for n in ("bothy-updates-strip", "updates-deidentify", "bothy-updates", "sso-viewer", "sso-operator",
          "sso-errors"):
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
spool = [v for v in longv if v.get("target") == "/spool"]
ok(len(spool) == 1 and spool[0].get("read_only") is False and spool[0].get("bind", {}).get("create_host_path") is False
   and spool[0]["source"] == "${STATE_ROOT:-${HOME}/.local/state}/bothy/updates/spool",
   "the spool is read-write, never auto-created, inside the updates state dir")
ok(len(rw) == 2 and "./audit:/audit:rw" in rw and spool[0] in rw,
   f"the ONLY read-write mounts are the audit dir and the spool: {rw}")
envs = svc.get("environment", {})
ok(envs.get("UPDATES_SPOOL") == "/spool" and envs.get("UPDATES_DIR") == "/updates",
   "the service is told where the spool and the state dir are")
ok(svc.get("environment", {}).get("UPDATES_AVAILABLE") == "/updates/available.json", "the service is told where the file is")
ne = yaml.safe_load(read("monitoring/compose.yml"))["services"]["node-exporter"]
ok("--collector.textfile.directory=/textfile" in ne["command"], "node-exporter has the textfile collector")
tf = [v for v in ne["volumes"] if isinstance(v, dict) and v.get("target") == "/textfile"]
ok(len(tf) == 1 and tf[0].get("read_only") is True and tf[0].get("bind", {}).get("create_host_path") is False
   and tf[0]["source"].endswith("/bothy/textfile"), "…on a dedicated, read-only, never-created directory")

print()
print("── BUILD: updates.py ships; discovery and the updater do not ───")
docker = read("apps/bothy-ops/Dockerfile")
dign = read("apps/.dockerignore")
ok(re.search(r"^COPY .*bothy-ops/updates\.py bothy-ops/updates\.toml", docker, re.M) is not None,
   "Dockerfile COPYs updates.py and updates.toml")
ok("!bothy-ops/updates.py" in dign and "!bothy-ops/updates.toml" in dign, "apps/.dockerignore allow-lists both")
ok("discover_updates" not in re.sub(r"#.*", "", docker) and "discover_updates" not in dign,
   "discover_updates.py is host-only, not in the image")
ok(not re.search(r"\bupdater\b", re.sub(r"#.*", "", docker)) and not re.search(r"\bupdater\b", dign),
   "the updater package is host-only, not in the image (bothy-ops cannot run it)")
app = read("apps/bothy-ops/app.py")
ok('route in ("/updates/status", "/updates/plan", "/updates/job")' in app and "updates.CATALOG = updates.load()" in app,
   "app.py routes the three GETs and refuses to start on a bad catalog")
post = app.split("def do_POST", 1)[1].split("def main", 1)[0]
ok(re.findall(r'"/updates/[a-z]+"', post) == [f'"/updates/{n}"' for n in
                                              ("request", "unpause", "discover", "autorun")],
   "the only POSTs under /updates are request, unpause, discover and autorun")
upd = read("apps/bothy-ops/updates.py")
ok(not re.search(r"^\s*(import|from)\s+(subprocess|socket|http\.client|urllib\.request)\b", upd, re.M),
   "updates.py imports nothing that starts a process or opens a connection")
print()
print("── JUST, bootstrap and host units ───────────────────────────────")
just = read("justfile")
ok(re.search(r"^updates-discover \*args:\n    python3 apps/bothy-ops/discover_updates\.py", just, re.M) is not None,
   "`just updates-discover` runs the host program")
ok(re.search(r"^update-plan component:\n    cd apps/bothy-ops && python3 -m updater plan", just, re.M) is not None
   and re.search(r"^update-status:\n    cd apps/bothy-ops && python3 -m updater status", just, re.M) is not None,
   "`just update-plan` and `just update-status` run the host updater by hand")
upapps = just.split("\nup-apps", 1)[1].split("\n\n", 1)[0]
ok('mkdir -p -m 700 "$state/bothy/updates"' in upapps and 'mkdir -p -m 700 "$state/bothy/updates/spool"' in upapps,
   "up-apps creates the updates dir and the spool, 700")
upmon = just.split("\nup-monitoring", 1)[1].split("\n\n", 1)[0]
ok("bothy/textfile" in upmon and "mkdir -p -m 755" in upmon, "up-monitoring creates the textfile dir, 755")
boot = read("scripts/bootstrap.sh")
ok("bothy/updates" in boot and "bothy/textfile" in boot and 'bothy/updates/spool" && chmod 700' in boot,
   "bootstrap creates all three")
svcu = read("host/systemd/bothy-updates-discover.service")
tim = read("host/systemd/bothy-updates-discover.timer")
ok("apps/bothy-ops/discover_updates.py" in svcu and "Type=oneshot" in svcu and "User=devssh" in svcu,
   "the discover service runs discover_updates.py once, as the owner")
ok("OnUnitActiveSec=6h" in tim and "Persistent=true" in tim, "the timer runs it every six hours, catching up")
pth = read("host/systemd/bothy-updater.path")
usv = read("host/systemd/bothy-updater.service")
ok(re.search(r"^PathExistsGlob=/\S+/\.local/state/bothy/updates/spool/\*\.json$", pth, re.M) is not None and "Unit=bothy-updater.service" in pth,
   "bothy-updater.path watches exactly the spool's *.json")
ok("Type=oneshot" in usv and "User=devssh" in usv and "ExecStart=/usr/bin/python3 -m updater run" in usv
   and re.search(r"^WorkingDirectory=/\S+/apps/bothy-ops$", usv, re.M) is not None and "NoNewPrivileges=yes" in usv,
   "bothy-updater.service: one run of the executor, as the owner, no new privileges")
ok(not os.path.exists(os.path.join(REPO, "host/systemd/bothy-updater.timer")),
   "the executor has no timer of its own: it runs a request someone - or the auto night job - wrote "
   "(checks/wiring_auto.py covers bothy-updater-auto.timer)")
print()
print("── step 6: the updater never replaces itself; images named by commit ─")
ok(re.search(r"^WorkingDirectory=/\S+/\.local/lib/bothy-updater/current/apps/bothy-ops$", usv, re.M) is not None,
   "bothy-updater.service runs the INSTALLED copy (…/bothy-updater/current), never the checkout it moves")
autosv = read("host/systemd/bothy-updater-auto.service")
ok(re.search(r"^WorkingDirectory=/\S+/\.local/lib/bothy-updater/current/apps/bothy-ops$", autosv, re.M) is not None,
   "bothy-updater-auto.service (the night job, step 7) runs the same installed copy")
ok(re.search(r"^ExecStart=/usr/bin/python3 /\S+/\.local/lib/bothy-updater/current/apps/bothy-ops/discover_updates\.py",
             svcu, re.M) is not None,
   "discovery (which writes the plans) runs the same installed copy - a plan id is computed by the code that re-checks it")
ok(re.search(r"^install-updater:\n    cd apps/bothy-ops && python3 -m updater install", just, re.M) is not None,
   "`just install-updater` installs HEAD's updater and switches `current`")
ok('BOTHY_IMAGE_TAG="${BOTHY_IMAGE_TAG:-$BOTHY_REVISION}"' in upapps and '"${BOTHY_UP_NO_BUILD:-}" = 1' in upapps
   and "--no-build" in upapps and re.search(r"^up-apps \*services: network$", just, re.M) is not None,
   "up-apps: per-service, images tagged by HEAD's sha, and a no-build mode for the updater and its rollback")
for app in ("bothy-web", "bothy-files", "bothy-ops"):
    comp = read(f"apps/{app}/compose.yml")
    ok(f"image: {app}:${{BOTHY_IMAGE_TAG:-latest}}" in comp and "pull_policy: never" in comp,
       f"{app}: image named by commit (BOTHY_IMAGE_TAG), never pulled")
bothy_cli = read("scripts/bothy")
ok("exec python3 -m updater upgrade" in bothy_cli.split("cmd_upgrade()", 1)[1].split("\n}\n", 1)[0],
   "`bothy upgrade` drives the updater's plan and executor when the updater is installed")
print()
print("── UI: the client calls exactly these paths ─────────────────────")
ts = read("apps/bothy-web/web/src/lib/updates.ts")
paths = set(re.findall(r"['`](/-/api/updates/[a-z/-]+)", ts))
ok(paths == {f"/-/api/updates/{p}" for p in WANTED_PATHS},
   f"lib/updates.ts calls exactly the seven routed paths: {sorted(paths)}")
# The point of the page is that every endpoint has a control and every control has
# an endpoint. A route nothing calls is dead surface behind an operator gate; a
# button with no route is a dead control, which is the thing a viewer must never
# see (components/states.tsx NeedsRole exists for the other case).
page = read("apps/bothy-web/web/src/pages/settings/Updates.tsx")
ok(all(f"{fn}(" in page for fn in ("requestUpdate", "unpauseAuto", "askDiscover", "askNightJob")),
   "Settings > Updates calls every writing client function - no route without a control")

print()
print("── ASKS: discover and autorun, end to end (2026-10-06) ──────────")
# The failure this holds: a spool file kind the executor's loop does not KNOW is
# removed as junk, with an audit line, and the ask it carried silently never
# happens. The name has to be in three places that do not import each other.
sp = read("apps/bothy-ops/updater/spool.py")
ok(re.search(r'^DISCOVER_FILE = re\.compile\(r"discover-\(\[a-f0-9\]\{32\}\)\\\.json"\)$', sp, re.M) is not None
   and re.search(r'^AUTORUN_FILE = re\.compile\(r"autorun-\(\[a-f0-9\]\{32\}\)\\\.json"\)$', sp, re.M) is not None,
   "spool.py knows both ask file names")
ok(re.search(r"^OTHER_KINDS = \(UNPAUSE_FILE, DISCOVER_FILE, AUTORUN_FILE\)$", sp, re.M) is not None
   and "any(p.fullmatch(n) for p in OTHER_KINDS)" in sp,
   "…and entries() skips every one of them rather than filing it as junk")
ex = read("apps/bothy-ops/updater/executor.py")
ok('_hook(cfg, "asks", "drain_discover")' in ex and '_hook(cfg, "asks", "drain_autorun")' in ex
   and ex.index('_hook(cfg, "asks", "drain_discover")') < ex.index('_hook(cfg, "asks", "drain_autorun")'),
   "the drain loop claims both, discovery first (the night job picks from its plans)")
ok(ex.index('_hook(cfg, "asks", "drain_autorun")') < ex.index("reqs, junk = spool.entries(cfg.spool)"),
   "…and both before it looks for update requests, so one turn covers the ask and the job it writes")
asks = read("apps/bothy-ops/updater/asks.py")
ok("updates.DISCOVER_MIN_SECONDS" in asks and "DISCOVER_MIN_SECONDS = 300" in upd
   and "DISCOVER_MIN_SECONDS" not in re.sub(r"updates\.DISCOVER_MIN_SECONDS", "", asks),
   "ONE rate-limit constant, defined in updates.py and read by the host half")
ok("updates.AUTO_ACTOR" in asks and 'raise spool.Invalid("requestedBy is malformed' in asks,
   "the host refuses an ask that names the system actor, like an unpause")
ok("spool.remove(cfg.spool, n)  # claimed before it acts" in asks and asks.count("spool.remove(cfg.spool, n)") >= 3,
   "every ask is claimed (unlinked) before it acts - at most once, like a request")
ok("discover_updates.py" in asks and "sys.executable" in asks and '"--state-dir", cfg.state' in asks
   and not re.search(r"shell\s*=\s*True", asks),
   "discovery runs as a fixed argv built from Config - nothing from the ask is in it")
ok(re.search(r"^from \. import OPS, hostio, spool$", asks, re.M) is not None,
   "…from the INSTALLED copy's own directory (updater.OPS), like the timer's unit")
ok('"asks.json"' in asks and "0o600" in asks,
   "asks.json - the host's record of each run - is 600 in the directory bothy-ops reads only")
ok('"asks.json"' in upd and "_asks_state" in upd and '"askedBy"' in upd,
   "updates.py re-filters asks.json to an allow-list and serves who asked")
ok("UPDATES_SPOOL" not in asks, "the host half never reads bothy-ops' environment")
ok('"discover"' in post and '"autorun"' in post, "app.py routes both POSTs")
ok(re.search(r"^WRITES = \(\"request\", \"unpause\", \"discover\", \"autorun\"\)$", upd, re.M) is not None,
   "updates.py's method table names all four writes, so none of them is served over GET")

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("wiring_updates: all passed")
