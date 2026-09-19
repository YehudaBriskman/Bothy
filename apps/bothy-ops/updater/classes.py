"""The update classes the executor handles, and what each one means.

docs/plans/updates.md §4 names eight classes. The updater handles THREE -
`stateless` and `timeseries` (step 4), and the one-way `app-db` (step 5:
Grafana and Keycloak) - and refuses the rest at plan time, in words. A class is
four things, and adding one (step 6: own-code) is writing these four for it and
adding it to CLASSES:

  plan words   what the plan tells a person: the snapshot, the downtime, who is
               signed out, the rollback rule
  snapshot     what is saved before anything changes (the executor always saves
               the pin line, the compose file, the plan and the old image's
               identity; a class adds its DATA)
  canaries     per component, in canaries.py (the class decides whether a
               history probe - and so a data restore - exists at all)
  restore      how the class's data snapshot is put back, when the rollback rule
               says it must be
"""

from __future__ import annotations

import os
import re
import tarfile
import time

from .hostio import HostError, container, docker_json, dotenv, read_json, run, run_io, tail, write_json

# Per-component words for the plan. Estimates, measured where the backup work
# measured them (docs/guide/backups.md), stated as ranges on purpose.
DOWNTIME = {
    "cadvisor": "~10-30 s while cadvisor is recreated: container metrics miss a scrape or two",
    "node-exporter": "~10-30 s while node-exporter is recreated: host metrics miss a scrape or two",
    "postgres-exporter": "~10-30 s while postgres-exporter is recreated: pg_* metrics miss a scrape or two. "
                         "Postgres itself is not touched",
    "alloy": "~10-30 s while Alloy is recreated: log shipping pauses and resumes from its saved "
             "positions - nothing is lost",
    "headlamp": "~10-30 s while Headlamp is recreated: :8110 answers 502 until it is healthy",
    "victoriametrics": "~10-30 s while VictoriaMetrics is recreated: queries fail (Grafana panels, the "
                       "portal's vitals) and a scrape or two is missed",
    "loki": "~30-60 s in two pieces: a few seconds stopped for the snapshot, then the recreate and "
            "Loki's ~15 s ring delay before /ready. Alloy retries, so no line is lost",
}
SIGNED_OUT = {
    "headlamp": "nobody - Headlamp sessions live in oauth2-proxy-headlamp, which keeps its cookie secret",
}


class UpdateClass:
    name = ""
    rollback = ""
    history = False                  # does verify carry a data-loss probe?
    # One-way: the rollback restores the data snapshot FIRST, whatever the
    # probes say, and only then puts the previous image back.
    always_restore = False

    def snapshot_kind(self, cid: str) -> str:
        return "image"

    def backup_kinds(self, cid: str) -> tuple[str, ...]:
        """The ~/backups/<kind> directories whose newest file must be < 24 h old."""
        return ("postgres",)

    def downtime(self, cfg, cid: str) -> str:
        return (cfg.specifics.get(cid, {}).get("downtime") or DOWNTIME.get(cid)
                or "~10-30 s while the container is recreated")

    def signed_out(self, cfg, cid: str) -> str:
        return cfg.specifics.get(cid, {}).get("signedOut") or SIGNED_OUT.get(cid) or "nobody"

    def snapshot_words(self, cid: str) -> str:
        return ("the pin line, the compose file, this plan and the old image's id and digest - "
                "the old image stays in the local store, which is what a rollback runs")

    def estimate(self, cfg, cid: str) -> int | None:
        return 0

    def take_snapshot(self, cfg, cid: str, container: str, dirpath: str) -> tuple[str | None, str]:
        """The class's DATA snapshot: (artefact path or None, detail)."""
        return None, "no data to save: the image is the whole state"

    def restore(self, cfg, cid: str, container: str, artefact: str) -> tuple[bool, str]:
        return False, "this class has no data snapshot to restore"


