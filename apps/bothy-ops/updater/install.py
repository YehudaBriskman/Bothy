"""The updater never replaces itself in the middle of a run (docs/plans/updates.md §6).

An update of Bothy moves the checkout. If the updater ran FROM that checkout, the
program doing the update would change under itself between two steps: a module
imported late, a rollback timer's command line, the next job's code. So on the
box it runs from a COPY:

    ~/.local/lib/bothy-updater/
        <sha>/                         one copy per installed or staged commit
            apps/bothy-ops/updater/    the package
            apps/bothy-ops/updates.py  the catalog parser it re-validates with
            apps/bothy-ops/discover_updates.py   the pin readers plans use
            apps/bothy-common/bothy_common/      audit.flat and friends
            INSTALL.json               {sha, repo, trees, installedAt}
        current -> <sha>               what the systemd units run
        staged  -> <sha>               a newer copy an update brought, NOT running

`just install-updater` copies HEAD's files out of git (never the working tree:
what runs is exactly a commit) and switches `current` with one atomic rename.
An own-code update whose release changes any of UPDATER_PATHS only STAGES the
new copy - Settings > Updates then says a manual `just install-updater` is
pending. Switching is a person's decision, made between jobs.

`INSTALL.json` records the git object id of every UPDATER_PATHS entry, so
"does this release change the updater?" is a comparison of ids, not of a diff
that could span a manual pull.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import tarfile

from . import hostio
from .config import Config
from .hostio import HostError, git, iso, run

# What the installed copy is made of. Everything the updater imports, and nothing
# it runs as a separate program (scripts/ stays the checkout's - see config.script).
UPDATER_PATHS = (
    "apps/bothy-ops/updater",
    "apps/bothy-ops/updates.py",
    "apps/bothy-ops/discover_updates.py",
    "apps/bothy-common/bothy_common",
)
KEEP = 3
_SHA = re.compile(r"[0-9a-f]{40}")


def trees(repo: str, sha: str) -> dict[str, str]:
    """{path: git object id} of each UPDATER_PATHS entry at `sha` (absent ones left out)."""
    out = {}
    for p in UPDATER_PATHS:
        rc, oid = git(repo, "rev-parse", "--verify", "--quiet", f"{sha}:{p}")
        if rc == 0 and re.fullmatch(r"[0-9a-f]{40}", oid):
            out[p] = oid
    return out


def _manifest(d: str) -> dict | None:
    try:
        doc = hostio.read_json(os.path.join(d, "INSTALL.json"), 64 * 1024)
    except (OSError, ValueError, HostError):
        return None
    return doc if isinstance(doc, dict) and _SHA.fullmatch(str(doc.get("sha"))) else None


def installed(cfg: Config, which: str = "current") -> dict | None:
    """The manifest `current` (or `staged`) points at, or None."""
    link = os.path.join(cfg.lib, which)
    if not os.path.islink(link):
        return None
    return _manifest(os.path.realpath(link))


def changed_paths(cfg: Config, target: str, head: str) -> list[str]:
    """The UPDATER_PATHS whose content at `target` differs from the copy that runs.

    Compared with the installed `current` when there is one - that is what runs,
    whatever HEAD says - and with HEAD otherwise (a checkout-run updater: tests,
    `just update-plan`)."""
    cur = installed(cfg)
    base = cur["trees"] if cur and isinstance(cur.get("trees"), dict) else trees(cfg.repo, head)
    new = trees(cfg.repo, target)
    return sorted(p for p in set(base) | set(new) if base.get(p) != new.get(p))


def copy_tree(cfg: Config, sha: str) -> str:
    """<lib>/<sha>/ holding UPDATER_PATHS exactly as committed at `sha`. Idempotent."""
    if not _SHA.fullmatch(sha):
        raise HostError(f"{sha!r} is not a commit id")
    hostio.ensure_dir(cfg.lib, 0o700)
    dest = os.path.join(cfg.lib, sha)
    want = trees(cfg.repo, sha)
    if not want:
        raise HostError(f"{sha[:12]} carries none of the updater's files")
    have = _manifest(dest)
    if have and have.get("trees") == want:
        return dest
    rc, out, err = _archive(cfg.repo, sha, sorted(want))
    if rc != 0:
        raise HostError(f"git archive {sha[:12]} failed: {err.strip()[:200]}")
    tmp = f"{dest}.tmp.{os.getpid()}"
    shutil.rmtree(tmp, ignore_errors=True)
    os.mkdir(tmp, 0o700)
    try:
        with tarfile.open(fileobj=io.BytesIO(out), mode="r:") as tf:
            tf.extractall(tmp, filter="data")
        hostio.write_json(os.path.join(tmp, "INSTALL.json"),
                          {"sha": sha, "repo": cfg.repo, "trees": want, "installedAt": iso()})
        if os.path.lexists(dest):
            shutil.rmtree(dest)
        os.rename(tmp, dest)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return dest


def _archive(repo: str, sha: str, paths: list[str]) -> tuple[int, bytes, str]:
    """`git archive` as BYTES (hostio.run is text)."""
    import subprocess
    try:
        p = subprocess.run(["git", "-C", repo, "archive", "--format=tar", sha, "--", *paths],
                           capture_output=True, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, b"", str(e)
    return p.returncode, p.stdout, p.stderr.decode(errors="replace")


def _point(cfg: Config, name: str, sha: str | None) -> None:
    """Atomically make <lib>/<name> point at <sha> (or remove it)."""
    link = os.path.join(cfg.lib, name)
    if sha is None:
        if os.path.islink(link):
            os.unlink(link)
        return
    tmp = f"{link}.tmp.{os.getpid()}"
    if os.path.lexists(tmp):
        os.unlink(tmp)
    os.symlink(sha, tmp)              # relative: the lib directory can move as a whole
    os.replace(tmp, link)


def write_status(cfg: Config) -> dict:
    """state/updater.json - what bothy-ops shows under Settings > Updates."""
    cur, stg = installed(cfg), installed(cfg, "staged")
    doc = {"version": 1, "writtenAt": iso(), "lib": cfg.lib,
           "current": {"sha": cur["sha"], "installedAt": cur.get("installedAt")} if cur else None,
           "staged": ({"sha": stg["sha"], "stagedAt": stg.get("stagedAt") or stg.get("installedAt"),
                       "job": stg.get("job")} if stg and (not cur or stg["sha"] != cur["sha"]) else None)}
    hostio.ensure_dir(cfg.state, 0o700)
    hostio.write_json(cfg.updater_file, doc)
    return doc


def _prune(cfg: Config) -> None:
    keep = {m["sha"] for m in (installed(cfg), installed(cfg, "staged")) if m}
    dirs = []
    for n in os.listdir(cfg.lib):
        d = os.path.join(cfg.lib, n)
        if _SHA.fullmatch(n) and os.path.isdir(d) and not os.path.islink(d):
            dirs.append((os.path.getmtime(d), n))
    for _, n in sorted(dirs, reverse=True)[KEEP:]:
        if n not in keep:
            shutil.rmtree(os.path.join(cfg.lib, n), ignore_errors=True)


def install(cfg: Config, sha: str | None = None) -> dict:
    """Copy `sha` (default HEAD) and switch `current` to it. `just install-updater`."""
    if sha is None:
        rc, sha = git(cfg.repo, "rev-parse", "HEAD")
        if rc != 0:
            raise HostError("git rev-parse HEAD failed")
    dest = copy_tree(cfg, sha)
    _point(cfg, "current", os.path.basename(dest))
    stg = installed(cfg, "staged")
    if stg and stg["sha"] == sha:
        _point(cfg, "staged", None)
    _prune(cfg)
    return write_status(cfg)


def stage(cfg: Config, sha: str, job: str | None = None) -> dict:
    """Copy `sha` beside `current` WITHOUT switching to it."""
    dest = copy_tree(cfg, sha)
    m = _manifest(dest) or {}
    m.update(stagedAt=iso(), job=job)
    hostio.write_json(os.path.join(dest, "INSTALL.json"), m)
    _point(cfg, "staged", os.path.basename(dest))
    _prune(cfg)
    return write_status(cfg)


def main_install(cfg: Config) -> int:
    rc, dirty = git(cfg.repo, "status", "--porcelain", "--", *UPDATER_PATHS)
    if rc == 0 and dirty:
        print("note: the updater's files have local changes; installing HEAD as committed, not the working tree")
    before = installed(cfg)
    doc = install(cfg)
    cur = doc["current"]["sha"]
    print(f"installed  {os.path.join(cfg.lib, cur)}")
    print(f"current -> {cur[:12]}" + (f"  (was {before['sha'][:12]})" if before and before["sha"] != cur else ""))
    print("The systemd units run from ~/.local/lib/bothy-updater/current: the next job uses it.")
    _, active, _ = run(["systemctl", "is-active", "bothy-updater.service"], timeout=10)
    if active.strip() == "active":
        print("note: an update job is running now; it finishes on the copy it started with")
    return 0
