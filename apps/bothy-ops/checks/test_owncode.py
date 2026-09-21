#!/usr/bin/env python3
"""Bothy updating itself (build step 6), as units: the plan and every refusal.

Run: python3 checks/test_owncode.py

No docker and no network: a throwaway git repository (a bare "origin" with
annotated release tags, and a clone on main), docker inspect replaced by a table,
and CI's verdict replaced by a function. What it pins down:

  PLAN      HEAD -> the NEWEST release tag on origin/main; level, confirm, the
            release-notes URL, the changed apps; an id that is stable for the
            same facts and moves when a container does
  REFUSALS  running from the checkout it would move; a dirty tree (modified AND
            untracked); not on main; detached; diverged; no newer tag; a tag not
            on origin/main; HEAD already past the tag; a mislabelled tag; CI not
            green (failed, still running, none); the auth boundary in the diff; a
            justfile that predates the updater; a container not running, or not
            running HEAD; a release rolled back before; a --target that is not it
  ESCALATE  compose, edge and other stacks' files make it type-the-name, listed
  UPDATER   a release that changes the updater says so; install/stage/current
  SERVE     bothy-ops copies the own block through its allow-list, and drops junk
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

import updater  # noqa: E402,F401
from updater import hostio, install, owncode, plans, spool  # noqa: E402
from updater.config import Config  # noqa: E402

import updates  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


TMP = tempfile.mkdtemp(prefix="bothy-owncode-unit-")
ORIGIN = os.path.join(TMP, "origin.git")
REPO = os.path.join(TMP, "repo")
DEV = os.path.join(TMP, "dev")
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false",
       "-c", "tag.gpgsign=false"]


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

[components.bothy]
title = "Bothy (web, files, ops)"
class = "own-code"
source = "github"
repo = "example/bothy"
pins = ["VERSION"]
apply = "just up-apps"
dependants = ["bothy-web", "bothy-files", "bothy-ops"]
changelog = "https://example.invalid/releases/tag/v{version}"
channel = "notify"
one_way = false
verify = ["it answers"]
"""


def write(rel: str, text: str, root: str = DEV) -> None:
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as fh:
        fh.write(text)


def release(version: str, files: dict[str, str], msg: str = "a release") -> str:
    """Commit on dev's main with VERSION bumped, tag v<version>, push both. Returns the sha."""
    write("VERSION", version + "\n")
    for k, v in files.items():
        write(k, v)
    git("add", "-A", cwd=DEV)
    git("commit", "-q", "-m", msg, cwd=DEV)
    git("tag", "-a", f"v{version}", "-m", f"Bothy v{version}", cwd=DEV)
    git("push", "-q", "origin", "main", f"v{version}", cwd=DEV)
    return git("rev-parse", "HEAD", cwd=DEV)


subprocess.run(["git", "init", "-q", "--bare", "-b", "main", ORIGIN], check=True)
subprocess.run(["git", "clone", "-q", ORIGIN, DEV], check=True, capture_output=True)
git("checkout", "-q", "-b", "main", cwd=DEV)
V1 = release("2026.1.0", {
    "justfile": "up-apps *services:\n    echo BOTHY_UP_NO_BUILD\n",
    "apps/bothy-ops/updates.toml": CATALOG,
    "apps/bothy-web/web/app.txt": "one\n",
    "apps/bothy-ops/updater/__init__.py": "# v1\n",
    "apps/bothy/compose.socket-proxy.yml": "services: {}\n",
    "monitoring/compose.yml": "services: {}\n",
}, "v1")
subprocess.run(["git", "clone", "-q", ORIGIN, REPO], check=True, capture_output=True)
V2 = release("2026.1.1", {"apps/bothy-web/web/app.txt": "two\n", "docs/notes.md": "x\n"}, "v2: web")