class Stateless(UpdateClass):
    name = "stateless"
    rollback = ("On any failure after the pull: the previous image goes back on the pin line (a one-line "
                "edit of the working tree, left uncommitted on purpose) and the recipe runs again; the old "
                "image must then pass the same canaries. There is no data to restore.")


# Time-series component -> the scripts/snapshot.sh and scripts/restore.sh kind,
# and the environment variable backup-lib.sh reads its container from.
TIMESERIES = {
    "victoriametrics": ("victoriametrics", "vm.tar", "BK_VM"),
    "loki": ("loki", "loki.tar.gz", "BK_LOKI"),
}


class Timeseries(UpdateClass):
    name = "timeseries"
    history = True
    rollback = ("On any failure after the pull: the previous image goes back on the pin line (left "
                "uncommitted) and the recipe runs again. The data snapshot is restored ONLY if the history "
                "probe still fails under the OLD image - i.e. history written before the update is "
                "unreadable by the version that wrote it. A restore discards everything written since the "
                "snapshot, so it is never the first move.")

    def snapshot_kind(self, cid: str) -> str:
        return TIMESERIES[cid][0]

    def backup_kinds(self, cid: str) -> tuple[str, ...]:
        return ("postgres", TIMESERIES[cid][0])

    def snapshot_words(self, cid: str) -> str:
        if cid == "loki":
            data = "Loki flushed, STOPPED for a few seconds and /loki tarred (bk_snapshot_loki)"
        else:
            data = "a VictoriaMetrics /snapshot/create, tarred and deleted (bk_snapshot_vm) - no downtime"
        return f"{data}; plus the pin line, the compose file, this plan and the old image's id and digest"

    def estimate(self, cfg, cid: str) -> int | None:
        """The newest nightly copy is the best estimate there is (backup.sh does the same)."""
        kind, fname, _ = TIMESERIES[cid]
        d = os.path.join(cfg.backups, kind)
        try:
            files = [os.path.join(d, f) for f in os.listdir(d) if not f.startswith(".")]
            newest = max(files, key=os.path.getmtime) if files else None
        except OSError:
            newest = None
        return os.path.getsize(newest) if newest else None

    def _env(self, cid: str, container: str) -> dict:
        env = dict(os.environ)
        env[TIMESERIES[cid][2]] = container
        return env

    def take_snapshot(self, cfg, cid: str, container: str, dirpath: str) -> tuple[str | None, str]:
        kind, fname, _ = TIMESERIES[cid]
        out = os.path.join(dirpath, fname)
        rc, o, e = run(["bash", cfg.script("snapshot.sh"), kind, out], env=self._env(cid, container), timeout=900)
        detail = tail(e or o, 300)
        if rc in (0, 2, 3) and os.path.exists(out) and os.path.getsize(out) >= 1000:
            # 2 and 3 keep a good artefact but say something is left to look at.
            return out, (detail or f"{fname} saved") + ("" if rc == 0 else f" (exit {rc})")
        return None, detail or f"snapshot.sh exited {rc}"

    def restore(self, cfg, cid: str, container: str, artefact: str) -> tuple[bool, str]:
        kind = TIMESERIES[cid][0]
        rc, o, e = run(["bash", cfg.script("restore.sh"), kind, artefact, "--yes"],
                       env=self._env(cid, container), timeout=1800)
        return rc == 0, tail(o + e, 400)


# ── app-db: Grafana and Keycloak - ONE-WAY (build step 5) ─────────────────────
#
# Both migrate their database on the first start of a new version, and the old
# version cannot read the result. So the image alone can never go back: on ANY
# failure after the pull, the rollback RESTORES the snapshot first - always, not
# only when a probe says the data is damaged - and only then puts the previous
# image back (executor.rollback, `always_restore`).
#
#   grafana   STOPPED, then the grafana_data volume (grafana.db + plugins) tarred
#             whole, grafana.db integrity-checked, started again. A live copy of
#             SQLite can be torn (docs/plans/updates.md §5).
#   keycloak  `pg_dump -Fc` of its database, from the postgres container its
#             KC_DB_URL names, with Keycloak running (pg_dump is one consistent
#             snapshot). The superuser's credentials come from the checkout's
#             .env and reach `docker exec` as environment (`-e NAME`), never argv.
#
# scripts/restore.sh's grafana path does not fit: it replaces grafana.db from a
# nightly .db file and restarts Grafana on whatever image it has - after an
# update that is the NEW image, which would migrate the restored file again. The
# restores here leave the container STOPPED; the rollback's recipe run recreates
# it on the old image.

