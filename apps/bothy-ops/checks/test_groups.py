#!/usr/bin/env python3
"""Applying a whole `apply` recipe at once: the decisions, as units.

Run: python3 checks/test_groups.py

No docker and no network: the same throwaway git repository and catalog shape
test_updater.py uses, with `docker inspect` and `docker compose config --hash`
replaced by tables. What it pins down:

  MEMBERSHIP   a group is a recipe with TWO OR MORE components the updater
               deploys as compose image pins - never a cluster add-on, the
               Postgres major, Bothy itself or the auth boundary, whose changes a
               rollback could not put back on a pin line
  THE UNION    the group's treatment is the strictest of its members', not the
               loosest: one one-way member makes the WHOLE group type-the-name
               (and the name typed is the RECIPE's), the level is the largest
               step, the required backups and the snapshot kinds are the unions,
               and the disk estimate is the sum
  THE SCOPE    the rule is unchanged - it is applied to the UNION of the members'
               services, and anything else the recipe would recreate still
               refuses, NAMED: whose service it is, and why the group will not
               carry it (another class, another recipe, a config-only change, or
               nothing in updates.toml owns it)
  THE ID       a hash of the member plans, so a member moving, the checkout
               moving or a container changing makes the old group plan stale
  THE REFUSAL  a single component's scope refusal now names the ACTION - the
               group - or, where its recipe has no group, says so and why
  THE SPOOL    a group request is `kind: "group"` with exact keys; never the
               night job's actor, never a note, and the typed confirmation is
               the recipe's id. The executor re-checks all of it.
  THE JOB      snapshots of EVERY member before ANY pull, one-way members first;
               ONE recipe run; every member verified; and an all-or-nothing
               rollback that restores a one-way member's data first, writes every
               pin line back and runs the recipe once
  THE PAUSE    a group job that rolled back pauses every `auto` member it moved,
               which it could not do from its `component` (the recipe) alone
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)
os.environ.setdefault("ADMIN_AUDIT_LOG", os.devnull)

import updates  # noqa: E402
import updater  # noqa: E402,F401
from updater import auto, classes, executor, groups, hostio, plans, record, spool  # noqa: E402
from updater.config import Config  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def D(c: str) -> str:
    return "sha256:" + c * 64


TMP = tempfile.mkdtemp(prefix="bothy-groups-unit-")
ORIGIN = os.path.join(TMP, "origin.git")
REPO = os.path.join(TMP, "repo")
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]


def git(*args: str, cwd: str = REPO) -> str:
    return subprocess.run([*GIT, *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


# `up-web` has three components the updater deploys (one of them one-way) plus
# `extra`, a service of the same compose project that NO component owns; `up-solo`
# has one, so it is never a group; `ksm` is a cluster add-on, whose class the group
# path must refuse to carry whatever its recipe is.
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
dependants = []
changelog = "https://example.invalid/web/v{version}"
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

[components.solo]
title = "Solo"
class = "stateless"
source = "image"
pins = ["other.yml:solo"]
apply = "just up-solo"
dependants = []
changelog = "https://example.invalid/solo"
channel = "notify"
one_way = false
verify = ["x"]

[components.o2p]
title = "oauth2-proxy"
class = "boundary"
source = "image"
pins = ["compose.yml:o2p"]
apply = "just up-web"
dependants = ["every gated route"]
changelog = "https://example.invalid/o2p/v{version}"
channel = "manual"
one_way = false
verify = ["viewer 202, shell 403"]

[components.ksm]
title = "kube-state-metrics"
class = "cluster"
source = "helm"
chart = "kube-state-metrics"
chart_repo = "https://example.invalid/charts"
release = "monitoring/kube-state-metrics"
pins = ["Chart.yaml:kube-state-metrics"]
apply = "just up-web"
dependants = []
changelog = "https://example.invalid/ksm/{version}"
channel = "notify"
one_way = false
verify = ["deployed"]
"""

