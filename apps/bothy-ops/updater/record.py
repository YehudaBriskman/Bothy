"""The four records of a job, written by the host and only read by bothy-ops.

  status.json      the current (or last) job, rewritten after EVERY step, so the
                   Settings page keeps showing progress while bothy-ops, Traefik
                   or bothy-web restart underneath it
  history.jsonl    one line per finished job (from, to, digests, plan, who,
                   duration, snapshot, outcome)
  audit.log        one TSV line per step, refusals included - on the host, in a
                   directory bothy-ops can only read
  bothy_updater.prom   bothy_update_last_result{component,result} for
                   node-exporter's textfile collector

All four live where bothy-ops mounts READ-ONLY (or, the metric, node-exporter
does). A compromised bothy-ops can make a request; it cannot edit what happened.
"""

from __future__ import annotations

import calendar
import json
import os
import time

from bothy_common.audit import flat

from . import hostio
from .config import Config
from .hostio import iso

STEPS = ("validate", "preflight", "snapshot", "pull", "apply", "verify", "rollback", "restore", "record")
# Own code (owncode.py) builds instead of pulling, arms a rollback timer, moves
# the checkout, and may stage a new copy of the updater itself.
OWN_STEPS = ("validate", "preflight", "build", "snapshot", "arm", "switch", "apply", "verify", "rollback",
             "stage", "record")
RESULTS = ("succeeded", "rolled_back", "aborted", "failed", "refused")
HISTORY_KEEP = 500


def new_job(req: dict, name: str, steps: tuple[str, ...] = STEPS) -> dict:
    """A job record for a claimed request - built from its FIELDS only if they
    passed validation; otherwise from what can be said safely."""
    ok = isinstance(req, dict)
    g = (lambda k, n=200: flat(req.get(k))[:n] if ok and isinstance(req.get(k), str) else None)
    return {
        "id": name[:-5] if name.endswith(".json") else name[:32],
        "component": g("component", 40) or "?",
        "planId": g("planId", 24),
        "state": "running",
        "requestedBy": g("requestedBy") or "unknown",
        "requestedAt": g("requestedAt", 20),
        "startedAt": iso(),
        "endedAt": None,
        "from": None, "to": None,
        "steps": [{"name": s, "state": "pending", "startedAt": None, "endedAt": None, "detail": None}
                  for s in steps if s not in ("rollback", "restore")],
        "error": None, "snapshot": None, "note": None,
    }


