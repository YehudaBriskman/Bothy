"""The automatic channel (docs/plans/updates.md step 7): one `auto` patch a night.

    python3 -m updater auto [--dry-run] [--no-wait]    the night job (bothy-updater-auto.timer, 03:30)
    python3 -m updater unpause <component>             an operator clears a pause (`just update-unpause`)
    python3 -m updater pauses                          what is paused, and the last nights

── what a night does, in order; the first "no" ends it ─────────────────────────

  1  the window     now is inside [policy] window_start..window_end, local time
                    (03:30-05:00). The timer is Persistent=false, so a night the
                    box slept through is skipped - never caught up at noon.
  2  one a night    nothing was requested tonight already; if tonight's job ended
                    in anything but `succeeded`, nothing more tonight (stop at the
                    first failure). max_auto_per_night is 0 or 1 (the catalog).
  3  idle           no request is waiting in the spool and no job is running: a
                    night job never queues behind a person's.
  4  the backup     tonight's stacks-backup.service SUCCEEDED - `systemctl show`
                    says Result=success, ExecMainStatus=0, it is not running, and
                    it exited after 03:00 today - AND the newest file in
                    ~/backups/postgres is newer than 03:00 today. Both, because a
                    unit can succeed having written nothing (it did once:
                    backup.sh's history) and a file can be yesterday's.
  5  candidates     every component whose catalog channel is `auto` and whose
                    host-written plan (refreshed now, plans.write_all) is
                    deployable, a PATCH (effective_channel() == "auto"), confirmed
                    by click, and NOT paused. Oldest first: ordered by when a night
                    first saw that exact target waiting, then by id.
  6  doctor         the candidate's narrow health: its container running and
                    healthy, and its canaries green NOW (the history probes aside
                    - pre-flight records those). A red candidate is skipped, with
                    its reason, and the next one is tried. See "why not
                    doctor.sh" below.
  7  the request    ONE spool file, in exactly the schema bothy-ops writes, with
                    requestedBy "auto" - the actor every record then carries
                    (status.json, history.jsonl, the executor's audit.log). The
                    executor is unchanged: it re-validates this file the way it
                    re-validates a browser's, pre-flight included.

The night is recorded in auto.json whatever it decided, and every decision is one
line in the executor's audit.log with the actor `auto`.

── pause on failure ────────────────────────────────────────────────────────────

Any `rolled_back` or `failed` result in history.jsonl for an auto-channel
component - whoever asked for it - pauses auto for that component. The pause lives
in ~/.local/state/bothy/updates/auto.json: on the HOST, 600, in the directory
bothy-ops mounts READ-ONLY. So bothy-ops can show it and cannot clear it. It is
cleared only by an operator:

  * POST /-/api/updates/unpause - bothy-ops writes `unpause-<id>.json` into the
    spool; bothy-updater.path starts the executor, whose loop hands those files
    to drain_unpause() below before it looks for update requests. The host owns
    the state; bothy-ops only asks.
  * `just update-unpause <component>` on the host.

A failure is handled once: its job id is remembered, so an unpause is not undone
by the same old history line the next time the pauses are synced.

── why not scripts/doctor.sh --strict ───────────────────────────────────────────

It is a whole-box sweep, and routinely red for reasons that have nothing to do
with the component on offer: a project that is stopped on purpose, no minikube, a
scrape target of a service nobody runs. As a gate it would stop every night, and
a gate that is always shut teaches everyone to ignore it. Step 4 made the same
call for the executor's pre-flight (docs/plans/updates.md, Decisions). What an
unattended update needs to know is narrower and sharper: is the thing about to be
replaced healthy NOW, by its bodies (rule 7) - an update is never verified
against a component that was already broken. The executor then checks it again,
plus disk, scope (compose config hashes) and a fresh backup, before it touches
anything. A whole-box outage is the alerting's job (instance down), not this.
"""

from __future__ import annotations

