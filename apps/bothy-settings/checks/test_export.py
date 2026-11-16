#!/usr/bin/env python3
"""Export document, import, and the age bundle.

Run: python3 apps/bothy-settings/checks/test_export.py   (needs `cryptography`)

The age tests need the real `age` and `age-keygen` binaries (BOTHY_AGE_BIN, or on
PATH). Without them they SKIP, and say so: the encrypt half is a thin wrapper over
the binary, so a fake would prove nothing about the bundle. The argv/env test uses
a stub on purpose, because what it checks is what WE pass, not what age does.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest

import helpers
from helpers import CANARY, CANARY2, CANARY3, StoreCase, tree_hits
from bothy_settings import Store, bootstrap
from bothy_settings.errors import ImportRefused
from bothy_settings.export import ExportError, age_encrypt, find_age

AGE = find_age()
KEYGEN = (os.path.join(os.path.dirname(AGE), "age-keygen") if AGE and os.path.dirname(AGE) else None) or shutil.which("age-keygen")
if KEYGEN and not os.path.exists(KEYGEN):
    KEYGEN = shutil.which("age-keygen")
HAVE_AGE = bool(AGE and KEYGEN and os.path.exists(AGE))

VALUES = {"TOKEN": CANARY, "OTHER": CANARY2, "THIRD": CANARY3}


class Document(StoreCase):
    def setUp(self) -> None:
        super().setUp()
        self.fill()

    def other_store(self) -> Store:
        root = tempfile.mkdtemp(prefix="bothy-settings-b-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        st, kf = os.path.join(root, "state"), os.path.join(root, "k", "master.key")
        bootstrap(st, kf)
        s = self.open(st, kf)
        s.register_fields("m", self.FIELDS, actor="test")
        return s

    def test_export_holds_everything_and_is_audited_with_a_count(self) -> None:
        doc = self.s.export_document(actor="ops", bothy_version="9.9")
        self.assertEqual(doc["bothy_version"], "9.9")
        (mod,) = doc["modules"]
        self.assertEqual(mod["secrets"], VALUES)
        self.assertEqual(mod["settings"], {"NAME": "bothy"})
        row = [r for r in self.s.read_audit() if r["action"] == "export"][-1]
        self.assertEqual((row["actor"], row["detail"]), ("ops", "4 value(s)"))
        self.assertNotIn(CANARY, json.dumps(self.s.read_audit()))

    def test_round_trip_into_a_store_with_a_different_key(self) -> None:
        doc = self.s.export_document(actor="ops")
        s2 = self.other_store()
        self.assertEqual(s2.import_document(doc, actor="ops"), 4)
        for k, v in VALUES.items():
            self.assertEqual(self.reveal(k, store=s2), v)
        self.assertEqual(s2.get_setting("m", "NAME"), "bothy")
        self.assertTrue(s2.verify_audit().ok)
        self.assertEqual(tree_hits(os.path.dirname(s2._db), list(VALUES.values())), [])

    def test_import_into_a_non_empty_store_is_refused_unless_merge(self) -> None:
        doc = self.s.export_document(actor="ops")
        s2 = self.other_store()
        s2.put_secret("m", "TOKEN", "pre-existing-value-0123456789", actor="a")
        with self.assertRaises(ImportRefused):
            s2.import_document(doc, actor="ops")
        self.assertEqual(self.reveal("TOKEN", store=s2), "pre-existing-value-0123456789")
        s2.import_document(doc, actor="ops", merge=True)
        self.assertEqual(self.reveal("TOKEN", store=s2), CANARY)

    def test_an_unknown_field_or_a_classification_mismatch_refuses_the_whole_document(self) -> None:
        doc = self.s.export_document(actor="ops")
        s2 = self.other_store()
        bad = json.loads(json.dumps(doc))
        bad["modules"][0]["secrets"]["NOT_REGISTERED"] = "x" * 20
        with self.assertRaises(ImportRefused):
            s2.import_document(bad, actor="ops")
        flip = json.loads(json.dumps(doc))
        flip["modules"][0]["settings"]["TOKEN"] = flip["modules"][0]["secrets"].pop("TOKEN")
        with self.assertRaises(ImportRefused):
            s2.import_document(flip, actor="ops")
        self.assertFalse(s2.get_meta("m", "OTHER").set, "a refused import writes nothing")

    def test_a_malformed_document_is_refused(self) -> None:
        s2 = self.other_store()
        doc = self.s.export_document(actor="ops")
        cases = {
            "extra top-level key": {**doc, "extra": 1},
            "wrong format": {**doc, "format": "nope"},
            "modules not a list": {**doc, "modules": {}},
            "extra module key": {**doc, "modules": [{**doc["modules"][0], "x": 1}]},
            "not a mapping": [],
        }
        for name, d in cases.items():
            with self.subTest(name), self.assertRaises(ImportRefused):
                s2.import_document(d, actor="ops")

    def test_a_refusal_does_not_echo_a_value(self) -> None:
        s2 = self.other_store()
        doc = self.s.export_document(actor="ops")
        doc["modules"][0]["secrets"]["NOT_REGISTERED"] = CANARY
        with self.assertRaises(ImportRefused) as cm:
            s2.import_document(doc, actor="ops")
        self.assertNotIn(CANARY, str(cm.exception))


class Age(StoreCase):
    def setUp(self) -> None:
        super().setUp()
        self.fill()

    def keypair(self) -> tuple[str, str]:
        ident = os.path.join(self.root, "age.key")
        out = subprocess.run([KEYGEN, "-o", ident], capture_output=True, check=True).stderr.decode()
        recipient = out.split("Public key:")[1].split()[0]
        return recipient, ident

    @unittest.skipUnless(HAVE_AGE, "no age/age-keygen binary (set BOTHY_AGE_BIN): the real-age round trip is NOT run")
    def test_bundle_round_trips_with_the_real_binary_and_leaks_nothing(self) -> None:
        recipient, ident = self.keypair()
        doc = self.s.export_document(actor="ops")
        dest = os.path.join(self.root, "bundle.age")
        n = age_encrypt(doc, recipient, dest)
        self.assertEqual(n, os.path.getsize(dest))
        self.assertEqual(stat.S_IMODE(os.stat(dest).st_mode), 0o600)
        with open(dest, "rb") as f:
            blob = f.read()
        for v in VALUES.values():
            self.assertNotIn(v.encode(), blob)
        self.assertEqual(sorted(os.listdir(self.root)).count("bundle.age"), 1)
        self.assertEqual([f for f in os.listdir(self.root) if ".tmp." in f], [])
        plain = subprocess.run([AGE, "-d", "-i", ident, dest], capture_output=True, check=True).stdout
        self.assertEqual(json.loads(plain), doc)

    @unittest.skipUnless(HAVE_AGE, "no age binary")
    def test_the_wrong_identity_cannot_open_it(self) -> None:
        recipient, _ = self.keypair()
        dest = os.path.join(self.root, "bundle.age")
        age_encrypt(self.s.export_document(actor="ops"), recipient, dest)
        other = os.path.join(self.root, "other.key")
        subprocess.run([KEYGEN, "-o", other], capture_output=True, check=True)
        p = subprocess.run([AGE, "-d", "-i", other, dest], capture_output=True)
        self.assertNotEqual(p.returncode, 0)

    @unittest.skipUnless(HAVE_AGE, "no age binary")
    def test_a_bundle_is_never_overwritten_and_a_bad_recipient_leaves_nothing(self) -> None:
        recipient, _ = self.keypair()
        doc = self.s.export_document(actor="ops")
        dest = os.path.join(self.root, "bundle.age")
        age_encrypt(doc, recipient, dest)
        with self.assertRaises(ExportError):
            age_encrypt(doc, recipient, dest)
        bad = os.path.join(self.root, "bad.age")
        with self.assertRaises(ExportError):
            age_encrypt(doc, "age1" + "q" * 40, bad)
        self.assertFalse(os.path.exists(bad))

    def test_recipient_shape_is_checked_before_anything_runs(self) -> None:
        doc = {"x": 1}
        for r in ("", "ssh-ed25519 AAAA", "age1", "age1;rm -rf /", None, "-p"):
            with self.subTest(r), self.assertRaises(ExportError):
                age_encrypt(doc, r, os.path.join(self.root, "x.age"))  # type: ignore[arg-type]

    def test_a_missing_binary_is_a_named_error(self) -> None:
        with self.assertRaises(ExportError) as cm:
            age_encrypt({"x": 1}, "age1" + "q" * 58, os.path.join(self.root, "x.age"),
                        age_bin=os.path.join(self.root, "no-such-age"))
        self.assertIn("failed", str(cm.exception))

    def test_plaintext_goes_to_stdin_only_never_argv_or_env(self) -> None:
        log = os.path.join(self.root, "stub.log")
        stub = os.path.join(self.root, "age-stub")
        with open(stub, "w") as f:
            f.write("#!/bin/sh\n"
                    f"printf '%s\\n' \"$@\" > {log}.argv\n"
                    f"env > {log}.env\n"
                    f"cat > {log}.stdin\n"
                    "printf 'ciphertext-stand-in'\n")
        os.chmod(stub, 0o700)
        os.environ["BOTHY_TEST_SECRET_IN_ENV"] = "inherited-secret-must-not-reach-child"
        self.addCleanup(os.environ.pop, "BOTHY_TEST_SECRET_IN_ENV", None)
        doc = self.s.export_document(actor="ops")
        dest = os.path.join(self.root, "b.age")
        age_encrypt(doc, "age1" + "q" * 58, dest, age_bin=stub)
        with open(log + ".argv") as f:
            argv = f.read()
        with open(log + ".env") as f:
            env = f.read()
        with open(log + ".stdin", "rb") as f:
            stdin = f.read()
        for v in VALUES.values():
            self.assertNotIn(v, argv)
            self.assertNotIn(v, env)
        self.assertNotIn("inherited-secret", env)
        self.assertEqual(argv.split(), ["-r", "age1" + "q" * 58])
        self.assertEqual(json.loads(stdin), doc)
        with open(dest, "rb") as f:
            self.assertEqual(f.read(), b"ciphertext-stand-in")

    def test_a_failing_age_leaves_no_file_and_does_not_echo_the_plaintext(self) -> None:
        stub = os.path.join(self.root, "age-fail")
        with open(stub, "w") as f:
            f.write("#!/bin/sh\ncat >/dev/null\necho 'age: boom' >&2\nexit 1\n")
        os.chmod(stub, 0o700)
        dest = os.path.join(self.root, "b.age")
        with self.assertRaises(ExportError) as cm:
            age_encrypt(self.s.export_document(actor="ops"), "age1" + "q" * 58, dest, age_bin=stub)
        self.assertIn("boom", str(cm.exception))
        self.assertFalse(os.path.exists(dest))
        self.assertEqual([f for f in os.listdir(self.root) if ".tmp." in f], [])
        self.assertNotIn(CANARY, str(cm.exception))


if __name__ == "__main__":
    unittest.main(verbosity=1)
