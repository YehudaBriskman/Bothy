#!/usr/bin/env python3
"""The update catalog's parser, and the version arithmetic every badge rests on.

Run: python3 checks/test_updates_catalog.py

Pure units, no network, no docker. Three parts:

  REFUSALS  updates.load_catalog() refuses an unknown key, an unknown channel,
            `auto` on a one-way component, `auto` on the auth boundary, `auto` on
            any class outside AUTO_CLASSES, a missing one_way_why, a stray
            placeholder, a traversing pin, a policy that switches a safety rule off
  VERSIONS  parse_version's shapes, classify()'s levels, effective_channel()'s
            policy table (auto = patch only; any major is manual)
  THE REAL  apps/bothy-ops/updates.toml loads, carries the approved channels,
  CATALOG   and every pin it names resolves in this repository to an image, a
            variable or a version; every `apply` is a recipe the justfile has
"""
import copy
import os
import re
import sys
import tomllib

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(SVC))
sys.path.insert(0, SVC)
os.environ.setdefault("ADMIN_AUDIT_LOG", os.devnull)

import discover_updates as du  # noqa: E402
import updates  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def refuses(doc: dict, needle: str, label: str) -> None:
    try:
        updates.load_catalog(doc)
    except updates.CatalogError as e:
        ok(needle.lower() in str(e).lower(), f"{label}  ({e})")
        return
    ok(False, f"{label}  (was ACCEPTED)")


with open(os.path.join(SVC, "updates.toml"), "rb") as fh:
    REAL = tomllib.load(fh)

POLICY = copy.deepcopy(REAL["policy"])
GOOD = {
    "title": "Thing", "class": "stateless", "source": "image", "pins": ["monitoring/compose.yml:thing"],
    "apply": "just up-monitoring", "dependants": [], "changelog": "https://example.com/v{version}",
    "channel": "auto", "one_way": False, "verify": ["it answers"],
}


def doc(**over) -> dict:
    c = {**copy.deepcopy(GOOD), **over}
    return {"policy": copy.deepcopy(POLICY), "components": {"thing": {k: v for k, v in c.items() if v is not None}}}


print("── REFUSALS: what the catalog may not say ───────────────────────")
ok(isinstance(updates.load_catalog(doc()), updates.Catalog), "the minimal good component is accepted")
refuses(doc(colour="red"), "unknown keys", "an unknown key")
refuses(doc(channel="nightly"), "channel must be one of", "an unknown channel")
refuses(doc(channel="Auto"), "channel must be one of", "a channel in the wrong case")
refuses(doc(one_way=True, one_way_why="Its schema migrates and cannot go back."), "one-way component may never be `auto`",
        "auto on a one-way component")
refuses(doc(**{"class": "boundary"}), "auth boundary may never be `auto`", "auto on the auth boundary")
for cls in ("edge", "app-db", "database"):
    refuses(doc(**{"class": cls}), "may not be `auto`", f"auto on class {cls} (not in AUTO_CLASSES)")
refuses(doc(**{"class": "own-code"}), "takes source", "own-code with an image source")
refuses(doc(channel="notify", one_way=True), "one_way_why", "one_way without one_way_why")
refuses(doc(channel="notify", one_way_why="Its schema migrates and cannot go back."), "unknown keys",
        "one_way_why on a two-way component")
refuses(doc(one_way="yes"), "one_way must be", "one_way that is not a bool")
refuses(doc(title=None), "required", "a missing required key (no defaults)")
refuses(doc(verify=[]), "must not be empty", "no verify canary")
refuses(doc(changelog="http://example.com/{version}"), "https", "a plain-http changelog")
refuses(doc(changelog="https://example.com/{tag}"), "placeholder", "a placeholder other than {version}")
refuses(doc(pins=["../etc/compose.yml:x"]), "repo-relative", "a pin that climbs out of the repo")
refuses(doc(pins=["/etc/compose.yml:x"]), "repo-relative", "an absolute pin")
refuses(doc(pins=["monitoring/compose.yml"]), "<file>:<name>", "an image pin without a service")
refuses(doc(pins=[]), "must not be empty", "no pin at all")
refuses(doc(apply="docker compose up -d"), "just <recipe>", "an apply that is not a just recipe")
refuses(doc(apply="just up-monitoring; rm -rf /"), "just <recipe>", "an apply with a shell tail")
refuses(doc(source="helm", **{"class": "cluster"}, channel="notify"), "required", "helm without chart/chart_repo/release")
bad = doc()
bad["components"]["Thing!"] = bad["components"].pop("thing")
refuses(bad, "id must be", "a malformed component id")
extra = doc()
extra["surprise"] = {}
refuses(extra, "exactly [policy]", "an unknown top-level table")
for k, v, needle in (("require_doctor", False, "must be true"), ("pause_on_failure", False, "must be true"),
                     ("max_auto_per_night", 3, "0 or 1"), ("window_start", "25:00", "HH:MM"),
                     ("window_end", "03:00", "start before")):
    p = doc()
    p["policy"][k] = v
    refuses(p, needle, f"policy {k} = {v!r}")
