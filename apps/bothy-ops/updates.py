"""Updates - the catalog, and the one READ that serves it.

    GET /updates/status     the catalog (updates.toml) merged with what the host
                            last discovered (available.json) - viewer

Build step 3 of docs/plans/updates.md: discovery and a read-only Settings page.
There is no apply, no request route and no spool. Nothing here runs anything,
pulls anything or writes anything except its own audit line.

── two halves, two processes ─────────────────────────────────────────────────

  load_catalog()      the strict parser for updates.toml. Used HERE, where a
                      malformed catalog refuses the start of bothy-ops, and by
                      discover_updates.py ON THE HOST, which must not trust a
                      catalog bothy-ops would refuse.
  status()/handle()   bothy-ops only. Reads available.json from a READ-ONLY
                      mount of ~/.local/state/bothy/updates and re-filters every
                      field to an allow-list, the admin.py "second lock": the host
                      writer is trusted to be right, not to be the only check.

Registry calls, docker inspect and git are the host's job (discover_updates.py);
this process holds none of the credentials or sockets that would take, and it
must not grow a network path to the internet for a page to be drawn.

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
import sys
import time
import tomllib
from dataclasses import dataclass
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
try:
    import bothy_common  # noqa: F401  (in the image it sits beside this file)
except ImportError:  # a checkout, or the host-side discoverer
    sys.path.insert(0, os.path.join(os.path.dirname(HERE), "bothy-common"))

from bothy_common.audit import AuditLog  # noqa: E402
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
        if not _SHELLVAR.fullmatch(name):
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


def status(catalog: Catalog) -> dict:
    doc, meta = _available()
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
        })
    summary = {
        "components": len(rows),
        "updates": sum(1 for r in rows if r["level"]),
        "behind": sum(1 for r in rows if r["behind"]),
        "drift": sum(1 for r in rows if r["discovered"] and r["discovered"]["drift"]),
        "errors": sum(1 for r in rows if r["discovered"] and r["discovered"]["error"]),
    }
    p = catalog.policy
    return {"discovery": meta, "summary": summary,
            "policy": {"windowStart": p.window_start, "windowEnd": p.window_end,
                       "requireBackup": p.require_backup, "requireDoctor": p.require_doctor,
                       "maxAutoPerNight": p.max_auto_per_night, "pauseOnFailure": p.pause_on_failure,
                       "discoverEveryHours": p.discover_every_hours},
            "applying": False,
            "components": rows}


def audit(who: str, outcome: str, detail: str = "", took_ms: int | None = None) -> None:
    """time  who  READ|REFUSED|FAILED|ERROR  updates-status  [detail]  [Nms] - admin.log's shape."""
    fields: list[object] = [who, outcome, "updates-status"]
    if detail:
        fields.append(detail)
    if took_ms is not None:
        fields.append(f"{took_ms}ms")
    LOG.write(*fields)


def handle(h) -> None:
    """GET /updates/status. `h` is the bothy-ops JsonHandler."""
    who = h.actor()
    t0 = time.monotonic()
    try:
        h.check_csrf("GET")
        if urlparse(h.path).query:
            raise Refused("/updates/status takes no parameters", status=400)
        if CATALOG is None:
            raise UpdatesError("the update catalog is not loaded", status=503)
        result = status(CATALOG)
        s = result["summary"]
        audit(who, "READ", f"{s['updates']} updates, {s['behind']} behind, {s['drift']} drift",
              int((time.monotonic() - t0) * 1000))
        return h._send(200, {"ok": True, **result})
    except Refused as e:
        audit(who, "REFUSED", str(e)[:200], int((time.monotonic() - t0) * 1000))
        return h._send(e.status, {"error": str(e)})
    except UpdatesError as e:
        audit(who, "FAILED", str(e)[:200], int((time.monotonic() - t0) * 1000))
        return h._send(e.status, {"error": str(e)})
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"ERROR /updates/status: {type(e).__name__}: {e}\n")
        audit(who, "ERROR", type(e).__name__)
        return h._send(500, {"error": "internal error"})
