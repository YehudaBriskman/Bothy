"""Plans: "this container runs W; main pins X; here is exactly what deploying X does".

A plan is computed ON THE HOST from four things only, none of them a request:

  updates.toml         the component, its class, pin, recipe and dependants
  the checkout         the pin line on `main` (which must be clean and merged)
  docker inspect       what the container runs now
  available.json       discovery's digest for the pinned tag

and it gets an id that is a hash of everything that decides what would happen.
Discovery pre-computes one per component (discover_updates.py -> write_all), so
bothy-ops only ever READS plans; the executor recomputes the plan when it runs
and refuses unless the id is the same. A request therefore names a plan the host
wrote, and a plan that went stale - main moved, the container changed,
discovery saw a different digest - cannot be executed under its old id.

    plan(component, target=None)   -> dict, or raises PlanRefused(reason)

`target`, when given, must be what main pins: the updater never deploys a version
main does not pin (docs/plans/updates.md "Decisions", step 4).
"""

from __future__ import annotations

import hashlib
import json
import os
import re

import updates
from discover_updates import same_image, split_image

from . import classes, hostio, pins, canaries
from .config import Config
from .hostio import HostError, git, iso

PLAN_VERSION = 1
PLAN_ID = re.compile(r"[a-f0-9]{24}")


class PlanRefused(Exception):
    """No plan for this component, and why - written for the Settings page."""


def load_available(cfg: Config) -> dict:
    try:
        doc = hostio.read_json(cfg.available)
    except FileNotFoundError:
        raise PlanRefused("nothing discovered yet - run `just updates-discover`") from None
    except (OSError, ValueError, HostError) as e:
        raise PlanRefused(f"available.json could not be read ({type(e).__name__})") from None
    if not isinstance(doc, dict) or doc.get("version") != 1 or not isinstance(doc.get("components"), dict):
        raise PlanRefused("available.json has an unknown shape - run `just updates-discover`")
    return doc


def _home(p: str) -> str:
    h = os.path.expanduser("~")
    return "~" + p[len(h):] if p.startswith(h + os.sep) else p


