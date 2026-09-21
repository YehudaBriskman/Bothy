#!/usr/bin/env python3
"""Build step 8's decisions, as units: the cluster class and the Postgres major.

Run: python3 checks/test_step8.py

No docker, no cluster, no network: a throwaway git repository (a bare "origin"
and a clone on main) holding COPIES of the real k8s/monitoring/Chart.yaml,
k8s/monitoring/alloy.yaml, data/postgres/compose.yml and auth/compose.yml; kubectl
and helm replaced by a table that records every argv; docker inspect replaced by
a table. What it pins down:

  CLUSTER   a plan is "what the cluster runs -> what main pins": kube-state-metrics
            8.4.0 -> 8.5.0 (helm, with the revision to roll back to), alloy
            v1.19.1 -> v1.19.2 (DaemonSet, with discovery's digest); the narrow
            recipe part; EVERY kubectl/helm argv names the context; and every
            refusal - a ServiceAccount identity (rule 6), no context configured,
            not installed, a failed release, nothing to deploy, a downgrade, a
            major, discovery older than the checkout, an unknown digest, a
            floating pin, another image, a Deployment, a dirty pin file, not main
  WRITE-BACK the rollback's one-line edit of Chart.yaml / alloy.yaml, strictly
  PG-MAJOR  17.10 -> 18.1 on a NEW volume: type-name AND a note, the two volumes,
            both pins; and every refusal - the same volume, a wrongly named one,
            18 mounted at /var/lib/postgresql/data, no declaration, a declaration
            with options, keycloak-db-init left on 17, no digest, a minor, a
            downgrade, the new volume already there, a volume that is not
            compose's; the executor's half: no note, a note on another plan, the
            actor `auto`, a click
  DUMP      read_dump counts rows per table per database from a pg_dumpall,
            quoted names and all, and knows a truncated dump
  GUARD     scripts/pg-volume-guard.sh refuses `up` onto an empty new volume
            (with a stand-in `docker`)
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SVC))
sys.path.insert(0, SVC)
os.environ.setdefault("ADMIN_AUDIT_LOG", os.devnull)

import updater  # noqa: E402,F401
from updater import cluster, hostio, k8s, pgmajor, pins, plans, spool  # noqa: E402
from updater.config import Config  # noqa: E402
import updates  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def D(c: str) -> str:
    return "sha256:" + c * 64


TMP = tempfile.mkdtemp(prefix="bothy-step8-unit-")
ORIGIN = os.path.join(TMP, "origin.git")
REPO = os.path.join(TMP, "repo")
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]


def git(*args: str) -> str:
    return subprocess.run([*GIT, *args], cwd=REPO, check=True, capture_output=True, text=True).stdout.strip()


def real(rel: str) -> str:
    return open(os.path.join(ROOT, rel), encoding="utf-8").read()


def put(rel: str, text: str) -> None:
    p = os.path.join(REPO, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(text)


def merge(msg: str) -> None:
    git("add", "-A")
    git("commit", "-q", "-m", msg)
    git("push", "-q", "origin", "main")


# The real catalog's entries for the three components, under a test [policy].
real_cat = real("apps/bothy-ops/updates.toml")
CATALOG = real_cat[real_cat.index("[policy]"):real_cat.index("# ══ stateless")]
for cid in ("kube-state-metrics", "alloy-cluster", "postgres"):
    start = real_cat.index(f"[components.{cid}]")
    end = real_cat.find("\n[", start + 1)
    CATALOG += "\n" + real_cat[start:end if end > 0 else None].strip() + "\n"
CATALOG += '''
[components.ksm-deploy]
title = "a Deployment"
class = "cluster"
source = "manifest"
pins = ["k8s/monitoring/alloy.yaml:alloy"]
workload = "monitoring/deployment/alloy"
apply = "just k8s-monitoring"
dependants = []
changelog = "https://example.invalid/{version}"
channel = "notify"
one_way = false
verify = ["x"]
'''

PG17 = "postgres:17.10@" + D("7")
PG18 = "postgres:18.1@" + D("8")
CHART = real("k8s/monitoring/Chart.yaml")
ALLOY = real("k8s/monitoring/alloy.yaml")
PGC = real("data/postgres/compose.yml")
AUTH = real("auth/compose.yml")
LIVE_PG = PGC.split("image: ", 1)[1].split("\n", 1)[0]


def pg_files(image: str = PG18, kdi: str | None = None, mount: str = "postgres18_data:/var/lib/postgresql",
             decl: str = "  postgres18_data:") -> None:
    t = PGC.replace(LIVE_PG, image).replace("postgres_data:/var/lib/postgresql/data", mount)
    t = t.replace("\nvolumes:\n  postgres_data:\n", f"\nvolumes:\n{decl}\n")
    put("data/postgres/compose.yml", t)
    put("auth/compose.yml", AUTH.replace(LIVE_PG, kdi or image))


subprocess.run(["git", "init", "-q", "--bare", "-b", "main", ORIGIN], check=True)
subprocess.run(["git", "clone", "-q", ORIGIN, REPO], check=True, capture_output=True)
git("checkout", "-q", "-b", "main")
put("updates.toml", CATALOG)
put("k8s/monitoring/Chart.yaml", CHART)
put("k8s/monitoring/alloy.yaml", ALLOY)
pg_files()
merge("pins")

cfg = Config(repo=REPO, catalog=os.path.join(REPO, "updates.toml"), state=os.path.join(TMP, "state"),
             backups=os.path.join(TMP, "backups"), textfile=None, kube_context="test-ctx")
KSM_PIN = cluster._value(cluster.chart_line(REPO, "k8s/monitoring/Chart.yaml", "kube-state-metrics"))
ALLOY_PIN = cluster._value(cluster.manifest_line(REPO, "k8s/monitoring/alloy.yaml", "alloy"))
ok(KSM_PIN == "8.5.0" and ALLOY_PIN == "grafana/alloy:v1.19.2",
   f"the pin lines of the REAL files are found: {KSM_PIN}, {ALLOY_PIN}")


def avail(**over) -> dict:
    comps = {
        "kube-state-metrics": {"image": "https://prometheus-community.github.io/helm-charts#kube-state-metrics",
                               "current": {"tag": "8.5.0", "version": "8.5.0", "float": False}},
        "alloy-cluster": {"image": "docker.io/grafana/alloy",
                          "current": {"tag": "v1.19.2", "version": "1.19.2", "float": False, "resolved": D("a")}},
        "ksm-deploy": {"image": "docker.io/grafana/alloy", "current": {"tag": "v1.19.2", "resolved": D("a")}},
        "postgres": {"image": "docker.io/library/postgres",
                     "current": {"tag": "18.1", "version": "18.1", "digest": D("8"), "float": True}},
    }
    for k, v in over.items():
        comps[k.replace("_", "-")] = v
    return {"version": 1, "generatedAt": "2026-09-21T10:00:00Z", "components": comps}


# ── kubectl and helm, replaced by a table ─────────────────────────────────────
KUBE = {"who": "minikube-user", "helm": [{"name": "kube-state-metrics", "namespace": "monitoring",
                                          "revision": "4", "status": "deployed", "chart": "kube-state-metrics-8.4.0",
                                          "app_version": "2.19.0"}],
        "ds_image": "grafana/alloy:v1.19.1", "ds_kind": "daemonset"}
CALLS: list[list[str]] = []


def fake_run(argv, **kw):
    CALLS.append(list(argv))
    a = [x for x in argv if not x.startswith("--request-timeout")]
    if a[0] == "kubectl":
        rest = a[3:]
        if rest[:2] == ["--kubeconfig", cfg.kubeconfig or ""]:
            rest = rest[2:]
        if rest[:2] == ["auth", "whoami"]:
            return 0, json.dumps({"status": {"userInfo": {"username": KUBE["who"]}}}), ""
        if "daemonset" in rest and "get" in rest:
            if KUBE["ds_image"] is None:
                return 1, "", 'Error from server (NotFound): daemonsets.apps "alloy" not found'
            return 0, json.dumps({"metadata": {"name": "alloy", "generation": 7}, "spec": {"template": {"spec": {
                "containers": [{"name": "alloy", "image": KUBE["ds_image"]}],
                "volumes": [{"name": "config", "configMap": {"name": "alloy"}}, {"name": "tmp", "emptyDir": {}}]}}},
                "status": {}}), ""
        return 1, "", f"unexpected kubectl {rest}"
    if a[0] == "helm":
        if "list" in a:
            return 0, json.dumps(KUBE["helm"]), ""
        return 1, "", "unexpected helm"
    return 1, "", f"unexpected {a[0]}"


k8s.run = fake_run


def refused(fn, needle: str, label: str) -> None:
    try:
        fn()
    except plans.PlanRefused as e:
        ok(needle.lower() in str(e).lower(), f"{label}  ({str(e)[:110]})")
        return
    ok(False, f"{label}  (a plan was MADE)")


A = avail()
print("── CLUSTER: what the cluster runs -> what main pins ─────────────")
p = plans.plan("kube-state-metrics", cfg=cfg, available=A)
ok(p["class"] == "cluster" and p["kind"] == "cluster" and p["cluster"]["kind"] == "helm"
   and p["from"]["tag"] == "8.4.0" and p["to"]["tag"] == "8.5.0" and p["level"] == "minor",
   f"kube-state-metrics: chart 8.4.0 -> 8.5.0, a minor ({p['from']['image']} -> {p['to']['image']})")
ok(p["cluster"]["revision"] == 4 and p["from"]["revision"] == 4 and "helm rollback kube-state-metrics 4" in p["rollback"],
   "the revision to roll back to is in the plan, and in its rollback words")
ok(p["recipe"] == "just k8s-monitoring ksm" and p["cluster"]["part"] == "ksm",
   "apply is the NARROW part: `just k8s-monitoring ksm`, never the whole script")
ok(p["confirm"] == "click" and p["oneWay"] is False and p["snapshot"]["kind"] == "helm"
   and "helm get values" in p["snapshot"]["what"], "click to confirm; the snapshot is helm get values + the revision")
ok(any("kube_node_info" in v for v in p["verify"]) and any('up{job="kube-state-metrics"' in v for v in p["verify"]),
   "verify: kube_node_info through the NodePort, and VictoriaMetrics' up{job=kube-state-metrics}")
ok(p["cluster"]["identity"] == "minikube-user" and any("never a ServiceAccount" in x for x in p["preflight"]),
   "the identity is recorded, and the pre-flight says whose")
ok(p["pin"]["file"] == "k8s/monitoring/Chart.yaml" and p["pin"]["text"].strip() == "version: 8.5.0",
   f"the pin: Chart.yaml line {p['pin']['line']}")
ok(plans.plan("kube-state-metrics", cfg=cfg, available=A)["id"] == p["id"] and len(p["id"]) == 24,
   "the id is stable for the same facts")
KUBE["helm"][0]["revision"] = "5"
ok(plans.plan("kube-state-metrics", cfg=cfg, available=A)["id"] != p["id"], "…and changes when the revision does")
KUBE["helm"][0]["revision"] = "4"

d = plans.plan("alloy-cluster", cfg=cfg, available=A)
ok(d["cluster"]["kind"] == "daemonset" and d["from"]["image"] == "grafana/alloy:v1.19.1"
   and d["to"]["image"] == "grafana/alloy:v1.19.2" and d["to"]["digest"] == D("a") and d["level"] == "patch",
   "alloy-cluster: the DaemonSet's image -> main's pin, with discovery's digest (verify checks the node pulled it)")
ok(d["recipe"] == "just k8s-monitoring alloy" and d["cluster"]["configMaps"] == ["alloy"]
   and d["snapshot"]["kind"] == "daemonset", "the narrow `alloy` part; the ConfigMap it mounts is snapshotted too")
ok(any('{cluster="thales-scc"}' in v for v in d["verify"]) and any("every node" in v for v in d["verify"]),
   "verify: rolled out on every node, and fresh {cluster=\"thales-scc\"} lines in Loki")
ctx_ok = all(("--context" in c and c[c.index("--context") + 1] == "test-ctx") if c[0] == "kubectl" else
             ("--kube-context" in c and c[c.index("--kube-context") + 1] == "test-ctx") for c in CALLS)
ok(CALLS and ctx_ok, f"EVERY kubectl/helm argv names the context explicitly ({len(CALLS)} calls)")
cfg.kubeconfig = os.path.join(TMP, "operator.kubeconfig")
CALLS.clear()
plans.plan("alloy-cluster", cfg=cfg, available=A)
ok(all("--kubeconfig" in c and c[c.index("--kubeconfig") + 1] == cfg.kubeconfig for c in CALLS),
   "a configured kubeconfig is passed on every argv too")
cfg.kubeconfig = None

KUBE["who"] = "system:serviceaccount:bothy:bothy-kube"
refused(lambda: plans.plan("kube-state-metrics", cfg=cfg, available=A), "serviceaccount",
        "RULE 6: a ServiceAccount identity (bothy-ops' token) is refused")
KUBE["who"] = "minikube-user"
cfg.kube_context = ""
refused(lambda: plans.plan("kube-state-metrics", cfg=cfg, available=A), "never uses the current one",
        "no context configured: never the current one implicitly")
cfg.kube_context = "test-ctx"
saved = KUBE["helm"]
KUBE["helm"] = []
refused(lambda: plans.plan("kube-state-metrics", cfg=cfg, available=A), "not installed", "the release is not installed")
KUBE["helm"] = [{**saved[0], "status": "pending-upgrade"}]
refused(lambda: plans.plan("kube-state-metrics", cfg=cfg, available=A), "not deployed", "a release stuck mid-upgrade")
KUBE["helm"] = [{**saved[0], "chart": "kube-state-metrics-8.5.0"}]
refused(lambda: plans.plan("kube-state-metrics", cfg=cfg, available=A), "nothing to deploy", "it already runs main's pin")
KUBE["helm"] = [{**saved[0], "chart": "kube-state-metrics-8.6.0"}]
refused(lambda: plans.plan("kube-state-metrics", cfg=cfg, available=A), "not newer", "a downgrade")
KUBE["helm"] = [{**saved[0], "chart": "kube-state-metrics-7.9.0"}]
refused(lambda: plans.plan("kube-state-metrics", cfg=cfg, available=A), "major", "a major (7.9.0 -> 8.5.0)")
KUBE["helm"] = saved
refused(lambda: plans.plan("kube-state-metrics", "8.6.0", cfg=cfg, available=A), "not what main pins",
        "a --target main does not pin")
refused(lambda: plans.plan("kube-state-metrics", cfg=cfg, available=avail(kube_state_metrics={
    "current": {"tag": "8.4.0"}})), "older than the checkout", "discovery saw another pin than the checkout has")
refused(lambda: plans.plan("alloy-cluster", cfg=cfg, available=avail(alloy_cluster={
    "image": "docker.io/grafana/alloy", "current": {"tag": "v1.19.2", "resolved": None}})), "digest",
    "the DaemonSet's target digest is unknown")
refused(lambda: plans.plan("alloy-cluster", cfg=cfg, available=avail(alloy_cluster={
    "image": "docker.io/grafana/alloy", "current": {"tag": "v1.19.2", "float": True, "resolved": D("a")}})),
    "floating", "a floating pin")
KUBE["ds_image"] = "grafana/alloy:v1.19.2"
refused(lambda: plans.plan("alloy-cluster", cfg=cfg, available=A), "nothing to deploy", "the DaemonSet runs main's pin")
KUBE["ds_image"] = "example.invalid/other:v1.19.1"
refused(lambda: plans.plan("alloy-cluster", cfg=cfg, available=A), "different image", "another image")
KUBE["ds_image"] = None
refused(lambda: plans.plan("alloy-cluster", cfg=cfg, available=A), "notfound", "no DaemonSet in the cluster")
KUBE["ds_image"] = "grafana/alloy:v1.19.1"
refused(lambda: plans.plan("ksm-deploy", cfg=cfg, available=A), "daemonset", "a Deployment workload is not this class")
put("k8s/monitoring/Chart.yaml", CHART.replace("version: 8.5.0", "version: 8.5.1"))
refused(lambda: plans.plan("kube-state-metrics", cfg=cfg, available=A), "local changes", "a dirty pin file")
git("checkout", "-q", "--", "k8s/monitoring/Chart.yaml")
git("checkout", "-q", "-b", "side")
refused(lambda: plans.plan("alloy-cluster", cfg=cfg, available=A), "not main", "a checkout not on main")
git("checkout", "-q", "main")

print()
print("── WRITE-BACK: the rollback's one line, strictly ────────────────")
ln = cluster.chart_line(REPO, "k8s/monitoring/Chart.yaml", "kube-state-metrics")
pins.write_line(REPO, ln, pins.swap(ln, "8.5.0", "8.4.0"))
diff = git("diff", "--numstat")
ok(diff.startswith("1\t1\t") and "version: 8.4.0" in open(os.path.join(REPO, ln.file)).read(),
   f"Chart.yaml: exactly one line changed, the comment and indentation kept ({diff})")
try:
    pins.write_line(REPO, ln, pins.swap(ln, "8.5.0", "8.3.0"))
    ok(False, "a stale line is refused (was WRITTEN)")
except hostio.HostError as e:
    ok("no longer reads exactly" in str(e), f"a stale line is refused ({e})")
git("checkout", "-q", "--", ".")
ml = cluster.manifest_line(REPO, "k8s/monitoring/alloy.yaml", "alloy")
try:
    pins.swap(ml, "grafana/alloy:v1.19.9", "x")
    ok(False, "a value the line does not carry is refused (SWAPPED)")
except hostio.HostError:
    ok(True, "a value the line does not carry is refused")
pins.write_line(REPO, ml, pins.swap(ml, "grafana/alloy:v1.19.2", "grafana/alloy:v1.19.1"))
ok(git("diff", "--numstat").startswith("1\t1\t"), "alloy.yaml: exactly one line changed")
git("checkout", "-q", "--", ".")
try:
    pins.write_line(REPO, ml, "x\ny")
    ok(False, "a line edit that adds a line is refused (WRITTEN)")
except hostio.HostError:
    ok(True, "a line edit that adds a line is refused")

print()
print("── PG-MAJOR: 17 -> 18 on a NEW volume, typed and noted ──────────")
# docker inspect, replaced: the running postgres, its volume, the rest.
PGS = {"image": PG17, "volume": "postgres_postgres_data", "key": "postgres_data", "project": "postgres",
       "existing": {"postgres_postgres_data"}}
CONTAINERS = {"postgres": PG17, "keycloak-db-init": PG17, "keycloak": "quay.io/keycloak/keycloak:26.7.4-0"}


def fake_container(name):
    if name == "postgres":
        img = PGS["image"]
    elif name in CONTAINERS:
        img = CONTAINERS[name]
    else:
        return None
    return {"name": name, "image": img, "imageId": "sha256:" + "1" * 64, "state": "running", "health": "healthy",
            "labels": {"com.docker.compose.project": "postgres"}}


def fake_inspect(name):
    if name != "postgres":
        return None
    return {"Mounts": [{"Type": "volume", "Name": PGS["volume"], "Destination": "/var/lib/postgresql/data"}],
            "Config": {"Labels": {"com.docker.compose.project": PGS["project"]}}}


def fake_volume(name):
    if name not in PGS["existing"]:
        return None
    key = name.split("_", 1)[1]
    return {"Name": name, "Labels": {"com.docker.compose.project": "postgres",
                                     "com.docker.compose.volume": PGS["key"] if name == PGS["volume"] else key}}


hostio.container = fake_container
pgmajor._inspect = fake_inspect
pgmajor._volume = fake_volume
pgmajor.data_bytes = lambda cfg, c: 50 << 20
pgmajor.databases = lambda cfg, c: ["dev", "keycloak", "postgres"]
pgmajor.keycloak_db = lambda cfg: "keycloak"

g = plans.plan("postgres", cfg=cfg, available=A)
ok(g["kind"] == "postgres-major" and g["class"] == "database" and g["level"] == "major",
   f"postgres 17.10 -> 18.1: a plan of kind postgres-major ({g['from']['version']} -> {g['to']['version']})")
ok(g["confirm"] == "type-name" and g["requiresNote"] is True and g["oneWay"] is True,
   "NEVER one click: type-the-name AND a maintenance note, one-way")
pm = g["pgMajor"]
ok(pm["oldVolume"] == "postgres_postgres_data" and pm["newVolume"] == "postgres_postgres18_data"
   and pm["oldMount"] == "/var/lib/postgresql/data" and pm["newMount"] == "/var/lib/postgresql",
   f"the two volumes and mounts: {pm['oldVolume']} -> {pm['newVolume']}")
ok([q["service"] for q in g["pins"]] == ["postgres", "keycloak-db-init"],
   "BOTH pins move in the same plan (the keycloak-db-init major rule)")
ok(len(g["procedure"]) == 10 and "stop the writers" in g["procedure"][2] and "switch" in g["procedure"][7],
   "the procedure is spelled out, step by step")
ok("docker volume rm postgres_postgres_data" == pm["deleteOld"] and "never deleted" in g["rollback"],
   "the old volume is never deleted by the updater - the plan names the later manual command")
ok(g["snapshot"]["kind"] == "pg-dumpall" and g["snapshot"]["estimateBytes"] == 50 << 20, "the snapshot: a pg_dumpall")
ok(g["mount"]["text"].strip() == "- postgres18_data:/var/lib/postgresql" and g["decl"]["oldDeclared"] is False,
   "the mount and declaration lines are recorded for the rollback to write back")

refused_pg = (lambda needle, label: refused(lambda: plans.plan("postgres", cfg=cfg, available=A), needle, label))


def with_files(label: str, needle: str, **kw) -> None:
    pg_files(**kw)
    merge(label)
    refused_pg(needle, label)
    pg_files()
    merge("back")


with_files("the new major on the OLD volume", "same volume", mount="postgres_data:/var/lib/postgresql",
           decl="  postgres_data:")
with_files("a new volume named anything else", "named postgres18_data", mount="pgdata:/var/lib/postgresql",
           decl="  pgdata:")
with_files("18 mounted at /var/lib/postgresql/data", "refuses a mount", mount="postgres18_data:/var/lib/postgresql/data")
with_files("the new volume not declared", "does not declare", decl="  something_else:")
with_files("a declaration with options", "options", decl="  postgres18_data:\n    name: elsewhere")
with_files("keycloak-db-init left on 17", "pins disagree", kdi=PG17)
with_files("a pin without a digest", "digest", image="postgres:18.1", kdi="postgres:18.1")
g2 = plans.plan("postgres", cfg=cfg, available=A)
ok(g2["id"] != g["id"], "after all that, main moved: a new plan id")
PGS["existing"].add("postgres_postgres18_data")
refused_pg("already exists", "the new volume exists already (an earlier attempt) - never reused, never deleted")
PGS["existing"].discard("postgres_postgres18_data")
PGS["image"] = PG18.replace("18.1", "18.0").replace(D("8"), D("5"))
refused_pg("minor", "18.0 -> 18.1 is a MINOR: not this procedure")
PGS["image"] = "postgres:19.0@" + D("9")
refused_pg("not newer", "a downgrade (19 -> 18)")
PGS["image"] = PG18
refused_pg("nothing to deploy", "it already runs main's pin")
PGS["image"] = PG17
PGS["key"] = "something"
refused_pg("not a compose volume", "a volume that is not compose-named")
PGS["key"] = "postgres_data"
refused(lambda: plans.plan("postgres", cfg=cfg, available=avail(postgres={
    "image": "docker.io/library/postgres", "current": {"tag": "18.0", "digest": D("8")}})), "older than the checkout",
    "discovery older than the checkout")

print()
print("── the executor's half: typed, noted, and a person ──────────────")
cat = updates.load(cfg.catalog)
hostio.ensure_dir(cfg.plans, 0o700)
hostio.write_json(os.path.join(cfg.plans, "postgres.json"), {"version": 1, "component": "postgres", "ok": True,
                                                             "plan": g2})
JOB = "b" * 32


def req(**kw) -> dict:
    d = {"v": 1, "jobId": JOB, "component": "postgres", "planId": g2["id"], "confirm": "postgres",
         "requestedBy": "op@example.com", "requestedAt": "2026-09-21T10:00:00Z",
         "note": "moving to 18: auth down ~3 min, team told"}
    d.update(kw)
    return {k: v for k, v in d.items() if v is not None}


def invalid(fn, needle: str, label: str) -> None:
    try:
        fn()
    except (spool.Invalid, ValueError) as e:
        ok(needle.lower() in str(e).lower(), f"{label}  ({e})")
        return
    ok(False, f"{label}  (ACCEPTED)")


pd = plans.read_plan(cfg, "postgres")
ok(spool.validate_against(spool.validate_shape(req(), f"{JOB}.json"), cat, pd)["id"] == g2["id"]
   and pgmajor.validate_note(req(), g2) == "moving to 18: auth down ~3 min, team told",
   "typed and noted: accepted, the note kept")
invalid(lambda: spool.validate_against(req(confirm=True), cat, pd), "confirmation", "a CLICK on the postgres major")
invalid(lambda: spool.validate_against(req(note=None), cat, pd), "maintenance note", "no note (spool)")
invalid(lambda: pgmajor.validate_note(req(note=None), g2), "maintenance note", "no note (executor)")
invalid(lambda: pgmajor.validate_note(req(note="short"), g2), "maintenance note", "a note that says nothing")
invalid(lambda: pgmajor.validate_note(req(requestedBy="auto"), g2), "never automatic", "the actor `auto`")
invalid(lambda: spool.validate_shape(req(note=7), f"{JOB}.json"), "note", "a note that is not text")
invalid(lambda: spool.validate_shape(req(note="x" * 501), f"{JOB}.json"), "note", "a note over 500 characters")
invalid(lambda: pgmajor.validate_note(req(), p), "only for a plan", "a note on a plan that does not ask for one")
ok(pgmajor.validate_note({k: v for k, v in req().items() if k != "note"}, p) is None,
   "…and a plan that does not ask for one is fine without")

print()
print("── DUMP: rows per table, from the pg_dumpall itself ─────────────")
DUMP = r"""--
-- PostgreSQL database cluster dump
--
CREATE ROLE dev;
\connect template1
\connect dev
COPY public.notes (id, body) FROM stdin;
1	a
2	b\nwith an escaped newline
\.
COPY public."Odd Table" (x) FROM stdin;
\.
\connect -reuse-previous=on "dbname='we''ird'"
COPY s.t FROM stdin;
9
\.
\connect keycloak
COPY public.user_entity (id) FROM stdin;
u1
u2
u3
\.
--
-- PostgreSQL database cluster dump complete
--
"""
dp = os.path.join(TMP, "d.sql")
open(dp, "w").write(DUMP)
r = pgmajor.read_dump(dp)
ok(r["databases"] == ["template1", "dev", "we'ird", "keycloak"], f"the databases, quoted names too: {r['databases']}")
ok(r["tables"] == {"dev": {"public.notes": 2, 'public."Odd Table"': 0}, "we'ird": {"s.t": 1},
                   "keycloak": {"public.user_entity": 3}} and r["complete"] is True,
   f"rows per table (an empty one is 0; an escaped newline is not a row): {r['tables']}")
open(dp, "w").write(DUMP.split("u2")[0])
ok(pgmajor.read_dump(dp)["complete"] is False, "a truncated dump says so")

print()
print("── GUARD: `just up-data` onto an empty new volume refuses ───────")
BIN = os.path.join(TMP, "bin")
os.makedirs(BIN)
with open(os.path.join(BIN, "docker"), "w") as fh:
    fh.write('#!/bin/sh\n# a stand-in: the volumes in $VOLS exist\ncase "$1 $2" in\n'
             '  "volume inspect") for v in $VOLS; do [ "$v" = "$3" ] && exit 0; done; exit 1 ;;\n'
             '  "volume ls") for v in $VOLS; do echo "$v"; done ;;\nesac\n')
os.chmod(os.path.join(BIN, "docker"), 0o755)
GUARD = os.path.join(ROOT, "scripts", "pg-volume-guard.sh")


def guard(vols: str, **env) -> subprocess.CompletedProcess:
    e = {**os.environ, "PATH": BIN + os.pathsep + os.environ["PATH"], "VOLS": vols, **env}
    return subprocess.run(["bash", GUARD, os.path.join(REPO, "data/postgres/compose.yml"), "postgres"], env=e,
                          capture_output=True, text=True)


r1 = guard("postgres_postgres_data")
ok(r1.returncode == 1 and "REFUSING" in r1.stderr and "postgres_postgres18_data" in r1.stderr,
   "main pins postgres18_data, only the old volume exists: REFUSED, and it says what to do")
ok(guard("postgres_postgres_data postgres_postgres18_data").returncode == 0,
   "the new volume exists (the updater filled it): passes")
ok(guard("").returncode == 0, "a fresh box with no volume at all: passes")
ok(guard("postgres_postgres_data", BOTHY_PG_FRESH_VOLUME="1").returncode == 0, "the deliberate override: passes")

print()
print("── RECORDS: bothy-ops serves every step the new jobs write ──────")
from updater import record  # noqa: E402
for name, steps in (("cluster", record.CLUSTER_STEPS), ("postgres-major", record.PG_STEPS)):
    ok(set(steps) <= set(updates.STEP_NAMES) and len(steps) <= 16,
       f"{name}: every step name is on bothy-ops' allow-list, and all of them fit ({len(steps)})")
ok({"helm", "daemonset", "pg-dumpall"} <= set(updates._SNAPSHOT_KINDS), "…and the three new snapshot kinds")

shutil.rmtree(TMP, ignore_errors=True)
print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("step 8 units: all passed")
