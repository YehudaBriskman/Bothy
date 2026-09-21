"""The only place this package starts a process or writes a file.

Every command is an argv LIST. Nothing here builds a shell string, and nothing
from a request reaches an argv except through a catalog lookup (a component id
selects a pin; the pin's file, service, image and recipe come from files on the
host). `run()` refuses anything that is not a list of str, so a later edit cannot
slip a string through by accident.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time

_DIGEST = re.compile(r"sha256:[a-f0-9]{64}")


class HostError(Exception):
    """A command or file operation failed. The message is written for a person."""


def iso(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if ts is None else ts))


def run(argv: list[str], *, timeout: float = 120, env: dict | None = None, cwd: str | None = None,
        stdin: str | None = None) -> tuple[int, str, str]:
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
        raise TypeError("run() takes an argv list of str - never a shell string")
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env, cwd=cwd,
                           input=stdin if stdin is not None else "", check=False)
    except subprocess.TimeoutExpired:
        return 124, "", f"{argv[0]} timed out after {int(timeout)}s"
    except OSError as e:
        return 127, "", f"{argv[0]}: {e}"
    return p.returncode, p.stdout, p.stderr


def run_io(argv: list[str], *, stdin_path: str | None = None, stdout_path: str | None = None,
           timeout: float = 900, env: dict | None = None, stderr_path: str | None = None) -> tuple[int, str]:
    """run() for BYTES: stdin from a file and/or stdout into a NEW file (0600).

    A pg_dump -Fc or a tar stream is binary, which run()'s text pipes would
    corrupt. The output file is created O_EXCL - a snapshot never overwrites -
    and removed again if the command fails. Returns (rc, stderr tail). With
    `stderr_path`, ALL of stderr also goes to that new file (0600) - a restore
    whose every error line must be read, not just the last 400 characters.
    """
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
        raise TypeError("run_io() takes an argv list of str - never a shell string")
    fin = fout = ferr = None
    try:
        fin = open(stdin_path, "rb") if stdin_path else subprocess.DEVNULL
        if stdout_path:
            fout = os.fdopen(os.open(stdout_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb")
        if stderr_path:
            ferr = os.fdopen(os.open(stderr_path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "w+b")
        p = subprocess.run(argv, stdin=fin, stdout=fout if fout else subprocess.DEVNULL,
                           stderr=ferr if ferr else subprocess.PIPE, timeout=timeout, env=env, check=False)
        if ferr:
            ferr.seek(0, os.SEEK_END)
            ferr.seek(max(0, ferr.tell() - 4096))
            rc, err = p.returncode, ferr.read().decode(errors="replace")
        else:
            rc, err = p.returncode, p.stderr.decode(errors="replace")
    except subprocess.TimeoutExpired:
        rc, err = 124, f"{argv[0]} timed out after {int(timeout)}s"
    except OSError as e:
        rc, err = 127, f"{argv[0]}: {e}"
    finally:
        if fin not in (None, subprocess.DEVNULL):
            fin.close()
        if fout:
            fout.close()
        if ferr:
            ferr.close()
    if rc != 0 and stdout_path and fout is not None and os.path.exists(stdout_path):
        os.unlink(stdout_path)
    return rc, tail(err, 400)


def tail(text: str, n: int = 400) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else "…" + text[-n:]


# ── files ──────────────────────────────────────────────────────────────────────

def ensure_dir(path: str, mode: int) -> None:
    os.makedirs(path, mode=mode, exist_ok=True)
    os.chmod(path, mode)


def atomic_write(path: str, data: str, mode: int = 0o600) -> None:
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".updater.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def write_json(path: str, doc: object, mode: int = 0o600) -> None:
    atomic_write(path, json.dumps(doc, indent=1, sort_keys=True) + "\n", mode)


def append_line(path: str, line: str, mode: int = 0o600) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, mode)
    try:
        os.write(fd, (line.rstrip("\n") + "\n").encode("utf-8"))
    finally:
        os.close(fd)


def read_json(path: str, limit: int = 2 * 1024 * 1024) -> object:
    with open(path, encoding="utf-8") as fh:
        text = fh.read(limit + 1)
    if len(text) > limit:
        raise HostError(f"{path} is implausibly large")
    return json.loads(text)


def dotenv(repo: str) -> dict[str, str]:
    """The environment `just` would give a recipe: ours, plus the repo's .env
    where ours has no value (just's dotenv-load, and scripts/lib/env.sh: the
    environment wins). Read, never sourced - a value is never executed."""
    env = dict(os.environ)
    path = os.path.join(repo, ".env")
    try:
        lines = open(path, encoding="utf-8").read().splitlines()
    except OSError:
        return env
    for ln in lines:
        if not ln or ln.lstrip().startswith("#") or "=" not in ln:
            continue
        k, v = ln.split("=", 1)
        k = k.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k):
            continue
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        env.setdefault(k, v)
    return env


# ── docker (the CLI, on the host - the executor is not behind a socket proxy) ──

def docker_json(argv: list[str], timeout: float = 30) -> list | dict | None:
    rc, out, _ = run(["docker", *argv], timeout=timeout)
    if rc != 0:
        return None
    try:
        return json.loads(out)
    except ValueError:
        return None


def container(name: str) -> dict | None:
    """{name, image, imageId, state, health, labels} of a container, or None."""
    j = docker_json(["inspect", "--type", "container", name])
    if not j:
        return None
    c = j[0]
    st = c.get("State") or {}
    return {
        "name": name,
        "image": (c.get("Config") or {}).get("Image"),
        "imageId": c.get("Image"),
        "state": st.get("Status"),
        "health": (st.get("Health") or {}).get("Status"),
        "labels": (c.get("Config") or {}).get("Labels") or {},
    }


def image(ref: str) -> dict | None:
    """{id, repoDigests, size, labels} of a local image, or None."""
    j = docker_json(["image", "inspect", ref])
    if not j:
        return None
    i = j[0]
    return {"id": i.get("Id"), "repoDigests": i.get("RepoDigests") or [], "size": i.get("Size") or 0,
            "labels": (i.get("Config") or {}).get("Labels") or {}}


def repo_digest(img: dict | None, repository_ref: str) -> str | None:
    """The digest under which `img` was pulled from `repository_ref` (registry/name)."""
    from discover_updates import split_image  # the one parser of image references
    for rd in (img or {}).get("repoDigests", []):
        s = split_image(rd)
        if s["ref"] == repository_ref and s["digest"]:
            return s["digest"]
    return None


def free_bytes(path: str) -> int | None:
    p = path
    while p and not os.path.exists(p):
        p = os.path.dirname(p)
    try:
        st = os.statvfs(p or "/")
    except OSError:
        return None
    return st.f_bavail * st.f_frsize


def docker_root() -> str:
    rc, out, _ = run(["docker", "info", "--format", "{{.DockerRootDir}}"], timeout=20)
    return out.strip() if rc == 0 and out.strip().startswith("/") else "/var/lib/docker"


# ── git ───────────────────────────────────────────────────────────────────────
# Read-only for every class but one. The updater never commits. Own code
# (owncode.py) fetches, fast-forwards the checkout to a green release tag, and -
# its rollback only, on a tree pre-flight proved clean - resets it back.

def git(repo: str, *args: str, timeout: float = 20) -> tuple[int, str]:
    rc, out, err = run(["git", "-C", repo, *args], timeout=timeout)
    return rc, (out if rc == 0 else err).strip()


def which(name: str) -> str | None:
    return shutil.which(name)
