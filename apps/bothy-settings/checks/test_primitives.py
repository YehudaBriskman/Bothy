#!/usr/bin/env python3
"""crypto.py, keyfile.py, fscheck.py and names.py as pure units.

Run: python3 apps/bothy-settings/checks/test_primitives.py   (needs `cryptography`)

Record s16 items 1 (the primitive half) and 2 (nonce uniqueness), plus every way
the key file can be wrong.
"""

from __future__ import annotations

import base64
import os
import shutil
import stat
import tempfile
import unittest
from unittest import mock

import helpers  # noqa: F401  (puts the package on sys.path)
from bothy_settings import crypto, fscheck, keyfile, names
from bothy_settings.errors import (
    KeyFileError, KeyFileModeError, KeyMissingError, NonceReuseError,
    UnsupportedFilesystemError, ValidationError,
)


class Crypto(unittest.TestCase):
    def test_round_trip_and_aad_binding(self) -> None:
        k = crypto.new_key()
        aad = crypto.aad_value(b"S" * 16, "m", "K")
        n, ct = crypto.seal(k, b"value", aad)
        self.assertEqual(crypto.open_(k, n, ct, aad), b"value")
        self.assertEqual(len(ct), len(b"value") + 16)  # 128-bit tag
        self.assertEqual(len(n), 12)

    def test_every_part_of_the_aad_matters(self) -> None:
        k = crypto.new_key()
        n, ct = crypto.seal(k, b"v", crypto.aad_value(b"S" * 16, "m", "K"))
        for label, aad in (("store_id", crypto.aad_value(b"T" * 16, "m", "K")),
                           ("module", crypto.aad_value(b"S" * 16, "x", "K")),
                           ("key", crypto.aad_value(b"S" * 16, "m", "L")),
                           ("wrap, not value", crypto.aad_wrap(b"S" * 16, "m", "K", "id")),
                           ("empty", b"")):
            with self.subTest(label), self.assertRaises(crypto.AuthFailure):
                crypto.open_(k, n, ct, aad)

    def test_wrap_aad_binds_the_key_id(self) -> None:
        k = crypto.new_key()
        n, ct = crypto.seal(k, b"d" * 32, crypto.aad_wrap(b"S" * 16, "m", "K", "aaaa"))
        with self.assertRaises(crypto.AuthFailure):
            crypto.open_(k, n, ct, crypto.aad_wrap(b"S" * 16, "m", "K", "bbbb"))

    def test_aad_encoding_is_unambiguous(self) -> None:
        # module/key boundary cannot be shifted: names exclude 0x00, the separator.
        a = crypto.aad_value(b"S" * 16, "ab", "c")
        b = crypto.aad_value(b"S" * 16, "a", "bc")
        self.assertNotEqual(a, b)

    def test_tampered_ciphertext_nonce_and_wrong_key_fail(self) -> None:
        k, aad = crypto.new_key(), b"aad"
        n, ct = crypto.seal(k, b"value", aad)
        flipped = bytes([ct[0] ^ 1]) + ct[1:]
        for label, args in (("ciphertext", (k, n, flipped, aad)),
                            ("tag", (k, n, ct[:-1] + bytes([ct[-1] ^ 1]), aad)),
                            ("nonce", (k, bytes([n[0] ^ 1]) + n[1:], ct, aad)),
                            ("wrong key", (crypto.new_key(), n, ct, aad)),
                            ("truncated", (k, n, ct[:-1], aad)),
                            ("short nonce", (k, n[:8], ct, aad)),
                            ("long nonce", (k, n + b"\0", ct, aad)),
                            ("no tag at all", (k, n, b"", aad))):
            with self.subTest(label), self.assertRaises(crypto.AuthFailure):
                crypto.open_(*args)

    def test_a_short_key_is_refused_not_padded(self) -> None:
        with self.assertRaises(ValueError):
            crypto.seal(b"k" * 16, b"v", b"")

    def test_fingerprint_is_keyed_stable_and_value_sensitive(self) -> None:
        fk = crypto.new_key()
        f1 = crypto.fingerprint(fk, "m", "K", b"v")
        self.assertEqual(f1, crypto.fingerprint(fk, "m", "K", b"v"))
        self.assertEqual(len(f1), 8)
        self.assertNotEqual(f1, crypto.fingerprint(fk, "m", "K", b"w"))
        self.assertNotEqual(f1, crypto.fingerprint(crypto.new_key(), "m", "K", b"v"))
        self.assertNotEqual(f1, crypto.fingerprint(fk, "m", "L", b"v"))

    def test_open_refuses_any_stored_nonce_that_is_not_12_bytes(self) -> None:
        # AESGCM itself takes 8..128 bytes and raises ValueError outside that, so a missing length
        # check does not show up as a failed decrypt for 8..11 or 13..128 (they fail the tag anyway);
        # it shows up as a ValueError, or an exception of the wrong type, for the rest. A tampered
        # row must always be an AuthFailure.
        k, aad = crypto.new_key(), b"aad"
        n, ct = crypto.seal(k, b"value", aad)
        for length in (0, 1, 4, 7, 8, 11, 13, 16, 128, 129, 200):
            with self.subTest(length):
                with self.assertRaises(crypto.AuthFailure):
                    crypto.open_(k, (n * 20)[:length], ct, aad)

    def test_the_guard_refuses_a_repeated_nonce_from_a_patched_source(self) -> None:
        # The guard is what stands between a broken random source and GCM nonce reuse. Feed it a
        # source that repeats on its 3rd draw: the first two seal, the 3rd must refuse, and the
        # refusal must come from the guard, not from the source.
        seq = iter([b"\x01" * 12, b"\x02" * 12, b"\x01" * 12, b"\x03" * 12])
        with mock.patch.object(crypto, "_random", lambda n: next(seq)):
            k = crypto.new_key()
            n1, _ = crypto.seal(k, b"a", b"")
            n2, _ = crypto.seal(k, b"b", b"")
            self.assertNotEqual(n1, n2)
            with self.assertRaises(NonceReuseError) as cm:
                crypto.seal(k, b"c", b"")
            self.assertIn("repeated", str(cm.exception))
            crypto.seal(k, b"d", b"")  # a refusal does not poison the guard: the next fresh nonce works

    def test_a_refused_nonce_never_encrypts(self) -> None:
        with mock.patch.object(crypto, "_random", lambda n: b"\x07" * n):
            crypto.seal(crypto.new_key(), b"first", b"")
            sealed = []
            with mock.patch.object(crypto, "AESGCM", side_effect=lambda *a: sealed.append(1)):
                with self.assertRaises(NonceReuseError):
                    crypto.seal(crypto.new_key(), b"second", b"")
            self.assertEqual(sealed, [], "the cipher must not even be constructed after a refused nonce")

    def test_a_constant_nonce_source_is_caught(self) -> None:
        # record s16.2: the bug class is a code path that reuses a nonce.
        with mock.patch.object(crypto, "_random", lambda n: b"\x00" * n):
            crypto.seal(crypto.new_key(), b"first", b"")
            with self.assertRaises(NonceReuseError):
                crypto.seal(crypto.new_key(), b"second", b"")

    def test_a_wrong_length_nonce_source_is_caught(self) -> None:
        with mock.patch.object(crypto, "_random", lambda n: b"\x01" * 8):
            with self.assertRaises(NonceReuseError):
                crypto.seal(crypto.new_key(), b"x", b"")

    def test_the_guard_forgets_only_old_nonces(self) -> None:
        g = crypto._NonceGuard(cap=10)
        seq = iter(bytes([i]) * 12 for i in range(1000))
        with mock.patch.object(crypto, "_random", lambda n: next(seq)):
            for _ in range(50):
                g.fresh()
        self.assertLessEqual(len(g._seen), 10)
        self.assertEqual(len(g._seen), len(g._order))


