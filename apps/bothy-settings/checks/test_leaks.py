#!/usr/bin/env python3
"""A secret value (or the master key) never appears where it must not.

Run: python3 apps/bothy-settings/checks/test_leaks.py   (needs `cryptography`)

Record s16.1: "a secret value never appears in the DB, logs, exception messages or
audit rows". One long workout drives every public operation, including the refusal
paths, while capturing: all log records at DEBUG, every exception (str, repr and
the full formatted traceback, chained causes included), every audit row, every Meta
and result object's repr, and every file under the state dir (plus the backups). Each
captured stream is then searched for every canary in every plausible spelling, and
for the master key bytes.
"""

from __future__ import annotations

import io
import json
import logging
import os
import sqlite3
import traceback
import unittest

import helpers
from helpers import CANARY, CANARY2, CANARY3, StoreCase, tree_hits, variants
from bothy_settings import Store, keyfile, restore
from bothy_settings.errors import SettingsError

NEW = "replacement-canary-4e61b0d2-ROTATED-OUT"
GEN = "generated"


def spellings(values: list[str]) -> list[tuple[str, str, bytes]]:
    return [(v[:12], label, needle) for v in values for label, needle in variants(v) if needle]


class Leaks(StoreCase):
    def setUp(self) -> None:
        super().setUp()
        self.captured: dict[str, bytes] = {}
        self.stream = io.StringIO()
        h = logging.StreamHandler(self.stream)
        h.setLevel(logging.DEBUG)
        root = logging.getLogger()
        self._old_level = root.level
        root.setLevel(logging.DEBUG)
        root.addHandler(h)
        self.addCleanup(root.removeHandler, h)
        self.addCleanup(root.setLevel, self._old_level)
        self.errors: list[str] = []

    def attempt(self, fn, *a, **k):  # noqa: ANN001
        """Run something that is allowed to fail; record every textual form of the failure."""
        try:
            return fn(*a, **k)
        except Exception as e:  # noqa: BLE001
            self.errors.append(f"{e!s}\n{e!r}\n" + "".join(traceback.format_exception(e)))
            return None

    def workout(self) -> list[object]:
        s, objs = self.s, []
        objs.append(s.put_secret("m", "TOKEN", CANARY, actor="alice", request_id="r1"))
        objs.append(s.put_secret("m", "OTHER", CANARY2, actor="alice"))
        objs.append(s.put_secret("m", "THIRD", CANARY3, actor="alice"))
        objs.append(s.put_secret("m", "TOKEN", NEW, actor="alice"))
        objs.append(s.generate_secret("m", "OTHER", actor="alice"))
        objs.append(s.put_secret("m", "OTHER", CANARY2, actor="alice"))
        objs.append(s.put_value("m", "NAME", "bothy", actor="alice"))
        objs.extend(s.list_meta("m"))
        objs.append(s.get_meta("m", "TOKEN"))
        # the one internal read, and an export
        s.reveal_for_projection("m", "TOKEN", actor="projection")
        s.export_document(actor="ops")
        # refusals that handle a secret value
        self.attempt(s.put_secret, "m", "NAME", CANARY, actor="alice")        # a non-secret field
        self.attempt(s.put_value, "m", "TOKEN", CANARY, actor="alice")        # a secret field via the plain path
        self.attempt(s.put_secret, "m", "NOT_REGISTERED", CANARY, actor="alice")
        self.attempt(s.put_secret, "m", "TOKEN", CANARY, actor="bad actor " + CANARY)
        self.attempt(s.put_secret, "m", "TOKEN", CANARY, actor="alice", if_version=999)
        self.attempt(s.put_secret, "m", "TOKEN", "x" * 20000 + CANARY, actor="alice")
        self.attempt(s.put_secret, "m", "TOKEN", None, actor="alice")
        self.attempt(s.get_setting, "m", "TOKEN")                             # reading a secret as a setting
        # rotations and a backup
        objs.append(s.rotate_deks(actor="ops"))
        objs.append(s.rotate_kek(actor="ops"))
        objs.append(s.backup(os.path.join(self.root, "bk.db")))
        objs.append(s.verify_audit())
        objs.append(s.verify_encrypted_at_rest())
        # tampering and the refusals it causes
        s._conn.execute("UPDATE secrets SET ciphertext=x'00' WHERE key='THIRD'")
        self.attempt(s.reveal_for_projection, "m", "THIRD", actor="projection")
        self.attempt(s.export_document, actor="ops")
        self.attempt(s.rotate_deks, actor="ops")
        self.attempt(s.verify_encrypted_at_rest)
        s._conn.execute("UPDATE secrets SET ciphertext=x'00' WHERE key='THIRD'")  # (idempotent)
        s.close()
        # open refusals: wrong key, tampered key_check
        os.rename(self.kf, self.kf + ".real")
        other = keyfile.create(self.kf)
        self.attempt(Store.open, self.state, self.kf)
        os.unlink(self.kf)
        os.rename(self.kf + ".real", self.kf)
        # restore refusals (wrong key; tampered backup)
        bk = os.path.join(self.root, "bk.db")
        c = sqlite3.connect(bk)
        c.execute("UPDATE secrets SET wrapped_dek=x'00' WHERE key='OTHER'")
        c.commit()
        c.close()
        self.attempt(restore, self.state, self.kf, bk, actor="cli:ops")
        self.s = self.open()
        self.other_key = other
        return objs

    def streams(self, objs: list[object]) -> dict[str, bytes]:
        out = {
            "log records": self.stream.getvalue().encode(),
            "exception texts": "\n".join(self.errors).encode(),
            "object reprs": "\n".join(repr(o) + str(o) for o in objs).encode(),
        }
        # Audit rows, the way a caller or a log shipper sees them: every column.
        s = self.s
        out["audit rows"] = json.dumps(s.read_audit(limit=1000), default=str, ensure_ascii=False).encode()
        out["audit rows (raw sqlite)"] = json.dumps(
            [list(map(str, r)) for r in s._conn.execute("SELECT * FROM audit")], ensure_ascii=False).encode()
        out["settings + fields tables"] = json.dumps(
            [list(map(str, r)) for t in ("settings", "fields") for r in s._conn.execute(f"SELECT * FROM {t}")],
            ensure_ascii=False).encode()
        return out

    def test_no_value_and_no_key_in_logs_exceptions_audit_reprs_or_files(self) -> None:
        objs = self.workout()
        needles = spellings([CANARY, CANARY2, CANARY3, NEW])
        ks = keyfile.load(self.kf)
        key_needles = [(kid[:8], "key", k) for kid, k in ks.keys]
        key_needles += [("old", "key", k) for _id, k in self.other_key.keys]
        for name, data in self.streams(objs).items():
            for tag, label, needle in needles + key_needles:
                self.assertNotIn(needle, data, f"{tag}... ({label}) found in {name}")
            self.assertTrue(data, f"{name} captured nothing: the check would pass vacuously")
        self.assertGreater(len(self.errors), 8, "the refusal paths ran")

    def test_no_value_in_any_file_of_the_state_dir_or_the_backups(self) -> None:
        self.workout()
        self.s.close()
        for t in (self.state, os.path.join(self.root, "bk.db")):
            root = t if os.path.isdir(t) else os.path.dirname(t)
            hits = tree_hits(root, [CANARY, CANARY2, CANARY3, NEW])
            self.assertEqual(hits, [], f"plaintext found under {root}")
        # the master key is not in the database either (only a key_check built FROM it)
        for kid, k in keyfile.load(self.kf).keys:
            self.assertEqual(tree_hits_bytes(self.state, k), [])

    def test_the_log_stream_is_json_lines_naming_no_value(self) -> None:
        self.workout()
        lines = [ln for ln in self.stream.getvalue().splitlines() if ln.startswith("{")]
        self.assertTrue(lines, "audit log lines were emitted")
        for ln in lines:
            rec = json.loads(ln)
            self.assertNotIn("value", rec)
            self.assertNotIn("plaintext", rec)

    def test_log_lines_appear_only_after_commit(self) -> None:
        before = self.stream.getvalue().count('"action": "set"')
        # a rolled-back transaction must not have logged
        self.attempt(self.s.put_secret, "m", "TOKEN", CANARY, actor="alice", if_version=42)
        self.assertEqual(self.stream.getvalue().count('"action": "set"'), before)
        self.s.put_secret("m", "TOKEN", CANARY, actor="alice")
        self.assertEqual(self.stream.getvalue().count('"action": "set"'), before + 1)

    def test_a_rolled_back_change_leaves_no_log_line_now_or_with_the_next_commit(self) -> None:
        marker = "never-committed-marker"
        with self.assertRaises(helpers.Crash):
            with self.s._tx():
                self.s._audit("set", actor="alice", surface="cli", module="m", key="TOKEN", detail=marker)
                raise helpers.Crash()
        self.assertNotIn(marker, self.stream.getvalue())
        self.s.put_value("m", "NAME", "next", actor="alice")  # an unrelated, committed change
        self.assertNotIn(marker, self.stream.getvalue(), "a rolled-back line must not ride out with the next commit")
        self.assertNotIn(marker, json.dumps(self.s.read_audit(limit=1000)))

    def test_a_leak_would_be_caught(self) -> None:
        # the scanner itself can fail: plant a value and look for it
        self.s.close()
        with open(os.path.join(self.state, "stray.txt"), "wb") as f:
            f.write(b"prefix " + CANARY.encode("utf-16-le") + b" suffix")
        self.assertTrue(tree_hits(self.state, [CANARY]))
        os.unlink(os.path.join(self.state, "stray.txt"))
        self.s = self.open()
        self.errors.append(f"oops {CANARY}")
        self.assertIn(CANARY.encode(), "\n".join(self.errors).encode())


def tree_hits_bytes(root: str, needle: bytes) -> list[str]:
    hits = []
    for dirpath, _d, files in os.walk(root):
        for fn in files:
            p = os.path.join(dirpath, fn)
            with open(p, "rb") as f:
                if needle in f.read():
                    hits.append(os.path.relpath(p, root))
    return hits


if __name__ == "__main__":
    unittest.main(verbosity=1)