p = doc()
p["policy"]["surprise"] = 1
refuses(p, "unknown", "an unknown policy key")

print()
print("── VERSIONS: shapes, levels and the channel table ───────────────")
V = updates.parse_version
ok(V("13.2.2").shape == ("", 3, False) and V("v1.152.0").shape == ("v", 3, False), "plain and v-prefixed shapes")
ok(V("26.7.4-0").shape == ("", 3, True) and V("26.7.4-0").text == "26.7.4", "a numeric build revision is its own shape")
ok(V("v3.7").shape == ("v", 2, False) and V("17").shape == ("", 1, False), "floating pins have fewer parts")
for t in ("latest", "17-alpine", "17.6-bookworm", "3.0.0-rc1", "v1.2.3-beta.1", "20240101", "1.2.3.4", ""):
    ok(V(t) is None, f"{t!r} is not a release version")
C = updates.classify
ok(C(V("1.2.3"), V("1.2.4")) == "patch" and C(V("1.2.3"), V("1.3.0")) == "minor" and C(V("1.2.3"), V("2.0.0")) == "major",
   "patch, minor, major")
ok(C(V("1.2.3"), V("1.2.3")) is None and C(V("1.2.3"), V("1.2.2")) is None, "not newer -> nothing")
ok(C(V("1.2.3"), V("v1.2.4")) is None and C(V("v3.7"), V("v3.7.1")) is None, "a different shape is never compared")
ok(C(V("1.2.9"), V("1.2.10")) == "patch", "numbers compare as numbers (10 > 9)")
ok(C(V("26.7.4-0"), V("26.7.4-1")) == "patch" and C(V("26.7.4-1"), V("26.8.0-0")) == "minor",
   "a build revision is a patch step")
ok(C(V("v3.7"), V("v3.8")) == "minor" and C(V("17"), V("18")) == "major", "a float moves by its own shape")
cands = du.candidates(V("1.2.3"), ["1.2.2", "1.2.3", "1.2.4", "1.2.10", "1.3.0", "1.3.0-rc1", "2.0.0", "latest", "v9.9.9"])
ok({k: v["tag"] for k, v in cands.items()} == {"patch": "1.2.10", "minor": "1.3.0", "major": "2.0.0"},
   f"the newest at each level, pre-releases and other shapes ignored: {cands}")
ok(du.latest_of(cands)["tag"] == "2.0.0", "latest is the largest step")
E = updates.effective_channel
table = {("auto", "patch"): "auto", ("auto", "minor"): "notify", ("auto", "major"): "manual",
         ("notify", "patch"): "notify", ("notify", "minor"): "notify", ("notify", "major"): "manual",
         ("manual", "patch"): "manual", ("manual", "minor"): "manual", ("manual", "major"): "manual"}
ok(all(E(c, lv) == want for (c, lv), want in table.items()), "auto is patch-only; minors notify; any major is manual")
ok(E("auto", None) is None, "no update -> no channel")
ok(updates.changelog_url("https://x/v{version}", "1.2.3") == "https://x/v1.2.3", "the changelog is filled in")
ok(updates.changelog_url("https://x/v{version}", "1.2.3/../../evil") is None, "a version is never pasted blindly")

print()
print("── THE REAL CATALOG ──────────────────────────────────────────────")
cat = updates.load(os.path.join(SVC, "updates.toml"))
ch = {cid: c.channel for cid, c in cat.components.items()}
ok({k for k, v in ch.items() if v == "auto"} ==
   {"cadvisor", "node-exporter", "postgres-exporter", "alloy", "headlamp", "victoriametrics", "loki"},
   "auto: exactly the approved seven")
ok({k for k, v in ch.items() if v == "notify"} == {"grafana", "traefik", "bothy", "kube-state-metrics", "alloy-cluster"},
   "notify: grafana, traefik, our code, the cluster add-ons")