class KeyFile(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="bothy-keyfile-")
        os.chmod(self.dir, 0o700)
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.path = os.path.join(self.dir, "master.key")

    def read(self) -> bytes:
        with open(self.path, "rb") as f:
            return f.read()

    def write(self, text: str, mode: int = 0o600) -> None:
        with open(self.path, "w") as f:
            f.write(text)
        os.chmod(self.path, mode)

    def test_create_is_0600_in_a_0700_directory_and_loads(self) -> None:
        p = os.path.join(self.dir, "new", "master.key")
        ks = keyfile.create(p)
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(p)).st_mode), 0o700)
        self.assertEqual(keyfile.load(p).keys, ks.keys)
        self.assertEqual(len(ks.active), 32)
        self.assertEqual(ks.active_id, keyfile.key_id_of(ks.active))
        self.assertEqual(os.listdir(os.path.dirname(p)), ["master.key"])  # no temp left behind

    def test_the_installers_golden_key_file_loads(self) -> None:
        """data-and-state.md R2/DS7: the file `bothy install` writes is this reader's format.
        The golden is shared with the Go installer's test (cli/internal/install), which
        reproduces it byte for byte; here the real reader loads it."""
        golden = os.path.join(helpers.HERE, "..", "..", "..", "cli", "internal", "install",
                              "testdata", "master.key.golden")
        with open(golden, "rb") as f:
            data = f.read()
        with open(self.path, "wb") as f:
            f.write(data)
        os.chmod(self.path, 0o600)
        ks = keyfile.load(self.path)
        self.assertEqual(ks.active, bytes(range(32)))
        self.assertEqual(ks.active_id, "630dcd2966c43366")
        self.assertEqual(keyfile._serialize(ks), data)

    def test_never_overwrites_even_if_asked_twice(self) -> None:
        keyfile.create(self.path)
        before = self.read()
        with self.assertRaises(KeyFileError):
            keyfile.create(self.path)
        self.assertEqual(self.read(), before)
        self.assertEqual(os.listdir(self.dir), ["master.key"])

    def test_never_overwrites_a_symlink_or_garbage_either(self) -> None:
        os.symlink("/nonexistent", self.path)
        with self.assertRaises(KeyFileError):
            keyfile.create(self.path)
        os.unlink(self.path)
        self.write("junk")
        with self.assertRaises(KeyFileError):
            keyfile.create(self.path)
        self.assertEqual(self.read(), b"junk")

    def test_missing_names_the_path_and_the_orphan_count(self) -> None:
        with self.assertRaises(KeyMissingError) as cm:
            keyfile.load(self.path, orphans=7)
        msg = str(cm.exception)
        self.assertIn(self.path, msg)
        self.assertIn("orphans 7", msg)
        self.assertIn("Do not generate a new one", msg)

    def test_wrong_mode_is_refused_and_never_repaired(self) -> None:
        keyfile.create(self.path)
        for mode in (0o640, 0o644, 0o604, 0o660, 0o666, 0o601, 0o677):
            with self.subTest(oct(mode)):
                os.chmod(self.path, mode)
                with self.assertRaises(KeyFileModeError) as cm:
                    keyfile.load(self.path)
                self.assertIn("0600", str(cm.exception))
                self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), mode, "must not chmod it for them")
        os.chmod(self.path, 0o400)  # read-only owner is fine
        keyfile.load(self.path)

    def test_a_symlink_is_refused(self) -> None:
        keyfile.create(self.path)
        link = os.path.join(self.dir, "link.key")
        os.symlink(self.path, link)
        with self.assertRaises(KeyFileModeError):
            keyfile.load(link)

    def test_not_a_regular_file_is_refused(self) -> None:
        os.mkfifo(self.path, 0o600)
        # O_NONBLOCK is not used by load(); a FIFO open for read would block, so a
        # directory stands in for "not a regular file".
        os.unlink(self.path)
        os.mkdir(self.path, 0o700)
        with self.assertRaises(KeyFileError):
            keyfile.load(self.path)

    def test_a_file_owned_by_someone_else_is_refused(self) -> None:
        keyfile.create(self.path)
        with mock.patch("os.geteuid", return_value=os.geteuid() + 1):
            with self.assertRaises(KeyFileModeError):
                keyfile.load(self.path)

    def test_a_key_directory_with_any_group_or_other_access_is_refused(self) -> None:
        # record s6.1: "the directory 0700". Readable and searchable count, not only writable.
        keyfile.create(self.path)
        for mode in (0o770, 0o707, 0o777, 0o750, 0o705, 0o710, 0o701, 0o1777):
            with self.subTest(oct(mode)):
                os.chmod(self.dir, mode)
                with self.assertRaises(KeyFileModeError) as cm:
                    keyfile.load(self.path)
                self.assertIn("0700", str(cm.exception))
        os.chmod(self.dir, 0o700)
        keyfile.load(self.path)

    def test_a_key_directory_owned_by_someone_else_is_refused(self) -> None:
        keyfile.create(self.path)
        real = os.stat(self.dir)

        class Other:  # the directory stat as another uid would own it; the FILE keeps its real uid
            st_uid = real.st_uid + 1
            st_mode = real.st_mode

        orig = os.stat
        with mock.patch("bothy_settings.keyfile.os.stat", lambda p, *a, **k: Other if p == self.dir else orig(p, *a, **k)):
            with self.assertRaises(KeyFileModeError) as cm:
                keyfile.load(self.path)
        self.assertIn("owned by uid", str(cm.exception))

    def test_a_key_file_with_a_second_hard_link_is_refused(self) -> None:
        keyfile.create(self.path)
        other = os.path.join(self.dir, "elsewhere")
        os.link(self.path, other)
        with self.assertRaises(KeyFileModeError) as cm:
            keyfile.load(self.path)
        self.assertIn("hard link", str(cm.exception))
        os.unlink(other)
        keyfile.load(self.path)

    def test_malformed_files_are_refused(self) -> None:
        good = base64.b64encode(b"k" * 32).decode()
        kid = keyfile.key_id_of(b"k" * 32)
        cases = {
            "no header": f"{kid} {good}\n",
            "wrong version": f"bothy-master-key v2\n{kid} {good}\n",
            "no keys": f"{keyfile.HEADER}\n",
            "empty": "",
            "one field": f"{keyfile.HEADER}\n{kid}\n",
            "three fields": f"{keyfile.HEADER}\n{kid} {good} extra\n",
            "bad base64": f"{keyfile.HEADER}\n{kid} !!!!\n",
            "short key": f"{keyfile.HEADER}\n{keyfile.key_id_of(b'k' * 16)} {base64.b64encode(b'k' * 16).decode()}\n",
            "key_id does not match": f"{keyfile.HEADER}\n{'0' * 16} {good}\n",
            "duplicate id": f"{keyfile.HEADER}\n{kid} {good}\n{kid} {good}\n",
        }
        for label, text in cases.items():
            with self.subTest(label):
                self.write(text)
                with self.assertRaises(KeyFileError):
                    keyfile.load(self.path)

    def test_non_ascii_and_oversized_files_are_refused(self) -> None:
        with open(self.path, "wb") as f:
            f.write(b"bothy-master-key v1\n\xff\xfe\n")
        os.chmod(self.path, 0o600)
        with self.assertRaises(KeyFileError):
            keyfile.load(self.path)
        with open(self.path, "wb") as f:
            f.write(b"x" * (70 * 1024))
        with self.assertRaises(KeyFileError):
            keyfile.load(self.path)

    def test_repr_and_errors_never_carry_key_material(self) -> None:
        ks = keyfile.create(self.path)
        b64 = base64.b64encode(ks.active).decode()
        self.assertNotIn(b64, repr(ks))
        self.assertNotIn(ks.active.hex(), repr(ks))
        self.assertIn(ks.active_id, repr(ks))
        self.write(f"{keyfile.HEADER}\n{'0' * 16} {b64}\n")
        with self.assertRaises(KeyFileError) as cm:
            keyfile.load(self.path)
        self.assertNotIn(b64, str(cm.exception))

    def test_append_keeps_the_old_key_and_makes_the_new_one_active(self) -> None:
        old = keyfile.create(self.path)
        new = keyfile.append_active(self.path)
        self.assertEqual(new.ids[1], old.active_id)
        self.assertNotEqual(new.active_id, old.active_id)
        self.assertEqual(keyfile.load(self.path).keys, new.keys)
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)

    def test_retire_writes_the_retired_file_first_and_is_idempotent(self) -> None:
        old = keyfile.create(self.path)
        new = keyfile.append_active(self.path)
        moved = keyfile.retire_inactive(self.path)
        rp = keyfile.retired_path(self.path, old.active_id)
        self.assertEqual(moved, [rp])
        self.assertEqual(stat.S_IMODE(os.stat(rp).st_mode), 0o600)
        self.assertEqual(keyfile.load(rp).active, old.active)
        self.assertEqual(keyfile.load(self.path).keys, new.keys[:1])
        self.assertEqual(keyfile.retire_inactive(self.path), [])  # nothing left to move

    def test_retire_after_a_crash_between_its_two_writes(self) -> None:
        # the retired file already exists, the main file still lists both keys
        old = keyfile.create(self.path)
        keyfile.append_active(self.path)
        with open(keyfile.retired_path(self.path, old.active_id), "wb") as f:
            f.write(keyfile._serialize(old))
        os.chmod(keyfile.retired_path(self.path, old.active_id), 0o600)
        keyfile.retire_inactive(self.path)
        self.assertEqual(len(keyfile.load(self.path).keys), 1)

    def test_retire_refuses_to_trust_a_different_file_of_that_name(self) -> None:
        old = keyfile.create(self.path)
        keyfile.append_active(self.path)
        other = keyfile.create(os.path.join(self.dir, "other.key"))
        os.rename(os.path.join(self.dir, "other.key"), keyfile.retired_path(self.path, old.active_id))
        self.assertNotEqual(other.active, old.active)
        with self.assertRaises(KeyFileError):
            keyfile.retire_inactive(self.path)
        self.assertEqual(len(keyfile.load(self.path).keys), 2, "the main file must be left alone")

    def test_drop_active_and_unretire(self) -> None:
        old = keyfile.create(self.path)
        keyfile.append_active(self.path)
        self.assertEqual(keyfile.drop_active(self.path).keys, old.keys)
        with self.assertRaises(KeyFileError):
            keyfile.drop_active(self.path)  # nothing to abort
        keyfile.append_active(self.path)
        keyfile.retire_inactive(self.path)
        back = keyfile.unretire(self.path, old.active_id)
        self.assertEqual(back.ids[1], old.active_id)
        self.assertEqual(keyfile.unretire(self.path, old.active_id).keys, back.keys)  # idempotent


