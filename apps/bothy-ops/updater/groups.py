"""Groups: apply everything `main` pins for ONE recipe, in one `docker compose up`.

    plan("up-monitoring")   -> dict, or raises plans.PlanRefused(reason)
    GroupExecution(...).go() -> the result, like any other job

── why this exists ──────────────────────────────────────────────────────────

`executor.compose_scope` refuses a single-component apply when any OTHER service
in the same compose project would also be recreated, because `just up-monitoring`
runs `docker compose up` over the whole project: applying Loki's merged pin would
drag Grafana's merged pin - a ONE-WAY migration - along with it, with no snapshot
of Grafana. The check is right and this does not weaken it.

But it also means that in a project where TWO services are behind, NO
single-component apply can ever succeed, and the updater can never leave that
state on its own. On 2026-10-07 ten components were behind on apply and three of
them (alloy, grafana, victoriametrics) were in `monitoring/`: every click was
refused, each naming the other two, and the only answer the product gave was "by
hand". A person then ran `just up-monitoring` by hand, which is precisely the
thing the check exists to prevent - every service recreated at once, Grafana's
one-way migration included, with no snapshot.

So the group is the missing action, and its rule is the union, never the loosest:

  the scope check is UNCHANGED; the group only widens `mine` to the union of its
  members' pinned services, and still refuses on anything left over - naming it,
  and naming why the updater will not carry it.

── what a group is ─────────────────────────────────────────────────────────────

One `apply` recipe (`just up-monitoring` -> the group id `up-monitoring`), and as
its members every component of the catalog that

  * shares that recipe,
  * is one of GROUP_CLASSES - the plain compose image pipeline - so that the ONLY
    thing the group changes is image pin lines, which is the only change a
    rollback can put back, and
  * has a deployable single-component plan right now.

Two or more such members, or there is no group: with one member the single
component's own Apply is the answer, and a group of one would widen `mine` by
nothing and be refused by exactly the same leftovers.

── the union of the members' treatments, never the loosest ───────────────────

  snapshot    EVERY member's class snapshot, taken before anything is pulled, the
              one-way ones first (theirs is the one that cannot be re-taken)
  confirm     type-the-name as soon as ONE member is one-way or one step is a
              major - and the name typed is the GROUP's, because the group is
              what is being approved
  channel     never automatic. The night job reads plans/<component>.json and
              deploys one component; it never sees this, and auto.decide() has
              no path to a group. _refuse_auto() says so again at run time.
  backups     the union of the members' required ~/backups/<kind> freshness
  disk        the sum of the members' estimates
  pre-flight  every member's container running, healthy, on the planned image,
              and every member's canaries green BEFORE anything changes
  verify      every member's canaries, every member's container on its new image
  rollback    ALL-OR-NOTHING, and said so in the UI. See below.

── rollback: all of them, together, and that is not a limitation to hide ──────

The apply is ONE `docker compose up`, so there is no "roll back Loki and keep
Grafana". A rollback writes EVERY member's previous image back on EVERY pin line
and runs the recipe once; a one-way member's data snapshot goes back FIRST, with
its new container stopped, exactly as the single-component path does.

A partial rollback is mechanically possible - write one member's pin back and run
the recipe, and compose recreates only that service - and it is deliberately NOT
offered. Verify failing for one member does not say the others are healthy
together, and the result would be a combination of versions that no commit on
`main` describes and that nobody reviewed, reached by a second recipe run that is
itself subject to the same scope trap. The operator approved one apply; one apply
is what comes back.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time

import updates

from . import canaries, classes, hostio, pins, plans, record
from .config import Config
from .executor import Execution, Refuse, StepError, compose_scope
from .hostio import HostError, iso
from .plans import PlanRefused

GROUP_VERSION = 1
KIND = "group"
# Exactly the classes executor.Execution runs: a plan whose whole change is image
# pin lines in one compose project. NOT `cluster` (helm/kubectl, its own narrow
# apply), NOT `database` (the Postgres major is a procedure, typed AND noted),
# NOT `own-code` (it moves the checkout), and not the `boundary` or `edge`
# classes, which the updater does not deploy at all.
GROUP_CLASSES = frozenset({"stateless", "timeseries", "app-db"})
# One member is not a group: the component's own Apply is the answer, and the
# union would widen `mine` by nothing.
MIN_MEMBERS = 2
GROUP_ID = re.compile(r"[a-z][a-z0-9-]{0,39}")


def recipe_of(comp: updates.Component) -> str:
    """`just up-monitoring` -> `up-monitoring`. load_catalog() proved the shape."""
    return comp.apply.split()[1]


def groups_of(catalog: updates.Catalog) -> dict[str, list[str]]:
    """{group id: member component ids} - every recipe with two or more candidates."""
    out: dict[str, list[str]] = {}
    for c in catalog.components.values():
        if c.cls in GROUP_CLASSES and c.source == "image":
            out.setdefault(recipe_of(c), []).append(c.id)
    return {g: sorted(v) for g, v in sorted(out.items()) if len(v) >= MIN_MEMBERS}


def group_of(catalog: updates.Catalog, cid: str) -> str | None:
    """The group a component belongs to, or None when its recipe has no group."""
    comp = catalog.components.get(cid)
    if comp is None or comp.cls not in GROUP_CLASSES or comp.source != "image":
        return None
    gid = recipe_of(comp)
    return gid if gid in groups_of(catalog) else None


def instead(comp: updates.Component, cfg: Config) -> str | None:
    """What to DO about a scope refusal, for the component whose apply was refused.

    From the catalog alone - no container, no registry - so the sentence costs one
    TOML parse and is there even when discovery has not run. It says one of two
    things, and never "by hand" with nothing after it:

      there IS a group for this recipe     -> apply the whole recipe together
      there is not (fewer than two of its  -> say so, and that `just <recipe>` by
      components are ones this deploys)       hand is then the only way, after a backup

    Whether the group is DEPLOYABLE today is the group plan's answer, on its own
    row in Settings > Updates; this only names the action that exists.
    """
    try:
        catalog = updates.load(cfg.catalog)
    except (updates.CatalogError, OSError, ValueError):
        return None
    gid = recipe_of(comp)
    if gid in groups_of(catalog):
        return (f"apply the whole recipe together: Settings > Updates > `Apply all of {comp.apply}` (the group "
                f"`{gid}`), which snapshots every member first and rolls all of them back together. From a "
                f"shell: `just update-groups {gid}`.")
    mates = sorted(c.id for c in catalog.components.values()
                   if c.apply == comp.apply and c.id != comp.id)
    return (f"there is no group for `{comp.apply}`: of its other components ({', '.join(mates) or 'none'}) "
            f"fewer than one more is a class the updater deploys, so it cannot apply them together. Back up "
            f"(`just backup`), then `{comp.apply}` by hand.")


# ── the plan ──────────────────────────────────────────────────────────────────

def _owner(catalog: updates.Catalog, service: str, project_files: set) -> updates.Component | None:
    """Which component pins `service` in one of the project's files, if any."""
    for c in catalog.components.values():
        for i in range(len(c.pins)):
            f, name = c.pin_parts(i)
            if name == service and os.path.basename(f) in project_files:
                return c
    return None


