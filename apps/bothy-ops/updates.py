"""Updates - the catalog, the reads that serve it, and the one request.

    GET  /updates/status     the catalog (updates.toml) merged with what the host
                             last discovered (available.json), the running or
                             last job, and the history - viewer
    GET  /updates/plan       ?component=  the plan the HOST wrote for it - viewer
    GET  /updates/job        ?id=  one job: queued, running or finished - viewer
    POST /updates/request    {component, plan_id, confirm[, note]} - operator. Writes ONE
                             file into the spool and answers 202. Runs nothing.
    POST /updates/unpause    {component} - operator. Writes ONE unpause file into
                             the spool (step 7); the host clears the pause.
    POST /updates/discover   {} - operator. Writes ONE discover file into the
                             spool; the HOST runs discovery (read-only, rate-limited).
    POST /updates/autorun    {dry_run} - operator. Writes ONE autorun file into the
                             spool; the HOST's night job decides, under all its gates.

Build steps 3 and 4 of docs/plans/updates.md. This process never pulls, never
edits a pin and never restarts anything for an update: the host executor
(apps/bothy-ops/updater, bothy-updater.path + .service) does, after checking
every field of the spool file again for itself. What this process CAN do is
bounded by what that executor accepts - see SECURITY.md rule 8.

── two halves, two processes ─────────────────────────────────────────────────

  load_catalog()      the strict parser for updates.toml. Used HERE, where a
                      malformed catalog refuses the start of bothy-ops, and by
                      discover_updates.py ON THE HOST, which must not trust a
                      catalog bothy-ops would refuse.
  status()/handle()   bothy-ops only. Reads available.json from a READ-ONLY
                      mount of ~/.local/state/bothy/updates and re-filters every
                      field to an allow-list, the admin.py "second lock": the host
                      writer is trusted to be right, not to be the only check.

Registry calls, docker inspect and git are the host's job (discover_updates.py,
updater/plans.py); this process holds none of the credentials or sockets that
would take, and it must not grow a network path to the internet for a page to be
drawn. Its only read-write mounts are its audit dir and the spool.

── the policy lives in code, not in the catalog ──────────────────────────────

What a channel MEANS is effective_channel(): `auto` is patch-only, a minor of an
auto component is `notify`, and a major of anything is `manual`. Which classes may
be `auto` at all is AUTO_CLASSES. The catalog chooses among those; it cannot widen
them. (Decisions approved 2026-09-18, docs/plans/updates.md.)

Standard library plus bothy_common, like the rest of bothy-ops.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import sys
import time
import tomllib
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
try:
    import bothy_common  # noqa: F401  (in the image it sits beside this file)
except ImportError:  # a checkout, or the host-side discoverer
    sys.path.insert(0, os.path.join(os.path.dirname(HERE), "bothy-common"))

from bothy_common.audit import AuditLog, flat  # noqa: E402
from bothy_common.http import Refused  # noqa: E402

CATALOG_FILE = os.environ.get("UPDATES_CATALOG", os.path.join(HERE, "updates.toml"))
AVAILABLE_FILE = os.environ.get("UPDATES_AVAILABLE", "/updates/available.json")
MAX_AVAILABLE_BYTES = 2 * 1024 * 1024

# The admin reads' log: this is a Settings read too, and one more file to parse
# would be one more shape for the audit viewer to guess at.
LOG = AuditLog(os.environ.get("ADMIN_AUDIT_LOG", "/audit/admin.log"))

CHANNELS = ("auto", "notify", "manual")
LEVELS = ("patch", "minor", "major")
SOURCES = ("image", "manifest", "helm", "github")
# class -> the sources it may use. A cluster add-on is a chart or a manifest; our
# own code comes from our own release tags; everything else is an image.
CLASSES: dict[str, tuple[str, ...]] = {
    "stateless": ("image",),
    "boundary": ("image",),
    "edge": ("image",),
    "timeseries": ("image",),
    "app-db": ("image",),
    "database": ("image",),
    "own-code": ("github",),
    "cluster": ("helm", "manifest"),
}
# The only classes an `auto` channel is legal on. Widening this is a reviewed
# code change (docs/plans/updates.md "Decisions": Traefik is revisited after a
# month, and only once it is digest-pinned).
AUTO_CLASSES = frozenset({"stateless", "timeseries"})

_COMMON = {"title", "class", "source", "pins", "apply", "dependants", "changelog", "channel",
           "one_way", "verify"}
_SOURCE_KEYS = {
    "image": set(),
    "manifest": {"workload"},
    "helm": {"chart", "chart_repo", "release"},
    "github": {"repo"},
}
_POLICY_KEYS = {"window_start", "window_end", "require_backup", "require_doctor",
                "max_auto_per_night", "pause_on_failure", "discover_every_hours"}

_ID = re.compile(r"[a-z][a-z0-9-]{0,39}")
_REL = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}")
_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,62}")
_SHELLVAR = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
_APPLY = re.compile(r"just [a-z][a-z0-9-]*")
_HHMM = re.compile(r"(?:[01]\d|2[0-3]):[0-5]\d")
_REPO = re.compile(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}")
_WORKLOAD = re.compile(r"[a-z0-9-]{1,63}/(?:daemonset|deployment|statefulset)/[a-z0-9-]{1,63}")
_RELEASE = re.compile(r"[a-z0-9-]{1,63}/[a-z0-9-]{1,53}")
_DIGEST = re.compile(r"sha256:[a-f0-9]{64}")


class CatalogError(Exception):
    """updates.toml is malformed. Raised at startup; bothy-ops does not start."""


@dataclass(frozen=True)
class Component:
    id: str
    title: str
    cls: str
    source: str
    pins: tuple[str, ...]
    apply: str
    dependants: tuple[str, ...]
    changelog: str
    channel: str
    one_way: bool
    one_way_why: str | None
    verify: tuple[str, ...]
    repo: str | None = None
    chart: str | None = None
    chart_repo: str | None = None
    release: str | None = None
    workload: str | None = None

    def pin_parts(self, i: int = 0) -> tuple[str, str | None]:
        """(file, name) of pin i; name is None for a github VERSION file."""
        f, sep, n = self.pins[i].partition(":")
        return f, (n if sep else None)


@dataclass(frozen=True)
class Policy:
    window_start: str
    window_end: str
    require_backup: str
    require_doctor: bool
    max_auto_per_night: int
    pause_on_failure: bool
    discover_every_hours: int


@dataclass(frozen=True)
class Catalog:
    components: dict[str, Component]
    policy: Policy


def _strs(where: str, v: object, *, empty_ok: bool) -> tuple[str, ...]:
    if not isinstance(v, list) or not all(isinstance(x, str) and x.strip() for x in v):
        raise CatalogError(f"{where} must be a list of non-empty strings")
    if not v and not empty_ok:
        raise CatalogError(f"{where} must not be empty")
    if len(set(v)) != len(v):
        raise CatalogError(f"{where} lists something twice")
    return tuple(v)


def _pin(where: str, source: str, pin: str) -> None:
    f, sep, name = pin.partition(":")
    if not _REL.fullmatch(f) or ".." in f.split("/") or f.startswith("/"):
        raise CatalogError(f"{where}: {pin!r} - the file must be a plain repo-relative path")
    if source == "github":
        if sep:
            raise CatalogError(f"{where}: a github pin is a file holding the version, with no ':'")
        return
    if not sep:
        raise CatalogError(f"{where}: {pin!r} must be <file>:<name>")
    if source == "helm":
        if f.endswith("Chart.yaml"):
            if not _NAME.fullmatch(name):
                raise CatalogError(f"{where}: {name!r} is not a chart dependency name")
        elif not _SHELLVAR.fullmatch(name):
            raise CatalogError(f"{where}: {name!r} is not a SHELL_VARIABLE name")
    elif not _NAME.fullmatch(name):
        raise CatalogError(f"{where}: {name!r} is not a service or container name")


def _policy(raw: object) -> Policy:
    if not isinstance(raw, dict) or set(raw) != _POLICY_KEYS:
        got = set(raw) if isinstance(raw, dict) else set()
        raise CatalogError(f"[policy] needs exactly {sorted(_POLICY_KEYS)} "
                           f"(missing {sorted(_POLICY_KEYS - got)}, unknown {sorted(got - _POLICY_KEYS)})")
    for k in ("window_start", "window_end"):
        if not isinstance(raw[k], str) or not _HHMM.fullmatch(raw[k]):
            raise CatalogError(f"[policy] {k} must be HH:MM")
    if raw["window_start"] >= raw["window_end"]:
        raise CatalogError("[policy] the window must start before it ends, inside one night")
    if not isinstance(raw["require_backup"], str) or not re.fullmatch(r"[a-z0-9-]+\.service", raw["require_backup"]):
        raise CatalogError("[policy] require_backup must name a .service unit")
    for k in ("require_doctor", "pause_on_failure"):
        if raw[k] is not True:
            # Not a preference: both are the approved safety rules, and a catalog
            # that turned one off would be a policy change nobody reviewed.
            raise CatalogError(f"[policy] {k} must be true")
    n = raw["max_auto_per_night"]
    if not isinstance(n, int) or isinstance(n, bool) or not 0 <= n <= 1:
        raise CatalogError("[policy] max_auto_per_night must be 0 or 1")
    h = raw["discover_every_hours"]
    if not isinstance(h, int) or isinstance(h, bool) or not 1 <= h <= 24:
        raise CatalogError("[policy] discover_every_hours must be 1..24")
    return Policy(raw["window_start"], raw["window_end"], raw["require_backup"], True, n, True, h)


def load_catalog(doc: object) -> Catalog:
    """Parse and validate updates.toml (the result of tomllib.load). No defaults."""
    if not isinstance(doc, dict) or set(doc) != {"policy", "components"}:
        raise CatalogError("updates.toml must hold exactly [policy] and [components.<id>]")
    policy = _policy(doc["policy"])
    comps_raw = doc["components"]
    if not isinstance(comps_raw, dict) or not comps_raw:
        raise CatalogError("updates.toml declares no components")
    comps: dict[str, Component] = {}
    for cid, raw in comps_raw.items():
        where = f"[components.{cid}]"
        if not _ID.fullmatch(cid):
            raise CatalogError(f"{where}: id must be lowercase letters, digits and '-'")
        if not isinstance(raw, dict):
            raise CatalogError(f"{where}: must be a table")
        source = raw.get("source")
        if source not in SOURCES:
            raise CatalogError(f"{where}: source must be one of {SOURCES}")
        want = _COMMON | _SOURCE_KEYS[source] | ({"one_way_why"} if raw.get("one_way") is True else set())
        unknown = set(raw) - want
        if unknown:
            raise CatalogError(f"{where}: unknown keys {sorted(unknown)}")
        missing = want - set(raw)
        if missing:
            raise CatalogError(f"{where}: {sorted(missing)} required (no defaults here)")
        cls = raw["class"]
        if cls not in CLASSES:
            raise CatalogError(f"{where}: class must be one of {tuple(CLASSES)}")
        if source not in CLASSES[cls]:
            raise CatalogError(f"{where}: class {cls} takes source {CLASSES[cls]}, not {source}")
        channel = raw["channel"]
        if channel not in CHANNELS:
            raise CatalogError(f"{where}: channel must be one of {CHANNELS}, not {channel!r}")
        if not isinstance(raw["one_way"], bool):
            raise CatalogError(f"{where}: one_way must be true or false")
        if channel == "auto":
            if raw["one_way"]:
                raise CatalogError(f"{where}: a one-way component may never be `auto` - "
                                   "its rollback is a restore, which no night job may choose on its own")
            if cls == "boundary":
                raise CatalogError(f"{where}: the auth boundary may never be `auto` "
                                   "(dependabot.yml reviews these by hand for the same reason)")
            if cls not in AUTO_CLASSES:
                raise CatalogError(f"{where}: class {cls} may not be `auto`; only {sorted(AUTO_CLASSES)} may")
        why = raw.get("one_way_why")
        if raw["one_way"] and (not isinstance(why, str) or len(why.strip()) < 20):
            raise CatalogError(f"{where}: one_way_why must say, in a sentence, what cannot be undone")
        for k in ("title", "apply", "changelog"):
            if not isinstance(raw[k], str) or not raw[k].strip():
                raise CatalogError(f"{where}: {k} must be a non-empty string")
        if not _APPLY.fullmatch(raw["apply"]):
            raise CatalogError(f"{where}: apply must be `just <recipe>`")
        cl = raw["changelog"]
        if not cl.startswith("https://") or re.search(r"\s", cl) or \
                re.sub(r"\{version\}", "", cl).count("{") or re.sub(r"\{version\}", "", cl).count("}"):
            raise CatalogError(f"{where}: changelog must be an https URL whose only placeholder is {{version}}")
        pins = _strs(f"{where} pins", raw["pins"], empty_ok=False)
        for p in pins:
            _pin(where, source, p)
        if source in ("helm", "github", "manifest") and len(pins) != 1:
            raise CatalogError(f"{where}: a {source} component has exactly one pin")
        extra: dict[str, str] = {}
        for k, rx in (("repo", _REPO), ("chart", _NAME), ("release", _RELEASE), ("workload", _WORKLOAD)):
            if k in raw:
                if not isinstance(raw[k], str) or not rx.fullmatch(raw[k]):
                    raise CatalogError(f"{where}: {k} {raw[k]!r} is malformed")
                extra[k] = raw[k]
        if "chart_repo" in raw:
            if not isinstance(raw["chart_repo"], str) or not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::\d{1,5})?(?:/[A-Za-z0-9._-]+)*/?", raw["chart_repo"]):
                raise CatalogError(f"{where}: chart_repo must be an https URL")
            extra["chart_repo"] = raw["chart_repo"].rstrip("/")
        comps[cid] = Component(
            id=cid, title=raw["title"], cls=cls, source=source, pins=pins, apply=raw["apply"],
            dependants=_strs(f"{where} dependants", raw["dependants"], empty_ok=True),
            changelog=cl, channel=channel, one_way=raw["one_way"],
            one_way_why=why if raw["one_way"] else None,
            verify=_strs(f"{where} verify", raw["verify"], empty_ok=False), **extra)
    return Catalog(comps, policy)


def load(path: str | None = None) -> Catalog:
    with open(path or CATALOG_FILE, "rb") as fh:
        return load_catalog(tomllib.load(fh))


# ══ versions ══════════════════════════════════════════════════════════════════
#
# A tag is a candidate only if it has the SAME SHAPE as the pin: the same `v`
# prefix or none, the same number of numeric parts, and a numeric `-N` build
# revision only if the pin has one (quay's keycloak 26.7.4-0). So `v3.7` is
# compared with `v3.8` and never with `v3.7.1`, `17` never with `17.6-bookworm`,
# and a pre-release (`-rc1`, `-beta`) never has a shape a release pin shares.
# Each number is at most five digits, so a date tag (20240101) is never a major.

_VERSION = re.compile(r"(v?)(\d{1,5}(?:\.\d{1,5}){0,2})(?:-(\d{1,5}))?")


@dataclass(frozen=True, order=True)
class Version:
    parts: tuple[int, ...]
    rev: int
    prefix: str
    has_rev: bool

    @property
    def shape(self) -> tuple[str, int, bool]:
        return (self.prefix, len(self.parts), self.has_rev)

    @property
    def text(self) -> str:
        """The version a changelog names: no `v`, no build revision."""
        return ".".join(str(p) for p in self.parts)


def parse_version(tag: str) -> Version | None:
    m = _VERSION.fullmatch(tag or "")
    if not m:
        return None
    return Version(tuple(int(x) for x in m.group(2).split(".")), int(m.group(3) or 0), m.group(1),
                   m.group(3) is not None)


def classify(current: Version, new: Version) -> str | None:
    """patch | minor | major, or None when `new` is not newer or not comparable."""
    if new.shape != current.shape or (new.parts, new.rev) <= (current.parts, current.rev):
        return None
    if new.parts[0] != current.parts[0]:
        return "major"
    if len(new.parts) > 1 and new.parts[1] != current.parts[1]:
        return "minor"
    return "patch"


def effective_channel(channel: str, level: str | None) -> str | None:
    """What an update at `level` of a component on `channel` gets. None: no update."""
    if level is None:
        return None
    if level == "major" or channel == "manual":
        return "manual"
    if channel == "auto":
        return "auto" if level == "patch" else "notify"
    return "notify"


def changelog_url(template: str, version: str | None) -> str | None:
    if "{version}" not in template:
        return template
    if not version or not re.fullmatch(r"[0-9][0-9A-Za-z.+-]{0,40}", version):
        return None
    return template.replace("{version}", version)


# ══ serving: catalog + available.json, through an allow-list ═════════════════

CATALOG: Catalog | None = None


class UpdatesError(Exception):
    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


def _s(v: object, n: int = 200) -> str | None:
    return v[:n] if isinstance(v, str) else None


def _ver(d: object) -> dict | None:
    """One {tag, version, digest, level?, publishedAt?}, or None. Every field re-checked."""
    if not isinstance(d, dict) or not isinstance(d.get("tag"), str):
        return None
    out = {"tag": d["tag"][:128], "version": _s(d.get("version"), 64),
           "digest": d["digest"] if isinstance(d.get("digest"), str) and _DIGEST.fullmatch(d["digest"]) else None}
    if d.get("level") in LEVELS:
        out["level"] = d["level"]
    if isinstance(d.get("publishedAt"), str):
        out["publishedAt"] = d["publishedAt"][:40]
    if d.get("floating") is True:
        out["floating"] = True  # the pin's own floating tag, moved to a newer image
    return out


def _running(v: object) -> list[dict]:
    if not isinstance(v, list):
        return []
    out = []
    for r in v[:8]:
        if isinstance(r, dict) and isinstance(r.get("name"), str):
            out.append({"name": r["name"][:64], "image": _s(r.get("image"), 255),
                        "digest": r["digest"] if isinstance(r.get("digest"), str) and _DIGEST.fullmatch(r["digest"]) else None,
                        "state": _s(r.get("state"), 32)})
    return out


def _discovered(d: object) -> dict | None:
    if not isinstance(d, dict):
        return None
    cur = d.get("current") if isinstance(d.get("current"), dict) else {}
    cands = d.get("candidates") if isinstance(d.get("candidates"), dict) else {}
    return {
        "checkedAt": _s(d.get("checkedAt"), 40),
        "error": _s(d.get("error"), 300),
        "image": _s(d.get("image"), 255),
        "current": {"tag": _s(cur.get("tag"), 128), "version": _s(cur.get("version"), 64),
                    "digest": cur["digest"] if isinstance(cur.get("digest"), str) and _DIGEST.fullmatch(cur["digest"]) else None,
                    "float": cur.get("float") is True,
                    # A floating tag's current release, and a digest pin's release.
                    "floatTarget": _s(cur.get("floatTarget"), 128),
                    "identifiedAs": _s(cur.get("identifiedAs"), 128)},
        "running": _running(d.get("running")),
        "runningVersion": _s(d.get("runningVersion"), 64),
        "drift": _s(d.get("drift"), 300),
        "notes": [n[:200] for n in d["notes"][:5] if isinstance(n, str)] if isinstance(d.get("notes"), list) else [],
        "floatMoved": d.get("floatMoved") if isinstance(d.get("floatMoved"), bool) else None,
        "latest": _ver(d.get("latest")),
        "candidates": {lv: _ver(cands.get(lv)) for lv in LEVELS if _ver(cands.get(lv))},
    }


def _available() -> tuple[dict | None, dict]:
    try:
        st = os.stat(AVAILABLE_FILE)
        if st.st_size > MAX_AVAILABLE_BYTES:
            raise UpdatesError("available.json is implausibly large - refusing to serve it")
        with open(AVAILABLE_FILE, encoding="utf-8") as fh:
            doc = json.load(fh)
    except FileNotFoundError:
        return None, {"present": False, "generatedAt": None, "ageSeconds": None, "stale": True,
                      "hint": "Nothing discovered yet - run `just updates-discover` on the host "
                              "(host/systemd/bothy-updates-discover.timer keeps it fresh)."}
    except (OSError, ValueError) as e:
        raise UpdatesError(f"available.json could not be read ({type(e).__name__})") from None
    if not isinstance(doc, dict) or doc.get("version") != 1 or not isinstance(doc.get("components"), dict):
        raise UpdatesError("available.json has an unknown shape - run `just updates-discover`")
    age = max(0, int(time.time() - st.st_mtime))
    every = CATALOG.policy.discover_every_hours if CATALOG else 6
    return doc, {"present": True, "generatedAt": _s(doc.get("generatedAt"), 40), "ageSeconds": age,
                 # Two missed runs, and an hour of grace for a slow one.
                 "stale": age > (2 * every + 1) * 3600, "hint": None}


def _changelog(c: Component, disc: dict | None) -> str:
    """The notes for the version on offer, else for the running pin, else the list."""
    for v in ((disc or {}).get("latest") or {}).get("version"), ((disc or {}).get("current") or {}).get("version"):
        url = changelog_url(c.changelog, v)
        if url:
            return url
    base = c.changelog.split("{version}")[0]
    base = base[:base.rfind("/") + 1]
    return base[:-len("tag/")] if base.endswith("/tag/") else base


# ══ groups: apply a whole `apply` recipe at once ═════════════════════════════
#
# A compose recipe is one `docker compose up`, so the host refuses to apply ONE
# component while another service of the same project also has a merged pin
# waiting - it would drag that one's migration along with no snapshot. When two
# are waiting, that refusal is total: no single apply can succeed, and there was
# nothing the page could offer but a shell. The group IS the offer.
#
# Everything here READS what the host wrote (updater/groups.py -> groups/<id>.json
# in the read-only mount) through an allow-list, and the one write is the same
# spool file as a component request with `kind: "group"` on it. There is no new
# route and no new gate: the group read rides on GET /updates/plan?group= and the
# group ask on POST /updates/request, which is already `operator`, CSRF-checked
# and audited. A group is not a new KIND of power over this box - it is the power
# /updates/request already has, over a plan the host wrote about a recipe rather
# than about one component - so it gets no new surface at the edge.

def _groups_dir() -> str:
    """Beside plans/, in the same read-only mount. A function, not a constant,
    because UPDATES_DIR is read from the environment further down this file."""
    return os.path.join(UPDATES_DIR, "groups")


def _read_group(gid: str) -> dict | None:
    if not _ID.fullmatch(gid):
        return None
    doc = _read_json(os.path.join(_groups_dir(), f"{gid}.json"), MAX_PLAN_BYTES)
    return doc if isinstance(doc, dict) and doc.get("version") == 1 and doc.get("group") == gid else None


def _member_row(m: object) -> dict | None:
    if not isinstance(m, dict) or not isinstance(m.get("component"), str) or not _ID.fullmatch(m["component"]):
        return None
    f, t = (m.get(k) if isinstance(m.get(k), dict) else {} for k in ("from", "to"))
    return {"component": m["component"], "title": _s(m.get("title"), 120), "class": _s(m.get("class"), 20),
            "container": _s(m.get("container"), 64),
            "planId": m["planId"] if isinstance(m.get("planId"), str) and _PLAN.fullmatch(m["planId"]) else None,
            "level": m["level"] if m.get("level") in LEVELS else None, "oneWay": m.get("oneWay") is True,
            "from": {"image": _s(f.get("image"), 255), "version": _s(f.get("version"), 64),
                     "tag": _s(f.get("tag"), 128), "digest": _digest_or_none(f.get("digest"))},
            "to": {"image": _s(t.get("image"), 255), "version": _s(t.get("version"), 64),
                   "tag": _s(t.get("tag"), 128), "digest": _digest_or_none(t.get("digest"))},
            "pins": _pins(m.get("pins")), "snapshot": _s(m.get("snapshot"), 40),
            "changelog": m["changelog"][:300] if isinstance(m.get("changelog"), str)
            and m["changelog"].startswith("https://") else None}


def _group_plan(p: object) -> dict | None:
    """A host-written GROUP plan, copied field by field. None when it is not one."""
    if not isinstance(p, dict) or not isinstance(p.get("id"), str) or not _PLAN.fullmatch(p["id"]):
        return None
    if p.get("kind") != "group" or p.get("level") not in LEVELS or p.get("confirm") not in ("click", "type-name"):
        return None
    if not isinstance(p.get("group"), str) or not _ID.fullmatch(p["group"]):
        return None
    rows = [r for r in (_member_row(m) for m in (p.get("memberRows") or [])[:16]) if r]
    if len(rows) < 2:
        return None  # a group is two or more members, or it is not a group
    snap = p.get("snapshot") if isinstance(p.get("snapshot"), dict) else {}
    est = snap.get("estimateBytes")
    return {
        "group": p["group"], "kind": "group", "id": p["id"], "title": _s(p.get("title"), 160),
        "recipe": p["recipe"] if isinstance(p.get("recipe"), str) and _APPLY.fullmatch(p["recipe"]) else None,
        "project": _s(p.get("project"), 64), "services": _strs_list(p.get("services"), 16, 64),
        "createdAt": _iso_or_none(p.get("createdAt")), "discoveredAt": _iso_or_none(p.get("discoveredAt")),
        "level": p["level"], "confirm": p["confirm"],
        # What the person types when confirm is type-name: the GROUP's id, because
        # the group is what is being approved - never one member's name.
        "confirmWord": p["confirmWord"] if p.get("confirmWord") == p["group"] else None,
        "oneWay": p.get("oneWay") is True, "oneWayWhy": _s(p.get("oneWayWhy"), 300),
        "members": rows,
        "skipped": [{"component": s["component"], "reason": _s(s.get("reason"), 300) or ""}
                    for s in (p.get("skipped") or [])[:16]
                    if isinstance(s, dict) and isinstance(s.get("component"), str) and _ID.fullmatch(s["component"])],
        "restarts": _strs_list(p.get("restarts"), 16, 100),
        "downtime": _s(p.get("downtime"), 800), "signedOut": _s(p.get("signedOut"), 300),
        "snapshot": {"kinds": [k for k in _strs_list(snap.get("kinds"), 8, 40) if k in _SNAPSHOT_KINDS],
                     "what": _s(snap.get("what"), 1200), "dir": _s(snap.get("dir"), 300),
                     "estimateBytes": est if isinstance(est, int) and not isinstance(est, bool) and est >= 0
                     else None},
        "preflight": _strs_list(p.get("preflight"), 12, 400),
        "verify": _strs_list(p.get("verify"), 32, 300),
        "rollback": _s(p.get("rollback"), 1000),
        "backupKinds": _strs_list(p.get("backupKinds"), 8, 40),
    }


def _group_rows(catalog: Catalog) -> list[dict]:
    """One row per group the host knows about: its plan, or why there is none."""
    try:
        names = sorted(n for n in os.listdir(_groups_dir()) if n.endswith(".json"))
    except OSError:
        return []
    out = []
    for n in names[:16]:
        gid = n[:-5]
        doc = _read_group(gid)
        if doc is None:
            continue
        members = [m for m in _strs_list(doc.get("members"), 16, 40) if _ID.fullmatch(m) and m in catalog.components]
        if doc.get("ok") is True:
            p = _group_plan(doc.get("plan"))
            if not p or p["group"] != gid:
                continue
            out.append({"group": gid, "deployable": True, "recipe": p["recipe"], "plan": p,
                        "reason": None, "candidates": [m["component"] for m in p["members"]],
                        "createdAt": p["createdAt"]})
        else:
            out.append({"group": gid, "deployable": False,
                        "recipe": f"just {gid}", "plan": None,
                        "reason": _s(doc.get("reason"), 300) or "no group plan",
                        "candidates": members, "createdAt": _iso_or_none(doc.get("createdAt"))})
    return out


def _row_plan(cid: str) -> dict | None:
    """The status row's summary of the host's plan file for `cid`."""
    doc = _read_plan(cid)
    if doc is None:
        return None
    if doc.get("ok") is True:
        p = _plan(doc.get("plan"))
        if not p:
            return None
        return {"id": p["id"], "deployable": True, "from": p["from"]["version"] or p["from"]["tag"],
                "to": p["to"]["version"] or p["to"]["tag"], "level": p["level"], "createdAt": p["createdAt"]}
    return {"id": None, "deployable": False, "reason": _s(doc.get("reason"), 300) or "no plan",
            "createdAt": _s(doc.get("createdAt"), 40)}


def status(catalog: Catalog) -> dict:
    doc, meta = _available()
    auto_state = _auto_state()
    asks = _asks_state()
    unpausing = {d["component"] for d in _unpause_queued()}
    found = doc["components"] if doc else {}
    rows = []
    for c in catalog.components.values():
        disc = _discovered(found.get(c.id))
        latest = disc["latest"] if disc else None
        level = latest.get("level") if latest else None
        rows.append({
            "id": c.id, "title": c.title, "class": c.cls, "source": c.source, "pins": list(c.pins),
            "apply": c.apply, "dependants": list(c.dependants), "channel": c.channel,
            "oneWay": c.one_way, "oneWayWhy": c.one_way_why, "verify": list(c.verify),
            "changelog": _changelog(c, disc),
            "level": level,
            "effectiveChannel": effective_channel(c.channel, level),
            "behind": level in ("minor", "major"),
            "discovered": disc,
            "plan": _row_plan(c.id),
            # Step 7: the host's pause (auto.json, read-only here) and whether an
            # operator's unpause is already waiting in the spool.
            "paused": auto_state["paused"].get(c.id),
            "unpauseQueued": c.id in unpausing,
        })
    groups = _group_rows(catalog)
    in_group = {c for g in groups if g["deployable"] for c in g["candidates"]}
    for r in rows:
        # Which group would carry this row, when one would. The page draws the
        # row's Apply as "apply it with its group", because applying it alone WILL
        # be refused by the host's scope check - the recipe recreates the others too.
        r["group"] = next((g["group"] for g in groups if r["id"] in g["candidates"]), None)
        r["applyWithGroup"] = r["id"] in in_group
    summary = {
        "components": len(rows),
        "updates": sum(1 for r in rows if r["level"]),
        "behind": sum(1 for r in rows if r["behind"]),
        "drift": sum(1 for r in rows if r["discovered"] and r["discovered"]["drift"]),
        "errors": sum(1 for r in rows if r["discovered"] and r["discovered"]["error"]),
        # The count the whole page was missing: "pins this box has not applied".
        # `updates` is what is newer UPSTREAM, which is a different question and
        # was the only count with a headline - 2 of them, while ten components
        # were behind on apply (2026-10-07).
        "toApply": sum(1 for r in rows if r["plan"] and r["plan"]["deployable"]),
        "groups": sum(1 for g in groups if g["deployable"]),
    }
    p = catalog.policy
    job = _current_job()
    queue = _queued()
    return {"discovery": meta, "summary": summary,
            "policy": {"windowStart": p.window_start, "windowEnd": p.window_end,
                       "requireBackup": p.require_backup, "requireDoctor": p.require_doctor,
                       "maxAutoPerNight": p.max_auto_per_night, "pauseOnFailure": p.pause_on_failure,
                       "discoverEveryHours": p.discover_every_hours},
            "applying": bool(queue) or bool(job and job["state"] == "running"),
            "job": job,
            # Step 6: the installed updater, and a staged one waiting for `just install-updater`.
            "updater": _updater(),
            "history": _history(20),
            "auto": {"enabled": p.max_auto_per_night > 0, "actor": AUTO_ACTOR,
                     "paused": sorted(auto_state["paused"]), "last": auto_state["last"]},
            # The two asks (POST /updates/discover, /updates/autorun): whether one
            # is waiting in the spool, and what the HOST said about the last one.
            # `discoverMinSeconds` is the rate limit, so the page can say "in 3 min"
            # rather than offering a button that will be refused.
            "asks": {"discoverQueued": bool(_ask_queued(_DISCOVER_FILE, "discover-")),
                     "autorunQueued": bool(_ask_queued(_AUTORUN_FILE, "autorun-")),
                     "discoverMinSeconds": DISCOVER_MIN_SECONDS, **asks},
            # One per `apply` recipe with two or more components to apply at once
            # (updater/groups.py): the whole plan when it is deployable, the reason
            # when it is not. Without this the page could only show a refusal.
            "groups": groups,
            "components": rows}


# ══ step 4: plans, requests and jobs ═════════════════════════════════════════
#
# bothy-ops' whole part in APPLYING an update is to write one small file into
# the spool, after checking the request against the plan the HOST wrote. It
# runs nothing, pulls nothing and edits nothing; the host executor
# (apps/bothy-ops/updater, a systemd path unit) re-validates every field of that
# file and decides for itself. Everything else here READS what the executor
# wrote, through the read-only mount, and re-filters it to an allow-list - the
# same "second lock" as available.json.

UPDATES_DIR = os.environ.get("UPDATES_DIR", os.path.dirname(AVAILABLE_FILE))
SPOOL_DIR = os.environ.get("UPDATES_SPOOL", "/spool")
MAX_PLAN_BYTES = 256 * 1024
MAX_STATUS_BYTES = 512 * 1024
MAX_HISTORY_BYTES = 2 * 1024 * 1024
MAX_SPOOL_BYTES = 4096
# How many requests may wait at once. The executor runs one at a time; a queue
# longer than this is a stuck executor or a flood, and both deserve a refusal.
MAX_QUEUE = 8

JOB_STATES = ("queued", "running", "succeeded", "rolled_back", "aborted", "failed", "refused")
STEP_NAMES = ("validate", "preflight", "snapshot", "pull", "apply", "verify", "rollback", "restore", "record",
              # own code (step 6): build instead of pull, a rollback timer, the checkout move, a staged updater
              "build", "arm", "switch", "stage",
              # the Postgres major (step 8): writers stopped, dump, a new volume, load, compare, start
              "stop", "dump", "create", "load", "compare", "start")
STEP_STATES = ("pending", "running", "ok", "failed", "skipped")
_JOB = re.compile(r"[a-f0-9]{32}")
_PLAN = re.compile(r"[a-f0-9]{24}")
_SHA = re.compile(r"[a-f0-9]{40}")
_ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
_SPOOL_FILE = re.compile(r"([a-f0-9]{32})\.json")


def _iso_or_none(v: object) -> str | None:
    return v if isinstance(v, str) and _ISO.fullmatch(v) else None


def _digest_or_none(v: object) -> str | None:
    return v if isinstance(v, str) and _DIGEST.fullmatch(v) else None


def _strs_list(v: object, n: int = 12, width: int = 300) -> list[str]:
    return [x[:width] for x in v[:n] if isinstance(x, str)] if isinstance(v, list) else []


def _read_bounded(path: str, limit: int) -> str | None:
    """A file's text, or None when absent, unreadable, a symlink or too large."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not (st.st_mode & 0o170000 == 0o100000) or st.st_size > limit:
            return None
        return os.read(fd, limit + 1).decode("utf-8", "replace")
    finally:
        os.close(fd)


