#!/usr/bin/env python3
"""Backup (online-backup API) and restore.

Run: python3 apps/bothy-settings/checks/test_backup.py   (needs `cryptography`)

Record s16.6: "Backup via the backup API during a write loop restores to a
consistent DB; restoring with the wrong key lists the missing key_id and changes
nothing." Plus every reason a restore must refuse.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import stat
import threading
import unittest
from unittest import mock

import helpers
from helpers import CANARY, CANARY2, CANARY3, StoreCase
from bothy_settings import Store, keyfile, restore
from bothy_settings.errors import (
    DowngradeError, KeyMissingError, RestoreError, RestoreKeyMissing, SettingsError, StoreBusyError,
)

VALUES = {"TOKEN": CANARY, "OTHER": CANARY2, "THIRD": CANARY3}


def sha(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def snapshot(state: str) -> dict[str, str]:
    return {f: sha(os.path.join(state, f)) for f in sorted(os.listdir(state))
            if os.path.isfile(os.path.join(state, f)) and f != ".lock"}


class Backup(StoreCase):
    def setUp(self) -> None:
        super().setUp()
        self.fill()

    def restored_copy(self, backup_path: str, name: str) -> Store:
        """Open a backup as a store of its own, in a new state dir, with the same key."""
        st = os.path.join(self.root, name)
        os.makedirs(st, mode=0o700)
        shutil.copy(backup_path, os.path.join(st, "settings.db"))
        os.chmod(os.path.join(st, "settings.db"), 0o600)
        return self.open(st)

    def test_a_backup_is_verified_hashed_0600_and_standalone(self) -> None:
        b = self.s.backup(os.path.join(self.root, "out", "b.db"))
        self.assertEqual(stat.S_IMODE(os.stat(b.path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(b.path + ".sha256").st_mode), 0o600)
        self.assertEqual(b.sha256, sha(b.path))
        with open(b.path + ".sha256") as f:
            self.assertEqual(f.read(), f"{b.sha256}  b.db\n")
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "out"))), ["b.db", "b.db.sha256"], "no -wal/-shm beside it")
        c = sqlite3.connect(b.path)
        self.assertEqual(c.execute("PRAGMA journal_mode").fetchone()[0], "delete")
        self.assertEqual(c.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        c.close()

    def test_a_backup_holds_everything_and_decrypts_with_the_same_key(self) -> None:
        b = self.s.backup(os.path.join(self.root, "b.db"))
        s2 = self.restored_copy(b.path, "copy")
        for k, v in VALUES.items():
            self.assertEqual(self.reveal(k, store=s2), v)
        self.assertEqual(s2.get_setting("m", "NAME"), "bothy")
        self.assertTrue(s2.verify_audit().ok)

    def test_the_default_destination_is_under_the_state_dir(self) -> None:
        b = self.s.backup()
        self.assertTrue(b.path.startswith(os.path.join(self.state, "backups") + os.sep))
        self.assertTrue(os.path.exists(b.path))

    def test_a_backup_is_never_overwritten(self) -> None:
        p = os.path.join(self.root, "b.db")
        self.s.backup(p)
        first = sha(p)
        with self.assertRaises(SettingsError):
            self.s.backup(p)
        self.assertEqual(sha(p), first)

    def test_a_failed_backup_leaves_nothing_behind(self) -> None:
        p = os.path.join(self.root, "fail.db")
        with mock.patch("bothy_settings.store.hashlib.sha256", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                self.s.backup(p)
        self.assertEqual([f for f in os.listdir(self.root) if f.startswith("fail")], [])

    def test_a_backup_that_does_not_verify_is_refused(self) -> None:
        p = os.path.join(self.root, "bad.db")
        real = sqlite3.connect

        class Bad(sqlite3.Connection):  # reports a broken database from integrity_check
            def execute(self, sql, *args):
                if "integrity_check" in sql:
                    return iter([("*** in database main ***",)])
                return super().execute(sql, *args)

        def bad_connect(target, *a, **k):  # only the DESTINATION connection is sabotaged
            if target == p:
                k["factory"] = Bad
            return real(target, *a, **k)
        with mock.patch("bothy_settings.store.sqlite3.connect", bad_connect):
            with self.assertRaises(SettingsError):
                self.s.backup(p)
        self.assertFalse(os.path.exists(p))

    def test_a_backup_taken_during_a_write_loop_is_one_consistent_snapshot(self) -> None:
        # Version n of TOKEN always holds the value "v<n>-...": a snapshot that mixed a row from one
        # commit with its version from another, or an audit chain from a different moment, shows here.
        self.s.delete("m", "TOKEN", actor="w")
        stop, errors = threading.Event(), []

        def writer() -> None:
            n = 0
            try:
                while not stop.is_set():
                    n += 1
                    self.s.put_secret("m", "TOKEN", f"v{n}-" + "x" * 30, actor="writer")
            except Exception as e:  # noqa: BLE001
                errors.append(e)
        t = threading.Thread(target=writer)
        t.start()
        try:
            paths = [self.s.backup(os.path.join(self.root, f"w{i}.db")).path for i in range(10)]
        finally:
            stop.set()
            t.join()
        self.assertEqual(errors, [])
        seen = set()
        for i, p in enumerate(paths):
            s2 = self.restored_copy(p, f"snap{i}")
            m = s2.get_meta("m", "TOKEN")
            if not m.set:
                continue
            self.assertEqual(self.reveal("TOKEN", store=s2), f"v{m.version}-" + "x" * 30,
                             "the row and its version come from different commits")
            v = s2.verify_audit()
            self.assertTrue(v.ok, "the audit chain in a snapshot must be a whole chain")
            n_set = s2._conn.execute("SELECT count(*) FROM audit WHERE action='set' AND key='TOKEN'").fetchone()[0]
            self.assertEqual(n_set - 1, m.version, "a change and its audit row are in the same snapshot")  # -1: the set done by fill()
            seen.add(m.version)
        self.assertGreaterEqual(len(seen), 2, "the writer ran while backups were taken")


class Restore(StoreCase):
    def setUp(self) -> None:
        super().setUp()
        self.fill()

    def backup(self) -> str:
        return self.s.backup(os.path.join(self.root, f"bk-{len(os.listdir(self.root))}.db")).path

    def test_restore_replays_the_old_state_and_reports_what_it_reverts(self) -> None:
        bk = self.backup()
        self.s.put_secret("m", "TOKEN", "changed-after-the-backup-01", actor="a")
        self.s.delete("m", "OTHER", actor="a")
        self.s.put_value("m", "NAME", "renamed", actor="a")
        self.s.close()
        rep = restore(self.state, self.kf, bk, actor="cli:ops")
        self.assertEqual(rep.restored_from, bk)
        self.assertEqual(rep.changed_since_backup, (("m", "OTHER"), ("m", "TOKEN")))
        self.assertIsNotNone(rep.aside)
        s = self.open()
        self.s = s
        for k, v in VALUES.items():
            self.assertEqual(self.reveal(k, store=s), v)
        self.assertEqual(s.get_setting("m", "NAME"), "bothy")
        self.assertTrue(s.verify_audit().ok)
        last = [r for r in s.read_audit() if r["action"] == "restore"][-1]
        self.assertEqual(last["actor"], "cli:ops")
        self.assertIn("2 secret(s) differ", last["detail"])

    def test_the_current_database_is_kept_aside_and_is_itself_restorable(self) -> None:
        bk = self.backup()
        self.s.put_secret("m", "TOKEN", "newer-value-0123456789", actor="a")
        self.s.close()
        rep = restore(self.state, self.kf, bk, actor="cli:ops")
        self.assertTrue(os.path.exists(rep.aside) and os.path.exists(rep.aside + ".sha256"))
        c = sqlite3.connect(rep.aside)
        self.assertEqual(c.execute("SELECT version FROM secrets WHERE key='TOKEN'").fetchone()[0], 2)
        c.close()
        restore(self.state, self.kf, rep.aside, actor="cli:ops")  # and back again
        s = self.open()
        self.s = s
        self.assertEqual(self.reveal("TOKEN", store=s), "newer-value-0123456789")

    def test_no_stale_wal_survives_the_swap(self) -> None:
        bk = self.backup()
        self.s.put_secret("m", "TOKEN", "x" * 30, actor="a")
        self.assertTrue(os.path.exists(self.state + "/settings.db-wal"))
        self.s.close()
        # re-create a stale -wal as a crash would leave it
        with open(os.path.join(self.state, "settings.db-wal"), "wb") as f:
            f.write(os.urandom(4152))
        restore(self.state, self.kf, bk, actor="cli:ops")
        self.assertEqual(sorted(f for f in os.listdir(self.state) if f.endswith(("-wal", "-shm"))), [])
        s = self.open()
        self.s = s
        self.assertEqual(self.reveal("TOKEN", store=s), CANARY)

    def test_the_wrong_key_lists_the_missing_key_id_and_changes_nothing(self) -> None:
        bk = self.backup()
        self.s.put_secret("m", "TOKEN", "x" * 30, actor="a")
        self.s.close()
        want = self.s.key_id
        os.unlink(self.kf)
        other = keyfile.create(self.kf)
        before = snapshot(self.state)
        with self.assertRaises(RestoreKeyMissing) as cm:
            restore(self.state, self.kf, bk, actor="cli:ops")
        self.assertEqual(cm.exception.missing, [want])
        self.assertIn(want, str(cm.exception))
        self.assertNotIn(other.active_id, cm.exception.missing)
        self.assertEqual(snapshot(self.state), before, "nothing may change, not even an aside copy")

    def test_a_backup_from_before_a_rotation_needs_the_retired_key_back(self) -> None:
        bk = self.backup()
        old_id = self.s.key_id
        self.s.rotate_kek(actor="ops")
        self.s.close()
        with self.assertRaises(RestoreKeyMissing) as cm:
            restore(self.state, self.kf, bk, actor="cli:ops")
        self.assertEqual(cm.exception.missing, [old_id])
        keyfile.unretire(self.kf, old_id)
        restore(self.state, self.kf, bk, actor="cli:ops")
        s = self.open()
        self.s = s
        self.assertEqual(s.key_id, old_id)
        self.assertEqual(s.rotation_state, "pending-rewrap", "the active key is the new one, the rows are old")
        for k, v in VALUES.items():
            self.assertEqual(self.reveal(k, store=s), v)
        s.rotate_kek(actor="ops")  # the open rotation finishes normally
        self.assertEqual(s.rotation_state, "none")
        self.assertEqual(self.reveal("TOKEN", store=s), CANARY)

    def refused(self, exc: type[Exception], bk: str) -> None:
        self.s.close()
        before = snapshot(self.state)
        with self.assertRaises(exc):
            restore(self.state, self.kf, bk, actor="cli:ops")
        self.assertEqual(snapshot(self.state), before, "a refused restore changes nothing")

    def test_a_backup_without_its_hash_is_refused(self) -> None:
        bk = self.backup()
        os.unlink(bk + ".sha256")
        self.s.close()
        self.refused(RestoreError, bk)

    def test_a_backup_that_does_not_match_its_hash_is_refused(self) -> None:
        bk = self.backup()
        with open(bk, "r+b") as f:
            f.seek(-1, os.SEEK_END)
            last = f.read(1)
            f.seek(-1, os.SEEK_END)
            f.write(bytes([last[0] ^ 1]))
        self.s.close()
        self.refused(RestoreError, bk)

    def rehash(self, bk: str) -> None:
        with open(bk + ".sha256", "w") as f:
            f.write(f"{sha(bk)}  {os.path.basename(bk)}\n")

    def test_a_corrupt_or_truncated_backup_is_refused_even_with_a_matching_hash(self) -> None:
        sizes = (0, 50, 4096)
        bks = [self.backup() for _ in sizes]
        self.s.close()
        for n, bk in zip(sizes, bks):
            with self.subTest(n):
                os.truncate(bk, n)
                self.rehash(bk)
                before = snapshot(self.state)
                with self.assertRaises(SettingsError):
                    restore(self.state, self.kf, bk, actor="cli:ops")
                self.assertEqual(snapshot(self.state), before)

    def test_a_newer_schema_backup_is_refused(self) -> None:
        bk = self.backup()
        c = sqlite3.connect(bk)
        c.execute("PRAGMA user_version = 99")
        c.commit()
        c.close()
        self.rehash(bk)
        self.refused(DowngradeError, bk)

    def test_a_backup_with_a_tampered_secret_is_refused_before_anything_changes(self) -> None:
        bk = self.backup()
        c = sqlite3.connect(bk)
        c.execute("UPDATE secrets SET ciphertext=x'00' WHERE key='OTHER'")
        c.commit()
        c.close()
        self.rehash(bk)
        self.s.close()
        with self.assertRaises(RestoreError) as cm:
            restore(self.state, self.kf, bk, actor="cli:ops")
        self.assertIn("OTHER", str(cm.exception))

    def test_a_backup_with_a_tampered_wrapped_dek_is_refused(self) -> None:
        bk = self.backup()
        c = sqlite3.connect(bk)
        c.execute("UPDATE secrets SET wrapped_dek=x'00' WHERE key='THIRD'")
        c.commit()
        c.close()
        self.rehash(bk)
        self.s.close()
        with self.assertRaises(RestoreError):
            restore(self.state, self.kf, bk, actor="cli:ops")

    def test_a_backup_with_a_tampered_key_check_is_refused(self) -> None:
        bk = self.backup()
        c = sqlite3.connect(bk)
        c.execute("UPDATE meta SET v=? WHERE k='key_check'", (b"\x00" * 40,))
        c.commit()
        c.close()
        self.rehash(bk)
        self.s.close()
        with self.assertRaises(RestoreError):
            restore(self.state, self.kf, bk, actor="cli:ops")

    def test_a_running_store_blocks_a_restore(self) -> None:
        bk = self.backup()
        with self.assertRaises(StoreBusyError):
            restore(self.state, self.kf, bk, actor="cli:ops")

    def test_a_missing_key_file_blocks_a_restore(self) -> None:
        bk = self.backup()
        self.s.close()
        os.unlink(self.kf)
        before = snapshot(self.state)
        with self.assertRaises(KeyMissingError):
            restore(self.state, self.kf, bk, actor="cli:ops")
        self.assertEqual(snapshot(self.state), before)

    def test_restore_into_an_empty_state_dir_works(self) -> None:
        bk = self.backup()
        self.s.close()
        fresh = os.path.join(self.root, "fresh")
        rep = restore(fresh if os.path.isdir(fresh) else self._mk(fresh), self.kf, bk, actor="cli:ops")
        self.assertIsNone(rep.aside)
        self.assertEqual(rep.changed_since_backup, ())
        s = self.open(fresh)
        self.assertEqual(self.reveal("TOKEN", store=s), CANARY)

    def _mk(self, p: str) -> str:
        os.makedirs(p, mode=0o700)
        return p


if __name__ == "__main__":
    unittest.main(verbosity=1)
