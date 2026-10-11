"""Change ONE allowlisted compose value, and put it back if the service does not
come back healthy.

    plan(component, key)        -> the plan, or raises plans.PlanRefused(reason)
    rows(component)             -> every env key of the component, editable or not
    write_all()                 -> configs/<component>.json, beside plans/ and groups/
    ConfigExecution(...).go()   -> the result, like any other job

── why this exists, and why it is shaped like this ───────────────────────────

The owner asked to be able to change a config value from the browser, and gave
the criterion for what may be on the list in their own words: anything whose
being wrong still leaves you able to reach the box and fix it. updates.toml's
[config_keys] header carries that criterion and the measurement behind it.

That criterion is what makes the undo HERE sufficient, and the two are not
separable. An automatic revert that runs in this process can save you from a
Grafana that will not start; it cannot save you from a Traefik that will not
route, because then nothing is left to tell you it ran. So the allowlist refuses
exactly the values the revert could not cover, and the revert covers exactly what
the allowlist allows. Each is the other's justification.

── the id, and the one field it cannot cover ────────────────────────────────

Every other plan in this package is a hash of facts the HOST read, and the
executor refuses a request unless it recomputes the same hash. A config change
has one field that is not such a fact: the new value comes from the browser. So
the two halves are validated differently, on purpose:

  the SITE       file, service, key, the value that is live, the pattern, the
                 container, the recipe, the compose project, HEAD's sha. All read
                 on the host, hashed into the plan id, recomputed by the executor
                 and refused unless identical. This is what makes "the plan went
                 stale" work: a value somebody changed in Files, a container that
                 moved, a commit, and the id is different.
  the VALUE      the one thing that comes from the request. It is never trusted:
                 it is fullmatched against the pattern in the catalog the HOST
                 reads, by bothy-ops first and by the executor again, and it
                 reaches a file write and nothing else - never an argv, never a
                 shell, never a template.

Putting the new value INTO the id would look stricter and prove nothing: the host
would be checking a hash of something it was told against the thing it was told.
The pattern is the bound that actually holds, and it is the same bound
kube.py already applies to a `configmap-value` param from the same browser.

── a config job is strictly smaller than an image job ───────────────────────

Same class, same pre-flight, same snapshot, same canaries - and three narrowings:

  the image never changes      so the first-start migration that makes Grafana
                               and Keycloak one-way never runs. That is why
                               `app-db` is in updates.CONFIG_CLASSES.
  no data is ever restored     the revert is the value going back. A restore is
                               the only step that loses data, and for a change
                               that moved one env value it is never the right
                               move - the snapshot is there for a person.
  the scope rule is unchanged  `just <recipe>` must recreate this service and
                               nothing else, over the same compose config hashes
                               executor.compose_scope and groups.py read.

── what a success leaves behind, said out loud ──────────────────────────────

The edit is in the WORKING TREE, uncommitted - the same place a rollback leaves a
pin line, and for the same reason: it is the only write to the tree this package
makes that a person can read with `git diff`. The cost is real and the job's note
says it: while that file is dirty, plans._git_gate refuses an image plan for
EVERY component pinned in it, which for monitoring/compose.yml is six. So a
successful config change is a pending commit, and the product says so rather than
letting the next Settings > Updates visit look broken for an unexplained reason.

The alternative - revert the tree after a successful verify and leave the running
container changed - was considered and is worse: the box would then run a
configuration `main` does not declare, which is the exact fault the owner
reported and batch 1A made the box admit to.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time

import updates

from . import canaries, classes, composeenv, hostio, pins, plans
from .config import Config
from .executor import Execution, Refuse, StepError, compose_scope
from .hostio import HostError, iso
from .plans import PlanRefused

CONFIG_VERSION = 1
KIND = "config"
# The same 24 hex a component or group plan id is: one shape of plan id in the
# spool, one regex (spool.PLAN_ID) that validates all three.
ID_LEN = 24


def _material_id(material: dict) -> str:
    return hashlib.sha256(json.dumps(material, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()[:ID_LEN]


def _tag_of(ref: object) -> str | None:
    from discover_updates import split_image   # the one parser of image references
    return split_image(ref)["tag"] if isinstance(ref, str) and ref else None


def value_ok(ck: updates.ConfigKey, value: object) -> str:
    """"" if `value` is legal for `ck`, else why not - for a person, not a log.

    ONE implementation, called by bothy-ops before it writes the spool file and
    by the executor when it claims it. The second call is not a formality: it is
    the one that holds when bothy-ops is the thing that is wrong, and it reads the
    pattern out of the catalog on the HOST rather than out of the request.
    """
    if not isinstance(value, str):
        return "the value is not a string"
    if not value or value.strip() != value:
        return "the value is empty, or has space at either end"
    if len(value) > updates.CONFIG_MAX_VALUE:
        return f"the value is {len(value)} characters; the limit is {updates.CONFIG_MAX_VALUE}"
    if not re.fullmatch(ck.pattern, value):
        return (f"{value!r} is not one of the values {ck.key} may take. {ck.meaning} "
                f"The allowed shape is /{ck.pattern}/")
    return ""


# ── the plan ──────────────────────────────────────────────────────────────────

def plan(component: str, key: str, *, cfg: Config | None = None,
         catalog: updates.Catalog | None = None, available: dict | None = None) -> dict:
    """The plan for changing one allowlisted value, or why there is none."""
    cfg = cfg or Config()
    try:
        catalog = catalog or updates.load(cfg.catalog)
    except (updates.CatalogError, OSError, ValueError) as e:
        raise PlanRefused(f"updates.toml is invalid: {e}") from None
    ck = catalog.config_keys.get(f"{component}.{key}")
    if ck is None:
        # NOT "unknown key": a key that exists in the file and is not on the list
        # has a reason, and the reason is what belongs on the row.
        raise PlanRefused(f"{component}.{key} is not an editable config value")
    comp = catalog.components[ck.component]
    klass = classes.get(comp.cls, comp.id)
    if klass is None:
        raise PlanRefused(f"class {comp.cls} is not handled by the updater")

    head = plans._git_gate(cfg, [ck.file], catalog)
    try:
        with open(os.path.join(cfg.repo, ck.file), encoding="utf-8") as fh:
            text = fh.read()
    except OSError as e:
        raise PlanRefused(f"{ck.file} could not be read ({e.strerror})") from None
    try:
        site = composeenv.locate(text, ck.service, ck.key, ck.file)
    except composeenv.Refused as e:
        raise PlanRefused(str(e)[:300]) from None
    bad = value_ok(ck, site.value)
    if bad:
        # THE SECOND OF [config_keys]' TWO RULES, enforced at plan time rather
        # than only in a check: a pattern that refuses the running value draws an
        # Edit button on a row that cannot be edited. Refusing the plan is how
        # that becomes a sentence instead of a dead control.
        raise PlanRefused(f"the pattern for {ck.key} does not accept the value that is live "
                          f"({site.value!r}) - the row would offer an edit that every value fails. "
                          f"Fix the pattern in updates.toml: {bad}"[:300])

    try:
        pin = pins.locate(cfg.repo, ck.file, ck.service)
    except HostError as e:
        raise PlanRefused(str(e)) from None
    if not pin.container:
        raise PlanRefused(f"{ck.file}:{ck.service} has no container_name - the updater addresses "
                          "containers by name")
    run = hostio.container(pin.container)
    if run is None or run.get("state") != "running":
        raise PlanRefused(f"{pin.container} is not running - start it with `{comp.apply}` first; the "
                          "updater only changes a running, healthy service")
    if not run.get("image") or not run.get("imageId"):
        raise PlanRefused(f"docker inspect {pin.container} did not say what it runs")
    try:
        pj = hostio.compose_project(cfg.repo, pin.container, ck.file, ck.service)
    except HostError as e:
        raise PlanRefused(f"the compose project of {pin.container} could not be read: {e}") from None

    available = available if available is not None else plans.load_available(cfg)
    material = {
        "v": CONFIG_VERSION, "kind": KIND, "component": comp.id, "class": comp.cls,
        "container": pin.container, "project": pj["project"],
        "file": ck.file, "service": ck.service, "key": ck.key,
        "from": {"value": site.value, "line": site.line, "text": site.text},
        # THE IMAGE IS IN THE ID, and it is not decoration: if a deploy moves this
        # container between the plan being written and the request being claimed,
        # the plan is stale, and `from.value` may be a value the new version reads
        # differently. The image itself never changes DURING a config job - that
        # is the whole reason this job is smaller than an image job - so putting
        # it in the id costs nothing and buys that staleness check.
        "image": run["image"], "imageId": run["imageId"],
        "pattern": ck.pattern, "commit": head, "recipe": comp.apply,
    }
    cs = canaries.for_component(cfg, comp.id)
    return {
        **material,
        "id": _material_id(material),
        "title": f"{ck.key} on {comp.title}",
        "meaning": ck.meaning,
        "createdAt": iso(),
        "discoveredAt": available.get("generatedAt"),
        # Every component whose pin lives in this file - how far one uncommitted
        # line reaches, which is what a successful config change leaves behind.
        # The same fact plans._pinned_in computes for the dirty-file refusal, read
        # here so the plan can state the cost BEFORE the button rather than only
        # in the note afterwards.
        "pinnedIn": plans._pinned_in(catalog, ck.file),
        # ONE CLICK, and the level follows REVERSIBILITY (catalog.toml decision 7,
        # 2026-09-21): the host holds the old value and puts it back by itself
        # when the canaries do not come green, so this is a change that can be
        # put back from this interface - which is what a click means here. It is
        # a click even on a one-way component, because the image does not move
        # and so the migration that makes it one-way does not run.
        "confirm": "click",
        "oneWay": False,
        "restarts": list(dict.fromkeys([pin.container, *comp.dependants])),
        "downtime": klass.downtime(cfg, comp.id),
        "signedOut": klass.signed_out(cfg, comp.id),
        "snapshot": {"kind": klass.snapshot_kind(comp.id), "what": klass.snapshot_words(comp.id),
                     "dir": plans._home(os.path.join(cfg.snapshots,
                                                     f"<time>-config-{comp.id}")) + "/",
                     "estimateBytes": klass.estimate(cfg, comp.id)},
        "preflight": [
            "the plan is still current: the file, the line, the value that is live, the container and "
            "HEAD recomputed on the host, with this id",
            f"the new value fullmatches /{ck.pattern}/, checked again here and not taken from the request",
            f"{ck.file} has no uncommitted changes, so the value this puts back is the one `main` declares",
            f"{pin.container} is running and healthy, and its canaries pass NOW - a change is never "
            "verified against a service that was already broken",
            f"`{comp.apply}` would recreate {ck.service} in project {pj['project']} and nothing else "
            "(compose config hashes), so no other pending change rides along",
            f"the newest backup in ~/backups/{{{','.join(klass.backup_kinds(comp.id))}}} is under 24 h old",
            "the request was made by a person, never the night job",
            "no other update is running (one global lock)",
        ],
        "verify": [f"{pin.container} is running and healthy on the same image", *(c.describe for c in cs)],
        "revert": (
            f"AUTOMATIC, and it is the host's. If {pin.container} is not healthy with every canary green "
            f"within {cfg.verify_timeout}s, {ck.file}:{site.line} goes back to {site.value} and "
            f"`{comp.apply}` runs again - whether or not a browser is still watching, because the host "
            "executor holds the old value and does the putting back. No data is restored: the image "
            "never changed, so nothing was migrated, and a restore is the only step that loses data."),
        "rollback": klass.rollback,
    }


# ── the rows a page draws: every key, editable or with its reason ─────────────

def rows(component: str, *, cfg: Config | None = None,
         catalog: updates.Catalog | None = None, available: dict | None = None) -> list[dict]:
    """Every environment key of this component's pinned services.

    An editable key carries its plan (or the refusal that stands in its place); a
    locked one carries the [config_reasons] category that says why.

    A LOCKED KEY CARRIES NO VALUE, deliberately. Fourteen of the 123 environment
    names in this repository are `${...}` pointers into the gitignored `.env`, and
    the source text of one of those names the variable and its fallback. This file
    is served to a `viewer` through GET /-/api/updates/plan, so the rule
    SECURITY.md rule 7 states for the credential inventory holds here too: key
    names and whether there is a value, never a value. An EDITABLE key's value is
    served, because the pattern bounds what it can be and the allowlist has
    already refused every name that reads as a credential.
    """
    cfg = cfg or Config()
    catalog = catalog or updates.load(cfg.catalog)
    comp = catalog.components.get(component)
    if comp is None or comp.source != "image":
        return []
    out: list[dict] = []
    for i in range(len(comp.pins)):
        rel, service = comp.pin_parts(i)
        if not service:
            continue
        try:
            with open(os.path.join(cfg.repo, rel), encoding="utf-8") as fh:
                text = fh.read()
        except OSError:
            continue
        env = composeenv._env_map(text)
        for (svc, key) in sorted(k for k in env if k[0] == service):
            ck = catalog.config_keys.get(f"{component}.{key}")
            if ck is None or ck.service != svc:
                r = catalog.config_reason(key, rel)
                out.append({"key": key, "service": svc, "file": rel, "editable": False,
                            "reason": {"name": r.name, "label": r.label, "meaning": r.meaning}})
                continue
            row = {"key": key, "service": svc, "file": rel, "editable": True,
                   "pattern": ck.pattern, "meaning": ck.meaning}
            try:
                p = plan(component, key, cfg=cfg, catalog=catalog, available=available)
                row.update(value=p["from"]["value"], line=p["from"]["line"], planId=p["id"], plan=p)
            except PlanRefused as e:
                # Allowlisted and not changeable right now - a dirty file, a
                # stopped container, a value in a shape the splice will not touch.
                # The row still says it is editable, because it is: what is wrong
                # is the state of the box, and that is the sentence to show.
                row.update(value=None, planId=None, reason=str(e)[:300])
            out.append(row)
    return out


# ── the files discovery writes, one per component ─────────────────────────────

def _config_file(cfg: Config, cid: str) -> str:
    return os.path.join(cfg.configs, f"{cid}.json")


def write_all(cfg: Config | None = None, catalog: updates.Catalog | None = None,
              available: dict | None = None) -> dict[str, str]:
    """configs/<component>.json - 600 in a 700 dir, beside plans/ and groups/.

    Keyed by COMPONENT, so a stale row cannot linger beside the current one, and
    written by the same discovery run for the same reason: a plan id is computed
    by the code that re-checks it.
    """
    cfg = cfg or Config()
    catalog = catalog or updates.load(cfg.catalog)
    hostio.ensure_dir(cfg.state, 0o700)
    hostio.ensure_dir(cfg.configs, 0o700)
    try:
        available = available if available is not None else plans.load_available(cfg)
    except PlanRefused:
        available = {}
    mine = sorted(c.id for c in catalog.components.values() if c.source == "image")
    out: dict[str, str] = {}
    for cid in mine:
        try:
            rs = rows(cid, cfg=cfg, catalog=catalog, available=available)
            doc = {"version": CONFIG_VERSION, "component": cid, "ok": True, "rows": rs,
                   "createdAt": iso(), "discoveredAt": available.get("generatedAt")}
            out[cid] = f"{sum(1 for r in rs if r.get('planId'))}/{len(rs)}"
        except (OSError, ValueError, updates.CatalogError) as e:
            doc = {"version": CONFIG_VERSION, "component": cid, "ok": False,
                   "reason": f"{type(e).__name__}: {e}"[:300], "rows": [], "createdAt": iso(),
                   "discoveredAt": available.get("generatedAt")}
            out[cid] = f"- {e}"
        hostio.write_json(_config_file(cfg, cid), doc)
    for fn in os.listdir(cfg.configs):
        if fn.endswith(".json") and fn[:-5] not in mine:
            os.unlink(os.path.join(cfg.configs, fn))
    return out


def read_config(cfg: Config, cid: str) -> dict | None:
    try:
        doc = hostio.read_json(_config_file(cfg, cid), 1024 * 1024)
    except (OSError, ValueError, HostError):
        return None
    return doc if isinstance(doc, dict) else None


def find_row(doc: dict | None, service: str, key: str) -> dict | None:
    """The row for ONE (service, key), never for a key alone.

    A COMPONENT MAY PIN TWO SERVICES, and two services may set the same
    environment key - Keycloak pins `keycloak` and `keycloak-init`, which share
    four of them. So the rows of one component legitimately carry the same key
    twice, and a lookup by key alone returns whichever came first. Found by
    checks/test_config_values.py with a fixture where `web` and `side` both set
    MODE: the locked `side` row shadowed the editable `web` one, and every
    request for it would have been refused with "there is no deployable config
    plan" for a value that was perfectly editable. The allowlist entry itself is
    never ambiguous - [config_keys] names the service - so the service is always
    available to the caller, and it is now required.
    """
    for r in (doc or {}).get("rows") or []:
        if isinstance(r, dict) and r.get("key") == key and r.get("service") == service:
            return r
    return None


# ── the job ───────────────────────────────────────────────────────────────────

class ConfigExecution:
    """One value changed, applied, verified, and put back if it did not hold.

    It borrows executor.Execution wholesale for the parts that are identical -
    the backup, disk and health pre-flight, the class's snapshot, the health and
    canary check - so that a config job gets app-db's stop-and-tar snapshot here
    exactly as an image job would, and there is no second copy of any of it to
    drift. What it overrides is the three steps that are actually different:
    `edit` instead of `pull`, no data restore anywhere, and a rollback that writes
    a value rather than an image reference.
    """

    def __init__(self, cfg: Config, rec, comp: updates.Component, plan_: dict, value: str) -> None:
        self.cfg = cfg
        self.rec = rec
        self.comp = comp
        self.plan = plan_
        self.value = value
        self.old = plan_["from"]["value"]
        self.file = plan_["file"]
        self.service = plan_["service"]
        self.key = plan_["key"]
        self.line = plan_["from"]["line"]
        self.text = plan_["from"]["text"]
        # Execution is borrowed for the parts that are identical. Its `from` and
        # `to` carry the SAME image, which is the honest statement of what a
        # config job does and is also load-bearing: canaries.Ctx.expected_tag()
        # then reads that tag in every phase, so Grafana's /api/health canary
        # asserts the version did NOT move - a property an image job cannot state
        # and this one must.
        tag = _tag_of(plan_["image"])
        side = {"image": plan_["image"], "imageId": plan_["imageId"], "digest": None,
                "version": tag, "tag": tag, "container": plan_["container"]}
        self.ex = Execution(cfg, rec, comp, {
            **plan_, "from": side, "to": dict(side),
            # `commit` belongs in the pin dict as well as at the top level, because
            # Execution.snapshot writes it into the snapshot's pin.json by that
            # path. Without it the snapshot step died with KeyError and the job
            # aborted - having touched nothing, which is the right way to fail, but
            # for a reason that was a missing key rather than anything about the box.
            "pin": {"file": self.file, "service": self.service, "line": self.line,
                    "text": self.text, "commit": plan_["commit"]},
            "pins": [],
        })
        self.edited = False
        self.dir = ""

    # ── the job ──
    def go(self) -> str:
        try:
            self.step("preflight", self.preflight)
        except Refuse as e:
            return self.rec.finish("refused", str(e))["state"]
        try:
            self.step("snapshot", self.snapshot)
        except StepError as e:
            return self.rec.finish("aborted", f"{e} - nothing running was changed and the file is "
                                              "untouched")["state"]
        try:
            self.step("edit", self.edit)
        except StepError as e:
            # The splice itself refused, or the line had moved. The file is
            # unchanged (composeenv.write writes atomically or not at all) and so
            # is the container, so this is `aborted` like a failed pull - not a
            # rollback, because there is nothing to roll back.
            return self.rec.finish("aborted", f"{e} - the file was not written and nothing was "
                                              "restarted")["state"]
        try:
            self.step("apply", self.apply)
            self.step("verify", self.verify)
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
        except Exception as e:  # noqa: BLE001 - a bug must still end in a record and a revert
            self.rec.step(name, "failed", f"{type(e).__name__}: {e}")
            raise StepError(f"{name}: {type(e).__name__}: {e}") from None
        self.rec.step(name, "ok", out if isinstance(out, str) else None)
        return out

    # ── pre-flight: Execution's, plus the file's cleanliness and the scope ──
    def preflight(self) -> str:
        notes = [self.ex._backups(), self._disk(), self._health(), self._clean(), self._scope(),
                 self.ex._baseline()]
        return "; ".join(n for n in notes if n)

    def _disk(self) -> str:
        # Execution._disk sizes against the image it is about to pull; nothing is
        # pulled here, so the budget is the snapshot's alone.
        need = max(2 * int(self.ex.klass.estimate(self.cfg, self.comp.id) or 0), self.cfg.min_free_bytes)
        for where in (self.cfg.backups, hostio.docker_root()):
            free = hostio.free_bytes(where)
            if free is not None and free < need:
                raise Refuse(f"{free >> 20} MiB free under {where}, the change needs {need >> 20} MiB")
        return f"disk: {need >> 20} MiB needed, available"

    def _health(self) -> str:
        c = hostio.container(self.plan["container"])
        if not c or c["state"] != "running":
            raise Refuse(f"{self.plan['container']} is not running")
        if c["health"] not in (None, "healthy"):
            raise Refuse(f"{self.plan['container']} is {c['health']} - fix it before changing its "
                         "configuration")
        return f"{self.plan['container']} {c['health'] or 'running'}"

    def _clean(self) -> str:
        """The file still reads what the plan recorded, and git agrees it is clean.

        Both, not either. The line check catches an edit to THIS value; git
        catches an edit anywhere else in the file - which matters because a
        revert re-runs the recipe, and a recipe over a file somebody is halfway
        through editing deploys their half-finished work.
        """
        rc, dirty = hostio.git(self.cfg.repo, "status", "--porcelain", "--", self.file)
        if rc != 0 or dirty:
            raise Refuse(f"{self.file} has uncommitted changes ({dirty.strip()[:80]}) - the value this "
                         "would put back is not the one `main` declares. Commit or revert them first")
        try:
            with open(os.path.join(self.cfg.repo, self.file), encoding="utf-8") as fh:
                now = composeenv.locate(fh.read(), self.service, self.key, self.file)
        except (OSError, composeenv.Refused) as e:
            raise Refuse(str(e)) from None
        if (now.line, now.text, now.value) != (self.line, self.text, self.old):
            raise Refuse(f"{self.file}:{self.line} no longer reads what the plan recorded - "
                         "reload and look again")
        return f"{self.file} clean, {self.key} still {self.old}"

    def _scope(self) -> str:
        return compose_scope(self.cfg, self.plan["container"], self.file, self.service,
                             {self.service}, self.comp.apply,
                             instead="apply that first - a configuration change carries one service, so "
                                     "it will not drag another's pending change along")

    # ── snapshot: the class's own, into a config-<component> directory ──
    def snapshot(self) -> str:
        out = self.ex.snapshot()
        self.dir = self.rec.job.get("snapshot") or ""
        if self.dir:
            # The old value on disk, 600, beside the class's own artefact - so the
            # value this job would put back survives the process that is holding
            # it in memory. The revert does not READ this file (it holds the value
            # it was given); it is here for the person who arrives after the one
            # outcome the revert cannot fix.
            hostio.write_json(os.path.join(self.dir, "config.json"), {
                "file": self.file, "service": self.service, "key": self.key,
                "line": self.line, "lineAtHead": self.text, "commit": self.plan["commit"],
                "oldValue": self.old, "newValue": self.value, "planId": self.plan["id"]})
        return out

    # ── edit: the one span, spliced and verified ──
    def edit(self) -> str:
        try:
            _, line = composeenv.write(self.cfg.repo, self.file, self.service, self.key,
                                       self.text, self.old, self.value)
        except (composeenv.Refused, OSError) as e:
            raise StepError(f"the value could not be written: {e}") from None
        self.edited = True
        return f"{self.file}:{self.line} now reads {line.strip()}"

    # ── apply: the component's own recipe, unchanged ──
    def apply(self) -> str:
        self.ex._recipe()
        return f"`{self.comp.apply}` done"

    # ── verify: health and every canary - the canary window ──
    def verify(self) -> str:
        imid = (hostio.container(self.plan["container"]) or {}).get("imageId") or ""
        ok, detail, _ = self.ex.check(imid, "verify")
        if not ok:
            raise StepError(detail)
        return detail

    # ── the revert: the old value back, the recipe again, and verify again ──
    def rollback(self, cause: Exception) -> str:
        self.rec.step("rollback", "running", f"because {cause}")
        if not self.edited:
            self.rec.step("rollback", "ok", "the file was never written - nothing to put back")
            return self.rec.finish("rolled_back", str(cause), note=self._note_back(False))["state"]
        try:
            # The strictness anchor for the way BACK is the line this job itself
            # wrote, not the line the plan recorded - the two differ by exactly
            # the value, and asserting the wrong one would make every revert
            # refuse. `edit` proved the file reads it.
            composeenv.write(self.cfg.repo, self.file, self.service, self.key,
                             self._line_now(), self.value, self.old)
            self.ex._recipe()
        except (composeenv.Refused, HostError, StepError, OSError) as e:
            self.rec.step("rollback", "failed", str(e))
            return self.rec.finish("failed", f"{cause}; and putting {self.key} back failed: {e}",
                                   note=self._note_stuck(e))["state"]
        imid = (hostio.container(self.plan["container"]) or {}).get("imageId") or ""
        ok, detail, _ = self.ex.check(imid, "rollback")
        if ok:
            self.rec.step("rollback", "ok", f"{self.key} is back to {self.old}: {detail}")
            return self.rec.finish("rolled_back", str(cause), note=self._note_back(True))["state"]
        # NO DATA RESTORE, and this is the branch that says so. An image job would
        # consider one here; a config job never does - the image never changed, so
        # nothing migrated the data, and a restore would discard everything written
        # since the snapshot to fix something the data is not the cause of.
        self.rec.step("rollback", "failed", detail)
        return self.rec.finish("failed", f"{cause}; the old value is back and {detail}",
                               note=self._note_unhealthy(detail))["state"]

    def _line_now(self) -> str:
        with open(os.path.join(self.cfg.repo, self.file), encoding="utf-8") as fh:
            lines = fh.read().split("\n")
        return lines[self.line - 1] if 0 < self.line <= len(lines) else ""

    # ── the words a person reads afterwards ──
    def _note_ok(self) -> str:
        reach = [c for c in self.plan.get("pinnedIn") or [] if c != self.comp.id]
        return (f"{self.file}:{self.line} now sets {self.key} to {self.value} LOCALLY (uncommitted, on "
                f"purpose - `git diff {self.file}` is the whole change), and {self.plan['container']} "
                f"runs it. COMMIT IT: until that file is clean the updater refuses an image plan for "
                f"every component pinned in it"
                + (f" ({', '.join(reach)} as well as {self.comp.id})" if reach else "")
                + f". Snapshot: {self.dir}")[:800]

    def _note_back(self, written: bool) -> str:
        s = (f"{self.key} is back to {self.old} and {self.plan['container']} is healthy on it. "
             f"{self.file} is clean again, so nothing is pending and image updates for it are not "
             f"blocked.") if written else \
            (f"{self.file} was never written, so there is nothing to put back and the tree is clean.")
        return (s + f" The value {self.value} did not hold: read the verify step's detail above before "
                    f"asking for it again.")[:800]

    def _note_stuck(self, e: Exception) -> str:
        return (f"{self.file}:{self.line} may still read {self.value} - putting {self.old} back FAILED "
                f"({e}). A person is needed: `git diff {self.file}`, then `git checkout -- {self.file}` "
                f"and `{self.comp.apply}`. No data was restored; the snapshot is {self.dir}.")[:800]

    def _note_unhealthy(self, detail: str) -> str:
        return (f"{self.key} is back to {self.old} and {self.file} is clean, but "
                f"{self.plan['container']} is still not healthy ({detail}), so the value was not the "
                f"cause. No data was restored - the image never changed, so nothing migrated it. The "
                f"snapshot is {self.dir} if you decide you want it.")[:800]