STATE = os.path.join(TMP, "state")
LIB = os.path.join(TMP, "lib")
VERDICT = {"green": True, "via": "a test", "runs": 7, "detail": "all 7 check runs passed"}
cfg = Config(repo=REPO, catalog=os.path.join(REPO, "apps/bothy-ops/updates.toml"), state=STATE,
             backups=os.path.join(TMP, "backups"), textfile=None, lib=LIB,
             own_checks=lambda slug, sha: dict(VERDICT))
os.makedirs(cfg.spool, mode=0o700)
AVAIL = {"version": 1, "generatedAt": "2026-09-19T10:00:00Z", "components": {}}

# docker inspect, replaced by a table: container -> (imageId, revision label)
RUNNING: dict[str, tuple[str, str]] = {}


def run_head() -> None:
    head = git("rev-parse", "HEAD")
    for i, c in enumerate(("bothy-files", "bothy-ops", "bothy-web")):
        RUNNING[c] = (f"sha256:{str(i + 1) * 64}", head)


def fake_container(name):
    if name not in RUNNING:
        return None
    iid, _ = RUNNING[name]
    return {"name": name, "image": f"{name}:x", "imageId": iid, "state": "running", "health": "healthy", "labels": {}}


def fake_image(ref):
    for iid, rev in RUNNING.values():
        if ref == iid:
            return {"id": iid, "repoDigests": [], "size": 1000, "labels": {owncode.REVISION: rev}}
    return None


hostio.container = fake_container
hostio.image = fake_image
run_head()
catalog = updates.load(cfg.catalog)


def P(**kw):
    return plans.plan("bothy", cfg=kw.pop("cfg", cfg), catalog=catalog, available=AVAIL, **kw)


def refused(fn, needle: str, label: str) -> None:
    try:
        fn()
    except plans.PlanRefused as e:
        ok(needle.lower() in str(e).lower(), f"{label}  ({str(e)[:150]})")
        return
    ok(False, f"{label}  (a plan was MADE)")


print("── PLAN: HEAD -> the newest green release tag ─────────────────────")
p = P()
ok(p["from"]["sha"] == V1 and p["to"]["sha"] == V2 and p["to"]["tag"] == "v2026.1.1",
   "from HEAD (v2026.1.0) to the tag v2026.1.1")
ok(p["from"]["version"] == "2026.1.0" and p["to"]["version"] == "2026.1.1" and p["level"] == "patch",
   "versions from VERSION and the tag; a patch")
ok(p["confirm"] == "click", "a release that touches only Bothy's apps (and docs) is one click")
ok(p["changelog"] == "https://example.invalid/releases/tag/v2026.1.1" and p["own"]["releaseUrl"] == p["changelog"],
   "the release notes are the tag's GitHub release")
ok(p["own"]["apps"] == ["bothy-web"] and p["own"]["commits"] == 1 and "changed" in (p["own"]["diffstat"] or ""),
   f"the changed apps and the diffstat: {p['own']['apps']} / {p['own']['diffstat']}")
ok(p["own"]["updater"] is False and p["own"]["elsewhere"] == [] and p["own"]["edge"] == [],
   "nothing else changes, and the updater does not")
ok(p["restarts"] == ["bothy-files", "bothy-ops", "bothy-web"] and p["own"]["order"][-1] == "bothy-web",
   "all three restart, bothy-web last")
ok(p["snapshot"]["kind"] == "git" and p["own"]["ci"]["via"] == "a test", "a git snapshot; CI's verdict names its source")
ok(len(p["id"]) == 24 and P()["id"] == p["id"], "the id is stable for the same facts")
RUNNING["bothy-ops"] = ("sha256:" + "9" * 64, V1)
ok(P()["id"] != p["id"], "…and moves when a running container does")
run_head()
refused(lambda: P(target="v2026.1.9"), "not the newest green release", "a --target that is not the chosen tag")
ok(P(target="v2026.1.1")["id"] == p["id"], "…while the chosen tag as --target is fine")