import argparse
import calendar
import datetime as dt
import errno
import fcntl
import getpass
import json
import os
import re
import secrets
import stat
import sys
import time
from dataclasses import dataclass, field
from typing import Callable

import updates
from bothy_common.audit import flat

from . import canaries, hostio, plans, record, spool
from .config import Config
from .hostio import iso, run, tail

ACTOR = "auto"
# stacks-backup.timer's OnCalendar (host/systemd/stacks-backup.timer). The window
# must open after it; checks/wiring_auto.py holds the two together.
BACKUP_AT = (3, 0)
UNPAUSE_KEYS = {"v", "kind", "id", "component", "requestedBy", "requestedAt"}
NIGHTS_KEEP = 14
HANDLED_KEEP = 20
WAIT_SECONDS = 80 * 60


# ── where: beside the executor's records, in the directory bothy-ops reads only ──

def state_file(cfg: Config) -> str:
    return os.path.join(cfg.state, "auto.json")


def _lock_file(cfg: Config) -> str:
    return os.path.join(cfg.state, ".auto.lock")


class _Locked:
    """Every writer of auto.json - the night job, the executor's hooks, `just
    update-unpause` - holds this, so a pause and an unpause never interleave."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.fd = -1

    def __enter__(self) -> "_Locked":
        hostio.ensure_dir(self.cfg.state, 0o700)
        self.fd = os.open(_lock_file(self.cfg), os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *_: object) -> None:
        os.close(self.fd)


def load_state(cfg: Config) -> dict:
    try:
        doc = hostio.read_json(state_file(cfg), 512 * 1024)
    except (OSError, ValueError, hostio.HostError):
        doc = None
    if not isinstance(doc, dict) or doc.get("version") != 1:
        doc = {}
    st = {"version": 1}
    for k in ("paused", "handled", "unpaused", "pending", "nights"):
        st[k] = doc.get(k) if isinstance(doc.get(k), dict) else {}
    st["last"] = doc.get("last") if isinstance(doc.get("last"), dict) else None
    return st


def save_state(cfg: Config, st: dict) -> None:
    nights = st["nights"]
    for k in sorted(nights)[:-NIGHTS_KEEP]:
        del nights[k]
    hostio.write_json(state_file(cfg), st)


def _audit(cfg: Config, job: str, component: str, who: str, step: str, state: str, detail: str) -> None:
    line = "\t".join(flat(x) for x in (iso(), job or "-", component or "-", who, step, state, detail))
    try:
        hostio.append_line(cfg.audit_file, line)
    except OSError:
        pass


# ── pauses ─────────────────────────────────────────────────────────────────────

def _auto_components(catalog: updates.Catalog) -> list[str]:
    return sorted(c.id for c in catalog.components.values() if c.channel == "auto")


def sync_pauses(cfg: Config, catalog: updates.Catalog | None = None) -> list[str]:
    """Pause every auto component whose history shows a rollback or a failure not
    yet handled. Returns the newly paused ids. Idempotent; takes the lock."""
    catalog = catalog or updates.load(cfg.catalog)
    auto = set(_auto_components(catalog))
    newly: list[str] = []
    with _Locked(cfg):
        st = load_state(cfg)
        for e in reversed(record.history(cfg, record.HISTORY_KEEP)):  # oldest first
            cid, jid = e.get("component"), e.get("id")
            if e.get("state") not in ("rolled_back", "failed") or cid not in auto or not isinstance(jid, str):
                continue
            seen = st["handled"].setdefault(cid, [])
            if jid in seen:
                continue
            seen.append(jid)
            del seen[:-HANDLED_KEEP]
            why = f"{e['state'].replace('_', ' ')}: {flat(e.get('error') or 'no reason recorded')}"[:300]
            st["paused"][cid] = {"since": e.get("endedAt") or iso(), "jobId": jid, "result": e["state"],
                                 "reason": why, "requestedBy": flat(e.get("requestedBy") or "unknown")[:200]}
            if cid not in newly:
                newly.append(cid)
            _audit(cfg, jid, cid, ACTOR, "pause", "paused", why)
        for cid in list(st["paused"]):
            if cid not in catalog.components:
                del st["paused"][cid]
        save_state(cfg, st)
        write_metrics(cfg, st, catalog)
    return newly


def unpause(cfg: Config, cid: str, by: str, *, via: str = "shell", req_id: str | None = None,
            catalog: updates.Catalog | None = None) -> tuple[bool, str]:
    catalog = catalog or updates.load(cfg.catalog)
    if cid not in catalog.components:
        return False, f"{cid!r} is not in updates.toml"
    with _Locked(cfg):
        st = load_state(cfg)
        p = st["paused"].pop(cid, None)
        if p is None:
            _audit(cfg, req_id or "-", cid, by, "unpause", "refused", f"not paused ({via})")
            return False, f"{cid} is not paused"
        st["unpaused"][cid] = {"at": iso(), "by": flat(by)[:200], "via": via, "was": p}
        save_state(cfg, st)
        write_metrics(cfg, st, catalog)
    _audit(cfg, req_id or "-", cid, by, "unpause", "ok", f"via {via}; was: {p.get('reason')}")
    return True, f"{cid}: auto resumes from the next night (it was paused since {p.get('since')}: {p.get('reason')})"


def _read_unpause(cfg: Config, name: str) -> dict:
    """An unpause request, read the way spool.read() reads an update request."""
    try:
        fd = os.open(os.path.join(cfg.spool, name), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as e:
        raise spool.Invalid("the request could not be opened" + (" (a symlink)" if e.errno == errno.ELOOP else "")) from None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > spool.MAX_BYTES:
            raise spool.Invalid("not a regular file of at most 4 KiB")
        raw = os.read(fd, spool.MAX_BYTES + 1)
    finally:
        os.close(fd)
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise spool.Invalid("not JSON") from None
    m = spool.UNPAUSE_FILE.fullmatch(name)
    if not isinstance(doc, dict) or set(doc) != UNPAUSE_KEYS:
        raise spool.Invalid(f"the keys are not {sorted(UNPAUSE_KEYS)}")
    if doc["v"] != 1 or doc["kind"] != "unpause":
        raise spool.Invalid("unknown version or kind")
    if not m or doc["id"] != m.group(1):
        raise spool.Invalid("the id does not match the file name")
    if not isinstance(doc["component"], str) or not spool.COMPONENT.fullmatch(doc["component"]):
        raise spool.Invalid("the component id is malformed")
    who = doc["requestedBy"]
    if not isinstance(who, str) or not 0 < len(who) <= 200 or who == ACTOR:
        raise spool.Invalid("requestedBy is malformed (and never the system actor)")
    if not isinstance(doc["requestedAt"], str) or not spool.ISO.fullmatch(doc["requestedAt"]):
        raise spool.Invalid("requestedAt is malformed")
    return doc


def drain_unpause(cfg: Config) -> int:
    """Claim and apply every unpause request in the spool. Called by the executor's
    loop (under its lock) before it looks for update requests."""
    try:
        names = sorted(n for n in os.listdir(cfg.spool) if spool.UNPAUSE_FILE.fullmatch(n))
    except FileNotFoundError:
        return 0
    if not names:
        return 0
    catalog = updates.load(cfg.catalog)
    for n in names:
        rid = spool.UNPAUSE_FILE.fullmatch(n).group(1)
        try:
            doc = _read_unpause(cfg, n)
        except spool.Invalid as e:
            spool.remove(cfg.spool, n)
            _audit(cfg, rid, "-", "-", "unpause", "refused", f"invalid request: {e}")
            continue
        spool.remove(cfg.spool, n)  # claimed before it acts, like an update request
        unpause(cfg, doc["component"], doc["requestedBy"], via="Settings > Updates", req_id=rid, catalog=catalog)
    return len(names)


def write_metrics(cfg: Config, st: dict, catalog: updates.Catalog) -> None:
    """bothy_update_paused{component}: 1 while auto is paused for it, 0 otherwise,
    for every auto-channel component - so "no series" means "not written", never
    "not paused"."""
    if not cfg.textfile:
        return
    lines = ["# HELP bothy_update_paused 1 while automatic updates are paused for the component (a rollback or "
             "a failure; an operator clears it).",
             "# TYPE bothy_update_paused gauge"]
    for cid in _auto_components(catalog):
        lines.append(f'bothy_update_paused{{component="{cid}"}} {1 if cid in st["paused"] else 0}')
    last = st.get("last") or {}
    try:
        ts = calendar.timegm(time.strptime(last.get("at") or "", "%Y-%m-%dT%H:%M:%SZ"))
    except ValueError:
        ts = None
    if ts is not None:
        lines += ["# HELP bothy_update_auto_last_run_timestamp_seconds When the night job last decided anything.",
                  "# TYPE bothy_update_auto_last_run_timestamp_seconds gauge",
                  f"bothy_update_auto_last_run_timestamp_seconds {ts}"]
    try:
        hostio.ensure_dir(cfg.textfile, 0o755)
        hostio.atomic_write(os.path.join(cfg.textfile, "bothy_updater_auto.prom"), "\n".join(lines) + "\n", 0o644)
    except OSError:
        pass


# ── the gates, each replaceable by a test ──────────────────────────────────────

def _local_now() -> dt.datetime:
    return dt.datetime.now().astimezone()


def systemd_props(unit: str) -> dict[str, str]:
    """`systemctl show` of the backup unit: the few properties the gate reads."""
    rc, out, err = run(["systemctl", "show", unit, "--timestamp=unix", "-p", "LoadState", "-p", "ActiveState",
                        "-p", "Result", "-p", "ExecMainStatus", "-p", "ExecMainExitTimestamp"], timeout=20)
    if rc != 0:
        return {"error": tail(err or out, 200) or f"systemctl exited {rc}"}
    return dict(ln.split("=", 1) for ln in out.splitlines() if "=" in ln)


def narrow_doctor(cfg: Config, cid: str, plan: dict) -> tuple[bool, str]:
    """The candidate's container running and healthy, its canaries green now."""
    name = plan.get("container") or ""
    c = hostio.container(name)
    if not c or c.get("state") != "running":
        return False, f"{name} is not running"
    if c.get("health") not in (None, "healthy"):
        return False, f"{name} is {c.get('health')}"
    ctx = canaries.Ctx(cfg, name, phase="preflight")
    n = 0
    for cn in canaries.for_component(cfg, cid):
        if cn.history:
            continue  # a baseline, not a health check: pre-flight records it
        good, d = cn.check(ctx)
        if not good:
            return False, f"{cn.describe}: {d}"
        n += 1
    return True, f"{name} {c.get('health') or 'running'}, {n} canaries green"