def _read_json(path: str, limit: int) -> object:
    text = _read_bounded(path, limit)
    if text is None:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _read_plan(cid: str) -> dict | None:
    if not _ID.fullmatch(cid):
        return None
    doc = _read_json(os.path.join(UPDATES_DIR, "plans", f"{cid}.json"), MAX_PLAN_BYTES)
    return doc if isinstance(doc, dict) and doc.get("version") == 1 and doc.get("component") == cid else None


def _plan(p: object) -> dict | None:
    """A host-written plan, copied field by field. None when it is not one."""
    if not isinstance(p, dict) or not isinstance(p.get("id"), str) or not _PLAN.fullmatch(p["id"]):
        return None
    if p.get("level") not in ("patch", "minor", "major") or p.get("confirm") not in ("click", "type-name"):
        return None
    f, t, pin, snap = (p.get(k) if isinstance(p.get(k), dict) else {} for k in ("from", "to", "pin", "snapshot"))
    if not isinstance(f.get("image"), str) or not isinstance(t.get("image"), str):
        return None
    line = pin.get("line")
    est = snap.get("estimateBytes")
    return {
        "id": p["id"], "component": _s(p.get("component"), 40), "title": _s(p.get("title"), 120),
        "class": _s(p.get("class"), 20), "createdAt": _iso_or_none(p.get("createdAt")),
        "discoveredAt": _iso_or_none(p.get("discoveredAt")),
        "level": p["level"], "confirm": p["confirm"],
        "from": {"image": f["image"][:255], "tag": _s(f.get("tag"), 128), "version": _s(f.get("version"), 64),
                 "digest": _digest_or_none(f.get("digest")), "container": _s(f.get("container"), 64)},
        "to": {"image": t["image"][:255], "tag": _s(t.get("tag"), 128), "version": _s(t.get("version"), 64),
               "digest": _digest_or_none(t.get("digest"))},
        "pin": {"file": _s(pin.get("file"), 200), "service": _s(pin.get("service"), 64),
                "line": line if isinstance(line, int) and not isinstance(line, bool) and 0 < line < 100000 else None,
                "commit": pin["commit"] if isinstance(pin.get("commit"), str) and _SHA.fullmatch(pin["commit"]) else None},
        "changelog": p["changelog"][:300] if isinstance(p.get("changelog"), str)
        and p["changelog"].startswith("https://") else None,
        "oneWay": p.get("oneWay") is True, "oneWayWhy": _s(p.get("oneWayWhy"), 300),
        "restarts": _strs_list(p.get("restarts"), 12, 100),
        "recipe": p["recipe"] if isinstance(p.get("recipe"), str) and _APPLY.fullmatch(p["recipe"]) else None,
        "downtime": _s(p.get("downtime"), 300), "signedOut": _s(p.get("signedOut"), 300),
        "pins": _pins(p.get("pins")),
        "snapshot": {"kind": snap.get("kind") if snap.get("kind") in _SNAPSHOT_KINDS else None,
                     "what": _s(snap.get("what"), 400), "dir": _s(snap.get("dir"), 300),
                     "estimateBytes": est if isinstance(est, int) and not isinstance(est, bool) and est >= 0 else None},
        "preflight": _strs_list(p.get("preflight")),
        "verify": _strs_list(p.get("verify")),
        "rollback": _s(p.get("rollback"), 800),
        **({"own": _own(p["own"])} if isinstance(p.get("own"), dict) else {}),
        # Step 8: which procedure (a cluster add-on, the Postgres major), what the
        # request must carry, the procedure's steps, and each kind's own facts.
        "kind": p["kind"] if p.get("kind") in PLAN_KINDS else None,
        "requiresNote": p.get("requiresNote") is True,
        "procedure": _strs_list(p.get("procedure"), 12, 400),
        **({"cluster": _cluster(p["cluster"])} if isinstance(p.get("cluster"), dict) else {}),
        **({"pgMajor": _pg_major(p["pgMajor"])} if isinstance(p.get("pgMajor"), dict) else {}),
    }


