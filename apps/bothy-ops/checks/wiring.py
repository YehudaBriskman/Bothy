#!/usr/bin/env python3
"""The copies of the catalog agree, and the grants are what the files claim.

Run: python3 checks/wiring.py      (needs PyYAML - the system python3 has it)

Static: reads files only. Everything here is a property you want to know BEFORE
the RBAC is applied or the edge file lands in a watched directory.

── what it asserts ─────────────────────────────────────────────────────────

  RBAC      k8s/rbac/bothy-kube.yaml: one Role + RoleBinding per namespace in
            guard.NAMESPACES and in no other; exactly the approved verb table;
            no ClusterRole(Binding); no exec/attach/portforward/secrets/wildcards;
            the subject is bothy/bothy-kube; the SA does not automount
  EDGE      edge/dynamic/bothy-ops.yml: one router per catalog id and one per
            container verb, and no other; each rule an exact Path(); no Host, no
            PathPrefix, no doubled brace; the role middleware matches the catalog
            (operator for every verb); the gates are defined in bothy-gates.yml
            and NOT redefined here
  COMPOSE   no ports; networks exactly opsnet + controlsocknet, and thales-scc
            only through the overlay; read-only root, no-new-privileges,
            cap_drop ALL, memory cap, healthcheck; the token mount is read-only,
            never auto-created, and lives only in the overlay
  TRAEFIK   edge/compose.yml puts traefik on opsnet and NOT on controlsocknet
            or thales-scc
  JUST      `just network` creates opsnet; `just up-apps` adds the overlay only
            when thales-scc exists; the retired networks are not created
  UI        web/src/lib/kube-actions.ts KUBE_CATALOG matches id/role/confirm/
            target/stream, and KUBE_NAMESPACES matches guard.NAMESPACES
  IGNORE    the token directory is gitignored

The kube ServiceAccount is still named `bothy-kube` in the cluster: it is an
identity with issued tokens, and renaming it with the container would have
revoked the live token for no security gain. That is the one place the old name
is deliberate.
"""
import os
import re
import sys
import tomllib

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(SVC))
sys.path.insert(0, SVC)
sys.path.insert(0, os.path.join(os.path.dirname(SVC), "bothy-common"))

import guard  # noqa: E402

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


with open(os.path.join(SVC, "catalog.toml"), "rb") as fh:
    CAT = guard.load_catalog(tomllib.load(fh))

# ── RBAC ────────────────────────────────────────────────────────────────────
print("── RBAC: the cluster grants exactly the table ───────────────────")
docs = [d for d in yaml.safe_load_all(open(os.path.join(REPO, "k8s/rbac/bothy-kube.yaml"))) if d]
kinds = [d["kind"] for d in docs]
ok("ClusterRole" not in kinds and "ClusterRoleBinding" not in kinds, "no ClusterRole, no ClusterRoleBinding")
ok(set(kinds) <= {"Namespace", "ServiceAccount", "Role", "RoleBinding"}, f"only namespaced RBAC kinds: {sorted(set(kinds))}")

sa = [d for d in docs if d["kind"] == "ServiceAccount"]
ok(len(sa) == 1 and sa[0]["metadata"] == {**sa[0]["metadata"], "name": "bothy-kube", "namespace": "bothy"},
   "one ServiceAccount, bothy/bothy-kube")
ok(sa and sa[0].get("automountServiceAccountToken") is False, "the SA never automounts into a pod")

WANT = {
    ("apps", "deployments"): {"get", "list", "patch"},
    ("apps", "deployments/scale"): {"get", "patch"},
    ("", "pods"): {"get", "list", "delete"},
    ("", "pods/log"): {"get"},
    ("", "events"): {"list"},
}
roles = [d for d in docs if d["kind"] == "Role"]
ok(sorted(r["metadata"]["namespace"] for r in roles) == sorted(guard.NAMESPACES),
   f"one Role per guard.NAMESPACES and no other: {sorted(r['metadata']['namespace'] for r in roles)}")
FORBIDDEN_RES = {"pods/exec", "pods/attach", "pods/portforward", "secrets", "configmaps",
                 "serviceaccounts/token", "*"}