@dataclass
class Env:
    now: Callable[[], dt.datetime] = _local_now
    backup_props: Callable[[str], dict] = systemd_props
    doctor: Callable[[Config, str, dict], tuple[bool, str]] = narrow_doctor
    refresh_plans: Callable[[Config, updates.Catalog], object] = field(
        default=lambda cfg, catalog: plans.write_all(cfg, catalog))


def in_window(now: dt.datetime, policy: updates.Policy) -> bool:
    hm = now.strftime("%H:%M")
    return policy.window_start <= hm < policy.window_end


def _cutoff(now: dt.datetime) -> float:
    return now.replace(hour=BACKUP_AT[0], minute=BACKUP_AT[1], second=0, microsecond=0).timestamp()


def backup_ok(cfg: Config, props: dict, now: dt.datetime, unit: str) -> tuple[bool, str]:
    """Tonight's backup ran to success after 03:00, and left a file to show for it."""
    cut = _cutoff(now)
    at = time.strftime("%H:%M", time.localtime(cut))
    if props.get("error"):
        return False, f"`systemctl show {unit}` failed: {props['error']}"
    if props.get("LoadState") != "loaded":
        return False, f"{unit} is {props.get('LoadState') or 'unknown'} - is it installed?"
    if props.get("ActiveState") in ("activating", "active", "reloading", "deactivating"):
        return False, f"{unit} is still {props['ActiveState']}"
    m = re.fullmatch(r"@(\d+)", props.get("ExecMainExitTimestamp") or "")
    ended = int(m.group(1)) if m else 0
    if ended < cut:
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(ended)) if ended else "never"
        return False, f"{unit} has not run since {at} today (it last ended {when})"
    if props.get("Result") != "success" or props.get("ExecMainStatus") != "0":
        return False, (f"tonight's {unit} FAILED (Result={props.get('Result')}, exit "
                       f"{props.get('ExecMainStatus')}) - `journalctl -u {unit}`")
    d = os.path.join(cfg.backups, "postgres")
    try:
        newest = max((os.path.getmtime(os.path.join(d, f)) for f in os.listdir(d)
                      if not f.startswith(".") and os.path.isfile(os.path.join(d, f))), default=None)
    except OSError:
        newest = None
    if newest is None or newest < cut:
        return False, f"{unit} succeeded, but the newest file in {d} is older than {at} today"
    return True, f"{unit} succeeded at {time.strftime('%H:%M', time.localtime(ended))}, the dump is fresh"


