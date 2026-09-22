"""The Postgres major: a guided, MANUAL plan kind `postgres-major` (build step 8).

A major (17 -> 18) cannot open the previous major's data directory, so it is not
an image swap: it is a dump, a NEW volume on the new image, a restore, and a
check that every row came across. `pg_upgrade --link` was rejected (docs/plans/
updates.md §5): it shares data files with the old cluster and so weakens the one
rollback that matters - the old volume, untouched.

── how it fits "deploy only what main pins" ───────────────────────────────────

`main` pins the new major AND the new volume name. So the PR for a Postgres
major changes, in the same commit:

  data/postgres/compose.yml   postgres: image postgres:<N>.<m>@sha256:…
                              its volume  - postgres<N>_data:<data dir>
                              the top-level `volumes:` declaration
  auth/compose.yml            keycloak-db-init: the SAME image (psql on the
                              server's major - the keycloak-db-init rule)

and the updater performs the data move. Until it has, `just up-data` refuses to
start Postgres on the empty new volume (scripts/pg-volume-guard.sh).

── never automatic, never one click ───────────────────────────────────────────

The plan is `confirm: type-name` and `requiresNote`: bothy-ops (operator only)
and then the executor refuse a request without the component's id typed AND a
maintenance note. The night job never offers it (class `database` is outside
AUTO_CLASSES, the channel is `manual`) and the executor refuses the actor `auto`.

── the procedure (every step is a status.json line) ───────────────────────────

  preflight  the nightly pg_dumpall is < 24 h old; free disk >= 3x the data;
             Keycloak healthy and its step-5 canaries green NOW; the new volume
             does not exist yet; the recipes touch nothing else
  pull       the new image, by the digest main pins
  stop       Keycloak, oauth2-proxy and postgres-exporter - every writer - so
             the dump is the last word (the dump comes after this on purpose: a
             dump taken while Keycloak runs loses what it writes until it stops)
  dump       `pg_dumpall` with the NEW major's client into pre-update/, the row
             count of every table read from the dump itself; then the old
             Postgres stops - its volume is never touched again
  create     the new volume postgres<N>_data, and a TEMPORARY container on the
             new image (no network) that initialises it
  load       the dump restored into it; every error line read, and only "role
             <superuser> already exists" (initdb made it) allowed
  compare    every database, and every table's row count, equal to the dump's -
             Keycloak's user count named - then the temporary container goes
  switch     `just up-data`: compose recreates Postgres from main - the new image
             on the new volume, which is already full
  start      `just up-auth`: keycloak-db-init (on the new major), Keycloak,
             oauth2-proxy, keycloak-init
  verify     Keycloak's step-5 canaries (issuer unchanged, realm, keycloak-init,
             the admin token, a real sign-in: viewer 202 / shell 403), and
             Postgres still holds every database and Keycloak's users

── rollback: back to the OLD volume, which is never deleted ────────────────────

Before the switch the tree and the old container are untouched: the temporary
container goes, the old Postgres and the writers start again. After it, the old
image and the old volume name go back on their lines (uncommitted, on purpose,
like every rollback here) and `just up-data` / `just up-auth` put everything
back on them. The NEW volume is kept too, for a person to look at. Deleting the
old volume is a separate, later, manual command the plan names.
"""

from __future__ import annotations

import os
import re
import shutil
import time

import updates
from discover_updates import same_image, split_image

from . import canaries, classes, hostio, pins, record
from .config import Config
from .executor import Refuse as _Refuse, compose_scope
from .hostio import HostError, docker_json, dotenv, iso, run, run_io, tail
from .plans import PLAN_VERSION, PlanRefused, _git_gate, _home, _material_id, _same_image_everywhere, load_available

KIND = "postgres-major"
NOTE_MIN, NOTE_MAX = 10, 500
_KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,62}")
_DB = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_$ .-]{0,62}")
_KC_URL = re.compile(r"jdbc:postgresql://[A-Za-z0-9][A-Za-z0-9_.-]{0,62}(?::\d{1,5})?/([a-z_][a-z0-9_]{0,62})")
_COPY = re.compile(r'COPY ((?:"(?:[^"]|"")*"|[^ ."]+)\.(?:"(?:[^"]|"")*"|[^ ."]+))(?: \(.*\))? FROM stdin;')
_CONNECT = re.compile(r"""\\connect (?:-reuse-previous=on )?(?:"dbname='((?:[^']|'')*)'"|(\S+))""")
COUNT_SQL = (
    "SELECT format('%I.%I', n.nspname, c.relname) || ' ' || "
    "(xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), "
    "false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
    "WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') "
    "AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'")


class Refuse(Exception):
    """Pre-flight said no."""


class StepError(Exception):
    """A step failed after pre-flight."""


# ══ reading a dump: which databases, and how many rows each table had ═════════