def _git_gate(cfg: Config, rels: list[str]) -> str:
    """HEAD's sha, if the checkout may be deployed from at all."""
    rc, branch = git(cfg.repo, "symbolic-ref", "--quiet", "--short", "HEAD")
    if rc != 0 or branch != "main":
        raise PlanRefused(f"the checkout is on {branch or 'a detached HEAD'!s}, not main - the updater "
                          "deploys only what main pins")
    rc, head = git(cfg.repo, "rev-parse", "HEAD")
    if rc != 0 or not re.fullmatch(r"[0-9a-f]{40}", head):
        raise PlanRefused("git rev-parse HEAD failed")
    for rel in rels:
        rc, dirty = git(cfg.repo, "status", "--porcelain", "--", rel)
        if rc != 0 or dirty:
            raise PlanRefused(f"{rel} has local changes (a rollback leaves the old pin there on purpose) - "
                              f"look at `git diff {rel}`, then `git checkout -- {rel}` to deploy what main pins")
    rc, _ = git(cfg.repo, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main")
    if rc != 0:
        raise PlanRefused("there is no origin/main to compare the checkout with")
    rc, _ = git(cfg.repo, "merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main")
    if rc != 0:
        raise PlanRefused("HEAD has commits that are not on origin/main - the updater deploys only what "
                          "main pins, reviewed and merged")
    return head


def _same_image_everywhere(all_pins: list) -> None:
    """A component with several pin lines (Keycloak: keycloak and keycloak-init
    share one image) moves ALL of them, to ONE image. So every line must name
    exactly the same repository, tag and digest - a Dependabot PR that bumped
    one line and not the other is refused, in words, rather than half-deployed.
    """
    first = all_pins[0]
    want = split_image(first.value)
    for pl in all_pins[1:]:
        got = split_image(pl.value)
        if (got["ref"], got["tag"], got["digest"]) != (want["ref"], want["tag"], want["digest"]):
            raise PlanRefused(f"the pins disagree: {first.file}:{first.line} ({first.service}) pins {first.value}, "
                              f"{pl.file}:{pl.line} ({pl.service}) pins {pl.value} - every pin of this component "
                              "must name the same tag@digest; fix main first")


def _material_id(material: dict) -> str:
    return hashlib.sha256(json.dumps(material, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:24]


def plan(component: str, target: str | None = None, *, cfg: Config | None = None,
         catalog: updates.Catalog | None = None, available: dict | None = None) -> dict:
    cfg = cfg or Config()
    try:
        catalog = catalog or updates.load(cfg.catalog)
    except (updates.CatalogError, OSError, ValueError) as e:
        raise PlanRefused(f"updates.toml is invalid: {e}") from None
    comp = catalog.components.get(component)
    if comp is None:
        raise PlanRefused(f"{component!r} is not in updates.toml")
    klass = classes.get(comp.cls, comp.id)
    if klass is None:
        raise PlanRefused(f"class {comp.cls} is not handled by the updater yet (it handles stateless, "
                          f"timeseries and app-db) - update it by hand: merge its pin, then `{comp.apply}`")
    if comp.source != "image" or not comp.pins:
        raise PlanRefused("the updater handles compose image pins only")
    parts = [comp.pin_parts(i) for i in range(len(comp.pins))]
    rel, service = parts[0]

    head = _git_gate(cfg, sorted({f for f, _ in parts}))
    try:
        all_pins = [pins.locate(cfg.repo, f, s or "") for f, s in parts]
    except HostError as e:
        raise PlanRefused(str(e)) from None
    pin = all_pins[0]
    for pl in all_pins:
        if not pl.container:
            raise PlanRefused(f"{pl.file}:{pl.service} has no container_name - the updater addresses containers "
                              "by name")
    _same_image_everywhere(all_pins)
    to = split_image(pin.value)
    to_v = updates.parse_version(to["tag"]) if to["tag"] else None
    if not to_v or len(to_v.parts) < 3:
        raise PlanRefused(f"{rel} pins {pin.value}, a floating tag - pin an exact version first "
                          "(docs/plans/updates.md step 1)")

    available = available if available is not None else load_available(cfg)
    e = available["components"].get(comp.id)
    if not isinstance(e, dict):
        raise PlanRefused("not discovered yet - run `just updates-discover`")
    cur = e.get("current") if isinstance(e.get("current"), dict) else {}
    if e.get("image") != to["ref"] or cur.get("tag") != to["tag"]:
        raise PlanRefused(f"discovery is older than the checkout (it saw {e.get('image')}:{cur.get('tag')}, "
                          f"{rel} pins {pin.value}) - run `just updates-discover`")
    if cur.get("float"):
        raise PlanRefused(f"{pin.value} is a floating pin - pin an exact version first")
    to_digest = to["digest"] or cur.get("resolved")
    if to["digest"] and cur.get("digest") and cur["digest"] != to["digest"]:
        raise PlanRefused("discovery recorded a different digest than the pin carries - run `just updates-discover`")

    run = hostio.container(pin.container)
    if run is None or run.get("state") != "running":
        raise PlanRefused(f"{pin.container} is not running - start it with `{comp.apply}` first; the updater "
                          "only replaces a running, healthy container")
    if not run.get("image") or not run.get("imageId"):
        raise PlanRefused(f"docker inspect {pin.container} did not say what it runs")
    frm = split_image(run["image"])
    old_img = hostio.image(run["imageId"])
    from_digest = frm["digest"] or hostio.repo_digest(old_img, frm["ref"])
    if same_image(run["image"], pin.value):
        if from_digest == to_digest or None in (from_digest, to_digest):
            raise PlanRefused(f"nothing to deploy: {pin.container} runs what main pins ({pin.value})")
        raise PlanRefused(f"{pin.value} now names a different image than the one running (re-published "
                          "upstream) - the updater does not chase a moving tag; do it by hand")
    if not isinstance(to_digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", to_digest):
        why = f": {e['error']}" if e.get("error") else ""
        raise PlanRefused(f"the digest of {pin.value} is unknown - discovery could not resolve it{why}")
    if frm["ref"] != to["ref"]:
        raise PlanRefused(f"{pin.container} runs {frm['ref']}, main pins {to['ref']} - a different image, "
                          "not an update; do it by hand")
    from_v = updates.parse_version(frm["tag"]) if frm["tag"] else None
    level = updates.classify(from_v, to_v) if from_v else None
    if from_v is None or (from_v.shape != to_v.shape):
        raise PlanRefused(f"{pin.container} runs {run['image']}, which cannot be compared with {pin.value}")
    if level is None:
        raise PlanRefused(f"{pin.value} is not newer than what runs ({run['image']}) - a downgrade is done by hand")
    if level == "major":
        raise PlanRefused(f"a major ({from_v.text} -> {to_v.text}) is a manual procedure")
    if target is not None and target not in (to["tag"], pin.value):
        raise PlanRefused(f"{target} is not what main pins ({pin.value}) - the updater deploys only what main "
                          "pins; merge its Dependabot PR and pull the checkout first")

    restarts = list(dict.fromkeys([*(pl.container for pl in all_pins), *comp.dependants]))
    material = {
        "v": PLAN_VERSION, "component": comp.id, "class": comp.cls, "container": pin.container,
        "from": {"image": run["image"], "imageId": run["imageId"], "digest": from_digest},
        "to": {"image": pin.value, "digest": to_digest},
        "pin": {"file": rel, "service": service, "line": pin.line, "text": pin.text, "commit": head},
        "recipe": comp.apply,
    }
    pin_list = [{"file": pl.file, "service": pl.service, "line": pl.line, "text": pl.text,
                 "container": pl.container} for pl in all_pins]
    if len(all_pins) > 1:
        # Only when there is more than one, so a single-pin plan keeps the id it
        # had before multi-pin components existed.
        material["pins"] = pin_list
    kinds = klass.backup_kinds(comp.id)
    cs = canaries.for_component(cfg, comp.id)
    return {
        **material,
        "id": _material_id(material),
        "title": comp.title,
        "createdAt": iso(),
        "discoveredAt": available.get("generatedAt"),
        "level": level,
        "confirm": "type-name" if (comp.one_way or level == "major") else "click",
        "from": {**material["from"], "tag": frm["tag"], "version": from_v.text, "container": pin.container},
        "to": {**material["to"], "tag": to["tag"], "version": to_v.text},
        "changelog": updates.changelog_url(comp.changelog, to_v.text),
        "oneWay": comp.one_way, "oneWayWhy": comp.one_way_why,
        "restarts": restarts,
        "downtime": klass.downtime(cfg, comp.id),
        "signedOut": klass.signed_out(cfg, comp.id),
        "snapshot": {"kind": klass.snapshot_kind(comp.id), "what": klass.snapshot_words(comp.id),
                     "dir": _home(os.path.join(cfg.snapshots, f"<time>-{comp.id}")) + "/",
                     "estimateBytes": klass.estimate(cfg, comp.id)},
        "preflight": [
            "the plan is still current: recomputed from main, the running container and discovery, it has this id",
            "free disk: at least twice (the image + the snapshot) on the backup disk and on Docker's",
            f"{pin.container} is running and healthy, and its canaries pass NOW - an update is never verified "
            "against a component that was already broken",
            f"`{comp.apply}` would recreate {' and '.join(pl.container for pl in all_pins)} and nothing else in "
            "its compose project (compose config hashes), so no other pending change rides along",
            f"the newest backup in ~/backups/{{{','.join(kinds)}}} is under 24 h old",
            "no other update is running (one global lock)",
        ],
        "verify": [f"{pin.container} runs the pulled image and is healthy", *(c.describe for c in cs)],
        # Every pin line the plan moves (and a rollback writes back) - one for
        # most components, two for Keycloak. `pin` above is the first of them.
        "pins": pin_list,
        "rollback": klass.rollback,
    }


def _plan_file(cfg: Config, cid: str) -> str:
    return os.path.join(cfg.plans, f"{cid}.json")


def write_all(cfg: Config | None = None, catalog: updates.Catalog | None = None,
              available: dict | None = None) -> dict[str, str]:
    """One file per component: its current plan, or why there is none.

    plans/<component>.json - keyed by COMPONENT, not by plan id, so the current
    plan is one file and a stale one cannot linger beside it. Mode 600 in a 700
    directory; bothy-ops reads them through its read-only mount of the state dir.
    """
    cfg = cfg or Config()
    catalog = catalog or updates.load(cfg.catalog)
    hostio.ensure_dir(cfg.state, 0o700)
    hostio.ensure_dir(cfg.plans, 0o700)
    try:
        available = available if available is not None else load_available(cfg)
    except PlanRefused:
        available = None
    out: dict[str, str] = {}
    for cid in catalog.components:
        try:
            if available is None:
                raise PlanRefused("nothing discovered yet - run `just updates-discover`")
            p = plan(cid, cfg=cfg, catalog=catalog, available=available)
            doc = {"version": PLAN_VERSION, "component": cid, "ok": True, "plan": p}
            out[cid] = p["id"]
        except PlanRefused as e:
            doc = {"version": PLAN_VERSION, "component": cid, "ok": False, "reason": str(e)[:300],
                   "createdAt": iso(), "discoveredAt": (available or {}).get("generatedAt")}
            out[cid] = f"- {e}"
        hostio.write_json(_plan_file(cfg, cid), doc)
    for fn in os.listdir(cfg.plans):
        if fn.endswith(".json") and fn[:-5] not in catalog.components:
            os.unlink(os.path.join(cfg.plans, fn))
    return out


def read_plan(cfg: Config, cid: str) -> dict | None:
    try:
        doc = hostio.read_json(_plan_file(cfg, cid), 256 * 1024)
    except (OSError, ValueError, HostError):
        return None
    return doc if isinstance(doc, dict) else None