class Names(unittest.TestCase):
    def test_fullmatch_rejects_the_trailing_newline_and_nul(self) -> None:
        for fn, good in ((names.module, "monitoring"), (names.key, "POSTGRES_PASSWORD"),
                         (names.actor, "cli:devssh")):
            self.assertEqual(fn(good), good)
            for bad in (good + "\n", "\n" + good, good + "\x00", good + " ", "", "../" + good,
                        good + "/../x", None, 3, [good]):
                with self.subTest(fn.__name__, bad=bad), self.assertRaises(ValidationError):
                    fn(bad)

    def test_the_internal_module_name_cannot_be_a_user_module(self) -> None:
        with self.assertRaises(ValidationError):
            names.module(names.INTERNAL_MODULE)

    def test_a_refused_name_is_not_echoed(self) -> None:
        with self.assertRaises(ValidationError) as cm:
            names.key("secret-looking-value-in-a-name!")
        self.assertNotIn("secret-looking", str(cm.exception))

    def test_surface_and_request_id(self) -> None:
        self.assertEqual(names.surface("web"), "web")
        with self.assertRaises(ValidationError):
            names.surface("telepathy")
        self.assertIsNone(names.request_id(None))
        with self.assertRaises(ValidationError):
            names.request_id("a b")


MOUNTINFO = r"""
22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sdc rw
30 22 0:25 / /mnt/c rw,noatime - 9p C:\134 rw,aname=drvfs
31 22 0:26 / /mnt/nfs rw - nfs4 server:/x rw
32 22 0:27 / /srv/with\040space rw - ext4 /dev/sdd rw
33 22 0:28 / /srv/fuse rw - fuse.sshfs u@h:/ rw
34 22 0:29 / /var/lib/containers rw - fuse.overlayfs overlay rw
35 22 0:30 / /tmp rw - tmpfs tmpfs rw
36 22 0:31 / /data rw - overlay overlay rw
37 22 0:32 / /mnt/cx rw - ext4 /dev/sde rw
38 22 0:33 / /mnt/c/inner rw - ext4 /dev/sdf rw
39 22 0:34 / /dup rw - nfs /a rw
40 22 0:35 / /dup rw - ext4 /b rw
"""


