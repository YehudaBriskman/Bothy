#!/usr/bin/env python3
"""The boundary as a pure unit. Needs nothing running - not docker, not a cluster.

Run: python3 checks/test_guard_kube.py

── what it asserts ─────────────────────────────────────────────────────────

  CATALOG     the shipped catalog loads, declares exactly the five v1 actions
              with the approved roles/confirm levels, and matches HANDLERS
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
want = {
    "rollout-restart": ("operator", "click", "POST", "deployment", False),
    "scale": ("operator", "type-name", "POST", "deployment", False),
    "events": ("viewer", "none", "GET", "deployment", False),
    "logs": ("viewer", "none", "GET", "deployment", True),
    "delete-completed-pods": ("operator", "click", "POST", "namespace", False),
}
ok(set(CAT) == set(want), f"exactly the five v1 actions: {sorted(CAT)}")
for aid, (role, confirm, method, target, stream) in want.items():
    a = CAT.get(aid)
    ok(a is not None and (a.role, a.confirm, a.method, a.target, a.stream)
       == (role, confirm, method, target, stream),
       f"{aid}: {role}, confirm {confirm}, {method}, target {target}, stream {stream}")
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
base = {"title": "x", "target": "deployment", "method": "POST", "role": "operator",
        "confirm": "click", "stream": False}


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
ok(p == {"tail": 500, "follow": True, "seconds": 30, "pod": None, "container": None},
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
req_no("logs", "GET", {**L, "previous": "true"}, "undeclared logs param `previous`", 400)
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
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("guard: all passed")
