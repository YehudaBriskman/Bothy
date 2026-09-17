#!/usr/bin/env python3
"""The boundary as a pure unit. Needs nothing running - not docker, not a cluster.

Run: python3 checks/test_guard_kube.py

── what it asserts ─────────────────────────────────────────────────────────

  CATALOG     the shipped catalog loads, declares exactly the approved actions
              with their roles/confirm levels/targets, and matches HANDLERS
  RBAC        a declaration of secrets, exec, attach, portforward, watch,
              escalate, bind, impersonate, wildcards, namespaces, or a write
              outside the approved pairs refuses to load
  POLICY      permissive allowlists refuse to load (empty/newline patterns)
  IMAGE       OCI reference + registry prefix, enumerated both ways
  CONFIGMAP   one ConfigMap, allowlisted keys, per-key value patterns,
              type-name confirmation of the KEY
  TEMPLATES   a template is named from the allowlist, never sent
  PARITY      a catalog id without a handler, or a handler without an id,
              refuses to start - in both directions
  FORMAT      the catalog format refuses the permissive mistakes: missing keys,
              unknown keys, operator GET, operator confirm=none, unbounded ints
  SCOPE       exactly two namespaces; kube-system, thales and friends refused
  NAMES       every traversal / injection shape refused, enumerated not sampled
  PARAMS      types, bounds, unknown keys, bool-as-int, repeated-looking junk
  CONFIRM     type-name demands confirm == target, from the service too
"""
import os
import sys
import tomllib

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)
sys.path.insert(0, os.path.join(os.path.dirname(SVC), "bothy-common"))

import guard  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def refuses(fn, *args, label: str, status: int | None = None) -> None:
    try:
        fn(*args)
    except guard.Refused as e:
        if status is not None and e.status != status:
            ok(False, f"{label} (refused, but {e.status} not {status})")
        else:
            ok(True, f"{label} -> {e.status}")
        return
    ok(False, f"{label} (NOT REFUSED)")


def catalog_error(doc, label: str) -> None:
    try:
        guard.load_catalog(doc)
    except guard.CatalogError as e:
        ok(True, f"{label} -> {str(e)[:70]}")
        return
    ok(False, f"{label} (ACCEPTED)")


with open(os.path.join(SVC, "catalog.toml"), "rb") as fh:
    RAW = tomllib.load(fh)
CAT = guard.load_catalog(RAW)

print("── the shipped catalog ──────────────────────────────────────────")
# id: (role, confirm, method, target, stream). Written out, not derived: this is
# the table a reviewer approves, and the catalog has to match it.
want = {
    "deployments": ("viewer", "none", "GET", "namespace", False),
    "rollout-status": ("viewer", "none", "GET", "deployment", False),
    "rollout-history": ("viewer", "none", "GET", "deployment", False),
    "rollback-to-revision": ("operator", "type-name", "POST", "deployment", False),
    "pause": ("operator", "click", "POST", "deployment", False),
    "resume": ("operator", "click", "POST", "deployment", False),
    "set-image": ("operator", "type-name", "POST", "deployment", False),
    "rollout-restart": ("operator", "click", "POST", "deployment", False),
    "scale": ("operator", "type-name", "POST", "deployment", False),
    "events": ("viewer", "none", "GET", "deployment", False),
    "logs": ("viewer", "none", "GET", "deployment", True),
    "pods": ("viewer", "none", "GET", "namespace", False),
    "delete-pod": ("operator", "click", "POST", "pod", False),
    "delete-completed-pods": ("operator", "click", "POST", "namespace", False),
    "jobs": ("viewer", "none", "GET", "namespace", False),
    "job-logs": ("viewer", "none", "GET", "job", False),
    "delete-job": ("operator", "click", "POST", "job", False),
    "run-template": ("operator", "type-name", "POST", "template", False),
    "configmap": ("viewer", "none", "GET", "configmap", False),
    "patch-key": ("operator", "type-name", "POST", "configmap", False),
    "patch-key-and-restart": ("operator", "type-name", "POST", "configmap", False),
    "services": ("viewer", "none", "GET", "namespace", False),
    "routes": ("viewer", "none", "GET", "namespace", False),
    "ingresses": ("viewer", "none", "GET", "namespace", False),
    "persistentvolumeclaims": ("viewer", "none", "GET", "namespace", False),
    "networkpolicies": ("viewer", "none", "GET", "namespace", False),
    "resourcequotas": ("viewer", "none", "GET", "namespace", False),
    "limitranges": ("viewer", "none", "GET", "namespace", False),
    "namespace-events": ("viewer", "none", "GET", "namespace", False),
}
ok(set(CAT) == set(want), f"exactly the approved {len(want)} actions: {sorted(set(CAT) ^ set(want)) or 'match'}")
for aid, (role, confirm, method, target, stream) in want.items():
    a = CAT.get(aid)
    ok(a is not None and (a.role, a.confirm, a.method, a.target, a.stream)
       == (role, confirm, method, target, stream),
       f"{aid}: {role}, confirm {confirm}, {method}, target {target}, stream {stream}")