_SNAPSHOT_KINDS = ("image", "victoriametrics", "loki", "grafana", "keycloak", "git", "helm", "daemonset",
                   "pg-dumpall")
PLAN_KINDS = ("cluster", "postgres-major")
NOTE_MIN, NOTE_MAX = 10, 500


def _num(v: object) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def _cluster(c: dict) -> dict:
    """A cluster add-on's facts (step 8): where, as whom, and which part of k8s-monitoring.sh."""
    return {"kind": c.get("kind") if c.get("kind") in ("helm", "daemonset") else None,
            "context": _s(c.get("context"), 100), "identity": _s(c.get("identity"), 120),
            "namespace": _s(c.get("namespace"), 63), "release": _s(c.get("release"), 63),
            "name": _s(c.get("name"), 63), "revision": _num(c.get("revision")),
            "part": c.get("part") if c.get("part") in ("ksm", "alloy") else None,
            "configMaps": _strs_list(c.get("configMaps"), 4, 63)}


def _pg_major(g: dict) -> dict:
    """The Postgres major's facts (step 8): the two majors, the two volumes, the data."""
    return {"fromMajor": _num(g.get("fromMajor")), "toMajor": _num(g.get("toMajor")),
            "oldVolume": _s(g.get("oldVolume"), 100), "newVolume": _s(g.get("newVolume"), 100),
            "oldMount": _s(g.get("oldMount"), 100), "newMount": _s(g.get("newMount"), 100),
            "dataBytes": _num(g.get("dataBytes")), "databases": _strs_list(g.get("databases"), 32, 63),
            "keycloakDb": _s(g.get("keycloakDb"), 63), "stops": _strs_list(g.get("stops"), 8, 63),
            "deleteOld": _s(g.get("deleteOld"), 200)}


