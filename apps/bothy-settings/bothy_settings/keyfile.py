"""The master key (KEK) file: format, creation, loading, rotation helpers.

settings-store.md s6.1. A small versioned text file:

    bothy-master-key v1
    <key_id> <base64 of 32 bytes>        <- the FIRST line is the active key
    <key_id> <base64 of 32 bytes>        <- present only while a rotation is open

`key_id` is the first 8 bytes of SHA-256 of the key, hex, and is VERIFIED on load:
a line whose id does not match its key is a corrupted file, not a different key.

Rules this module enforces rather than documents:

  * never overwritten. Creation uses link(2) of a fully written temp file, which
    fails if the target exists, so a crash cannot leave a half-written key where
    the next start would read it as the key, and `--force` has nothing to force.
  * mode must leave nothing to group/other, the owner must be the current uid,
    it must be a regular file and not a symlink (O_NOFOLLOW), and its directory
    must not be writable by anyone else (a writable directory lets another user
    swap the file). It is REFUSED, never chmod-ed: fixing the mode silently would
    hide that the key was readable.
  * the key bytes never appear in a repr, an exception or a log line.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import os
import secrets
import stat
from dataclasses import dataclass, field

from .errors import KeyFileError, KeyFileModeError, KeyMissingError

HEADER = "bothy-master-key v1"
KEY_LEN = 32
_MAX_FILE = 64 * 1024


def key_id_of(key: bytes) -> str:
    return hashlib.sha256(key).digest()[:8].hex()


@dataclass(frozen=True)
class KeySet:
    """Ordered keys; the first is active. Holds secrets, so repr says nothing."""
    keys: tuple[tuple[str, bytes], ...] = field(repr=False)

    def __repr__(self) -> str:
        return f"KeySet(ids={list(self.ids)})"

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(k for k, _ in self.keys)

    @property
    def active_id(self) -> str:
        return self.keys[0][0]

    @property
    def active(self) -> bytes:
        return self.keys[0][1]

    def get(self, key_id: str) -> bytes | None:
        for k, v in self.keys:
            if k == key_id:
                return v
        return None


def _serialize(keys: KeySet) -> bytes:
    lines = [HEADER] + [f"{kid} {base64.b64encode(k).decode('ascii')}" for kid, k in keys.keys]
    return ("\n".join(lines) + "\n").encode("ascii")


def _parse(text: str, path: str) -> KeySet:
    lines = text.splitlines()
    if not lines or lines[0] != HEADER:
        raise KeyFileError(f"{path}: not a bothy master key file (header '{HEADER}' missing)")
    out: list[tuple[str, bytes]] = []
    for n, line in enumerate(lines[1:], start=2):
        parts = line.split(" ")
        if len(parts) != 2:
            raise KeyFileError(f"{path}: line {n} is not '<key_id> <base64>'")
        kid, b64 = parts
        try:
            key = base64.b64decode(b64.encode("ascii"), validate=True)
        except (binascii.Error, UnicodeEncodeError):
            raise KeyFileError(f"{path}: line {n} is not valid base64") from None
        if len(key) != KEY_LEN:
            raise KeyFileError(f"{path}: line {n} is not a {KEY_LEN}-byte key")
        if kid != key_id_of(key):
            raise KeyFileError(f"{path}: line {n} key_id does not match its key (corrupt)")
        if any(kid == k for k, _ in out):
            raise KeyFileError(f"{path}: line {n} repeats key_id {kid}")
        out.append((kid, key))
    if not out:
        raise KeyFileError(f"{path}: holds no key")
    return KeySet(tuple(out))


def _check_dir(path: str) -> None:
    d = os.path.dirname(os.path.abspath(path))
    try:
        st = os.stat(d)
    except OSError as e:
        raise KeyFileError(f"cannot stat key directory {d}: {e.strerror}") from None
    # g+w/o+w lets another user rename the file away and plant their own. A
    # sticky bit (/tmp) stops that for files we own, so it is accepted.
    if st.st_mode & 0o022 and not st.st_mode & stat.S_ISVTX:
        raise KeyFileModeError(f"key directory {d} is writable by group/other "
                               f"(mode {st.st_mode & 0o7777:04o}); make it 0700")


def load(path: str | os.PathLike[str], *, orphans: int | None = None) -> KeySet:
    path = os.fspath(path)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        raise KeyMissingError(path, orphans) from None
    except OSError as e:
        raise KeyFileModeError(f"cannot open key file {path}: {e.strerror} "
                               f"(a symlink is refused)") from None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise KeyFileModeError(f"{path} is not a regular file")
        if st.st_uid != os.geteuid():
            raise KeyFileModeError(f"{path} is owned by uid {st.st_uid}, not the running uid")
        if st.st_mode & 0o077:
            raise KeyFileModeError(f"{path} has mode {st.st_mode & 0o777:04o}; it must be "
                                   f"0600 (no access for group or other). Refusing to use it: "
                                   f"anyone who could read it could decrypt a copy of the store")
        if st.st_size > _MAX_FILE:
            raise KeyFileError(f"{path} is implausibly large for a key file")
        _check_dir(path)
        data = b""
        while True:
            chunk = os.read(fd, 8192)
            if not chunk:
                break
            data += chunk
    finally:
        os.close(fd)
    try:
        return _parse(data.decode("ascii"), path)
    except UnicodeDecodeError:
        raise KeyFileError(f"{path}: not ASCII text") from None


def _fsync_dir(path: str) -> None:
    fd = os.open(os.path.dirname(os.path.abspath(path)), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_temp(path: str, data: bytes) -> str:
    tmp = f"{path}.tmp.{os.getpid()}.{secrets.token_hex(4)}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        os.unlink(tmp)
        raise
    os.close(fd)
    return tmp


def _ensure_dir(path: str) -> None:
    d = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(d):
        os.makedirs(d, mode=0o700)
        os.chmod(d, 0o700)  # makedirs' mode is masked by umask


def create(path: str | os.PathLike[str]) -> KeySet:
    """Generate a key and write it, atomically, and NEVER over an existing file."""
    path = os.fspath(path)
    _ensure_dir(path)
    key = os.urandom(KEY_LEN)
    ks = KeySet(((key_id_of(key), key),))
    tmp = _write_temp(path, _serialize(ks))
    try:
        os.link(tmp, path)  # atomic, and fails if `path` exists in any form
    except FileExistsError:
        raise KeyFileError(f"{path} already exists; a master key is never overwritten") from None
    finally:
        os.unlink(tmp)
    _fsync_dir(path)
    return ks


def _replace(path: str, ks: KeySet) -> None:
    tmp = _write_temp(path, _serialize(ks))
    try:
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise
    _fsync_dir(path)


def append_active(path: str | os.PathLike[str]) -> KeySet:
    """Rotation step 2: a NEW key becomes active; every old key stays in the file."""
    path = os.fspath(path)
    cur = load(path)
    key = os.urandom(KEY_LEN)
    new = KeySet(((key_id_of(key), key),) + cur.keys)
    _replace(path, new)
    return new


def drop_active(path: str | os.PathLike[str]) -> KeySet:
    """Abort a rotation that has not rewrapped anything: the previous key is active again."""
    path = os.fspath(path)
    cur = load(path)
    if len(cur.keys) < 2:
        raise KeyFileError("no second key in the file; nothing to abort")
    new = KeySet(cur.keys[1:])
    _replace(path, new)
    return new


def retired_path(path: str | os.PathLike[str], key_id: str) -> str:
    return f"{os.fspath(path)}.retired.{key_id}"


def retire_inactive(path: str | os.PathLike[str]) -> list[str]:
    """Rotation step 5: move every non-active key to master.key.retired.<key_id>.

    Retired files are written (0600, fsynced) BEFORE the main file drops the lines,
    so a crash between the two leaves the key in both places, never in neither.
    """
    path = os.fspath(path)
    cur = load(path)
    moved: list[str] = []
    for kid, key in cur.keys[1:]:
        rp = retired_path(path, kid)
        data = _serialize(KeySet(((kid, key),)))
        if os.path.exists(rp):
            if load(rp).keys != ((kid, key),):
                raise KeyFileError(f"{rp} exists and holds a different key")
        else:
            tmp = _write_temp(rp, data)
            try:
                os.link(tmp, rp)
            finally:
                os.unlink(tmp)
        moved.append(rp)
    _fsync_dir(path)
    _replace(path, KeySet(cur.keys[:1]))
    return moved


def unretire(path: str | os.PathLike[str], key_id: str) -> KeySet:
    """Put a retired key back as an INACTIVE line, so an old backup can be restored
    (the store then opens with a rotation 'pending' and `rotate_kek` finishes it)."""
    path = os.fspath(path)
    cur = load(path)
    if cur.get(key_id) is not None:
        return cur
    rk = load(retired_path(path, key_id))
    new = KeySet(cur.keys + rk.keys)
    _replace(path, new)
    return new