ok(all(a.meaning for a in CAT.values()), "every action carries a meaning for the UI")
ok(all(a.rbac for a in CAT.values()), "every action declares what it calls (rbac)")
ok(all(v in ("get", "list") for a in CAT.values() if a.role == "viewer" for g in a.rbac for v in g.verbs),
   "every viewer action declares only get/list")
ok(CAT.policy.configmaps == ("thales",), f"configmaps allowlist is exactly thales: {CAT.policy.configmaps}")
ok(CAT.policy.image_registries == ("thales/", "localhost:5000/thales/"),
   f"image registries: {CAT.policy.image_registries}")
ok(CAT.policy.job_templates == ("migrate", "seed-identity", "seed-reference"),
   f"job templates: {CAT.policy.job_templates}")
ok(set(CAT.policy.configmap_keys) == {"LOG_LEVEL", "DB_POOL_MAX", "JOB_MAX_WORKERS"},
   f"configmap keys: {sorted(CAT.policy.configmap_keys)}")
ok(CAT["scale"].params["replicas"].min == 0 and CAT["scale"].params["replicas"].max == 3,
   "scale.replicas is bounded 0..3")
ok(CAT["logs"].params["tail"].max == 500, "logs.tail is bounded at 500")
ok(CAT["logs"].params["seconds"].max <= 300, "a follow is bounded at <= 300 seconds")

# Parity with kube.py's HANDLERS, read as source rather than imported so this
# file needs nothing app.py imports.
src = open(os.path.join(SVC, "kube.py"), encoding="utf-8").read()
start = src.index("HANDLERS = {")
block = src[start:src.index("}", start)]
import re  # noqa: E402
handler_ids = set(re.findall(r'^\s+"([a-z-]+)":\s*h_', block, re.M))
ok(handler_ids == set(CAT), f"kube.HANDLERS keys == catalog ids: {sorted(handler_ids)}")

print()
print("── catalog/handler parity refuses to start ──────────────────────")
try:
    guard.check_handlers(CAT.keys(), handler_ids)
    ok(True, "shipped catalog and handlers agree")
except guard.CatalogError as e:
    ok(False, f"shipped catalog and handlers disagree: {e}")
for label, cat_ids, han_ids in (
    ("catalog id with no handler", set(CAT) | {"exec"}, handler_ids),
    ("handler with no catalog id", set(CAT), handler_ids | {"port-forward"}),
    ("both directions at once", set(CAT) - {"scale"}, handler_ids | {"exec"}),
):
    try:
        guard.check_handlers(cat_ids, han_ids)
        ok(False, f"{label} (STARTED)")
    except guard.CatalogError as e:
        ok(True, f"{label} -> {str(e)[:70]}")