def _pins(v: object) -> list[dict]:
    """Every pin line a plan moves (two for Keycloak): file, service, line - never the raw text."""
    out = []
    for q in (v if isinstance(v, list) else [])[:4]:
        if not isinstance(q, dict):
            continue
        line = q.get("line")
        out.append({"file": _s(q.get("file"), 200), "service": _s(q.get("service"), 64),
                    "line": line if isinstance(line, int) and not isinstance(line, bool) and 0 < line < 100000
                    else None})
    return out
_OWN_APPS = ("bothy-web", "bothy-files", "bothy-ops")
_TAG = re.compile(r"v\d{1,5}\.\d{1,5}\.\d{1,5}")


def _own(o: dict) -> dict:
    """An own-code plan's extra facts (step 6), copied field by field."""
    ci = o.get("ci") if isinstance(o.get("ci"), dict) else {}
    num = (lambda v: v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None)
    url = o.get("releaseUrl")
    return {
        "fromSha": o["fromSha"] if isinstance(o.get("fromSha"), str) and _SHA.fullmatch(o["fromSha"]) else None,
        "toSha": o["toSha"] if isinstance(o.get("toSha"), str) and _SHA.fullmatch(o["toSha"]) else None,
        "tag": o["tag"] if isinstance(o.get("tag"), str) and _TAG.fullmatch(o["tag"]) else None,
        "releaseUrl": url[:300] if isinstance(url, str) and url.startswith("https://") else None,
        "commits": num(o.get("commits")), "diffstat": _s(o.get("diffstat"), 200),
        "apps": [a for a in _strs_list(o.get("apps"), 3, 20) if a in _OWN_APPS],
        "compose": _strs_list(o.get("compose"), 20, 200), "edge": _strs_list(o.get("edge"), 20, 200),
        "elsewhere": _strs_list(o.get("elsewhere"), 20, 200), "elsewhereCount": num(o.get("elsewhereCount")),
        "updater": o.get("updater") is True, "updaterFiles": _strs_list(o.get("updaterFiles"), 20, 200),
        "ci": {"via": _s(ci.get("via"), 80), "detail": _s(ci.get("detail"), 300), "runs": num(ci.get("runs"))},
        "rollbackAfter": num(o.get("rollbackAfter")),
        "order": [a for a in _strs_list(o.get("order"), 3, 20) if a in _OWN_APPS],
    }