# spool re-validation knows the class (it would refuse an unknown one)
doc = {"version": 1, "component": "bothy", "ok": True, "plan": p}
req = {"v": 1, "jobId": "a" * 32, "component": "bothy", "planId": p["id"], "confirm": True,
       "requestedBy": "t", "requestedAt": "2026-09-19T10:00:00Z"}
ok(spool.validate_against(req, catalog, doc)["id"] == p["id"], "the spool accepts a request for the own-code plan")

print("── the night job (step 7) never picks Bothy itself ──────────────")
import dataclasses  # noqa: E402
from updater import auto  # noqa: E402
try:
    updates.load_catalog({**updates.tomllib.loads(CATALOG), "components": {"bothy": {
        **updates.tomllib.loads(CATALOG)["components"]["bothy"], "channel": "auto"}}})
    ok(False, "the catalog refuses channel auto on own-code (it was ACCEPTED)")
except updates.CatalogError as e:
    ok("auto" in str(e), f"the catalog refuses channel auto on own-code ({str(e)[:80]})")
forced = dataclasses.replace(catalog, components={"bothy": dataclasses.replace(catalog.components["bothy"],
                                                                               channel="auto")})
ok(auto._auto_components(forced) == [], "…and auto's candidate filter drops own-code even if the catalog let it through")

print("── REFUSALS ──────────────────────────────────────────────────────")
refused(lambda: P(cfg=Config(repo=updater.CODE, state=STATE, lib=LIB)), "install-updater",
        "the updater runs from the checkout it would move")
write("apps/bothy-web/web/app.txt", "edited\n", REPO)
refused(P, "local changes", "a modified file")
git("checkout", "-q", "--", ".")
write("stray.txt", "x\n", REPO)
refused(P, "local changes", "an untracked file (a reset would not remove it, an ff may clash)")
os.unlink(os.path.join(REPO, "stray.txt"))
git("checkout", "-q", "-b", "side")
refused(P, "not main", "a branch other than main")
git("checkout", "-q", "--detach")
refused(P, "detached", "a detached HEAD")
git("checkout", "-q", "main")
git("commit", "-q", "--allow-empty", "-m", "local only")
refused(P, "diverged", "HEAD has a commit origin/main does not")
git("reset", "-q", "--hard", V1)
VERDICT.update(green=False, detail="2 of 7 check runs did not pass: CI / web (failure)")
refused(P, "not verified green", "CI failed on the tag's commit")
VERDICT.update(green=True, detail="all 7 check runs passed")
RUNNING.pop("bothy-web")
refused(P, "not running", "a container is not running")
run_head()
RUNNING["bothy-files"] = (RUNNING["bothy-files"][0], "f" * 40)
refused(P, "not every bothy container runs head", "a container runs another commit's image")
run_head()
os.makedirs(cfg.own_dir, exist_ok=True)
with open(os.path.join(cfg.own_dir, owncode.BLOCKED), "w") as fh:
    json.dump({"sha": V2, "tag": "v2026.1.1", "at": "2026-09-19T10:00:00Z", "why": "verify failed"}, fh)
refused(P, "rolled back", "a release that was rolled back is not offered again")
os.unlink(os.path.join(cfg.own_dir, owncode.BLOCKED))