print()
print("── the catalog format refuses the permissive mistakes ───────────")
base = {"title": "x", "meaning": "x", "target": "deployment", "method": "POST", "role": "operator",
        "confirm": "click", "stream": False, "rbac": [{"resource": "deployments", "verbs": ["get", "patch"]}]}


def one(**kw):
    a = {**base, **kw}
    return {"actions": {"x": {k: v for k, v in a.items() if v is not None}}}


catalog_error({}, "empty document")
catalog_error({"actions": {}, "extra": 1}, "unknown top-level table")
catalog_error(one(role=None), "missing role (no default)")
catalog_error(one(confirm=None), "missing confirm (no default)")
catalog_error(one(rol="viewer"), "typo'd key `rol`")
catalog_error(one(role="admin"), "unknown role")
catalog_error(one(method="GET"), "operator action over GET")
catalog_error(one(confirm="none"), "operator action with confirm=none")
catalog_error(one(role="viewer", confirm="none"), "viewer action over POST")
catalog_error(one(role="viewer", method="GET", confirm="none", target="cluster"), "unknown target")
catalog_error(one(stream=True), "a POST that streams")
catalog_error(one(stream="yes"), "stream not a bool")
catalog_error(one(params={"n": {"type": "int"}}), "int param with no bounds")
catalog_error(one(params={"n": {"type": "int", "min": 0, "max": True}}), "bool as int bound")
catalog_error(one(params={"n": {"type": "int", "min": 5, "max": 1}}), "min > max")
catalog_error(one(params={"n": {"type": "int", "min": 0, "max": 3, "default": 9}}), "default out of range")
catalog_error(one(params={"namespace": {"type": "name"}}), "param shadows a reserved key")
catalog_error(one(params={"n": {"type": "path"}}), "unknown param type")
catalog_error(one(params={"n": {"type": "name", "default": "x"}}), "name param with a default")
catalog_error(one(params={"n": {"type": "int", "min": 0, "max": 3, "required": True, "default": 1}}),
              "required and default together")
catalog_error({"actions": {"Exec/../x": base}}, "malformed id")
catalog_error(one(meaning=None), "missing meaning")
catalog_error(one(rbac=None), "missing rbac (a handler that calls nothing is not a handler)")
catalog_error({"actions": {"catalog": {**base, "role": "viewer", "method": "GET", "confirm": "none",
               "rbac": [{"resource": "deployments", "verbs": ["get"]}]}}}, "an action named catalog")
catalog_error(one(target="template"), "a template target with no job_templates")
catalog_error(one(target="configmap"), "a configmap target with no configmaps")
catalog_error(one(params={"img": {"type": "image", "required": True}}), "an image param with no registries")
catalog_error(one(params={"v": {"type": "configmap-value"}}), "a configmap-value with no key param")
catalog_error(one(target="pod", params={"pod": {"type": "name"}}), "a param shadowing the action's own target")

