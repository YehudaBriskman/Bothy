#!/usr/bin/env python3
"""The host updater's decisions, as units: plans, the spool, the pin edit, the lock.

Run: python3 checks/test_updater.py

No docker and no network: a throwaway git repository (a bare "origin" and a
clone on main), a test catalog, and docker inspect replaced by a table. What it
pins down:

  PLANS    a plan is "what runs -> what main pins", with tag@digest both sides,
           an id that is a hash of what decides the job (stable across calls,
           new when main moves); and every refusal - out of scope, floating,
           major, not newer, nothing to deploy, not running, not on main, dirty,
           ahead of origin/main, discovery older than the checkout, digest
           unknown, a --target main does not pin
  APP-DB   (step 5) Grafana and Keycloak plans are one-way: type-the-name, their
           snapshot, a rollback that always restores; Keycloak's TWO pins are
           both in the plan and must name the same tag@digest, or no plan
  SPOOL   only <32 hex>.json regular files are requests; exact keys; a symlink,
           an oversized file and junk are refused or removed; a tampered plan id,
           an unknown component, a component outside the updater's classes and a
           major (no plan) are all refused before anything runs; a one-way plan
           needs the component's id as confirm, in the executor as in bothy-ops
  PINS     the one-line edit keeps comments and quotes, and refuses unless the
           line and the value are exactly what the plan recorded
  LOCK     a second run while one holds the lock does nothing and says so
  RECORD   bothy_update_last_result carries exactly one 1 per component
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)
os.environ.setdefault("ADMIN_AUDIT_LOG", os.devnull)

import updater  # noqa: E402,F401
from updater import executor, hostio, pins, plans, record, spool  # noqa: E402
from updater.config import Config  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def D(c: str) -> str:
    return "sha256:" + c * 64


TMP = tempfile.mkdtemp(prefix="bothy-updater-unit-")
ORIGIN = os.path.join(TMP, "origin.git")
REPO = os.path.join(TMP, "repo")
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]


def git(*args: str, cwd: str = REPO) -> str:
    return subprocess.run([*GIT, *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


CATALOG = """
[policy]
window_start = "03:30"
window_end = "05:00"
require_backup = "stacks-backup.service"
require_doctor = true
max_auto_per_night = 1
pause_on_failure = true
discover_every_hours = 6

[components.web]
title = "Web"
class = "stateless"
source = "image"
pins = ["compose.yml:web"]
apply = "just up-web"
dependants = ["nothing much"]
changelog = "https://example.invalid/releases/tag/v{version}"
channel = "auto"
one_way = false
verify = ["body says web"]

[components.loki]
title = "Loki"
class = "timeseries"
source = "image"
pins = ["compose.yml:loki"]
apply = "just up-web"
dependants = []
changelog = "https://example.invalid/loki/{version}"
channel = "auto"
one_way = false
verify = ["ready"]

[components.graf]
title = "Graf"
class = "app-db"
source = "image"
pins = ["compose.yml:graf"]
apply = "just up-web"
dependants = []
changelog = "https://example.invalid/graf"
channel = "notify"
one_way = true
one_way_why = "its database migrates on first start and cannot go back"
verify = ["health"]

[components.grafana]
title = "Grafana"
class = "app-db"
source = "image"
pins = ["compose.yml:grafana"]
apply = "just up-web"
dependants = []
changelog = "https://example.invalid/grafana/v{version}"
channel = "notify"
one_way = true
one_way_why = "grafana.db's schema migrates on first start and cannot be downgraded"
verify = ["health"]

[components.keycloak]
title = "Keycloak"
class = "app-db"
source = "image"
pins = ["compose.yml:keycloak", "compose.yml:kc-init"]
apply = "just up-web"
dependants = ["oauth2-proxy", "every gated route"]
changelog = "https://example.invalid/keycloak/{version}"
channel = "manual"
one_way = true
one_way_why = "Keycloak migrates its database on first start; only the dump goes back"
verify = ["issuer"]

