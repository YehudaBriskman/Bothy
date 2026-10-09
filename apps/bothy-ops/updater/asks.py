"""The two asks that make the host RUN something, and record what it said - plus
the re-check the host does for itself after a run.

    discover-<32 hex>.json   "check for updates now"   -> discover_updates.py
    autorun-<32 hex>.json    "run the night job now"   -> auto.decide()
    (no file)                "a job just changed the box"   -> rediscover()

Added 2026-10-06, because Settings > Updates could SHOW two states it could not
change: discovery is a six-hourly timer, so the page can be six hours stale and
say so; and the night job's decision ("nothing eligible", "backup failed") could
be read but not re-asked. `just updates-discover` and `just update-auto` were the
only cure, and a shell is not an answer to "the page is stale".

── the same shape, and deliberately no new power ─────────────────────────────

bothy-ops writes ONE file; the executor's drain loop claims it under the global
flock, RE-CHECKS it, and runs a fixed argv or a function in this process. Nothing
from the file reaches an argv: a discover ask carries no parameters at all, and an
autorun ask carries one boolean.

  * Discovery pulls nothing and changes nothing running. What a compromised
    bothy-ops gains is TIMING, plus one bounded resource - Docker Hub's anonymous
    quota, per public IP, shared with every pull this box makes. So it is
    rate-limited HERE as well as there, off available.json's own mtime, which the
    asking process cannot touch (it mounts the directory read-only).
  * The night job is auto.decide(), unchanged: the window, tonight's backup, one a
    night, the pauses, the narrow doctor, and only an `auto`-channel component's
    patch plan with `confirm: click`. That is a strict SUBSET of the plans
    /updates/request can already queue. A dry run writes nothing at all.

── the actor stays the night job's ──────────────────────────────────────────

A real autorun writes its update request as `auto`, because `auto` names WHO CHOSE
the component, the level and the plan - and that is still the night job, under its
own gates, not the person who asked it to run early. The person is recorded beside
it: in asks.json, in this module's audit lines, and in bothy-ops' admin.log. So the
rule SECURITY.md rule 8 states still holds exactly - a record naming `auto` is one
the HOST wrote - and nothing claims a person decided what the night job decided.

── asks.json ────────────────────────────────────────────────────────────────

One file, 600, in the state directory bothy-ops mounts READ-ONLY, holding the last
run of each kind: who asked, what happened, and why. It is the only way the page
can tell "discovery ran and found nothing new" from "discovery was refused",
because both leave available.json exactly as it was. Only this module writes it,
and only from inside the executor's lock, so it needs no lock of its own.
"""

from __future__ import annotations

import errno
import json
import os
import stat
import sys
import time

import updates
from bothy_common.audit import flat

from . import OPS, hostio, spool
from .config import Config
from .hostio import iso, run

DISCOVER_KEYS = {"v", "kind", "id", "requestedBy", "requestedAt"}
AUTORUN_KEYS = {"v", "kind", "id", "dryRun", "requestedBy", "requestedAt"}
# A registry round over every component. The discover systemd unit allows ten
# minutes for the same work; this one also holds the executor's lock while it runs,
# so an update request queued behind it waits - correctly, one at a time.
DISCOVER_TIMEOUT = 600
STATE_VERSION = 1


def state_file(cfg: Config) -> str:
    return os.path.join(cfg.state, "asks.json")


def load_state(cfg: Config) -> dict:
    try:
        doc = hostio.read_json(state_file(cfg), 256 * 1024)
    except (OSError, ValueError, hostio.HostError):
        doc = None
    if not isinstance(doc, dict) or doc.get("version") != STATE_VERSION:
        return {"version": STATE_VERSION, "discover": None, "autorun": None}
    doc.setdefault("discover", None)
    doc.setdefault("autorun", None)
    return doc


def _audit(cfg: Config, rid: str, who: str, kind: str, outcome: str, detail: str) -> None:
    try:
        hostio.append_line(cfg.audit_file, "\t".join(
            (iso(), rid or "-", "-", flat(who)[:200] or "-", kind, outcome, flat(detail)[:300])))
    except OSError:
        pass


def _record(cfg: Config, kind: str, entry: dict) -> None:
    """The last run of this kind, for the page. 600, beside the executor's records."""
    st = load_state(cfg)
    st[kind] = entry
    try:
        hostio.ensure_dir(cfg.state, 0o700)
        hostio.write_json(state_file(cfg), st, 0o600)
    except OSError:
        pass  # a record that could not be written is not a reason to undo the run