print()
print("── rbac declarations: what the generated Role may never hold ────")
for label, grant, role in (
    ("secrets", {"resource": "secrets", "verbs": ["get"]}, "viewer"),
    ("secrets list", {"resource": "secrets", "verbs": ["list"]}, "viewer"),
    ("pods/exec", {"resource": "pods", "subresource": "exec", "verbs": ["create"]}, "operator"),
    ("pods/exec get", {"resource": "pods", "subresource": "exec", "verbs": ["get"]}, "viewer"),
    ("pods/attach", {"resource": "pods", "subresource": "attach", "verbs": ["create"]}, "operator"),
    ("pods/portforward", {"resource": "pods", "subresource": "portforward", "verbs": ["create"]}, "operator"),
    ("a watch", {"resource": "pods", "verbs": ["watch"]}, "viewer"),
    ("escalate", {"resource": "deployments", "verbs": ["escalate"]}, "operator"),
    ("bind", {"resource": "deployments", "verbs": ["bind"]}, "operator"),
    ("impersonate", {"resource": "deployments", "verbs": ["impersonate"]}, "operator"),
    ("a wildcard verb", {"resource": "deployments", "verbs": ["*"]}, "operator"),
    ("a wildcard resource", {"resource": "*", "verbs": ["get"]}, "viewer"),
    ("create namespaces", {"resource": "namespaces", "verbs": ["create"]}, "operator"),
    ("delete namespaces", {"resource": "namespaces", "verbs": ["delete"]}, "operator"),
    ("create pods", {"resource": "pods", "verbs": ["create"]}, "operator"),
    ("delete deployments", {"resource": "deployments", "verbs": ["delete"]}, "operator"),
    ("patch jobs", {"resource": "jobs", "verbs": ["patch"]}, "operator"),
    ("update", {"resource": "deployments", "verbs": ["update"]}, "operator"),
    ("deletecollection", {"resource": "pods", "verbs": ["deletecollection"]}, "operator"),
    ("roles", {"resource": "roles", "verbs": ["get"]}, "viewer"),
    ("an unknown resource", {"resource": "cronjobs", "verbs": ["get"]}, "viewer"),
    ("an unknown subresource", {"resource": "deployments", "subresource": "status", "verbs": ["get"]}, "viewer"),
    ("an unknown key", {"resource": "deployments", "verbs": ["get"], "resourceNames": ["x"]}, "viewer"),
    ("a viewer that patches", {"resource": "deployments", "verbs": ["patch"]}, "viewer"),
):
    extra = {"role": "viewer", "method": "GET", "confirm": "none"} if role == "viewer" else {}
    catalog_error(one(rbac=[grant], **extra), f"rbac: {label}")

print()
print("── policy: the allowlists refuse the permissive mistakes ────────")


def pol(**kw):
    return {**one(), **kw}


catalog_error(pol(configmap_keys={"LOG_LEVEL": {"pattern": ".*", "meaning": "x"}}), "a key pattern that accepts empty")
catalog_error(pol(configmap_keys={"LOG_LEVEL": {"pattern": "[a-z\\n]+", "meaning": "x"}}),
              "a key pattern that accepts a newline")
catalog_error(pol(configmap_keys={"LOG_LEVEL": {"pattern": "(", "meaning": "x"}}), "a key pattern that does not compile")
catalog_error(pol(configmap_keys={"LOG LEVEL": {"pattern": "a", "meaning": "x"}}), "a malformed key")
catalog_error(pol(configmap_keys={"LOG_LEVEL": {"pattern": "a"}}), "a key without meaning")
catalog_error(pol(image_registries=["docker.io"]), "a registry prefix without a trailing slash")
catalog_error(pol(image_registries=[""]), "an empty registry prefix (would allow everything)")
catalog_error(pol(image_registries=["thales/", "thales/"]), "a repeated registry prefix")
catalog_error(pol(job_templates=["../migrate"]), "a template name with a path")
catalog_error(pol(configmaps=["thales", "kube-root-ca.crt"]), "a configmap name with a dot")

print()
print("── scope: two namespaces, and nothing else ──────────────────────")
ok(guard.NAMESPACES == ("thales-dev", "thales-pre-prod"),
   f"a literal tuple of two: {guard.NAMESPACES}")
for ns in guard.NAMESPACES:
    ok(guard.check_namespace(ns) == ns, f"{ns} allowed")
for ns in ("kube-system", "kube-public", "default", "thales", "thales-prod", "bothy",
           "kyverno", "ingress-nginx", "THALES-DEV", "thales-dev ", " thales-dev",
           "thales-dev/../kube-system", "thales-dev%2f..", "*", "thales-*"):
    refuses(guard.check_namespace, ns, label=f"namespace {ns!r} refused", status=403)
for ns in ("", None, 3, ["thales-dev"], {"a": 1}):
    refuses(guard.check_namespace, ns, label=f"namespace {ns!r} refused", status=400)

