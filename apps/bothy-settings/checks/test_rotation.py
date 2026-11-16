#!/usr/bin/env python3
"""KEK rotation, DEK rotation, and a crash at every step of both.

Run: python3 apps/bothy-settings/checks/test_rotation.py   (needs `cryptography`)

Record s16.3: "KEK rotation keeps every value readable; interrupted at each step
(crash injection) it resumes or aborts; old key alone and new key alone both
behave." Two kinds of crash are injected: an exception from a test hook (which
unwinds the transaction the way a failed statement would) and a real os._exit(9)
in a child process (which leaves SQLite to recover from its WAL, as a kill would).
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import unittest

import helpers
from helpers import CANARY, CANARY2, CANARY3, Crash, StoreCase
from bothy_settings import Store, keyfile
from bothy_settings.errors import DecryptError, RotationError, WrongKeyError

PKG = os.path.dirname(helpers.HERE)

# step -> rotation_state a restart must find
STEPS = {
    "backup": "none",
    "keyfile": "pending-rewrap",
    "rewrap-midway": "pending-rewrap",
    "rewrap-precommit": "pending-rewrap",
    "rewrap": "pending-finish",
    "verify": "pending-finish",
    "finish": "none",
}
VALUES = {"TOKEN": CANARY, "OTHER": CANARY2, "THIRD": CANARY3}


class KekRotation(StoreCase):
    def setUp(self) -> None:
        super().setUp()
        self.fill()
        self.old_id = self.s.key_id
        self.fps = {k: self.s.get_meta("m", k).fingerprint for k in VALUES}

    def assert_all_readable(self, s: Store | None = None) -> None:
        for k, v in VALUES.items():
            self.assertEqual(self.reveal(k, store=s), v)
        self.assertEqual((s or self.s).get_setting("m", "NAME"), "bothy")

    def test_rotation_keeps_every_value_and_does_not_reencrypt_values(self) -> None:
        before = {r["key"]: dict(r) for r in self.rows("SELECT * FROM secrets")}
        res = self.s.rotate_kek(actor="ops")
        self.assertEqual((res.old_key_id, res.rewrapped, res.finished), (self.old_id, 3, True))
        self.assertNotEqual(res.new_key_id, self.old_id)
        self.assertEqual(self.s.key_id, res.new_key_id)
        self.assert_all_readable()
        for r in self.rows("SELECT * FROM secrets"):
            b = before[r["key"]]
            self.assertEqual((r["ciphertext"], r["nonce"]), (b["ciphertext"], b["nonce"]),
                             "the VALUE is not re-encrypted")
            self.assertNotEqual(r["wrapped_dek"], b["wrapped_dek"])
            self.assertNotEqual(r["wrap_nonce"], b["wrap_nonce"])
            self.assertEqual((r["kek_id"], r["version"], r["updated_at"], r["updated_by"]),
                             (res.new_key_id, b["version"], b["updated_at"], b["updated_by"]))
        self.assertEqual({k: self.s.get_meta("m", k).fingerprint for k in VALUES}, self.fps,
                         "fingerprints are stable across a KEK rotation (fp_key is wrapped, not replaced)")
        self.assertTrue(self.s.verify_audit().ok)
        self.assertEqual(self.s.rotation_state, "none")

    def test_the_file_ends_with_one_key_and_the_old_one_retired_0600(self) -> None:
        self.s.rotate_kek(actor="ops")
        ks = keyfile.load(self.kf)
        self.assertEqual(ks.ids, (self.s.key_id,))
        rp = keyfile.retired_path(self.kf, self.old_id)
        self.assertEqual(stat.S_IMODE(os.stat(rp).st_mode), 0o600)
        self.assertEqual(keyfile.load(rp).active_id, self.old_id)

    def test_a_verified_pre_rotation_backup_is_taken(self) -> None:
        self.s.rotate_kek(actor="ops")
        d = os.path.join(self.state, "backups")
        dbs = [f for f in os.listdir(d) if f.startswith("pre-rotate-") and f.endswith(".db")]
        self.assertEqual(len(dbs), 1)
        self.assertIn(self.old_id, dbs[0])
        import sqlite3
        c = sqlite3.connect(os.path.join(d, dbs[0]))
        self.assertEqual(c.execute("SELECT v FROM meta WHERE k='kek_id'").fetchone()[0].decode(), self.old_id)
        self.assertEqual(c.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        c.close()

    def test_writes_after_rotation_use_the_new_key(self) -> None:
        res = self.s.rotate_kek(actor="ops")
        self.s.put_secret("m", "TOKEN", "after-rotation-0123456789", actor="a")
        self.assertEqual(self.rows("SELECT kek_id FROM secrets WHERE key='TOKEN'")[0][0], res.new_key_id)
        self.assertEqual(self.reveal("TOKEN"), "after-rotation-0123456789")

    def test_old_key_alone_and_new_key_alone(self) -> None:
        self.s.rotate_kek(actor="ops")
        new_id = self.s.key_id
        rp = keyfile.retired_path(self.kf, self.old_id)
        old_only = os.path.join(self.root, "old-only.key")
        shutil.copy(rp, old_only)
        os.chmod(old_only, 0o600)
        self.s.close()
        with self.assertRaises(WrongKeyError) as cm:
            Store.open(self.state, old_only)
        self.assertEqual((cm.exception.expected, cm.exception.found), (new_id, [self.old_id]))
        s = Store.open(self.state, self.kf)  # the new key alone is a complete, normal state
        self.addCleanup(s.close)
        self.assert_all_readable(s)

    def test_rotating_twice_chains_and_keeps_both_retired_keys(self) -> None:
        r1 = self.s.rotate_kek(actor="ops")
        r2 = self.s.rotate_kek(actor="ops")
        self.assertEqual(r2.old_key_id, r1.new_key_id)
        self.assert_all_readable()
        for kid in (self.old_id, r1.new_key_id):
            self.assertTrue(os.path.exists(keyfile.retired_path(self.kf, kid)))
        self.assertEqual(self.s.rotation_state, "none")
        self.assertTrue(self.s.verify_audit().ok)

    def test_finish_false_leaves_both_keys_until_finish_rotation(self) -> None:
        res = self.s.rotate_kek(actor="ops", finish=False)
        self.assertFalse(res.finished)
        self.assertEqual(self.s.rotation_state, "pending-finish")
        self.assertEqual(len(keyfile.load(self.kf).keys), 2)
        self.assert_all_readable()
        self.s.finish_rotation()
        self.assertEqual(self.s.rotation_state, "none")
        self.assertEqual(len(keyfile.load(self.kf).keys), 1)

    def test_finish_is_refused_while_rows_are_not_moved(self) -> None:
        self.s.rotation_hook = lambda step: (_ for _ in ()).throw(Crash()) if step == "keyfile" else None
        with self.assertRaises(Crash):
            self.s.rotate_kek(actor="ops")
        with self.assertRaises(RotationError):
            self.s.finish_rotation()
        self.assertEqual(len(keyfile.load(self.kf).keys), 2, "nothing may be retired before the rows moved")

    def test_a_rotation_audits_itself_with_counts_and_ids_only(self) -> None:
        res = self.s.rotate_kek(actor="ops", request_id="rot-1")
        row = self.rows("SELECT * FROM audit WHERE action='rotate-kek'")[0]
        self.assertEqual((row["actor"], row["request_id"]), ("ops", "rot-1"))
        self.assertIn(f"{self.old_id} -> {res.new_key_id}", row["detail"])
        self.assertIn("3 data key(s)", row["detail"])

    def test_a_tampered_row_blocks_rotation_and_changes_nothing(self) -> None:
        self.s._conn.execute("UPDATE secrets SET wrapped_dek=x'00' WHERE key='OTHER'")
        before = {r["key"]: r["kek_id"] for r in self.rows("SELECT key, kek_id FROM secrets")}
        with self.assertRaises(DecryptError):
            self.s.rotate_kek(actor="ops")
        self.assertEqual({r["key"]: r["kek_id"] for r in self.rows("SELECT key, kek_id FROM secrets")}, before)
        self.assertEqual(self.s.key_id, self.old_id)
        self.assertEqual(self.s.rotation_state, "pending-rewrap")
        self.assertEqual(self.reveal("TOKEN"), CANARY)

    def test_a_row_under_an_unknown_key_blocks_rotation(self) -> None:
        self.s._conn.execute("UPDATE secrets SET kek_id='deadbeefdeadbeef' WHERE key='OTHER'")
        with self.assertRaises(RotationError) as cm:
            self.s.rotate_kek(actor="ops")
        self.assertIn("deadbeefdeadbeef", str(cm.exception))
        self.assertIn("OTHER", str(cm.exception))

    def test_abort_before_the_rewrap_restores_the_old_key(self) -> None:
        self.s.rotation_hook = lambda step: (_ for _ in ()).throw(Crash()) if step == "keyfile" else None
        with self.assertRaises(Crash):
            self.s.rotate_kek(actor="ops")
        self.s.rotation_hook = None
        self.assertEqual(self.s.rotation_state, "pending-rewrap")
        self.s.abort_rotation()
        self.assertEqual(keyfile.load(self.kf).ids, (self.old_id,))
        self.assertEqual(self.s.rotation_state, "none")
        self.assert_all_readable()
        self.s.rotate_kek(actor="ops")  # and a fresh rotation still works
        self.assert_all_readable()

    def test_abort_is_refused_when_there_is_nothing_to_abort_or_it_is_too_late(self) -> None:
        with self.assertRaises(RotationError):
            self.s.abort_rotation()  # none
        self.s.rotate_kek(actor="ops", finish=False)
        with self.assertRaises(RotationError):
            self.s.abort_rotation()  # pending-finish: rows already moved

    def test_writes_during_an_open_rotation_stay_under_the_stores_key_and_are_swept_up(self) -> None:
        self.s.rotation_hook = lambda step: (_ for _ in ()).throw(Crash()) if step == "keyfile" else None
        with self.assertRaises(Crash):
            self.s.rotate_kek(actor="ops")
        self.s.rotation_hook = None
        self.s.put_secret("m", "TOKEN", "written-mid-rotation-0123", actor="a")
        self.assertEqual(self.rows("SELECT kek_id FROM secrets WHERE key='TOKEN'")[0][0], self.old_id)
        self.s.rotate_kek(actor="ops")
        self.assertEqual(self.reveal("TOKEN"), "written-mid-rotation-0123")
        self.assertEqual({r[0] for r in self.rows("SELECT kek_id FROM secrets")}, {self.s.key_id})

    def test_no_nonce_repeats_across_a_rotation(self) -> None:
        self.s.rotate_kek(actor="ops")
        self.s.rotate_deks(actor="ops")
        nonces = [bytes(x) for r in self.rows("SELECT nonce, wrap_nonce FROM secrets") for x in r]
        self.assertEqual(len(nonces), len(set(nonces)))

    # ---- crash injection ----------------------------------------------------
    def crash_at(self, step: str) -> None:
        def hook(s: str) -> None:
            if s == step:
                raise Crash(step)
        self.s.rotation_hook = hook
        with self.assertRaises(Crash):
            self.s.rotate_kek(actor="ops")
        self.s.close()

    def test_a_crash_at_every_step_resumes(self) -> None:
        for step, state in STEPS.items():
            with self.subTest(step):
                self.setUp()  # a fresh store per step
                self.crash_at(step)
                s = self.open()
                self.s = s
                self.assertEqual(s.rotation_state, state, f"restart after a crash at '{step}'")
                self.assert_all_readable(s)  # nothing lost, whichever key the rows are under
                self.assertTrue(s.verify_audit().ok)
                if step == "finish":
                    self.assertEqual(len(keyfile.load(self.kf).keys), 1)
                else:
                    res = s.rotate_kek(actor="ops")  # resumes (or, from 'none', rotates cleanly)
                    self.assertTrue(res.finished)
                    self.assertEqual(s.rotation_state, "none")
                    self.assertEqual(keyfile.load(self.kf).ids, (s.key_id,))
                    self.assertNotEqual(s.key_id, self.old_id)
                self.assert_all_readable(s)
                self.assertEqual({r[0] for r in self.rows("SELECT kek_id FROM secrets")}, {s.key_id})
                self.assertEqual({k: s.get_meta("m", k).fingerprint for k in VALUES}, self.fps)
                self.assertTrue(os.path.exists(keyfile.retired_path(self.kf, self.old_id)))
                self.assertTrue(s.verify_audit().ok)

    def test_a_crash_mid_transaction_leaves_every_row_under_the_old_key(self) -> None:
        for step in ("rewrap-midway", "rewrap-precommit"):
            with self.subTest(step):
                self.setUp()
                self.crash_at(step)
                s = self.open()
                self.s = s
                self.assertEqual({r[0] for r in self.rows("SELECT kek_id FROM secrets")}, {self.old_id})
                self.assertEqual(self.rows("SELECT v FROM meta WHERE k='kek_id'")[0][0].decode(), self.old_id)
                self.assertEqual(self.rows("SELECT count(*) FROM audit WHERE action='rotate-kek'")[0][0], 0)

    def test_a_crash_after_the_keyfile_step_can_be_aborted_instead(self) -> None:
        self.crash_at("keyfile")
        s = self.open()
        self.s = s
        s.abort_rotation()
        self.assertEqual(keyfile.load(self.kf).ids, (self.old_id,))
        self.assert_all_readable(s)

    def test_a_crash_between_the_retired_write_and_the_main_rewrite(self) -> None:
        # step 5's ordering: the retired file is on disk, the main file still lists both keys
        self.s.rotate_kek(actor="ops", finish=False)
        main = keyfile.load(self.kf)
        old_kid, old_key = main.keys[1]
        rp = keyfile.retired_path(self.kf, old_kid)
        with open(rp, "wb") as f:
            f.write(keyfile._serialize(keyfile.KeySet(((old_kid, old_key),))))
        os.chmod(rp, 0o600)
        s = self.reopen()
        self.assertEqual(s.rotation_state, "pending-finish")
        s.finish_rotation()
        self.assertEqual(s.rotation_state, "none")
        self.assert_all_readable(s)

    def kill_at(self, step: str) -> int:
        code = (
            "import os, sys\n"
            "sys.path.insert(0, sys.argv[1])\n"
            "from bothy_settings import Store\n"
            "s = Store.open(sys.argv[2], sys.argv[3])\n"
            "def hook(step):\n"
            "    if step == sys.argv[4]:\n"
            "        os._exit(9)\n"
            "s.rotation_hook = hook\n"
            "s.rotate_kek(actor='crashing-child')\n"
            "os._exit(0)\n"
        )
        self.s.close()
        p = subprocess.run([sys.executable, "-I", "-c", code, PKG, self.state, self.kf, step],
                           capture_output=True, timeout=60)
        self.assertEqual(p.returncode, 9, p.stderr.decode()[-500:])
        return p.returncode

    def test_a_real_process_kill_at_each_step_recovers(self) -> None:
        for step in ("backup", "keyfile", "rewrap-midway", "rewrap-precommit", "rewrap", "verify"):
            with self.subTest(step):
                self.setUp()
                self.kill_at(step)
                s = self.open()  # the dead child's flock is gone with it
                self.s = s
                self.assertEqual(s.rotation_state, STEPS[step])
                self.assert_all_readable(s)
                self.assertTrue(s.verify_audit().ok)
                s.rotate_kek(actor="ops")
                self.assertEqual(s.rotation_state, "none")
                self.assert_all_readable(s)
                self.assertEqual(self.rows("PRAGMA integrity_check")[0][0], "ok")


class DekRotation(StoreCase):
    def setUp(self) -> None:
        super().setUp()
        self.fill()

    def test_every_dek_and_nonce_changes_and_nothing_else(self) -> None:
        before = {r["key"]: dict(r) for r in self.rows("SELECT * FROM secrets")}
        self.assertEqual(self.s.rotate_deks(actor="ops"), 3)
        for r in self.rows("SELECT * FROM secrets"):
            b = before[r["key"]]
            for col in ("ciphertext", "nonce", "wrapped_dek", "wrap_nonce"):
                self.assertNotEqual(r[col], b[col], f"{r['key']}.{col} must change")
            for col in ("version", "fingerprint", "updated_at", "updated_by", "kek_id"):
                self.assertEqual(r[col], b[col], col)
        for k, v in VALUES.items():
            self.assertEqual(self.reveal(k), v)
        self.assertEqual(self.rows("SELECT detail FROM audit WHERE action='rotate-dek'")[0][0], "3 secret(s)")
        self.assertTrue(self.s.verify_audit().ok)

    def test_it_survives_a_reopen_and_a_second_run(self) -> None:
        self.s.rotate_deks(actor="ops")
        self.s.rotate_deks(actor="ops")
        s = self.reopen()
        self.assertEqual(self.reveal("OTHER", store=s), CANARY2)

    def test_a_tampered_row_aborts_the_whole_rotation_and_changes_nothing(self) -> None:
        self.s._conn.execute("UPDATE secrets SET ciphertext=x'00' WHERE key='OTHER'")
        before = [tuple(r) for r in self.rows("SELECT * FROM secrets ORDER BY key")]
        with self.assertRaises(DecryptError):
            self.s.rotate_deks(actor="ops")
        self.assertEqual([tuple(r) for r in self.rows("SELECT * FROM secrets ORDER BY key")], before)
        self.assertEqual(self.rows("SELECT count(*) FROM audit WHERE action='rotate-dek'")[0][0], 0)

    def test_an_empty_store_rotates_zero(self) -> None:
        for k in VALUES:
            self.s.delete("m", k, actor="a")
        self.assertEqual(self.s.rotate_deks(actor="ops"), 0)

    def test_a_crash_inside_the_transaction_changes_nothing(self) -> None:
        from unittest import mock
        before = [tuple(r) for r in self.rows("SELECT * FROM secrets ORDER BY key")]
        real = Store._open_row
        calls = {"n": 0}

        def flaky(self_, r):  # noqa: ANN001
            calls["n"] += 1
            if calls["n"] == 3:
                raise Crash("mid-rotation")
            return real(self_, r)
        with mock.patch.object(Store, "_open_row", flaky):
            with self.assertRaises(Crash):
                self.s.rotate_deks(actor="ops")
        self.assertEqual([tuple(r) for r in self.rows("SELECT * FROM secrets ORDER BY key")], before)


if __name__ == "__main__":
    unittest.main(verbosity=1)