[components.flo]
title = "Floating"
class = "stateless"
source = "image"
pins = ["compose.yml:flo"]
apply = "just up-web"
dependants = []
changelog = "https://example.invalid/flo"
channel = "notify"
one_way = false
verify = ["x"]
"""

COMPOSE = """name: t
services:
  web:
    image: example.invalid/web:{web}   # pinned by the test
    container_name: t-web
  loki:
    image: "grafana/loki:{loki}"
    container_name: t-loki
  graf:
    image: grafana/grafana:13.2.2
    container_name: t-graf
  flo:
    image: traefik:v3.7
    container_name: t-flo
  grafana:
    image: grafana/grafana:13.2.2
    container_name: t-grafana
  keycloak:
    image: quay.io/keycloak/keycloak:{kc}   # pinned twice
    container_name: t-kc
  kc-init:
    image: quay.io/keycloak/keycloak:{kci}
    container_name: t-kc-init
"""


def write_compose(web: str = "1.0.1", loki: str = "3.7.7", kc: str = "26.7.4-0", kci: str | None = None) -> None:
    with open(os.path.join(REPO, "compose.yml"), "w") as fh:
        fh.write(COMPOSE.format(web=web, loki=loki, kc=kc, kci=kci or kc))


os.makedirs(ORIGIN)
subprocess.run(["git", "init", "-q", "--bare", "-b", "main", ORIGIN], check=True)
subprocess.run(["git", "clone", "-q", ORIGIN, REPO], check=True, capture_output=True)
git("checkout", "-q", "-b", "main")
write_compose()
with open(os.path.join(REPO, "updates.toml"), "w") as fh:
    fh.write(CATALOG)
git("add", ".")
git("commit", "-q", "-m", "pins")
git("push", "-q", "origin", "main")

STATE = os.path.join(TMP, "state")
BACKUPS = os.path.join(TMP, "backups")
cfg = Config(repo=REPO, catalog=os.path.join(REPO, "updates.toml"), state=STATE, backups=BACKUPS,
             textfile=os.path.join(TMP, "textfile"))
os.makedirs(cfg.spool, mode=0o700)


def avail(web_resolved=D("b"), loki_resolved=D("d"), web_tag="1.0.1") -> dict:
    return {"version": 1, "generatedAt": "2026-09-19T10:00:00Z", "components": {
        "web": {"image": "example.invalid/web", "current": {"tag": web_tag, "float": False,
                                                            "resolved": web_resolved}},
        "loki": {"image": "docker.io/grafana/loki", "current": {"tag": "3.7.7", "float": False,
                                                                "resolved": loki_resolved}},
        "graf": {"image": "docker.io/grafana/grafana", "current": {"tag": "13.2.2"}},
        "flo": {"image": "docker.io/library/traefik", "current": {"tag": "v3.7", "float": True}},
        "grafana": {"image": "docker.io/grafana/grafana", "current": {"tag": "13.2.2", "float": False,
                                                                      "resolved": D("f")}},
        "keycloak": {"image": "quay.io/keycloak/keycloak", "current": {"tag": "26.7.4-0", "float": False,
                                                                        "resolved": D("e")}},
    }}


# docker inspect, replaced by a table: container -> (image, imageId, digest)
RUNNING = {
    "t-web": ("example.invalid/web:1.0.0", "sha256:" + "1" * 64, D("a")),
    "t-loki": ("grafana/loki:3.7.6", "sha256:" + "2" * 64, D("c")),
    "t-grafana": ("grafana/grafana:13.1.4", "sha256:" + "7" * 64, D("7")),
    "t-kc": ("quay.io/keycloak/keycloak:26.7.3-0", "sha256:" + "8" * 64, D("8")),
}


def fake_container(name):
    if name not in RUNNING:
        return None
    img, iid, _ = RUNNING[name]
    return {"name": name, "image": img, "imageId": iid, "state": "running", "health": "healthy", "labels": {}}


def fake_image(ref):
    for img, iid, dg in RUNNING.values():
        if ref == iid:
            repo = img.rsplit(":", 1)[0]
            if "/" in repo and "." not in repo.split("/")[0]:
                repo = "docker.io/" + repo
            return {"id": iid, "repoDigests": [f"{repo}@{dg}"], "size": 1000}
    return None


hostio.container = fake_container
hostio.image = fake_image


def refused(fn, needle: str, label: str) -> None:
    try:
        fn()
    except plans.PlanRefused as e:
        ok(needle.lower() in str(e).lower(), f"{label}  ({e})")
        return
    ok(False, f"{label}  (a plan was MADE)")


A = avail()
print("── PLANS: what runs -> what main pins ───────────────────────────")
p = plans.plan("web", cfg=cfg, available=A)
ok(p["from"]["image"] == "example.invalid/web:1.0.0" and p["from"]["digest"] == D("a"), "from: the running tag@digest")
ok(p["to"]["image"] == "example.invalid/web:1.0.1" and p["to"]["digest"] == D("b"),
   "to: the pinned tag, with discovery's digest - never a request's")
ok(p["level"] == "patch" and p["confirm"] == "click" and p["oneWay"] is False, "a patch, click-to-confirm, two-way")
ok(p["pin"]["file"] == "compose.yml" and p["pin"]["line"] == 4 and p["pin"]["commit"] == git("rev-parse", "HEAD"),
   "the pin: file, line and commit")
ok(p["changelog"] == "https://example.invalid/releases/tag/v1.0.1", "the changelog names the target")
ok(p["restarts"] == ["t-web", "nothing much"] and p["recipe"] == "just up-web", "restarts and the recipe")
ok(p["snapshot"]["kind"] == "image" and p["downtime"] and p["signedOut"] == "nobody", "snapshot, downtime, who signs out")
ok(len(p["id"]) == 24 and plans.plan("web", cfg=cfg, available=A)["id"] == p["id"],
   "the id is stable for the same facts")
ok(plans.plan("web", cfg=cfg, available=avail(web_resolved=D("e")))["id"] != p["id"],
   "…and changes when discovery's digest does")
pl = plans.plan("loki", cfg=cfg, available=A)
ok(pl["snapshot"]["kind"] == "loki" and "restored ONLY if" in pl["rollback"], "a timeseries plan: the loki snapshot and the restore rule")
ok(pl["to"]["image"] == "grafana/loki:3.7.7", "a quoted pin is read without its quotes")

refused(lambda: plans.plan("graf", cfg=cfg, available=A), "class app-db is not handled",
        "out of scope: an app-db component the updater has no snapshot for")
refused(lambda: plans.plan("nope", cfg=cfg, available=A), "not in updates.toml", "a component outside the catalog")
refused(lambda: plans.plan("flo", cfg=cfg, available=A), "floating", "a floating pin")
refused(lambda: plans.plan("web", "1.0.2", cfg=cfg, available=A), "not what main pins", "a --target main does not pin")
ok(plans.plan("web", "1.0.1", cfg=cfg, available=A)["id"] == p["id"], "…while the pinned tag as --target is fine")
refused(lambda: plans.plan("web", cfg=cfg, available=avail(web_tag="1.0.0")), "older than the checkout",
        "discovery saw another pin than the checkout has")
refused(lambda: plans.plan("web", cfg=cfg, available=avail(web_resolved=None)), "digest", "the digest is unknown")
refused(lambda: plans.plan("web", cfg=cfg, available={"version": 1, "components": {}}), "not discovered",
        "not in available.json")

RUNNING["t-web"] = ("example.invalid/web:1.0.1", "sha256:" + "3" * 64, D("b"))
refused(lambda: plans.plan("web", cfg=cfg, available=A), "nothing to deploy", "it already runs what main pins")
RUNNING["t-web"] = ("example.invalid/web:1.0.1", "sha256:" + "3" * 64, D("9"))
refused(lambda: plans.plan("web", cfg=cfg, available=A), "re-published", "the pinned tag moved under the container")
RUNNING["t-web"] = ("example.invalid/web:1.0.2", "sha256:" + "4" * 64, D("5"))
refused(lambda: plans.plan("web", cfg=cfg, available=A), "not newer", "a downgrade")
RUNNING["t-web"] = ("example.invalid/web:0.9.0", "sha256:" + "6" * 64, D("6"))
refused(lambda: plans.plan("web", cfg=cfg, available=A), "major", "a major (0.9.0 -> 1.0.1)")
saved = RUNNING.pop("t-web")
refused(lambda: plans.plan("web", cfg=cfg, available=A), "not running", "the container is not running")
RUNNING["t-web"] = ("example.invalid/web:1.0.0", "sha256:" + "1" * 64, D("a"))

write_compose(web="1.0.3")
refused(lambda: plans.plan("web", cfg=cfg, available=A), "local changes", "a dirty pin file")
git("checkout", "-q", "--", "compose.yml")
git("commit", "-q", "--allow-empty", "-m", "local only")
refused(lambda: plans.plan("web", cfg=cfg, available=A), "not on origin/main", "HEAD ahead of origin/main")
git("push", "-q", "origin", "main")
ok(plans.plan("web", cfg=cfg, available=A)["id"] != p["id"], "a new commit on main makes a new id (the old plan is stale)")
git("checkout", "-q", "-b", "feature")
refused(lambda: plans.plan("web", cfg=cfg, available=A), "not main", "a checkout not on main")
git("checkout", "-q", "main")

print()
print("── APP-DB (step 5): one-way plans, and components with two pins ─")
g = plans.plan("grafana", cfg=cfg, available=A)
ok(g["class"] == "app-db" and g["oneWay"] is True and g["confirm"] == "type-name" and g["level"] == "minor",
   "grafana 13.1.4 -> 13.2.2: one-way, so type-the-name, even for a minor")
ok(g["snapshot"]["kind"] == "grafana" and "STOPPED" in g["snapshot"]["what"] and "plugins" in g["snapshot"]["what"],
   f"the snapshot: Grafana stopped, the whole volume: {g['snapshot']['what'][:70]}")
ok("restored FIRST" in g["rollback"] and "always" in g["rollback"], "the rollback ALWAYS restores, before the old image")
ok(any("~/backups/{postgres,grafana}" in x for x in g["preflight"]), "pre-flight wants a fresh postgres AND grafana backup")
ok(any("database ok" in v for v in g["verify"]) and any("dashboards" in v for v in g["verify"])
   and any("uid=prometheus" in v for v in g["verify"]), "verify: health + version, the dashboard count, the datasource")
ok(len(g["pins"]) == 1 and g["pins"][0]["service"] == "grafana", "one pin, listed")

k = plans.plan("keycloak", cfg=cfg, available=A)
ok(k["class"] == "app-db" and k["confirm"] == "type-name" and k["snapshot"]["kind"] == "keycloak"
   and "pg_dump -Fc" in k["snapshot"]["what"], "keycloak: type-the-name, a pg_dump -Fc snapshot")
ok([(q["service"], q["line"], q["container"]) for q in k["pins"]] == [("keycloak", 19, "t-kc"),
                                                                      ("kc-init", 22, "t-kc-init")],
   f"BOTH pin lines are in the plan: {[(q['service'], q['line']) for q in k['pins']]}")
ok(k["restarts"] == ["t-kc", "t-kc-init", "oauth2-proxy", "every gated route"],
   f"restarts: both containers, then the dependants: {k['restarts']}")
ok("1-2 min" in k["downtime"] and "FAILS CLOSED" in k["downtime"] and "logins are unavailable" in k["downtime"],
   "downtime: logins out ~1-2 min, gated routes fail closed")
ok("persists user sessions" in k["signedOut"] and "26.0.0" in k["signedOut"], "signed out: nobody - 26.x persists sessions")
ok(any("t-kc and t-kc-init" in x for x in k["preflight"]), "the scope check names both containers")
ok(k["to"]["image"] == "quay.io/keycloak/keycloak:26.7.4-0" and k["to"]["digest"] == D("e"), "to: the pinned tag@digest")

write_compose(kci="26.7.3-0")
git("commit", "-q", "-am", "bump keycloak but not keycloak-init")
git("push", "-q", "origin", "main")
refused(lambda: plans.plan("keycloak", cfg=cfg, available=A), "pins disagree",
        "two pins naming different tags are refused (a half-bumped PR)")
write_compose(kci="26.7.4-0@" + D("9"))
git("commit", "-q", "-am", "the second pin carries a digest")
git("push", "-q", "origin", "main")
refused(lambda: plans.plan("keycloak", cfg=cfg, available=A), "same tag@digest",
        "the same tag, but one with a digest and one without, is refused too")
write_compose()
git("commit", "-q", "-am", "pins agree again")
git("push", "-q", "origin", "main")
k2 = plans.plan("keycloak", cfg=cfg, available=A)
ok(k2["pins"] == k["pins"] and k2["id"] != k["id"], "agreeing again: a plan, with a new id (a new commit)")
with open(os.path.join(REPO, "compose.yml"), "a") as fh:
    fh.write("# a local edit\n")
refused(lambda: plans.plan("keycloak", cfg=cfg, available=A), "local changes", "a dirty pin file refuses both pins")
git("checkout", "-q", "--", "compose.yml")

print()
print("── write_all: one file per component, 600 in 700 ────────────────")
hostio.write_json(cfg.available, A)
got = plans.write_all(cfg)
ok(set(got) == {"web", "loki", "graf", "flo", "grafana", "keycloak"}, f"a file per catalog component: {sorted(got)}")
ok(not got["web"].startswith("- ") and got["graf"].startswith("- "), "web has a plan; graf has a reason")
ok(oct(os.stat(cfg.plans).st_mode & 0o777) == "0o700" and
   all(oct(os.stat(os.path.join(cfg.plans, f)).st_mode & 0o777) == "0o600" for f in os.listdir(cfg.plans)),
   "plans/ is 700, every plan 600")
doc = plans.read_plan(cfg, "graf")
ok(doc["ok"] is False and "not handled" in doc["reason"], "a refusal is written with its reason")
open(os.path.join(cfg.plans, "gone.json"), "w").write("{}")
plans.write_all(cfg)
ok(not os.path.exists(os.path.join(cfg.plans, "gone.json")), "a plan for a component no longer in the catalog is removed")

print()
print("── SPOOL: what a request may be ─────────────────────────────────")
import updates  # noqa: E402
cat = updates.load(cfg.catalog)
cur = plans.read_plan(cfg, "web")["plan"]
JOB = "a" * 32


def req(**kw) -> dict:
    d = {"v": 1, "jobId": JOB, "component": "web", "planId": cur["id"], "confirm": True,
         "requestedBy": "op@example.com", "requestedAt": "2026-09-19T10:00:00Z"}
    d.update(kw)
    return d


def invalid(fn, needle: str, label: str) -> None:
    try:
        fn()
    except spool.Invalid as e:
        ok(needle.lower() in str(e).lower(), f"{label}  ({e})")
        return
    ok(False, f"{label}  (ACCEPTED)")


ok(spool.validate_against(spool.validate_shape(req(), f"{JOB}.json"), cat, plans.read_plan(cfg, "web"))["id"] == cur["id"],
   "a well-formed request for the current plan is accepted")
invalid(lambda: spool.validate_shape(req(extra=1), f"{JOB}.json"), "keys", "an extra key")
invalid(lambda: spool.validate_shape(req(), f"{'b' * 32}.json"), "file name", "a job id that is not the file's")
invalid(lambda: spool.validate_shape(req(planId="../../etc"), f"{JOB}.json"), "plan id", "a plan id that is not 24 hex")
invalid(lambda: spool.validate_shape(req(component="Web;rm"), f"{JOB}.json"), "component", "a component id that is not one")
invalid(lambda: spool.validate_shape(req(confirm="yes please"), f"{JOB}.json"), "confirm", "a confirm that is neither")
invalid(lambda: spool.validate_against(req(planId="0" * 24), cat, plans.read_plan(cfg, "web")), "not the current plan",
        "a TAMPERED plan id (well-formed, not the host's)")
invalid(lambda: spool.validate_against(req(component="nope"), cat, None), "not in updates.toml", "an unknown component")
invalid(lambda: spool.validate_against(req(component="graf"), cat, plans.read_plan(cfg, "graf")),
        "does not handle", "a component outside the updater's classes")
RUNNING["t-web"] = ("example.invalid/web:0.9.0", "sha256:" + "6" * 64, D("6"))
plans.write_all(cfg)
invalid(lambda: spool.validate_against(req(), cat, plans.read_plan(cfg, "web")), "no deployable plan",
        "a MAJOR has no plan, so no request for it can name one")
RUNNING["t-web"] = ("example.invalid/web:1.0.0", "sha256:" + "1" * 64, D("a"))
plans.write_all(cfg)
cur = plans.read_plan(cfg, "web")["plan"]
invalid(lambda: spool.validate_against(req(confirm="web"), cat, plans.read_plan(cfg, "web")), "confirmation",
        "a type-the-name confirm on a click plan")
gp = plans.read_plan(cfg, "grafana")
invalid(lambda: spool.validate_against(req(component="grafana", planId=gp["plan"]["id"], confirm=True), cat, gp),
        "confirmation", "EXECUTOR side: a click (confirm: true) on a one-way plan is refused")
invalid(lambda: spool.validate_against(req(component="grafana", planId=gp["plan"]["id"], confirm="keycloak"), cat, gp),
        "confirmation", "…and so is another component's name")
ok(spool.validate_against(req(component="grafana", planId=gp["plan"]["id"], confirm="grafana"), cat, gp)["id"]
   == gp["plan"]["id"], "the component's own id is accepted")

sp = cfg.spool
with open(os.path.join(sp, f"{'c' * 32}.json"), "w") as fh:
    fh.write(" " * 5000)
invalid(lambda: spool.read(sp, f"{'c' * 32}.json"), "limit", "an oversized request")
os.symlink("/etc/passwd", os.path.join(sp, f"{'d' * 32}.json"))
invalid(lambda: spool.read(sp, f"{'d' * 32}.json"), "open", "a symlink is never followed")
os.mkdir(os.path.join(sp, f"{'e' * 32}.json"))
open(os.path.join(sp, "junk.txt"), "w").write("x")
reqs, junk = spool.entries(sp)
ok([n for _, n in reqs] == [f"{'c' * 32}.json"] and set(junk) == {f"{'d' * 32}.json", f"{'e' * 32}.json", "junk.txt"},
   f"only regular <hex>.json files are requests; the rest is junk: {sorted(junk)}")
for n in junk:
    spool.remove(sp, n)
ok(os.path.exists("/etc/passwd") and sorted(os.listdir(sp)) == [f"{'c' * 32}.json"],
   "junk (a symlink, a directory) is removed without touching what a link points at")
os.unlink(os.path.join(sp, f"{'c' * 32}.json"))

print()
print("── the executor refuses bad requests and records them ───────────")


def drop(doc: dict | str, name: str) -> None:
    with open(os.path.join(sp, name), "w") as fh:
        fh.write(doc if isinstance(doc, str) else json.dumps(doc))


drop(req(planId="0" * 24, jobId="1" * 32), f"{'1' * 32}.json")
drop("{not json", f"{'2' * 32}.json")
drop(req(component="graf", planId=cur["id"], jobId="3" * 32), f"{'3' * 32}.json")
drop(req(component="nope", jobId="4" * 32), f"{'4' * 32}.json")
drop(req(component="grafana", planId=gp["plan"]["id"], confirm=True, jobId="6" * 32), f"{'6' * 32}.json")
executor.run_spool(cfg, log=lambda *_: None)
hist = {h["id"]: h for h in record.history(cfg)}
ok(os.listdir(sp) == [], "every request was claimed (removed), valid or not")
ok(all(hist.get(c * 32, {}).get("state") == "refused" for c in "1234"),
   f"all four refused: {[hist.get(c * 32, {}).get('state') for c in '1234']}")
ok("not the current plan" in hist["1" * 32]["error"] and "not JSON" in hist["2" * 32]["error"]
   and "does not handle" in hist["3" * 32]["error"] and "not in updates.toml" in hist["4" * 32]["error"],
   "each with its reason")
ok(hist.get("6" * 32, {}).get("state") == "refused" and "confirmation" in hist["6" * 32]["error"],
   "a one-way request written straight into the spool with confirm: true is refused by the executor")
audit = open(cfg.audit_file).read()
ok(audit.count("\tvalidate\tfailed\t") == 5 and audit.count("\tresult\trefused\t") == 5,
   "audit.log: a failed validate and a refused result per request")
st = hostio.read_json(cfg.status_file)["job"]
ok(st["state"] == "refused" and all(s["state"] in ("failed", "skipped", "ok") for s in st["steps"]),
   "status.json ends in the last job's result, no step left pending")
ok(oct(os.stat(cfg.status_file).st_mode & 0o777) == "0o600" and
   oct(os.stat(cfg.history_file).st_mode & 0o777) == "0o600", "status.json and history.jsonl are 600")
drop(req(jobId="1" * 32, planId=cur["id"]), f"{'1' * 32}.json")
executor.run_spool(cfg, log=lambda *_: None)
ok("used before" in record.history(cfg, 1)[0]["error"], "a job id is never reused")

print()
print("── PINS: one line, strictly ─────────────────────────────────────")
pl = pins.locate(REPO, "compose.yml", "web")
ok(pl.line == 4 and pl.value == "example.invalid/web:1.0.1" and pl.container == "t-web", "located: line, value, container")
new = pins.replace(REPO, pl, "example.invalid/web:1.0.0")
ok(new == "    image: example.invalid/web:1.0.0   # pinned by the test", f"the comment survives: {new!r}")
diff = git("diff", "--numstat")
ok(diff.startswith("1\t1\t"), f"exactly one line changed: {diff}")
try:
    pins.replace(REPO, pl, "example.invalid/web:1.0.2")
    ok(False, "a stale PinLine is refused (was ACCEPTED)")
except hostio.HostError as e:
    ok("no longer reads exactly" in str(e), f"a stale PinLine is refused ({e})")
git("checkout", "-q", "--", "compose.yml")
lq = pins.locate(REPO, "compose.yml", "loki")
ok(pins.replace(REPO, lq, "grafana/loki:3.7.6") == '    image: "grafana/loki:3.7.6"', "the quote style survives")
try:
    pins.replace(REPO, pins.locate(REPO, "compose.yml", "web"), "evil; rm -rf /")
    ok(False, "a value that is not an image reference is refused (ACCEPTED)")
except hostio.HostError:
    ok(True, "a value that is not an image reference is refused")
git("checkout", "-q", "--", "compose.yml")

print()
print("── LOCK: one run at a time ──────────────────────────────────────")
drop(req(jobId="5" * 32, planId=cur["id"]), f"{'5' * 32}.json")
holder = subprocess.Popen([sys.executable, "-c", (
    "import fcntl,os,sys,time; fd=os.open(sys.argv[1], os.O_RDWR|os.O_CREAT, 0o600); "
    "fcntl.flock(fd, fcntl.LOCK_EX); print('held', flush=True); time.sleep(30)"), cfg.lock_file],
    stdout=subprocess.PIPE, text=True)
holder.stdout.readline()
said: list[str] = []
t0 = time.monotonic()
rc = executor.run_spool(cfg, log=said.append)
ok(rc == 0 and "holds the lock" in " ".join(said) and time.monotonic() - t0 < 5,
   f"a second run returns at once and says why: {said}")
ok(os.listdir(sp) == [f"{'5' * 32}.json"], "…and leaves the queue for the holder")
holder.kill()
holder.wait()
os.unlink(os.path.join(sp, f"{'5' * 32}.json"))

print()
print("── RECORD: the textfile metric ──────────────────────────────────")
record.write_metrics(cfg)
prom = open(os.path.join(cfg.textfile, "bothy_updater.prom")).read()
rows = [ln for ln in prom.splitlines() if ln.startswith("bothy_update_last_result{")]
by: dict[str, list[str]] = {}
for ln in rows:
    comp = ln.split('component="')[1].split('"')[0]
    by.setdefault(comp, []).append(ln)
ok(all(sum(1 for ln in v if ln.endswith(" 1")) == 1 and len(v) == len(record.RESULTS) for v in by.values()),
   f"exactly one result is 1 per component: {sorted(by)}")
ok('bothy_update_last_result{component="web",result="refused"} 1' in prom, "web's last result is refused")
ok(oct(os.stat(os.path.join(cfg.textfile, "bothy_updater.prom")).st_mode & 0o777) == "0o644",
   "644, so node-exporter (nobody) can read it")

shutil.rmtree(TMP, ignore_errors=True)
print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("updater units: all passed")
