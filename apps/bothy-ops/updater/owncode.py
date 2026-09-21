"""Own code: Bothy updating itself (class own-code, component `bothy`; build step 6).

── what it deploys: a GREEN RELEASE TAG, never main's tip ──────────────────────

Step 4's rule was "deploy only what is reviewed". For a third-party image that
means "what main pins". For our own code it means a release tag:

  * release.yml tags `v$VERSION` only on a commit whose CI run on main concluded
    `success` (it is triggered by workflow_run, so the tag cannot exist first);
  * the plan re-asks GitHub for that commit's check runs and refuses unless every
    one completed and none failed - through `gh` when it is installed and logged
    in, else the public API unauthenticated (the plan says which);
  * the tag must be on origin/main, strictly ahead of HEAD, and carry the VERSION
    its name claims.

origin/main's HEAD was the alternative. It is reviewed too, but at any moment it
may be red, or mid-CI, and it has no version, no release page to link and no
stable name to refuse again after a rollback. A tag is all four. The cost: a
merged fix waits for `VERSION` to be bumped (`just release`'s habit).

── the flow (executor order; every step is a status.json line) ────────────────

  validate   the request, and the plan recomputed here - after a `git fetch`
  preflight  the three containers run HEAD's images and are healthy; a systemd
             user manager exists (the rollback timer needs it); no rollback armed
  build      `bothy-*:<target sha>` from a TEMPORARY worktree of the tag, BEFORE
             the live checkout or any container is touched. A failed build is
             `aborted`: nothing running changed
  snapshot   the previous sha and image ids; the running images are tagged
             `<repo>:<previous sha>` so the rollback can name them
  arm        `systemd-run --user --on-active=…` a rollback unit: it restores the
             previous sha and images unless verify disarms it. Armed BEFORE the
             checkout moves (with the apply budget added), and re-armed for the
             plain 10 minutes once the containers are up - so a dead updater, a
             hung verify or a WSL restart anywhere after this line is covered
  switch     `git merge --ff-only <tag>` on the live checkout
  apply      `just up-apps <svc>` for bothy-files, bothy-ops, then bothy-web LAST,
             each with BOTHY_UP_NO_BUILD=1: the images were built above
  verify     each container runs the image built above, labelled with the target;
             bothy-web's /version.json names the target; bothy-files' and bothy-ops'
             /healthz answer ok (bodies, rule 7); the catch-all serves index.html -
             inside bothy-web and, as a browser gets it, through the edge
  stage      if the release changes the updater itself, its copy is STAGED, never
             switched (updater/install.py)

── the image tagging decision ──────────────────────────────────────────────────

Compose names the images `bothy-web:${BOTHY_IMAGE_TAG:-latest}` and `just up-apps`
sets BOTHY_IMAGE_TAG to HEAD's sha. An env-selected tag rather than `:latest`
plus a sha alias, because the rollback then needs no build and no retagging:
`git reset` to the old sha and `BOTHY_UP_NO_BUILD=1 just up-apps` selects exactly
the old images by name. With `:latest` the rollback would first have to move
`:latest` back - a step that can itself be interrupted, leaving the name that
compose uses pointing at the wrong build. The image's tag now also says which
commit runs, beside its revision label.

── the reset ───────────────────────────────────────────────────────────────────

The rollback runs `git reset --hard <previous sha>`. That is safe ONLY because
pre-flight proved the tree clean (nothing uncommitted, nothing untracked) and
switch was a fast-forward: between those two facts, every file the reset
touches is one the fast-forward wrote. If someone edits the tree inside the
10-minute window anyway (the bothy-files editor), the rollback saves `git diff`
and the status list to own/<job>.dirty.json before it resets.
"""

from __future__ import annotations

import errno
import json
import os
import re
import secrets
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request

import updates

from . import CODE, OPS, canaries, hostio, install, record
from .config import OWN_SERVICES, Config
from .hostio import HostError, git, iso, run, tail
from .plans import PLAN_VERSION, PlanRefused, _home, _material_id, load_available

REVISION = "org.opencontainers.image.revision"
BOUNDARY = ("apps/bothy/compose.socket-proxy.yml",)
_COMPOSE = re.compile(r"apps/bothy(-web|-files|-ops)?/compose[^/]*\.ya?ml")
_INERT_PREFIX = ("docs/", ".github/", "scripts/checks/", "apps/bothy-web/checks/", "apps/bothy-files/checks/",
                 "apps/bothy-ops/checks/", "apps/bothy-common/checks/", ".claude/")
_INERT_FILES = {"VERSION", "LICENSE", ".gitignore", ".gitattributes", ".editorconfig"}
_SLUG = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
_SHA = re.compile(r"[0-9a-f]{40}")
_JOB = re.compile(r"[0-9a-f]{32}")
CHECKS_OK = {"success", "neutral", "skipped"}
CHECKS_CACHE = 6 * 3600
BLOCKED = "blocked.json"


class Refuse(Exception):
    """Pre-flight said no."""


class StepError(Exception):
    """A step failed after pre-flight."""


# ══ the plan ══════════════════════════════════════════════════════════════════

def classify_paths(paths: list[str]) -> dict[str, list[str]]:
    """What a release's changed files mean for an own-code update.

      apps       the images that change (informative: all three are recreated
                 anyway, since the revision label moves on every commit)
      boundary   the socket proxies - `just up-apps` would recreate them: REFUSED
      compose    Bothy's own compose files - applied by `just up-apps`
      edge       edge/dynamic/ - Traefik's file provider reloads them the moment
                 the checkout moves
      elsewhere  another stack's files: in the checkout after this, NOT applied
                 (their rows in Settings > Updates, or their recipe, do that)
      updater    the updater's own files: staged, not switched
    """
    out: dict[str, set | list] = {k: set() for k in ("apps",)}
    lists: dict[str, list[str]] = {k: [] for k in ("boundary", "compose", "edge", "elsewhere", "updater", "inert")}
    up = install.UPDATER_PATHS
    for p in paths:
        apps = _apps_of(p)
        out["apps"] |= apps
        if p in BOUNDARY:
            lists["boundary"].append(p)
        elif _COMPOSE.fullmatch(p):
            lists["compose"].append(p)
        elif p.startswith("edge/dynamic/"):
            lists["edge"].append(p)
        if any(p == u or p.startswith(u + "/") for u in up):
            lists["updater"].append(p)
        if apps or p in BOUNDARY or _COMPOSE.fullmatch(p) or p.startswith("edge/dynamic/") \
                or any(p == u or p.startswith(u + "/") for u in up):
            continue
        if p in _INERT_FILES or p.endswith(".md") or p.startswith(_INERT_PREFIX) \
                or p in ("apps/bothy-ops/inventory.py",):
            lists["inert"].append(p)
            continue
        lists["elsewhere"].append(p)
    return {"apps": sorted(out["apps"]), **lists}


