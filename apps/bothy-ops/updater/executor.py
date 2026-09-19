"""The executor: drain the spool, one job at a time, under one lock.

    validate -> preflight -> snapshot -> pull -> apply -> verify [-> rollback [-> restore]] -> record

Every step writes status.json before and after it runs. What decides a job's
RESULT, and so what bothy_update_last_result says:

  refused      validation or pre-flight said no. Nothing was touched.
  aborted      the snapshot or the pull failed. Nothing RUNNING was touched
               (a pulled image and a snapshot directory may be left behind).
  succeeded    the container runs the image main pins, and every canary passed.
  rolled_back  apply or verify failed; the previous image is back on the pin
               line (uncommitted) and passed the same canaries.
  failed       the rollback did not bring the old image back to health. A
               person is needed: status.json and audit.log say where it stopped.

── the rollback rule for time-series data ─────────────────────────────────────

Roll the IMAGE back first, always. Then ask the history probe (canaries.py)
again, under the old image: is data written before the update still readable?

  yes  -> keep the data. The new version failed for its own reasons, or could
          not read what the old one can; either way the files are fine, and a
          restore would throw away everything written since the snapshot.
  no   -> the data itself is damaged. Restore the pre-update snapshot with
          scripts/restore.sh (the same restore `just restore-<kind>` runs), then
          verify again.

A restore is never the first move, because it is the only step that loses data.
"""

from __future__ import annotations

import fcntl
import os
import re
import shutil
import sys
import time

import updates
from discover_updates import split_image

from . import canaries, classes, hostio, pins, plans, record, spool
from .config import Config
from .hostio import HostError, iso, run, tail


class Refuse(Exception):
    """Pre-flight said no."""


class StepError(Exception):
    """A step failed after pre-flight."""