def _updater() -> dict | None:
    """Which updater copy runs and which is staged (updater/install.py writes it)."""
    doc = _read_json(os.path.join(UPDATES_DIR, "updater.json"), 64 * 1024)
    if not isinstance(doc, dict) or doc.get("version") != 1:
        return None
    cur = doc.get("current") if isinstance(doc.get("current"), dict) else {}
    stg = doc.get("staged") if isinstance(doc.get("staged"), dict) else {}
    sha = (lambda v: v if isinstance(v, str) and _SHA.fullmatch(v) else None)
    return {"current": sha(cur.get("sha")), "installedAt": _iso_or_none(cur.get("installedAt")),
            "staged": sha(stg.get("sha")), "stagedAt": _iso_or_none(stg.get("stagedAt"))}


def _ref(v: object) -> dict | None:
    if not isinstance(v, dict) or not isinstance(v.get("image"), str):
        return None
    return {"image": v["image"][:255], "version": _s(v.get("version"), 64)}


def _job(j: object, *, steps: bool = True) -> dict | None:
    """A job record (status.json's, or a history line), copied field by field."""
    if not isinstance(j, dict) or not isinstance(j.get("id"), str) or not _JOB.fullmatch(j["id"]):
        return None
    if j.get("state") not in JOB_STATES:
        return None
    out = {
        "id": j["id"], "component": _s(j.get("component"), 40) or "?",
        "planId": j["planId"] if isinstance(j.get("planId"), str) and _PLAN.fullmatch(j["planId"]) else None,
        "state": j["state"], "requestedBy": _s(j.get("requestedBy"), 200) or "unknown",
        "requestedAt": _iso_or_none(j.get("requestedAt")), "startedAt": _iso_or_none(j.get("startedAt")),
        "endedAt": _iso_or_none(j.get("endedAt")),
        "from": _ref(j.get("from")), "to": _ref(j.get("to")),
        "error": _s(j.get("error"), 500), "snapshot": _s(j.get("snapshot"), 300), "note": _s(j.get("note"), 800),
        # A GROUP job (updater/groups.py): `component` is the recipe, and these are
        # the components it moved - so a history row says which, and so auto's
        # pause can be read back against them.
        "members": [m for m in _strs_list(j.get("members"), 16, 40) if _ID.fullmatch(m)],
    }
    if steps:
        out["steps"] = [{"name": s["name"], "state": s["state"], "startedAt": _iso_or_none(s.get("startedAt")),
                         "endedAt": _iso_or_none(s.get("endedAt")), "detail": _s(s.get("detail"), 500)}
                        for s in (j.get("steps") if isinstance(j.get("steps"), list) else [])[:16]
                        if isinstance(s, dict) and s.get("name") in STEP_NAMES and s.get("state") in STEP_STATES]
    else:
        d = j.get("durationMs")
        out["durationMs"] = d if isinstance(d, int) and not isinstance(d, bool) and d >= 0 else None
        out["failedStep"] = j.get("failedStep") if j.get("failedStep") in STEP_NAMES else None
    return out


def _current_job() -> dict | None:
    doc = _read_json(os.path.join(UPDATES_DIR, "status.json"), MAX_STATUS_BYTES)
    return _job(doc.get("job")) if isinstance(doc, dict) and doc.get("version") == 1 else None


def _history_lines() -> list[str]:
    path = os.path.join(UPDATES_DIR, "history.jsonl")
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - MAX_HISTORY_BYTES))
            data = fh.read().decode("utf-8", "replace")
    except OSError:
        return []
    lines = data.splitlines()
    return lines[1:] if size > MAX_HISTORY_BYTES else lines


def _history(limit: int) -> list[dict]:
    out = []
    for ln in reversed(_history_lines()):
        try:
            e = _job(json.loads(ln), steps=False)
        except ValueError:
            continue
        if e:
            out.append(e)
            if len(out) >= limit:
                break
    return out


def _queued() -> list[dict]:
    """The requests waiting in the spool - this process wrote them, and still
    reads them as untrusted: a symlink or an oversized file is skipped."""
    try:
        names = sorted(n for n in os.listdir(SPOOL_DIR) if _SPOOL_FILE.fullmatch(n))
    except OSError:
        return []
    out = []
    for n in names[:MAX_QUEUE * 2]:
        d = _read_json(os.path.join(SPOOL_DIR, n), MAX_SPOOL_BYTES)
        if isinstance(d, dict) and d.get("jobId") == n[:-5]:
            out.append(d)
    return out