FORBIDDEN_VERBS = {"*", "create", "update", "deletecollection", "escalate", "bind", "impersonate", "watch"}
for r in roles:
    ns = r["metadata"]["namespace"]
    got: dict[tuple[str, str], set[str]] = {}
    for rule in r.get("rules", []):
        for g in rule.get("apiGroups", []):
            for res in rule.get("resources", []):
                got.setdefault((g, res), set()).update(rule.get("verbs", []))
                ok(g != "*", f"{ns}: no wildcard apiGroup")
    ok(got == WANT, f"{ns}: grants exactly the approved table")
    res_all = {res for _, res in got}
    verbs_all = set().union(*got.values()) if got else set()
    ok(not (res_all & FORBIDDEN_RES), f"{ns}: no exec/attach/portforward/secrets/configmaps/wildcard")
    ok(not (verbs_all & FORBIDDEN_VERBS), f"{ns}: no create/update/watch/deletecollection/escalate/bind/impersonate")

bindings = [d for d in docs if d["kind"] == "RoleBinding"]
ok(sorted(b["metadata"]["namespace"] for b in bindings) == sorted(guard.NAMESPACES),
   "one RoleBinding per namespace")
for b in bindings:
    ok(b["roleRef"] == {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "bothy-kube"}
       and b["subjects"] == [{"kind": "ServiceAccount", "name": "bothy-kube", "namespace": "bothy"}],
       f"{b['metadata']['namespace']}: binds Role bothy-kube to bothy/bothy-kube only")

# ── EDGE ────────────────────────────────────────────────────────────────────
print()
print("── EDGE: one exact Path per catalog id and per verb ─────────────")
edge_dir = os.path.join(REPO, "edge/dynamic")
edge_src = open(os.path.join(edge_dir, "bothy-ops.yml"), encoding="utf-8").read()
ok("{{" not in edge_src, "no doubled brace anywhere (Go template would void the file)")
edge = yaml.safe_load(edge_src)["http"]
routers = edge["routers"]
KUBE_P, CONTROL_P = "bothy-ops-kube-", "bothy-ops-control-"
ok(all(k.startswith((KUBE_P, CONTROL_P)) for k in routers),
   f"every router is a kube action or a container verb: {sorted(routers)}")
ids_from_routers = {k[len(KUBE_P):] for k in routers if k.startswith(KUBE_P)}
verbs_from_routers = {k[len(CONTROL_P):] for k in routers if k.startswith(CONTROL_P)}
ok(ids_from_routers == set(CAT), f"kube routers == catalog ids: {sorted(ids_from_routers)}")
ok(verbs_from_routers == set(guard.VERBS), f"control routers == guard.VERBS: {sorted(verbs_from_routers)}")
ROLE_MW = {"viewer": "sso-viewer", "operator": "sso-operator"}
for name, r in routers.items():
    if name.startswith(KUBE_P):
        aid, path, role = name[len(KUBE_P):], f"/-/api/kube/{name[len(KUBE_P):]}", None
        role = CAT[aid].role if aid in CAT else None
    else:
        aid, path, role = name[len(CONTROL_P):], f"/-/api/control/{name[len(CONTROL_P):]}", "operator"
    ok(r["rule"] == f"Path(`{path}`)", f"{name}: exact Path(`{path}`)")
    ok("Host" not in r["rule"] and "PathPrefix" not in r["rule"] and "Regexp" not in r["rule"],
       f"{name}: no Host, PathPrefix or Regexp")
    if role:
        ok(r["middlewares"] == ["bothy-ops-strip", "ops-deidentify", ROLE_MW[role], "sso-errors"],
           f"{name}: middlewares strip, deidentify, {ROLE_MW[role]}, sso-errors")
    ok(r["service"] == "bothy-ops" and r.get("entryPoints") == ["web"], f"{name}: service bothy-ops on web")
mws = edge.get("middlewares", {})
ok(not ({"sso-viewer", "sso-editor", "sso-operator", "sso-errors"} & set(mws)),
   "no gate is redefined here")
gates = yaml.safe_load(open(os.path.join(edge_dir, "bothy-gates.yml"), encoding="utf-8"))["http"]["middlewares"]
ok(set(gates) == {"sso-viewer", "sso-editor", "sso-operator"},
   f"bothy-gates.yml defines exactly the three gates: {sorted(gates)}")