APPDB = ("grafana", "keycloak")
GRAFANA_DATA = "/var/lib/grafana"
_PGNAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,62}")
_DBNAME = re.compile(r"[a-z_][a-z0-9_]{0,62}")
_KC_URL = re.compile(r"jdbc:postgresql://([A-Za-z0-9][A-Za-z0-9_.-]{0,62})(?::\d{1,5})?/([a-z_][a-z0-9_]{0,62})")

DOWNTIME.update({
    "grafana": "~30-90 s in two pieces: Grafana is STOPPED while its volume is tarred (seconds; longer with many "
               "plugins), started again, then recreated on the new image, whose first start migrates grafana.db "
               "before it answers. Dashboards on :3000 and alert evaluation pause meanwhile",
    "keycloak": "~1-2 min: logins are unavailable while Keycloak is recreated, migrates its database and passes "
                "its health check, and keycloak-init re-runs. Every gated route (sso-viewer, sso-editor, "
                "sso-operator, Headlamp) FAILS CLOSED meanwhile - refused, never open",
})
SIGNED_OUT.update({
    "grafana": "nobody - Grafana's sessions live in grafana.db, which the update keeps. A rollback restores the "
               "snapshot, which ends any session started after it",
    "keycloak": "nobody: Keycloak 26 persists user sessions in its database by default (persistent user sessions, "
                "on since 26.0.0 - keycloak.org release notes), so they survive the restart, and oauth2-proxy's "
                "cookies are untouched. A rollback restores the pre-update dump, which ends any session started "
                "after it",
})


def _inspect(name: str) -> dict | None:
    j = docker_json(["inspect", "--type", "container", name])
    return j[0] if j else None


def _stop(name: str) -> None:
    if _inspect(name):
        run(["docker", "stop", "-t", "60", name], timeout=120)


def _wait_healthy(name: str, seconds: int) -> str:
    deadline = time.monotonic() + seconds
    while True:
        c = container(name) or {}
        if c.get("state") == "running" and c.get("health") in (None, "healthy"):
            return c.get("health") or "running"
        if time.monotonic() > deadline:
            return f"{c.get('state')}/{c.get('health')}"
        time.sleep(2)


def _meta(dirpath: str) -> str:
    return os.path.join(dirpath, "app-db.json")


# The integrity check and the counts run in the helper image (grafana/grafana
# ships no sqlite3). Read-only, immutable: it never writes the file it checks.
_GF_STATS = r'''
import sqlite3, sys
c = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro&immutable=1", uri=True, timeout=30)
ok = c.execute("PRAGMA integrity_check").fetchone()[0]
n = c.execute("SELECT count(*) FROM sqlite_master WHERE type = 'table'").fetchone()[0]
print(ok.replace(" ", "_"), n)
'''


def _gf_integrity(cfg, volume: str) -> tuple[bool, str]:
    rc, out, err = run(["docker", "run", "--rm", "-v", f"{volume}:/data:ro", cfg.helper_image,
                        "python3", "-c", _GF_STATS, "/data/grafana.db"], timeout=300)
    words = out.split()
    if rc != 0 or len(words) != 2:
        return False, f"grafana.db could not be checked: {tail(err or out, 200)}"
    return words[0] == "ok", f"grafana.db integrity {words[0]}, {words[1]} tables"