def _apps_of(p: str) -> set[str]:
    apps: set[str] = set()
    if p.startswith("apps/bothy-common/bothy_common/"):
        apps |= {"bothy-files", "bothy-ops"}
    if p.startswith("k8s/job-templates/"):
        apps.add("bothy-ops")
    for svc in OWN_SERVICES:
        pre = f"apps/{svc}/"
        if not p.startswith(pre):
            continue
        rest = p[len(pre):]
        if rest.startswith(("checks/", "audit/", "data/", "secrets/")) or rest.endswith(".md") \
                or re.fullmatch(r"compose[^/]*\.ya?ml", rest):
            continue
        if svc == "bothy-ops" and (rest.startswith("updater/") or rest in ("discover_updates.py", "inventory.py")):
            continue
        apps.add(svc)
    return apps


def fetch(cfg: Config) -> None:
    rc, out = git(cfg.repo, "fetch", "--quiet", "--tags", "origin", timeout=90)
    if rc != 0:
        raise PlanRefused(f"git fetch failed ({tail(out, 160)}) - the updater will not choose a release it cannot see")


def gate(cfg: Config) -> str:
    """HEAD's sha, if the checkout may be moved at all. The refusals, in words."""
    rc, branch = git(cfg.repo, "symbolic-ref", "--quiet", "--short", "HEAD")
    if rc != 0 or branch != "main":
        raise PlanRefused(f"the checkout is on {branch or 'a detached HEAD'}, not main - Bothy updates itself only "
                          "along main")
    rc, head = git(cfg.repo, "rev-parse", "HEAD")
    if rc != 0 or not _SHA.fullmatch(head):
        raise PlanRefused("git rev-parse HEAD failed")
    rc, dirty = git(cfg.repo, "status", "--porcelain")
    if rc != 0 or dirty:
        first = ", ".join(ln.split(None, 1)[-1] for ln in dirty.splitlines()[:3]) if rc == 0 else "git status failed"
        raise PlanRefused(f"the checkout has local changes ({first}) - an update moves it and its rollback resets it, "
                          "so it must be clean. Commit them to a branch, or `git stash`, and look again")
    rc, _ = git(cfg.repo, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main")
    if rc != 0:
        raise PlanRefused("there is no origin/main to compare the checkout with")
    rc, _ = git(cfg.repo, "merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main")
    if rc != 0:
        raise PlanRefused("the checkout has diverged from origin/main (commits that are not on it) - the updater "
                          "only fast-forwards")
    return head


def _version_at(cfg: Config, rev: str) -> str | None:
    rc, v = git(cfg.repo, "show", f"{rev}:VERSION")
    return v.strip() if rc == 0 else None


def choose_target(cfg: Config, head: str, from_v: updates.Version) -> tuple[str, str, updates.Version]:
    """(tag, sha, version) of the newest release tag newer than HEAD's VERSION."""
    rc, out = git(cfg.repo, "tag", "--list", "v*")
    if rc != 0:
        raise PlanRefused("git tag failed")
    newer = []
    for t in out.split():
        v = updates.parse_version(t)
        if v and len(v.parts) == 3 and v.shape == from_v.shape and updates.classify(from_v, v):
            newer.append((v.parts, t, v))
    if not newer:
        raise PlanRefused(f"nothing to deploy: no release tag is newer than v{from_v.text}")
    _, tag, v = max(newer)
    rc, sha = git(cfg.repo, "rev-parse", "--verify", "--quiet", f"refs/tags/{tag}^{{commit}}")
    if rc != 0 or not _SHA.fullmatch(sha):
        raise PlanRefused(f"{tag} does not name a commit")
    rc, _ = git(cfg.repo, "merge-base", "--is-ancestor", sha, "refs/remotes/origin/main")
    if rc != 0:
        raise PlanRefused(f"{tag} ({sha[:12]}) is not on origin/main - only a release cut from main is deployed")
    if sha == head:
        raise PlanRefused(f"nothing to deploy: the checkout is {tag}")
    rc, _ = git(cfg.repo, "merge-base", "--is-ancestor", head, sha)
    if rc != 0:
        raise PlanRefused(f"nothing to deploy: the checkout ({head[:12]}) is already past {tag} or beside it - "
                          "the updater only moves forward to a newer release")
    tv = _version_at(cfg, sha)
    if tv != v.text:
        raise PlanRefused(f"{tag} points at a commit whose VERSION says {tv!r} - a mislabelled tag is not deployed")
    return tag, sha, v


# ── CI's verdict on the target commit ────────────────────────────────────────

def judge(doc: object) -> dict:
    runs = doc.get("check_runs") if isinstance(doc, dict) else None
    if not isinstance(runs, list) or not runs:
        return {"green": False, "runs": 0, "detail": "no check runs are recorded for it"}
    pending = [r.get("name") for r in runs if isinstance(r, dict) and r.get("status") != "completed"]
    bad = [f"{r.get('name')} ({r.get('conclusion')})" for r in runs
           if isinstance(r, dict) and r.get("status") == "completed" and r.get("conclusion") not in CHECKS_OK]
    good = sum(1 for r in runs if isinstance(r, dict) and r.get("conclusion") == "success")
    if bad:
        return {"green": False, "runs": len(runs), "detail": f"{len(bad)} of {len(runs)} check runs did not pass: "
                                                             + ", ".join(str(b) for b in bad[:3])}
    if pending:
        return {"green": False, "runs": len(runs), "detail": f"{len(pending)} of {len(runs)} check runs are still "
                                                             "running"}
    if not good:
        return {"green": False, "runs": len(runs), "detail": "no check run succeeded"}
    return {"green": True, "runs": len(runs), "detail": f"all {len(runs)} check runs passed"}


def ci_verdict(cfg: Config, slug: str, sha: str) -> dict:
    """{green, via, runs, detail} for `sha` on GitHub. A green answer is cached 6 h."""
    if callable(cfg.own_checks):
        return cfg.own_checks(slug, sha)
    cache = os.path.join(cfg.own_dir, f"checks-{sha}.json")
    try:
        c = hostio.read_json(cache, 64 * 1024)
        if isinstance(c, dict) and c.get("green") is True and time.time() - float(c.get("at", 0)) < CHECKS_CACHE:
            return c
    except (OSError, ValueError, HostError, TypeError):
        pass
    path = f"repos/{slug}/commits/{sha}/check-runs?per_page=100"
    doc, via, why = None, None, ""
    gh = hostio.which("gh")
    if gh:
        rc, out, err = run([gh, "api", "-H", "Accept: application/vnd.github+json", path], timeout=30)
        if rc == 0:
            try:
                doc, via = json.loads(out), "gh (authenticated)"
            except ValueError:
                why = "gh answered something that is not JSON"
        else:
            why = f"gh: {tail(err, 120)}"
    if doc is None:
        req = urllib.request.Request(f"{cfg.github_api}/{path}", headers={
            "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "bothy-updater/1 (+https://github.com/YehudaBriskman/Bothy)"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                doc, via = json.loads(r.read(4 * 1024 * 1024)), "the GitHub API, unauthenticated"
        except (urllib.error.URLError, OSError, ValueError) as e:
            return {"green": False, "via": "the GitHub API, unauthenticated", "runs": 0,
                    "detail": f"GitHub could not be asked ({(why + '; ') if why else ''}{str(e)[:120]})"}
    v = {**judge(doc), "via": via, "at": time.time()}
    if v["green"]:
        try:
            hostio.ensure_dir(cfg.own_dir, 0o700)
            hostio.write_json(cache, v)
        except OSError:
            pass
    return v


# ── what runs now ────────────────────────────────────────────────────────────

def running(cfg: Config) -> dict[str, dict]:
    """service -> {container, imageId, revision, health, state}."""
    out = {}
    for svc in OWN_SERVICES:
        name = cfg.own_containers[svc]
        c = hostio.container(name)
        if not c or c.get("state") != "running":
            raise PlanRefused(f"{name} is not running - `just up-apps` first; the updater replaces a running Bothy")
        img = hostio.image(c["imageId"]) or {}
        out[svc] = {"container": name, "imageId": c["imageId"], "health": c.get("health"),
                    "revision": (img.get("labels") or {}).get(REVISION)}
    return out


def blocked(cfg: Config) -> dict | None:
    try:
        b = hostio.read_json(os.path.join(cfg.own_dir, BLOCKED), 16 * 1024)
    except (OSError, ValueError, HostError):
        return None
    return b if isinstance(b, dict) and _SHA.fullmatch(str(b.get("sha"))) else None


def plan(comp: updates.Component, cfg: Config, catalog: updates.Catalog, available: dict | None,
         target: str | None = None) -> dict:
    """The plan for Bothy itself: HEAD -> the newest green release tag."""
    if os.path.realpath(CODE) == cfg.repo:
        raise PlanRefused("the updater is running from the checkout it would move - run `just install-updater` "
                          "first (it runs from ~/.local/lib/bothy-updater/current and never replaces itself)")
    slug = comp.repo or ""
    if not _SLUG.fullmatch(slug):
        raise PlanRefused(f"updates.toml gives no GitHub repository for {comp.id}")
    available = available if available is not None else load_available(cfg)
    if cfg.own_fetch:
        fetch(cfg)
    head = gate(cfg)
    fv = _version_at(cfg, "HEAD")
    from_v = updates.parse_version(f"v{fv}") if fv else None
    if not from_v or len(from_v.parts) != 3:
        raise PlanRefused(f"VERSION at HEAD reads {fv!r}, not a release version")
    tag, sha, to_v = choose_target(cfg, head, from_v)
    if target is not None and target not in (tag, to_v.text, sha):
        raise PlanRefused(f"{target} is not the newest green release ({tag}) - the updater deploys only that")
    b = blocked(cfg)
    if b and b["sha"] == sha:
        raise PlanRefused(f"{tag} was rolled back at {b.get('at')} ({str(b.get('why'))[:160]}) and is not offered "
                          f"again - fix the cause in a newer release, or delete "
                          f"{_home(os.path.join(cfg.own_dir, BLOCKED))} to try it once more")
    for rev, who in ((head, "HEAD"), (sha, tag)):
        rc, jf = git(cfg.repo, "show", f"{rev}:justfile")
        if rc != 0 or "BOTHY_UP_NO_BUILD" not in jf:
            raise PlanRefused(f"{who}'s justfile predates the own-code updater (no BOTHY_UP_NO_BUILD in up-apps) - "
                              "move the checkout past step 6 once by hand: `git pull --ff-only && just up-apps`")
    rc, names = git(cfg.repo, "diff", "--name-only", f"{head}..{sha}")
    if rc != 0:
        raise PlanRefused("git diff failed")
    paths = [p for p in names.splitlines() if p]
    cls = classify_paths(paths)
    if cls["boundary"]:
        raise PlanRefused(f"{tag} changes the auth boundary ({', '.join(cls['boundary'])}), which `just up-apps` "
                          "would recreate with Bothy - a boundary update is manual: `git pull --ff-only`, "
                          "`just up-apps`, then `just ops-check`")
    ci = ci_verdict(cfg, slug, sha)
    if not ci.get("green"):
        raise PlanRefused(f"{tag} ({sha[:12]}) is not verified green on GitHub: {ci.get('detail')} "
                          f"(asked via {ci.get('via') or 'nothing'})")
    run_ = running(cfg)
    stale = [f"{v['container']} ({str(v['revision'] or 'no label')[:12]})" for v in run_.values()
             if v["revision"] != head]
    if stale:
        raise PlanRefused(f"not every Bothy container runs HEAD {head[:12]}: {', '.join(stale)} - run `just up-apps` "
                          "so the box runs its checkout, then look again")
    upd = install.changed_paths(cfg, sha, head)
    level = updates.classify(from_v, to_v) or "patch"
    rc, commits = git(cfg.repo, "rev-list", "--count", f"{head}..{sha}")
    rc2, stat = git(cfg.repo, "diff", "--shortstat", f"{head}..{sha}")
    web = cfg.own_containers["bothy-web"]
    material = {
        "v": PLAN_VERSION, "component": comp.id, "class": comp.cls, "container": web,
        "from": {"image": f"bothy@{head[:12]}", "sha": head,
                 "imageIds": {s: run_[s]["imageId"] for s in OWN_SERVICES}},
        "to": {"image": f"bothy@{sha[:12]}", "sha": sha, "tag": tag},
        "pin": {"file": "VERSION", "service": None, "line": 1, "text": fv, "commit": head},
        "recipe": comp.apply, "changed": sorted(paths), "updater": upd,
    }
    escalate = sorted(set(cls["compose"]) | set(cls["edge"]) | set(cls["elsewhere"]))
    restarts = [cfg.own_containers[s] for s in OWN_SERVICES]
    after_m = max(1, cfg.own_rollback_after // 60)
    return {
        **material,
        "id": _material_id(material),
        "title": comp.title,
        "createdAt": iso(),
        "discoveredAt": (available or {}).get("generatedAt"),
        "level": level,
        # A calendar-versioned release goes "major" every January; that is a
        # type-the-name confirmation here, not a refusal. So is anything the
        # update applies or leaves pending beyond Bothy's own images.
        "confirm": "type-name" if (level == "major" or escalate) else "click",
        "from": {**material["from"], "tag": f"v{from_v.text}", "version": from_v.text, "digest": None,
                 "container": web},
        "to": {**material["to"], "version": to_v.text, "digest": None},
        "changelog": updates.changelog_url(comp.changelog, to_v.text),
        "oneWay": False, "oneWayWhy": None,
        "restarts": restarts,
        "downtime": ("~10-40 s per container, one at a time: bothy-files, then bothy-ops, then bothy-web. "
                     "The file editor, then container actions and Settings, then the page itself are away "
                     "while each is recreated; this page reconnects on its own"),
        "signedOut": "nobody - sessions live in oauth2-proxy, which is not touched",
        "snapshot": {"kind": "git", "what": (f"the current commit ({head[:12]}) and the three running images, "
                                             f"kept as <image>:{head[:12]}… - the rollback runs them again "
                                             "without a build"),
                     "dir": _home(os.path.join(cfg.snapshots, f"<time>-{comp.id}")) + "/", "estimateBytes": None},
        "preflight": [
            "the plan is still current: recomputed after a `git fetch`, it has this id",
            "the checkout is on main, clean (nothing modified or untracked) and not ahead of origin/main",
            f"{tag} is on origin/main, strictly ahead of HEAD, its VERSION says {to_v.text}, and every check run "
            f"on its commit passed (asked via {ci.get('via')})",
            f"{', '.join(restarts)} run HEAD's images and are healthy",
            "a systemd user manager is running (the rollback timer lives there), and no earlier rollback is armed",
            "no other update is running (one global lock)",
        ],
        "verify": [
            f"each container runs the image built from {sha[:12]}, and its revision label says so",
            f"bothy-web's /version.json names {sha[:12]}",
            "bothy-files' and bothy-ops' /healthz answer `\"ok\": true`",
            "the catch-all serves index.html for an unrouted path - in bothy-web, and through the edge",
        ],
        "rollback": (f"A rollback unit is armed before the checkout moves and fires {after_m} min after the "
                     "containers are up unless verify passes; a failed verify fires it at once. It runs "
                     f"`git reset --hard {head[:12]}` (safe: pre-flight proved the tree clean and the move is a "
                     "fast-forward) and `just up-apps` on the previous images, without a build. The release is then "
                     "not offered again."),
        "own": {
            "fromSha": head, "toSha": sha, "tag": tag, "releaseUrl": updates.changelog_url(comp.changelog, to_v.text),
            "commits": int(commits) if rc == 0 and commits.isdigit() else None,
            "diffstat": stat.strip() if rc2 == 0 else None,
            "apps": cls["apps"], "compose": cls["compose"][:20], "edge": cls["edge"][:20],
            "elsewhere": cls["elsewhere"][:20], "elsewhereCount": len(cls["elsewhere"]),
            "updater": bool(upd), "updaterFiles": upd[:20],
            "ci": {"via": ci.get("via"), "detail": ci.get("detail"), "runs": ci.get("runs")},
            "rollbackAfter": cfg.own_rollback_after, "order": list(OWN_SERVICES),
        },
    }


# ══ the executor ══════════════════════════════════════════════════════════════

def user_env() -> dict:
    """The environment `systemctl --user` needs, from a system service too."""
    env = dict(os.environ)
    rt = env.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    env["XDG_RUNTIME_DIR"] = rt
    env.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path={rt}/bus")
    return env


def _just(cfg: Config, repo: str, args: list[str], env_extra: dict, timeout: int) -> None:
    just = hostio.which("just")
    if not just:
        raise StepError("`just` is not on PATH")
    env = dict(os.environ)
    env.update(env_extra)
    rc, out, err = run([just, "--justfile", os.path.join(repo, "justfile"), "--working-directory", repo, *args],
                       timeout=timeout, cwd=repo, env=env)
    if rc != 0:
        raise StepError(f"`just {' '.join(args)}` exited {rc}: {tail(err or out, 300)}")


def _armed_paths(cfg: Config, job: str) -> dict[str, str]:
    base = os.path.join(cfg.own_dir, job)
    return {k: f"{base}.{k}.json" for k in ("armed", "firing", "disarmed", "result")}


def _tree_git(repo: str, *args: str, timeout: float = 60) -> tuple[int, str]:
    """A git command that WRITES the working tree, under umask 022.

    bothy-updater.service runs with UMask=0077 so its own records are private.
    git creates files with 0666 & ~umask, so a fast-forward under 077 would leave
    every new or changed file in the checkout at 600 - and the containers that
    bind-mount config from it (Grafana as uid 472, node-exporter as nobody) could
    no longer read it. The checkout is not the updater's private state."""
    old = os.umask(0o022)
    try:
        return git(repo, *args, timeout=timeout)
    finally:
        os.umask(old)


def _claim(src: str, dst: str) -> bool:
    """Exactly one of the executor and the timer gets the armed file."""
    try:
        os.rename(src, dst)
        return True
    except OSError as e:
        if e.errno == errno.ENOENT:
            return False
        raise


def _stop_units(units: list[str]) -> None:
    for u in units:
        run(["systemctl", "--user", "stop", f"{u}.timer"], timeout=20, env=user_env())
        run(["systemctl", "--user", "reset-failed", f"{u}.timer", f"{u}.service"], timeout=20, env=user_env())


class OwnExecution:
    def __init__(self, cfg: Config, rec: record.Recorder, comp: updates.Component, plan_: dict) -> None:
        self.cfg = cfg
        self.rec = rec
        self.comp = comp
        self.plan = plan_
        self.job = rec.job["id"]
        self.head = plan_["from"]["sha"]
        self.target = plan_["to"]["sha"]
        self.tag = plan_["to"]["tag"]
        self.built: dict[str, str] = {}
        self.units: list[str] = []
        self.paths = _armed_paths(cfg, self.job)
        self.staged: str | None = None

    def step(self, name: str, fn):
        self.rec.step(name, "running")
        try:
            out = fn()
        except (Refuse, StepError) as e:
            self.rec.step(name, "failed", str(e))
            raise
        except Exception as e:  # noqa: BLE001 - a bug must still end in a record and a rollback
            self.rec.step(name, "failed", f"{type(e).__name__}: {e}")
            raise StepError(f"{name}: {type(e).__name__}: {e}") from None
        self.rec.step(name, "ok", out if isinstance(out, str) else None)
        return out

    def go(self) -> str:
        try:
            self.step("preflight", self.preflight)
        except Refuse as e:
            return self.rec.finish("refused", str(e))["state"]
        try:
            self.step("build", self.build)
            self.step("snapshot", self.snapshot)
            self.step("arm", lambda: self.arm(self.cfg.own_rollback_after + 3 * self.cfg.own_apply_timeout))
        except StepError as e:
            self._disarm()
            return self.rec.finish("aborted", f"{e} - nothing running was changed")["state"]
        try:
            self.step("switch", self.switch)
            self.step("apply", self.apply)
            self.step("verify", self.verify)
        except StepError as e:
            return self.rollback_now(e)
        if not self._disarm():
            # The timer got there first (a verify slower than the timer): it owns the rollback.
            return self._after_timer(StepError("verify outlived the rollback timer"))
        self.stage()
        self._prune()
        note = (f"Bothy runs {self.tag} ({self.target[:12]}); the checkout fast-forwarded from {self.head[:12]}. "
                f"The previous images are kept as <image>:{self.head[:12]}….")
        if self.staged:
            note += (f" The release changes the updater: its copy is STAGED ({self.staged[:12]}), not running - run "
                     "`just install-updater` on the host to switch to it.")
        return self.rec.finish("succeeded", note=note)["state"]

    # ── pre-flight ──
    def preflight(self) -> str:
        notes = []
        for svc in OWN_SERVICES:
            name = self.cfg.own_containers[svc]
            c = hostio.container(name)
            if not c or c.get("state") != "running":
                raise Refuse(f"{name} is not running")
            if c["imageId"] != self.plan["from"]["imageIds"][svc]:
                raise Refuse(f"{name} changed since the plan was made")
            if c.get("health") not in (None, "healthy"):
                raise Refuse(f"{name} is {c.get('health')} - fix it before updating Bothy")
            notes.append(f"{name} {c.get('health') or 'running'}")
        rc, _, err = run(["systemctl", "--user", "show-environment"], timeout=15, env=user_env())
        if rc != 0:
            raise Refuse("no systemd user manager answers (`systemctl --user`), and the rollback timer lives there - "
                         f"`loginctl enable-linger {os.environ.get('USER') or '$USER'}` ({tail(err, 120)})")
        if os.path.isdir(self.cfg.own_dir):
            for n in os.listdir(self.cfg.own_dir):
                if n.endswith((".armed.json", ".firing.json")):
                    raise Refuse(f"a rollback is still armed or running ({n[:12]}…) - let it finish, then ask again")
        if not hostio.which("just"):
            raise Refuse("`just` is not on PATH")
        free = hostio.free_bytes(hostio.docker_root())
        need = max(self.cfg.min_free_bytes, 2 << 30)
        if free is not None and free < need:
            raise Refuse(f"{free >> 20} MiB free for Docker; building Bothy needs {need >> 20} MiB")
        return "; ".join(notes) + "; systemd user manager up"

    # ── build: before anything that runs is touched ──
    def build(self) -> str:
        wt = tempfile.mkdtemp(prefix="bothy-own-build-")
        os.rmdir(wt)
        rc, out = git(self.cfg.repo, "worktree", "add", "--detach", "--quiet", wt, self.target, timeout=120)
        if rc != 0:
            raise StepError(f"git worktree add failed: {tail(out, 200)}")
        try:
            env = hostio.dotenv(self.cfg.repo)
            env.update(BOTHY_IMAGE_TAG=self.target, BOTHY_REVISION=self.target, BUILDX_NO_DEFAULT_ATTESTATIONS="1")
            rc, o, e = run(["docker", "compose", "-f", os.path.join(wt, self.cfg.own_compose), "build",
                            *OWN_SERVICES], env=env, cwd=wt, timeout=self.cfg.own_build_timeout)
            if rc != 0:
                raise StepError(f"the build of {self.tag} failed: {tail(e or o, 300)}")
        finally:
            git(self.cfg.repo, "worktree", "remove", "--force", wt, timeout=60)
            shutil.rmtree(wt, ignore_errors=True)
            git(self.cfg.repo, "worktree", "prune", timeout=30)
        for svc in OWN_SERVICES:
            ref = f"{self.cfg.own_images[svc]}:{self.target}"
            img = hostio.image(ref)
            if not img:
                raise StepError(f"{ref} is not in the local store after the build")
            if (img.get("labels") or {}).get(REVISION) != self.target:
                raise StepError(f"{ref} carries revision {(img.get('labels') or {}).get(REVISION)!r}, not the target")
            self.built[svc] = img["id"]
        self.rec.set(built={s: i for s, i in self.built.items()})
        return f"built {', '.join(f'{self.cfg.own_images[s]}:{self.target[:12]}' for s in OWN_SERVICES)} from a " \
               "temporary worktree of " + self.tag

    # ── snapshot: the previous sha and images, by name ──
    def snapshot(self) -> str:
        hostio.ensure_dir(self.cfg.snapshots, 0o700)
        d = os.path.join(self.cfg.snapshots, f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{self.comp.id}")
        os.mkdir(d, 0o700)
        self.rec.set(snapshot=d)
        prev = {}
        for svc in OWN_SERVICES:
            iid = self.plan["from"]["imageIds"][svc]
            ref = f"{self.cfg.own_images[svc]}:{self.head}"
            have = hostio.image(ref)
            if not have or have["id"] != iid:
                rc, _, err = run(["docker", "tag", iid, ref], timeout=30)
                if rc != 0:
                    raise StepError(f"docker tag {iid[:19]} {ref} failed: {tail(err, 200)}")
            prev[svc] = {"imageId": iid, "ref": ref, "container": self.cfg.own_containers[svc]}
        hostio.write_json(os.path.join(d, "previous.json"), {"sha": self.head, "images": prev, "job": self.job})
        hostio.write_json(os.path.join(d, "plan.json"), self.plan)
        rx = re.compile(rf"\d{{8}}T\d{{6}}Z-{re.escape(self.comp.id)}")
        mine = sorted(n for n in os.listdir(self.cfg.snapshots) if rx.fullmatch(n))
        for n in mine[:-self.cfg.keep_snapshots]:
            shutil.rmtree(os.path.join(self.cfg.snapshots, n), ignore_errors=True)
        return f"{d}: previous sha {self.head[:12]}, images tagged :{self.head[:12]}…"

    # ── arm: the rollback unit ──
    def _spec(self) -> dict:
        c = self.cfg
        return {"v": 1, "job": self.job, "component": self.comp.id, "repo": c.repo, "prev": self.head,
                "target": self.target, "tag": self.tag,
                "prevImages": {s: self.plan["from"]["imageIds"][s] for s in OWN_SERVICES},
                "cfg": {"repo": c.repo, "catalog": c.catalog, "state": c.state, "backups": c.backups,
                        "textfile": c.textfile, "lib": c.lib, "own_containers": c.own_containers,
                        "own_images": c.own_images, "own_apply_timeout": c.own_apply_timeout,
                        "verify_timeout": c.verify_timeout},
                "armedAt": iso()}

    def arm(self, delay: int) -> str:
        hostio.ensure_dir(self.cfg.own_dir, 0o700)
        if not os.path.exists(self.paths["armed"]):
            hostio.write_json(self.paths["armed"], self._spec())
        unit = f"bothy-own-rollback-{self.job[:12]}-{len(self.units) + 1}"
        keep = ("PATH", "HOME", "USER", "LANG", "BK_HELPER_IMAGE")
        argv = ["systemd-run", "--user", "--quiet", f"--unit={unit}", "--collect",
                "--description=Bothy own-code rollback (fires unless verify disarms it)",
                f"--on-active={int(delay)}s", "--timer-property=AccuracySec=1s",
                f"--property=WorkingDirectory={OPS}",
                *(f"--setenv={k}={os.environ[k]}" for k in keep if os.environ.get(k)),
                "--", sys.executable, "-m", "updater", "own-rollback", self.paths["armed"]]
        rc, out, err = run(argv, timeout=30, env=user_env())
        if rc != 0:
            raise StepError(f"systemd-run could not arm the rollback: {tail(err or out, 200)}")
        old, self.units = list(self.units), [*self.units, unit]
        _stop_units(old)
        when = time.strftime("%H:%M:%S", time.localtime(time.time() + delay))
        return f"{unit}.timer fires at {when} ({delay} s) unless verify disarms it"

    def _disarm(self) -> bool:
        """True if this process took the armed file back (so no rollback will run)."""
        took = os.path.exists(self.paths["armed"]) and _claim(self.paths["armed"], self.paths["disarmed"])
        _stop_units(self.units)
        return took

    # ── switch and apply ──
    def switch(self) -> str:
        rc, out = _tree_git(self.cfg.repo, "merge", "--ff-only", "--quiet", self.target)
        if rc != 0:
            raise StepError(f"git merge --ff-only {self.tag} failed: {tail(out, 200)}")
        rc, now = git(self.cfg.repo, "rev-parse", "HEAD")
        if now != self.target:
            raise StepError(f"after the merge HEAD is {now[:12]}, not {self.target[:12]}")
        return f"main fast-forwarded {self.head[:12]} -> {self.target[:12]} ({self.tag})"

    def apply(self) -> str:
        for svc in OWN_SERVICES:
            _just(self.cfg, self.cfg.repo, ["up-apps", svc],
                  {"BOTHY_UP_NO_BUILD": "1", "BOTHY_IMAGE_TAG": self.target}, self.cfg.own_apply_timeout)
        self.rec.step("arm", "ok", self.arm(self.cfg.own_rollback_after) + " (re-armed once the containers were up)")
        return f"`just up-apps` for {', '.join(OWN_SERVICES)}, in that order, on the images built above"

    # ── verify: images, labels, /version.json, health bodies, the catch-all ──
    def verify(self) -> str:
        if self.cfg.own_force_verify == "fail":
            raise StepError("verify was forced to fail (a test)")
        if self.cfg.own_force_verify == "hang":
            time.sleep(self.cfg.own_rollback_after * 4 + 30)
        deadline = time.monotonic() + self.cfg.verify_timeout
        last = "nothing checked yet"
        while True:
            ok, last = self._check()
            if ok:
                return last
            if time.monotonic() > deadline:
                raise StepError(last)
            time.sleep(2)

    def _check(self) -> tuple[bool, str]:
        cfg = self.cfg
        for svc in OWN_SERVICES:
            name = cfg.own_containers[svc]
            c = hostio.container(name)
            if not c:
                return False, f"{name} is gone"
            if c["imageId"] != self.built[svc]:
                return False, f"{name} runs {str(c['imageId'])[:19]}, not the image built from {self.target[:12]}"
            if c.get("state") != "running" or c.get("health") not in (None, "healthy"):
                return False, f"{name} is {c.get('state')}/{c.get('health')}"
            rev = ((hostio.image(c["imageId"]) or {}).get("labels") or {}).get(REVISION)
            if rev != self.target:
                return False, f"{name}'s image says revision {rev!r}"
        web = canaries.Ctx(cfg, cfg.own_containers["bothy-web"])
        base = f"http://127.0.0.1:{cfg.own_web_port}"
        st, body = canaries.probe(web, f"{base}/version.json")
        try:
            got = json.loads(body).get("revision")
        except (ValueError, AttributeError):
            got = None
        if st != 200 or got != self.target:
            return False, f"/version.json answered {st} {tail(body, 80)!r}, not revision {self.target[:12]}"
        for svc, (url, pat) in cfg.own_health.items():
            st, b = canaries.probe(canaries.Ctx(cfg, cfg.own_containers[svc]), url, pat)
            if st != 200 or not b.startswith("MATCH "):
                return False, f"{svc} {url}: {st} {tail(b, 100)}"
        st0, index = canaries.probe(web, f"{base}/")
        probe_path = f"/-/bothy-update-probe/{secrets.token_hex(4)}"
        st1, spa = canaries.probe(web, base + probe_path)
        if st0 != 200 or st1 != 200 or index != spa or "<script" not in index:
            return False, (f"the catch-all did not serve index.html for {probe_path} (/: {st0}, the probe: {st1}, "
                           f"same bytes: {index == spa})")
        edge = "not checked (no edge configured)"
        if cfg.own_edge_url:
            try:
                with urllib.request.urlopen(cfg.own_edge_url.rstrip("/") + probe_path, timeout=10) as r:
                    eb, est = r.read(2 * 1024 * 1024).decode(errors="replace"), r.status
            except (urllib.error.URLError, OSError) as e:
                return False, f"the edge did not answer {probe_path}: {str(e)[:100]}"
            if est != 200 or eb != index:
                return False, f"through the edge {probe_path} answered {est} with other bytes than bothy-web's index.html"
            edge = "the edge serves the same index.html"
        return True, (f"{', '.join(cfg.own_containers[s] for s in OWN_SERVICES)} run {self.target[:12]} and are "
                      f"healthy; /version.json names it; /healthz ok; catch-all serves index.html; {edge}")

    # ── rollback ──
    def rollback_now(self, cause: Exception) -> str:
        self.rec.step("rollback", "running", f"because {cause}")
        if _claim(self.paths["armed"], self.paths["firing"]):
            _stop_units(self.units)
            ok, detail = do_rollback(self.cfg, read_spec(self.paths["firing"]), self.paths["firing"])
            return self._record_rollback(cause, ok, detail)
        return self._after_timer(cause)

    def _after_timer(self, cause: Exception) -> str:
        """The timer fired first: wait for its result and record it."""
        self.rec.step("rollback", "running", f"because {cause}; the rollback timer fired first - waiting for it")
        res = wait_result(self.paths["result"], self.cfg.own_apply_timeout * 3 + 120)
        ok, detail = (res.get("ok") is True, str(res.get("detail"))) if res else (False, "the timer's rollback "
                                                                                        "gave no result")
        return self._record_rollback(cause, ok, detail)

    def _record_rollback(self, cause: Exception, ok: bool, detail: str) -> str:
        if ok:
            self.rec.step("rollback", "ok", detail)
            return self.rec.finish("rolled_back", str(cause), note=_note(self.cfg, self.head, self.tag))["state"]
        self.rec.step("rollback", "failed", detail)
        return self.rec.finish("failed", f"{cause}; and the rollback did not restore {self.head[:12]}: {detail}",
                               note="A person is needed: `just update-status`, then `git -C <checkout> log -1` and "
                                    "`docker ps` - see docs/guide/upgrading.md")["state"]

    # ── after a success ──
    def stage(self) -> None:
        upd = self.plan.get("updater") or []
        if not upd:
            self.rec.step("stage", "skipped", "the release does not change the updater")
            return
        self.rec.step("stage", "running")
        try:
            doc = install.stage(self.cfg, self.target, self.job)
        except (HostError, OSError) as e:
            self.rec.step("stage", "failed", f"the new updater could not be staged: {e} - `just install-updater` "
                                             "installs it from the checkout")
            return
        cur = (doc.get("current") or {}).get("sha") or "the checkout"
        self.staged = self.target
        self.rec.step("stage", "ok", f"{', '.join(upd[:4])} changed: staged {self.target[:12]} beside current "
                                     f"{cur[:12]} - NOT switched; `just install-updater` switches")

    def _prune(self) -> None:
        """Keep the images of the three newest commits (plus the previous one)."""
        for svc in OWN_SERVICES:
            repo = self.cfg.own_images[svc]
            rc, out, _ = run(["docker", "image", "ls", repo, "--format", "{{.Tag}}"], timeout=30)
            if rc != 0:
                continue
            tags = [t for t in out.split() if _SHA.fullmatch(t)]
            for t in tags[3:]:
                if t not in (self.target, self.head):
                    run(["docker", "image", "rm", f"{repo}:{t}"], timeout=60)


def _note(cfg: Config, head: str, tag: str) -> str:
    return (f"The checkout is back at {head[:12]} and the previous images run again. {tag} is not offered again "
            f"until a newer release, or until {_home(os.path.join(cfg.own_dir, BLOCKED))} is deleted.")


# ══ the rollback: the timer's program, and the executor's on a failed verify ══

def read_spec(path: str) -> dict:
    doc = hostio.read_json(path, 64 * 1024)
    if not isinstance(doc, dict) or doc.get("v") != 1 or not _JOB.fullmatch(str(doc.get("job"))) \
            or not _SHA.fullmatch(str(doc.get("prev"))) or not _SHA.fullmatch(str(doc.get("target"))):
        raise HostError(f"{path} is not an armed rollback")
    return doc


def wait_result(path: str, timeout: float) -> dict | None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            r = hostio.read_json(path, 64 * 1024)
            if isinstance(r, dict):
                return r
        except (OSError, ValueError, HostError):
            pass
        time.sleep(1)
    return None


def do_rollback(cfg: Config, spec: dict, firing: str) -> tuple[bool, str]:
    """Put the previous sha and the previous images back. (ok, detail)."""
    repo, prev, job = spec["repo"], spec["prev"], spec["job"]
    paths = _armed_paths(cfg, job)
    steps = []
    ok, detail = False, ""
    try:
        rc, dirty = git(repo, "status", "--porcelain")
        if rc == 0 and dirty:
            _, diff = git(repo, "diff", "HEAD")
            hostio.write_json(os.path.join(cfg.own_dir, f"{job}.dirty.json"),
                              {"status": dirty.splitlines()[:200], "diff": diff[:512 * 1024]})
            steps.append(f"the tree was edited during the window - saved to own/{job}.dirty.json first")
        rc, branch = git(repo, "symbolic-ref", "--quiet", "--short", "HEAD")
        if rc != 0 or branch != "main":
            raise StepError(f"the checkout is on {branch or 'a detached HEAD'} - not resetting it")
        rc, out = _tree_git(repo, "reset", "--hard", "--quiet", prev)
        if rc != 0:
            raise StepError(f"git reset --hard {prev[:12]} failed: {tail(out, 200)}")
        steps.append(f"checkout reset to {prev[:12]}")
        for svc in OWN_SERVICES:
            iid, ref = spec["prevImages"][svc], f"{cfg.own_images[svc]}:{prev}"
            have = hostio.image(ref)
            if not have or have["id"] != iid:
                rc, _, err = run(["docker", "tag", iid, ref], timeout=30)
                if rc != 0:
                    raise StepError(f"the previous image {iid[:19]} is gone ({tail(err, 120)})")
        for svc in OWN_SERVICES:
            _just(cfg, repo, ["up-apps", svc], {"BOTHY_UP_NO_BUILD": "1", "BOTHY_IMAGE_TAG": prev},
                  cfg.own_apply_timeout)
        deadline = time.monotonic() + cfg.verify_timeout
        while True:
            bad = []
            for svc in OWN_SERVICES:
                c = hostio.container(cfg.own_containers[svc]) or {}
                if c.get("imageId") != spec["prevImages"][svc] or c.get("state") != "running" \
                        or c.get("health") not in (None, "healthy"):
                    bad.append(f"{cfg.own_containers[svc]} {c.get('state')}/{c.get('health')}")
            if not bad:
                break
            if time.monotonic() > deadline:
                raise StepError("after the rollback: " + ", ".join(bad))
            time.sleep(2)
        steps.append("the previous images run and are healthy")
        ok, detail = True, "; ".join(steps)
    except (StepError, HostError, OSError) as e:
        ok, detail = False, "; ".join([*steps, str(e)])
    try:
        hostio.write_json(os.path.join(cfg.own_dir, BLOCKED),
                          {"sha": spec["target"], "tag": spec.get("tag"), "job": job, "at": iso(), "why": detail[:300]})
        hostio.write_json(paths["result"], {"ok": ok, "detail": detail, "at": iso()})
        os.replace(firing, os.path.join(cfg.own_dir, f"{job}.fired.json"))
    except OSError:
        pass
    return ok, detail


def main_timer(path: str) -> int:
    """`python3 -m updater own-rollback <armed file>` - what the systemd timer runs."""
    real = os.path.realpath(path)
    if not re.fullmatch(r"[0-9a-f]{32}\.armed\.json", os.path.basename(real)) \
            or os.path.basename(os.path.dirname(real)) != "own":
        print(f"not an armed rollback: {path}", file=sys.stderr)
        return 2
    try:
        spec = read_spec(real)
    except (OSError, ValueError, HostError) as e:
        print(f"nothing to do: {e}")
        return 0
    c = spec.get("cfg") or {}
    cfg = Config(**{k: c[k] for k in ("repo", "catalog", "state", "backups", "textfile", "lib", "own_containers",
                                      "own_images", "own_apply_timeout", "verify_timeout") if k in c})
    if os.path.dirname(real) != os.path.realpath(cfg.own_dir):
        print("the armed file is not in its own state directory", file=sys.stderr)
        return 2
    paths = _armed_paths(cfg, spec["job"])
    if not _claim(real, paths["firing"]):
        print("disarmed - verify passed, or the executor is rolling back itself")
        return 0
    ok, detail = do_rollback(cfg, spec, paths["firing"])
    print(("rolled back: " if ok else "ROLLBACK FAILED: ") + detail)
    # If the executor is gone (killed, WSL restarted), nobody else will finish
    # the job's record: the lock is free exactly then.
    from .executor import _lock
    fd = _lock(cfg)
    if fd is not None:
        try:
            st = hostio.read_json(cfg.status_file)
            j = st.get("job") if isinstance(st, dict) else None
            if isinstance(j, dict) and j.get("id") == spec["job"] and j.get("state") == "running":
                rec = record.Recorder(cfg, j)
                cause = "the updater stopped before verify finished; the rollback timer fired"
                rec.step("rollback", "ok" if ok else "failed", detail)
                if ok:
                    rec.finish("rolled_back", cause, note=_note(cfg, spec["prev"], spec.get("tag") or "the release"))
                else:
                    rec.finish("failed", f"{cause}; and it did not restore the previous version: {detail}")
        except (OSError, ValueError, HostError):
            pass
        finally:
            os.close(fd)
    return 0 if ok else 1
