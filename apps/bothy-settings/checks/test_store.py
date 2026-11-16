#!/usr/bin/env python3
"""The store: the API, the refusals, the audit, and the failure paths.

Run: python3 apps/bothy-settings/checks/test_store.py   (needs `cryptography`)

Record s16 items 1, 4, 5, 8, 9 and 12 (the SQLite half), plus the write-only
surface, the registry, and every way a database can be wrong at open.
"""

from __future__ import annotations

import hashlib
import inspect
import logging
import os
import sqlite3
import stat
import threading
import unittest
from unittest import mock

import helpers
from helpers import CANARY, CANARY2, CANARY3, StoreCase
from bothy_settings import (
    Store, bootstrap, crypto, fscheck, keyfile, schema,
)
from bothy_settings.errors import (
    ClassificationError, CorruptDatabaseError, DecryptError, DowngradeError, KeyFileModeError,
    KeyMissingError, NotFound, StoreBusyError, UnsupportedFilesystemError, UnsupportedSQLiteError,
    ValidationError, VersionConflict, WrongKeyError,
)


def sha(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class RoundTripAndRowIsolation(StoreCase):
    """Record s16.1: each failure is that row only."""

    def test_round_trip(self) -> None:
        self.fill()
        self.assertEqual(self.reveal("TOKEN"), CANARY)
        self.assertEqual(self.reveal("OTHER"), CANARY2)
        self.assertEqual(self.s.get_setting("m", "NAME"), "bothy")

    def test_survives_a_reopen(self) -> None:
        self.fill()
        s = self.reopen()
        self.assertEqual(self.reveal("TOKEN", store=s), CANARY)
        self.assertEqual(s.get_meta("m", "TOKEN").version, 1)

    def test_unicode_and_boundary_sizes_round_trip(self) -> None:
        for v in ("", "x", "\u05e9\u05dc\u05d5\u05dd \U0001f511", "a\nb\x00c", "x" * 16 * 1024):
            self.s.put_secret("m", "TOKEN", v, actor="a")
            self.assertEqual(self.reveal("TOKEN"), v)

    def assert_only_this_row_fails(self, broken: str) -> None:
        with self.assertRaises(DecryptError) as cm:
            self.reveal(broken)
        self.assertEqual((cm.exception.module, cm.exception.key), ("m", broken))
        for ok_key, want in (("TOKEN", CANARY), ("OTHER", CANARY2), ("THIRD", CANARY3)):
            if ok_key != broken:
                self.assertEqual(self.reveal(ok_key), want, f"{ok_key} must be unaffected")
        denied = self.rows("SELECT module, key FROM audit WHERE action='read-denied'")
        self.assertEqual([(r[0], r[1]) for r in denied], [("m", broken)])

    def test_tampered_ciphertext_fails_that_row_only(self) -> None:
        self.fill()
        ct = bytes(self.rows("SELECT ciphertext FROM secrets WHERE key='OTHER'")[0][0])
        self.s._conn.execute("UPDATE secrets SET ciphertext=? WHERE key='OTHER'", (bytes([ct[0] ^ 1]) + ct[1:],))
        self.assert_only_this_row_fails("OTHER")

    def test_tampered_wrapped_dek_fails_that_row_only(self) -> None:
        self.fill()
        w = bytes(self.rows("SELECT wrapped_dek FROM secrets WHERE key='OTHER'")[0][0])
        self.s._conn.execute("UPDATE secrets SET wrapped_dek=? WHERE key='OTHER'", (w[:-1] + bytes([w[-1] ^ 1]),))
        self.assert_only_this_row_fails("OTHER")

    def test_tampered_nonces_fail_that_row_only(self) -> None:
        self.fill()
        for col in ("nonce", "wrap_nonce"):
            with self.subTest(col):
                self.s._conn.execute("DELETE FROM audit WHERE 0")  # (triggers: a no-op, proves nothing rewritten)
                n = bytes(self.rows(f"SELECT {col} FROM secrets WHERE key='OTHER'")[0][0])
                self.s._conn.execute(f"UPDATE secrets SET {col}=? WHERE key='OTHER'", (n[:-1] + b"\x7f" if n[-1] != 0x7f else n[:-1] + b"\x00",))
                with self.assertRaises(DecryptError):
                    self.reveal("OTHER")
                self.s._conn.execute(f"UPDATE secrets SET {col}=? WHERE key='OTHER'", (n,))
                self.assertEqual(self.reveal("OTHER"), CANARY2)

    def test_a_row_moved_to_another_key_fails_there_only(self) -> None:
        self.fill()
        self.s.register_fields("m", {"SPARE": True}, actor="t")
        self.s._conn.execute("UPDATE secrets SET key='SPARE' WHERE key='OTHER'")  # swapped AAD: key
        with self.assertRaises(DecryptError) as cm:
            self.reveal("SPARE")
        self.assertEqual(cm.exception.key, "SPARE")
        self.assertEqual(self.reveal("TOKEN"), CANARY)
        self.assertEqual(self.reveal("THIRD"), CANARY3)

    def test_a_row_moved_to_another_module_fails_there_only(self) -> None:
        self.fill()
        self.s.register_fields("n", {"TOKEN": True}, actor="t")
        self.s._conn.execute("UPDATE secrets SET module='n' WHERE key='OTHER'")  # swapped AAD: module
        with self.assertRaises(DecryptError):
            self.reveal("OTHER", module="n")
        self.assertEqual(self.reveal("TOKEN"), CANARY)
        self.assertEqual(self.reveal("THIRD"), CANARY3)

    def test_a_row_from_another_store_fails_there_only(self) -> None:
        # same KEK, same module and key, a DIFFERENT store_id: only the AAD tells them apart
        self.fill()
        other_state = os.path.join(self.root, "state2")
        with Store.open(other_state, self.kf) as b:
            b.register_fields("m", self.FIELDS, actor="t")
            b.put_secret("m", "TOKEN", "from-the-other-store-0123456789", actor="t")
            foreign = b._conn.execute("SELECT * FROM secrets WHERE key='TOKEN'").fetchone()
            cols = ("ciphertext", "nonce", "wrapped_dek", "wrap_nonce", "kek_id")
            vals = [foreign[c] for c in cols]
        self.s._conn.execute("UPDATE secrets SET ciphertext=?, nonce=?, wrapped_dek=?, wrap_nonce=?, kek_id=? "
                             "WHERE key='TOKEN'", vals)
        self.assert_only_this_row_fails("TOKEN")

    def test_a_row_wrapped_under_a_different_key_fails_there_only(self) -> None:
        self.fill()
        dek = crypto.new_key()
        n, ct = crypto.seal(dek, b"x" * 20, crypto.aad_value(self.s._store_id, "m", "OTHER"))
        wn, wd = crypto.seal(crypto.new_key(), dek, crypto.aad_wrap(self.s._store_id, "m", "OTHER", self.s.key_id))
        self.s._conn.execute("UPDATE secrets SET ciphertext=?, nonce=?, wrapped_dek=?, wrap_nonce=? WHERE key='OTHER'",
                             (ct, n, wd, wn))
        self.assert_only_this_row_fails("OTHER")

    def test_a_row_naming_a_key_id_not_in_the_file_names_that_key_id(self) -> None:
        self.fill()
        self.s._conn.execute("UPDATE secrets SET kek_id='deadbeefdeadbeef' WHERE key='OTHER'")
        with self.assertRaises(WrongKeyError) as cm:
            self.reveal("OTHER")
        self.assertEqual(cm.exception.expected, "deadbeefdeadbeef")
        self.assertEqual(self.reveal("TOKEN"), CANARY)

    def test_no_decrypt_error_for_a_missing_row_but_a_notfound(self) -> None:
        with self.assertRaises(NotFound):
            self.reveal("TOKEN")


class WriteOnlySurface(StoreCase):
    def test_public_methods_are_pinned(self) -> None:
        # Adding a method here is how a new way to read a secret would arrive.
        # The two that decrypt are listed by name; anything else new must be argued.
        public = sorted(n for n, _ in inspect.getmembers(Store, inspect.isroutine) if not n.startswith("_"))
        self.assertEqual(public, sorted([
            "abort_rotation", "backup", "close", "delete", "export_document", "finish_rotation",
            "generate_secret", "get_meta", "get_setting", "import_document", "list_meta", "open",
            "put_secret", "put_value", "read_audit", "register_fields", "reveal_for_projection",
            "rotate_deks", "rotate_kek", "verify_audit", "verify_encrypted_at_rest",
        ]))
        # ...and none of the others returns the value: put/generate/get/list return Meta.
        self.fill()
        for meta in (self.s.get_meta("m", "TOKEN"), *self.s.list_meta("m"),
                     self.s.put_secret("m", "TOKEN", CANARY, actor="a"),
                     self.s.generate_secret("m", "OTHER", actor="a")):
            self.assertNotIn(CANARY, repr(meta))
            self.assertIsNone(meta.value if meta.is_secret else None)

    def test_get_setting_refuses_a_secret(self) -> None:
        self.fill()
        with self.assertRaises(ClassificationError):
            self.s.get_setting("m", "TOKEN")

    def test_meta_for_a_secret_has_a_fingerprint_but_no_value(self) -> None:
        self.fill()
        m = self.s.get_meta("m", "TOKEN")
        self.assertTrue(m.is_secret and m.set)
        self.assertEqual((m.version, m.updated_by), (1, "alice"))
        self.assertRegex(m.fingerprint or "", r"^[0-9a-f]{8}$")
        self.assertIsNone(m.value)
        unset = self.s.get_meta("m", "PORT")
        self.assertFalse(unset.set)

    def test_fingerprint_changes_with_the_value_and_only_then(self) -> None:
        a = self.s.put_secret("m", "TOKEN", "value-one-0123456789", actor="a").fingerprint
        b = self.s.put_secret("m", "TOKEN", "value-one-0123456789", actor="a").fingerprint
        c = self.s.put_secret("m", "TOKEN", "value-two-0123456789", actor="a").fingerprint
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_generate_returns_no_value_and_makes_distinct_secrets(self) -> None:
        m = self.s.generate_secret("m", "TOKEN", actor="a")
        v1 = self.reveal("TOKEN")
        self.s.generate_secret("m", "TOKEN", actor="a")
        v2 = self.reveal("TOKEN")
        self.assertNotEqual(v1, v2)
        self.assertGreaterEqual(len(v1), 43)
        self.assertNotIn(v1, repr(m))
        self.assertEqual(self.rows("SELECT action FROM audit WHERE action='generate'")[0][0], "generate")
        for bad in (8, 513, 32.0, True, "32", None):
            with self.subTest(bad), self.assertRaises(ValidationError):
                self.s.generate_secret("m", "TOKEN", actor="a", nbytes=bad)  # type: ignore[arg-type]

    def test_list_meta_covers_unset_fields_and_filters_by_module(self) -> None:
        self.fill()
        self.s.register_fields("n", {"Z": False}, actor="t")
        ms = self.s.list_meta("m")
        self.assertEqual([m.key for m in ms], sorted(self.FIELDS))
        self.assertEqual([m.set for m in ms if m.key == "PORT"], [False])
        self.assertEqual([m.module for m in self.s.list_meta()], ["m"] * 5 + ["n"])
        self.assertEqual(self.s.list_meta("nope"), [])


class Registry(StoreCase):
    def test_plaintext_put_to_a_secret_is_refused_and_writes_nothing(self) -> None:
        with self.assertRaises(ClassificationError):
            self.s.put_value("m", "TOKEN", CANARY, actor="a")
        self.assertEqual(self.rows("SELECT count(*) FROM settings")[0][0], 0)
        self.assertFalse(self.s.get_meta("m", "TOKEN").set)

    def test_secret_put_to_a_plain_key_is_refused(self) -> None:
        with self.assertRaises(ClassificationError):
            self.s.put_secret("m", "NAME", CANARY, actor="a")
        with self.assertRaises(ClassificationError):
            self.s.generate_secret("m", "NAME", actor="a")
        self.assertEqual(self.rows("SELECT count(*) FROM secrets")[0][0], 0)

    def test_an_unregistered_key_is_refused_both_ways(self) -> None:
        with self.assertRaises(ClassificationError):
            self.s.put_value("m", "NOPE", 1, actor="a")
        with self.assertRaises(ClassificationError):
            self.s.put_secret("m", "NOPE", "x" * 20, actor="a")
        with self.assertRaises(ClassificationError):
            self.s.delete("m", "NOPE", actor="a")
        with self.assertRaises(NotFound):
            self.s.get_meta("m", "NOPE")

    def test_a_classification_is_never_flipped(self) -> None:
        for flip in ({"TOKEN": False}, {"NAME": True}):
            with self.subTest(flip), self.assertRaises(ClassificationError):
                self.s.register_fields("m", flip, actor="t")
        self.s.register_fields("m", self.FIELDS, actor="t")  # the same again is a no-op
        self.assertEqual(self.rows("SELECT count(*) FROM audit WHERE action='register'")[0][0], 1)

    def test_a_failed_registration_is_all_or_nothing(self) -> None:
        with self.assertRaises(ClassificationError):
            self.s.register_fields("m", {"BRAND_NEW": True, "TOKEN": False}, actor="t")
        self.assertEqual(self.rows("SELECT count(*) FROM fields WHERE key='BRAND_NEW'")[0][0], 0)

    def test_the_fields_check_constraint_holds(self) -> None:
        with self.assertRaises(sqlite3.IntegrityError):
            self.s._conn.execute("INSERT INTO fields VALUES ('m','BAD',2)")

    def test_registration_input_is_validated(self) -> None:
        with self.assertRaises(ValidationError):
            self.s.register_fields("m", {"K": "yes"}, actor="t")  # type: ignore[dict-item]
        with self.assertRaises(ValidationError):
            self.s.register_fields("m", {"bad key": True}, actor="t")


class Validation(StoreCase):
    def test_bad_names_and_actors_are_refused_everywhere(self) -> None:
        for call in (
            lambda: self.s.put_value("m\n", "NAME", 1, actor="a"),
            lambda: self.s.put_value("m", "NAME\n", 1, actor="a"),
            lambda: self.s.put_value("m", "NAME", 1, actor="a\nb"),
            lambda: self.s.put_secret("../m", "TOKEN", "x" * 20, actor="a"),
            lambda: self.s.put_value("m", "NAME", 1, actor="a", surface="x"),
            lambda: self.s.put_value("m", "NAME", 1, actor="a", request_id="a b"),
            lambda: self.s.get_meta("M", "NAME"),
            lambda: self.s.delete("m", "N\x00AME", actor="a"),
        ):
            with self.assertRaises(ValidationError):
                call()
        self.assertEqual(self.rows("SELECT count(*) FROM audit WHERE action='set'")[0][0], 0)

    def test_value_types_and_sizes(self) -> None:
        for bad in (None, 5, b"bytes", ["x"], {"a": 1}):
            with self.subTest(bad), self.assertRaises(ValidationError):
                self.s.put_secret("m", "TOKEN", bad, actor="a")  # type: ignore[arg-type]
        with self.assertRaises(ValidationError):
            self.s.put_secret("m", "TOKEN", "x" * (16 * 1024 + 1), actor="a")
        with self.assertRaises(ValidationError):
            self.s.put_secret("m", "TOKEN", "\ud800 lone surrogate", actor="a")
        for bad in (float("nan"), float("inf"), object(), {1, 2}, {"a": object()}):
            with self.subTest(repr(bad)), self.assertRaises(ValidationError):
                self.s.put_value("m", "NAME", bad, actor="a")
        with self.assertRaises(ValidationError):
            self.s.put_value("m", "NAME", "x" * (16 * 1024 + 1), actor="a")
        self.assertEqual(self.rows("SELECT count(*) FROM secrets")[0][0], 0)

    def test_plain_values_keep_their_json_type(self) -> None:
        for v in (0, 1.5, True, None, "s", [1, "a"], {"b": {"c": [None]}}):
            self.s.put_value("m", "NAME", v, actor="a")
            self.assertEqual(self.s.get_setting("m", "NAME"), v)
            self.assertIs(type(self.s.get_setting("m", "NAME")), type(v))

    def test_if_version_argument_is_validated(self) -> None:
        for bad in (-1, 1.0, "1", True):
            with self.subTest(bad), self.assertRaises(ValidationError):
                self.s.put_value("m", "NAME", 1, actor="a", if_version=bad)  # type: ignore[arg-type]


class Versions(StoreCase):
    """Record s16.9."""

    def test_versions_count_up_and_conflicts_name_the_current_one(self) -> None:
        self.assertEqual(self.s.put_value("m", "NAME", "a", actor="a", if_version=0).version, 1)
        self.assertEqual(self.s.put_value("m", "NAME", "b", actor="a", if_version=1).version, 2)
        with self.assertRaises(VersionConflict) as cm:
            self.s.put_value("m", "NAME", "c", actor="a", if_version=1)
        self.assertEqual((cm.exception.expected, cm.exception.current), (1, 2))
        with self.assertRaises(VersionConflict):
            self.s.put_value("m", "NAME", "c", actor="a", if_version=0)  # exists already
        self.assertEqual(self.s.get_setting("m", "NAME"), "b")
        self.assertEqual(self.s.put_value("m", "NAME", "d", actor="a").version, 3)  # unconditional

    def test_a_conflict_changes_nothing_and_audits_nothing(self) -> None:
        self.s.put_secret("m", "TOKEN", CANARY, actor="a")
        n = self.rows("SELECT count(*) FROM audit")[0][0]
        before = self.rows("SELECT * FROM secrets")
        with self.assertRaises(VersionConflict):
            self.s.put_secret("m", "TOKEN", "x" * 20, actor="a", if_version=9)
        self.assertEqual(self.rows("SELECT count(*) FROM audit")[0][0], n)
        self.assertEqual([tuple(r) for r in self.rows("SELECT * FROM secrets")], [tuple(r) for r in before])

    def test_secrets_conflict_the_same_way(self) -> None:
        self.s.put_secret("m", "TOKEN", "x" * 20, actor="a", if_version=0)
        with self.assertRaises(VersionConflict):
            self.s.put_secret("m", "TOKEN", "y" * 20, actor="a", if_version=0)
        with self.assertRaises(VersionConflict):
            self.s.delete("m", "TOKEN", actor="a", if_version=5)
        self.s.delete("m", "TOKEN", actor="a", if_version=1)

    def _race(self, fn, n: int = 8) -> tuple[list, list]:
        barrier, won, lost = threading.Barrier(n), [], []

        def run(i: int) -> None:
            barrier.wait()
            try:
                won.append(fn(i))
            except VersionConflict as e:
                lost.append(e)
        ts = [threading.Thread(target=run, args=(i,)) for i in range(n)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        return won, lost

    def test_two_simultaneous_creates_lose_exactly_one_each(self) -> None:
        won, lost = self._race(lambda i: self.s.put_value("m", "NAME", f"w{i}", actor="a", if_version=0))
        self.assertEqual((len(won), len(lost)), (1, 7))
        self.assertEqual(self.s.get_meta("m", "NAME").version, 1)

    def test_simultaneous_secret_updates_lose_all_but_one(self) -> None:
        self.s.put_secret("m", "TOKEN", "x" * 20, actor="a")
        won, lost = self._race(lambda i: self.s.put_secret("m", "TOKEN", f"writer-{i}-0123456789", actor="a", if_version=1))
        self.assertEqual((len(won), len(lost)), (1, 7))
        self.assertEqual(self.s.get_meta("m", "TOKEN").version, 2)
        self.assertEqual(self.reveal("TOKEN"), f"writer-{[w.updated_by for w in won] and self._winner(won)}-0123456789")

    def _winner(self, won: list) -> str:
        # the value tells which thread won; read it back instead of guessing
        v = self.reveal("TOKEN")
        return v.split("-")[1]

    def test_every_write_has_its_audit_row_in_the_same_transaction(self) -> None:
        won, _ = self._race(lambda i: self.s.put_value("m", "NAME", f"w{i}", actor="a", if_version=0))
        self.assertEqual(self.rows("SELECT count(*) FROM audit WHERE action='set'")[0][0], len(won))


class Delete(StoreCase):
    def test_delete_removes_and_audits(self) -> None:
        self.fill()
        self.s.delete("m", "TOKEN", actor="bob")
        self.s.delete("m", "NAME", actor="bob")
        self.assertFalse(self.s.get_meta("m", "TOKEN").set)
        self.assertFalse(self.s.get_meta("m", "NAME").set)
        with self.assertRaises(NotFound):
            self.s.reveal_for_projection("m", "TOKEN", actor="x")
        rows = self.rows("SELECT action, key, old_json, new_json, detail FROM audit WHERE action='delete' ORDER BY id")
        self.assertEqual([tuple(r) for r in rows],
                         [("delete", "TOKEN", None, None, "removed"), ("delete", "NAME", '"bothy"', None, None)])

    def test_deleting_what_is_not_set_is_a_notfound_and_audits_nothing(self) -> None:
        with self.assertRaises(NotFound):
            self.s.delete("m", "TOKEN", actor="a")
        self.assertEqual(self.rows("SELECT count(*) FROM audit WHERE action='delete'")[0][0], 0)

    def test_secure_delete_is_on_so_the_ciphertext_is_overwritten(self) -> None:
        self.assertEqual(self.rows("PRAGMA secure_delete")[0][0], 1)


class Pragmas(StoreCase):
    def test_pragmas_and_modes(self) -> None:
        q = lambda p: self.rows(f"PRAGMA {p}")[0][0]  # noqa: E731
        self.assertEqual(q("journal_mode"), "wal")
        self.assertEqual(q("synchronous"), 2)  # FULL
        self.assertEqual(q("foreign_keys"), 1)
        self.assertEqual(q("busy_timeout"), 5000)
        self.fill()
        for name in ("settings.db", "settings.db-wal", "settings.db-shm", ".lock"):
            p = os.path.join(self.state, name)
            self.assertTrue(os.path.exists(p), name)
            self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600, name)
        self.assertEqual(stat.S_IMODE(os.stat(self.state).st_mode), 0o700)

    def test_every_table_is_strict_and_the_sqlite_is_new_enough(self) -> None:
        # record s16.12 (the SQLite half): STRICT needs 3.37
        self.assertGreaterEqual(sqlite3.sqlite_version_info, (3, 37, 0))
        strict = {r["name"]: r["strict"] for r in self.rows("PRAGMA table_list") if r["name"] in schema.TABLES}
        self.assertEqual(set(strict), set(schema.TABLES))
        self.assertTrue(all(strict.values()), strict)

    def test_an_old_sqlite_is_refused(self) -> None:
        with mock.patch.object(sqlite3, "sqlite_version_info", (3, 36, 0)), \
                mock.patch.object(sqlite3, "sqlite_version", "3.36.0"):
            with self.assertRaises(UnsupportedSQLiteError):
                Store.open(os.path.join(self.root, "s9"), self.kf)
        self.assertFalse(os.path.exists(os.path.join(self.root, "s9")))

    def test_strict_really_rejects_the_wrong_type(self) -> None:
        with self.assertRaises(sqlite3.IntegrityError):
            self.s._conn.execute("INSERT INTO meta(k, v) VALUES ('x', 'text-in-a-blob-column')")


class Startup(unittest.TestCase):
    """Record s16.4."""

    def setUp(self) -> None:
        import shutil
        import tempfile
        self.root = tempfile.mkdtemp(prefix="bothy-settings-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.state = os.path.join(self.root, "state")
        self.kf = os.path.join(self.root, "cfg", "master.key")
        self.db = os.path.join(self.state, "settings.db")

    def test_both_absent_open_refuses_and_creates_neither(self) -> None:
        with self.assertRaises(KeyMissingError):
            Store.open(self.state, self.kf)
        self.assertFalse(os.path.exists(self.db))
        self.assertFalse(os.path.exists(self.kf))

    def test_both_absent_bootstrap_creates_both_and_prints_no_key(self) -> None:
        r = bootstrap(self.state, self.kf)
        self.assertTrue(r.key_created and r.store_created)
        self.assertEqual(stat.S_IMODE(os.stat(self.kf).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(self.kf)).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.db).st_mode), 0o600)
        self.assertEqual(r.key_id, keyfile.load(self.kf).active_id)
        self.assertNotIn(keyfile.load(self.kf).active.hex(), repr(r))
        with Store.open(self.state, self.kf) as s:
            self.assertEqual(s.rotation_state, "none")
            rows = s.read_audit()
            self.assertEqual([(x["action"], x["actor"], x["surface"]) for x in rows],
                             [("migrate", "system:bootstrap", "bootstrap")])
            self.assertIn("freshly generated key", rows[0]["detail"])
            self.assertTrue(s.verify_audit().ok)

    def test_key_present_db_absent_creates_a_new_store_with_a_loud_audit_row(self) -> None:
        keyfile.create(self.kf)
        r = bootstrap(self.state, self.kf)
        self.assertFalse(r.key_created)
        self.assertTrue(r.store_created)
        with Store.open(self.state, self.kf) as s:
            self.assertIn("NEW store on a pre-existing key", s.read_audit()[0]["detail"])

    def test_key_present_db_absent_plain_open_also_creates(self) -> None:
        keyfile.create(self.kf)
        with Store.open(self.state, self.kf) as s:
            self.assertEqual(s.rotation_state, "none")

    def test_key_absent_db_present_fails_closed_with_the_named_message(self) -> None:
        bootstrap(self.state, self.kf)
        with Store.open(self.state, self.kf) as s:
            s.register_fields("m", {"A": True, "B": True}, actor="t")
            s.put_secret("m", "A", "x" * 20, actor="t")
            s.put_secret("m", "B", "y" * 20, actor="t")
        before = sha(self.db)
        os.unlink(self.kf)
        for attempt in (lambda: Store.open(self.state, self.kf), lambda: bootstrap(self.state, self.kf)):
            with self.assertRaises(KeyMissingError) as cm:
                attempt()
            msg = str(cm.exception)
            self.assertIn(self.kf, msg)
            self.assertIn("orphans 2 secret(s)", msg)
            self.assertIn("Do not generate a new one", msg)
        self.assertFalse(os.path.exists(self.kf), "bootstrap must NEVER generate a key when a DB exists")
        self.assertEqual(sha(self.db), before)

    def test_a_wrong_key_names_both_key_ids_and_touches_nothing(self) -> None:
        r = bootstrap(self.state, self.kf)
        before = sha(self.db)
        os.unlink(self.kf)
        other = keyfile.create(self.kf)
        with self.assertRaises(WrongKeyError) as cm:
            Store.open(self.state, self.kf)
        self.assertEqual((cm.exception.expected, cm.exception.found), (r.key_id, [other.active_id]))
        self.assertIn(r.key_id, str(cm.exception))
        self.assertIn(other.active_id, str(cm.exception))
        self.assertEqual(sha(self.db), before)

    def test_a_wrong_mode_key_is_refused_by_open_and_by_bootstrap(self) -> None:
        bootstrap(self.state, self.kf)
        os.chmod(self.kf, 0o644)
        for attempt in (lambda: Store.open(self.state, self.kf), lambda: bootstrap(self.state, self.kf)):
            with self.assertRaises(KeyFileModeError):
                attempt()
        self.assertEqual(stat.S_IMODE(os.stat(self.kf).st_mode), 0o644, "never repaired for the caller")
        # and no lock is left held by the refusal
        os.chmod(self.kf, 0o600)
        Store.open(self.state, self.kf).close()

    def test_a_tampered_key_check_is_corruption_not_a_wrong_key(self) -> None:
        bootstrap(self.state, self.kf)
        c = sqlite3.connect(self.db)
        c.execute("UPDATE meta SET v=? WHERE k='key_check'", (b"\x00" * 40,))
        c.commit()
        c.close()
        with self.assertRaises(CorruptDatabaseError):
            Store.open(self.state, self.kf)

    def test_a_tampered_store_id_is_corruption(self) -> None:
        bootstrap(self.state, self.kf)
        c = sqlite3.connect(self.db)
        c.execute("UPDATE meta SET v=? WHERE k='store_id'", (os.urandom(16),))
        c.commit()
        c.close()
        with self.assertRaises(CorruptDatabaseError):
            Store.open(self.state, self.kf)

    def test_a_missing_meta_row_is_corruption(self) -> None:
        bootstrap(self.state, self.kf)
        c = sqlite3.connect(self.db)
        c.execute("DELETE FROM meta WHERE k='kek_id'")
        c.commit()
        c.close()
        with self.assertRaises(CorruptDatabaseError):
            Store.open(self.state, self.kf)

    def test_a_schema_version_that_disagrees_with_user_version_is_corruption(self) -> None:
        bootstrap(self.state, self.kf)
        c = sqlite3.connect(self.db)
        c.execute("UPDATE meta SET v=? WHERE k='schema_version'", (b"7",))
        c.commit()
        c.close()
        with self.assertRaises(CorruptDatabaseError):
            Store.open(self.state, self.kf)

    def test_a_missing_table_is_corruption(self) -> None:
        bootstrap(self.state, self.kf)
        c = sqlite3.connect(self.db)
        c.execute("DROP TABLE settings")
        c.commit()
        c.close()
        with self.assertRaises(CorruptDatabaseError):
            Store.open(self.state, self.kf)

    def test_a_second_opener_is_refused_until_the_first_closes(self) -> None:
        bootstrap(self.state, self.kf)
        a = Store.open(self.state, self.kf)
        with self.assertRaises(StoreBusyError):
            Store.open(self.state, self.kf)
        with self.assertRaises(StoreBusyError):
            bootstrap(self.state, self.kf)
        a.close()
        a.close()  # idempotent
        Store.open(self.state, self.kf).close()

    def test_a_closed_store_refuses_work(self) -> None:
        bootstrap(self.state, self.kf)
        s = Store.open(self.state, self.kf)
        s.close()
        with self.assertRaises(Exception):
            s.register_fields("m", {"A": False}, actor="t")

    def test_an_unsupported_filesystem_is_refused_and_nothing_is_created(self) -> None:
        mountinfo = "1 0 0:1 / / rw - 9p C:\\134 rw,aname=drvfs\n"
        with mock.patch.object(fscheck, "read_mountinfo", return_value=mountinfo):
            with self.assertRaises(UnsupportedFilesystemError):
                bootstrap(self.state, self.kf)
            with self.assertRaises(UnsupportedFilesystemError):
                Store.open(self.state, self.kf)
        self.assertFalse(os.path.exists(self.kf), "no key may be generated for a store that cannot exist")
        self.assertFalse(os.path.exists(self.db))

    def test_an_interrupted_creation_leaves_no_database_and_a_retry_works(self) -> None:
        keyfile.create(self.kf)
        with mock.patch("bothy_settings.store._audit.append", side_effect=RuntimeError("crash while creating")):
            with self.assertRaises(RuntimeError):
                Store.open(self.state, self.kf)
        self.assertFalse(os.path.exists(self.db))
        self.assertEqual([f for f in os.listdir(self.state) if f.startswith("settings.db.")], [])
        Store.open(self.state, self.kf).close()

    def test_a_leftover_temp_from_a_crashed_creation_is_swept(self) -> None:
        keyfile.create(self.kf)
        os.makedirs(self.state, mode=0o700)
        junk = os.path.join(self.state, "settings.db.creating-1-abcd")
        open(junk, "wb").close()
        Store.open(self.state, self.kf).close()
        self.assertFalse(os.path.exists(junk))