class Filesystem(unittest.TestCase):
    def fs(self, path: str) -> str:
        return fscheck.require_supported(path, MOUNTINFO)

    def test_native_filesystems_pass(self) -> None:
        for p, want in (("/srv/x/state", "ext4"), ("/tmp/x", "tmpfs"), ("/data/s", "overlay"),
                        ("/srv/with space/db", "ext4"), ("/var/lib/containers/s", "fuse.overlayfs")):
            with self.subTest(p):
                self.assertEqual(self.fs(p), want)

    def test_windows_drive_network_and_fuse_mounts_are_refused(self) -> None:
        for p in ("/mnt/c", "/mnt/c/Users/x/state", "/mnt/nfs/db", "/srv/fuse/state"):
            with self.subTest(p), self.assertRaises(UnsupportedFilesystemError) as cm:
                self.fs(p)
            self.assertIn("native", str(cm.exception))

    def test_longest_mount_wins_and_prefix_is_by_component(self) -> None:
        self.assertEqual(self.fs("/mnt/c/inner/db"), "ext4")  # a nested native mount
        self.assertEqual(self.fs("/mnt/cx/db"), "ext4")       # /mnt/cx is not under /mnt/c
        with self.assertRaises(UnsupportedFilesystemError):
            self.fs("/mnt/c/other")

    def test_the_later_mount_on_the_same_point_is_on_top(self) -> None:
        self.assertEqual(self.fs("/dup/x"), "ext4")

    def test_every_denied_type_is_refused(self) -> None:
        for t in sorted(fscheck.DENIED_TYPES):
            info = f"1 0 0:1 / / rw - {t} src rw\n"
            with self.subTest(t), self.assertRaises(UnsupportedFilesystemError):
                fscheck.require_supported("/anything", info)

    def test_an_unknown_answer_refuses_rather_than_passes(self) -> None:
        for info in ("", "garbage\n", "1 0 0:1 / /elsewhere rw - ext4 x rw\n"):
            with self.subTest(info), self.assertRaises(UnsupportedFilesystemError):
                fscheck.require_supported("/not/under/any", info) if info else \
                    fscheck.require_supported("/x", "")
        with mock.patch.object(fscheck, "read_mountinfo", return_value=None):
            with self.assertRaises(UnsupportedFilesystemError):
                fscheck.require_supported("/tmp")

    def test_the_real_tmp_is_supported_on_this_machine(self) -> None:
        d = tempfile.mkdtemp(prefix="bothy-fs-")
        self.addCleanup(shutil.rmtree, d)
        # If this fails the other suites cannot run here either: say so plainly.
        self.assertNotIn(fscheck.require_supported(d), fscheck.DENIED_TYPES)


if __name__ == "__main__":
    unittest.main(verbosity=1)