def _leftover_words(catalog: updates.Catalog, group: str, others: list[str], files: list[str],
                    member_ids: set, refusals: dict[str, str]) -> str:
    """Each service the group will NOT carry, and why - never just "by hand"."""
    basenames = {os.path.basename(f) for f in files}
    said = []
    for s in sorted(others):
        c = _owner(catalog, s, basenames)
        if c is None:
            said.append(f"{s} (no component in updates.toml owns it)")
        elif c.id in member_ids:
            said.append(f"{s} (a member's own service, which is a defect - report it)")
        elif c.cls not in GROUP_CLASSES or c.source != "image":
            said.append(f"{s} ({c.id}, class {c.cls} - the updater does not deploy it here; `{c.apply}` by hand)")
        elif recipe_of(c) != group:
            said.append(f"{s} ({c.id}, applied by `{c.apply}`, not this recipe)")
        else:
            said.append(f"{s} ({c.id}: {refusals.get(c.id, 'no deployable plan')})")
    return "; ".join(said)


def plan(group: str, *, cfg: Config | None = None, catalog: updates.Catalog | None = None,
         available: dict | None = None) -> dict:
    """The group plan alone - what discovery writes and bothy-ops serves."""
    return resolve(group, cfg=cfg, catalog=catalog, available=available)[0]