class Truncation(unittest.TestCase):
    """A truncated or damaged database is REFUSED, never recreated empty (record s13.2)."""

    def setUp(self) -> None:
        import shutil
        import tempfile
        self.root = tempfile.mkdtemp(prefix="bothy-settings-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.state, self.kf = os.path.join(self.root, "state"), os.path.join(self.root, "cfg", "master.key")
        self.db = os.path.join(self.state, "settings.db")
        bootstrap(self.state, self.kf)
        with Store.open(self.state, self.kf) as s:
            s.register_fields("m", {"K%d" % i: True for i in range(30)}, actor="t")
            for i in range(30):
                s.put_secret("m", "K%d" % i, ("v%02d-" % i) * 30, actor="t")
        self.size = os.path.getsize(self.db)  # closed cleanly: the WAL is checkpointed into the file

    def truncate(self, n: int) -> None:
        os.truncate(self.db, n)

    def test_a_database_with_data_is_big_enough_to_truncate_meaningfully(self) -> None:
        self.assertGreater(self.size, 4 * 4096)
        self.assertFalse(os.path.exists(self.db + "-wal"))

    def test_every_truncation_is_refused(self) -> None:
        for n in (0, 1, 50, 99, 100, 512, 4096, 4097, 8192, self.size // 2, self.size - 4097, self.size - 4096):
            with self.subTest(truncated_to=n):
                self.setUp_fresh()  # truncation destroys data, so rebuild each time
                self.truncate(n)
                with self.assertRaises(CorruptDatabaseError):
                    Store.open(self.state, self.kf)
                self.assertEqual(os.path.getsize(self.db), n, "a refused database must not be rewritten")

    def setUp_fresh(self) -> None:
        for f in os.listdir(self.state):
            os.unlink(os.path.join(self.state, f))
        # rebuild with the same key so the rest of the test is about the DB only
        with Store.open(self.state, self.kf) as s:
            s.register_fields("m", {"K%d" % i: True for i in range(30)}, actor="t")
            for i in range(30):
                s.put_secret("m", "K%d" % i, ("v%02d-" % i) * 30, actor="t")
        self.size = os.path.getsize(self.db)

    def test_zero_length_is_not_a_new_store(self) -> None:
        self.truncate(0)
        with self.assertRaises(CorruptDatabaseError) as cm:
            Store.open(self.state, self.kf)
        self.assertIn("NOT recreated", str(cm.exception))

    def test_a_foreign_file_is_refused(self) -> None:
        with open(self.db, "wb") as f:
            f.write(b"this is not sqlite " * 100)
        with self.assertRaises(CorruptDatabaseError):
            Store.open(self.state, self.kf)

    def test_a_foreign_sqlite_database_is_refused(self) -> None:
        os.unlink(self.db)
        c = sqlite3.connect(self.db)
        c.execute("CREATE TABLE t(x)")
        c.commit()
        c.close()
        with self.assertRaises(CorruptDatabaseError):
            Store.open(self.state, self.kf)

    def test_garbage_in_the_header_after_the_magic_is_refused(self) -> None:
        with open(self.db, "r+b") as f:
            f.seek(16)
            f.write(b"\xff" * 20)
        with self.assertRaises(Exception) as cm:
            Store.open(self.state, self.kf)
        self.assertIsInstance(cm.exception, (CorruptDatabaseError, DowngradeError))

    def test_a_symlinked_database_is_refused(self) -> None:
        os.rename(self.db, self.db + ".real")
        os.symlink(self.db + ".real", self.db)
        with self.assertRaises(CorruptDatabaseError):
            Store.open(self.state, self.kf)

    def test_a_refused_open_releases_the_lock(self) -> None:
        self.truncate(0)
        for _ in range(2):
            with self.assertRaises(CorruptDatabaseError):
                Store.open(self.state, self.kf)  # would be StoreBusyError the second time if it leaked


class Downgrade(unittest.TestCase):
    """Record s16.5."""

    def setUp(self) -> None:
        import shutil
        import tempfile
        self.root = tempfile.mkdtemp(prefix="bothy-settings-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.state, self.kf = os.path.join(self.root, "state"), os.path.join(self.root, "cfg", "master.key")
        self.db = os.path.join(self.state, "settings.db")
        bootstrap(self.state, self.kf)

    def test_a_newer_database_is_refused_and_not_touched(self) -> None:
        c = sqlite3.connect(self.db)
        c.execute("PRAGMA user_version = 99")
        c.commit()
        c.close()
        before = (sha(self.db), sorted(os.listdir(self.state)))
        with self.assertRaises(DowngradeError) as cm:
            Store.open(self.state, self.kf)
        self.assertIn("99", str(cm.exception))
        self.assertEqual((sha(self.db), sorted(os.listdir(self.state))), before)

    def test_migrating_leaves_a_verified_pre_migrate_copy_and_then_old_code_refuses_it(self) -> None:
        with Store.open(self.state, self.kf) as s:
            s.register_fields("m", {"A": True}, actor="t")
            s.put_secret("m", "A", CANARY, actor="t")
        v2 = schema.MIGRATIONS + (("CREATE TABLE extra (id INTEGER PRIMARY KEY, note TEXT) STRICT",
                                   "INSERT INTO extra(note) VALUES ('hello')"),)
        with mock.patch.object(schema, "MIGRATIONS", v2):
            with Store.open(self.state, self.kf) as s:
                self.assertEqual(s._conn.execute("SELECT note FROM extra").fetchone()[0], "hello")
                self.assertEqual(s._conn.execute("PRAGMA user_version").fetchone()[0], 2)
                self.assertEqual(s.reveal_for_projection("m", "A", actor="t"), CANARY)
                self.assertEqual(s._conn.execute("SELECT v FROM meta WHERE k='schema_version'").fetchone()[0], b"2")
                mig = [r for r in s.read_audit() if r["action"] == "migrate"]
                self.assertEqual(mig[-1]["detail"], "schema 1 -> 2")
                self.assertTrue(s.verify_audit().ok)
        pre = os.path.join(self.state, "pre-migrate-1-2.db")
        self.assertTrue(os.path.exists(pre) and os.path.exists(pre + ".sha256"))
        with open(pre + ".sha256") as f:
            self.assertEqual(sha(pre), f.read().split()[0])
        c = sqlite3.connect(pre)
        self.assertEqual(c.execute("PRAGMA user_version").fetchone()[0], 1)
        self.assertEqual(c.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertEqual(c.execute("SELECT count(*) FROM sqlite_master WHERE name='extra'").fetchone()[0], 0)
        c.close()
        self.assertEqual(stat.S_IMODE(os.stat(pre).st_mode), 0o600)
        # the original code, opening the migrated file: downgrade, untouched
        before = sha(self.db)
        with self.assertRaises(DowngradeError):
            Store.open(self.state, self.kf)
        self.assertEqual(sha(self.db), before)

    def test_a_failing_migration_rolls_back_and_the_copy_survives(self) -> None:
        with Store.open(self.state, self.kf) as s:
            s.register_fields("m", {"A": True}, actor="t")
            s.put_secret("m", "A", CANARY, actor="t")
        bad = schema.MIGRATIONS + (("CREATE TABLE half (id INTEGER PRIMARY KEY) STRICT",
                                    "THIS IS NOT SQL"),)
        with mock.patch.object(schema, "MIGRATIONS", bad):
            with self.assertRaises(sqlite3.Error):
                Store.open(self.state, self.kf)
        self.assertTrue(os.path.exists(os.path.join(self.state, "pre-migrate-1-2.db")))
        with Store.open(self.state, self.kf) as s:  # still version 1, nothing half-applied
            self.assertEqual(s._conn.execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertEqual(s._conn.execute("SELECT count(*) FROM sqlite_master WHERE name='half'").fetchone()[0], 0)
            self.assertEqual(s.reveal_for_projection("m", "A", actor="t"), CANARY)


class Audit(StoreCase):
    """Record s16.8."""

    def test_triggers_refuse_update_and_delete(self) -> None:
        self.fill()
        for sql in ("UPDATE audit SET actor='mallory'", "DELETE FROM audit", "DELETE FROM audit WHERE id=1",
                    "UPDATE audit SET mac=x'00' WHERE id=1"):
            with self.subTest(sql), self.assertRaises(sqlite3.IntegrityError) as cm:
                self.s._conn.execute(sql)
            self.assertIn("append-only", str(cm.exception))
        self.assertTrue(self.s.verify_audit().ok)

    def test_the_chain_verifies_across_reopen_and_every_operation(self) -> None:
        self.fill()
        self.s.delete("m", "NAME", actor="a")
        self.s.rotate_deks(actor="a")
        self.s.rotate_kek(actor="a")
        s = self.reopen()
        s.put_secret("m", "TOKEN", "x" * 20, actor="a")
        v = s.verify_audit()
        self.assertTrue(v.ok)
        self.assertGreaterEqual(v.checked, 10)

    def _without_triggers(self) -> None:
        self.s._conn.execute("DROP TRIGGER audit_no_update")
        self.s._conn.execute("DROP TRIGGER audit_no_delete")

    def test_a_flipped_field_fails_verification_at_that_row(self) -> None:
        self.fill()
        self._without_triggers()
        target = self.rows("SELECT id FROM audit WHERE action='set' ORDER BY id")[1][0]
        for col, val in (("actor", "mallory"), ("module", "x"), ("key", "ZZ"), ("action", "set"),
                         ("at", "2000-01-01T00:00:00Z"), ("detail", "hacked"), ("new_json", '"x"'),
                         ("old_json", '"y"'), ("surface", "web"), ("request_id", "forged")):
            with self.subTest(col):
                keep = self.rows(f"SELECT {col} FROM audit WHERE id=?", target)[0][0]
                if keep == val:
                    val = f"{val}-different"
                self.s._conn.execute(f"UPDATE audit SET {col}=? WHERE id=?", (val, target))
                v = self.s.verify_audit()
                self.assertEqual((v.ok, v.first_bad_id), (False, target))
                self.s._conn.execute(f"UPDATE audit SET {col}=? WHERE id=?", (keep, target))
                self.assertTrue(self.s.verify_audit().ok, "restoring the original field restores the chain")

    def test_a_deleted_row_in_the_middle_fails(self) -> None:
        self.fill()
        self._without_triggers()
        ids = [r[0] for r in self.rows("SELECT id FROM audit ORDER BY id")]
        self.s._conn.execute("DELETE FROM audit WHERE id=?", (ids[3],))
        v = self.s.verify_audit()
        self.assertEqual((v.ok, v.first_bad_id), (False, ids[4]))

    def test_a_renumbered_row_and_a_forged_mac_fail(self) -> None:
        self.fill()
        self._without_triggers()
        last = self.rows("SELECT max(id) FROM audit")[0][0]
        self.s._conn.execute("UPDATE audit SET id=? WHERE id=?", (last + 10, last))
        self.assertFalse(self.s.verify_audit().ok)
        self.s._conn.execute("UPDATE audit SET id=? WHERE id=?", (last, last + 10))
        self.s._conn.execute("UPDATE audit SET mac=? WHERE id=?", (b"\x00" * 32, last))
        self.assertEqual(self.s.verify_audit().first_bad_id, last)

    def test_a_forged_row_without_the_audit_key_fails(self) -> None:
        self.fill()
        self._without_triggers()
        self.s._conn.execute("INSERT INTO audit(at, actor, surface, action, mac) VALUES "
                             "('2026-01-01T00:00:00Z','mallory','web','set',?)", (os.urandom(32),))
        self.assertFalse(self.s.verify_audit().ok)

    def test_secret_writes_are_audited_as_changed_and_never_with_a_value_or_fingerprint(self) -> None:
        self.s.put_secret("m", "TOKEN", CANARY, actor="alice", surface="web", request_id="req-1")
        row = self.rows("SELECT * FROM audit WHERE action='set'")[0]
        self.assertEqual((row["actor"], row["surface"], row["module"], row["key"], row["detail"], row["request_id"]),
                         ("alice", "web", "m", "TOKEN", "changed", "req-1"))
        self.assertIsNone(row["old_json"])
        self.assertIsNone(row["new_json"])
        fp = self.s.get_meta("m", "TOKEN").fingerprint
        dump = repr([tuple(r) for r in self.rows("SELECT * FROM audit")])
        self.assertNotIn(CANARY, dump)
        self.assertNotIn(fp, dump)

    def test_non_secret_writes_carry_old_and_new(self) -> None:
        self.s.put_value("m", "PORT", 80, actor="alice")
        self.s.put_value("m", "PORT", 8080, actor="alice")
        rows = self.rows("SELECT old_json, new_json, detail FROM audit WHERE action='set' ORDER BY id")
        self.assertEqual([tuple(r) for r in rows], [(None, "80", None), ("80", "8080", None)])

    def test_each_entry_is_logged_as_one_json_line_after_commit_only(self) -> None:
        import json
        records: list[logging.LogRecord] = []

        class H(logging.Handler):
            def emit(self, r: logging.LogRecord) -> None:
                records.append(r)
        log = logging.getLogger("bothy.settings.audit")
        h, old = H(), log.level
        log.addHandler(h)
        log.setLevel(logging.INFO)
        self.addCleanup(log.removeHandler, h)
        self.addCleanup(log.setLevel, old)
        self.s.put_secret("m", "TOKEN", CANARY, actor="alice")
        with self.assertRaises(VersionConflict):
            self.s.put_secret("m", "TOKEN", CANARY2, actor="alice", if_version=9)
        with self.assertRaises(ClassificationError):
            self.s.put_value("m", "TOKEN", CANARY, actor="alice")
        lines = [json.loads(r.getMessage()) for r in records]
        self.assertEqual([(x["action"], x["key"]) for x in lines], [("set", "TOKEN")])
        self.assertNotIn("mac", lines[0])
        text = "".join(r.getMessage() for r in records)
        self.assertNotIn(CANARY, text)
        self.assertNotIn(CANARY2, text)

    def test_a_failed_decrypt_is_audited_as_read_denied(self) -> None:
        self.fill()
        self.s._conn.execute("UPDATE secrets SET ciphertext=x'00' WHERE key='TOKEN'")
        for fn in (lambda: self.reveal("TOKEN"), lambda: self.s.export_document(actor="a")):
            with self.assertRaises(DecryptError):
                fn()
        rows = self.rows("SELECT module, key, detail FROM audit WHERE action='read-denied'")
        self.assertEqual(len(rows), 2)
        self.assertTrue(self.s.verify_audit().ok)

    def test_every_reveal_and_export_is_audited(self) -> None:
        self.fill()
        self.reveal("TOKEN")
        self.s.export_document(actor="a")
        rows = [tuple(r) for r in self.rows("SELECT action, key, detail FROM audit WHERE action IN ('projection','export')")]
        self.assertEqual(rows, [("projection", "TOKEN", "projected"), ("export", None, "4 value(s)")])

    def test_read_audit_pages_and_never_returns_the_mac(self) -> None:
        self.fill()
        first = self.s.read_audit(limit=2)
        self.assertEqual(len(first), 2)
        rest = self.s.read_audit(after_id=first[-1]["id"])
        self.assertTrue(all(r["id"] > first[-1]["id"] for r in rest))
        self.assertNotIn("mac", first[0])

    def test_a_chain_that_never_existed_verifies_as_empty_ok(self) -> None:
        self.assertTrue(self.s.verify_audit().ok)


if __name__ == "__main__":
    unittest.main(verbosity=1)