COMPOSE = """name: t
services:
  web:
    image: example.invalid/web:{web}   # pinned by the test
    container_name: t-web
  loki:
    image: "grafana/loki:{loki}"
    container_name: t-loki
  grafana:
    image: grafana/grafana:{grafana}
    container_name: t-grafana
  extra:
    image: example.invalid/extra:9.9.9
    container_name: t-extra
  o2p:
    image: example.invalid/o2p:7.15.5
    container_name: t-o2p
"""


def write_compose(web="1.0.1", loki="3.7.7", grafana="13.2.2") -> None:
    with open(os.path.join(REPO, "compose.yml"), "w") as fh:
        fh.write(COMPOSE.format(web=web, loki=loki, grafana=grafana))


os.makedirs(ORIGIN)
subprocess.run(["git", "init", "-q", "--bare", "-b", "main", ORIGIN], check=True)
subprocess.run(["git", "clone", "-q", ORIGIN, REPO], check=True, capture_output=True)
git("checkout", "-q", "-b", "main")
write_compose()
with open(os.path.join(REPO, "other.yml"), "w") as fh:
    fh.write("name: o\nservices:\n  solo:\n    image: example.invalid/solo:2.0.0\n    container_name: t-solo\n")
with open(os.path.join(REPO, "Chart.yaml"), "w") as fh:
    fh.write("dependencies:\n  - name: kube-state-metrics\n    version: 8.6.0\n")
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
catalog = updates.load(cfg.catalog)

A = {"version": 1, "generatedAt": "2026-10-07T10:00:00Z", "components": {
    "web": {"image": "example.invalid/web", "current": {"tag": "1.0.1", "float": False, "resolved": D("b")}},
    "loki": {"image": "docker.io/grafana/loki", "current": {"tag": "3.7.7", "float": False, "resolved": D("d")}},
    "grafana": {"image": "docker.io/grafana/grafana", "current": {"tag": "13.2.2", "float": False,
                                                                  "resolved": D("f")}},
    "solo": {"image": "example.invalid/solo", "current": {"tag": "2.0.0", "float": False, "resolved": D("9")}},
}}

# docker inspect, replaced by a table: container -> (image, imageId, digest)
RUNNING = {
    "t-web": ("example.invalid/web:1.0.0", "sha256:" + "1" * 64, D("a")),
    "t-loki": ("grafana/loki:3.7.6", "sha256:" + "2" * 64, D("c")),
    "t-grafana": ("grafana/grafana:13.1.4", "sha256:" + "7" * 64, D("7")),
    "t-extra": ("example.invalid/extra:9.9.9", "sha256:" + "3" * 64, D("3")),
    "t-solo": ("example.invalid/solo:2.0.0", "sha256:" + "4" * 64, D("9")),
    "t-o2p": ("example.invalid/o2p:7.15.4", "sha256:" + "6" * 64, D("6")),
}
PROJECT = {n: "t" for n in RUNNING}


def fake_container(name):
    if name not in RUNNING:
        return None
    img, iid, _ = RUNNING[name]
    return {"name": name, "image": img, "imageId": iid, "state": "running", "health": "healthy",
            "labels": {"com.docker.compose.project": PROJECT[name],
                       "com.docker.compose.service": name[len("t-"):]}}


def fake_image(ref):
    for img, iid, dg in RUNNING.values():
        if ref == iid:
            repo = img.rsplit(":", 1)[0]
            if "/" in repo and "." not in repo.split("/")[0]:
                repo = "docker.io/" + repo
            return {"id": iid, "repoDigests": [f"{repo}@{dg}"], "size": 1000}
    return None


# `docker compose config --hash "*"` and the labels, replaced by a table: every
# service of project `t`, and which of them compose WOULD recreate.
DIFFERS = {"web", "loki", "grafana"}


def fake_project(repo, name, pin_file, pin_service):
    if name not in RUNNING:
        raise hostio.HostError(f"{name} is not running")
    want = {s: f"want-{s}" for s in ("web", "loki", "grafana", "extra", "o2p")}
    have = {s: (f"old-{s}" if s in DIFFERS else f"want-{s}") for s in want}
    return {"project": "t", "files": [os.path.join(repo, "compose.yml")], "wd": repo, "want": want, "have": have}