def _queued_job(d: dict) -> dict:
    # A group request names a RECIPE instead of a component, and that is what every
    # record calls it (updater/record.new_job does the same on the host).
    return {"id": d["jobId"], "component": _s(d.get("component"), 40) or _s(d.get("group"), 40) or "?",
            "group": _s(d.get("group"), 40),
            "planId": d.get("planId") if isinstance(d.get("planId"), str) and _PLAN.fullmatch(d["planId"]) else None,
            "state": "queued", "requestedBy": _s(d.get("requestedBy"), 200) or "unknown",
            "requestedAt": _iso_or_none(d.get("requestedAt")), "startedAt": None, "endedAt": None,
            "from": None, "to": None, "steps": [], "error": None, "snapshot": None, "note": None}


def _spool_ready() -> None:
    if not os.path.isdir(SPOOL_DIR) or not os.access(SPOOL_DIR, os.W_OK):
        raise UpdatesError("the update spool is not mounted - `just up-apps` creates it", status=503)


def _spool_write(rid: str, name: str, doc: dict) -> None:
    """The ONE write this process makes, in one place: a dot-named temp file the
    path unit's glob (`*.json`) cannot match, then a rename. The executor never
    sees half a request. 600, O_EXCL, O_NOFOLLOW.

    One function for all four kinds of ask, so "what bothy-ops can put in the
    spool" is a list of callers rather than four copies of an open() that could
    drift apart. Nothing else here writes anywhere.
    """
    tmp = os.path.join(SPOOL_DIR, f".{rid}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, json.dumps(doc, sort_keys=True).encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(tmp, os.path.join(SPOOL_DIR, name))


def _one_param(h, *names: str) -> tuple[str, str]:
    """(name, value) of the ONE query parameter, which must be one of `names`.

    `/updates/plan` takes `?component=` or - for a group (updater/groups.py) -
    `?group=`, and exactly one of them: one parameter, from a closed set, used
    only as a lookup key into a file the HOST wrote.
    """
    q = urlparse(h.path).query
    try:
        pairs = parse_qsl(q, keep_blank_values=True, strict_parsing=True)
    except ValueError:
        raise Refused(f"expected ?{names[0]}=…", status=400) from None
    if len(pairs) != 1 or pairs[0][0] not in names:
        raise Refused(f"expected exactly one parameter, {' or '.join(names)}", status=400)
    return pairs[0]


def group_read(h, gid: str) -> tuple[dict, str]:
    """GET /updates/plan?group=: the host's group plan, or its reason. Viewer."""
    if not _ID.fullmatch(gid):
        raise Refused("group must be an `apply` recipe name", status=400)
    doc = _read_group(gid)
    if doc is None:
        return ({"group": gid, "plan": None, "ageSeconds": None,
                 "reason": "no group plan - run `just updates-discover` on the host (it writes one per recipe "
                           "with two or more components to apply at once)"}, f"{gid}: none")
    try:
        age = max(0, int(time.time() - os.stat(os.path.join(_groups_dir(), f"{gid}.json")).st_mtime))
    except OSError:
        age = None
    if doc.get("ok") is True:
        p = _group_plan(doc.get("plan"))
        if p and p["group"] == gid:
            return {"group": gid, "plan": p, "reason": None, "ageSeconds": age}, f"{gid}: {p['id']}"
        return {"group": gid, "plan": None, "reason": "the group plan file is malformed",
                "ageSeconds": age}, f"{gid}: malformed"
    return ({"group": gid, "plan": None, "reason": _s(doc.get("reason"), 300) or "no group plan",
             "ageSeconds": age}, f"{gid}: refused")


def plan_read(h) -> tuple[dict, str]:
    what, value = _one_param(h, "component", "group")
    if what == "group":
        return group_read(h, value)
    cid = value
    if not _ID.fullmatch(cid):
        raise Refused("component must be a catalog id", status=400)
    if cid not in CATALOG.components:
        raise Refused(f"{cid} is not in updates.toml", status=404)
    doc = _read_plan(cid)
    if doc is None:
        return ({"component": cid, "plan": None, "ageSeconds": None,
                 "reason": "no plan yet - run `just updates-discover` on the host (it writes one per component)"},
                f"{cid}: none")
    try:
        age = max(0, int(time.time() - os.stat(os.path.join(UPDATES_DIR, "plans", f"{cid}.json")).st_mtime))
    except OSError:
        age = None
    if doc.get("ok") is True:
        p = _plan(doc.get("plan"))
        if p and p["component"] == cid:
            return {"component": cid, "plan": p, "reason": None, "ageSeconds": age}, f"{cid}: {p['id']}"
        return {"component": cid, "plan": None, "reason": "the plan file is malformed", "ageSeconds": age}, \
            f"{cid}: malformed"
    return ({"component": cid, "plan": None, "reason": _s(doc.get("reason"), 300) or "no plan", "ageSeconds": age},
            f"{cid}: refused")


def request_group(h, who: str, body: dict) -> tuple[dict, str]:
    """POST /updates/request with `group`: apply a whole recipe. ONE spool file.

    The same route, the same `operator` gate, the same CSRF check and the same
    audit line as a component request - because it is the same power over the box,
    about a plan the host wrote for a recipe rather than for one component. Not a
    second route: a group adds no KIND of access, and SECURITY.md counts routes.
    """
    if set(body) != {"group", "plan_id", "confirm"}:
        raise Refused("the body is exactly {group, plan_id, confirm} - a group takes no note", status=400)
    gid, pid, confirm = body["group"], body["plan_id"], body["confirm"]
    if not isinstance(gid, str) or not _ID.fullmatch(gid):
        raise Refused("group must be an `apply` recipe name", status=400)
    if not isinstance(pid, str) or not _PLAN.fullmatch(pid):
        raise Refused("plan_id must be 24 hex characters", status=400)
    if flat(who) == AUTO_ACTOR:
        raise Refused(f"{AUTO_ACTOR!r} is the automatic channel's name, not a person's", status=403)
    doc = _read_group(gid)
    if doc is None:
        raise Refused(f"there is no group plan for {gid} - run `just updates-discover` on the host", status=404)
    if doc.get("ok") is not True:
        raise Refused(f"{gid} has no deployable group plan: {_s(doc.get('reason'), 300)}", status=409)
    p = _group_plan(doc.get("plan"))
    if not p or p["group"] != gid:
        raise Refused("the group plan file is malformed", status=502)
    if p["id"] != pid:
        raise Refused(f"group plan {pid} is not the current plan for {gid} - reload and look again", status=409)
    avail, _ = _available()
    if not avail or avail.get("generatedAt") != p["discoveredAt"]:
        raise Refused("discovery ran again after this plan was made - reload and look again", status=409)
    if p["confirm"] == "type-name":
        # The union, never the loosest: one one-way member, or one major step, and
        # the whole group is typed - and what is typed is the GROUP's name.
        if confirm != gid:
            raise Refused(f"type the recipe's name ({gid}) to confirm - this group applies "
                          f"{len(p['members'])} components in one `{p['recipe']}`", status=400)
    elif confirm is not True:
        raise Refused("confirm must be true", status=400)
    _spool_ready()
    queue = _queued()
    if len(queue) >= MAX_QUEUE:
        raise Refused(f"{len(queue)} requests are already waiting - is bothy-updater.path running?", status=429)
    mine = {gid, *(m["component"] for m in p["members"])}
    for q in queue:
        if q.get("group") == gid:
            raise Refused(f"an apply of {gid} is already queued", status=409)
        if q.get("component") in mine:
            raise Refused(f"an update of {q['component']} is already queued, and this group would apply it "
                          "too", status=409)
    cur = _current_job()
    if cur and cur["state"] == "running" and cur["component"] in mine:
        raise Refused(f"an update of {cur['component']} is running now", status=409)
    job = secrets.token_hex(16)
    req = {"v": 1, "jobId": job, "kind": "group", "group": gid, "planId": pid, "confirm": confirm,
           "requestedBy": flat(who)[:200] or "unknown",
           "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    _spool_write(job, f"{job}.json", req)
    return ({"jobId": job, "group": gid, "planId": pid,
             "components": [m["component"] for m in p["members"]]},
            f"group {gid} plan {pid} job {job}: `{p['recipe']}` applies "
            + ", ".join(f"{m['component']} {m['from']['version']}->{m['to']['version']}" for m in p["members"]))


def request_update(h, who: str) -> tuple[dict, str]:
    """POST /updates/request: check, then write ONE spool file. Runs nothing."""
    body = h.read_json_object(2048)
    if "group" in body:
        return request_group(h, who, body)
    if not {"component", "plan_id", "confirm"} <= set(body) <= {"component", "plan_id", "confirm", "note"}:
        raise Refused("the body is exactly {component, plan_id, confirm} (+ note, for a plan that needs one)",
                      status=400)
    cid, pid, confirm, note = body["component"], body["plan_id"], body["confirm"], body.get("note")
    if not isinstance(cid, str) or not _ID.fullmatch(cid):
        raise Refused("component must be a catalog id", status=400)
    if not isinstance(pid, str) or not _PLAN.fullmatch(pid):
        raise Refused("plan_id must be 24 hex characters", status=400)
    if flat(who) == AUTO_ACTOR:
        # The night job's name (updater/auto.py). Nobody signs in as it, and a
        # request that did would read as the system's in every record.
        raise Refused(f"{AUTO_ACTOR!r} is the automatic channel's name, not a person's", status=403)
    comp = CATALOG.components.get(cid)
    if comp is None:
        raise Refused(f"{cid} is not in updates.toml", status=404)
    doc = _read_plan(cid)
    if doc is None:
        raise Refused(f"there is no plan for {cid} - run `just updates-discover` on the host", status=404)
    if doc.get("ok") is not True:
        raise Refused(f"{cid} has no deployable plan: {_s(doc.get('reason'), 300)}", status=409)
    p = _plan(doc.get("plan"))
    if not p or p["component"] != cid:
        raise Refused("the plan file is malformed", status=502)
    if p["id"] != pid:
        raise Refused(f"plan {pid} is not the current plan for {cid} - reload and look again", status=409)
    avail, _ = _available()
    if not avail or avail.get("generatedAt") != p["discoveredAt"]:
        raise Refused("discovery ran again after this plan was made - reload and look again", status=409)
    if p["confirm"] == "type-name":
        if confirm != cid:
            raise Refused(f"type the component's id ({cid}) to confirm", status=400)
    elif confirm is not True:
        raise Refused("confirm must be true", status=400)
    if p["requiresNote"]:
        # The Postgres major (step 8): never one click - the id typed AND a note.
        if not isinstance(note, str) or not NOTE_MIN <= len(note.strip()) <= NOTE_MAX or "\n" in note \
                or "\r" in note:
            raise Refused(f"this plan needs a maintenance note: one line, {NOTE_MIN}-{NOTE_MAX} characters - what, "
                          "why, and who is told", status=400)
        note = flat(note.strip())[:NOTE_MAX]
    elif note is not None:
        raise Refused("a maintenance note is only for a plan that asks for one", status=400)
    _spool_ready()
    queue = _queued()
    if len(queue) >= MAX_QUEUE:
        raise Refused(f"{len(queue)} requests are already waiting - is bothy-updater.path running?", status=429)
    if any(q.get("component") == cid for q in queue):
        raise Refused(f"an update of {cid} is already queued", status=409)
    for q in queue:
        # A group already waiting that would apply this component too: the host
        # would refuse the second one anyway (the plan it names goes stale the
        # moment the first runs), and saying so here is the answer, not a 409
        # arriving minutes later from the executor.
        if not isinstance(q.get("group"), str):
            continue
        gdoc = _read_group(q["group"])
        gp = _group_plan((gdoc or {}).get("plan")) if (gdoc or {}).get("ok") is True else None
        if gp and cid in {m["component"] for m in gp["members"]}:
            raise Refused(f"an apply of the whole `{gp['recipe']}` is already queued, and it includes {cid}",
                          status=409)
    cur = _current_job()
    if cur and cur["state"] == "running" and cur["component"] == cid:
        raise Refused(f"an update of {cid} is running now", status=409)
    job = secrets.token_hex(16)
    req = {"v": 1, "jobId": job, "component": cid, "planId": pid, "confirm": confirm,
           "requestedBy": flat(who)[:200] or "unknown",
           "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if note is not None:
        req["note"] = note
    _spool_write(job, f"{job}.json", req)
    return ({"jobId": job, "component": cid, "planId": pid},
            f"{cid} plan {pid} job {job}: {p['from']['image']} -> {p['to']['image']}"
            + (f" note: {note}" if note is not None else ""))


# ══ step 7: the automatic channel's pauses ═══════════════════════════════════
#
# The pause state is the HOST's (updater/auto.py writes auto.json, 600, in the
# directory mounted here read-only). This process shows it and can ask for one
# pause to be cleared - one small file in the spool - and nothing more: the
# executor's loop claims the file, re-checks it and clears the pause itself.

AUTO_ACTOR = "auto"
MAX_AUTO_BYTES = 512 * 1024
_UNPAUSE_FILE = re.compile(r"unpause-([a-f0-9]{32})\.json")
AUTO_OUTCOMES = ("requested", "skipped")


def _auto_state() -> dict:
    doc = _read_json(os.path.join(UPDATES_DIR, "auto.json"), MAX_AUTO_BYTES)
    out: dict = {"paused": {}, "last": None}
    if not isinstance(doc, dict) or doc.get("version") != 1:
        return out
    paused = doc.get("paused") if isinstance(doc.get("paused"), dict) else {}
    for cid, p in list(paused.items())[:64]:
        if not isinstance(cid, str) or not _ID.fullmatch(cid) or not isinstance(p, dict):
            continue
        out["paused"][cid] = {
            "since": _iso_or_none(p.get("since")),
            "result": p.get("result") if p.get("result") in ("rolled_back", "failed") else None,
            "reason": _s(p.get("reason"), 300) or "a rollback or a failure",
            "jobId": p["jobId"] if isinstance(p.get("jobId"), str) and _JOB.fullmatch(p["jobId"]) else None,
            "requestedBy": _s(p.get("requestedBy"), 200),
        }
    last = doc.get("last")
    if isinstance(last, dict) and last.get("outcome") in AUTO_OUTCOMES:
        comp = last.get("component")
        jid = last.get("jobId")
        out["last"] = {
            "at": _iso_or_none(last.get("at")),
            "outcome": last["outcome"],
            "reason": _s(last.get("reason"), 500),
            "component": comp if isinstance(comp, str) and _ID.fullmatch(comp) else None,
            "jobId": jid if isinstance(jid, str) and _JOB.fullmatch(jid) else None,
        }
    return out


def _unpause_queued() -> list[dict]:
    try:
        names = sorted(n for n in os.listdir(SPOOL_DIR) if _UNPAUSE_FILE.fullmatch(n))
    except OSError:
        return []
    out = []
    for n in names[:MAX_QUEUE * 2]:
        d = _read_json(os.path.join(SPOOL_DIR, n), MAX_SPOOL_BYTES)
        if isinstance(d, dict) and d.get("id") == n[len("unpause-"):-5] and isinstance(d.get("component"), str):
            out.append(d)
    return out


def request_unpause(h, who: str) -> tuple[dict, str]:
    """POST /updates/unpause: check, then write ONE unpause file. Clears nothing itself."""
    body = h.read_json_object(512)
    if set(body) != {"component"}:
        raise Refused("the body is exactly {component}", status=400)
    cid = body["component"]
    if not isinstance(cid, str) or not _ID.fullmatch(cid):
        raise Refused("component must be a catalog id", status=400)
    if cid not in CATALOG.components:
        raise Refused(f"{cid} is not in updates.toml", status=404)
    if flat(who) == AUTO_ACTOR:
        raise Refused(f"{AUTO_ACTOR!r} is the automatic channel's name, not a person's", status=403)
    if cid not in _auto_state()["paused"]:
        raise Refused(f"automatic updates are not paused for {cid}", status=409)
    _spool_ready()
    queue = _unpause_queued()
    if any(q.get("component") == cid for q in queue):
        raise Refused(f"an unpause of {cid} is already waiting for the host", status=409)
    if len(queue) >= MAX_QUEUE:
        raise Refused(f"{len(queue)} unpause requests are already waiting - is bothy-updater.path running?",
                      status=429)
    rid = secrets.token_hex(16)
    _spool_write(rid, f"unpause-{rid}.json",
                 {"v": 1, "kind": "unpause", "id": rid, "component": cid,
                  "requestedBy": flat(who)[:200] or "unknown",
                  "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    return {"id": rid, "component": cid}, f"{cid} unpause {rid}"


# ══ the two asks that make the host RUN something (2026-10-06) ═══════════════
#
# Until now the page could read everything and ask for exactly two things: an
# update, and an unpause. The CLI could do more, and two of those were the only
# cure for a state this page SHOWS and could not change:
#
#   `just updates-discover`   discovery is a six-hourly timer, so the page can be
#                             six hours stale and say so, and the only way to
#                             refresh it was a shell.
#   `just update-auto`        "why did nothing happen last night?" The page shows
#                             the decision; it could not ask for a new one, nor
#                             preview tonight's.
#
# Both keep the shape: ONE file in the spool, and the HOST decides. Neither is a
# new power over this box.
#
#   * Discovery pulls nothing and changes nothing running. It reads the pins, runs
#     `docker inspect` / `kubectl get` / `helm list` read-only, and asks public
#     registries with anonymous tokens. What a compromised bothy-ops gains is
#     timing, plus one bounded resource: Docker Hub's anonymous quota is per public
#     IP and shared with every pull this box makes. So the ask is RATE-LIMITED -
#     here as a courtesy, and again on the host, which is the copy that counts
#     (DISCOVER_MIN_SECONDS, one constant, read by both).
#   * The night job is the host's own gate chain, run early. It still keeps to the
#     window, tonight's backup, one a night, the pauses and the narrow doctor, and
#     it can still only pick an `auto`-channel component's PATCH plan with
#     `confirm: click` - a strict SUBSET of what POST /updates/request already
#     queues. `dry_run` writes nothing whatsoever.
#
# Both are `operator`, not `viewer`. Discovery rewrites available.json and every
# plan file - the facts the whole page is drawn from - and the night job may end in
# a deploy. A read is a read; neither of these is one.
#
# THE ACTOR STAYS HONEST. A real night-job run still writes its update request as
# `auto`, because the night job chose the component, the level and the plan under
# its own gates - that is what the actor means. Who asked it to run early is
# recorded beside it, in asks.json and in admin.log. bothy-ops still refuses to
# write the actor `auto` itself (below), so a record naming `auto` is still only
# ever one the HOST wrote.
#
# What came back is not this process's word for it either: the host records each
# run in asks.json, 600, in the directory bothy-ops mounts READ-ONLY, and this
# re-filters it to an allow-list like every other record here.

# How soon discovery may run again. Both halves read this one constant:
# bothy-ops to refuse early with a number the page can show, and
# updater/asks.py - the half that matters - to refuse a file that got past it.
DISCOVER_MIN_SECONDS = 300
MAX_ASKS_BYTES = 256 * 1024
_DISCOVER_FILE = re.compile(r"discover-([a-f0-9]{32})\.json")
_AUTORUN_FILE = re.compile(r"autorun-([a-f0-9]{32})\.json")
# `ok` discovery ran / the night job requested something; `skipped` a gate said no
# (which is the answer, not a fault); `refused` the file itself was not acceptable;
# `failed` it ran and broke.
ASK_OUTCOMES = ("ok", "skipped", "refused", "failed")


def _ask_queued(pattern: re.Pattern, prefix: str) -> list[dict]:
    """The asks of one kind waiting in the spool. This process wrote them and still
    reads them as untrusted, like _queued()."""
    try:
        names = sorted(n for n in os.listdir(SPOOL_DIR) if pattern.fullmatch(n))
    except OSError:
        return []
    out = []
    for n in names[:MAX_QUEUE * 2]:
        d = _read_json(os.path.join(SPOOL_DIR, n), MAX_SPOOL_BYTES)
        if isinstance(d, dict) and d.get("id") == n[len(prefix):-len(".json")]:
            out.append(d)
    return out


def _asks_state() -> dict:
    """asks.json, allow-listed: the host's record of the last discovery and the last
    night-job run it was ASKED for (the timer's own runs are auto.json's)."""
    doc = _read_json(os.path.join(UPDATES_DIR, "asks.json"), MAX_ASKS_BYTES)
    out: dict = {"discover": None, "autorun": None}
    if not isinstance(doc, dict) or doc.get("version") != 1:
        return out
    for kind in out:
        e = doc.get(kind)
        if not isinstance(e, dict) or e.get("outcome") not in ASK_OUTCOMES:
            continue
        entry = {"at": _iso_or_none(e.get("at")), "askedBy": _s(e.get("askedBy"), 200),
                 "outcome": e["outcome"], "reason": _s(e.get("reason"), 500), "tookMs": _num(e.get("tookMs"))}
        if kind == "autorun":
            comp, jid = e.get("component"), e.get("jobId")
            sk = e.get("skipped") if isinstance(e.get("skipped"), list) else []
            entry.update({
                "dryRun": e.get("dryRun") is True,
                "component": comp if isinstance(comp, str) and _ID.fullmatch(comp) else None,
                "jobId": jid if isinstance(jid, str) and _JOB.fullmatch(jid) else None,
                "skipped": [{"component": d["component"], "why": _s(d.get("why"), 200) or ""}
                            for d in sk[:20] if isinstance(d, dict) and isinstance(d.get("component"), str)
                            and _ID.fullmatch(d["component"])],
            })
        out[kind] = entry
    return out


def request_discover(h, who: str) -> tuple[dict, str]:
    """POST /updates/discover: ask the host to run discovery now. Runs nothing."""
    if h.read_json_object(512):
        raise Refused("the body is exactly {} - discovery takes no parameters", status=400)
    if flat(who) == AUTO_ACTOR:
        raise Refused(f"{AUTO_ACTOR!r} is the automatic channel's name, not a person's", status=403)
    age = _available()[1]["ageSeconds"]
    if age is not None and age < DISCOVER_MIN_SECONDS:
        raise Refused(f"discovery ran {age}s ago and may run again in {DISCOVER_MIN_SECONDS - age}s - it asks "
                      "public registries on an anonymous quota shared with every pull this box makes", status=429)
    _spool_ready()
    if _ask_queued(_DISCOVER_FILE, "discover-"):
        raise Refused("a discovery is already waiting for the host", status=409)
    rid = secrets.token_hex(16)
    _spool_write(rid, f"discover-{rid}.json",
                 {"v": 1, "kind": "discover", "id": rid, "requestedBy": flat(who)[:200] or "unknown",
                  "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    return {"id": rid}, f"discovery {rid} (last ran {age if age is not None else 'never'})"


def request_autorun(h, who: str) -> tuple[dict, str]:
    """POST /updates/autorun: ask the host's night job to decide now. Decides nothing."""
    body = h.read_json_object(512)
    if set(body) != {"dry_run"} or not isinstance(body["dry_run"], bool):
        raise Refused("the body is exactly {dry_run: true|false}", status=400)
    dry = body["dry_run"]
    if flat(who) == AUTO_ACTOR:
        raise Refused(f"{AUTO_ACTOR!r} is the automatic channel's name, not a person's", status=403)
    _spool_ready()
    if _ask_queued(_AUTORUN_FILE, "autorun-"):
        raise Refused("a night-job run is already waiting for the host", status=409)
    if not dry:
        # The night job's own fourth gate, said early so the page can explain it:
        # a night job never queues behind a person's update. The host checks it
        # again, against the spool and status.json it owns.
        cur = _current_job()
        if _queued() or (cur and cur["state"] == "running"):
            raise Refused("an update is queued or running - the night job never queues behind one", status=409)
    rid = secrets.token_hex(16)
    _spool_write(rid, f"autorun-{rid}.json",
                 {"v": 1, "kind": "autorun", "id": rid, "dryRun": dry,
                  "requestedBy": flat(who)[:200] or "unknown",
                  "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    return {"id": rid, "dryRun": dry}, f"night job {rid}" + (" (dry run)" if dry else "")


def job_read(h) -> tuple[dict, str]:
    jid = _one_param(h, "id")[1]
    if not _JOB.fullmatch(jid):
        raise Refused("id must be 32 hex characters", status=400)
    # Spool first, then status.json, then history: the executor writes
    # status.json BEFORE it unlinks the spool file, and history BEFORE the next
    # job replaces status.json - so in this order a job is never missed.
    d = _read_json(os.path.join(SPOOL_DIR, f"{jid}.json"), MAX_SPOOL_BYTES)
    if isinstance(d, dict) and d.get("jobId") == jid:
        return {"job": _queued_job(d)}, f"{jid}: queued"
    cur = _current_job()
    if cur and cur["id"] == jid:
        return {"job": cur}, f"{jid}: {cur['state']}"
    for ln in reversed(_history_lines()):
        if jid not in ln:
            continue
        try:
            e = _job(json.loads(ln), steps=False)
        except ValueError:
            continue
        if e and e["id"] == jid:
            e["steps"] = []
            return {"job": e}, f"{jid}: {e['state']}"
    raise Refused("no such job", status=404)


def audit(who: str, outcome: str, endpoint: str, detail: str = "", took_ms: int | None = None) -> None:
    """time  who  READ|REQUESTED|REFUSED|FAILED|ERROR  updates-<endpoint>  [detail]  [Nms] - admin.log's shape."""
    fields: list[object] = [who, outcome, f"updates-{endpoint}"]
    if detail:
        fields.append(detail)
    if took_ms is not None:
        fields.append(f"{took_ms}ms")
    LOG.write(*fields)


WRITES = ("request", "unpause", "discover", "autorun")


def handle(h, endpoint: str = "status") -> None:
    """GET /updates/{status,plan,job}, POST /updates/{request,unpause,discover,autorun}.

    `h` is the JsonHandler: it holds the CSRF gate, the body ceiling and the actor.
    """
    who = h.actor()
    t0 = time.monotonic()
    method = "POST" if endpoint in WRITES else "GET"
    try:
        h.check_csrf(method)
        if CATALOG is None:
            raise UpdatesError("the update catalog is not loaded", status=503)
        if endpoint == "status":
            if urlparse(h.path).query:
                raise Refused("/updates/status takes no parameters", status=400)
            result = status(CATALOG)
            s = result["summary"]
            code, outcome, detail = 200, "READ", f"{s['updates']} updates, {s['behind']} behind, {s['drift']} drift"
        elif endpoint == "plan":
            result, detail = plan_read(h)
            code, outcome = 200, "READ"
        elif endpoint == "job":
            result, detail = job_read(h)
            code, outcome = 200, "READ"
        elif endpoint == "request":
            result, detail = request_update(h, who)
            code, outcome = 202, "REQUESTED"
        elif endpoint == "unpause":
            result, detail = request_unpause(h, who)
            code, outcome = 202, "REQUESTED"
        elif endpoint == "discover":
            result, detail = request_discover(h, who)
            code, outcome = 202, "REQUESTED"
        elif endpoint == "autorun":
            result, detail = request_autorun(h, who)
            code, outcome = 202, "REQUESTED"
        else:
            raise Refused("no such endpoint", status=404)
        audit(who, outcome, endpoint, detail, int((time.monotonic() - t0) * 1000))
        return h._send(code, {"ok": True, **result})
    except Refused as e:
        audit(who, "REFUSED", endpoint, str(e)[:200], int((time.monotonic() - t0) * 1000))
        return h._send(e.status, {"error": str(e)})
    except UpdatesError as e:
        audit(who, "FAILED", endpoint, str(e)[:200], int((time.monotonic() - t0) * 1000))
        return h._send(e.status, {"error": str(e)})
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"ERROR /updates/{endpoint}: {type(e).__name__}: {e}\n")
        audit(who, "ERROR", endpoint, type(e).__name__)
        return h._send(500, {"error": "internal error"})