class Recorder:
    def __init__(self, cfg: Config, job: dict) -> None:
        self.cfg = cfg
        self.job = job
        self.t0 = time.monotonic()
        self._write()

    def _write(self) -> None:
        hostio.write_json(self.cfg.status_file, {"version": 1, "job": self.job})

    def _step(self, name: str) -> dict:
        for s in self.job["steps"]:
            if s["name"] == name:
                return s
        s = {"name": name, "state": "pending", "startedAt": None, "endedAt": None, "detail": None}
        # rollback/restore appear only when they happen, before `record` (and
        # before own code's `stage`, which only a success reaches).
        names = [x["name"] for x in self.job["steps"]]
        at = names.index("stage") if "stage" in names else len(names) - 1
        self.job["steps"].insert(at, s)
        return s

    def reshape(self, steps: tuple[str, ...]) -> None:
        """Swap in another class's step list, keeping the steps already taken."""
        have = {s["name"]: s for s in self.job["steps"]}
        self.job["steps"] = [have.get(n) or {"name": n, "state": "pending", "startedAt": None, "endedAt": None,
                                             "detail": None}
                             for n in steps if n not in ("rollback", "restore")]
        self._write()

    def audit(self, step: str, state: str, detail: str = "") -> None:
        j = self.job
        line = "\t".join(flat(x) for x in (iso(), j["id"], j["component"], j["requestedBy"], step, state, detail))
        try:
            hostio.append_line(self.cfg.audit_file, line)
        except OSError:
            pass  # like bothy_common.audit: a full disk must not stop the rollback

    def step(self, name: str, state: str, detail: str | None = None) -> None:
        s = self._step(name)
        if state == "running":
            s["startedAt"] = iso()
        elif state in ("ok", "failed", "skipped"):
            s["startedAt"] = s["startedAt"] or iso()
            s["endedAt"] = iso()
        s["state"] = state
        if detail is not None:
            s["detail"] = flat(detail)[:500]
        self.audit(name, state, detail or "")
        self._write()

    def set(self, **kw) -> None:
        self.job.update(kw)
        self._write()

    def finish(self, result: str, error: str | None = None, note: str | None = None) -> dict:
        assert result in RESULTS
        for s in self.job["steps"]:
            if s["state"] == "pending":
                s["state"] = "skipped"
        self.step("record", "running")
        self.job.update(state=result, endedAt=iso(),
                        error=flat(error)[:500] if error else None, note=flat(note)[:800] if note else None)
        entry = {k: v for k, v in self.job.items() if k != "steps"}
        entry["durationMs"] = int((time.monotonic() - self.t0) * 1000)
        failed = [s["name"] for s in self.job["steps"] if s["state"] == "failed"]
        entry["failedStep"] = failed[0] if failed else None
        try:
            hostio.append_line(self.cfg.history_file, json.dumps(entry, sort_keys=True))
            _trim(self.cfg.history_file)
        except OSError as e:
            self.audit("record", "failed", f"history.jsonl: {e}")
        self.audit("result", result, error or note or "")
        write_metrics(self.cfg)
        self.step("record", "ok", result)
        return entry


def _trim(path: str) -> None:
    with open(path, encoding="utf-8") as fh:
        lines = fh.readlines()
    if len(lines) > HISTORY_KEEP * 2:
        hostio.atomic_write(path, "".join(lines[-HISTORY_KEEP:]))


def history(cfg: Config, limit: int = 50) -> list[dict]:
    try:
        with open(cfg.history_file, encoding="utf-8") as fh:
            lines = fh.readlines()[-limit:]
    except FileNotFoundError:
        return []
    out = []
    for ln in reversed(lines):
        try:
            d = json.loads(ln)
        except ValueError:
            continue
        if isinstance(d, dict):
            out.append(d)
    return out


def write_metrics(cfg: Config) -> None:
    """bothy_update_last_result{component,result}: 1 on the last result, 0 on the rest."""
    if not cfg.textfile:
        return
    last: dict[str, dict] = {}
    for e in reversed(history(cfg, HISTORY_KEEP)):
        if isinstance(e.get("component"), str) and e.get("state") in RESULTS:
            last[e["component"]] = e
    lines = ["# HELP bothy_update_last_result 1 on the result of the component's last update job (bothy-updater).",
             "# TYPE bothy_update_last_result gauge"]
    for cid in sorted(last):
        for r in RESULTS:
            lines.append(f'bothy_update_last_result{{component="{cid}",result="{r}"}} '
                         f'{1 if last[cid]["state"] == r else 0}')
    lines += ["# HELP bothy_update_last_run_timestamp_seconds When the component's last update job ended.",
              "# TYPE bothy_update_last_run_timestamp_seconds gauge"]
    for cid in sorted(last):
        try:
            ts = calendar.timegm(time.strptime(last[cid]["endedAt"], "%Y-%m-%dT%H:%M:%SZ"))
        except (TypeError, ValueError):
            continue
        lines.append(f'bothy_update_last_run_timestamp_seconds{{component="{cid}"}} {ts}')
    try:
        hostio.ensure_dir(cfg.textfile, 0o755)
        # 644: node-exporter runs as nobody (discover_updates.write, same reason).
        hostio.atomic_write(os.path.join(cfg.textfile, "bothy_updater.prom"), "\n".join(lines) + "\n", 0o644)
    except OSError:
        pass