hostio.container = fake_container
hostio.image = fake_image
hostio.compose_project = fake_project


def refused(fn, needle: str, label: str) -> None:
    try:
        fn()
    except plans.PlanRefused as e:
        ok(needle.lower() in str(e).lower(), f"{label}  ({str(e)[:150]})")
        return
    ok(False, f"{label}  (a plan was MADE)")


print("── MEMBERSHIP: a recipe with two or more components it can deploy ─")
gs = groups.groups_of(catalog)
ok(gs == {"up-web": ["grafana", "loki", "web"]}, f"one group, and only the compose image pins in it: {gs}")
ok("up-solo" not in gs, "a recipe with one component is not a group - its own row is the answer")
ok("ksm" not in gs.get("up-web", []),
   "a cluster add-on is never a member, whatever its recipe: a rollback could not put its change back on a pin line")
ok("o2p" not in gs.get("up-web", []),
   "the AUTH BOUNDARY is never a member either, however ordinary its pin looks - the updater does not deploy it at all")
ok(groups.group_of(catalog, "loki") == "up-web" and groups.group_of(catalog, "solo") is None
   and groups.group_of(catalog, "ksm") is None, "group_of answers for a member and for nobody else")
ok(groups.recipe_of(catalog.components["loki"]) == "up-web", "the group id is the recipe, not the file or the project")

print()
print("── THE UNION: the strictest of its members', never the loosest ───")
g, members = groups.resolve("up-web", cfg=cfg, catalog=catalog, available=A)
ok([m["component"] for m in g["memberRows"]] == ["grafana", "loki", "web"], "every deployable member is in it")
ok(g["level"] == "minor", f"the level is the LARGEST step any member takes: {g['level']}")
ok(g["confirm"] == "type-name" and g["confirmWord"] == "up-web",
   "one one-way member makes the WHOLE group type-the-name, and the name is the RECIPE's")
ok(g["oneWay"] is True and "grafana" in (g["oneWayWhy"] or ""), "it says which member is one-way, and why")
ok(g["backupKinds"] == ["grafana", "loki", "postgres"],
   f"the required backups are the UNION of the members': {g['backupKinds']}")
ok(sorted(g["snapshot"]["kinds"]) == ["grafana", "image", "loki"],
   f"every member's own snapshot kind: {g['snapshot']['kinds']}")
ok(g["services"] == ["grafana", "loki", "web"], f"the services one compose up recreates: {g['services']}")
ok(g["project"] == "t" and g["recipe"] == "just up-web", "the project is read from a member's container")
ok("ALL OR NOTHING" in g["rollback"] and "no partial rollback" in g["rollback"],
   "the rollback says plainly that it is all of them, together")
ok(any("the actor is a person, never the night job" in x for x in g["preflight"]),
   "pre-flight says a group is never automatic")
ok(all(any(m["component"] in v for v in g["verify"]) for m in g["memberRows"]),
   "verify covers EVERY member's canaries, not just one")
ok(g["kind"] == "group" and len(g["members"]) == 3, "the plan names its kind and its members")

print()
print("── THE ID: a hash of the member plans ───────────────────────────")
again = groups.plan("up-web", cfg=cfg, catalog=catalog, available=A)
ok(again["id"] == g["id"], "stable across calls")
RUNNING["t-web"] = ("example.invalid/web:1.0.0", "sha256:" + "5" * 64, D("a"))
moved = groups.plan("up-web", cfg=cfg, catalog=catalog, available=A)
ok(moved["id"] != g["id"], "a member's container changing makes the old group id stale")
RUNNING["t-web"] = ("example.invalid/web:1.0.0", "sha256:" + "1" * 64, D("a"))
ok(groups.plan("up-web", cfg=cfg, catalog=catalog, available=A)["id"] == g["id"], "…and back again when it does not")

print()
print("── THE SCOPE: the union, and every leftover NAMED ───────────────")
DIFFERS.add("extra")
refused(lambda: groups.plan("up-web", cfg=cfg, catalog=catalog, available=A),
        "no component in updates.toml owns it",
        "a service of the project nobody owns refuses the group, and says so")
