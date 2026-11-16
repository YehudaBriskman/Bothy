"""SQLite schema and forward-only migrations (settings-store.md s7).

`PRAGMA user_version` is the schema version. MIGRATIONS[i] takes a database from
version i to i+1, as a list of single statements run inside ONE transaction (a
trigger body contains `;`, so a script cannot be split safely). Nothing here ever
goes backwards: a database newer than len(MIGRATIONS) is refused by the caller before it
is touched.

The audit table's two triggers are the append-only guarantee against anything
that is not a DB-level attacker with the power to drop them; against that
attacker the HMAC chain (audit.py) is what is left.
"""

from __future__ import annotations

MIGRATIONS: tuple[tuple[str, ...], ...] = (
    # 0 -> 1
    (
        """CREATE TABLE meta (
             k TEXT PRIMARY KEY,
             v BLOB NOT NULL
           ) STRICT""",
        """CREATE TABLE fields (
             module     TEXT NOT NULL,
             key        TEXT NOT NULL,
             is_secret  INTEGER NOT NULL CHECK (is_secret IN (0,1)),
             PRIMARY KEY (module, key)
           ) STRICT""",
        """CREATE TABLE settings (
             module     TEXT NOT NULL,
             key        TEXT NOT NULL,
             value_json TEXT NOT NULL,
             version    INTEGER NOT NULL,
             updated_by TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             PRIMARY KEY (module, key)
           ) STRICT""",
        """CREATE TABLE secrets (
             module      TEXT NOT NULL,
             key         TEXT NOT NULL,
             ciphertext  BLOB NOT NULL,
             nonce       BLOB NOT NULL,
             wrapped_dek BLOB NOT NULL,
             wrap_nonce  BLOB NOT NULL,
             kek_id      TEXT NOT NULL,
             version     INTEGER NOT NULL,
             fingerprint TEXT NOT NULL,
             updated_by  TEXT NOT NULL,
             updated_at  TEXT NOT NULL,
             PRIMARY KEY (module, key)
           ) STRICT""",
        """CREATE TABLE audit (
             id         INTEGER PRIMARY KEY AUTOINCREMENT,
             at         TEXT NOT NULL,
             actor      TEXT NOT NULL,
             surface    TEXT NOT NULL,
             action     TEXT NOT NULL,
             module     TEXT,
             key        TEXT,
             old_json   TEXT,
             new_json   TEXT,
             detail     TEXT,
             request_id TEXT,
             mac        BLOB NOT NULL
           ) STRICT""",
        """CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
           BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END""",
        """CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
           BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END""",
    ),
)

TABLES = frozenset({"meta", "fields", "settings", "secrets", "audit"})