def resolve(group: str, *, cfg: Config | None = None, catalog: updates.Catalog | None = None,
            available: dict | None = None) -> tuple[dict, list[tuple[updates.Component, dict]]]:
    """(the group plan, its members' FULL single-component plans).

    The executor needs the full member plans to run them; the plan FILE carries
    only the summary `memberRows`, so neither the file nor bothy-ops' copy of it
    is where the executor gets what it acts on. It recomputes this and refuses
    unless the group id comes out the same.
    """
    cfg = cfg or Config()
    try:
        catalog = catalog or updates.load(cfg.catalog)
    except (updates.CatalogError, OSError, ValueError) as e:
        raise PlanRefused(f"updates.toml is invalid: {e}") from None
    if not isinstance(group, str) or not GROUP_ID.fullmatch(group):
        raise PlanRefused("that is not a group id")
    all_groups = groups_of(catalog)
    if group not in all_groups:
        raise PlanRefused(f"{group!r} is not a recipe with two or more components the updater deploys")
    available = available if available is not None else plans.load_available(cfg)

    members: list[tuple[updates.Component, dict]] = []
    refusals: dict[str, str] = {}
    for cid in all_groups[group]:
        try:
            members.append((catalog.components[cid],
                            plans.plan(cid, cfg=cfg, catalog=catalog, available=available)))
        except PlanRefused as e:
            refusals[cid] = str(e)[:200]
    if len(members) < MIN_MEMBERS:
        why = "; ".join(f"{cid}: {r}" for cid, r in sorted(refusals.items()))
        raise PlanRefused(f"{len(members)} of {len(all_groups[group])} components of `just {group}` have "
                          f"something to apply; a group is for two or more (one is its own row). {why}"[:300])

    # The project, read once from the first member's container - every member must
    # be in the same one, or `just <recipe>` is not one `docker compose up`.
    anchor, anchor_plan = members[0]
    try:
        pj = hostio.compose_project(cfg.repo, anchor_plan["container"], anchor_plan["pin"]["file"],
                                    anchor_plan["pin"]["service"])
    except HostError as e:
        raise PlanRefused(f"the project of `just {group}` could not be read: {e}") from None
    mine: set[str] = set()
    for comp, p in members:
        c = hostio.container(p["container"]) or {}
        lab = c.get("labels") or {}
        if lab.get("com.docker.compose.project") != pj["project"]:
            raise PlanRefused(f"{p['container']} is in compose project "
                              f"{lab.get('com.docker.compose.project')!r}, not {pj['project']!r} - "
                              f"`just {group}` is not one compose project")
        for q in p["pins"]:
            if q["service"] in pj["want"]:
                mine.add(q["service"])
    others = [s for s in pj["want"] if s not in mine and pj["have"].get(s) != pj["want"][s]]
    if others:
        # The scope rule, unchanged, over the union. Everything left over is named,
        # with whose it is and why the group will not carry it.
        raise PlanRefused(f"`just {group}` would also recreate or create "
                          f"{_leftover_words(catalog, group, others, pj['files'], {c.id for c, _ in members}, refusals)}"
                          f" - the group moves image pins only, so those are still by hand "
                          f"(back up first)"[:300])

    # ── the union: the strictest of every member's treatment ──
    one_way = [c.id for c, _ in members if c.one_way]
    levels = [p["level"] for _, p in members]
    worst = "major" if "major" in levels else "minor" if "minor" in levels else "patch"
    confirm = "type-name" if (one_way or worst == "major") else "click"
    kinds = sorted({classes.get(c.cls, c.id).snapshot_kind(c.id) for c, _ in members})
    backup_kinds = sorted({k for c, _ in members for k in classes.get(c.cls, c.id).backup_kinds(c.id)})
    estimate = sum(int(classes.get(c.cls, c.id).estimate(cfg, c.id) or 0) for c, _ in members)
    material = {
        "v": GROUP_VERSION, "group": group, "recipe": anchor.apply, "project": pj["project"],
        "services": sorted(mine),
        "members": [{"component": c.id, "planId": p["id"]} for c, p in members],
    }
    doc = {
        **material,
        "kind": KIND,
        "id": hashlib.sha256(json.dumps(material, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:24],
        "title": f"Everything `{anchor.apply}` pins",
        "createdAt": iso(),
        "discoveredAt": available.get("generatedAt"),
        "level": worst,
        "confirm": confirm,
        # What the person types when confirm is type-name: the GROUP's id. Typing a
        # member's name would misname what is being approved.
        "confirmWord": group,
        "oneWay": bool(one_way),
        "oneWayWhy": ("; ".join(f"{c.id}: {c.one_way_why}" for c, _ in members if c.one_way)[:300]
                      if one_way else None),
        "memberRows": [{
            "component": c.id, "title": c.title, "class": c.cls, "container": p["container"],
            "planId": p["id"], "level": p["level"], "oneWay": c.one_way,
            "from": {"image": p["from"]["image"], "version": p["from"]["version"], "tag": p["from"]["tag"],
                     "digest": p["from"]["digest"]},
            "to": {"image": p["to"]["image"], "version": p["to"]["version"], "tag": p["to"]["tag"],
                   "digest": p["to"]["digest"]},
            "pins": [{"file": q["file"], "service": q["service"], "line": q["line"]} for q in p["pins"]],
            "snapshot": classes.get(c.cls, c.id).snapshot_kind(c.id),
            "changelog": p["changelog"],
        } for c, p in members],
        "skipped": [{"component": cid, "reason": r} for cid, r in sorted(refusals.items())],
        "restarts": sorted({r for _, p in members for r in p["restarts"]}),
        "downtime": "; ".join(f"{c.id}: {p['downtime']}" for c, p in members)[:800],
        "signedOut": "; ".join(dict.fromkeys(p["signedOut"] for _, p in members))[:300],
        "snapshot": {
            "kinds": kinds,
            "what": "every member's own snapshot, the one-way ones first, all of them BEFORE anything is "
                    "pulled: " + "; ".join(f"{c.id} - {classes.get(c.cls, c.id).snapshot_words(c.id)}"
                                           for c, _ in members)[:1200],
            "dir": plans._home(os.path.join(cfg.snapshots, f"<time>-group-{group}")) + "/<component>/",
            "estimateBytes": estimate,
        },
        "preflight": [
            "the group plan is still current: every member's plan recomputed here, and this group id",
            "free disk: at least twice (every image + every snapshot) on the backup disk and on Docker's",
            "every member's container is running and healthy on the image its plan recorded, and every "
            "member's canaries pass NOW",
            f"`{anchor.apply}` recreates exactly {', '.join(sorted(mine))} in project {pj['project']} and "
            "nothing else (compose config hashes) - the same check a single component gets, over the union",
            f"the newest backup in ~/backups/{{{','.join(backup_kinds)}}} is under 24 h old",
            "the actor is a person, never the night job",
            "no other update is running (one global lock)",
        ],
        "verify": [f"{p['container']} runs the pulled image and is healthy" for _, p in members]
        + [f"{c.id}: {d.describe}" for c, _ in members for d in canaries.for_component(cfg, c.id)],
        "rollback": (
            f"ALL OR NOTHING. The apply is one `{anchor.apply}`, so a rollback is one too: every member's "
            "previous image goes back on EVERY pin line (edits of the working tree, left uncommitted on "
            "purpose) and the recipe runs once, and every member must then pass its own canaries on its old "
            "image. "
            + ("A one-way member's data snapshot is restored FIRST, with its container stopped - "
               f"{', '.join(one_way)} - and anything written since the snapshot is lost. If a restore fails, "
               "the old images are NOT put back and a person is needed. " if one_way else "")
            + "There is no partial rollback: the members that worked do not stay on their new images, because "
              "that is a combination no commit on main describes."),
        "backupKinds": backup_kinds,
    }
    return doc, members


# ── the files discovery writes, one per group ─────────────────────────────────

def _group_file(cfg: Config, gid: str) -> str:
    return os.path.join(cfg.groups, f"{gid}.json")


def write_all(cfg: Config | None = None, catalog: updates.Catalog | None = None,
              available: dict | None = None) -> dict[str, str]:
    """groups/<group>.json - its current plan, or why there is none. 600 in a 700 dir.

    Keyed by GROUP, like plans/<component>.json is keyed by component, so a stale
    group plan cannot linger beside the current one. bothy-ops reads them through
    its read-only mount of the state directory and never writes one.
    """
    cfg = cfg or Config()
    catalog = catalog or updates.load(cfg.catalog)
    hostio.ensure_dir(cfg.state, 0o700)
    hostio.ensure_dir(cfg.groups, 0o700)
    try:
        available = available if available is not None else plans.load_available(cfg)
    except PlanRefused:
        available = None
    known = groups_of(catalog)
    out: dict[str, str] = {}
    for gid in known:
        try:
            if available is None:
                raise PlanRefused("nothing discovered yet - run `just updates-discover`")
            p = plan(gid, cfg=cfg, catalog=catalog, available=available)
            doc = {"version": GROUP_VERSION, "group": gid, "ok": True, "plan": p}
            out[gid] = p["id"]
        except PlanRefused as e:
            doc = {"version": GROUP_VERSION, "group": gid, "ok": False, "reason": str(e)[:300],
                   "createdAt": iso(), "discoveredAt": (available or {}).get("generatedAt"),
                   "members": known[gid]}
            out[gid] = f"- {e}"
        hostio.write_json(_group_file(cfg, gid), doc)
    for fn in os.listdir(cfg.groups):
        if fn.endswith(".json") and fn[:-5] not in known:
            os.unlink(os.path.join(cfg.groups, fn))
    return out


def read_group(cfg: Config, gid: str) -> dict | None:
    try:
        doc = hostio.read_json(_group_file(cfg, gid), 256 * 1024)
    except (OSError, ValueError, HostError):
        return None
    return doc if isinstance(doc, dict) else None


# ── the job ───────────────────────────────────────────────────────────────────

class GroupExecution:
    """One `docker compose up` for several components, each with its own class.

    Every per-member mechanic is the single-component one: an executor.Execution
    per member, sharing this job's Recorder, driven phase by phase. So a member of
    class app-db gets app-db's stop-and-tar snapshot and app-db's restore-first
    rollback here exactly as it would alone - that is what "the union, never the
    loosest" means in code rather than in a comment.
    """

    def __init__(self, cfg: Config, rec: record.Recorder, plan_: dict,
                 members: list[tuple[updates.Component, dict]]) -> None:
        self.cfg = cfg
        self.rec = rec
        self.plan = plan_
        self.group = plan_["group"]
        self.recipe = plan_["recipe"]
        self.execs = [Execution(cfg, rec, comp, p) for comp, p in members]
        # The one-way members first everywhere it matters: their snapshot is the one
        # that cannot be taken again afterwards, and their restore is the rollback.
        self.ordered = sorted(self.execs, key=lambda x: (not x.klass.always_restore, x.comp.id))
        self.dir = ""

    # ── the job ──
    def go(self) -> str:
        try:
            self.step("preflight", self.preflight)
        except Refuse as e:
            return self.rec.finish("refused", str(e))["state"]
        pulled: dict[str, str] = {}
        try:
            self.step("snapshot", self.snapshot)
            self.step("pull", lambda: self.pull(pulled))
        except StepError as e:
            return self.rec.finish("aborted", f"{e} - nothing running was changed")["state"]
        try:
            self.step("apply", self.apply)
            self.step("verify", lambda: self.verify(pulled))
        except StepError as e:
            return self.rollback(e)
        return self.rec.finish("succeeded", note=self._note_ok())["state"]

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

    # ── pre-flight: every member's, plus the union scope ──
    def preflight(self) -> str:
        notes = []
        for x in self.execs:
            notes.append(f"{x.comp.id}: " + "; ".join(n for n in (x._backups(), x._disk(), x._health()) if n))
        mine = set(self.plan["services"])
        notes.append(compose_scope(self.cfg, self.execs[0].container, self.execs[0].pin.file,
                                   self.execs[0].pin.service, mine, self.recipe,
                                   instead=f"this group already covers them; recompute it "
                                           f"(`just updates-discover`) and ask again"))
        for x in self.execs:
            notes.append(f"{x.comp.id}: {x._baseline()}")
        return " | ".join(notes)

    # ── snapshot: every member, into one group directory, one-way first ──
    def snapshot(self) -> str:
        hostio.ensure_dir(self.cfg.snapshots, 0o700)
        self.dir = os.path.join(self.cfg.snapshots,
                                f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-group-{self.group}")
        os.mkdir(self.dir, 0o700)
        self.rec.set(snapshot=self.dir)
        out = []
        for x in self.ordered:
            out.append(x.snapshot(into=os.path.join(self.dir, x.comp.id)))
        self._rotate()
        return " | ".join(out)

    def _rotate(self) -> None:
        rx = re.compile(rf"\d{{8}}T\d{{6}}Z-group-{re.escape(self.group)}")
        mine = sorted(n for n in os.listdir(self.cfg.snapshots) if rx.fullmatch(n))
        for n in mine[:-self.cfg.keep_snapshots]:
            shutil.rmtree(os.path.join(self.cfg.snapshots, n), ignore_errors=True)

    # ── pull: every member's planned digest, or nothing ──
    def pull(self, into: dict) -> str:
        for x in self.execs:
            into[x.comp.id] = x.pull()
        return ", ".join(f"{k} {v[:19]}" for k, v in sorted(into.items()))

    # ── apply: the recipe, ONCE ──
    def apply(self) -> str:
        self.execs[0]._recipe()
        return f"`{self.recipe}` done - one compose up for {', '.join(self.plan['services'])}"

    # ── verify: every member's image, health and canaries ──
    def verify(self, pulled: dict) -> str:
        out = []
        for x in self.execs:
            ok, detail, _ = x.check(pulled[x.comp.id], "verify")
            if not ok:
                raise StepError(f"{x.comp.id}: {detail}")
            out.append(f"{x.comp.id}: {detail}")
        return " | ".join(out)

    # ── rollback: all of them, one-way data first ──
    def rollback(self, cause: Exception) -> str:
        self.rec.step("rollback", "running", f"because {cause}")
        restored: list[str] = []
        for x in self.ordered:
            if not x.klass.always_restore:
                continue
            self.rec.step("restore", "running", f"one-way {x.comp.id}: restoring {x.artefact} before the old image")
            rok, rdetail = x.klass.restore(self.cfg, x.comp.id, x.container, x.artefact or "")
            if not rok:
                self.rec.step("restore", "failed", f"{x.comp.id}: {rdetail}")
                self.rec.step("rollback", "failed", f"{x.comp.id}'s snapshot could not be restored - no old "
                                                    "image was put back, on data it may not be able to read")
                return self.rec.finish("failed", f"{cause}; and restoring {x.comp.id} failed: {rdetail}",
                                       note=self._note_bad(x))["state"]
            restored.append(x.comp.id)
            self.rec.step("restore", "ok", f"{x.comp.id}: {rdetail}")
        try:
            for x in self.execs:
                for q in x.pins:
                    pins.replace(self.cfg.repo, q, x.plan["from"]["image"])
            self.execs[0]._recipe()
        except Exception as e:  # noqa: BLE001 - HostError, StepError, OSError
            self.rec.step("rollback", "failed", str(e))
            return self.rec.finish("failed", f"{cause}; and the rollback failed: {e}",
                                   note=self._note(restored))["state"]
        bad = []
        probes = {}
        for x in self.execs:
            ok, detail, history_ok = x.check(x.plan["from"]["imageId"], "rollback")
            probes[x.comp.id] = (ok, detail, history_ok, x)
            if not ok:
                bad.append(f"{x.comp.id}: {detail}")
        if not bad:
            self.rec.step("rollback", "ok", f"every member is back on its previous image ({len(self.execs)})")
            return self.rec.finish("rolled_back", str(cause), note=self._note(restored))["state"]
        # A time-series member whose history is unreadable under the OLD image too:
        # its data is damaged, and only then is a restore the right move (the same
        # rule the single-component path has - a restore is never the first move).
        damaged = [p for p in probes.values()
                   if not p[0] and not p[2] and p[3].klass.history and p[3].artefact
                   and p[3].comp.id not in restored]
        if not damaged:
            self.rec.step("rollback", "failed", "; ".join(bad))
            return self.rec.finish("failed", f"{cause}; after the rollback: {'; '.join(bad)}",
                                   note=self._note(restored))["state"]
        self.rec.step("rollback", "ok", f"the old images are back, but {'; '.join(bad)}")
        for _, _, _, x in damaged:
            self.rec.step("restore", "running", f"{x.comp.id}: restoring {x.artefact}")
            rok, rdetail = x.klass.restore(self.cfg, x.comp.id, x.container, x.artefact or "")
            if not rok:
                self.rec.step("restore", "failed", f"{x.comp.id}: {rdetail}")
                return self.rec.finish("failed", f"{cause}; data restore of {x.comp.id} did not recover: "
                                                 f"{rdetail}", note=self._note(restored + [x.comp.id]))["state"]
            restored.append(x.comp.id)
            self.rec.step("restore", "ok", f"{x.comp.id}: {rdetail}")
        again = [f"{x.comp.id}: {d}" for x in self.execs
                 for ok, d, _ in [x.check(x.plan["from"]["imageId"], "rollback")] if not ok]
        if again:
            return self.rec.finish("failed", f"{cause}; after the restore: {'; '.join(again)}",
                                   note=self._note(restored))["state"]
        return self.rec.finish("rolled_back", str(cause), note=self._note(restored))["state"]

    # ── the words a person reads afterwards ──
    def _note_ok(self) -> str:
        return (f"{', '.join(self.plan['services'])} run what main pins, in one `{self.recipe}` - the tree is "
                f"unchanged. Snapshots: {self.dir}")

    def _note(self, restored: list[str]) -> str:
        where = ", ".join(f"{q.file}:{q.line}" for x in self.execs for q in x.pins)
        s = (f"{where} now pin the PREVIOUS images LOCALLY (uncommitted, on purpose) so the next "
             f"`{self.recipe}` keeps the versions that work; main still pins the new ones. The whole group "
             f"went back - there is no partial rollback. Find out why it failed, then `git checkout --` those "
             f"files and apply the group again.")
        if restored:
            s += f" Data was restored for {', '.join(restored)}: anything written after the snapshot is gone."
        return s[:800]

    def _note_bad(self, x) -> str:
        return (f"The data snapshot {x.artefact} of {x.comp.id} could NOT be restored, so NO old image was put "
                f"back; {x.container} may be stopped and the other members still run their new images. A person "
                f"is needed: restore it by hand, then `{self.recipe}`.")[:800]