try:
    groups.plan("up-web", cfg=cfg, catalog=catalog, available=A)
except plans.PlanRefused as e:
    ok("extra" in str(e) and "image pins only" in str(e),
       "…naming the service, and that the group moves image pins only")
DIFFERS.discard("extra")

print()
print("── fewer than two members: not a group, with each reason ────────")
refused(lambda: groups.plan("up-web", cfg=cfg, catalog=catalog, available={"version": 1, "components": {}}),
        "not discovered yet", "a member discovery has not seen refuses the whole group")
write_compose(web="1.0.0")          # web now runs what main pins
git("add", "compose.yml")
git("commit", "-q", "-m", "web applied")
git("push", "-q", "origin", "main")
DIFFERS.discard("web")              # …so compose would not recreate it either
A2 = json.loads(json.dumps(A))
A2["components"]["web"]["current"].update(tag="1.0.0", resolved=D("a"))
g2 = groups.plan("up-web", cfg=cfg, catalog=catalog, available=A2)
ok(len(g2["memberRows"]) == 2 and [s["component"] for s in g2["skipped"]] == ["web"],
   "two members is still a group, and the third is listed as skipped with its reason")
ok("nothing to deploy" in g2["skipped"][0]["reason"], f"…its reason is the host's own: {g2['skipped'][0]['reason']}")
A3 = json.loads(json.dumps(A2))
A3["components"]["loki"]["current"].update(tag="3.7.6", resolved=D("c"))
write_compose(web="1.0.0", loki="3.7.6")
git("add", "compose.yml")
git("commit", "-q", "-m", "loki applied")
git("push", "-q", "origin", "main")
DIFFERS.discard("loki")
refused(lambda: groups.plan("up-web", cfg=cfg, catalog=catalog, available=A3), "a group is for two or more",
        "one member left is not a group: its own row is the action")
refused(lambda: groups.plan("up-solo", cfg=cfg, catalog=catalog, available=A3), "is not a recipe with two or more",
        "a recipe that never had two is refused by name")
refused(lambda: groups.plan("../etc", cfg=cfg, catalog=catalog, available=A3), "not a group id",
        "a group id is validated before it is used as a path")
write_compose()
git("add", "compose.yml")
git("commit", "-q", "-m", "back")
git("push", "-q", "origin", "main")
DIFFERS.update({"web", "loki"})

print()
print("── THE REFUSAL names the action, not a shell ────────────────────")
word = groups.instead(catalog.components["loki"], cfg)
ok("Apply all of just up-web" in word and "up-web" in word, f"a member's refusal names the group: {word[:90]}")
word = groups.instead(catalog.components["solo"], cfg)
ok("no group for" in word and "by hand" in word,
   f"a component whose recipe has no group is told THAT, and why: {word[:110]}")
p_loki = plans.plan("loki", cfg=cfg, catalog=catalog, available=A)
x = executor.Execution(cfg, record.Recorder(cfg, record.new_job({}, "0" * 32 + ".json")),
                       catalog.components["loki"], p_loki)
try:
    x._scope()
    ok(False, "the scope check let a project with three pending services through")
except executor.Refuse as e:
    ok("grafana" in str(e) and "web" in str(e) and "Apply all of just up-web" in str(e),
       f"the live refusal names the others AND the group: {str(e)[:170]}")

print()
print("── THE SPOOL: a group request, and what the executor refuses ────")
G = groups.plan("up-web", cfg=cfg, catalog=catalog, available=A)
groups.write_all(cfg, catalog, A)
ok(oct(os.stat(cfg.groups).st_mode & 0o777) == "0o700"
   and oct(os.stat(os.path.join(cfg.groups, "up-web.json")).st_mode & 0o777) == "0o600",
   "groups/ is 700 and each group plan 600, like plans/")
ok(sorted(os.listdir(cfg.groups)) == ["up-web.json"], "one file per group, keyed by the recipe")
open(os.path.join(cfg.groups, "up-gone.json"), "w").write("{}")
groups.write_all(cfg, catalog, A)
ok("up-gone.json" not in os.listdir(cfg.groups), "a group the catalog no longer has is removed")