for role in ("viewer", "editor", "operator"):
    ok(gates.get(f"sso-{role}", {}).get("forwardAuth", {}).get("address", "").endswith(f"allowed_groups={role}"),
       f"sso-{role} asks oauth2-proxy for group {role}")
others = {}
for fn in sorted(os.listdir(edge_dir)):
    if fn.endswith(".yml") and fn != "bothy-gates.yml":
        others[fn] = open(os.path.join(edge_dir, fn), encoding="utf-8").read()
for mw in ("sso-viewer", "sso-editor", "sso-operator"):
    defs = [fn for fn, src in others.items() if re.search(rf"^\s{{4}}{mw}:\s*$", src, re.M)]
    ok(not defs, f"{mw} is defined ONLY in bothy-gates.yml (also in: {defs or 'nowhere'})")
ok(re.search(r"^\s{4}sso-errors:\s*$", others.get("auth.yml", ""), re.M) is not None,
   "sso-errors is still defined in auth.yml")
ok(set(mws["ops-deidentify"]["headers"]["customRequestHeaders"]) >= {"X-Auth-Request-Email", "X-Auth-Request-User",
   "X-Auth-Request-Groups"}, "client X-Auth-Request-* headers are stripped")
ok(edge["services"]["bothy-ops"]["loadBalancer"]["servers"] == [{"url": "http://bothy-ops:8097"}],
   "service points at bothy-ops:8097 (over opsnet)")
ign = open(os.path.join(edge_dir, ".gitignore"), encoding="utf-8").read()
for fn in ("bothy-ops.yml", "bothy-gates.yml"):
    ok(re.search(rf"^!{re.escape(fn)}$", ign, re.M) is not None,
       f"edge/dynamic/.gitignore allow-lists {fn} (the directory denies `*`)")
for fn in ("bothy-control.yml", "bothy-kube.yml"):
    ok(not os.path.exists(os.path.join(edge_dir, fn)), f"the retired {fn} is gone")

# ── COMPOSE ─────────────────────────────────────────────────────────────────
print()
print("── COMPOSE: no port, one way in, locked down ────────────────────")
comp = yaml.safe_load(open(os.path.join(SVC, "compose.yml")))
svc = comp["services"]["bothy-ops"]
ok(list(comp["services"]) == ["bothy-ops"], "exactly one service")
ok("ports" not in svc and "expose" not in svc, "no ports published")
ok(sorted(svc["networks"]) == ["controlsocknet", "opsnet"],
   f"networks exactly opsnet + controlsocknet: {svc['networks']}")
ok(all(comp["networks"][n].get("external") for n in ("opsnet", "controlsocknet")),
   "both networks are external (created by just network)")
ok("thales-scc" not in comp.get("networks", {}),
   "thales-scc is NOT in compose.yml - a missing external network would fail the whole project")
ok(svc.get("read_only") is True, "read-only root filesystem")
ok("no-new-privileges:true" in svc.get("security_opt", []), "no-new-privileges")
ok(svc.get("cap_drop") == ["ALL"], "cap_drop ALL")
ok(svc.get("deploy", {}).get("resources", {}).get("limits", {}).get("memory"), "a memory cap")
ok("healthcheck" in svc, "a healthcheck")
ok("traefik.enable=false" in svc.get("labels", []), "traefik.enable=false (no auto router)")
ok(not str(svc.get("user", "")).startswith("0") and "root" not in str(svc.get("user", "")), "not root")
vols = svc["volumes"]
ok(not any("docker.sock" in str(v) for v in vols), "no docker socket")
ok(not any(isinstance(v, dict) and v.get("target") == "/secrets" for v in vols),
   "no token mount in the base file - it rides with the cluster network")

over = yaml.safe_load(open(os.path.join(SVC, "compose.cluster.yml")))
osvc = over["services"]["bothy-ops"]
ok(list(over["services"]) == ["bothy-ops"], "the overlay touches bothy-ops only")
ok(sorted(osvc["networks"]) == ["controlsocknet", "opsnet", "thales-scc"],
   f"the overlay adds thales-scc and nothing else: {osvc['networks']}")
