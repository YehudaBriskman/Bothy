#!/usr/bin/env python3
"""The defects an independent review found, one class each, each proved to FAIL on the old code.

Run: python3 apps/bothy-settings/checks/test_hardening.py   (needs `cryptography`)

  Restore         dry-decrypt of BOTH store keys and the audit chain before anything is touched;
                  rollback when the restored file will not open; crash-safe swap (every step,
                  as an exception and as a real kill); a stale WAL cannot be replayed onto the
                  new file; an unreadable live database can be replaced.
  AuditHead       tail deletion and deleting every row no longer verify.
  Versions        delete-then-put keeps counting (no ABA through `if_version`).
  ExportPartial   one bad row does not abort an export (record s13.2).
  OddPaths        a state path holding %, # and ? (URIs are quoted).
  MigrationAudit  the `migrate` row is in the migration's own transaction.
  Downgrade       each of the two refusals, alone.
  DekRotation     the NEW dek really is new, and the old one opens nothing.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import subprocess
import sys
import tempfile
import shutil
import unittest
from unittest import mock

import helpers
from helpers import CANARY, CANARY2, CANARY3, Crash, StoreCase
from bothy_settings import Store, audit, bootstrap, crypto, keyfile, restore, schema
from bothy_settings import store as store_mod
from bothy_settings.errors import (
    DecryptError, DowngradeError, KeyMissingError, RestoreError, VersionConflict,
)

PKG = os.path.dirname(helpers.HERE)
LIVE = "live-after-the-backup-0123456789"
VALUES = {"TOKEN": CANARY, "OTHER": CANARY2, "THIRD": CANARY3}


def sha(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def snapshot(state: str) -> dict[str, str]:
    return {f: sha(os.path.join(state, f)) for f in sorted(os.listdir(state))
            if os.path.isfile(os.path.join(state, f)) and f != ".lock"}


def child(code: str, *args: str, expect: int = 0) -> subprocess.CompletedProcess:  # type: ignore[type-arg]
    p = subprocess.run([sys.executable, "-I", "-c", "import sys\nsys.path.insert(0, sys.argv[1])\n" + code, PKG, *args],
                       capture_output=True, timeout=60)
    assert p.returncode == expect, (p.returncode, p.stderr.decode()[-600:])
    return p


class Restore(StoreCase):
    def setUp(self) -> None:
        super().setUp()
        self.fill()
        self.bk = self.s.backup(os.path.join(self.root, "bk.db")).path

    def rehash(self, bk: str) -> None:
        with open(bk + ".sha256", "w") as f:
            f.write(f"{sha(bk)}  {os.path.basename(bk)}\n")

    def edit_backup(self, sql: str, *args: object, triggers: bool = False) -> None:
        c = sqlite3.connect(self.bk)
        if triggers:
            c.execute("DROP TRIGGER audit_no_update")
            c.execute("DROP TRIGGER audit_no_delete")
        c.execute(sql, args)
        c.commit()
        c.close()
        self.rehash(self.bk)

    def diverge(self) -> None:
        """The live store moves on after the backup, so a restore visibly changes it."""
        self.s.put_secret("m", "TOKEN", LIVE, actor="a")
        self.s.close()

    def refused(self, why: str) -> None:
        self.diverge()
        before = snapshot(self.state)
        with self.assertRaises(RestoreError) as cm:
            restore(self.state, self.kf, self.bk, actor="cli:ops")
        self.assertIn(why, str(cm.exception))
        self.assertEqual(snapshot(self.state), before, "a refused restore changes nothing")
        self.assertEqual([f for f in os.listdir(self.state) if "restoring" in f], [], "and leaves no temp file")
        s = self.open()  # the live store is still perfectly good
        self.s = s
        self.assertEqual(self.reveal("TOKEN", store=s), LIVE)
        self.assertTrue(s.verify_audit().ok)

    # -- item 1 --------------------------------------------------------------
    def test_a_backup_with_a_corrupted_audit_key_wrap_is_refused_and_the_live_store_survives(self) -> None:
        # Reproduction from the review: hash matches, every secret decrypts, key_check is fine -
        # and the file cannot be opened. Before the fix this REPLACED the live database.
        self.edit_backup("UPDATE meta SET v=? WHERE k='store_key.audit_key'", b"\x00" * 60)
        self.refused("cannot be opened")

    def test_a_backup_with_a_corrupted_fp_key_wrap_is_refused(self) -> None:
        self.edit_backup("UPDATE meta SET v=? WHERE k='store_key.fp_key'", b"\x01" * 60)
        self.refused("cannot be opened")

    def test_a_backup_whose_audit_chain_is_broken_is_refused(self) -> None:
        self.edit_backup("UPDATE audit SET actor='mallory' WHERE id=3", triggers=True)
        self.refused("audit chain")

    def test_a_backup_with_the_audit_tail_cut_off_is_refused(self) -> None:
        self.edit_backup("DELETE FROM audit WHERE id > 3", triggers=True)
        self.refused("audit chain")

    # -- item 6: the swap ----------------------------------------------------
    STEPS_OLD = ("written", "verified", "aside", "checkpointed", "audited")
    STEPS_NEW = ("renamed",)

    def crash_then_open(self, step: str) -> Store:
        def hook(s: str) -> None:
            if s == step:
                raise Crash(step)
        self.diverge()
        with mock.patch.object(store_mod, "_restore_hook", hook):
            with self.assertRaises(Exception):
                restore(self.state, self.kf, self.bk, actor="cli:ops")
        s = self.open()
        self.s = s
        return s

    def assert_complete(self, s: Store, want: str) -> None:
        self.assertEqual(self.reveal("TOKEN", store=s), want)
        self.assertEqual(self.reveal("OTHER", store=s), CANARY2)
        self.assertEqual(self.reveal("THIRD", store=s), CANARY3)
        self.assertEqual(s.get_setting("m", "NAME"), "bothy")
        self.assertTrue(s.verify_audit().ok)
        self.assertEqual(s._conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertEqual([f for f in os.listdir(self.state) if "restoring" in f], [], "no temp file survives an open")

    def test_a_crash_at_every_step_leaves_one_complete_database(self) -> None:
        for step in self.STEPS_OLD + self.STEPS_NEW:
            with self.subTest(step):
                self.setUp()
                s = self.crash_then_open(step)
                self.assert_complete(s, CANARY if step in self.STEPS_NEW else LIVE)

    def test_a_real_process_kill_at_every_step_leaves_one_complete_database(self) -> None:
        code = ("import os\n"
                "from bothy_settings import restore\n"
                "from bothy_settings import store as st\n"
                "def hook(s):\n"
                "    if s == sys.argv[5]:\n"
                "        os._exit(9)\n"
                "st._restore_hook = hook\n"
                "restore(sys.argv[2], sys.argv[3], sys.argv[4], actor='child')\n"
                "os._exit(0)\n")
        for step in self.STEPS_OLD + self.STEPS_NEW:
            with self.subTest(step):
                self.setUp()
                self.diverge()
                child(code, self.state, self.kf, self.bk, step, expect=9)
                s = self.open()
                self.s = s
                # killed before the rename: the old one; at or after it: the restored one
                new = step in ("renamed", "audited")
                self.assert_complete(s, CANARY if new else LIVE)
                if step == "audited":
                    self.assertIn("restore", [r["action"] for r in s.read_audit(limit=1000)])

    def test_a_wal_left_by_the_old_database_cannot_be_replayed_onto_the_new_one(self) -> None:
        # The reviewer's mutant "restore keeps the old -wal" survived every test. Build a REAL,
        # valid WAL (from another database, left behind by a killed writer) and plant it at the
        # one moment it matters: after the live database is set aside, before the rename.
        scratch = os.path.join(self.root, "scratch.db")
        child("import os, sqlite3\n"
              "c = sqlite3.connect(sys.argv[2], isolation_level=None)\n"
              "c.execute('PRAGMA journal_mode=WAL')\n"
              "c.execute('PRAGMA wal_autocheckpoint=0')\n"
              "c.execute('CREATE TABLE t(x)')\n"
              "for i in range(300):\n"
              "    c.execute('INSERT INTO t VALUES (?)', ('x' * 500,))\n"
              "os._exit(0)\n", scratch)
        with open(scratch + "-wal", "rb") as f:
            stale = f.read()
        self.assertGreater(len(stale), 4096, "a real WAL, with frames")

        def hook(step: str) -> None:
            if step == "checkpointed":
                with open(os.path.join(self.state, "settings.db-wal"), "wb") as f:
                    f.write(stale)
        self.diverge()
        with mock.patch.object(store_mod, "_restore_hook", hook):
            restore(self.state, self.kf, self.bk, actor="cli:ops")
        s = self.open()
        self.s = s
        self.assert_complete(s, CANARY)

    def test_what_a_killed_writer_left_in_the_wal_is_kept_in_the_aside_copy_and_then_replaced(self) -> None:
        self.s.close()
        child("import os\n"
              "from bothy_settings import Store\n"
              "s = Store.open(sys.argv[2], sys.argv[3])\n"
              "s.put_secret('m', 'TOKEN', sys.argv[4], actor='writer')\n"
              "os._exit(0)\n", self.state, self.kf, LIVE)
        self.assertTrue(os.path.exists(os.path.join(self.state, "settings.db-wal")), "the writer left a WAL")
        rep = restore(self.state, self.kf, self.bk, actor="cli:ops")
        keep = sqlite3.connect(rep.aside)
        self.assertEqual(keep.execute("SELECT version FROM secrets WHERE key='TOKEN'").fetchone()[0], 2,
                         "the aside copy has the writer's committed-but-uncheckpointed change")
        keep.close()
        s = self.open()
        self.s = s
        self.assert_complete(s, CANARY)
        self.assertEqual(rep.changed_since_backup, (("m", "TOKEN"),))

    def test_the_installed_file_is_the_file_that_was_verified_and_hashed(self) -> None:
        self.s.close()
        restore(self.state, self.kf, self.bk, actor="cli:ops")
        # restore wrote the restore audit row, so the file now differs from the backup, but a restore
        # of a backup whose bytes change between hash and write must not install them
        with open(self.bk, "rb") as f:
            original = f.read()
        real_open = open
        calls = {"n": 0}

        def swap_after_hash(path, *a, **k):  # noqa: ANN001
            f = real_open(path, *a, **k)
            if path == self.bk and a and a[0] == "rb":
                calls["n"] += 1
            return f
        with mock.patch("builtins.open", swap_after_hash):
            restore(self.state, self.kf, self.bk, actor="cli:ops")
        self.assertEqual(calls["n"], 1, "the backup file is read exactly ONCE; verification and the install use that buffer")
        with open(self.bk, "rb") as f:
            self.assertEqual(f.read(), original)

    def test_a_restored_file_that_will_not_open_puts_the_previous_database_back(self) -> None:
        self.diverge()
        before_aside_values = None  # noqa: F841
        real = Store._open_existing.__func__  # type: ignore[attr-defined]
        calls = {"n": 0}

        def flaky(cls, *a, **k):  # noqa: ANN001
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("will not open")
            return real(cls, *a, **k)
        with mock.patch.object(Store, "_open_existing", classmethod(flaky)):
            with self.assertRaises(RestoreError) as cm:
                restore(self.state, self.kf, self.bk, actor="cli:ops")
        self.assertIn("put back", str(cm.exception))
        s = self.open()
        self.s = s
        self.assert_complete(s, LIVE)
        self.assertTrue([f for f in os.listdir(self.state) if f.startswith("pre-restore-")], "the aside copy is kept")

    def test_a_failed_restore_into_an_empty_state_dir_leaves_it_empty(self) -> None:
        fresh = os.path.join(self.root, "fresh")
        os.makedirs(fresh, mode=0o700)
        with mock.patch.object(Store, "_open_existing", side_effect=RuntimeError("will not open")):
            with self.assertRaises(RestoreError):
                restore(fresh, self.kf, self.bk, actor="cli:ops")
        self.assertEqual([f for f in os.listdir(fresh) if f.startswith("settings.db")], [])

    def test_an_unreadable_live_database_can_be_replaced_and_its_bytes_are_kept(self) -> None:
        self.s.close()
        junk = b"this is not a database " * 200
        with open(os.path.join(self.state, "settings.db"), "wb") as f:
            f.write(junk)
        rep = restore(self.state, self.kf, self.bk, actor="cli:ops")
        self.assertTrue(os.path.isdir(rep.aside))
        with open(os.path.join(rep.aside, "settings.db"), "rb") as f:
            self.assertEqual(f.read(), junk)
        s = self.open()
        self.s = s
        self.assert_complete(s, CANARY)


class AuditHead(StoreCase):
    def setUp(self) -> None:
        super().setUp()
        self.fill()
        self.s._conn.execute("DROP TRIGGER audit_no_delete")  # the attacker who can drop triggers

    def test_deleting_the_newest_rows_is_detected(self) -> None:
        self.assertTrue(self.s.verify_audit().ok)
        n = self.rows("SELECT max(id) FROM audit")[0][0]
        self.s._conn.execute("DELETE FROM audit WHERE id > ?", (n - 3,))
        v = self.s.verify_audit()
        self.assertFalse(v.ok)
        self.assertIn("head", v.reason or "")

    def test_deleting_every_row_is_detected(self) -> None:
        self.s._conn.execute("DELETE FROM audit")
        v = self.s.verify_audit()
        self.assertFalse(v.ok)
        self.assertEqual(v.checked, 0)
        self.assertIn("every audit row is gone", v.reason or "")

    def test_the_head_cannot_be_rewritten_without_the_audit_key(self) -> None:
        n = self.rows("SELECT max(id) FROM audit")[0][0]
        self.s._conn.execute("DELETE FROM audit WHERE id = ?", (n,))
        head = bytes(self.rows("SELECT v FROM meta WHERE k='audit_head'")[0][0])
        prev = bytes(self.rows("SELECT mac FROM audit WHERE id = ?", n - 1)[0][0])
        forged = (n - 1).to_bytes(8, "big") + prev + head[40:]  # the right shape, the OLD authenticator
        self.s._conn.execute("UPDATE meta SET v=? WHERE k='audit_head'", (forged,))
        v = self.s.verify_audit()
        self.assertFalse(v.ok)
        self.assertIn("authenticate", v.reason or "")

    def test_a_missing_head_fails(self) -> None:
        self.s._conn.execute("DELETE FROM meta WHERE k='audit_head'")
        self.assertFalse(self.s.verify_audit().ok)

    def test_the_head_moves_in_the_same_transaction_as_the_row(self) -> None:
        head = lambda: bytes(self.rows("SELECT v FROM meta WHERE k='audit_head'")[0][0])  # noqa: E731
        h0 = head()
        with self.assertRaises(Crash):
            with self.s._tx():
                self.s._audit("set", actor="a", surface="cli", module="m", key="TOKEN", detail="x")
                raise Crash()
        self.assertEqual(head(), h0, "a rolled-back append leaves the head where it was")
        self.s.put_value("m", "NAME", "z", actor="a")
        self.assertNotEqual(head(), h0)
        last = self.rows("SELECT id, mac FROM audit ORDER BY id DESC LIMIT 1")[0]
        self.assertEqual(head()[:8], int(last[0]).to_bytes(8, "big"))
        self.assertEqual(head()[8:40], bytes(last[1]))
        self.assertTrue(self.s.verify_audit().ok)

    def test_the_head_survives_reopen_rotation_and_a_backup(self) -> None:
        self.s._conn.execute("CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit "
                             "BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END")
        self.s.rotate_kek(actor="a")
        s = self.reopen()
        self.assertTrue(s.verify_audit().ok)
        bk = s.backup(os.path.join(self.root, "b.db")).path
        c = sqlite3.connect(bk)
        self.assertEqual(c.execute("SELECT count(*) FROM meta WHERE k='audit_head'").fetchone()[0], 1)
        c.close()


class Versions(StoreCase):
    def test_delete_then_put_keeps_counting_so_a_stale_if_version_conflicts(self) -> None:
        for secret in (True, False):
            with self.subTest("secret" if secret else "plain"):
                key = "TOKEN" if secret else "NAME"
                put = (lambda v, **k: self.s.put_secret("m", key, v, actor="a", **k)) if secret else \
                      (lambda v, **k: self.s.put_value("m", key, v, actor="a", **k))
                v1 = put("first-value-0123456789").version
                self.s.delete("m", key, actor="a")
                v2 = put("second-value-0123456789").version
                self.assertGreater(v2, v1, "a delete must not reset the counter")
                with self.assertRaises(VersionConflict):
                    put("clobber-0123456789", if_version=v1)  # the stale client from before the delete
                self.assertEqual(put("third-value-0123456789", if_version=v2).version, v2 + 1)

    def test_the_counter_survives_generate_reopen_import_and_restore(self) -> None:
        self.s.put_secret("m", "TOKEN", "a" * 20, actor="a")
        self.s.put_secret("m", "TOKEN", "b" * 20, actor="a")
        self.s.delete("m", "TOKEN", actor="a")
        s = self.reopen()
        self.assertEqual(s.generate_secret("m", "TOKEN", actor="a").version, 3)
        doc = s.export_document(actor="a")
        s.delete("m", "TOKEN", actor="a")
        s.import_document(doc, actor="a", merge=True)
        self.assertEqual(s.get_meta("m", "TOKEN").version, 4)
        bk = s.backup(os.path.join(self.root, "b.db")).path
        s.close()
        restore(self.state, self.kf, bk, actor="cli:ops")
        s = self.open()
        self.s = s
        s.delete("m", "TOKEN", actor="a")
        self.assertEqual(s.put_secret("m", "TOKEN", "c" * 20, actor="a").version, 5)

    def test_if_version_zero_still_means_must_not_exist(self) -> None:
        self.s.put_secret("m", "TOKEN", "a" * 20, actor="a")
        self.s.delete("m", "TOKEN", actor="a")
        self.assertEqual(self.s.put_secret("m", "TOKEN", "b" * 20, actor="a", if_version=0).version, 2)

    def test_a_tampered_counter_is_refused_not_ignored(self) -> None:
        self.s._conn.execute("INSERT INTO meta(k, v) VALUES ('version.m.TOKEN', x'6e6f7065')")
        with self.assertRaises(Exception) as cm:
            self.s.put_secret("m", "TOKEN", "a" * 20, actor="a")
        self.assertIn("not a number", str(cm.exception))


class ExportPartial(StoreCase):
    def setUp(self) -> None:
        super().setUp()
        self.fill()

    def test_one_tampered_row_does_not_abort_the_export(self) -> None:
        self.s._conn.execute("UPDATE secrets SET ciphertext=x'00' WHERE key='OTHER'")
        doc = self.s.export_document(actor="ops")
        (mod,) = doc["modules"]
        self.assertEqual(mod["secrets"], {"TOKEN": CANARY, "THIRD": CANARY3})
        self.assertEqual(mod["settings"], {"NAME": "bothy"})
        self.assertEqual(doc.unreadable, ("m.OTHER",))
        self.assertEqual(sorted(doc), ["bothy_version", "exported_at", "format", "modules"],
                         "the unreadable list is not part of the document")
        rows = self.rows("SELECT module, key FROM audit WHERE action='read-denied'")
        self.assertEqual([tuple(r) for r in rows], [("m", "OTHER")])
        detail = self.rows("SELECT detail FROM audit WHERE action='export'")[0][0]
        self.assertEqual(detail, "3 value(s); 1 unreadable: m.OTHER")
        self.assertNotIn(CANARY2, str(doc.unreadable) + detail)
        self.assertTrue(self.s.verify_audit().ok)

    def test_a_row_under_a_key_that_is_not_in_the_key_file_is_reported_too(self) -> None:
        self.s._conn.execute("UPDATE secrets SET kek_id='deadbeefdeadbeef' WHERE key='THIRD'")
        doc = self.s.export_document(actor="ops")
        self.assertEqual(doc.unreadable, ("m.THIRD",))
        self.assertEqual(doc["modules"][0]["secrets"], {"TOKEN": CANARY, "OTHER": CANARY2})

    def test_a_clean_export_reports_nothing_and_every_bad_row_is_named(self) -> None:
        self.assertEqual(self.s.export_document(actor="ops").unreadable, ())
        self.s._conn.execute("UPDATE secrets SET ciphertext=x'00'")
        doc = self.s.export_document(actor="ops")
        self.assertEqual(doc.unreadable, ("m.OTHER", "m.THIRD", "m.TOKEN"))
        self.assertEqual(doc["modules"][0]["secrets"], {})


class OddPaths(unittest.TestCase):
    def test_a_state_path_with_percent_hash_and_question_mark(self) -> None:
        root = tempfile.mkdtemp(prefix="bothy-odd-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        state = os.path.join(root, "st%41te#1?x=y")
        kf = os.path.join(root, "k%2F#k?", "master.key")
        # the decoy a naive `file:{path}` URI would open instead of the real file: %41 -> A
        decoy_dir = os.path.join(root, "stAte#1")
        os.makedirs(decoy_dir)
        bootstrap(state, kf)
        with Store.open(state, kf) as s:
            s.register_fields("m", {"TOKEN": True}, actor="t")
            s.put_secret("m", "TOKEN", CANARY, actor="t")
            bk = s.backup(os.path.join(root, "b%41#?.db")).path  # backup source AND destination
            s.put_secret("m", "TOKEN", LIVE, actor="t")
        rep = restore(state, kf, bk, actor="cli:ops")  # restore: live db read, backup read
        self.assertIsNotNone(rep.aside)
        with Store.open(state, kf) as s:
            self.assertEqual(s.reveal_for_projection("m", "TOKEN", actor="t"), CANARY)
        os.unlink(kf)  # bootstrap's orphan count reads the database through a URI too
        with self.assertRaises(KeyMissingError) as cm:
            bootstrap(state, kf)
        self.assertEqual(cm.exception.orphans, 1)
        self.assertEqual(os.listdir(decoy_dir), [], "nothing was ever opened at the decoy path")


class MigrationAudit(StoreCase):
    V2 = schema.MIGRATIONS + (("CREATE TABLE extra (id INTEGER PRIMARY KEY) STRICT",),)

    def test_the_migrate_row_is_in_the_migrations_own_transaction(self) -> None:
        self.s.close()
        real = audit.append

        def failing(c, key, **kw):  # noqa: ANN001
            if kw.get("action") == "migrate":
                raise RuntimeError("the audit write failed")
            return real(c, key, **kw)
        with mock.patch.object(schema, "MIGRATIONS", self.V2), mock.patch.object(audit, "append", failing):
            with self.assertRaises(RuntimeError):
                Store.open(self.state, self.kf)
        # Before the fix the migration had already committed: version 2 and no audit row.
        c = sqlite3.connect(os.path.join(self.state, "settings.db"))
        self.assertEqual(c.execute("PRAGMA user_version").fetchone()[0], 1, "the migration rolled back with its audit row")
        self.assertEqual(c.execute("SELECT count(*) FROM sqlite_master WHERE name='extra'").fetchone()[0], 0)
        c.close()
        with mock.patch.object(schema, "MIGRATIONS", self.V2):
            s = Store.open(self.state, self.kf)
        self.addCleanup(s.close)
        self.assertEqual(s._conn.execute("PRAGMA user_version").fetchone()[0], 2)
        self.assertEqual([r["detail"] for r in s.read_audit(limit=1000) if r["action"] == "migrate"][-1], "schema 1 -> 2")
        self.assertTrue(s.verify_audit().ok)


class Downgrade(StoreCase):
    def make_newer_in_header(self) -> None:
        self.s.close()
        with open(os.path.join(self.state, "settings.db"), "r+b") as f:
            f.seek(60)
            f.write((99).to_bytes(4, "big"))

    def test_the_header_check_refuses_before_any_connection_is_made(self) -> None:
        self.make_newer_in_header()
        before = snapshot(self.state)
        with mock.patch.object(store_mod, "_connect", side_effect=AssertionError("connected to a newer database")):
            with self.assertRaises(DowngradeError):
                Store.open(self.state, self.kf)
        self.assertEqual(snapshot(self.state), before)

    def test_a_newer_version_that_only_the_wal_holds_is_still_a_downgrade(self) -> None:
        self.s.close()
        child("import os, sqlite3\n"
              "c = sqlite3.connect(sys.argv[2], isolation_level=None)\n"
              "c.execute('PRAGMA journal_mode=WAL')\n"
              "c.execute('PRAGMA wal_autocheckpoint=0')\n"
              "c.execute('PRAGMA user_version=99')\n"
              "os._exit(0)\n", os.path.join(self.state, "settings.db"))
        with open(os.path.join(self.state, "settings.db"), "rb") as f:
            self.assertEqual(int.from_bytes(f.read(64)[60:64], "big"), 1, "the main file still says 1")
        with self.assertRaises(DowngradeError):  # not CorruptDatabaseError from a later, accidental check
            Store.open(self.state, self.kf)


class DekRotation(StoreCase):
    def unwrap(self, row, kek: bytes) -> bytes:  # noqa: ANN001
        return crypto.open_(kek, bytes(row["wrap_nonce"]), bytes(row["wrapped_dek"]),
                            crypto.aad_wrap(self.s._store_id, row["module"], row["key"], row["kek_id"]))

    def test_every_dek_is_replaced_and_the_old_one_opens_nothing(self) -> None:
        self.fill()
        kek = keyfile.load(self.kf).active
        old = {r["key"]: (self.unwrap(r, kek), bytes(r["nonce"]), bytes(r["ciphertext"]))
               for r in self.rows("SELECT * FROM secrets")}
        self.s.rotate_deks(actor="ops")
        for r in self.rows("SELECT * FROM secrets"):
            dek_old, n_old, ct_old = old[r["key"]]
            dek_new = self.unwrap(r, kek)
            self.assertNotEqual(dek_new, dek_old, f"{r['key']}: the DEK must be new")
            aad = crypto.aad_value(self.s._store_id, r["module"], r["key"])
            with self.assertRaises(crypto.AuthFailure):  # the leaked DEK opens neither the new row ...
                crypto.open_(dek_old, bytes(r["nonce"]), bytes(r["ciphertext"]), aad)
            self.assertEqual(crypto.open_(dek_old, n_old, ct_old, aad), VALUES[r["key"]].encode(),
                             "(the old row, which no longer exists, did open under it)")
            self.assertEqual(crypto.open_(dek_new, bytes(r["nonce"]), bytes(r["ciphertext"]), aad),
                             VALUES[r["key"]].encode())


if __name__ == "__main__":
    unittest.main(verbosity=1)
