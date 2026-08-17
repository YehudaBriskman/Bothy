"""Resolve a client-supplied path to a real file, or refuse.

DERIVED FROM apps/portal-files/safepath.py, deliberately and with attribution.

Why a copy rather than an import. The two services do not share a build context:
`apps/bothy-config/compose.yml` builds with `context: .`, and Docker will not
follow a symlink or a `../` COPY out of it. Widening the context to `apps/` to
reach one module would put every other service's source into this image's build
context - which is a larger and less obvious change than a copy. The alternative,
publishing safepath as a package, is a build system this repo does not have.

So: a copy, trimmed to what the config tier actually needs (resolve, safe_open,
snapshot, the name deny-list). The archive walk, the secret content scanner and
the content-type tables are NOT here - this service serves no bytes to a browser
and walks no trees, so carrying them would be surface with no user.

THE DRIFT RISK IS REAL AND IS HANDLED BY A TEST, not by discipline.
checks/test_safepath.py runs the same truth table portal-files runs, including
real planted symlinks. If someone fixes a hole there and not here, the case they
added is the case that fails here.

── the threats, unchanged from the original ────────────────────────────────

    ../../../../etc/passwd          climbing out with dot-dot
    /etc/passwd                     an absolute path that ignores the root
    docs/link -> /etc               a symlink planted inside the root
    docs/../../.ssh/id_ed25519      dot-dot after a legitimate prefix
    .git/config                     inside the root, but not content

The defence is to resolve FIRST and compare AFTER. Checking the string for ".."
before resolving is the classic mistake: it cannot see a symlink, and it rejects
legitimate names that merely contain the characters. os.path.realpath() collapses
dot-dot AND follows every symlink, so the comparison happens on the real
destination - which is the only thing that matters.
"""

from __future__ import annotations

import fnmatch
import hashlib
import os
import stat
import time
import tomllib
from dataclasses import dataclass

# ── the policy is DECLARED, not coded ───────────────────────────────────────
#
# Same precedent, same reason: widening what this service may touch must be a
# reviewable diff in a file people open, not a Python constant nobody reads.
#
# It FAILS CLOSED. A missing file, a parse error, a root whose directory does not
# exist, or an unwritable snapshot directory raises at import and the service
# does not start. There is no built-in default, because the only safe default is
# "patch nothing", and a service that patches nothing looks broken in a way
# people work around by disabling the check.
POLICY_PATH = os.environ.get("POLICY_FILE",
                             os.path.join(os.path.dirname(__file__), "policy.toml"))


class PolicyError(Exception):
    """The policy could not be loaded. Fatal on purpose."""


class PathRefused(Exception):
    """A path was not proven safe. The message is safe to show a user."""


def _load_policy(path: str) -> dict:
    try:
        with open(path, "rb") as fh:
            doc = tomllib.load(fh)
    except FileNotFoundError as e:
        raise PolicyError(f"no policy at {path} - refusing to start") from e
    except tomllib.TOMLDecodeError as e:
        raise PolicyError(f"policy at {path} does not parse: {e}") from e

    roots = doc.get("roots")
    if not isinstance(roots, dict) or not roots:
        raise PolicyError("policy declares no roots")
    for name, cfg in roots.items():
        if not isinstance(cfg, dict) or not cfg.get("path"):
            raise PolicyError(f"root {name!r} has no path")
        # A declared-but-unmounted root presents as an empty directory, which
        # reads as "nothing to patch here" rather than "misconfigured".
        if not os.path.isdir(cfg["path"]):
            raise PolicyError(
                f"root {name!r} points at {cfg['path']}, which is not a directory "
                f"- is it mounted in compose.yml?")

    if not isinstance(doc.get("deny", {}).get("components"), list):
        raise PolicyError("policy is missing [deny].components")
    if not isinstance(doc.get("deny", {}).get("file_patterns"), list):
        raise PolicyError("policy is missing [deny].file_patterns")
    if not isinstance(doc.get("patch", {}).get("suffixes"), list):
        raise PolicyError("policy is missing [patch].suffixes")

    # The field allowlist is the whole point of this service, so an empty one is
    # a configuration error rather than a quiet no-op. A service that accepts
    # every request with "that field is not patchable" is indistinguishable from
    # a broken one, and the difference matters when someone is debugging at 3am.
    fields = doc.get("fields")
    if not isinstance(fields, dict) or not fields:
        raise PolicyError("policy declares no [fields] - nothing would be patchable")
    for fname, cfg in fields.items():
        if not isinstance(cfg, dict) or not cfg.get("kind"):
            raise PolicyError(f"field {fname!r} declares no kind")

    # Checked exactly like a root: declared but not mounted is a startup error.
    # A missing undo net that nobody notices until they need it is worse than no
    # undo net at all, because the whole point of it is that it is there without
    # being thought about.
    snaps = doc.get("snapshots")
    if not isinstance(snaps, dict) or not snaps.get("path"):
        raise PolicyError("policy declares no [snapshots].path")
    if not os.path.isdir(snaps["path"]):
        raise PolicyError(
            f"snapshot directory {snaps['path']} is not a directory "
            f"- is it mounted in compose.yml?")
    if not os.access(snaps["path"], os.W_OK | os.X_OK):
        raise PolicyError(
            f"snapshot directory {snaps['path']} is not writable by uid "
            f"{os.getuid()} - a bind mount docker created will be root-owned")
    return doc


