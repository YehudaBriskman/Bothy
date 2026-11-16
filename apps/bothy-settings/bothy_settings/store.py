"""The settings and secrets store (docs/plans/settings-store.md).

PUBLIC INTERFACE: put_value / put_secret / generate_secret / delete / get_meta /
list_meta / get_setting. There is NO method that returns a secret's value. Exactly
two internal capabilities decrypt, and both write an audit row:

    reveal_for_projection()   the projector (record s9)
    export_document()         the export bundle (record s11)

checks/test_store.py pins the public method list, so adding a third way to read a
secret fails a test and has to be argued for in review.

PROPERTY: no plaintext secret is ever written to disk by this library. The value
exists as bytes in this process while it is sealed or opened and is handed to
SQLite only as ciphertext. The audit, the log line and every exception carry
names, never values. (Python cannot wipe a str; memory is out of scope, as in
record s12.2.)

One process is the only writer: the state directory is flock-ed for the life of a
Store, and every write is BEGIN IMMEDIATE with its audit row in the same
transaction.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import logging
import mmap
import os
import secrets as _secrets
import sqlite3
import stat
import threading
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from . import audit as _audit
from . import crypto, fscheck, keyfile, names, schema
from .errors import (
    ClassificationError, CorruptDatabaseError, DecryptError, DowngradeError,
    ImportRefused, KeyFileError, KeyMissingError, NotFound, RestoreError,
    RestoreKeyMissing, RotationError, SettingsError, StoreBusyError,
    UnsupportedSQLiteError, ValidationError, VersionConflict, WrongKeyError,
)

DB_NAME = "settings.db"
EXPORT_FORMAT = "bothy-config-export/1"
KEY_CHECK = b"bothy-key-check-v1"
_STORE = names.INTERNAL_MODULE
_log = logging.getLogger("bothy.settings.audit")

_SQLITE_MIN = (3, 37, 0)  # STRICT tables


# -- small value types --------------------------------------------------------
@dataclass(frozen=True)
class Meta:
    """What the API may say about a field. `value` is filled for NON-secrets only."""
    module: str
    key: str
    is_secret: bool
    set: bool
    version: int | None = None
    updated_at: str | None = None
    updated_by: str | None = None
    fingerprint: str | None = None
    value: Any = None


@dataclass(frozen=True)
class BackupResult:
    path: str
    sha256: str
    size: int


@dataclass(frozen=True)
class AtRestReport:
    ok: bool
    secrets_checked: int
    problems: tuple[str, ...]


@dataclass(frozen=True)
class RotationResult:
    old_key_id: str
    new_key_id: str
    rewrapped: int
    finished: bool


@dataclass(frozen=True)
class RestoreReport:
    restored_from: str
    aside: str | None
    changed_since_backup: tuple[tuple[str, str], ...]


# -- helpers ------------------------------------------------------------------
def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _stamp() -> str:
    """A file-name-safe timestamp that cannot collide within one second."""
    return f"{_now().replace(':', '')}-{_secrets.token_hex(3)}"


def _fsync_dir(path: str) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _precreate(path: str) -> None:
    """Create an empty 0600 file, so SQLite (and its -wal/-shm) never exist wider."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    os.close(fd)