# ── the night ──────────────────────────────────────────────────────────────────

@dataclass
class Decision:
    outcome: str                      # requested | skipped
    reason: str
    component: str | None = None
    job: str | None = None
    skipped: list = field(default_factory=list)   # [(component, why)] candidates passed over


def _busy(cfg: Config) -> str | None:
    q = spool.queued(cfg.spool)
    if q:
        return f"{len(q)} update request(s) are waiting in the spool"
    try:
        stj = hostio.read_json(cfg.status_file)
    except (OSError, ValueError, hostio.HostError):
        return None
    job = stj.get("job") if isinstance(stj, dict) else None
    if isinstance(job, dict) and job.get("state") == "running":
        return f"job {str(job.get('id'))[:12]} ({job.get('component')}) is running"
    return None


def _result(cfg: Config, jid: str) -> str | None:
    for h in record.history(cfg, record.HISTORY_KEEP):
        if h.get("id") == jid:
            return h.get("state")
    return None


def _write_request(cfg: Config, cid: str, plan_id: str) -> str:
    """The same file bothy-ops' request_update() writes - key for key - with the
    system actor. Atomic: a dot-named temp file the path unit cannot match."""
    job = secrets.token_hex(16)
    req = {"v": 1, "jobId": job, "component": cid, "planId": plan_id, "confirm": True,
           "requestedBy": ACTOR, "requestedAt": iso()}
    assert set(req) == spool.KEYS
    hostio.ensure_dir(cfg.spool, 0o700)
    tmp = os.path.join(cfg.spool, f".{job}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, json.dumps(req, sort_keys=True).encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(tmp, os.path.join(cfg.spool, f"{job}.json"))
    return job


def decide(cfg: Config, env: Env, catalog: updates.Catalog, *, dry_run: bool = False) -> Decision:
    """Every gate, in order; writes the request unless dry_run. Records the night."""
    pol = catalog.policy
    now = env.now()
    night = now.strftime("%Y-%m-%d")
    if pol.max_auto_per_night < 1:
        return Decision("skipped", "max_auto_per_night is 0 in updates.toml - automatic updates are off")
    if not in_window(now, pol):
        return Decision("skipped", f"outside the window ({pol.window_start}-{pol.window_end}; it is "
                                   f"{now.strftime('%H:%M')}) - a missed night is skipped, never caught up")
    if not dry_run:
        sync_pauses(cfg, catalog)
    with _Locked(cfg):
        st = load_state(cfg)
        tonight = st["nights"].get(night) or {}
        jobs = [j for j in tonight.get("jobs", []) if isinstance(j, dict)]
        for j in jobs:
            r = _result(cfg, j.get("jobId", ""))
            if r is None:
                return _record(cfg, st, night, Decision(
                    "skipped", f"tonight's job {j.get('jobId', '')[:12]} ({j.get('component')}) has not finished"),
                    dry_run)
            if r != "succeeded":
                return _record(cfg, st, night, Decision(
                    "skipped", f"tonight's automatic update of {j.get('component')} ended {r} - nothing more "
                               "tonight (stop at the first failure)"), dry_run)
        if len(jobs) >= pol.max_auto_per_night:
            return _record(cfg, st, night, Decision(
                "skipped", f"already {len(jobs)} automatic update tonight (the limit is {pol.max_auto_per_night})"),
                dry_run)
        busy = _busy(cfg)
        if busy:
            return _record(cfg, st, night, Decision("skipped", f"busy: {busy} - a night job never queues "
                                                               "behind a person's"), dry_run)
        good, why = backup_ok(cfg, env.backup_props(pol.require_backup), now, pol.require_backup)
        if not good:
            return _record(cfg, st, night, Decision("skipped", f"backup: {why}"), dry_run)

    # Plans are written outside the auto lock: write_all inspects every container.
    if not dry_run:
        env.refresh_plans(cfg, catalog)

    with _Locked(cfg):
        st = load_state(cfg)
        cands: list[tuple[str, dict]] = []
        passed: list[tuple[str, str]] = []
        waiting = {}
        for cid in _auto_components(catalog):
            comp = catalog.components[cid]
            doc = plans.read_plan(cfg, cid)
            if not doc or doc.get("ok") is not True or not isinstance(doc.get("plan"), dict):
                continue  # nothing to deploy is not news; the page shows the reason
            p = doc["plan"]
            if updates.effective_channel(comp.channel, p.get("level")) != "auto" or p.get("confirm") != "click":
                passed.append((cid, f"{p.get('level')} - only patches are automatic"))
                continue
            to = (p.get("to") or {}).get("image") or ""
            prev = st["pending"].get(cid)
            waiting[cid] = prev if isinstance(prev, dict) and prev.get("to") == to else {"to": to, "since": iso(now.timestamp())}
            if cid in st["paused"]:
                passed.append((cid, f"paused since {st['paused'][cid].get('since')}"))
                continue
            cands.append((cid, p))
        if not dry_run:
            st["pending"] = waiting
        cands.sort(key=lambda c: (waiting[c[0]]["since"], c[0]))
        if not cands:
            why = "nothing eligible: no auto component has a deployable patch plan that is not paused"
            return _record(cfg, st, night, Decision("skipped", why, skipped=passed), dry_run)
        for cid, p in cands:
            good, why = env.doctor(cfg, cid, p)
            if not good:
                passed.append((cid, f"doctor red: {why}"))
                continue
            if dry_run:
                return Decision("requested", f"would request {cid} {p['from'].get('version')} -> "
                                             f"{p['to'].get('version')} (plan {p['id']}; {why})",
                                component=cid, skipped=passed)
            job = _write_request(cfg, cid, p["id"])
            tonight = st["nights"].setdefault(night, {"jobs": []})
            tonight.setdefault("jobs", []).append({"jobId": job, "component": cid, "planId": p["id"],
                                                   "to": p["to"].get("image"), "requestedAt": iso()})
            return _record(cfg, st, night, Decision(
                "requested", f"{cid} {p['from'].get('version')} -> {p['to'].get('version')} (plan {p['id']}; {why})",
                component=cid, job=job, skipped=passed), dry_run)
        return _record(cfg, st, night, Decision("skipped", "every eligible component is red: " +
                                                "; ".join(f"{c}: {w}" for c, w in passed[-3:]), skipped=passed), dry_run)


def _record(cfg: Config, st: dict, night: str, d: Decision, dry_run: bool) -> Decision:
    """auto.json's `last` and the night's decisions, and one audit line. Caller holds the lock."""
    if dry_run:
        return d
    entry = {"at": iso(), "night": night, "outcome": d.outcome, "reason": flat(d.reason)[:500],
             "component": d.component, "jobId": d.job,
             "skipped": [{"component": c, "why": flat(w)[:200]} for c, w in d.skipped][:20]}
    st["last"] = entry
    n = st["nights"].setdefault(night, {"jobs": []})
    n.setdefault("decisions", []).append({k: entry[k] for k in ("at", "outcome", "reason", "component", "jobId")})
    del n["decisions"][:-10]
    save_state(cfg, st)
    try:
        write_metrics(cfg, st, updates.load(cfg.catalog))
    except (updates.CatalogError, OSError, ValueError):
        pass
    _audit(cfg, d.job or "-", d.component or "-", ACTOR, "auto", d.outcome, d.reason)
    return d


def wait_for(cfg: Config, job: str, timeout: float = WAIT_SECONDS, poll: float = 10) -> str | None:
    """The job's result from history.jsonl, or None on timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r = _result(cfg, job)
        if r:
            return r
        time.sleep(poll)
    return None


def run_auto(cfg: Config, env: Env | None = None, *, dry_run: bool = False, wait: bool = True,
             log=print) -> int:
    env = env or Env()
    try:
        catalog = updates.load(cfg.catalog)
    except (updates.CatalogError, OSError, ValueError) as e:
        log(f"auto: updates.toml is invalid: {e}")
        return 2
    d = decide(cfg, env, catalog, dry_run=dry_run)
    for c, w in d.skipped:
        log(f"auto: passed over {c}: {w}")
    log(f"auto: {d.outcome}{' (dry run)' if dry_run else ''}: {d.reason}")
    if d.outcome != "requested" or dry_run or not wait or not d.job:
        return 0
    r = wait_for(cfg, d.job)
    sync_pauses(cfg, catalog)
    log(f"auto: job {d.job} ended {r or 'NOT within the wait (still running?)'}")
    return 0 if r == "succeeded" else 1


def main_pauses(cfg: Config, log=print) -> int:
    st = load_state(cfg)
    if not st["paused"]:
        log("no component is paused")
    for cid, p in sorted(st["paused"].items()):
        log(f"PAUSED {cid:18} since {p.get('since')}  {p.get('reason')}  (job {str(p.get('jobId'))[:12]}) "
            f"- `just update-unpause {cid}`")
    last = st.get("last")
    if last:
        log(f"last night job decision {last.get('at')}: {last.get('outcome')} - {last.get('reason')}")
    return 0


def add_parsers(sub) -> None:
    a = sub.add_parser("auto", help="the night job: at most one `auto` patch, after a good backup (the timer)")
    a.add_argument("--dry-run", action="store_true", help="say what tonight would do; write nothing")
    a.add_argument("--no-wait", action="store_true", help="write the request and return; do not wait for the job")
    u = sub.add_parser("unpause", help="clear an automatic-update pause (an operator's decision)")
    u.add_argument("component")
    u.add_argument("--by", default=None, help="who is clearing it (default: this user, from a shell)")
    sub.add_parser("pauses", help="what is paused, and the night job's last decision")


def dispatch(a: argparse.Namespace, cfg: Config) -> int | None:
    if a.cmd == "auto":
        return run_auto(cfg, dry_run=a.dry_run, wait=not a.no_wait)
    if a.cmd == "unpause":
        if not spool.COMPONENT.fullmatch(a.component):
            print("a component id is lowercase letters, digits and '-'", file=sys.stderr)
            return 2
        good, msg = unpause(cfg, a.component, a.by or f"{getpass.getuser()} (shell)", via="just update-unpause")
        print(msg, file=sys.stdout if good else sys.stderr)
        return 0 if good else 1
    if a.cmd == "pauses":
        return main_pauses(cfg)
    return None