# HEAD at the newest tag: nothing to deploy.
git("merge", "-q", "--ff-only", V2)
run_head()
refused(P, "nothing to deploy", "the checkout is the newest release")
# HEAD past the newest tag (main moved on, no release yet): still nothing.
write("apps/bothy-web/web/app.txt", "three\n")
git("add", "-A", cwd=DEV)
git("commit", "-q", "-m", "unreleased", cwd=DEV)
git("push", "-q", "origin", "main", cwd=DEV)
git("pull", "-q", "--ff-only")
run_head()
refused(P, "no release tag is newer", "main past the last tag, with no newer release")
# A tag on a side branch, never merged to main.
git("checkout", "-q", "-b", "side", cwd=DEV)
V_SIDE = release("2026.1.2", {"apps/bothy-web/web/app.txt": "side\n"}, "side")
git("checkout", "-q", "main", cwd=DEV)
refused(P, "not on origin/main", "a release tag that is not on origin/main")
git("push", "-q", "origin", "--delete", "v2026.1.2", cwd=DEV)
git("tag", "-d", "v2026.1.2", cwd=DEV)
git("tag", "-d", "v2026.1.2")
# A tag whose commit's VERSION disagrees with its name.
write("VERSION", "2026.1.2\n")
git("add", "-A", cwd=DEV)
git("commit", "-q", "-m", "version bump without a matching tag", cwd=DEV)
git("tag", "-a", "v2026.1.3", "-m", "mislabelled", cwd=DEV)
git("push", "-q", "origin", "main", "v2026.1.3", cwd=DEV)
refused(P, "mislabelled", "a tag whose VERSION says another version")
git("push", "-q", "origin", "--delete", "v2026.1.3", cwd=DEV)
git("tag", "-d", "v2026.1.3", cwd=DEV)
git("tag", "-d", "v2026.1.3")

print("── ESCALATE, REFUSE BY CONTENT, UPDATER ─────────────────────────")
V4 = release("2026.1.4", {"apps/bothy/compose.socket-proxy.yml": "services: {x: {}}\n"}, "boundary")
refused(P, "auth boundary", "a release that changes the socket proxies (up-apps would recreate them)")
release("2026.1.5", {"apps/bothy/compose.socket-proxy.yml": "services: {}\n",
                     "justfile": "up-apps *services:\n    echo old\n"}, "old justfile")
refused(P, "predates", "a target justfile without BOTHY_UP_NO_BUILD")
V6 = release("2026.1.6", {"justfile": "up-apps *services:\n    echo BOTHY_UP_NO_BUILD\n",
                          "apps/bothy-web/compose.yml": "services: {}\n", "edge/dynamic/bothy-api.yml": "http: {}\n",
                          "monitoring/compose.yml": "services: {grafana: {}}\n",
                          "apps/bothy-ops/updater/__init__.py": "# v6\n",
                          "apps/bothy-ops/checks/new_check.py": "\n"}, "a wide release")
p6 = P()
ok(p6["to"]["sha"] == V6 and p6["confirm"] == "type-name", "compose, edge or another stack in the diff: type the name")
ok(p6["own"]["compose"] == ["apps/bothy-web/compose.yml"] and p6["own"]["edge"] == ["edge/dynamic/bothy-api.yml"],
   f"…listed: compose {p6['own']['compose']}, edge {p6['own']['edge']}")
ok("monitoring/compose.yml" in p6["own"]["elsewhere"] and "apps/bothy-ops/checks/new_check.py" not in p6["own"]["elsewhere"]
   , f"…other stacks' files listed, checks are not: {p6['own']['elsewhere']}")
ok(p6["own"]["updater"] is True and p6["own"]["updaterFiles"] == ["apps/bothy-ops/updater"],
   f"the release changes the updater: {p6['own']['updaterFiles']}")
VERDICT.update(green=False, detail="1 of 7 check runs are still running")
refused(P, "still running", "CI still running on the target")
VERDICT.update(green=True, detail="all 7 check runs passed")

print("── classify_paths and judge ─────────────────────────────────────")
c = owncode.classify_paths(["apps/bothy-common/bothy_common/audit.py", "apps/bothy-ops/updates.py",
                            "apps/bothy-ops/discover_updates.py", "k8s/job-templates/x.yaml", "README.md",
                            "apps/bothy-web/checks/a.mjs", "apps/bothy-ops/compose.admin.yml", "auth/compose.yml"])