POLICY = _load_policy(POLICY_PATH)

ROOTS: dict[str, str] = {k: v["path"] for k, v in POLICY["roots"].items()}
WRITABLE_ROOTS = frozenset(
    k for k, v in POLICY["roots"].items() if v.get("writable") is True)

DENY_COMPONENTS = frozenset(POLICY["deny"]["components"])
DENY_FILE_PATTERNS = tuple(POLICY["deny"]["file_patterns"])
PATCHABLE_SUFFIXES = frozenset(POLICY["patch"]["suffixes"])

# Whole files and whole directories that are never patched even though their
# suffix says they could be. See policy.toml for what is on each list and why -
# `edge/dynamic/` in particular is not a formatting preference.
DENY_RELPATHS = frozenset(POLICY["patch"].get("deny_relpaths", []))
DENY_PREFIXES = tuple(POLICY["patch"].get("deny_prefixes", []))

# The field allowlist, as the rest of the service sees it: {name: {kind, ...}}.
# Nothing outside this table is patchable, and there is no wildcard.
FIELDS: dict[str, dict] = dict(POLICY["fields"])

# The ceiling on any value, whatever its own field's limit says.
MAX_VALUE_LENGTH = int(POLICY.get("validate", {}).get("max_length", 500))

SNAPSHOT_DIR: str = POLICY["snapshots"]["path"]
SNAPSHOT_KEEP = int(POLICY["snapshots"].get("keep", 20))
SNAPSHOT_MAX_AGE = int(POLICY["snapshots"].get("max_age_days", 30)) * 86400
SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024
SNAPSHOT_UNCHANGED = ""
_SWEEP_EVERY = 3600

# A compose file is a page of YAML. Anything above this is not one, and reading
# it into memory to splice one label would be the wrong shape of mistake.
MAX_BYTES = 1_000_000


def is_denied_name(basename: str) -> bool:
    """True if this filename must never be opened.

    Case-insensitive, because the filesystem here is case-sensitive but the
    person who named `Key.PEM` did not mean something different by it.
    """
    name = basename.lower()
    return any(fnmatch.fnmatch(name, pat) for pat in DENY_FILE_PATTERNS)