print()
print("── names: one path segment, and never more ──────────────────────")
for n in ("frontend", "algorithm", "a", "a-b-c", "x" * 63, "frontend-5d8f7c9b4-abcde", "0abc"):
    ok(guard.valid_name(n) == n, f"{n[:30]!r} allowed")
for n in ("", "..", ".", "a/b", "frontend/scale", "../secrets", "frontend/../../secrets",
          "frontend%2f..", "frontend?x=1", "frontend#x", "frontend\n", "front end",
          "Frontend", "-frontend", "frontend-", "front.end", "x" * 64, "frontend\x00",
          "frоntend", "frontend;rm", "frontend&follow=true", "secrets", None, 7):
    # `secrets` IS a valid name - and still unreachable, because it is only ever
    # a deployment name inside /deployments/<name>. Asserted separately below.
    if n == "secrets":
        continue
    refuses(guard.valid_name, n, label=f"name {n!r} refused", status=400)
ok(guard.valid_name("secrets") == "secrets",
   "`secrets` is a legal NAME - it can only ever be a deployment called that")

print()
print("── a whole request ──────────────────────────────────────────────")


def req_ok(aid, method, req, label):
    try:
        a, ns, target, params = guard.check_request(CAT, aid, method, req)
        ok(True, f"{label} -> {ns}/{target} {params}")
        return params
    except guard.Refused as e:
        ok(False, f"{label} (refused: {e})")
        return None


def req_no(aid, method, req, label, status):
    refuses(guard.check_request, CAT, aid, method, req, label=label, status=status)


req_ok("rollout-restart", "POST", {"namespace": "thales-dev", "deployment": "frontend"}, "rollout-restart")
p = req_ok("scale", "POST", {"namespace": "thales-dev", "deployment": "algorithm",
                             "replicas": 1, "confirm": "algorithm"}, "scale 1 with confirm")
ok(p == {"replicas": 1}, "scale params coerced")
p = req_ok("events", "GET", {"namespace": "thales-dev", "deployment": "frontend"}, "events, defaults")
ok(p == {"limit": 50}, "events default limit applied")
p = req_ok("logs", "GET", {"namespace": "thales-pre-prod", "deployment": "backend", "tail": "500",
                           "follow": "true", "seconds": "30"}, "logs from a query string")
ok(p == {"tail": 500, "follow": True, "seconds": 30, "pod": None, "container": None, "previous": False},
   "logs params coerced from strings")
req_ok("delete-completed-pods", "POST", {"namespace": "thales-dev"}, "delete-completed-pods")

for aid in ("exec", "port-forward", "secrets", "get-secret", "apply", "delete", "Scale",
            "scale ", "scale/../exec", "", "healthz", "rollout-restart/x"):
    req_no(aid, "POST", {"namespace": "thales-dev", "deployment": "frontend"},
           f"unknown action {aid!r}", 404)
req_no("scale", "GET", {"namespace": "thales-dev", "deployment": "x", "replicas": "1", "confirm": "x"},
       "a change over GET", 405)
req_no("events", "POST", {"namespace": "thales-dev", "deployment": "x"}, "a read over POST", 405)
req_no("rollout-restart", "POST", {"namespace": "kube-system", "deployment": "coredns"},
       "rollout-restart in kube-system", 403)
req_no("logs", "GET", {"namespace": "kube-system", "deployment": "coredns"}, "logs in kube-system", 403)
req_no("events", "GET", {"deployment": "frontend"}, "no namespace", 400)
req_no("events", "GET", {"namespace": "thales-dev"}, "no deployment", 400)
req_no("delete-completed-pods", "POST", {"namespace": "thales-dev", "deployment": "frontend"},
       "namespace action given a deployment", 400)

print()
print("── parameters: declared, typed, bounded ─────────────────────────")
S = {"namespace": "thales-dev", "deployment": "algorithm", "confirm": "algorithm"}
for r in (-1, 4, 10, 10000, "4", "-1", "1.0", "1e1", " 1", "0x1", True, False, None, 1.0, [1], "one"):
    req_no("scale", "POST", {**S, "replicas": r}, f"replicas={r!r}", 400)