def _read_ask(cfg: Config, name: str, pattern, keys: set, kind: str) -> dict:
    """An ask, read the way spool.read() reads an update request: O_NOFOLLOW, a
    regular file of at most 4 KiB, an exact key set, and never the system actor."""
    try:
        fd = os.open(os.path.join(cfg.spool, name), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as e:
        raise spool.Invalid("the ask could not be opened"
                            + (" (a symlink)" if e.errno == errno.ELOOP else "")) from None
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
    m = pattern.fullmatch(name)
    if not isinstance(doc, dict) or set(doc) != keys:
        raise spool.Invalid(f"the keys are not {sorted(keys)}")
    if doc["v"] != STATE_VERSION or doc["kind"] != kind:
        raise spool.Invalid("unknown version or kind")
    if not m or doc["id"] != m.group(1):
        raise spool.Invalid("the id does not match the file name")
    who = doc["requestedBy"]
    if not isinstance(who, str) or not 0 < len(who) <= 200 or who == updates.AUTO_ACTOR:
        raise spool.Invalid("requestedBy is malformed (and never the system actor)")
    if not isinstance(doc["requestedAt"], str) or not spool.ISO.fullmatch(doc["requestedAt"]):
        raise spool.Invalid("requestedAt is malformed")
    return doc


def discover_argv(cfg: Config) -> list[str]:
    """The fixed argv, built from Config alone - nothing from the ask is in it.

    The same program the timer runs (host/systemd/bothy-updates-discover.service),
    from the same INSTALLED copy, so the plans it writes carry ids computed by the
    code that re-checks them.
    """
    argv = [sys.executable, os.path.join(OPS, "discover_updates.py"), "--quiet", "--state-dir", cfg.state]
    argv += ["--textfile-dir", cfg.textfile] if cfg.textfile else ["--no-textfile"]
    return argv


def available_age(cfg: Config) -> int | None:
    try:
        return max(0, int(time.time() - os.stat(cfg.available).st_mtime))
    except OSError:
        return None


def drain_discover(cfg: Config) -> int:
    """Claim and run every discovery ask in the spool. The executor's loop calls
    this under its lock, before it looks for update requests - so a "check now"
    followed by an Update sees the plan the check just wrote."""
    try:
        names = sorted(n for n in os.listdir(cfg.spool) if spool.DISCOVER_FILE.fullmatch(n))
    except FileNotFoundError:
        return 0
    for n in names:
        rid = spool.DISCOVER_FILE.fullmatch(n).group(1)
        try:
            doc = _read_ask(cfg, n, spool.DISCOVER_FILE, DISCOVER_KEYS, "discover")
        except spool.Invalid as e:
            spool.remove(cfg.spool, n)
            _audit(cfg, rid, "-", "discover", "refused", f"invalid ask: {e}")
            _record(cfg, "discover", {"at": iso(), "askedBy": None, "outcome": "refused",
                                      "reason": f"the ask was not acceptable: {e}", "tookMs": None})
            continue
        spool.remove(cfg.spool, n)  # claimed before it acts, like an update request
        who = doc["requestedBy"]
        age = available_age(cfg)
        if age is not None and age < updates.DISCOVER_MIN_SECONDS:
            # bothy-ops refuses this first, with the same constant. This copy is the
            # one that holds when the asking process is the thing that is wrong.
            why = (f"discovery ran {age}s ago; the limit is one every "
                   f"{updates.DISCOVER_MIN_SECONDS}s (an anonymous registry quota, per public IP)")
            _audit(cfg, rid, who, "discover", "refused", why)
            _record(cfg, "discover", {"at": iso(), "askedBy": who, "outcome": "refused", "reason": why,
                                      "tookMs": None})
            continue
        t0 = time.monotonic()
        rc, _, err = run(discover_argv(cfg), timeout=DISCOVER_TIMEOUT)
        took = int((time.monotonic() - t0) * 1000)
        # Discovery prints its summary line on stderr and exits 0 even when a
        # registry refused one component - the per-component error is in
        # available.json, and the page shows it on the row. So rc is the only
        # verdict here, and its last line is the detail.
        tail = hostio.tail(err, 300) or ("" if rc == 0 else f"exit {rc}")
        outcome = "ok" if rc == 0 else "failed"
        _audit(cfg, rid, who, "discover", outcome, f"{took}ms {tail}")
        _record(cfg, "discover", {"at": iso(), "askedBy": who, "outcome": outcome,
                                  "reason": tail or None, "tookMs": took})
    return len(names)


def rediscover(cfg: Config) -> str:
    """Look again, because a run just changed the box. executor.run_spool calls
    this once per drain that did work, with the global lock still held.

    WHY (2026-10-09). available.json and the plans beside it are a SNAPSHOT of
    what this box runs, taken when discovery runs. The moment a job applies,
    refuses or rolls back, that snapshot is a statement about a box that no longer
    exists - and until this existed nothing looked again until the six-hourly
    timer, so for up to six hours the page drew an Update button from data written
    before the work was done. The owner's screenshot was the refusal that follows
    it: `nothing to deploy: the cluster runs what main pins (8.6.0)`, over an
    available.json written nine minutes before the apply. A REFUSED job is the
    most important case, not an exception to it - "the plan no longer holds" is
    precisely the evidence that the stored plan was stale.

    NOT AN ASK, and no new power. It is the same fixed argv the timer runs
    (discover_argv, built from Config alone), decided by the host, about work the
    host had just finished; nothing in the spool can ask for it and nothing from a
    request reaches it. The limit on an ASK (one every
    updates.DISCOVER_MIN_SECONDS, the anonymous registry quota) is a limit on the
    asking process's share of that quota and deliberately does not apply here: a
    drain happens only after the host itself deployed or refused something, this
    runs at most once per drain whatever the drain did, and applying the limit
    would restore the bug for the commonest sequence there is - "check now", then
    Update, four minutes later.

    A FAILURE IS NOT THE JOB'S. The deployment already happened; a stale
    available.json afterwards is a separate and lesser fault. So this never
    raises: it returns one sentence for the journal and leaves one audit line, and
    the job keeps whatever result it earned. asks.json is left alone on purpose -
    that file answers "what did the last person who asked get?", and nobody asked
    for this one, any more than for the timer's run.
    """
    t0 = time.monotonic()
    rc, _, err = run(discover_argv(cfg), timeout=DISCOVER_TIMEOUT)
    took = int((time.monotonic() - t0) * 1000)
    detail = hostio.tail(err, 300) or ("" if rc == 0 else f"exit {rc}")
    _audit(cfg, "-", "-", "rediscover", "ok" if rc == 0 else "failed", f"{took}ms {detail}")
    if rc == 0:
        return f"looked again after the run in {took}ms: {detail or 'available.json and the plans rewritten'}"
    return (f"the re-check after the run FAILED ({detail}) - available.json is still what it was before the "
            "job, so the page may offer a plan the host would refuse; `just updates-discover` fixes it now, "
            "and the six-hourly timer will")


def drain_autorun(cfg: Config, env=None) -> int:
    """Claim and run every night-job ask in the spool. A real run may write ONE
    update request, which the executor's loop then picks up on its next turn.

    `env` is auto.Env - the clock, `systemctl show`, doctor and the plan writer -
    injected only by checks/test_asks.py, exactly as run_auto() takes it. The
    systemd unit passes nothing, so what runs on the box is auto.Env()'s defaults.
    """
    try:
        names = sorted(n for n in os.listdir(cfg.spool) if spool.AUTORUN_FILE.fullmatch(n))
    except FileNotFoundError:
        return 0
    if not names:
        return 0
    from . import auto
    for n in names:
        rid = spool.AUTORUN_FILE.fullmatch(n).group(1)
        try:
            doc = _read_ask(cfg, n, spool.AUTORUN_FILE, AUTORUN_KEYS, "autorun")
            if not isinstance(doc["dryRun"], bool):
                raise spool.Invalid("dryRun is not a boolean")
        except spool.Invalid as e:
            spool.remove(cfg.spool, n)
            _audit(cfg, rid, "-", "autorun", "refused", f"invalid ask: {e}")
            _record(cfg, "autorun", {"at": iso(), "askedBy": None, "outcome": "refused",
                                     "reason": f"the ask was not acceptable: {e}", "tookMs": None,
                                     "dryRun": False, "component": None, "jobId": None, "skipped": []})
            continue
        spool.remove(cfg.spool, n)
        who, dry = doc["requestedBy"], doc["dryRun"]
        t0 = time.monotonic()
        try:
            catalog = updates.load(cfg.catalog)
            d = auto.decide(cfg, env or auto.Env(), catalog, dry_run=dry)
            outcome, reason, comp, job = ("ok" if d.outcome == "requested" else "skipped"), d.reason, d.component, d.job
            skipped = [{"component": c, "why": w} for c, w in d.skipped]
        except Exception as e:  # noqa: BLE001 - a broken night job must not stop the drain
            outcome, reason, comp, job, skipped = "failed", f"{type(e).__name__}: {e}", None, None, []
        took = int((time.monotonic() - t0) * 1000)
        # The night job's OWN record (auto.json's `last`, one audit line as the
        # actor `auto`) is written by decide() for a real run. This adds the half
        # that record cannot carry: who asked for it, early, from the browser.
        _audit(cfg, rid, who, "autorun", outcome, f"{'dry run; ' if dry else ''}{reason}"[:300])
        _record(cfg, "autorun", {"at": iso(), "askedBy": who, "outcome": outcome, "reason": reason,
                                 "tookMs": took, "dryRun": dry, "component": comp, "jobId": job,
                                 "skipped": skipped[:20]})
    return len(names)
