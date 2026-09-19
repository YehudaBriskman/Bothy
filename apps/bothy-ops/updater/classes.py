"""The update classes the executor handles, and what each one means.

docs/plans/updates.md §4 names eight classes. Step 4 handles TWO - `stateless`
and `timeseries` - and refuses the rest at plan time, in words. A class is four
things, and adding one (step 5: app-db for Grafana and Keycloak; step 6:
own-code) is writing these four for it and adding it to CLASSES:

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

from .hostio import run, tail

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


CLASSES: dict[str, UpdateClass] = {"stateless": Stateless(), "timeseries": Timeseries()}


def get(cls: str, cid: str) -> UpdateClass | None:
    """The class for a component, or None when the updater does not handle it -
    including a time-series component nobody has written a snapshot for."""
    c = CLASSES.get(cls)
    if isinstance(c, Timeseries) and cid not in TIMESERIES:
        return None
    return c