for r in (0, 3, "0", "3"):
    req_ok("scale", "POST", {**S, "replicas": r}, f"replicas={r!r}")
req_no("scale", "POST", {k: v for k, v in S.items()}, "replicas missing", 400)
req_no("rollout-restart", "POST", {"namespace": "thales-dev", "deployment": "x", "image": "evil"},
       "an undeclared parameter", 400)
req_no("rollout-restart", "POST", {"namespace": "thales-dev", "deployment": "x", "confirm": "x"},
       "confirm on a click-level action", 400)
L = {"namespace": "thales-dev", "deployment": "frontend"}
for t in ("0", "501", "-5", "all", "1000000"):
    req_no("logs", "GET", {**L, "tail": t}, f"tail={t!r}", 400)
for s in ("4", "301", "3600"):
    req_no("logs", "GET", {**L, "seconds": s}, f"seconds={s!r}", 400)
for f in ("yes", "on", "TRUE", "", "2"):
    req_no("logs", "GET", {**L, "follow": f}, f"follow={f!r}", 400)
for pod in ("../postgres", "postgres/log", "x?follow=true"):
    req_no("logs", "GET", {**L, "pod": pod}, f"pod={pod!r}", 400)
req_no("logs", "GET", {**L, "sinceTime": "1"}, "undeclared logs param `sinceTime`", 400)
for pv in ("yes", "2", ""):
    req_no("logs", "GET", {**L, "previous": pv}, f"previous={pv!r}", 400)
p = req_ok("logs", "GET", {**L, "previous": "true", "container": "frontend"}, "logs previous + container")
ok(p is not None and p["previous"] is True and p["container"] == "frontend", "previous and container coerced")
req_no("logs", "GET", {**L, "sinceSeconds": "1"}, "undeclared logs param `sinceSeconds`", 400)

print()
print("── type-name is enforced by the service too ─────────────────────")
for c in (None, "", "algorithm ", "Algorithm", "frontend", "thales-dev", 1):
    body = {**S, "replicas": 1}
    if c is None:
        body.pop("confirm")
    else:
        body["confirm"] = c
    req_no("scale", "POST", body, f"scale with confirm={c!r}", 400)

print()
print("── image: an OCI reference, from an allowed registry ────────────")
REG = CAT.policy.image_registries
for img in ("thales/backend:0.1.7", "thales/frontend:0.1.8-rc.1", "localhost:5000/thales/backend:0.1.7",
            "thales/backend@sha256:" + "a" * 64, "thales/backend:0.1.7@sha256:" + "0" * 64,
            "thales/sub/path:v1", "thales/a_b:1", "thales/a__b:1", "thales/a--b:1"):
    try:
        ok(guard.valid_image(img, REG) == img, f"image {img[:50]!r} allowed")
    except guard.Refused as e:
        ok(False, f"image {img[:50]!r} (refused: {e})")
for img, status in (
    ("docker.io/library/nginx:1.27", 403), ("nginx:1.27", 403), ("ghcr.io/thales/backend:1", 403),
    ("docker.io/thales/backend:1", 403), ("thalesx/backend:1", 403), ("localhost:5001/thales/x:1", 403),
    ("evil.com/thales/backend:1", 403), ("thales.evil.com/backend:1", 403),
    ("thales/backend", 400), ("thales/backend:", 400), ("thales/../backend:1", 400),
    ("thales//backend:1", 400), ("Thales/backend:1", 400), ("thales/backend:1 ", 400),
    (" thales/backend:1", 400), ("thales/backend:1\n", 400), ("https://thales/backend:1", 400),
    ("thales/backend:1;rm -rf", 400), ("thales/backend:-bad", 400), ("thales/backend@sha256:abc", 400),
    ("thales/backend:" + "a" * 129, 400), ("thales/" + "a" * 260 + ":1", 400), ("", 400), (None, 400), (7, 400),
):
    refuses(guard.valid_image, img, REG, label=f"image {str(img)[:50]!r} refused", status=status)
