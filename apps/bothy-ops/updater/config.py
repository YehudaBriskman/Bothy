"""Where everything is. One object, so a test can point ALL of it somewhere else.

Every default is the live box's; the end-to-end test (checks/e2e_updater.py)
builds a Config whose repo, catalog, state, backups and textfile directories
are all temporary, and whose components are a throwaway compose project. There
is no environment variable that swaps the canaries or the catalog in the
systemd unit: what the unit runs is what is written here.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from . import OPS

REPO = os.path.dirname(os.path.dirname(OPS))


def _state_root() -> str:
    return os.environ.get("STATE_ROOT") or os.path.expanduser("~/.local/state")


def _backup_root() -> str:
    return os.environ.get("BACKUP_ROOT") or os.path.expanduser("~/backups")


@dataclass
class Config:
    repo: str = REPO
    catalog: str = ""                   # default: <repo>/apps/bothy-ops/updates.toml
    state: str = ""                     # default: $STATE_ROOT/bothy/updates
    backups: str = ""                   # default: $BACKUP_ROOT
    textfile: str | None = ""           # default: $STATE_ROOT/bothy/textfile; None = no metrics
    # Borrowed with `docker run --rm` for the canaries, exactly as
    # scripts/lib/backup-lib.sh borrows it (BK_HELPER_IMAGE): it joins the target
    # container's network namespace, so a canary needs no published port and the
    # target image needs no curl.
    helper_image: str = os.environ.get("BK_HELPER_IMAGE", "python:3.13-alpine")
    backup_max_age: int = 24 * 3600
    keep_snapshots: int = 3
    apply_timeout: int = 900
    verify_timeout: int = 180
    min_free_bytes: int = 1 << 30
    max_jobs_per_run: int = 10
    # Extra canaries by component id - the tests' throwaway components only.
    canaries: dict = field(default_factory=dict)
    # Extra per-component words for a plan (downtime, signed out) - tests only.
    specifics: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.repo = os.path.realpath(self.repo)
        self.catalog = self.catalog or os.path.join(self.repo, "apps", "bothy-ops", "updates.toml")
        self.state = self.state or os.path.join(_state_root(), "bothy", "updates")
        self.backups = self.backups or _backup_root()
        if self.textfile == "":
            self.textfile = os.path.join(_state_root(), "bothy", "textfile")

    # ── the state directory: what bothy-ops sees (read-only) and writes (spool) ──
    @property
    def available(self) -> str:
        return os.path.join(self.state, "available.json")

    @property
    def spool(self) -> str:
        return os.path.join(self.state, "spool")

    @property
    def plans(self) -> str:
        return os.path.join(self.state, "plans")

    @property
    def status_file(self) -> str:
        return os.path.join(self.state, "status.json")

    @property
    def history_file(self) -> str:
        return os.path.join(self.state, "history.jsonl")

    @property
    def audit_file(self) -> str:
        # On the HOST, in a directory bothy-ops mounts read-only - not in
        # apps/bothy-ops/audit, which bothy-ops can write. The executor's record
        # of what it did must not be editable by the process that asked.
        return os.path.join(self.state, "audit.log")

    @property
    def lock_file(self) -> str:
        return os.path.join(self.state, ".updater.lock")

    @property
    def snapshots(self) -> str:
        return os.path.join(self.backups, "pre-update")

    @staticmethod
    def script(name: str) -> str:
        # The scripts are CODE, so they come from the checkout this package was
        # loaded from - not from `repo`, which is the tree being deployed (and a
        # temporary one in the tests).
        return os.path.join(REPO, "scripts", name)