def req(**kw) -> dict:
    d = {"v": 1, "jobId": "a" * 32, "kind": "group", "group": "up-web", "planId": G["id"],
         "confirm": "up-web", "requestedBy": "someone@example.com", "requestedAt": "2026-10-07T10:00:00Z"}
    d.update(kw)
    return {k: v for k, v in d.items() if v is not None}


def shape_bad(doc, needle, label) -> None:
    try:
        spool.validate_shape(doc, f"{doc.get('jobId', '')}.json")
    except spool.Invalid as e:
        ok(needle.lower() in str(e).lower(), f"{label}  ({e})")
        return
    ok(False, f"{label}  (ACCEPTED)")


ok(spool.is_group(req()) and not spool.is_group({"component": "loki"}),
   "the two request shapes are told apart by `kind`, not by guessing from a key")
ok(spool.validate_shape(req(), "a" * 32 + ".json") == req(), "a well-formed group request is accepted")
shape_bad({**req(), "component": "loki"}, "not ['confirm'", "a request may not be BOTH a component and a group")
shape_bad(req(group="Up-Web"), "group id is malformed", "the group id is checked like a component id")
shape_bad(req(note="a note"), "not ['confirm'", "a group request carries no note")


def against_bad(doc, gdoc, needle, label) -> None:
    try:
        spool.validate_against_group(doc, catalog, gdoc)
    except spool.Invalid as e:
        ok(needle.lower() in str(e).lower(), f"{label}  ({str(e)[:120]})")
        return
    ok(False, f"{label}  (ACCEPTED)")


GDOC = {"version": 1, "group": "up-web", "ok": True, "plan": G}
ok(spool.validate_against_group(req(), catalog, GDOC)["id"] == G["id"], "the current group plan is accepted")
against_bad(req(requestedBy="auto"), GDOC, "never automatic",
            "the executor refuses a group request from the night job's actor")
against_bad(req(confirm=True), GDOC, "confirmation does not match",
            "a click will not do for a group with a one-way member")
against_bad(req(confirm="grafana"), GDOC, "confirmation does not match",
            "nor will a MEMBER's name: the group is what is approved")
against_bad(req(planId="0" * 24), GDOC, "is not the current plan", "a tampered group plan id is refused")
against_bad(req(group="up-solo"), GDOC, "two or more", "a recipe that is not a group is refused")
against_bad(req(), {"version": 1, "group": "up-web", "ok": False, "reason": "nope"}, "no deployable group plan",
            "a group the host refused is refused here too")
against_bad(req(), None, "no group plan file", "a group with no file at all is refused")
# `note` is stripped by validate_shape, so reach validate_against_group directly.
against_bad({**req(), "note": "a maintenance note here"}, GDOC, "only for a plan that asks for one",
            "a note smuggled past the shape check is refused")

print()
print("── THE JOB: every snapshot first, one apply, all of them back ───")
LOG: list[str] = []


def patched(name, fn):
    setattr(executor.Execution, name, fn)


patched("_backups", lambda self: f"backups {self.comp.id}")
patched("_disk", lambda self: "disk ok")
patched("_health", lambda self: f"{self.container} healthy")
patched("_baseline", lambda self: (LOG.append(f"baseline:{self.comp.id}"), "green")[1])


def fake_snapshot(self, into=None):
    LOG.append(f"snapshot:{self.comp.id}")
    os.makedirs(into, exist_ok=True)
    self.artefact = os.path.join(into, "data")
    open(self.artefact, "w").write("x")
    return f"{into}: fake"


def fake_pull(self):
    LOG.append(f"pull:{self.comp.id}")
    return "sha256:" + "e" * 64


def fake_recipe(self):
    LOG.append(f"recipe:{self.comp.id}")


patched("snapshot", fake_snapshot)
patched("pull", fake_pull)
patched("_recipe", fake_recipe)

VERIFY_OK = [True]


def fake_check(self, image_id, phase):
    LOG.append(f"check:{phase}:{self.comp.id}")
    if phase == "verify" and not VERIFY_OK[0]:
        return False, "the body never said ready", True
    return True, f"{self.container} healthy", True