ok({k for k, v in ch.items() if v == "manual"} ==
   {"keycloak", "oauth2-proxy", "oauth2-proxy-headlamp", "socket-proxy", "postgres"},
   "manual: keycloak, both oauth2-proxies, the socket proxies, postgres")
ok(all(cat.components[c].one_way for c in ("grafana", "keycloak", "postgres")), "grafana, keycloak and postgres are one-way")
just = open(os.path.join(REPO, "justfile"), encoding="utf-8").read()
for c in cat.components.values():
    recipe = c.apply.split()[1]
    ok(re.search(rf"^{re.escape(recipe)}( [^:]*)?:", just, re.M) is not None, f"{c.id}: `{c.apply}` is a real recipe")
    for i, pin in enumerate(c.pins):
        f, name = c.pin_parts(i)
        path = os.path.join(REPO, f)
        if not os.path.isfile(path):
            ok(False, f"{c.id}: {f} exists")
            continue
        text = open(path, encoding="utf-8").read()
        if c.source == "image":
            svc = du.compose_service(text, name or "")
            good = bool(svc.get("image")) and bool(svc.get("container_name"))
            ok(good, f"{c.id}: {pin} -> {svc.get('image')} (container {svc.get('container_name')})")
        elif c.source == "manifest":
            ok(bool(du.manifest_image(text, name or "")), f"{c.id}: {pin} -> {du.manifest_image(text, name or '')}")
        elif c.source == "helm":
            v = du.shell_var(text, name or "")
            ok(bool(v and updates.parse_version(v)), f"{c.id}: {pin} = {v}")
        else:
            ok(bool(updates.parse_version("v" + text.strip())), f"{c.id}: {f} holds a version ({text.strip()})")
    if len(c.pins) > 1 and c.source == "image":
        imgs = {du.compose_service(open(os.path.join(REPO, c.pin_parts(i)[0])).read(), c.pin_parts(i)[1] or "")
                .get("image", "").split("#")[0].strip() for i in range(len(c.pins))}
        ok(len({du.split_image(i)["ref"] + str(du.split_image(i)["tag"]) for i in imgs}) == 1,
           f"{c.id}: its {len(c.pins)} pins agree ({imgs})")
reg = {du.split_image(du.compose_service(open(os.path.join(REPO, c.pin_parts()[0])).read(), c.pin_parts()[1] or "")
                      .get("image", ""))["registry"]
       for c in cat.components.values() if c.source == "image"}
ok(reg <= set(du.REGISTRIES), f"every image lives on a registry discovery reads: {sorted(reg)}")

print()
print("── the scanners on awkward input ─────────────────────────────────")
COMPOSE = """services:
  a:
    image: "x/a:1.0.0"   # a comment
    container_name: a
    environment:
      image: not-this
  b:
    # image: commented-out:9
    image: quay.io/x/b@sha256:""" + "a" * 64 + """
networks:
  image: nope
"""
ok(du.compose_service(COMPOSE, "a") == {"image": "x/a:1.0.0", "container_name": "a"},
   "compose: quotes and comments stripped, nested keys ignored")
ok(du.compose_service(COMPOSE, "b")["image"].endswith("a" * 64), "compose: a digest pin, and a commented line skipped")
ok(du.compose_service(COMPOSE, "c") == {}, "compose: an unknown service finds nothing")
s = du.split_image("postgres:17")
ok((s["registry"], s["repository"], s["tag"]) == ("docker.io", "library/postgres", "17"), "docker.io official image")
s = du.split_image("localhost:5000/thales/api:1.2.3")
ok((s["registry"], s["repository"], s["tag"]) == ("localhost:5000", "thales/api", "1.2.3"), "a host:port registry")
ok(du.same_image("grafana/grafana:1", "docker.io/grafana/grafana:1") and not du.same_image("a:1", "a:2"),
   "two spellings of one image are the same image")
HELM = """apiVersion: v1
entries:
  alpha:
  - version: 9.9.9
  kube-state-metrics:
  - annotations:
      version: 0.0.1
    apiVersion: v2
    appVersion: 2.21.0
    created: "2026-09-01T00:00:00Z"
    version: 8.6.0
  - apiVersion: v2
    deprecated: true
    version: 8.5.9
  - version: 8.5.0
  zeta:
  - version: 99.0.0
generated: x
"""
hv = du.helm_index_versions(HELM, "kube-state-metrics")
ok([v["version"] for v in hv] == ["8.6.0", "8.5.0"] and hv[0]["appVersion"] == "2.21.0",
   f"helm index: one chart's versions, nested keys and deprecated entries ignored: {hv}")

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("updates catalog: all passed")