def safe_open(abspath: str) -> tuple[int, os.stat_result]:
    """Open a regular file, closing three races at once. Caller must os.close().

    O_NOFOLLOW  - closes the window between realpath() and open() in which the
                  final component could be swapped for a symlink.
    O_NONBLOCK  - stops open() blocking FOREVER on a FIFO.
    fstat on fd - the size checked and the bytes read are the same inode, so
                  there is no size TOCTOU.
    """
    try:
        fd = os.open(abspath, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as e:
        raise PathRefused(f"cannot open: {e.strerror}") from e
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise PathRefused("not a regular file")
    except Exception:
        os.close(fd)
        raise
    return fd, st


@dataclass(frozen=True)
class Resolved:
    root_key: str
    root_dir: str      # the real directory the root names
    abspath: str       # the real, resolved location on disk
    relpath: str       # path relative to root_dir - what a human sees


def resolve(root_key: str, rel: str, *, for_write: bool = False) -> Resolved:
    """Return a Resolved, or raise PathRefused.

    Deliberately refuses rather than sanitising. Silently "fixing" a hostile path
    into a nearby legal one means an attack and a typo produce the same quiet
    success, and neither shows up anywhere.
    """
    root_dir = ROOTS.get(root_key)
    if root_dir is None:
        raise PathRefused(f"unknown root {root_key!r}")

    if not isinstance(rel, str) or not rel.strip():
        raise PathRefused("empty path")

    # A NUL truncates the path in any C-level call underneath us, so the check
    # above it could inspect one string while open() acts on a shorter one.
    if "\x00" in rel:
        raise PathRefused("path contains a null byte")

    # An absolute path would make os.path.join discard the root entirely -
    # join("/repos/stacks", "/etc/passwd") == "/etc/passwd". Refuse before joining.
    if os.path.isabs(rel):
        raise PathRefused("path must be relative to the root")

    real_root = os.path.realpath(root_dir)
    candidate = os.path.realpath(os.path.join(real_root, rel))

    # THE check. Compare resolved-to-resolved, with a trailing separator so that
    # a sibling directory sharing a name prefix cannot pass: without it,
    # "/repos/stacks-secret" starts with "/repos/stacks" and would be accepted.
    if candidate != real_root and not candidate.startswith(real_root + os.sep):
        raise PathRefused("path escapes its root")

    relpath = os.path.relpath(candidate, real_root)

    # Components of the RESOLVED path, so a symlink that lands inside .git is
    # caught by where it points rather than by what it is called.
    if set(relpath.split(os.sep)) & DENY_COMPONENTS:
        raise PathRefused("path is in a denied directory")

    # Then the FILENAME, for the same reason: a symlink named `compose.yml`
    # pointing at `.env` must be refused for what it reaches, not what it is
    # called.
    if is_denied_name(os.path.basename(candidate)):
        raise PathRefused("this file is excluded as a possible secret")

    # The two policy lists, applied on READ as well as on write.
    #
    # They were under `for_write` first, and checks/test_safepath.py caught it:
    # a symlink pointing into a denied path was refused for patching and
    # cheerfully READABLE, so `monitoring/prometheus-web.yml` - which exists on
    # the list because it carries a bcrypt hash - could be fetched through
    # /config/fields by naming a link to it. A deny list that half of the service
    # honours is a deny list nobody should rely on.
    #
    # Making them unconditional costs nothing real. This service has exactly one
    # read endpoint and its whole purpose is to describe what a form may change;
    # a file no form may change has nothing to say through it.
    #
    # Both checked on the RESOLVED relpath, so a symlink named
    # `apps/x/compose.yml` that lands in edge/dynamic/ is refused for where it
    # points rather than for what it is called.
    slashed = relpath.replace(os.sep, "/")
    if slashed in DENY_RELPATHS:
        raise PathRefused("this file is excluded by policy")
    if any(slashed.startswith(p) for p in DENY_PREFIXES):
        raise PathRefused(
            "this directory is excluded - see policy.toml for why edge/dynamic "
            "is edited as a diff and not as a form")

    if for_write:
        if root_key not in WRITABLE_ROOTS:
            raise PathRefused(f"the {root_key!r} root is read-only")
        if os.path.splitext(candidate)[1].lower() not in PATCHABLE_SUFFIXES:
            raise PathRefused(
                "only " + ", ".join(sorted(PATCHABLE_SUFFIXES)) + " files may be patched")
        # Writing THROUGH a symlink would let someone plant a link inside the
        # root and have us overwrite its target. The realpath check above already
        # proves the destination is inside the root, so this only forbids the
        # confusing case where the name and the target differ.
        if os.path.islink(os.path.join(real_root, rel)):
            raise PathRefused("refusing to write through a symlink")

    return Resolved(root_key=root_key, root_dir=real_root,
                    abspath=candidate, relpath=relpath)


def snapshot(root: str, relpath: str, abspath: str,
             incoming: bytes | None = None) -> str | None:
    """Keep the bytes a write is about to destroy. Returns the copy, or None.

    THE ONE QUESTION THIS ANSWERS is "what did this file say before the form
    changed it?" It is not version control and must not grow into it: no
    ordering, no messages, no merging. git is for history; this is for the ten
    seconds after a mistake.

    It matters MORE here than in the file tier, and that is worth saying. A
    person editing text in Files can see what they are about to overwrite. A
    person typing in a form cannot see the file at all, so the only evidence that
    a patch went somewhere unintended is the copy taken before it did.

    BEST EFFORT, DELIBERATELY. A failure here returns None and the write still
    happens - the opposite of how everything else in this module fails. Refusing
    to save because the safety net is missing would destroy the work it exists to
    protect. The caller reports which way it went, so a silently absent net is
    still visible.

    COPIED, NOT HARD-LINKED. os.link would be free, but an editor that truncates
    in place instead of renaming would then rewrite the snapshot's bytes through
    the shared inode, and a backup that silently follows the file it is backing
    up is worse than none.
    """
    dest_dir = os.path.realpath(os.path.join(SNAPSHOT_DIR, root, relpath))
    if not (dest_dir + os.sep).startswith(os.path.realpath(SNAPSHOT_DIR) + os.sep):
        return None

    try:
        fd, st = safe_open(abspath)
    except (PathRefused, OSError):
        return None  # nothing there yet: a create, not an overwrite
    try:
        if st.st_size > SNAPSHOT_MAX_BYTES:
            return None
        with os.fdopen(fd, "rb") as fh:
            data = fh.read()
    except OSError:
        os.close(fd)
        return None

    # A save that changes nothing destroys nothing, so there is nothing to keep.
    if incoming is not None and data == incoming:
        return SNAPSHOT_UNCHANGED

    digest = hashlib.sha256(data).hexdigest()[:12]
    try:
        os.makedirs(dest_dir, mode=0o700, exist_ok=True)
        prior = sorted(os.listdir(dest_dir))
        name = f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.{digest}"
        path = os.path.join(dest_dir, name)
        # O_EXCL: two patches in the same second must not clobber each other's
        # copy, which is exactly when a snapshot is most likely to be wanted.
        for n in range(20):
            try:
                sfd = os.open(f"{path}{'' if n == 0 else f'-{n}'}",
                              os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                break
            except FileExistsError:
                continue
        else:
            return None
        with os.fdopen(sfd, "wb") as out:
            out.write(data)

        _prune(dest_dir, prior)
        _sweep()
        return path
    except OSError:
        return None


def _prune(dest_dir: str, prior: list[str]) -> None:
    """Hold one file's snapshots to SNAPSHOT_KEEP, oldest dropped first."""
    if len(prior) < SNAPSHOT_KEEP:
        return
    for old in prior[:len(prior) - SNAPSHOT_KEEP + 1]:
        try:
            os.unlink(os.path.join(dest_dir, old))
        except OSError:
            pass


def _sweep() -> None:
    """Drop snapshots older than the policy's age, at most hourly.

    Gated on a marker's mtime rather than a timer thread: the work is
    proportional to the trash, and doing it on the save path means it cannot be
    forgotten when the process restarts. A patch must not pay for a full walk, so
    the common case is one stat().
    """
    marker = os.path.join(SNAPSHOT_DIR, ".last-sweep")
    now = time.time()
    try:
        if now - os.stat(marker).st_mtime < _SWEEP_EVERY:
            return
    except FileNotFoundError:
        pass
    except OSError:
        return
    try:
        with open(marker, "w"):
            pass
    except OSError:
        return

    cutoff = now - SNAPSHOT_MAX_AGE
    for dirpath, _dirnames, filenames in os.walk(SNAPSHOT_DIR, topdown=False):
        for fn in filenames:
            if fn == ".last-sweep":
                continue
            p = os.path.join(dirpath, fn)
            try:
                if os.stat(p).st_mtime < cutoff:
                    os.unlink(p)
            except OSError:
                pass
        if dirpath != SNAPSHOT_DIR:
            try:
                os.rmdir(dirpath)
            except OSError:
                pass