SI = {"namespace": "thales-dev", "deployment": "backend", "confirm": "backend", "container": "backend"}
p = req_ok("set-image", "POST", {**SI, "image": "thales/backend:0.1.7"}, "set-image to a thales image")
ok(p == {"container": "backend", "image": "thales/backend:0.1.7"}, "set-image params")
req_no("set-image", "POST", {**SI, "image": "docker.io/library/busybox:1"}, "set-image from docker.io", 403)
req_no("set-image", "POST", {**SI, "image": "thales/backend:1", "confirm": "frontend"}, "set-image, wrong confirm", 400)
for cn in ("../backend", "Backend", "backend/x", "", None):
    body = {**SI, "image": "thales/backend:1", "container": cn}
    req_no("set-image", "POST", body, f"set-image container={cn!r}", 400)
req_no("set-image", "POST", {k: v for k, v in SI.items() if k != "container"} | {"image": "thales/b:1"},
       "set-image without a container", 400)

print()
print("── configmaps: one ConfigMap, allowlisted keys, per-key values ───")
CM = {"namespace": "thales-dev", "configmap": "thales"}
req_ok("configmap", "GET", CM, "view thales")
for other, status in (("kube-root-ca.crt", 400), ("thales-secrets", 403), ("other", 403), ("../secrets", 400)):
    req_no("configmap", "GET", {**CM, "configmap": other}, f"view configmap {other!r}", status)
for key, value in (("LOG_LEVEL", "debug"), ("LOG_LEVEL", "info"), ("LOG_LEVEL", "warn"), ("LOG_LEVEL", "error"),
                   ("DB_POOL_MAX", "1"), ("DB_POOL_MAX", "10"), ("DB_POOL_MAX", "20"),
                   ("JOB_MAX_WORKERS", "1"), ("JOB_MAX_WORKERS", "4")):
    p = req_ok("patch-key", "POST", {**CM, "key": key, "value": value, "confirm": key}, f"{key}={value}")
    ok(p == {"key": key, "value": value}, f"{key}={value} params")
for key, value in (("LOG_LEVEL", "trace"), ("LOG_LEVEL", "fatal"), ("LOG_LEVEL", "INFO"), ("LOG_LEVEL", "info\n"),
                   ("LOG_LEVEL", "info "), ("LOG_LEVEL", ""), ("LOG_LEVEL", "info|debug"), ("DB_POOL_MAX", "0"),
                   ("DB_POOL_MAX", "21"), ("DB_POOL_MAX", "010"), ("DB_POOL_MAX", "-1"), ("DB_POOL_MAX", 10),
                   ("JOB_MAX_WORKERS", "5"), ("JOB_MAX_WORKERS", "1.0"), ("JOB_MAX_WORKERS", None)):
    req_no("patch-key", "POST", {**CM, "key": key, "value": value, "confirm": key}, f"{key}={value!r}", 400)
for key in ("DATABASE_URL", "DEMO_LOGINS", "ENABLE_OTLP_EXPORT", "log_level", "LOG_LEVEL ", "", 3):
    req_no("patch-key", "POST", {**CM, "key": key, "value": "info", "confirm": key}, f"key {key!r}", 403)
req_no("patch-key", "POST", {**CM, "key": "LOG_LEVEL", "value": "info", "confirm": "thales"},
       "patch-key confirmed with the configmap name, not the key", 400)
req_no("patch-key", "POST", {**CM, "key": "LOG_LEVEL", "value": "info"}, "patch-key without confirm", 400)
req_no("patch-key", "POST", {**CM, "configmap": "other", "key": "LOG_LEVEL", "value": "info", "confirm": "LOG_LEVEL"},
       "patch-key on another configmap", 403)
