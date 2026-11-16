"""Every refusal this library can make, as a type a caller can match on.

RULE FOR EVERY MESSAGE IN THIS PACKAGE: it names a module, a key, a path or a key
id, and never a value. A value that reaches an exception reaches a traceback, a
log line and a bug report, which is how a secret store leaks. checks/test_leaks.py
feeds a canary through every failing path and greps the exception text.
"""

from __future__ import annotations


class SettingsError(Exception):
    """Base class. Nothing in this package raises a bare Exception."""


# -- the master key file ------------------------------------------------------
class KeyFileError(SettingsError):
    """The key file is unusable (format, ownership, an attempt to overwrite it)."""


class KeyMissingError(KeyFileError):
    def __init__(self, path: str, orphans: int | None = None):
        self.path = path
        self.orphans = orphans
        if orphans is None:
            msg = (f"master key not found at {path}. A store is created by "
                   f"`bootstrap`, which generates the key when no database exists.")
        else:
            msg = (f"master key not found at {path}; restore it from your copy, or "
                   f"from an export bundle with `bothy config import`. Do not "
                   f"generate a new one: that orphans {orphans} secret(s)")
        super().__init__(msg)


class KeyFileModeError(KeyFileError):
    """Wrong permissions, owner, type or directory: fail closed, never chmod it for them."""


class WrongKeyError(SettingsError):
    def __init__(self, expected: str, found: list[str]):
        self.expected = expected
        self.found = list(found)
        super().__init__(f"wrong master key: the store needs key_id {expected}, "
                         f"the key file holds {', '.join(found) or 'none'}. "
                         f"Find the retired key (master.key.retired.<key_id>).")


# -- the database -------------------------------------------------------------
class CorruptDatabaseError(SettingsError):
    """Refuse to start; never auto-recreate (an empty store reads as 'use defaults')."""


class DowngradeError(SettingsError):
    """The database is newer than this code. The file is not touched."""


class UnsupportedSQLiteError(SettingsError):
    """The linked SQLite lacks something the schema needs (STRICT tables, 3.37)."""


class UnsupportedFilesystemError(SettingsError):
    """WAL does not work over a network or Windows-drive mount."""


class StoreBusyError(SettingsError):
    """Another process holds the state directory lock."""


# -- crypto -------------------------------------------------------------------
class DecryptError(SettingsError):
    """One row failed authentication. Only that row: others keep working."""

    def __init__(self, module: str, key: str):
        self.module = module
        self.key = key
        super().__init__(f"cannot decrypt {module}.{key}: the row failed authentication "
                         f"(tampered, copied from another store, or wrong key)")


class NonceReuseError(SettingsError):
    """The nonce source returned a value it had already returned: a bug, never chance."""


# -- use of the API -----------------------------------------------------------
class ValidationError(SettingsError, ValueError):
    pass


class ClassificationError(ValidationError):
    """A secret/plain mismatch against the `fields` registry."""


class NotFound(SettingsError):
    pass


class VersionConflict(SettingsError):
    def __init__(self, module: str, key: str, expected: int | None, current: int):
        self.module, self.key, self.expected, self.current = module, key, expected, current
        super().__init__(f"version conflict on {module}.{key}: "
                         f"if_version={expected}, current version is {current}")


class RotationError(SettingsError):
    pass


class RestoreError(SettingsError):
    pass


class RestoreKeyMissing(RestoreError):
    def __init__(self, missing: list[str]):
        self.missing = list(missing)
        super().__init__(f"restore refused: key_id(s) {', '.join(missing)} are not in the "
                         f"key file; nothing was changed")


class ImportRefused(SettingsError):
    pass