def _lock(cfg: Config) -> int | None:
    hostio.ensure_dir(cfg.state, 0o700)
    fd = os.open(cfg.lock_file, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return None
    os.ftruncate(fd, 0)
    os.write(fd, f"{os.getpid()} {iso()}\n".encode())
    return fd


def run_spool(cfg: Config | None = None, *, log=print) -> int:
    """Drain the spool. 0 on success (including "another run holds the lock")."""
    cfg = cfg or Config()
    fd = _lock(cfg)
    if fd is None:
        log("another updater run holds the lock - it drains the spool; nothing to do here")
        return 0
    try:
        hostio.ensure_dir(cfg.spool, 0o700)
        done = 0
        while done < cfg.max_jobs_per_run:
            _auto_hook(cfg, "drain_unpause")
            reqs, junk = spool.entries(cfg.spool)
            for n in junk:
                spool.remove(cfg.spool, n)
                _audit_junk(cfg, n)
            if not reqs:
                break
            name = reqs[0][1]
            result = run_one(cfg, name)
            log(f"{name[:-5]}: {result}")
            _auto_hook(cfg, "sync_pauses")
            done += 1
        return 0
    finally:
        os.close(fd)


def _auto_hook(cfg: Config, what: str) -> None:
    """Step 7's two calls into the drain loop (updater/auto.py): claim unpause
    requests, and pause a component the moment one of its jobs rolls back or
    fails. A fault in either is audited and never stops an update or a rollback."""
    try:
        from . import auto
        getattr(auto, what)(cfg)
    except Exception as e:  # noqa: BLE001
        try:
            hostio.append_line(cfg.audit_file, "\t".join((iso(), "-", "-", "auto", what, "failed",
                                                          f"{type(e).__name__}: {e}"[:300])))
        except OSError:
            pass


def _audit_junk(cfg: Config, name: str) -> None:
    from bothy_common.audit import flat
    try:
        hostio.append_line(cfg.audit_file, "\t".join(
            (iso(), "-", "-", "-", "spool", "removed", flat(f"not a request: {name[:80]!r}"))))
    except OSError:
        pass


def run_one(cfg: Config, name: str) -> str:
    """Claim, validate and execute one spool file. Returns the result."""
    doc: dict | None = None
    invalid: Exception | None = None
    try:
        doc = spool.validate_shape(spool.read(cfg.spool, name), name)
    except spool.Invalid as e:
        invalid = e
    rec = record.Recorder(cfg, record.new_job(doc or {}, name))
    # CLAIMED: removed before anything runs, so a crash never re-runs it.
    spool.remove(cfg.spool, name)
    rec.step("validate", "running")
    if invalid is not None or doc is None:
        rec.step("validate", "failed", str(invalid))
        return rec.finish("refused", f"invalid request: {invalid}")["state"]
    try:
        if any(h.get("id") == doc["jobId"] for h in record.history(cfg, record.HISTORY_KEEP)):
            raise spool.Invalid("that job id was used before")
        try:
            catalog = updates.load(cfg.catalog)
        except (updates.CatalogError, OSError, ValueError) as e:
            raise spool.Invalid(f"updates.toml is invalid: {e}") from None
        p = spool.validate_against(doc, catalog, plans.read_plan(cfg, doc["component"]))
        try:
            fresh = plans.plan(doc["component"], cfg=cfg, catalog=catalog)
        except plans.PlanRefused as e:
            raise spool.Invalid(f"the plan no longer holds: {e}") from None
        if fresh["id"] != p["id"]:
            raise spool.Invalid(f"plan {p['id']} is stale - recomputed now it is {fresh['id']} "
                                "(main, the container or discovery changed); ask again")
    except spool.Invalid as e:
        rec.step("validate", "failed", str(e))
        return rec.finish("refused", str(e))["state"]
    rec.set(**{"from": {"image": fresh["from"]["image"], "version": fresh["from"]["version"]},
               "to": {"image": fresh["to"]["image"], "version": fresh["to"]["version"]}})
    rec.step("validate", "ok", f"plan {fresh['id']}: {fresh['from']['image']} -> {fresh['to']['image']}")
    return Execution(cfg, rec, catalog.components[doc["component"]], fresh).go()


class Execution:
    def __init__(self, cfg: Config, rec: record.Recorder, comp: updates.Component, plan: dict) -> None:
        self.cfg = cfg
        self.rec = rec
        self.comp = comp
        self.plan = plan
        self.klass = classes.get(comp.cls, comp.id)
        self.container = plan["container"]
        self.canaries = canaries.for_component(cfg, comp.id)
        self.ctx = canaries.Ctx(cfg, self.container, phase="preflight", plan=plan)
        pp = plan["pin"]
        self.pin = pins.PinLine(pp["file"], pp["service"], pp["line"], pp["text"], plan["to"]["image"],
                                self.container)
        # Every pin line the component moves - Keycloak's image is pinned twice
        # (keycloak, keycloak-init). The plan proved they all name the same image.
        self.pins = [pins.PinLine(q["file"], q["service"], q["line"], q["text"], plan["to"]["image"],
                                  q.get("container")) for q in plan.get("pins") or []] or [self.pin]
        self.artefact: str | None = None

    # ── the job ──
    def go(self) -> str:
        try:
            self.step("preflight", self.preflight)
        except Refuse as e:
            return self.rec.finish("refused", str(e))["state"]
        try:
            self.step("snapshot", self.snapshot)
            new_id = self.step("pull", self.pull)
        except StepError as e:
            return self.rec.finish("aborted", f"{e} - nothing running was changed")["state"]
        try:
            self.step("apply", self.apply)
            self.step("verify", lambda: self.verify(new_id, "verify"))
        except StepError as e:
            return self.rollback(e)
        return self.rec.finish("succeeded", note=f"{self.container} runs {self.plan['to']['image']}, which main "
                                                 "already pins - the tree is unchanged")["state"]

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

    # ── pre-flight: nothing is touched until every one of these holds ──
    def preflight(self) -> str:
        notes = [self._backups(), self._disk(), self._health(), self._scope(), self._baseline()]
        return "; ".join(n for n in notes if n)

    def _backups(self) -> str:
        cutoff = time.time() - self.cfg.backup_max_age
        out = []
        for kind in self.klass.backup_kinds(self.comp.id):
            d = os.path.join(self.cfg.backups, kind)
            try:
                newest = max((os.path.getmtime(os.path.join(d, f)) for f in os.listdir(d)
                              if not f.startswith(".") and os.path.isfile(os.path.join(d, f))), default=None)
            except OSError:
                newest = None
            if newest is None or newest < cutoff:
                age = "none" if newest is None else f"{int((time.time() - newest) // 3600)} h old"
                raise Refuse(f"the newest backup in {d} is {age}; the updater needs one under "
                             f"{self.cfg.backup_max_age // 3600} h - run `just backup` first")
            out.append(f"{kind} {int((time.time() - newest) // 60)} min old")
        return "backups: " + ", ".join(out)

    def _disk(self) -> str:
        img = hostio.image(self.plan["from"]["imageId"]) or {}
        need = 2 * (int(img.get("size") or 0) + int(self.klass.estimate(self.cfg, self.comp.id) or 0))
        need = max(need, self.cfg.min_free_bytes)
        for where in (self.cfg.backups, hostio.docker_root()):
            free = hostio.free_bytes(where)
            if free is not None and free < need:
                raise Refuse(f"{free >> 20} MiB free under {where}, the update needs {need >> 20} MiB")
        return f"disk: {need >> 20} MiB needed, available"

    def _health(self) -> str:
        c = hostio.container(self.container)
        if not c or c["state"] != "running":
            raise Refuse(f"{self.container} is not running")
        if c["imageId"] != self.plan["from"]["imageId"]:
            raise Refuse(f"{self.container} changed since the plan was made")
        if c["health"] not in (None, "healthy"):
            raise Refuse(f"{self.container} is {c['health']} - fix it before updating it")
        return f"{self.container} {c['health'] or 'running'}"

    def _scope(self) -> str:
        """`just <recipe>` must recreate this container and nothing else.

        The recipe runs `docker compose up` over a whole project. If any OTHER
        service in it has a pending change - Grafana's pin merged but not applied,
        in the same project as Loki - updating Loki would drag Grafana's one-way
        migration along with no snapshot. Compose recreates a container exactly
        when its config hash differs from the `com.docker.compose.config-hash`
        label it was created with, so compare the two, with the same files the
        container was created from.
        """
        c = hostio.container(self.container) or {}
        lab = c.get("labels") or {}
        project = lab.get("com.docker.compose.project")
        files = [f for f in (lab.get("com.docker.compose.project.config_files") or "").split(",") if f]
        wd = lab.get("com.docker.compose.project.working_dir")
        if not project or not files or not wd or lab.get("com.docker.compose.service") != self.pin.service:
            raise Refuse(f"{self.container} carries no compose labels for service {self.pin.service}")
        repo = self.cfg.repo + os.sep
        if not all(os.path.realpath(f).startswith(repo) for f in files):
            raise Refuse(f"{self.container} was created from files outside {self.cfg.repo}")
        if os.path.realpath(os.path.join(self.cfg.repo, self.pin.file)) not in {os.path.realpath(f) for f in files}:
            raise Refuse(f"{self.container} was not created from {self.pin.file}")
        argv = ["docker", "compose", "-p", project, "--project-directory", wd]
        for f in files:
            argv += ["-f", f]
        rc, out, err = run([*argv, "config", "--hash", "*"], env=hostio.dotenv(self.cfg.repo), cwd=self.cfg.repo)
        if rc != 0:
            raise Refuse(f"cannot prove the recipe touches only {self.container}: compose config failed "
                         f"({tail(err, 200)})")
        want = dict(ln.split(None, 1) for ln in out.splitlines() if len(ln.split()) == 2)
        rc, names, _ = run(["docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={project}",
                            "--format", "{{.Names}}"])
        have: dict[str, str] = {}
        for n in names.split():
            o = hostio.container(n) or {}
            ol = o.get("labels") or {}
            if ol.get("com.docker.compose.oneoff") == "True":
                continue
            have[ol.get("com.docker.compose.service", "")] = ol.get("com.docker.compose.config-hash", "")
        mine = {q.service for q in self.pins if q.file == self.pin.file}
        others = [s for s in want if s not in mine and have.get(s) != want[s]]
        if others:
            raise Refuse(f"`{self.comp.apply}` would also recreate or create {', '.join(sorted(others))} "
                         "(its configuration changed since it was started) - apply that first, by hand if "
                         "the updater does not handle it")
        return f"scope: only {', '.join(sorted(mine))} change in project {project}"

    def _baseline(self) -> str:
        self.ctx.phase = "preflight"
        done = []
        for cn in self.canaries:
            ok, d = False, ""
            for _ in range(3):
                ok, d = cn.check(self.ctx)
                if ok:
                    break
                time.sleep(3)
            if not ok:
                raise Refuse(f"before the update, {cn.describe} does not hold ({d})")
            done.append(d)
        return f"canaries green now ({len(done)})"

    # ── snapshot ──
    def snapshot(self) -> str:
        cid = self.comp.id
        hostio.ensure_dir(self.cfg.snapshots, 0o700)
        d = os.path.join(self.cfg.snapshots, f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{cid}")
        os.mkdir(d, 0o700)
        self.rec.set(snapshot=d)
        old = hostio.image(self.plan["from"]["imageId"]) or {}
        hostio.write_json(os.path.join(d, "plan.json"), self.plan)
        hostio.write_json(os.path.join(d, "pin.json"), {
            "file": self.pin.file, "service": self.pin.service, "line": self.pin.line,
            "lineAtHead": self.pin.text, "commit": self.plan["pin"]["commit"],
            "oldImage": self.plan["from"]["image"], "oldImageId": self.plan["from"]["imageId"],
            "oldDigest": self.plan["from"]["digest"], "oldRepoDigests": old.get("repoDigests", []),
            "newImage": self.plan["to"]["image"], "newDigest": self.plan["to"]["digest"],
            "pins": [{"file": q.file, "service": q.service, "line": q.line, "lineAtHead": q.text}
                     for q in self.pins]})
        src = os.path.join(self.cfg.repo, self.pin.file)
        dst = os.path.join(d, os.path.basename(self.pin.file))
        shutil.copyfile(src, dst)
        os.chmod(dst, 0o600)
        self.artefact, detail = self.klass.take_snapshot(self.cfg, cid, self.container, d)
        if self.klass.snapshot_kind(cid) != "image" and not self.artefact:
            raise StepError(f"the {self.klass.snapshot_kind(cid)} snapshot failed: {detail}")
        self._rotate()
        return f"{d}: {detail}"

    def _rotate(self) -> None:
        rx = re.compile(rf"\d{{8}}T\d{{6}}Z-{re.escape(self.comp.id)}")
        mine = sorted(n for n in os.listdir(self.cfg.snapshots) if rx.fullmatch(n))
        for n in mine[:-self.cfg.keep_snapshots]:
            shutil.rmtree(os.path.join(self.cfg.snapshots, n), ignore_errors=True)

    # ── pull: the planned digest, or nothing ──
    def pull(self) -> str:
        ref = self.plan["to"]["image"]
        rc, out, err = run(["docker", "pull", ref], timeout=900)
        if rc != 0:
            raise StepError(f"docker pull {ref} failed: {tail(err or out, 300)}")
        img = hostio.image(ref)
        if not img:
            raise StepError(f"{ref} is not in the local store after the pull")
        want = self.plan["to"]["digest"]
        got = hostio.repo_digest(img, split_image(ref)["ref"])
        if want and got != want:
            raise StepError(f"{ref} now names {got}, the plan says {want} - the tag moved; run discovery again")
        return img["id"]

    # ── apply: the component's own recipe (dependency order, .env, --wait) ──
    def _recipe(self) -> None:
        just = hostio.which("just")
        if not just:
            raise StepError("`just` is not on PATH")
        recipe = self.comp.apply.split()[1]
        rc, out, err = run([just, "--justfile", os.path.join(self.cfg.repo, "justfile"),
                            "--working-directory", self.cfg.repo, recipe],
                           timeout=self.cfg.apply_timeout, cwd=self.cfg.repo)
        if rc != 0:
            raise StepError(f"`{self.comp.apply}` exited {rc}: {tail(err or out, 300)}")

    def apply(self) -> str:
        self._recipe()
        return f"`{self.comp.apply}` done"

    # ── verify: the image, health, then every canary - bodies, not status codes ──
    def verify(self, image_id: str, phase: str) -> str:
        ok, detail, _ = self.check(image_id, phase)
        if not ok:
            raise StepError(detail)
        return detail

    def check(self, image_id: str, phase: str) -> tuple[bool, str, bool]:
        """(everything held, detail, the history probe held)."""
        deadline = time.monotonic() + self.cfg.verify_timeout
        c: dict | None = None
        while True:
            c = hostio.container(self.container)
            if c and c["imageId"] != image_id:
                return False, f"{self.container} runs {str(c['imageId'])[:19]}, not {image_id[:19]}", True
            if c and c["state"] == "running" and c["health"] in (None, "healthy"):
                break
            if time.monotonic() > deadline:
                st = f"{c['state']}/{c['health']}" if c else "gone"
                return False, f"{self.container} is {st} after {self.cfg.verify_timeout}s", True
            time.sleep(2)
        self.ctx.phase = phase
        history_ok = True
        for cn in self.canaries:
            while True:
                ok, d = cn.check(self.ctx)
                if ok or not cn.retry or time.monotonic() > deadline:
                    break
                time.sleep(3)
            if not ok:
                if cn.history:
                    history_ok = False
                return False, f"{cn.describe}: {d}", history_ok
        return True, f"{self.container} {c['health'] or 'running'}, {len(self.canaries)} canaries green", True

    # ── rollback ──
    def rollback(self, cause: Exception) -> str:
        old = self.plan["from"]["image"]
        self.rec.step("rollback", "running", f"because {cause}")
        restored = False
        if self.klass.always_restore:
            # ONE-WAY: the data goes back BEFORE the old image, whatever the probes
            # say - the new version may have migrated it past what the old reads.
            self.rec.step("restore", "running", f"one-way: restoring {self.artefact} before the old image")
            rok, rdetail = self.klass.restore(self.cfg, self.comp.id, self.container, self.artefact or "")
            if not rok:
                self.rec.step("restore", "failed", rdetail)
                self.rec.step("rollback", "failed", "the snapshot could not be restored - the old image was NOT "
                                                    "put back on data it may not be able to read")
                return self.rec.finish("failed", f"{cause}; and restoring the snapshot failed: {rdetail}",
                                       note=self._note(old, restored=False, pinned=False))["state"]
            self.rec.step("restore", "ok", rdetail)
            restored = True
        try:
            for q in self.pins:
                pins.replace(self.cfg.repo, q, old)
            self._recipe()
        except (HostError, StepError, OSError) as e:
            self.rec.step("rollback", "failed", str(e))
            return self.rec.finish("failed", f"{cause}; and the rollback failed: {e}",
                                   note=self._note(old, restored=restored))["state"]
        ok, detail, history_ok = self.check(self.plan["from"]["imageId"], "rollback")
        if ok:
            self.rec.step("rollback", "ok", f"{old} is back: {detail}")
            return self.rec.finish("rolled_back", str(cause), note=self._note(old, restored=restored))["state"]
        if restored or history_ok or not self.klass.history or not self.artefact:
            self.rec.step("rollback", "failed", detail)
            return self.rec.finish("failed", f"{cause}; after the rollback: {detail}",
                                   note=self._note(old, restored=restored))["state"]
        # History is unreadable under the OLD image too: the data is damaged.
        self.rec.step("rollback", "ok", f"{old} is back, but {detail}")
        self.rec.step("restore", "running", f"restoring {self.artefact}")
        rok, rdetail = self.klass.restore(self.cfg, self.comp.id, self.container, self.artefact)
        ok2, detail2, _ = self.check(self.plan["from"]["imageId"], "rollback") if rok else (False, rdetail, False)
        if not ok2:
            self.rec.step("restore", "failed", detail2)
            return self.rec.finish("failed", f"{cause}; data restore did not recover: {detail2}",
                                   note=self._note(old, restored=True))["state"]
        self.rec.step("restore", "ok", detail2)
        return self.rec.finish("rolled_back", str(cause), note=self._note(old, restored=True))["state"]

    def _note(self, old: str, *, restored: bool, pinned: bool = True) -> str:
        f = self.pin.file
        where = ", ".join(f"{q.file}:{q.line}" for q in self.pins)
        if not pinned:
            s = (f"The data snapshot {self.artefact} could NOT be restored, so the old image was not put back; "
                 f"{self.container} may be stopped. A person is needed: restore it by hand, then "
                 f"`git diff {f}`.")
            return s
        s = (f"{where} now pin{'s' if len(self.pins) == 1 else ''} {old} LOCALLY (uncommitted, on purpose) so the "
             f"next `just up` keeps the version that works; main still pins {self.plan['to']['image']}. Find out "
             f"why it failed, then `git checkout -- {f}` and deploy again.")
        if restored:
            s += f" Data was restored from {self.artefact}: anything written after the snapshot is gone."
        return s


def main_status(cfg: Config) -> int:
    try:
        st = hostio.read_json(cfg.status_file)
    except (OSError, ValueError, HostError):
        st = None
    job = (st or {}).get("job") if isinstance(st, dict) else None
    if job:
        print(f"last job {job['id']} {job['component']}: {job['state']}")
        for s in job.get("steps", []):
            print(f"  {s['state']:8} {s['name']:10} {s.get('detail') or ''}")
    else:
        print("no job has run")
    for h in record.history(cfg, 10):
        print(f"{h.get('endedAt')}  {h.get('component'):18} {h.get('state'):12} {h.get('id')}")
    q = spool.queued(cfg.spool)
    if q:
        print(f"queued: {', '.join(n[:-5] for n in q)}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(run_spool())