def _grafana_volume(name: str) -> str | None:
    for m in (_inspect(name) or {}).get("Mounts") or []:
        if m.get("Destination") == GRAFANA_DATA and m.get("Type") == "volume" and m.get("Name"):
            return m["Name"]
    return None


def _pg(cfg, kc: str) -> tuple[str, str, dict]:
    """(postgres container, database, env for `docker exec -e PGUSER -e PGPASSWORD`)
    - from what the Keycloak container was created with, not from a guess."""
    env = {e.split("=", 1)[0]: e.split("=", 1)[1] for e in
           ((_inspect(kc) or {}).get("Config") or {}).get("Env") or [] if "=" in e}
    m = _KC_URL.fullmatch(env.get("KC_DB_URL", ""))
    if env.get("KC_DB") != "postgres" or not m:
        raise HostError(f"{kc} does not name a postgres database in KC_DB_URL")
    host, db = m.group(1), m.group(2)
    if not _PGNAME.fullmatch(host) or not _DBNAME.fullmatch(db):
        raise HostError(f"{kc}'s KC_DB_URL names an unusable host or database")
    pg = container(host)
    if not pg or pg.get("state") != "running":
        raise HostError(f"the postgres container {host} (from {kc}'s KC_DB_URL) is not running")
    dot = dotenv(cfg.repo)
    pgenv = dict(os.environ)
    pgenv["PGUSER"] = dot.get("POSTGRES_USER") or "dev"
    pgenv["PGPASSWORD"] = dot.get("POSTGRES_PASSWORD") or ""
    return host, db, pgenv


def _pg_exec(pg: str, *argv: str, stdin: bool = False) -> list[str]:
    return ["docker", "exec", *(["-i"] if stdin else []), "-e", "PGUSER", "-e", "PGPASSWORD", pg, *argv]


def _dump_tables(pg: str, pgenv: dict, dump: str) -> tuple[int, str]:
    """How many tables the dump would create - `pg_restore -l`, so a dump that
    cannot be read is found at snapshot time, not at rollback time."""
    listing = dump + ".toc"
    rc, err = run_io(_pg_exec(pg, "pg_restore", "-l", stdin=True), stdin_path=dump, stdout_path=listing,
                     env=pgenv, timeout=300)
    if rc != 0:
        return -1, err
    try:
        with open(listing, encoding="utf-8", errors="replace") as fh:
            n = sum(1 for ln in fh if re.match(r"\d+; \d+ \d+ TABLE (?!DATA )", ln))
    finally:
        os.unlink(listing)
    return n, ""


