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

from . import CODE, INSTALLED, REPO


def _state_root() -> str:
    return os.environ.get("STATE_ROOT") or os.path.expanduser("~/.local/state")


def _backup_root() -> str:
    return os.environ.get("BACKUP_ROOT") or os.path.expanduser("~/backups")


def _lib_root() -> str:
    return os.environ.get("BOTHY_UPDATER_LIB") or os.path.expanduser("~/.local/lib/bothy-updater")


# Bothy's own three, in the order an update brings them up (docs/plans/updates.md
# §6): bothy-web LAST, so the page showing the progress stays up the longest.
OWN_SERVICES = ("bothy-files", "bothy-ops", "bothy-web")


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

    # ── own code (class own-code, component `bothy`; build step 6) ──────────────
    # Where the updater is installed: <lib>/<sha>/ and a `current` symlink.
    lib: str = ""
    # The compose file that builds Bothy's images, repo-relative.
    own_compose: str = "apps/bothy/compose.yml"
    # service -> container name, and service -> image repository (`<repo>:<sha>`).
    # The same names on the box; a throwaway project's in the end-to-end test.
    own_containers: dict = field(default_factory=dict)
    own_images: dict = field(default_factory=dict)
    # The rollback timer: armed before the checkout moves, fires unless verify
    # disarms it. 10 minutes on the box; seconds in the test.
    own_rollback_after: int = 600
    own_apply_timeout: int = 420          # per service: `just up-apps <svc>`, --wait included
    own_build_timeout: int = 1800         # npm ci + vite build, from a cold cache
    # The edge's catch-all, as a browser reaches it. None: skip it (no Traefik - tests).
    own_edge_url: str | None = "http://127.0.0.1/"
    # Health endpoints read in each container's network namespace: svc -> (url, regex).
    own_health: dict = field(default_factory=lambda: {
        "bothy-files": ("http://127.0.0.1:8099/healthz", r'"ok"\s*:\s*true'),
        "bothy-ops": ("http://127.0.0.1:8097/healthz", r'"ok"\s*:\s*true'),
    })
    own_web_port: int = 80
    # `git fetch` while planning. Off only where there is no origin to ask.
    own_fetch: bool = True
    # CI's verdict on a sha: a callable(repo, sha) -> {green, via, detail, runs}.
    # None: the GitHub API (through `gh` when it is logged in, else unauthenticated).
    own_checks: object = None
    github_api: str = "https://api.github.com"
    # Tests only - there is no environment variable for it: "fail" makes verify
    # fail, "hang" makes verify sleep past the rollback timer.
    own_force_verify: str | None = None

    # ── cluster add-ons (class cluster; build step 8) ───────────────────────────
    # The OPERATOR's kubeconfig (None: kubectl's own default, ~/.kube/config) and
    # always an explicit context - never bothy-ops' namespaced token (SECURITY.md
    # rule 6). The plan refuses a service-account identity outright.
    kube_context: str = os.environ.get("KUBE_CONTEXT", "thales-scc")
    kubeconfig: str | None = None
    # The `cluster` label alloy.yaml stamps on every stream it ships to Loki.
    kube_cluster_label: str = "thales-scc"
    # Where the cluster canaries read the box's side: VictoriaMetrics' `up` and
    # Loki's fresh lines, from inside those containers (canaries.probe).
    vm_container: str = "victoriametrics"
    loki_container: str = "loki"
    cluster_timeout: int = 600           # the narrow `just k8s-monitoring <part>` (helm --wait, rollout)
    cluster_verify_timeout: int = 240    # a scrape interval or two, and alloy's first push

    # ── the Postgres major (class database, plan kind postgres-major; step 8) ───
    # The containers that write to Postgres and are stopped before the dump, and
    # the recipe that brings Keycloak and oauth2-proxy back after the switch.
    # postgres-exporter comes back with the switch itself (`just up-data`).
    pg_stop: tuple = ("keycloak", "oauth2-proxy", "postgres-exporter")
    pg_start: tuple = ("up-auth",)
    # Keycloak's container: its step-5 canaries verify the move (component `keycloak`).
    pg_keycloak: str = "keycloak"
    pg_ready_timeout: int = 180
    pg_restore_timeout: int = 3600
    # Tests only - no environment variable: "compare" fails the row-count
    # comparison (before the switch), "verify" fails the last step (after it).
    pg_force_fail: str | None = None

    def __post_init__(self) -> None:
        self.repo = os.path.realpath(self.repo)
        self.catalog = self.catalog or os.path.join(self.repo, "apps", "bothy-ops", "updates.toml")
        self.state = self.state or os.path.join(_state_root(), "bothy", "updates")
        self.backups = self.backups or _backup_root()
        self.lib = self.lib or _lib_root()
        self.own_containers = {s: self.own_containers.get(s, s) for s in OWN_SERVICES}
        self.own_images = {s: self.own_images.get(s, s) for s in OWN_SERVICES}
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

    @property
    def own_dir(self) -> str:
        """Own-code jobs' files: the armed rollback, its result, the CI cache."""
        return os.path.join(self.state, "own")

    @property
    def updater_file(self) -> str:
        """Which updater copy is installed and which is staged - bothy-ops reads it."""
        return os.path.join(self.state, "updater.json")

    @staticmethod
    def script(name: str) -> str:
        # The scripts are CODE, so they come from the checkout this package was
        # loaded from - not from `repo`, which is the tree being deployed (and a
        # temporary one in the tests). An INSTALLED copy carries no scripts/
        # (updater/install.py copies the Python only), so it uses the checkout it
        # was installed from, whose scripts/lib/env.sh finds that checkout's .env.
        return os.path.join(REPO if INSTALLED else CODE, "scripts", name)