def read_dump(path: str) -> dict:
    """{databases: [...], tables: {db: {schema.table: rows}}, complete: bool}
    - counted from the COPY blocks, so "matches the dump" means exactly that."""
    dbs: list[str] = []
    tables: dict[str, dict[str, int]] = {}
    db, table, n, complete = None, None, 0, False
    with open(path, encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            ln = raw.rstrip("\n")
            if table is not None:
                if ln == "\\.":
                    tables.setdefault(db or "?", {})[table] = n
                    table = None
                else:
                    n += 1
                continue
            m = _CONNECT.fullmatch(ln)
            if m:
                db = m.group(1).replace("''", "'") if m.group(1) is not None else m.group(2)
                if db not in dbs:
                    dbs.append(db)
                continue
            m = _COPY.fullmatch(ln)
            if m:
                table, n = m.group(1), 0
                continue
            if ln.startswith("-- PostgreSQL database cluster dump complete"):
                complete = True
    return {"databases": dbs, "tables": tables, "complete": complete and table is None}


# ══ the plan ══════════════════════════════════════════════════════════════════

def _mounts(repo: str, rel: str, service: str) -> list[pins.Line]:
    """The `- <name>:<path>` lines of `service`'s `volumes:` in a compose file."""
    lines = open(os.path.join(repo, rel), encoding="utf-8").read().split("\n")
    out, in_s, in_svc, in_vol = [], False, False, False
    for i, ln in enumerate(lines, 1):
        if not ln.strip() or ln.lstrip().startswith("#"):
            continue
        ind = len(ln) - len(ln.lstrip(" "))
        if ind == 0:
            in_s, in_svc, in_vol = ln.startswith("services:"), False, False
            continue
        if not in_s:
            continue
        if ind == 2:
            in_svc, in_vol = re.fullmatch(rf"{re.escape(service)}:\s*(#.*)?", ln.strip()) is not None, False
            continue
        if in_svc and ind == 4:
            in_vol = re.fullmatch(r"volumes:\s*(#.*)?", ln.strip()) is not None
            continue
        if in_svc and in_vol and ind == 6 and re.fullmatch(r"\s*- [A-Za-z0-9][A-Za-z0-9_.-]*:/\S*(\s+#.*)?", ln):
            out.append(pins.Line(rel, i, ln))
    return out


def _mount_parts(line: pins.Line) -> tuple[str, str]:
    m = re.fullmatch(r"\s*- ([A-Za-z0-9][A-Za-z0-9_.-]*):(/[^\s:#]*)(?::[a-z,]+)?(\s+#.*)?", line.text)
    if not m:
        raise HostError(f"{line.file}:{line.line} is not a plain `- <volume>:<path>` mount")
    return m.group(1), m.group(2)


def _declaration(repo: str, rel: str, key: str) -> pins.Line | None:
    """`  <key>:` under the top-level `volumes:`, or None. Refuses one with options."""
    lines = open(os.path.join(repo, rel), encoding="utf-8").read().split("\n")
    in_v = False
    for i, ln in enumerate(lines, 1):
        if not ln.strip() or ln.lstrip().startswith("#"):
            continue
        if not ln.startswith(" "):
            in_v = ln.rstrip() == "volumes:" or ln.startswith("volumes:")
            continue
        if in_v and re.fullmatch(rf"  {re.escape(key)}:\s*(#.*)?", ln):
            nxt = next((x for x in lines[i:] if x.strip() and not x.lstrip().startswith("#")), "")
            if len(nxt) - len(nxt.lstrip(" ")) > 2:
                raise HostError(f"{rel}:{i}: the volume {key} carries options (name:, external:, driver:) - the "
                                "updater moves Postgres only between two plain declarations")
            return pins.Line(rel, i, ln)
    return None


def _inspect(name: str) -> dict | None:
    j = docker_json(["inspect", "--type", "container", name])
    return j[0] if j else None


def _volume(name: str) -> dict | None:
    j = docker_json(["volume", "inspect", name])
    return j[0] if j else None


def _pgenv(cfg: Config) -> tuple[dict, str]:
    dot = dotenv(cfg.repo)
    env = dict(os.environ)
    env["PGUSER"] = dot.get("POSTGRES_USER") or "dev"
    env["PGPASSWORD"] = dot.get("POSTGRES_PASSWORD") or ""
    return env, env["PGUSER"]


def _psql(container: str, db: str, sql: str) -> list[str]:
    return ["docker", "exec", "-e", "PGUSER", "-e", "PGPASSWORD", container, "psql", "-X", "-At", "-v",
            "ON_ERROR_STOP=1", "-d", db, "-c", sql]


def data_bytes(cfg: Config, container: str) -> int | None:
    env, _ = _pgenv(cfg)
    rc, out, _ = run(_psql(container, "postgres", "SELECT sum(pg_database_size(datname)) FROM pg_database"),
                     env=env, timeout=60)
    return int(out.strip()) if rc == 0 and out.strip().isdigit() else None


def databases(cfg: Config, container: str) -> list[str] | None:
    env, _ = _pgenv(cfg)
    rc, out, _ = run(_psql(container, "postgres", "SELECT datname FROM pg_database WHERE NOT datistemplate "
                                                  "ORDER BY 1"), env=env, timeout=60)
    return [x for x in out.split("\n") if x] if rc == 0 else None


def keycloak_db(cfg: Config) -> str:
    env = {e.split("=", 1)[0]: e.split("=", 1)[1] for e in
           ((_inspect(cfg.pg_keycloak) or {}).get("Config") or {}).get("Env") or [] if "=" in e}
    m = _KC_URL.fullmatch(env.get("KC_DB_URL", ""))
    return m.group(1) if m else "keycloak"


def plan(comp: updates.Component, cfg: Config, catalog: updates.Catalog, available: dict | None,
         target: str | None = None) -> dict:
    if comp.source != "image" or not comp.pins:
        raise PlanRefused("Postgres is a compose image pin")
    parts = [comp.pin_parts(i) for i in range(len(comp.pins))]
    head = _git_gate(cfg, sorted({f for f, _ in parts}))
    try:
        all_pins = [pins.locate(cfg.repo, f, s or "") for f, s in parts]
    except HostError as e:
        raise PlanRefused(str(e)) from None
    for pl in all_pins:
        if not pl.container:
            raise PlanRefused(f"{pl.file}:{pl.service} has no container_name - the updater addresses containers by name")
    # The keycloak-db-init rule: its psql is on the SERVER's major, so it moves in
    # the same plan. Every pin must name exactly the same tag@digest.
    _same_image_everywhere(all_pins)
    server = all_pins[0]
    to = split_image(server.value)
    to_v = updates.parse_version(to["tag"]) if to["tag"] else None
    if not to_v or len(to_v.parts) < 2:
        raise PlanRefused(f"{server.file} pins {server.value} - a Postgres major is deployed from an exact "
                          "`<major>.<minor>@sha256:…` pin only")
    if not to["digest"]:
        raise PlanRefused(f"{server.file} pins {server.value} without a digest - a Postgres major is deployed "
                          "by digest only: pin postgres:<major>.<minor>@sha256:…")
    available = available if available is not None else load_available(cfg)
    e = available["components"].get(comp.id)
    if not isinstance(e, dict):
        raise PlanRefused("not discovered yet - run `just updates-discover`")
    cur = e.get("current") if isinstance(e.get("current"), dict) else {}
    if e.get("image") != to["ref"] or cur.get("tag") != to["tag"] or (cur.get("digest") and
                                                                      cur["digest"] != to["digest"]):
        raise PlanRefused(f"discovery is older than the checkout (it saw {e.get('image')}:{cur.get('tag')}, "
                          f"{server.file} pins {server.value}) - run `just updates-discover`")

    run_ = hostio.container(server.container)
    if run_ is None or run_.get("state") != "running":
        raise PlanRefused(f"{server.container} is not running - the updater moves a running Postgres only")
    if not run_.get("image") or not run_.get("imageId"):
        raise PlanRefused(f"docker inspect {server.container} did not say what it runs")
    frm = split_image(run_["image"])
    from_v = updates.parse_version(frm["tag"]) if frm["tag"] else None
    if frm["ref"] != to["ref"]:
        raise PlanRefused(f"{server.container} runs {frm['ref']}, main pins {to['ref']} - not an update")
    if same_image(run_["image"], server.value):
        raise PlanRefused(f"nothing to deploy: {server.container} runs what main pins ({server.value})")
    if not from_v:
        raise PlanRefused(f"{server.container} runs {run_['image']}, whose major cannot be read")
    if to_v.parts[0] < from_v.parts[0] or (to_v.parts[0] == from_v.parts[0] and to_v.parts <= from_v.parts):
        raise PlanRefused(f"{server.value} is not newer than what runs ({run_['image']}) - a downgrade is done by hand")
    if to_v.parts[0] == from_v.parts[0]:
        raise PlanRefused(f"{from_v.text} -> {to_v.text} is a Postgres MINOR: the updater moves Postgres only across "
                          "a major (the postgres-major procedure). A minor keeps its volume - `just up-data` by hand")
    if target is not None and target not in (to["tag"], server.value):
        raise PlanRefused(f"{target} is not what main pins ({server.value})")
    old_major, new_major = from_v.parts[0], to_v.parts[0]

    # ── the volumes: the one that runs, the one main names ──
    ins = _inspect(server.container) or {}
    data = [m for m in ins.get("Mounts") or [] if m.get("Type") == "volume"
            and str(m.get("Destination", "")).startswith("/var/lib/postgresql")]
    if len(data) != 1:
        raise PlanRefused(f"{server.container} has {len(data)} data volumes under /var/lib/postgresql - expected one")
    old_vol, old_target = data[0].get("Name"), data[0].get("Destination")
    lab = (ins.get("Config") or {}).get("Labels") or {}
    project = lab.get("com.docker.compose.project") or ""
    vol = _volume(old_vol or "") or {}
    vlab = vol.get("Labels") or {}
    old_key = vlab.get("com.docker.compose.volume") or ""
    if not project or vlab.get("com.docker.compose.project") != project or old_vol != f"{project}_{old_key}":
        raise PlanRefused(f"{server.container}'s volume {old_vol} is not a compose volume of project {project!r} - "
                          "the updater moves Postgres only between compose-named volumes")
    try:
        mounts = [m for m in _mounts(cfg.repo, server.file, server.service)
                  if _mount_parts(m)[1].startswith("/var/lib/postgresql")]
        if len(mounts) != 1:
            raise HostError(f"{server.file}: {server.service} mounts {len(mounts)} volumes under /var/lib/postgresql "
                            "- expected one")
        mount = mounts[0]
        new_key, new_target = _mount_parts(mount)
        want_key = f"postgres{new_major}_data"
        if new_key == old_key:
            raise HostError(f"main pins Postgres {new_major} on the SAME volume ({old_key}), which holds a "
                            f"{old_major} data directory it cannot open. The PR for a major also renames the volume: "
                            f"`- {want_key}:…` and its declaration")
        if new_key != want_key:
            raise HostError(f"main mounts {new_key}; a Postgres {new_major} volume is named {want_key} - rename it "
                            "in the PR")
        if new_major >= 18 and new_target == "/var/lib/postgresql/data":
            raise HostError("postgres 18+ keeps its data in /var/lib/postgresql/<major>/docker and refuses a "
                            "mount at /var/lib/postgresql/data - mount the volume at /var/lib/postgresql in the PR")
        decl = _declaration(cfg.repo, server.file, new_key)
        if decl is None:
            raise HostError(f"{server.file} does not declare {new_key} under `volumes:`")
        old_declared = _declaration(cfg.repo, server.file, old_key) is not None
    except (HostError, OSError) as err:
        raise PlanRefused(str(err)) from None
    new_vol = f"{project}_{new_key}"
    if _volume(new_vol) is not None:
        raise PlanRefused(f"the volume {new_vol} already exists (an earlier attempt?). Look at it, then "
                          f"`docker volume rm {new_vol}` - the updater creates it itself, and never deletes one")
    size = data_bytes(cfg, server.container)
    dbs = databases(cfg, server.container)
    kdb = keycloak_db(cfg)

    stops = list(cfg.pg_stop)
    material = {
        "v": PLAN_VERSION, "component": comp.id, "class": comp.cls, "kind": KIND, "container": server.container,
        "from": {"image": run_["image"], "imageId": run_["imageId"], "digest": frm["digest"],
                 "volume": old_vol, "key": old_key, "target": old_target},
        "to": {"image": server.value, "digest": to["digest"], "volume": new_vol, "key": new_key,
               "target": new_target},
        "pin": {"file": server.file, "service": server.service, "line": server.line, "text": server.text,
                "commit": head},
        "pins": [{"file": pl.file, "service": pl.service, "line": pl.line, "text": pl.text,
                  "container": pl.container} for pl in all_pins],
        "mount": {"file": mount.file, "line": mount.line, "text": mount.text},
        "decl": {"file": decl.file, "line": decl.line, "text": decl.text, "oldDeclared": old_declared},
        "recipe": comp.apply, "stops": stops, "start": list(cfg.pg_start),
    }
    mib = f"{size >> 20} MiB" if size is not None else "an unknown amount of"
    return {
        **material,
        "id": _material_id(material),
        "title": comp.title,
        "createdAt": iso(),
        "discoveredAt": available.get("generatedAt"),
        "level": "major",
        # NEVER a click: the component's id typed, AND a maintenance note, checked
        # by bothy-ops and again by the executor.
        "confirm": "type-name",
        "requiresNote": True,
        "from": {**material["from"], "tag": frm["tag"], "version": from_v.text, "container": server.container},
        "to": {**material["to"], "tag": to["tag"], "version": to_v.text},
        "changelog": updates.changelog_url(comp.changelog, to_v.text),
        "oneWay": True, "oneWayWhy": comp.one_way_why,
        "restarts": list(dict.fromkeys([server.container, *stops, *(pl.container for pl in all_pins[1:])])),
        "downtime": (f"the whole move, start to finish: {', '.join(stops)} stop FIRST and the database is "
                     f"unavailable until the switch. Every gated route (sso-viewer, sso-editor, sso-operator, "
                     f"Headlamp) FAILS CLOSED meanwhile. Roughly 2-4 min plus the dump and restore of {mib} data"),
        "signedOut": ("nobody by the move itself - Keycloak's sessions are rows in its database, and every row is "
                      "copied and counted - but nobody can sign in during it. Anything another project writes to "
                      "the dev database after the dump is NOT in the new cluster: stop those projects first"),
        "snapshot": {"kind": "pg-dumpall",
                     "what": (f"a pg_dumpall of every database with Postgres {new_major}'s client, taken after "
                              f"the writers stop, plus every table's row count read from it; and the OLD volume "
                              f"{old_vol} itself, which is stopped, never touched and never deleted"),
                     "dir": _home(os.path.join(cfg.snapshots, f"<time>-{comp.id}")) + "/", "estimateBytes": size},
        "preflight": [
            "the plan is still current: recomputed from main, the running container and discovery, it has this id",
            "the request carries the component's id typed AND a maintenance note, and was made by a person",
            "the nightly pg_dumpall in ~/backups/postgres is under 24 h old",
            f"free disk: at least 3x the data ({mib}) for Docker, and twice it for the dump",
            f"{server.container} is running and healthy on {run_['image']}, on {old_vol}; {new_vol} does not exist",
            f"{cfg.pg_keycloak} is healthy and Keycloak's canaries pass NOW (the same ones as its own update)",
            f"`{comp.apply}` and `just {' / just '.join(cfg.pg_start)}` would recreate only the pinned services",
            "no other update is running (one global lock)",
        ],
        "procedure": [
            f"pre-flight (above) - nothing is touched until every item holds",
            f"pull {server.value}",
            f"stop the writers: {', '.join(stops)}",
            f"pg_dumpall into pre-update/ with Postgres {new_major}'s client; count every table's rows in the dump; "
            f"stop the old Postgres ({old_vol} is not touched again)",
            f"create {new_vol} and a temporary Postgres {new_major} on it (no network)",
            "restore the dump into it - only `role <superuser> already exists` is an allowed error",
            f"compare: every database, every table's row count, Keycloak's users ({kdb}.public.user_entity) - "
            "equal to the dump's; then the temporary container goes",
            f"switch: `{comp.apply}` recreates {server.container} from main - Postgres {new_major} on {new_vol}",
            f"start: `just {' / just '.join(cfg.pg_start)}` - keycloak-db-init on Postgres {new_major}, Keycloak, "
            "oauth2-proxy, keycloak-init",
            "verify with Keycloak's canaries; every database and Keycloak's users are still there",
        ],
        "verify": [
            "every database of the dump exists in the new cluster, and every table's row count equals the dump's",
            f"Keycloak's user count ({kdb}.public.user_entity) equals the dump's",
            f"both pins run {to_v.text} (the keycloak-db-init major rule)",
            *(c.describe for c in canaries.for_component(cfg, "keycloak")),
        ],
        "rollback": classes.CLASSES["database"].rollback + f" The old volume {old_vol} is deleted only by hand, "
                    f"later: `docker volume rm {old_vol}`.",
        "pgMajor": {"fromMajor": old_major, "toMajor": new_major, "oldVolume": old_vol, "newVolume": new_vol,
                    "oldMount": old_target, "newMount": new_target, "dataBytes": size, "databases": dbs,
                    "keycloakDb": kdb, "stops": stops, "deleteOld": f"docker volume rm {old_vol}"},
    }


# ══ the executor ══════════════════════════════════════════════════════════════

class PgMajorExecution:
    def __init__(self, cfg: Config, rec: record.Recorder, comp: updates.Component, plan_: dict,
                 note: str) -> None:
        self.cfg = cfg
        self.rec = rec
        self.comp = comp
        self.plan = plan_
        self.note = note
        self.server = plan_["container"]
        self.tmp = f"{self.server}-major{plan_['pgMajor']['toMajor']}-{rec.job['id'][:8]}"
        self.kc_ctx = canaries.Ctx(cfg, cfg.pg_keycloak, phase="preflight", plan=plan_)
        self.kc_canaries = canaries.for_component(cfg, "keycloak")
        self.stopped: list[str] = []
        self.old_stopped = False
        self.switched = False
        self.snap: str | None = None
        self.dump: dict | None = None
        self.new_image_id: str | None = None
        self.env, self.superuser = _pgenv(cfg)

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
            self.step("pull", self.pull)
        except StepError as e:
            return self.rec.finish("aborted", f"{e} - nothing running was changed")["state"]
        try:
            for name, fn in (("stop", self.stop), ("dump", self.dump_), ("create", self.create), ("load", self.load),
                             ("compare", self.compare), ("switch", self.switch), ("start", self.start),
                             ("verify", self.verify)):
                self.step(name, fn)
        except StepError as e:
            return self.rollback(e)
        return self.rec.finish("succeeded", note=(
            f"Postgres {self.plan['to']['version']} runs on {self.plan['to']['volume']}, which main pins. The OLD volume "
            f"{self.plan['from']['volume']} is kept, stopped and untouched: when you are sure, delete it by hand - "
            f"`{self.plan['pgMajor']['deleteOld']}`. Maintenance note: {self.note}"))["state"]

    # ── pre-flight ──
    def preflight(self) -> str:
        p, cfg = self.plan, self.cfg
        c = hostio.container(self.server)
        if not c or c["state"] != "running":
            raise Refuse(f"{self.server} is not running")
        if c["imageId"] != p["from"]["imageId"]:
            raise Refuse(f"{self.server} changed since the plan was made")
        if c["health"] not in (None, "healthy"):
            raise Refuse(f"{self.server} is {c['health']} - fix it before moving it")
        vols = [m.get("Name") for m in (_inspect(self.server) or {}).get("Mounts") or [] if m.get("Type") == "volume"]
        if p["from"]["volume"] not in vols:
            raise Refuse(f"{self.server} no longer mounts {p['from']['volume']}")
        if _volume(p["to"]["volume"]) is not None:
            raise Refuse(f"{p['to']['volume']} exists already - look at it, then `docker volume rm` it")
        # The nightly pg_dumpall is fresh.
        d = os.path.join(cfg.backups, "postgres")
        try:
            newest = max((os.path.getmtime(os.path.join(d, f)) for f in os.listdir(d)
                          if not f.startswith(".") and os.path.isfile(os.path.join(d, f))), default=None)
        except OSError:
            newest = None
        if newest is None or newest < time.time() - cfg.backup_max_age:
            raise Refuse(f"the newest pg_dumpall in {d} is {'missing' if newest is None else 'older than 24 h'} - "
                         "run `just backup` first")
        size = data_bytes(cfg, self.server)
        if size is None:
            raise Refuse(f"the size of the data in {self.server} could not be read")
        for where, factor in ((hostio.docker_root(), 3), (cfg.backups, 2)):
            free = hostio.free_bytes(where)
            need = max(factor * size, cfg.min_free_bytes)
            if free is not None and free < need:
                raise Refuse(f"{free >> 20} MiB free under {where}; the move needs {factor}x the data ({need >> 20} MiB)")
        kc = hostio.container(cfg.pg_keycloak)
        if not kc or kc["state"] != "running" or kc["health"] not in (None, "healthy"):
            raise Refuse(f"{cfg.pg_keycloak} is not running and healthy - its canaries are how the move is verified")
        self.kc_ctx.phase = "preflight"
        for cn in self.kc_canaries:
            ok, dd = False, ""
            for _ in range(3):
                ok, dd = cn.check(self.kc_ctx)
                if ok:
                    break
                time.sleep(3)
            if not ok:
                raise Refuse(f"before the move, {cn.describe} does not hold ({dd})")
        try:
            scope = [compose_scope(cfg, q["container"], q["file"], q["service"], {q["service"]},
                                   p["recipe"] if i == 0 else f"just {cfg.pg_start[0]}")
                     for i, q in enumerate(p["pins"]) if hostio.container(q["container"])]
        except _Refuse as e:
            raise Refuse(str(e)) from None
        if not hostio.which("just"):
            raise Refuse("`just` is not on PATH")
        return (f"{self.server} healthy on {p['from']['volume']}; {size >> 20} MiB of data, disk ok; "
                f"{cfg.pg_keycloak} and its {len(self.kc_canaries)} canaries green; {'; '.join(scope)}")

    # ── pull ──
    def pull(self) -> str:
        ref = self.plan["to"]["image"]
        rc, out, err = run(["docker", "pull", ref], timeout=900)
        if rc != 0:
            raise StepError(f"docker pull {ref} failed: {tail(err or out, 300)}")
        img = hostio.image(ref)
        if not img:
            raise StepError(f"{ref} is not in the local store after the pull")
        got = hostio.repo_digest(img, split_image(ref)["ref"])
        if got != self.plan["to"]["digest"]:
            raise StepError(f"{ref} is {got} locally, the plan says {self.plan['to']['digest']}")
        self.new_image_id = img["id"]
        return f"{ref} ({img['id'][:19]})"

    # ── stop the writers ──
    def stop(self) -> str:
        for name in self.plan["stops"]:
            c = hostio.container(name)
            if not c or c["state"] != "running":
                continue
            rc, _, err = run(["docker", "stop", "-t", "60", name], timeout=120)
            if rc != 0:
                raise StepError(f"{name} would not stop: {tail(err, 200)}")
            self.stopped.append(name)
        return f"stopped {', '.join(self.stopped) or 'nothing (none was running)'}"

    # ── dump, with the NEW major's client; then the old server stops ──
    def dump_(self) -> str:
        hostio.ensure_dir(self.cfg.snapshots, 0o700)
        d = os.path.join(self.cfg.snapshots, f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{self.comp.id}")
        os.mkdir(d, 0o700)
        self.snap = d
        self.rec.set(snapshot=d)
        hostio.write_json(os.path.join(d, "plan.json"), self.plan)
        for q in self.plan["pins"]:
            dst = os.path.join(d, q["file"].replace("/", "__"))
            if not os.path.exists(dst):
                shutil.copyfile(os.path.join(self.cfg.repo, q["file"]), dst)
                os.chmod(dst, 0o600)
        out = os.path.join(d, "dumpall.sql")
        rc, err = run_io(["docker", "run", "--rm", "--network", f"container:{self.server}", "-e", "PGUSER",
                          "-e", "PGPASSWORD", self.plan["to"]["image"], "pg_dumpall", "-h", "127.0.0.1",
                          "--no-password"], stdout_path=out, env=self.env, timeout=self.cfg.pg_restore_timeout)
        if rc != 0:
            raise StepError(f"pg_dumpall failed: {err}")
        self.dump = read_dump(out)
        if not self.dump["complete"] or not self.dump["databases"]:
            raise StepError("the dump is incomplete (no `cluster dump complete` line, or no database in it)")
        hostio.write_json(os.path.join(d, "counts.json"), self.dump)
        rows = sum(sum(t.values()) for t in self.dump["tables"].values())
        rc, _, err = run(["docker", "stop", "-t", "120", self.server], timeout=180)
        if rc != 0:
            raise StepError(f"the old {self.server} would not stop: {tail(err, 200)}")
        self.old_stopped = True
        return (f"{os.path.getsize(out) >> 10} KiB, {len(self.dump['databases'])} databases, "
                f"{sum(len(t) for t in self.dump['tables'].values())} tables, {rows} rows; the old {self.server} "
                f"stopped, {self.plan['from']['volume']} untouched")

    # ── a new volume, a temporary container on it ──
    def create(self) -> str:
        p = self.plan
        project = p["from"]["volume"][:-len(p["from"]["key"]) - 1]
        rc, _, err = run(["docker", "volume", "create", "--label", f"com.docker.compose.project={project}",
                          "--label", f"com.docker.compose.volume={p['to']['key']}",
                          "--label", f"bothy.updater.job={self.rec.job['id']}", p["to"]["volume"]], timeout=30)
        if rc != 0:
            raise StepError(f"docker volume create {p['to']['volume']}: {tail(err, 200)}")
        env = dict(self.env)
        env["POSTGRES_USER"], env["POSTGRES_PASSWORD"] = self.env["PGUSER"], self.env["PGPASSWORD"]
        rc, _, err = run(["docker", "run", "-d", "--name", self.tmp, "--network", "none",
                          "--label", f"bothy.updater.job={self.rec.job['id']}",
                          "-v", f"{p['to']['volume']}:{p['to']['target']}", "-e", "POSTGRES_USER", "-e",
                          "POSTGRES_PASSWORD", "-e", "POSTGRES_DB=postgres", p["to"]["image"]], env=env, timeout=60)
        if rc != 0:
            raise StepError(f"the temporary Postgres would not start: {tail(err, 200)}")
        deadline = time.monotonic() + self.cfg.pg_ready_timeout
        while True:
            # TCP, not the socket: during initdb the entrypoint's server listens on
            # the socket only, so a socket answer could come from the one it restarts.
            rc, _, _ = run(["docker", "exec", "-e", "PGUSER", self.tmp, "pg_isready", "-q", "-h", "127.0.0.1"],
                           env=self.env, timeout=20)
            if rc == 0:
                break
            c = hostio.container(self.tmp) or {}
            if c.get("state") != "running" or time.monotonic() > deadline:
                _, logs, lerr = run(["docker", "logs", "--tail", "20", self.tmp], timeout=20)
                raise StepError(f"the temporary Postgres is {c.get('state')} and not ready: {tail(logs + lerr, 300)}")
            time.sleep(2)
        return f"{p['to']['volume']} created; {self.tmp} ({p['to']['image'].split('@')[0]}) ready on it, no network"

    # ── load the dump ──
    def load(self) -> str:
        errf = os.path.join(self.snap or "", "load.stderr")
        rc, err = run_io(["docker", "exec", "-i", "-e", "PGUSER", "-e", "PGPASSWORD", self.tmp, "psql", "-X", "-q",
                          "-v", "ON_ERROR_STOP=0", "-d", "postgres", "-f", "-"],
                         stdin_path=os.path.join(self.snap or "", "dumpall.sql"), stderr_path=errf, env=self.env,
                         timeout=self.cfg.pg_restore_timeout)
        allowed = f'role "{self.superuser}" already exists'
        errors = []
        with open(errf, encoding="utf-8", errors="replace") as fh:
            for ln in fh:
                m = re.search(r"\bERROR:\s+(.*)", ln)
                if m and m.group(1).strip() != allowed:
                    errors.append(m.group(1).strip())
        if rc != 0 or errors:
            raise StepError(f"the restore reported {len(errors)} error(s) (exit {rc}): {'; '.join(errors[:3])[:300]}")
        return f"restored into {self.plan['to']['volume']}; the only error was the expected `{allowed}`"

    # ── compare: every database and every row count, against the dump ──
    def counts(self, container: str) -> tuple[list[str], dict[str, dict[str, int]]]:
        rc, out, err = run(_psql(container, "postgres", "SELECT datname FROM pg_database WHERE datallowconn "
                                                        "ORDER BY 1"), env=self.env, timeout=60)
        if rc != 0:
            raise StepError(f"the new cluster's databases could not be listed: {tail(err, 200)}")
        dbs = [x for x in out.split("\n") if x]
        got: dict[str, dict[str, int]] = {}
        for db in (x for x in self.dump["databases"] if x in dbs):
            rc, out, err = run(_psql(container, db, COUNT_SQL), env=self.env, timeout=self.cfg.pg_restore_timeout)
            if rc != 0:
                raise StepError(f"counting rows in {db} failed: {tail(err, 200)}")
            got[db] = {}
            for ln in out.split("\n"):
                name, _, n = ln.rpartition(" ")
                if name and n.isdigit():
                    got[db][name] = int(n)
        return dbs, got

    def _differences(self, dbs: list[str], got: dict) -> list[str]:
        diff = [f"database {db} is missing" for db in self.dump["databases"] if db not in dbs]
        for db, tables in self.dump["tables"].items():
            for t, n in tables.items():
                have = got.get(db, {}).get(t)
                if have != n:
                    diff.append(f"{db}.{t}: {have} rows, the dump has {n}")
        return diff

    def _users(self, got: dict) -> str:
        kdb = self.plan["pgMajor"]["keycloakDb"]
        want = self.dump["tables"].get(kdb, {}).get("public.user_entity")
        if want is None:
            return f"no {kdb}.public.user_entity in the dump"
        have = got.get(kdb, {}).get("public.user_entity")
        if have != want:
            raise StepError(f"Keycloak's user count: {have}, the dump has {want}")
        return f"Keycloak's users: {have}, as in the dump"

    def compare(self) -> str:
        if self.cfg.pg_force_fail == "compare":
            raise StepError("the comparison was forced to fail (a test)")
        dbs, got = self.counts(self.tmp)
        diff = self._differences(dbs, got)
        if diff:
            raise StepError(f"{len(diff)} difference(s) from the dump: {'; '.join(diff[:4])}")
        users = self._users(got)
        n = sum(len(t) for t in self.dump["tables"].values())
        run(["docker", "rm", "-f", self.tmp], timeout=120)
        return (f"{len(self.dump['databases'])} databases and {n} tables, every row count equal to the dump's; "
                f"{users}; {self.tmp} removed ({self.plan['to']['volume']} kept)")

    # ── switch and start: main's compose, now that the new volume is full ──
    def _just(self, recipe: str) -> None:
        just = hostio.which("just")
        if not just:
            raise StepError("`just` is not on PATH")
        rc, out, err = run([just, "--justfile", os.path.join(self.cfg.repo, "justfile"), "--working-directory",
                            self.cfg.repo, recipe], timeout=self.cfg.apply_timeout, cwd=self.cfg.repo)
        if rc != 0:
            raise StepError(f"`just {recipe}` exited {rc}: {tail(err or out, 300)}")

    def _on(self, image_id: str, volume: str) -> tuple[bool, str]:
        deadline = time.monotonic() + self.cfg.verify_timeout
        while True:
            c = hostio.container(self.server) or {}
            vols = [m.get("Name") for m in (_inspect(self.server) or {}).get("Mounts") or []
                    if m.get("Type") == "volume"]
            if c.get("imageId") == image_id and volume in vols and c.get("state") == "running" \
                    and c.get("health") in (None, "healthy"):
                return True, f"{self.server} {c.get('health') or 'running'} on {volume}"
            if time.monotonic() > deadline:
                return False, (f"{self.server} is {c.get('state')}/{c.get('health')}, image "
                               f"{str(c.get('imageId'))[:19]}, volumes {vols}")
            time.sleep(2)

    def switch(self) -> str:
        self.switched = True
        self._just(self.plan["recipe"].split()[1])
        ok, d = self._on(self.new_image_id or "", self.plan["to"]["volume"])
        if not ok:
            raise StepError(d)
        return f"`{self.plan['recipe']}`: {d}"

    def start(self) -> str:
        for r in self.plan["start"]:
            self._just(r)
        return f"`just {' / just '.join(self.plan['start'])}` done"

    def verify(self) -> str:
        if self.cfg.pg_force_fail == "verify":
            raise StepError("verify was forced to fail (a test)")
        dbs, got = self.counts(self.server)
        missing = [db for db in self.dump["databases"] if db not in dbs]
        if missing:
            raise StepError(f"after the switch, {', '.join(missing)} missing")
        users = self._users(got)
        for q in self.plan["pins"]:
            c = hostio.container(q["container"])
            if c and not same_image(c.get("image") or "", self.plan["to"]["image"]):
                raise StepError(f"{q['container']} runs {c.get('image')}, not {self.plan['to']['image']} - the "
                                "keycloak-db-init rule: every pin on the new major")
        ok, d = self._kc("verify")
        if not ok:
            raise StepError(d)
        return f"{len(dbs)} databases; {users}; {d}"

    def _kc(self, phase: str) -> tuple[bool, str]:
        self.kc_ctx.phase = phase
        deadline = time.monotonic() + self.cfg.verify_timeout
        for cn in self.kc_canaries:
            while True:
                ok, d = cn.check(self.kc_ctx)
                if ok or not cn.retry or time.monotonic() > deadline:
                    break
                time.sleep(3)
            if not ok:
                return False, f"{cn.describe}: {d}"
        return True, f"Keycloak's {len(self.kc_canaries)} canaries green"

    # ── rollback: to the OLD volume ──
    def rollback(self, cause: Exception) -> str:
        self.rec.step("rollback", "running", f"because {cause}")
        try:
            detail = self._back_after_switch() if self.switched else self._back_before_switch()
        except (StepError, HostError, OSError) as e:
            self.rec.step("rollback", "failed", str(e))
            return self.rec.finish("failed", f"{cause}; and the rollback failed: {e}", note=self._note())["state"]
        ok, d = self._on(self.plan["from"]["imageId"], self.plan["from"]["volume"])
        ok2, d2 = self._kc("rollback") if ok else (False, "")
        if not (ok and ok2):
            self.rec.step("rollback", "failed", d if not ok else d2)
            return self.rec.finish("failed", f"{cause}; after the rollback: {d if not ok else d2}",
                                   note=self._note())["state"]
        self.rec.step("rollback", "ok", f"{detail}; {d}; {d2}")
        return self.rec.finish("rolled_back", str(cause), note=self._note())["state"]

    def _back_before_switch(self) -> str:
        """Nothing in the tree moved and the old container still exists, stopped."""
        run(["docker", "rm", "-f", self.tmp], timeout=120)
        if self.old_stopped:
            rc, _, err = run(["docker", "start", self.server], timeout=120)
            if rc != 0:
                raise StepError(f"the old {self.server} would not start: {tail(err, 200)}")
            ok, d = self._on(self.plan["from"]["imageId"], self.plan["from"]["volume"])
            if not ok:
                raise StepError(d)
        for name in self.stopped:
            rc, _, err = run(["docker", "start", name], timeout=120)
            if rc != 0:
                raise StepError(f"{name} would not start again: {tail(err, 200)}")
            classes._wait_healthy(name, 300)
        # keycloak-init ran against the Keycloak that just restarted: the same
        # one-shot `just up-auth` runs after it (and its canary checks for).
        if self.cfg.pg_keycloak in self.stopped and hostio.container("keycloak-init"):
            run(["docker", "start", "-a", "keycloak-init"], timeout=300)
        return (f"before the switch: {self.tmp} removed, the old {self.server} and {', '.join(self.stopped) or '-'} "
                "started again; the tree was never changed")

    def _back_after_switch(self) -> str:
        """main's compose now names the new image and volume: write the OLD ones back."""
        p = self.plan
        for name in [*p["stops"], self.server]:
            if (hostio.container(name) or {}).get("state") == "running":
                run(["docker", "stop", "-t", "60", name], timeout=120)
        old = p["from"]["image"]
        for q in p["pins"]:
            pins.replace(self.cfg.repo, pins.PinLine(q["file"], q["service"], q["line"], q["text"], p["to"]["image"],
                                                     q["container"]), old)
        m = pins.Line(p["mount"]["file"], p["mount"]["line"], p["mount"]["text"])
        pins.write_line(self.cfg.repo, m, pins.swap(m, f"{p['to']['key']}:{p['to']['target']}",
                                                    f"{p['from']['key']}:{p['from']['target']}"))
        if not p["decl"]["oldDeclared"]:
            dl = pins.Line(p["decl"]["file"], p["decl"]["line"], p["decl"]["text"])
            pins.write_line(self.cfg.repo, dl, pins.swap(dl, p["to"]["key"], p["from"]["key"]))
        self._just(p["recipe"].split()[1])
        for r in p["start"]:
            self._just(r)
        return (f"after the switch: the old image and {p['from']['key']} written back on their lines (uncommitted), "
                f"`{p['recipe']}` and `just {' / just '.join(p['start'])}` run again")

    def _note(self) -> str:
        p = self.plan
        s = (f"The old volume {p['from']['volume']} was never touched. The new one, {p['to']['volume']}, is kept for "
             f"you to look at - `docker volume rm {p['to']['volume']}` when done, or the next plan refuses.")
        if self.switched:
            files = sorted({q["file"] for q in p["pins"]} | {p["mount"]["file"]})
            s += (f" {', '.join(files)} now pin the OLD image and volume LOCALLY (uncommitted, on purpose) so the "
                  f"next `just up` keeps the version that works; main still pins {p['to']['image']}. Find out why, "
                  f"then `git checkout -- {' '.join(files)}` and run the move again.")
            s += " Anything written to the new cluster after the switch is not in the old volume."
        if self.snap:
            s += f" The dump and its row counts: {self.snap}."
        return s + f" Maintenance note: {self.note}"


def validate_note(doc: dict, plan_: dict) -> str | None:
    """The executor's half of "never one click": a postgres-major request carries
    a maintenance note and was made by a person. Returns the note (or None for
    any other kind of plan, which must carry none). Raises ValueError."""
    note = doc.get("note")
    if plan_.get("kind") != KIND:
        if note is not None:
            raise ValueError("a maintenance note is only for a plan that requires one")
        return None
    if doc.get("requestedBy") == "auto":
        raise ValueError("a Postgres major is never automatic")
    if not isinstance(note, str) or not NOTE_MIN <= len(note.strip()) <= NOTE_MAX:
        raise ValueError(f"a Postgres major needs a maintenance note ({NOTE_MIN}-{NOTE_MAX} characters): what, why, "
                         "and who is told")
    return note.strip()