class AppDb(UpdateClass):
    name = "app-db"
    always_restore = True
    rollback = ("ONE-WAY: on any failure after the pull, the pre-update snapshot is restored FIRST - always, "
                "because the new version may already have migrated the data and the old one cannot read it - "
                "with the new container stopped. Then the previous image goes back on every pin line (left "
                "uncommitted) and the recipe runs again, and the old image must pass the same canaries. "
                "Anything written between the snapshot and the rollback is lost.")

    def snapshot_kind(self, cid: str) -> str:
        return cid

    def backup_kinds(self, cid: str) -> tuple[str, ...]:
        return ("postgres", "grafana") if cid == "grafana" else ("postgres",)

    def snapshot_words(self, cid: str) -> str:
        if cid == "grafana":
            data = ("Grafana STOPPED and its whole volume (grafana.db and plugins) tarred, grafana.db "
                    "integrity-checked, then started again")
        else:
            data = ("`pg_dump -Fc` of Keycloak's database (no downtime), proven readable with `pg_restore -l` "
                    "before anything changes")
        return f"{data}; plus every pin line, the compose file, this plan and the old image's id and digest"

    def estimate(self, cfg, cid: str) -> int | None:
        d = os.path.join(cfg.backups, "grafana" if cid == "grafana" else "postgres")
        try:
            files = [os.path.join(d, f) for f in os.listdir(d) if not f.startswith(".")]
            newest = max(files, key=os.path.getmtime) if files else None
        except OSError:
            newest = None
        return os.path.getsize(newest) if newest else None

    # ── snapshot ──
    def take_snapshot(self, cfg, cid: str, name: str, dirpath: str) -> tuple[str | None, str]:
        try:
            return (self._snap_grafana if cid == "grafana" else self._snap_keycloak)(cfg, name, dirpath)
        except HostError as e:
            return None, str(e)

    def _snap_grafana(self, cfg, name: str, dirpath: str) -> tuple[str | None, str]:
        vol = _grafana_volume(name)
        if not vol:
            raise HostError(f"{name} has no named volume at {GRAFANA_DATA}")
        out = os.path.join(dirpath, "grafana-data.tar.gz")
        write_json(_meta(dirpath), {"kind": "grafana", "container": name, "volume": vol})
        t0 = time.monotonic()
        rc, _, err = run(["docker", "stop", "-t", "60", name], timeout=120)
        if rc != 0:
            raise HostError(f"{name} would not stop: {tail(err, 200)}")
        try:
            good, integrity = _gf_integrity(cfg, vol)
            if not good:
                raise HostError(f"refusing to snapshot a damaged database: {integrity}")
            rc, err = run_io(["docker", "run", "--rm", "-v", f"{vol}:/data:ro", cfg.helper_image,
                              "tar", "-czf", "-", "-C", "/data", "."], stdout_path=out, timeout=1800)
            if rc != 0:
                raise HostError(f"the tar of {vol} failed: {err}")
        finally:
            run(["docker", "start", name], timeout=120)
        stopped = int(time.monotonic() - t0)
        try:
            with tarfile.open(out, "r:gz") as tf:
                if "./grafana.db" not in tf.getnames():
                    raise HostError(f"{os.path.basename(out)} holds no ./grafana.db")
        except (tarfile.TarError, OSError) as e:
            raise HostError(f"{os.path.basename(out)} is unreadable: {e}") from None
        health = _wait_healthy(name, 120)
        return out, (f"{vol} tarred ({os.path.getsize(out) >> 10} KiB), {integrity}; {name} stopped {stopped}s, "
                     f"now {health}")

    def _snap_keycloak(self, cfg, name: str, dirpath: str) -> tuple[str | None, str]:
        pg, db, pgenv = _pg(cfg, name)
        rc, owner, err = run(_pg_exec(pg, "psql", "-X", "-At", "-d", "postgres", "-c",
                                      f"SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '{db}'"),
                             env=pgenv, timeout=60)
        owner = owner.strip()
        if rc != 0 or not _DBNAME.fullmatch(owner):
            raise HostError(f"database {db} on {pg} has no readable owner: {tail(err or owner, 200)}")
        out = os.path.join(dirpath, f"{db}.dump")
        write_json(_meta(dirpath), {"kind": "keycloak", "container": name, "postgres": pg, "database": db,
                                    "owner": owner})
        rc, err = run_io(_pg_exec(pg, "pg_dump", "-Fc", "-d", db), stdout_path=out, env=pgenv, timeout=1800)
        if rc != 0:
            raise HostError(f"pg_dump of {db} failed: {err}")
        n, err = _dump_tables(pg, pgenv, out)
        if n <= 0:
            raise HostError(f"the dump of {db} is unreadable or empty: {err or 'no TABLE entries'}")
        return out, f"pg_dump -Fc {db} from {pg}: {os.path.getsize(out) >> 10} KiB, {n} tables"

    # ── restore: the container is left STOPPED; the rollback's recipe run recreates it ──
    def restore(self, cfg, cid: str, name: str, artefact: str) -> tuple[bool, str]:
        try:
            meta = read_json(_meta(os.path.dirname(artefact)))
            if not isinstance(meta, dict) or meta.get("kind") != cid:
                raise HostError("the snapshot's app-db.json does not describe this component")
            return (self._restore_grafana if cid == "grafana" else self._restore_keycloak)(cfg, name, artefact, meta)
        except (HostError, OSError, ValueError) as e:
            return False, str(e)

    def _restore_grafana(self, cfg, name: str, art: str, meta: dict) -> tuple[bool, str]:
        vol = meta.get("volume")
        if not isinstance(vol, str) or not _PGNAME.fullmatch(vol):
            raise HostError("the snapshot names no usable volume")
        with tarfile.open(art, "r:gz") as tf:
            if "./grafana.db" not in tf.getnames():
                raise HostError(f"{art} holds no ./grafana.db - not restoring from it")
        _stop(name)
        rc, out, err = run(["docker", "run", "--rm", "-v", f"{vol}:/data", "-v", f"{art}:/restore.tar.gz:ro",
                            cfg.helper_image, "sh", "-euc",
                            "find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && "
                            "tar -xzf /restore.tar.gz -C /data"], timeout=1800)
        if rc != 0:
            raise HostError(f"unpacking into {vol} failed: {tail(err or out, 200)}")
        good, integrity = _gf_integrity(cfg, vol)
        if not good:
            raise HostError(f"after the restore, {integrity}")
        return True, f"{vol} emptied and restored from {os.path.basename(art)}: {integrity}; {name} left stopped"

    def _restore_keycloak(self, cfg, name: str, art: str, meta: dict) -> tuple[bool, str]:
        pg, db, owner = meta.get("postgres"), meta.get("database"), meta.get("owner")
        if not (isinstance(pg, str) and _PGNAME.fullmatch(pg) and isinstance(db, str) and _DBNAME.fullmatch(db)
                and isinstance(owner, str) and _DBNAME.fullmatch(owner)):
            raise HostError("the snapshot names no usable postgres container, database or owner")
        dot = dotenv(cfg.repo)
        pgenv = dict(os.environ)
        pgenv["PGUSER"] = dot.get("POSTGRES_USER") or "dev"
        pgenv["PGPASSWORD"] = dot.get("POSTGRES_PASSWORD") or ""
        want, err = _dump_tables(pg, pgenv, art)
        if want <= 0:
            raise HostError(f"{art} is unreadable - not dropping {db}: {err}")
        _stop(name)
        for sql in (f'DROP DATABASE IF EXISTS "{db}" WITH (FORCE)', f'CREATE DATABASE "{db}" OWNER "{owner}"'):
            rc, out, err = run(_pg_exec(pg, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", "postgres",
                                        "-c", sql), env=pgenv, timeout=120)
            if rc != 0:
                raise HostError(f"{sql.split(' IF')[0].split(' OWNER')[0]} failed: {tail(err or out, 200)}")
        rc, err = run_io(_pg_exec(pg, "pg_restore", "--exit-on-error", "-d", db, stdin=True),
                         stdin_path=art, env=pgenv, timeout=1800)
        if rc != 0:
            raise HostError(f"pg_restore into {db} failed: {err}")
        rc, got, err = run(_pg_exec(pg, "psql", "-X", "-At", "-d", db, "-c",
                                    "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN "
                                    "('pg_catalog', 'information_schema')"), env=pgenv, timeout=60)
        if rc != 0 or got.strip() != str(want):
            raise HostError(f"{db} after pg_restore holds {got.strip() or '?'} tables, the dump {want}")
        return True, f"{db} dropped, recreated (owner {owner}) and restored: {want} tables, as in the dump; " \
                     f"{name} left stopped"


CLASSES: dict[str, UpdateClass] = {"stateless": Stateless(), "timeseries": Timeseries(), "app-db": AppDb()}


def get(cls: str, cid: str) -> UpdateClass | None:
    """The class for a component, or None when the updater does not handle it -
    including a time-series component nobody has written a snapshot for."""
    c = CLASSES.get(cls)
    if isinstance(c, Timeseries) and cid not in TIMESERIES:
        return None
    if isinstance(c, AppDb) and cid not in APPDB:
        return None
    return c