ok(over["networks"]["thales-scc"].get("external") is True, "thales-scc is external (created by minikube)")
sec = [v for v in osvc.get("volumes", []) if isinstance(v, dict) and v.get("target") == "/secrets"]
ok(len(sec) == 1 and sec[0].get("read_only") is True and sec[0].get("bind", {}).get("create_host_path") is False,
   "the token mount is read-only and never auto-created")
ok(sec and sec[0].get("source") == "../bothy-ops/secrets",
   "the token source is spelled so it resolves from apps/bothy AND apps/bothy-ops")
ok(not any("docker.sock" in str(v) for v in osvc.get("volumes", [])), "the overlay adds no docker socket")

tr = yaml.safe_load(open(os.path.join(REPO, "edge/compose.yml")))["services"]["traefik"]
ok("opsnet" in tr["networks"], "traefik is on opsnet")
ok("thales-scc" not in tr["networks"], "traefik is NOT on thales-scc (no route to the apiserver)")
ok("controlsocknet" not in tr["networks"], "traefik is NOT on controlsocknet (no route to the write proxy)")
for gone in ("controlnet", "kubenet", "confignet"):
    ok(gone not in tr["networks"], f"traefik no longer joins the retired {gone}")

bothy = yaml.safe_load(open(os.path.join(REPO, "apps/bothy/compose.yml")))
inc = sorted(i["path"] if isinstance(i, dict) else i for i in bothy.get("include", []))
ok(inc == sorted(["../bothy-web/compose.yml", "../bothy-files/compose.yml",
                  "../bothy-ops/compose.yml", "./socket-proxy.yml"]),
   f"apps/bothy/compose.yml includes exactly web, files, ops and the proxies: {inc}")

just = open(os.path.join(REPO, "justfile"), encoding="utf-8").read()
ok("docker network create opsnet" in just, "`just network` creates opsnet")
for gone in ("controlnet", "kubenet", "confignet"):
    ok(f"docker network create {gone}" not in just, f"`just network` no longer creates {gone}")
ok(re.search(r"^up-kube", just, re.M) is None, "`just up-kube` is gone - up-apps covers the cluster")
upapps = just.split("\nup-apps", 1)[1].split("\n\n", 1)[0] if "\nup-apps" in just else ""
ok("docker network inspect thales-scc" in upapps and "apps/bothy-ops/compose.cluster.yml" in upapps,
   "`just up-apps` adds compose.cluster.yml only when thales-scc exists")
ok(re.search(r"^apps/bothy-ops/secrets/$", open(os.path.join(REPO, ".gitignore")).read(), re.M) is not None,
   "apps/bothy-ops/secrets/ is gitignored")
_dign = [ln.strip() for ln in open(os.path.join(REPO, "apps/.dockerignore"), encoding="utf-8")
         if ln.strip() and not ln.lstrip().startswith("#")]
ok(bool(_dign) and _dign[0] == "*" and all(ln.startswith("!") for ln in _dign[1:])
   and not any("secrets" in ln or "audit" in ln for ln in _dign),
   "apps/.dockerignore is an allowlist, so the cluster token never enters a build context")

# ── UI ──────────────────────────────────────────────────────────────────────
print()
print("── UI: the client's catalog copy matches ────────────────────────")
ts_path = os.path.join(REPO, "apps/bothy-web/web/src/lib/kube-actions.ts")
ts = open(ts_path, encoding="utf-8").read()
entries = re.findall(r"\{ id: '([a-z-]+)', title: '[^']*', role: '(\w+)', confirm: '([\w-]+)', "
                     r"target: '(\w+)', stream: (true|false)", ts)
got = {e[0]: (e[1], e[2], e[3], e[4] == "true") for e in entries}
want = {a.id: (a.role, a.confirm, a.target, a.stream) for a in CAT.values()}
ok(got == want, f"KUBE_CATALOG == catalog.toml ({len(got)} entries)")
m = re.search(r"KUBE_NAMESPACES: readonly string\[\] = \[([^\]]*)\]", ts)
ok(m is not None and tuple(re.findall(r"'([^']+)'", m.group(1))) == guard.NAMESPACES,
   "KUBE_NAMESPACES == guard.NAMESPACES")
sm = re.search(r"SCALE_MAX = (\d+)", ts)
ok(sm is not None and int(sm.group(1)) == CAT["scale"].params["replicas"].max, "SCALE_MAX == catalog max")

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("wiring: all passed")