patched("check", fake_check)
RESTORED: list[str] = []
classes.AppDb.restore = lambda self, cfg_, cid, name, art: (RESTORED.append(cid), (True, "restored"))[1]
classes.Timeseries.restore = lambda self, cfg_, cid, name, art: (RESTORED.append(cid), (True, "restored"))[1]

G = groups.plan("up-web", cfg=cfg, catalog=catalog, available=A)
_, members = groups.resolve("up-web", cfg=cfg, catalog=catalog, available=A)
rec = record.Recorder(cfg, record.new_job(req(), "b" * 32 + ".json"))
state = groups.GroupExecution(cfg, rec, G, members).go()
ok(state == "succeeded", f"a group apply that verifies succeeds: {state}")
snaps = [i for i, x in enumerate(LOG) if x.startswith("snapshot:")]
pulls = [i for i, x in enumerate(LOG) if x.startswith("pull:")]
ok(len(snaps) == 3 and len(pulls) == 3 and max(snaps) < min(pulls),
   f"EVERY member's snapshot is taken before ANY image is pulled: {LOG}")
ok(LOG[snaps[0]] == "snapshot:grafana",
   "the one-way member is snapshotted FIRST - its snapshot is the one that cannot be re-taken")
ok(len([x for x in LOG if x.startswith("recipe:")]) == 1, "ONE recipe run applies all three")
ok(len([x for x in LOG if x.startswith("check:verify:")]) == 3, "every member is verified, not only one")
ok(rec.job["component"] == "up-web" and sorted(rec.job["members"]) == ["grafana", "loki", "web"],
   "the record is about the RECIPE, and names the components it moved")
d = rec.job["snapshot"]
ok("group-up-web" in d and sorted(os.listdir(d)) == ["grafana", "loki", "web"],
   f"one snapshot directory for the group, a subdirectory per member: {d}")

LOG.clear()
RESTORED.clear()
VERIFY_OK[0] = False
G = groups.plan("up-web", cfg=cfg, catalog=catalog, available=A)
_, members = groups.resolve("up-web", cfg=cfg, catalog=catalog, available=A)
rec = record.Recorder(cfg, record.new_job(req(), "c" * 32 + ".json"))
state = groups.GroupExecution(cfg, rec, G, members).go()
ok(state == "rolled_back", f"a verify failure rolls the group back: {state}")
ok(RESTORED == ["grafana"],
   f"the one-way member's data goes back FIRST, and only it - a restore is never the first move for the rest: {RESTORED}")
text = open(os.path.join(REPO, "compose.yml")).read()
ok("example.invalid/web:1.0.0" in text and "grafana/loki:3.7.6" in text and "grafana/grafana:13.1.4" in text,
   "every member's pin line is written back - the whole group, together")
ok(len([x for x in LOG if x.startswith("recipe:")]) == 2, "one apply, then one rollback apply")
ok("no partial rollback" in (rec.job["note"] or ""), "and the record says there is no partial rollback")
git("checkout", "-q", "--", "compose.yml")
VERIFY_OK[0] = True

print()
print("── THE PAUSE: a group that rolled back pauses its auto members ──")
newly = auto.sync_pauses(cfg, catalog)
ok(sorted(newly) == ["loki", "web"],
   f"the rolled-back group paused every `auto` member it moved, by name: {newly}")
ok("up-web" not in auto.load_state(cfg)["paused"],
   "the recipe itself is not paused - there is no `auto` channel on a group to pause")
ok("grafana" not in newly, "a `notify` member is not paused: it was never automatic")

print()
print("── write_all: the groups go beside the plans, in one run ────────")
shutil.rmtree(cfg.groups)
got = plans.write_all(cfg, catalog, A)
ok("just up-web" in got and os.path.isfile(os.path.join(cfg.groups, "up-web.json")),
   "one discovery run writes the component plans AND the group plans")
doc = groups.read_group(cfg, "up-web")
ok(doc["ok"] is True and doc["plan"]["group"] == "up-web", "and the file is the plan, readable by its group id")

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("group units: all passed")
