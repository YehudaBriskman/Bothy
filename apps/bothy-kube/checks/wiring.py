#!/usr/bin/env python3
"""The four copies of the catalog agree, and the grants are what the files claim.

Run: python3 checks/wiring.py      (needs PyYAML - the system python3 has it)

Static: reads files only. Everything here is a property you want to know BEFORE
the RBAC is applied or the edge file lands in a watched directory.

── what it asserts ─────────────────────────────────────────────────────────

  RBAC      k8s/rbac/bothy-kube.yaml: one Role + RoleBinding per namespace in
            guard.NAMESPACES and in no other; exactly the approved verb table;
            no ClusterRole(Binding); no exec/attach/portforward/secrets/wildcards;
            the subject is bothy/bothy-kube; the SA does not automount
  EDGE      edge/dynamic/bothy-kube.yml: one router per catalog id and no other;
            each rule an exact Path(); no Host, no PathPrefix, no doubled brace;
            the role middleware matches the catalog; borrowed middlewares are
            defined elsewhere in edge/dynamic and NOT redefined here
  COMPOSE   no ports; networks exactly kubenet + thales-scc; read-only root,
            no-new-privileges, cap_drop ALL, memory cap, healthcheck; the secret
            mount is read-only and never auto-created
  TRAEFIK   edge/compose.yml puts traefik on kubenet and NOT on thales-scc
  UI        web/src/lib/kube-actions.ts KUBE_CATALOG matches id/role/confirm/
            target/stream, and KUBE_NAMESPACES matches guard.NAMESPACES
  IGNORE    the token directory is gitignored
"""
import os
import re
import sys
import tomllib

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(SVC))
sys.path.insert(0, SVC)

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
print("── EDGE: one exact Path per catalog id ──────────────────────────")
edge_dir = os.path.join(REPO, "edge/dynamic")
edge_src = open(os.path.join(edge_dir, "bothy-kube.yml"), encoding="utf-8").read()
ok("{{" not in edge_src, "no doubled brace anywhere (Go template would void the file)")
edge = yaml.safe_load(edge_src)["http"]
routers = edge["routers"]
ids_from_routers = {k[len("bothy-kube-"):] for k in routers}
ok(ids_from_routers == set(CAT), f"routers == catalog ids: {sorted(ids_from_routers)}")
ROLE_MW = {"viewer": "sso-viewer", "operator": "sso-operator"}
for name, r in routers.items():
    aid = name[len("bothy-kube-"):]
    a = CAT.get(aid)
    ok(r["rule"] == f"Path(`/-/api/kube/{aid}`)", f"{aid}: exact Path(`/-/api/kube/{aid}`)")
    ok("Host" not in r["rule"] and "PathPrefix" not in r["rule"] and "Regexp" not in r["rule"],
       f"{aid}: no Host, PathPrefix or Regexp")
    if a:
        ok(r["middlewares"] == ["bothy-kube-strip", "kube-deidentify", ROLE_MW[a.role], "sso-errors"],
           f"{aid}: middlewares strip, deidentify, {ROLE_MW[a.role]}, sso-errors")
    ok(r["service"] == "bothy-kube" and r.get("entryPoints") == ["web"], f"{aid}: service bothy-kube on web")
mws = edge.get("middlewares", {})
ok(not ({"sso-viewer", "sso-operator", "sso-errors"} & set(mws)), "borrowed middlewares are NOT redefined here")
others = ""
for fn in os.listdir(edge_dir):
    if fn.endswith(".yml") and fn != "bothy-kube.yml":
        others += open(os.path.join(edge_dir, fn), encoding="utf-8").read()
for mw in ("sso-viewer", "sso-operator", "sso-errors"):
    ok(re.search(rf"^\s{{4}}{mw}:\s*$", others, re.M) is not None, f"{mw} is still defined in another edge file")
ok(set(mws["kube-deidentify"]["headers"]["customRequestHeaders"]) >= {"X-Auth-Request-Email", "X-Auth-Request-User",
   "X-Auth-Request-Groups"}, "client X-Auth-Request-* headers are stripped")
ok(edge["services"]["bothy-kube"]["loadBalancer"]["servers"] == [{"url": "http://bothy-kube:8098"}],
   "service points at bothy-kube:8098 (over kubenet)")

# ── COMPOSE ─────────────────────────────────────────────────────────────────
print()
print("── COMPOSE: no port, two networks, locked down ──────────────────")
comp = yaml.safe_load(open(os.path.join(SVC, "compose.yml")))
svc = comp["services"]["bothy-kube"]
ok(list(comp["services"]) == ["bothy-kube"], "exactly one service")
ok("ports" not in svc and "expose" not in svc, "no ports published")
ok(sorted(svc["networks"]) == ["kubenet", "thales-scc"], f"networks exactly kubenet + thales-scc: {svc['networks']}")
ok(comp["networks"]["kubenet"].get("external") and comp["networks"]["thales-scc"].get("external"),
   "both networks are external (created by just network / by minikube)")
ok(svc.get("read_only") is True, "read-only root filesystem")
ok("no-new-privileges:true" in svc.get("security_opt", []), "no-new-privileges")
ok(svc.get("cap_drop") == ["ALL"], "cap_drop ALL")
ok(svc.get("deploy", {}).get("resources", {}).get("limits", {}).get("memory"), "a memory cap")
ok("healthcheck" in svc, "a healthcheck")
ok("traefik.enable=false" in svc.get("labels", []), "traefik.enable=false (no auto router)")
ok(not str(svc.get("user", "")).startswith("0") and "root" not in str(svc.get("user", "")), "not root")
vols = svc["volumes"]
sec = [v for v in vols if isinstance(v, dict) and v.get("target") == "/secrets"]
ok(len(sec) == 1 and sec[0].get("read_only") is True and sec[0].get("bind", {}).get("create_host_path") is False,
   "the token mount is read-only and never auto-created")
ok(not any("docker.sock" in str(v) for v in vols), "no docker socket")

tr = yaml.safe_load(open(os.path.join(REPO, "edge/compose.yml")))["services"]["traefik"]
ok("kubenet" in tr["networks"], "traefik is on kubenet")
ok("thales-scc" not in tr["networks"], "traefik is NOT on thales-scc (no route to the apiserver)")

just = open(os.path.join(REPO, "justfile"), encoding="utf-8").read()
ok("docker network create kubenet" in just, "`just network` creates kubenet")
ok(re.search(r"^apps/bothy-kube/secrets/$", open(os.path.join(REPO, ".gitignore")).read(), re.M) is not None,
   "apps/bothy-kube/secrets/ is gitignored")

# ── UI ──────────────────────────────────────────────────────────────────────
print()
print("── UI: the client's catalog copy matches ────────────────────────")
ts_path = os.path.join(REPO, "apps/bothy-web/web/src/lib/kube-actions.ts")
if not os.path.exists(ts_path):
    # The web app is being renamed portal-next -> bothy-web; follow it.
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