class _StateLock:
    def __init__(self, state: str):
        self.fd = os.open(os.path.join(state, ".lock"),
                          os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(self.fd)
            raise StoreBusyError(f"{state} is in use by another process "
                                 f"(a running service, or a restore)") from None

    def release(self) -> None:
        if self.fd >= 0:
            os.close(self.fd)  # closing drops the flock
            self.fd = -1


def _check_sqlite() -> None:
    if sqlite3.sqlite_version_info < _SQLITE_MIN:
        raise UnsupportedSQLiteError(
            f"SQLite {sqlite3.sqlite_version} is linked; the schema uses STRICT tables "
            f"and needs 3.37.0 or newer")


def _connect(path: str) -> sqlite3.Connection:
    c = sqlite3.connect(path, isolation_level=None, check_same_thread=False, timeout=5.0)
    c.row_factory = sqlite3.Row
    return c


def _pragmas(c: sqlite3.Connection) -> None:
    # Record s7. synchronous=FULL: a silently reverted "I rotated that password"
    # costs more than the fsync does at a few writes a day.
    mode = c.execute("PRAGMA journal_mode=WAL").fetchone()[0]
    if str(mode).lower() != "wal":
        raise UnsupportedSQLiteError(f"SQLite refused WAL (journal_mode={mode})")
    c.execute("PRAGMA synchronous=FULL")
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("PRAGMA busy_timeout=5000")
    c.execute("PRAGMA secure_delete=ON")


def _header_version(path: str) -> int:
    """user_version from the file header, with no connection (and so no side effect)."""
    try:
        with open(path, "rb") as f:
            head = f.read(100)
    except OSError as e:
        raise CorruptDatabaseError(f"cannot read {path}: {e.strerror}") from None
    if len(head) < 100 or head[:16] != b"SQLite format 3\x00":
        raise CorruptDatabaseError(
            f"{path} is not a settings database (empty, truncated or foreign). It is "
            f"NOT recreated: an empty store would be read as 'use defaults'. Restore the "
            f"last verified backup; if this was an interrupted first install, remove it")
    return int.from_bytes(head[60:64], "big")


def _integrity(c: sqlite3.Connection, path: str) -> None:
    try:
        rows = [r[0] for r in c.execute("PRAGMA integrity_check")]
        have = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    except sqlite3.DatabaseError:
        raise CorruptDatabaseError(f"{path} failed to read (corrupt or truncated)") from None
    if rows != ["ok"]:
        raise CorruptDatabaseError(f"{path} failed PRAGMA integrity_check "
                                   f"({len(rows)} problem(s)); refusing to start")
    if not schema.TABLES <= have:
        raise CorruptDatabaseError(f"{path} is missing tables "
                                   f"{sorted(schema.TABLES - have)}; refusing to start")


def _meta(c: sqlite3.Connection, k: str) -> bytes:
    r = c.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    if r is None:
        raise CorruptDatabaseError(f"meta.{k} is missing; refusing to start")
    return bytes(r[0])


def _set_meta(c: sqlite3.Connection, k: str, v: bytes) -> None:
    c.execute("INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)", (k, v))


def _wrap_store_key(kek: bytes, kek_id: str, store_id: bytes, name: str, key: bytes) -> bytes:
    nonce, ct = crypto.seal(kek, key, crypto.aad_wrap(store_id, _STORE, name, kek_id))
    return nonce + ct


def _unwrap_store_key(kek: bytes, kek_id: str, store_id: bytes, name: str, blob: bytes) -> bytes:
    try:
        return crypto.open_(kek, blob[:12], blob[12:], crypto.aad_wrap(store_id, _STORE, name, kek_id))
    except crypto.AuthFailure:
        raise CorruptDatabaseError(f"stored key '{name}' does not unwrap under key_id "
                                   f"{kek_id}: the database is tampered or damaged") from None


def _apply_migrations(c: sqlite3.Connection, current: int, before: Callable[[int, int], None] | None) -> int:
    """Forward-only, one transaction per step. `before(from, to)` runs once, first."""
    target = len(schema.MIGRATIONS)
    if current < target and before is not None and current > 0:
        before(current, target)
    for v in range(current, target):
        c.execute("BEGIN IMMEDIATE")
        try:
            for stmt in schema.MIGRATIONS[v]:
                c.execute(stmt)
            c.execute(f"PRAGMA user_version = {v + 1}")
            _set_meta(c, "schema_version", str(v + 1).encode())
            c.execute("COMMIT")
        except BaseException:
            c.execute("ROLLBACK")
            raise
    return target


def _tmp_name(state: str, tag: str) -> str:
    return os.path.join(state, f"{DB_NAME}.{tag}-{os.getpid()}-{_secrets.token_hex(4)}")


def _backup_to(src_path: str, dest: str) -> BackupResult:
    """Online-backup-API copy of `src_path` to a NEW 0600 file, verified and hashed.

    A fresh read connection, not the Store's own: a WAL reader sees one consistent
    snapshot while writers carry on, which is the property record s10 relies on
    (and why `cp` of a live WAL database is wrong).
    """
    if os.path.lexists(dest):
        raise SettingsError(f"{dest} already exists; backups are never overwritten")
    os.makedirs(os.path.dirname(os.path.abspath(dest)), mode=0o700, exist_ok=True)
    _precreate(dest)
    made = [dest]
    try:
        src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True, timeout=5.0)
        dst = sqlite3.connect(dest)
        try:
            src.backup(dst)
            # A standalone file: the WAL flag lives in the header the backup copied.
            dst.execute("PRAGMA journal_mode=DELETE")
            res = [r[0] for r in dst.execute("PRAGMA integrity_check")]
            has_meta = dst.execute("SELECT count(*) FROM meta WHERE k='store_id'").fetchone()[0]
        finally:
            dst.close()
            src.close()
        if res != ["ok"] or has_meta != 1:
            raise SettingsError("the backup did not verify (integrity_check / meta)")
        with open(dest, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        with open(dest + ".sha256", "x") as f:
            made.append(dest + ".sha256")  # only what WE created is removed on failure
            f.write(f"{digest}  {os.path.basename(dest)}\n")
        os.chmod(dest + ".sha256", 0o600)
        return BackupResult(dest, digest, os.path.getsize(dest))
    except BaseException:
        for p in made:
            try:
                os.unlink(p)
            except FileNotFoundError:
                pass
        raise


# -- the store ----------------------------------------------------------------
class Store:
    """Open with Store.open(); never construct directly."""

    def __init__(self, *, state: str, keyfile_path: str, conn: sqlite3.Connection, lock: _StateLock,
                 keys: keyfile.KeySet, kek_id: str, store_id: bytes, fp_key: bytes, audit_key: bytes):
        self._state = state
        self._db = os.path.join(state, DB_NAME)
        self._keyfile = keyfile_path
        self._conn = conn
        self._lock_file = lock
        self._keys = keys
        self._kek_id = kek_id
        self._store_id = store_id
        self._fp_key = fp_key
        self._audit_key = audit_key
        self._lock = threading.RLock()
        self._pending_log: list[dict[str, object]] = []
        self._closed = False
        #: test seam: called with a step name during rotation; raising simulates a crash.
        self.rotation_hook: Callable[[str], None] | None = None

    def __repr__(self) -> str:
        return f"<Store {self._db} key_id={self._kek_id}>"

    # ---- opening -----------------------------------------------------------
    @classmethod
    def open(cls, state_dir: str | os.PathLike[str], key_file: str | os.PathLike[str],
             *, _created_key: bool = False) -> "Store":
        """Open the store, creating the database (never the key) if it does not exist.

        Refuses, with a named error: no key; wrong key; wrong key-file mode;
        corrupt or truncated database; a database newer than this code; a state
        dir on a network or Windows-drive mount; SQLite older than 3.37.
        """
        _check_sqlite()
        state, kp = os.fspath(state_dir), os.fspath(key_file)
        if not os.path.isdir(state):
            os.makedirs(state, mode=0o700)
            os.chmod(state, 0o700)
        fscheck.require_supported(state)
        lock = _StateLock(state)
        try:
            return cls._open_locked(state, kp, lock, _created_key)
        except BaseException:
            lock.release()
            raise

    @classmethod
    def _open_locked(cls, state: str, kp: str, lock: _StateLock, created_key: bool) -> "Store":
        db = os.path.join(state, DB_NAME)
        for leftover in os.listdir(state):  # an interrupted creation never reached a rename
            if leftover.startswith((f"{DB_NAME}.creating-", f"{DB_NAME}.restoring-")):
                os.unlink(os.path.join(state, leftover))
        if os.path.islink(db):
            raise CorruptDatabaseError(f"{db} is a symlink; refusing to follow it")
        existed = os.path.lexists(db)
        if existed:
            return cls._open_existing(state, db, kp, lock)
        keys = keyfile.load(kp)  # raises KeyMissingError: a missing key never creates a store
        cls._create(state, db, keys, created_key)
        return cls._open_existing(state, db, kp, lock)

    @classmethod
    def _create(cls, state: str, db: str, keys: keyfile.KeySet, created_key: bool) -> None:
        """Build the whole store in a temp file, then rename it into place.

        A crash leaves either no database or a complete one, never an empty one
        that the next start would have to guess about.
        """
        tmp = _tmp_name(state, "creating")
        _precreate(tmp)
        c = _connect(tmp)
        try:
            _pragmas(c)
            _apply_migrations(c, 0, None)
            store_id = os.urandom(16)
            fp_key, audit_key = crypto.new_key(), crypto.new_key()
            kid, kek = keys.active_id, keys.active
            c.execute("BEGIN IMMEDIATE")
            _set_meta(c, "store_id", store_id)
            _set_meta(c, "created_at", _now().encode())
            _set_meta(c, "kek_id", kid.encode())
            nonce, ct = crypto.seal(kek, KEY_CHECK, crypto.aad_wrap(store_id, _STORE, "key_check", kid))
            _set_meta(c, "key_check", nonce + ct)
            _set_meta(c, "store_key.fp_key", _wrap_store_key(kek, kid, store_id, "fp_key", fp_key))
            _set_meta(c, "store_key.audit_key", _wrap_store_key(kek, kid, store_id, "audit_key", audit_key))
            why = ("created a new store on a freshly generated key" if created_key else
                   "created a NEW store on a pre-existing key (no database was present)")
            rec = _audit.append(c, audit_key, at=_now(), actor="system:bootstrap", surface="bootstrap",
                                action="migrate", detail=f"{why}; schema_version={len(schema.MIGRATIONS)}")
            c.execute("COMMIT")
            c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            _log.info(json.dumps(rec, sort_keys=True))
        except BaseException:
            c.close()
            os.unlink(tmp)
            raise
        c.close()
        for ext in ("-wal", "-shm"):
            try:
                os.unlink(tmp + ext)
            except FileNotFoundError:
                pass
        fd = os.open(tmp, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rename(tmp, db)
        _fsync_dir(state)

    @classmethod
    def _open_existing(cls, state: str, db: str, kp: str, lock: _StateLock) -> "Store":
        header_v = _header_version(db)
        if header_v > len(schema.MIGRATIONS):
            raise DowngradeError(f"{db} is schema version {header_v}; this code knows "
                                 f"{len(schema.MIGRATIONS)}. Not touched. Run the newer "
                                 f"release, or restore the pre-migration copy")
        c = _connect(db)
        try:
            try:
                version = c.execute("PRAGMA user_version").fetchone()[0]
            except sqlite3.DatabaseError:
                raise CorruptDatabaseError(f"{db} failed to read (corrupt or truncated)") from None
            if version > len(schema.MIGRATIONS):  # a newer version still in the WAL
                raise DowngradeError(f"{db} is schema version {version}; this code knows "
                                     f"{len(schema.MIGRATIONS)}. Not touched.")
            if version == 0:
                raise CorruptDatabaseError(f"{db} is not a settings database (schema version 0)")
            try:
                _pragmas(c)
            except sqlite3.DatabaseError:
                raise CorruptDatabaseError(f"{db} failed to read (corrupt or truncated)") from None
            _integrity(c, db)
            try:
                orphans = c.execute("SELECT count(*) FROM secrets").fetchone()[0]
            except sqlite3.DatabaseError:
                orphans = None
            keys = keyfile.load(kp, orphans=orphans)
            store_id = _meta(c, "store_id")
            if len(store_id) != 16:
                raise CorruptDatabaseError("meta.store_id is malformed; refusing to start")
            kek_id = _meta(c, "kek_id").decode("ascii", "replace")
            kek = keys.get(kek_id)
            if kek is None:
                raise WrongKeyError(kek_id, list(keys.ids))
            blob = _meta(c, "key_check")
            try:
                good = crypto.open_(kek, blob[:12], blob[12:],
                                    crypto.aad_wrap(store_id, _STORE, "key_check", kek_id)) == KEY_CHECK
            except crypto.AuthFailure:
                good = False
            if not good:
                raise CorruptDatabaseError("key_check does not decrypt although the key id matches: "
                                           "the database is tampered or damaged")
            fp_key = _unwrap_store_key(kek, kek_id, store_id, "fp_key", _meta(c, "store_key.fp_key"))
            audit_key = _unwrap_store_key(kek, kek_id, store_id, "audit_key", _meta(c, "store_key.audit_key"))
            migrated_from = None
            if version < len(schema.MIGRATIONS):
                migrated_from = version

                def pre(frm: int, to: int) -> None:
                    dest = os.path.join(state, f"pre-migrate-{frm}-{to}.db")
                    if os.path.lexists(dest):  # a failed attempt already left one: keep it, add another
                        dest = os.path.join(state, f"pre-migrate-{frm}-{to}-{_stamp()}.db")
                    _backup_to(db, dest)
                _apply_migrations(c, version, pre)
            elif int(_meta(c, "schema_version")) != version:
                raise CorruptDatabaseError("meta.schema_version disagrees with user_version")
            self = cls(state=state, keyfile_path=kp, conn=c, lock=lock, keys=keys, kek_id=kek_id,
                       store_id=store_id, fp_key=fp_key, audit_key=audit_key)
            if migrated_from is not None:
                with self._tx():
                    self._audit("migrate", actor="system:migrate", surface="bootstrap",
                                detail=f"schema {migrated_from} -> {len(schema.MIGRATIONS)}")
            return self
        except BaseException:
            c.close()
            raise

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            try:
                self._conn.close()
            finally:
                self._lock_file.release()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ---- transactions & audit ---------------------------------------------
    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            if self._closed:
                raise SettingsError("the store is closed")
            self._conn.execute("BEGIN IMMEDIATE")
            self._pending_log = []
            try:
                yield self._conn
                self._conn.execute("COMMIT")
            except BaseException:
                if self._conn.in_transaction:
                    self._conn.execute("ROLLBACK")
                self._pending_log = []
                raise
            pending, self._pending_log = self._pending_log, []
        for rec in pending:  # after COMMIT only: a rolled-back change leaves no log line
            _log.info(json.dumps(rec, sort_keys=True))

    def _audit(self, action: str, *, actor: str, surface: str, module: str | None = None,
               key: str | None = None, old_json: str | None = None, new_json: str | None = None,
               detail: str | None = None, request_id: str | None = None) -> None:
        rec = _audit.append(self._conn, self._audit_key, at=_now(), actor=actor, surface=surface,
                            action=action, module=module, key=key, old_json=old_json,
                            new_json=new_json, detail=detail, request_id=request_id)
        self._pending_log.append(rec)

    def _hook(self, step: str) -> None:
        if self.rotation_hook is not None:
            self.rotation_hook(step)

    # ---- registry ----------------------------------------------------------
    def register_fields(self, module: str, fields: Mapping[str, bool], *, actor: str,
                        surface: str = "cli", request_id: str | None = None) -> None:
        """Record which keys of a module are secret (copied from the module schema, #320).

        A classification is NEVER changed once registered: flipping a key from
        secret to plain is how a secret gets written in clear.
        """
        module, actor, surface, request_id = (names.module(module), names.actor(actor),
                                              names.surface(surface), names.request_id(request_id))
        for k, s in fields.items():
            names.key(k)
            if not isinstance(s, bool):
                raise ValidationError("is_secret must be a bool")
        with self._tx() as c:
            added = []
            for k, s in sorted(fields.items()):
                row = c.execute("SELECT is_secret FROM fields WHERE module=? AND key=?", (module, k)).fetchone()
                if row is None:
                    c.execute("INSERT INTO fields(module, key, is_secret) VALUES (?,?,?)", (module, k, int(s)))
                    added.append(f"{k}:{'secret' if s else 'plain'}")
                elif bool(row[0]) != s:
                    raise ClassificationError(f"{module}.{k} is registered as "
                                              f"{'secret' if row[0] else 'plain'}; a classification is never changed")
            if added:
                self._audit("register", actor=actor, surface=surface, module=module,
                            detail=",".join(added)[:1024], request_id=request_id)

    def _classification(self, c: sqlite3.Connection, module: str, key: str) -> bool:
        row = c.execute("SELECT is_secret FROM fields WHERE module=? AND key=?", (module, key)).fetchone()
        if row is None:
            raise ClassificationError(f"{module}.{key} is not registered in the fields registry")
        return bool(row[0])

    # ---- writes ------------------------------------------------------------
    def put_value(self, module: str, key: str, value: Any, *, actor: str, surface: str = "cli",
                  if_version: int | None = None, request_id: str | None = None) -> Meta:
        """Write a NON-secret. Refused if the registry says the key is a secret."""
        module, key, actor, surface, request_id = (names.module(module), names.key(key), names.actor(actor),
                                                   names.surface(surface), names.request_id(request_id))
        try:
            vj = json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
        except (TypeError, ValueError):
            raise ValidationError("a setting must be JSON-serialisable") from None
        if len(vj.encode()) > names.MAX_VALUE_BYTES:
            raise ValidationError(f"a value is at most {names.MAX_VALUE_BYTES} bytes")
        with self._tx() as c:
            if self._classification(c, module, key):
                raise ClassificationError(f"{module}.{key} is a secret; a plaintext put is refused")
            old = c.execute("SELECT value_json, version FROM settings WHERE module=? AND key=?",
                            (module, key)).fetchone()
            cur = old["version"] if old else 0
            self._check_version(module, key, if_version, cur if old else None)
            now = _now()
            c.execute("INSERT OR REPLACE INTO settings(module, key, value_json, version, updated_by, updated_at) "
                      "VALUES (?,?,?,?,?,?)", (module, key, vj, cur + 1, actor, now))
            self._audit("set", actor=actor, surface=surface, module=module, key=key,
                        old_json=old["value_json"] if old else None, new_json=vj, request_id=request_id)
        return Meta(module, key, False, True, cur + 1, now, actor, None, value)

    def put_secret(self, module: str, key: str, value: str, *, actor: str, surface: str = "cli",
                   if_version: int | None = None, request_id: str | None = None) -> Meta:
        """Replace a secret. Write-only: the returned Meta carries no value."""
        return self._put_secret(module, key, value, actor=actor, surface=surface,
                                if_version=if_version, request_id=request_id, action="set")

    def generate_secret(self, module: str, key: str, *, actor: str, surface: str = "cli", nbytes: int = 32,
                        if_version: int | None = None, request_id: str | None = None) -> Meta:
        """A server-side random value (token_urlsafe). It is never returned."""
        if not isinstance(nbytes, int) or isinstance(nbytes, bool) or not 16 <= nbytes <= 512:
            raise ValidationError("nbytes must be an int from 16 to 512")
        return self._put_secret(module, key, _secrets.token_urlsafe(nbytes), actor=actor, surface=surface,
                                if_version=if_version, request_id=request_id, action="generate")

    def _put_secret(self, module: str, key: str, value: str, *, actor: str, surface: str,
                    if_version: int | None, request_id: str | None, action: str) -> Meta:
        module, key, actor, surface, request_id = (names.module(module), names.key(key), names.actor(actor),
                                                   names.surface(surface), names.request_id(request_id))
        raw = self._encode_secret(value)
        with self._tx() as c:
            if not self._classification(c, module, key):
                raise ClassificationError(f"{module}.{key} is not a secret; storing it as one is refused")
            old = c.execute("SELECT version FROM secrets WHERE module=? AND key=?", (module, key)).fetchone()
            cur = old["version"] if old else 0
            self._check_version(module, key, if_version, cur if old else None)
            now = _now()
            fp = self._write_secret_row(c, module, key, raw, cur + 1, actor, now)
            self._audit(action, actor=actor, surface=surface, module=module, key=key,
                        detail="changed", request_id=request_id)
        return Meta(module, key, True, True, cur + 1, now, actor, fp)

    @staticmethod
    def _encode_secret(value: object) -> bytes:
        if not isinstance(value, str):
            raise ValidationError("a secret is a str")
        try:
            raw = value.encode("utf-8")
        except UnicodeEncodeError:
            raise ValidationError("a secret must be valid UTF-8 text") from None
        if len(raw) > names.MAX_VALUE_BYTES:
            raise ValidationError(f"a secret is at most {names.MAX_VALUE_BYTES} bytes")
        return raw

    def _write_secret_row(self, c: sqlite3.Connection, module: str, key: str, raw: bytes,
                          version: int, actor: str, now: str) -> str:
        """A NEW random DEK and nonce on every write (record s8.1)."""
        kek = self._keys.get(self._kek_id)
        if kek is None:
            raise WrongKeyError(self._kek_id, list(self._keys.ids))
        dek = crypto.new_key()
        nonce, ct = crypto.seal(dek, raw, crypto.aad_value(self._store_id, module, key))
        wnonce, wdek = crypto.seal(kek, dek, crypto.aad_wrap(self._store_id, module, key, self._kek_id))
        fp = crypto.fingerprint(self._fp_key, module, key, raw)
        c.execute("INSERT OR REPLACE INTO secrets(module, key, ciphertext, nonce, wrapped_dek, wrap_nonce, "
                  "kek_id, version, fingerprint, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                  (module, key, ct, nonce, wdek, wnonce, self._kek_id, version, fp, actor, now))
        return fp

    @staticmethod
    def _check_version(module: str, key: str, if_version: int | None, current: int | None) -> None:
        """None: unconditional. 0: must not exist. n: must equal the current version."""
        if if_version is None:
            return
        if isinstance(if_version, bool) or not isinstance(if_version, int) or if_version < 0:
            raise ValidationError("if_version must be a non-negative int")
        if if_version != (current or 0):
            raise VersionConflict(module, key, if_version, current or 0)

    def delete(self, module: str, key: str, *, actor: str, surface: str = "cli",
               if_version: int | None = None, request_id: str | None = None) -> None:
        module, key, actor, surface, request_id = (names.module(module), names.key(key), names.actor(actor),
                                                   names.surface(surface), names.request_id(request_id))
        with self._tx() as c:
            secret = self._classification(c, module, key)
            table = "secrets" if secret else "settings"
            old = c.execute(f"SELECT version{'' if secret else ', value_json'} FROM {table} "
                            "WHERE module=? AND key=?", (module, key)).fetchone()
            if old is None:
                raise NotFound(f"{module}.{key} is not set")
            self._check_version(module, key, if_version, old["version"])
            c.execute(f"DELETE FROM {table} WHERE module=? AND key=?", (module, key))
            self._audit("delete", actor=actor, surface=surface, module=module, key=key,
                        old_json=None if secret else old["value_json"],
                        detail="removed" if secret else None, request_id=request_id)

    # ---- reads (metadata only for secrets) ---------------------------------
    def get_meta(self, module: str, key: str) -> Meta:
        module, key = names.module(module), names.key(key)
        with self._lock:
            return self._meta_of(module, key)

    def _meta_of(self, module: str, key: str) -> Meta:
        reg = self._conn.execute("SELECT is_secret FROM fields WHERE module=? AND key=?", (module, key)).fetchone()
        if reg is None:
            raise NotFound(f"{module}.{key} is not registered")
        if reg[0]:
            r = self._conn.execute("SELECT version, updated_at, updated_by, fingerprint FROM secrets "
                                   "WHERE module=? AND key=?", (module, key)).fetchone()
            if r is None:
                return Meta(module, key, True, False)
            return Meta(module, key, True, True, r["version"], r["updated_at"], r["updated_by"], r["fingerprint"])
        r = self._conn.execute("SELECT value_json, version, updated_at, updated_by FROM settings "
                               "WHERE module=? AND key=?", (module, key)).fetchone()
        if r is None:
            return Meta(module, key, False, False)
        return Meta(module, key, False, True, r["version"], r["updated_at"], r["updated_by"], None,
                    json.loads(r["value_json"]))

    def list_meta(self, module: str | None = None) -> list[Meta]:
        if module is not None:
            module = names.module(module)
        with self._lock:
            rows = self._conn.execute("SELECT module, key FROM fields WHERE (? IS NULL OR module=?) "
                                      "ORDER BY module, key", (module, module)).fetchall()
            return [self._meta_of(r["module"], r["key"]) for r in rows]

    def get_setting(self, module: str, key: str) -> Any:
        """A non-secret's value. Refuses a secret outright."""
        m = self.get_meta(module, key)
        if m.is_secret:
            raise ClassificationError(f"{m.module}.{m.key} is a secret; there is no read verb for it")
        if not m.set:
            raise NotFound(f"{m.module}.{m.key} is not set")
        return m.value

    def read_audit(self, *, after_id: int = 0, limit: int = 100) -> list[dict[str, object]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, at, actor, surface, action, module, key, old_json, new_json, detail, request_id "
                "FROM audit WHERE id > ? ORDER BY id LIMIT ?", (int(after_id), max(1, min(int(limit), 1000)))
            ).fetchall()
        return [dict(r) for r in rows]

    def verify_audit(self) -> _audit.Verification:
        with self._lock:
            return _audit.verify(self._conn, self._audit_key)

    # ---- the two internal decrypt paths ------------------------------------
    def _open_row(self, r: sqlite3.Row) -> bytes:
        module, key = r["module"], r["key"]
        kek = self._keys.get(r["kek_id"])
        if kek is None:
            raise WrongKeyError(r["kek_id"], list(self._keys.ids))
        try:
            dek = crypto.open_(kek, bytes(r["wrap_nonce"]), bytes(r["wrapped_dek"]),
                               crypto.aad_wrap(self._store_id, module, key, r["kek_id"]))
            return crypto.open_(dek, bytes(r["nonce"]), bytes(r["ciphertext"]),
                                crypto.aad_value(self._store_id, module, key))
        except crypto.AuthFailure:
            raise DecryptError(module, key) from None

    def _read_denied(self, module: str, key: str, actor: str, surface: str) -> None:
        try:
            with self._tx():
                self._audit("read-denied", actor=actor, surface=surface, module=module, key=key,
                            detail="row failed authentication")
        except sqlite3.Error:
            pass  # failing to record the failure must not mask it

    def reveal_for_projection(self, module: str, key: str, *, actor: str, surface: str = "cli") -> str:
        """INTERNAL. Decrypt one secret for the projector. Audited; the value is not."""
        module, key, actor, surface = names.module(module), names.key(key), names.actor(actor), names.surface(surface)
        with self._lock:
            r = self._conn.execute("SELECT * FROM secrets WHERE module=? AND key=?", (module, key)).fetchone()
            if r is None:
                raise NotFound(f"{module}.{key} is not set")
            try:
                raw = self._open_row(r)
            except DecryptError:
                self._read_denied(module, key, actor, surface)
                raise
            with self._tx():
                self._audit("projection", actor=actor, surface=surface, module=module, key=key,
                            detail="projected")
            return raw.decode("utf-8")

    def export_document(self, *, actor: str, surface: str = "cli", bothy_version: str = "unknown") -> dict[str, Any]:
        """INTERNAL. Every setting and every secret, decrypted, in memory. Audited with a count.

        The caller owns the plaintext this returns and must stream it to `age`
        (export.age_encrypt) without writing it anywhere.
        """
        actor, surface = names.actor(actor), names.surface(surface)
        with self._lock:
            mods: dict[str, dict[str, dict[str, Any]]] = {}
            n = 0
            for r in self._conn.execute("SELECT * FROM settings ORDER BY module, key").fetchall():
                mods.setdefault(r["module"], {"settings": {}, "secrets": {}})["settings"][r["key"]] = \
                    json.loads(r["value_json"])
                n += 1
            for r in self._conn.execute("SELECT * FROM secrets ORDER BY module, key").fetchall():
                try:
                    raw = self._open_row(r)
                except DecryptError:
                    self._read_denied(r["module"], r["key"], actor, surface)
                    raise
                mods.setdefault(r["module"], {"settings": {}, "secrets": {}})["secrets"][r["key"]] = raw.decode("utf-8")
                n += 1
            with self._tx():
                self._audit("export", actor=actor, surface=surface, detail=f"{n} value(s)")
        return {"format": EXPORT_FORMAT, "exported_at": _now(), "bothy_version": str(bothy_version),
                "modules": [{"module": m, **v} for m, v in sorted(mods.items())]}

    def import_document(self, doc: Mapping[str, Any], *, actor: str, surface: str = "import",
                        merge: bool = False) -> int:
        """Load an export document. Into an EMPTY store unless `merge`.

        Every field must already be registered with the same classification
        (the caller registers the module schemas first): unknown fields are
        rejected, as the record requires. One transaction, one audit row. Values
        are re-wrapped under THIS store's key, so a different KEK is fine.
        """
        actor, surface = names.actor(actor), names.surface(surface)
        parsed = self._parse_document(doc)
        with self._tx() as c:
            if not merge and (c.execute("SELECT count(*) FROM settings").fetchone()[0]
                              or c.execute("SELECT count(*) FROM secrets").fetchone()[0]):
                raise ImportRefused("the store is not empty; use merge to overwrite")
            now = _now()
            for module, key, secret, value in parsed:
                if self._classification(c, module, key) != secret:
                    raise ImportRefused(f"{module}.{key}: classification differs from the registry")
                if secret:
                    old = c.execute("SELECT version FROM secrets WHERE module=? AND key=?", (module, key)).fetchone()
                    self._write_secret_row(c, module, key, value, (old[0] if old else 0) + 1, actor, now)
                else:
                    old = c.execute("SELECT version FROM settings WHERE module=? AND key=?", (module, key)).fetchone()
                    c.execute("INSERT OR REPLACE INTO settings(module, key, value_json, version, updated_by, "
                              "updated_at) VALUES (?,?,?,?,?,?)",
                              (module, key, value, (old[0] if old else 0) + 1, actor, now))
            self._audit("import", actor=actor, surface=surface, detail=f"{len(parsed)} value(s)")
        return len(parsed)

    def _parse_document(self, doc: Mapping[str, Any]) -> list[tuple[str, str, bool, Any]]:
        """Strict: any unknown key anywhere refuses the whole document."""
        def bad(why: str) -> ImportRefused:
            return ImportRefused(f"export document refused: {why}")
        if not isinstance(doc, Mapping) or set(doc) != {"format", "exported_at", "bothy_version", "modules"}:
            raise bad("unexpected top-level shape")
        if doc["format"] != EXPORT_FORMAT:
            raise bad("unsupported format version")
        if not isinstance(doc["modules"], list):
            raise bad("modules is not a list")
        out: list[tuple[str, str, bool, Any]] = []
        for m in doc["modules"]:
            if not isinstance(m, Mapping) or set(m) != {"module", "settings", "secrets"}:
                raise bad("unexpected module shape")
            if not isinstance(m["settings"], Mapping) or not isinstance(m["secrets"], Mapping):
                raise bad("settings and secrets must be objects")
            try:
                module = names.module(m["module"])
                for k, v in m["settings"].items():
                    vj = json.dumps(v, sort_keys=True, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
                    if len(vj.encode()) > names.MAX_VALUE_BYTES:
                        raise bad("a value is too large")
                    out.append((module, names.key(k), False, vj))
                for k, v in m["secrets"].items():
                    out.append((module, names.key(k), True, self._encode_secret(v)))
            except (ValidationError, TypeError, ValueError):
                raise bad("an invalid module, key or value") from None
        with self._lock:
            for module, key, secret, _ in out:
                r = self._conn.execute("SELECT is_secret FROM fields WHERE module=? AND key=?", (module, key)).fetchone()
                if r is None:
                    raise ImportRefused(f"{module}.{key} is not a registered field; unknown fields are rejected")
                if bool(r[0]) != secret:
                    raise ImportRefused(f"{module}.{key}: classification differs from the registry")
        return out

    # ---- backup ------------------------------------------------------------
    def backup(self, dest: str | os.PathLike[str] | None = None) -> BackupResult:
        """A consistent, verified, hashed copy via SQLite's online-backup API."""
        if dest is None:
            dest = os.path.join(self._state, "backups", f"settings-{_stamp()}.db")
        return _backup_to(self._db, os.fspath(dest))

    # ---- rotation ----------------------------------------------------------
    @property
    def key_id(self) -> str:
        return self._kek_id

    def _needs_rewrap(self) -> bool:
        if self._kek_id != self._keys.active_id:
            return True
        return self._conn.execute("SELECT count(*) FROM secrets WHERE kek_id != ?",
                                  (self._keys.active_id,)).fetchone()[0] > 0

    @property
    def rotation_state(self) -> str:
        """none | pending-rewrap (new key in the file, rows not moved) | pending-finish (rows moved,
        old key still in the file)."""
        with self._lock:
            if self._needs_rewrap():
                return "pending-rewrap"
            return "pending-finish" if len(self._keys.keys) > 1 else "none"

    def rotate_kek(self, *, actor: str, surface: str = "cli", finish: bool = True,
                   request_id: str | None = None) -> RotationResult:
        """Record s8.2. Resumable: run it again after a crash at any step.

        1 backup (verified)  2 new key appended, old kept  3 ONE transaction rewrapping every DEK and
        both store keys (values are not re-encrypted)  4 verify with the new key ALONE
        5 finish: old key moved to master.key.retired.<key_id>.
        """
        actor, surface, request_id = names.actor(actor), names.surface(surface), names.request_id(request_id)
        with self._lock:
            old_id = self._kek_id
            if self.rotation_state == "none":
                self.backup(os.path.join(self._state, "backups", f"pre-rotate-{old_id}-{_stamp()}.db"))
                self._hook("backup")
                self._keys = keyfile.append_active(self._keyfile)
                self._hook("keyfile")
            n = 0
            if self._needs_rewrap():
                n = self._rewrap_all(actor, surface, request_id)
                self._hook("rewrap")
            self._verify_with_active_key_only()
            self._hook("verify")
            done = False
            if finish:
                self.finish_rotation()
                done = True
            return RotationResult(old_id, self._keys.active_id, n, done)

    def _rewrap_all(self, actor: str, surface: str, request_id: str | None) -> int:
        new_id, new = self._keys.active_id, self._keys.active
        with self._tx() as c:
            rows = c.execute("SELECT module, key, wrapped_dek, wrap_nonce, kek_id FROM secrets").fetchall()
            for r in rows:
                old = self._keys.get(r["kek_id"])
                if old is None:
                    raise RotationError(f"cannot rewrap {r['module']}.{r['key']}: key_id {r['kek_id']} "
                                        f"is not in the key file")
                try:
                    dek = crypto.open_(old, bytes(r["wrap_nonce"]), bytes(r["wrapped_dek"]),
                                       crypto.aad_wrap(self._store_id, r["module"], r["key"], r["kek_id"]))
                except crypto.AuthFailure:
                    raise DecryptError(r["module"], r["key"]) from None
                wn, wd = crypto.seal(new, dek, crypto.aad_wrap(self._store_id, r["module"], r["key"], new_id))
                c.execute("UPDATE secrets SET kek_id=?, wrap_nonce=?, wrapped_dek=? WHERE module=? AND key=?",
                          (new_id, wn, wd, r["module"], r["key"]))
            self._hook("rewrap-midway")
            old = self._keys.get(self._kek_id)
            if old is None:
                raise RotationError(f"the store's key_id {self._kek_id} is not in the key file")
            for name, plain in (("fp_key", self._fp_key), ("audit_key", self._audit_key)):
                _set_meta(c, f"store_key.{name}", _wrap_store_key(new, new_id, self._store_id, name, plain))
            nonce, ct = crypto.seal(new, KEY_CHECK, crypto.aad_wrap(self._store_id, _STORE, "key_check", new_id))
            _set_meta(c, "key_check", nonce + ct)
            _set_meta(c, "kek_id", new_id.encode())
            self._audit("rotate-kek", actor=actor, surface=surface, request_id=request_id,
                        detail=f"{len(rows)} data key(s) rewrapped {self._kek_id} -> {new_id}")
            self._hook("rewrap-precommit")
        self._kek_id = new_id
        return len(rows)

    def _verify_with_active_key_only(self) -> None:
        only = keyfile.KeySet(self._keys.keys[:1])
        rows = self._conn.execute("SELECT * FROM secrets").fetchall()
        for r in rows:
            if r["kek_id"] != only.active_id:
                raise RotationError(f"{r['module']}.{r['key']} is still wrapped under {r['kek_id']}")
            try:
                dek = crypto.open_(only.active, bytes(r["wrap_nonce"]), bytes(r["wrapped_dek"]),
                                   crypto.aad_wrap(self._store_id, r["module"], r["key"], r["kek_id"]))
                crypto.open_(dek, bytes(r["nonce"]), bytes(r["ciphertext"]),
                             crypto.aad_value(self._store_id, r["module"], r["key"]))
            except crypto.AuthFailure:
                raise RotationError(f"{r['module']}.{r['key']} does not decrypt under the new key alone; "
                                    f"the old key is still in the key file") from None

    def finish_rotation(self) -> list[str]:
        with self._lock:
            if self._needs_rewrap():
                raise RotationError("rows are not all under the active key; run rotate_kek first")
            moved = keyfile.retire_inactive(self._keyfile)
            self._keys = keyfile.load(self._keyfile)
            self._hook("finish")
            return moved

    def abort_rotation(self) -> None:
        """Only while NOTHING has been rewrapped: drop the new key, the old one is active again."""
        with self._lock:
            if self.rotation_state != "pending-rewrap":
                raise RotationError("no rotation is open at the rewrap step; nothing to abort")
            if self._conn.execute("SELECT count(*) FROM secrets WHERE kek_id = ?",
                                  (self._keys.active_id,)).fetchone()[0]:
                raise RotationError("some rows are already under the new key; finish, do not abort")
            self._keys = keyfile.drop_active(self._keyfile)

    def rotate_deks(self, *, actor: str, surface: str = "cli", request_id: str | None = None) -> int:
        """Re-encrypt every secret under a FRESH DEK (record s8.1). One transaction.

        The value, version and fingerprint are unchanged: nothing about the secret changed."""
        actor, surface, request_id = names.actor(actor), names.surface(surface), names.request_id(request_id)
        with self._tx() as c:
            rows = c.execute("SELECT * FROM secrets").fetchall()
            kek = self._keys.get(self._kek_id)
            if kek is None:
                raise WrongKeyError(self._kek_id, list(self._keys.ids))
            for r in rows:
                raw = self._open_row(r)
                dek = crypto.new_key()
                nonce, ct = crypto.seal(dek, raw, crypto.aad_value(self._store_id, r["module"], r["key"]))
                wn, wd = crypto.seal(kek, dek, crypto.aad_wrap(self._store_id, r["module"], r["key"], self._kek_id))
                c.execute("UPDATE secrets SET ciphertext=?, nonce=?, wrapped_dek=?, wrap_nonce=?, kek_id=? "
                          "WHERE module=? AND key=?", (ct, nonce, wd, wn, self._kek_id, r["module"], r["key"]))
            self._audit("rotate-dek", actor=actor, surface=surface, request_id=request_id,
                        detail=f"{len(rows)} secret(s)")
        return len(rows)

    # ---- encrypted-at-rest verification ------------------------------------
    def verify_encrypted_at_rest(self) -> AtRestReport:
        """Every secret authenticates, and NO secret value appears in any file under the
        state directory (database, -wal, -shm, backups, pre-migrate copies).

        Values shorter than 8 bytes are not searched for (a 1-byte needle matches
        anything); they are still authenticated.
        """
        problems: list[str] = []
        needles: list[tuple[str, bytes]] = []
        with self._lock:
            rows = self._conn.execute("SELECT * FROM secrets ORDER BY module, key").fetchall()
            for r in rows:
                try:
                    raw = self._open_row(r)
                except DecryptError:
                    problems.append(f"{r['module']}.{r['key']}: does not authenticate")
                    continue
                if len(raw) >= 8:
                    needles.append((f"{r['module']}.{r['key']}", raw))
                if raw in bytes(r["ciphertext"]) or raw in bytes(r["wrapped_dek"]):
                    problems.append(f"{r['module']}.{r['key']}: plaintext inside its own row")
        for dirpath, _dirs, files in os.walk(self._state):
            for fn in files:
                p = os.path.join(dirpath, fn)
                try:
                    if os.path.getsize(p) == 0:
                        continue
                    with open(p, "rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                        for label, raw in needles:
                            if mm.find(raw) != -1:
                                problems.append(f"{label}: plaintext found in {os.path.relpath(p, self._state)}")
                except (OSError, ValueError):
                    problems.append(f"{os.path.relpath(p, self._state)}: could not be scanned")
        return AtRestReport(not problems, len(rows), tuple(problems))


# -- bootstrap and restore (module level: they run before / instead of a Store) --
@dataclass(frozen=True)
class BootstrapResult:
    key_path: str
    key_id: str
    key_created: bool
    store_created: bool


def bootstrap(state_dir: str | os.PathLike[str], key_file: str | os.PathLike[str]) -> BootstrapResult:
    """Record s14.2 step 1-2. Generates the key ONLY when no database exists.

    key absent + DB present  -> KeyMissingError, nothing generated ("do not generate a new
                                one: that orphans N secrets")
    both absent              -> key and store created
    key present, DB absent   -> a new store on the key, with a loud audit row
    both present             -> opened and closed (validates, creates nothing)

    The key value is never returned or printed: the caller prints path and key_id.
    """
    state, kp = os.fspath(state_dir), os.fspath(key_file)
    db_exists = os.path.lexists(os.path.join(state, DB_NAME))
    key_exists = os.path.lexists(kp)
    created_key = False
    if db_exists and not key_exists:
        orphans = None
        try:
            c = sqlite3.connect(f"file:{os.path.join(state, DB_NAME)}?mode=ro", uri=True)
            try:
                orphans = c.execute("SELECT count(*) FROM secrets").fetchone()[0]
            finally:
                c.close()
        except sqlite3.Error:
            pass
        raise KeyMissingError(kp, orphans)
    if not key_exists:
        # fail BEFORE writing a key if the state dir could not hold a store anyway
        os.makedirs(state, mode=0o700, exist_ok=True)
        fscheck.require_supported(state)
        keyfile.create(kp)
        created_key = True
    with Store.open(state, kp, _created_key=created_key) as s:
        return BootstrapResult(kp, s.key_id, created_key, not db_exists)


def restore(state_dir: str | os.PathLike[str], key_file: str | os.PathLike[str],
            backup_path: str | os.PathLike[str], *, actor: str, surface: str = "cli") -> RestoreReport:
    """Record s10. The store must be closed (the state dir lock is taken here).

    Verifies the hash and integrity, refuses a newer schema, DRY-DECRYPTS everything with the present
    key file and names every missing key_id BEFORE touching anything, keeps the current database aside,
    swaps, reopens and writes a `restore` audit row. A restore replays old state: the report lists the
    secrets that differ from what was current.
    """
    actor, surface = names.actor(actor), names.surface(surface)
    state, kp, bp = os.fspath(state_dir), os.fspath(key_file), os.fspath(backup_path)
    _check_sqlite()
    fscheck.require_supported(state)
    lock = _StateLock(state)
    try:
        return _restore_locked(state, kp, bp, actor, surface)
    finally:
        lock.release()


def _restore_locked(state: str, kp: str, bp: str, actor: str, surface: str) -> RestoreReport:
    side = bp + ".sha256"
    if not os.path.exists(side):
        raise RestoreError(f"{side} is missing; a backup without its hash is not restored")
    with open(side, encoding="ascii") as f:
        want = f.read().split()[0]
    with open(bp, "rb") as f:
        raw = f.read()
    if hashlib.sha256(raw).hexdigest() != want:
        raise RestoreError(f"{bp} does not match its .sha256")
    if _header_version(bp) > len(schema.MIGRATIONS):
        raise DowngradeError(f"{bp} is a newer schema than this code; refused")
    src = sqlite3.connect(f"file:{bp}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    try:
        _integrity(src, bp)
        store_id = _meta(src, "store_id")
        kek_id = _meta(src, "kek_id").decode("ascii", "replace")
        rows = src.execute("SELECT * FROM secrets").fetchall()
        needed = sorted({kek_id} | {r["kek_id"] for r in rows})
        keys = keyfile.load(kp)
        missing = [k for k in needed if keys.get(k) is None]
        if missing:
            raise RestoreKeyMissing(missing)
        kek = keys.get(kek_id)
        assert kek is not None
        blob = _meta(src, "key_check")
        try:
            ok = crypto.open_(kek, blob[:12], blob[12:], crypto.aad_wrap(store_id, _STORE, "key_check", kek_id)) == KEY_CHECK
        except crypto.AuthFailure:
            ok = False
        if not ok:
            raise RestoreError("the backup's key_check does not decrypt under the present key")
        for r in rows:
            try:
                dek = crypto.open_(keys.get(r["kek_id"]) or b"", bytes(r["wrap_nonce"]), bytes(r["wrapped_dek"]),
                                   crypto.aad_wrap(store_id, r["module"], r["key"], r["kek_id"]))
                crypto.open_(dek, bytes(r["nonce"]), bytes(r["ciphertext"]),
                             crypto.aad_value(store_id, r["module"], r["key"]))
            except crypto.AuthFailure:
                raise RestoreError(f"{r['module']}.{r['key']} in the backup does not decrypt; nothing was changed") from None
        in_backup = {(r["module"], r["key"]): (r["version"], r["updated_at"]) for r in rows}
    finally:
        src.close()

    db = os.path.join(state, DB_NAME)
    changed: list[tuple[str, str]] = []
    aside = None
    if os.path.lexists(db):
        try:
            cur = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            try:
                now_rows = {(m, k): (v, u) for m, k, v, u in
                            cur.execute("SELECT module, key, version, updated_at FROM secrets")}
                # both directions: what the restore overwrites or drops, and what it brings back
                changed = [mk for mk in set(now_rows) | set(in_backup) if now_rows.get(mk) != in_backup.get(mk)]
            finally:
                cur.close()
            aside = _backup_to(db, os.path.join(state, f"pre-restore-{_stamp()}.db")).path
        except sqlite3.Error:
            raise RestoreError("the current database could not be read to keep a copy aside; "
                               "nothing was changed") from None
    tmp = _tmp_name(state, "restoring")
    _precreate(tmp)
    with open(tmp, "wb") as f:
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())
    # The old WAL must go BEFORE the new file is in place: a stale -wal replayed onto a
    # different database is corruption. The current state is already kept aside.
    for ext in ("-wal", "-shm"):
        try:
            os.unlink(db + ext)
        except FileNotFoundError:
            pass
    os.rename(tmp, db)
    _fsync_dir(state)
    # The restored file has journal_mode=DELETE from the backup; open() sets WAL again.
    s = Store._open_existing(state, db, kp, _NoLock())  # type: ignore[arg-type]
    try:
        with s._tx():
            s._audit("restore", actor=actor, surface=surface,
                     detail=f"restored from {os.path.basename(bp)}; {len(changed)} secret(s) differ from before")
    finally:
        s._conn.close()
    return RestoreReport(bp, aside, tuple(sorted(changed)))


class _NoLock:
    """restore() already holds the state lock; the temporary Store it opens needs none."""
    def release(self) -> None:
        pass