req_no("patch-key", "GET", {**CM, "key": "LOG_LEVEL", "value": "info", "confirm": "LOG_LEVEL"}, "patch-key over GET", 405)
req_ok("patch-key-and-restart", "POST", {**CM, "key": "JOB_MAX_WORKERS", "value": "2", "confirm": "JOB_MAX_WORKERS"},
       "patch-key-and-restart")

print()
print("── jobs, pods and templates ─────────────────────────────────────")
T = {"namespace": "thales-dev", "template": "migrate", "confirm": "migrate"}
req_ok("run-template", "POST", T, "run-template migrate")
for tpl, status in (("../migrate", 400), ("migrate.yaml", 400), ("seed-scenario", 404), ("x", 404),
                    ("..", 400), ("migrate/../../x", 400), ("", 400)):
    req_no("run-template", "POST", {**T, "template": tpl, "confirm": tpl}, f"template {tpl!r}", status)
req_no("run-template", "POST", {**T, "confirm": "Migrate"}, "run-template, wrong confirm", 400)
req_no("run-template", "POST", {**T, "image": "thales/backend:1"}, "run-template given an image", 400)
req_no("run-template", "POST", {**T, "spec": {"template": {}}}, "run-template given a body", 400)
req_no("run-template", "POST", {**T, "namespace": "kube-system"}, "run-template in kube-system", 403)
req_ok("delete-pod", "POST", {"namespace": "thales-dev", "pod": "frontend-6d9f8-x2k4q"}, "delete-pod")
req_no("delete-pod", "POST", {"namespace": "thales-dev", "pod": "../x"}, "delete-pod traversal", 400)
req_no("delete-pod", "POST", {"namespace": "thales-dev"}, "delete-pod with no pod", 400)
req_no("delete-pod", "POST", {"namespace": "thales-dev", "pod": "x", "confirm": "x"}, "delete-pod given confirm", 400)
req_ok("delete-job", "POST", {"namespace": "thales-dev", "job": "thales-migrate-abcde"}, "delete-job")
p = req_ok("job-logs", "GET", {"namespace": "thales-dev", "job": "thales-migrate-abcde", "previous": "1"}, "job-logs")
ok(p == {"tail": 200, "container": None, "previous": True}, f"job-logs params {p}")
p = req_ok("pods", "GET", {"namespace": "thales-dev", "deployment": "frontend"}, "pods of a deployment")
ok(p == {"deployment": "frontend"}, "pods takes deployment as a PARAMETER")
p = req_ok("pods", "GET", {"namespace": "thales-dev"}, "pods of the namespace")
ok(p == {"deployment": None}, "pods, no deployment")
req_no("pods", "GET", {"namespace": "thales-dev", "deployment": "../x"}, "pods deployment traversal", 400)
p = req_ok("rollback-to-revision", "POST", {"namespace": "thales-dev", "deployment": "backend", "revision": "4",
                                            "confirm": "backend"}, "rollback to 4")
ok(p == {"revision": 4}, "revision coerced")
for rv in ("0", "-1", "1000000", "x", True):
    req_no("rollback-to-revision", "POST", {"namespace": "thales-dev", "deployment": "backend", "revision": rv,
                                            "confirm": "backend"}, f"revision={rv!r}", 400)
for aid in ("services", "routes", "ingresses", "persistentvolumeclaims", "networkpolicies", "resourcequotas",
            "limitranges", "namespace-events", "deployments", "jobs"):
    req_ok(aid, "GET", {"namespace": "thales-pre-prod"}, f"view {aid}")
    req_no(aid, "GET", {"namespace": "kube-system"}, f"view {aid} in kube-system", 403)
    req_no(aid, "POST", {"namespace": "thales-dev"}, f"{aid} over POST", 405)
for aid in ("secrets", "secret", "exec", "attach", "port-forward", "portforward", "create-namespace",
            "delete-namespace", "catalog", "rbac", "roles", "apply", "create-job"):
    req_no(aid, "GET", {"namespace": "thales-dev"}, f"no action {aid!r}", 404)

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("guard: all passed")
