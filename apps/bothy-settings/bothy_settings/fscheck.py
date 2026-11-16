"""Is the state directory on a filesystem SQLite's WAL mode works on?

The record (settings-store.md s4, riskiest assumption 3): WAL "does not work over
a network filesystem and requires all processes to be on the same host", and its
behaviour on a Windows drive mount is UNVERIFIED, so the state dir is required to
be on a native filesystem and that is ASSERTED AT START.

A DENY-list of types known to be wrong rather than an allow-list of ext4: overlay,
xfs, btrfs, zfs and tmpfs are all fine, and an allow-list would refuse a valid
install over a name nobody listed. The price is that an exotic unlisted network
filesystem passes. On WSL2 the /mnt/<drive> mounts report as 9p (older kernels:
drvfs), which is why those are on the list.

When the type cannot be determined (no /proc/self/mountinfo) it REFUSES. A check
that passes when it cannot see is the failure this repo's mutants.sh exists for.
"""

from __future__ import annotations

import os

from .errors import UnsupportedFilesystemError

DENIED_TYPES = frozenset({
    "nfs", "nfs4", "cifs", "smb3", "smbfs", "9p", "drvfs", "virtiofs", "vboxsf",
    "afs", "ceph", "glusterfs", "lustre", "ncpfs", "fuseblk",
})
# `fuse.<anything>` (sshfs, rclone, s3fs ...) is a network or foreign filesystem
# by construction, except the one that backs container root filesystems.
_FUSE_OK = frozenset({"fuse.overlayfs"})


def read_mountinfo() -> str | None:
    try:
        with open("/proc/self/mountinfo", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def _unescape(field: str) -> str:
    # mountinfo octal-escapes space, tab, newline and backslash as \040 etc.
    out, i = [], 0
    while i < len(field):
        if field[i] == "\\" and field[i + 1:i + 4].isdigit():
            out.append(chr(int(field[i + 1:i + 4], 8)))
            i += 4
        else:
            out.append(field[i])
            i += 1
    return "".join(out)


def fstype_of(path: str, mountinfo: str) -> str | None:
    """The filesystem type of the mount that holds `path` (longest mount point wins)."""
    best_len, best_type = -1, None
    for line in mountinfo.splitlines():
        left, sep, right = line.partition(" - ")
        parts = left.split()
        rparts = right.split()
        if not sep or len(parts) < 5 or not rparts:
            continue
        mp = _unescape(parts[4])
        inside = path == mp or mp == "/" or path.startswith(mp.rstrip("/") + "/")
        # `>=`: of two mounts on the same point the LATER one is on top.
        if inside and len(mp) >= best_len:
            best_len, best_type = len(mp), rparts[0]
    return best_type


def require_supported(path: str, mountinfo: str | None = None) -> str:
    """Return the fstype, or raise UnsupportedFilesystemError."""
    real = os.path.realpath(path)
    text = read_mountinfo() if mountinfo is None else mountinfo
    fstype = fstype_of(real, text) if text else None
    if fstype is None:
        raise UnsupportedFilesystemError(
            f"cannot determine the filesystem type of {real}; refusing to put a "
            f"WAL database where that is unknown")
    if fstype in DENIED_TYPES or (fstype.startswith("fuse.") and fstype not in _FUSE_OK):
        raise UnsupportedFilesystemError(
            f"{real} is on a '{fstype}' filesystem; SQLite WAL needs a native local "
            f"one (ext4, xfs, btrfs, tmpfs, overlay). On WSL2 use the distro disk, "
            f"not a /mnt/<drive> path")
    return fstype