ok(c["apps"] == ["bothy-files", "bothy-ops"], f"bothy_common and job templates are in the images: {c['apps']}")
ok(set(c["updater"]) == {"apps/bothy-common/bothy_common/audit.py", "apps/bothy-ops/updates.py",
                         "apps/bothy-ops/discover_updates.py"}, "…and bothy_common, updates.py are ALSO the updater's")
ok(c["compose"] == ["apps/bothy-ops/compose.admin.yml"] and c["elsewhere"] == ["auth/compose.yml"],
   "an overlay is Bothy's compose; auth/ is elsewhere")
J = owncode.judge
ok(J({"check_runs": [{"name": "a", "status": "completed", "conclusion": "success"},
                     {"name": "b", "status": "completed", "conclusion": "skipped"}]})["green"], "success + skipped: green")
ok(not J({"check_runs": [{"name": "a", "status": "completed", "conclusion": "success"},
                         {"name": "b", "status": "completed", "conclusion": "failure"}]})["green"], "a failure: red")
ok(not J({"check_runs": [{"name": "a", "status": "in_progress", "conclusion": None}]})["green"], "in progress: not yet")
ok(not J({"check_runs": []})["green"] and not J({})["green"], "no check runs: not green")
ok(not J({"check_runs": [{"name": "a", "status": "completed", "conclusion": "skipped"}]})["green"],
   "all skipped, none succeeded: not green")

print("── INSTALL: current, staged, never switched by an update ─────────")
d = install.install(cfg, V1)
ok(d["current"]["sha"] == V1 and os.path.islink(os.path.join(LIB, "current"))
   and os.path.exists(os.path.join(LIB, V1, "apps/bothy-ops/updater/__init__.py")), "install copies V1 and points current at it")
ok(json.load(open(os.path.join(LIB, V1, "INSTALL.json")))["repo"] == REPO, "INSTALL.json names the checkout to deploy")
ok(install.changed_paths(cfg, V6, V1) == ["apps/bothy-ops/updater"], "V6 differs from the INSTALLED copy in updater/")
ok(install.changed_paths(cfg, V2, V1) == [], "V2 does not")
d = install.stage(cfg, V6, "b" * 32)
ok(d["staged"]["sha"] == V6 and d["current"]["sha"] == V1 and os.path.realpath(os.path.join(LIB, "current")).endswith(V1),
   "stage: the new copy sits beside current; current is untouched")
st = json.load(open(cfg.updater_file))
ok(st["staged"]["sha"] == V6 and st["staged"]["job"] == "b" * 32, "updater.json says a switch is pending")
d = install.install(cfg, V6)
ok(d["current"]["sha"] == V6 and d["staged"] is None and not os.path.islink(os.path.join(LIB, "staged")),
   "install of the staged sha switches, and clears staged")

print("── the timer's program refuses a file that is not an armed rollback ─")
ok(owncode.main_timer(os.path.join(TMP, "x.armed.json")) == 2, "a path outside own/")
os.makedirs(cfg.own_dir, exist_ok=True)
ok(owncode.main_timer(os.path.join(cfg.own_dir, "c" * 32 + ".armed.json")) == 0, "no such armed file: nothing to do")

print("── SERVE: bothy-ops' allow-list for the own block ───────────────")
served = updates._plan(p6)
ok(served is not None and served["own"]["tag"] == "v2026.1.6" and served["own"]["toSha"] == V6
   and served["snapshot"]["kind"] == "git", "the own block and the git snapshot kind survive")
bad = json.loads(json.dumps(p6))
bad["own"].update(tag="v1; rm -rf", apps=["bothy-web", "evil"], releaseUrl="javascript:alert(1)", commits=-3)
sb = updates._plan(bad)["own"]
ok(sb["tag"] is None and sb["apps"] == ["bothy-web"] and sb["releaseUrl"] is None and sb["commits"] is None,
   "…and junk in it is dropped")

shutil.rmtree(TMP, ignore_errors=True)
print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("own-code units: all passed")
