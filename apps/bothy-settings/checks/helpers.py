"""Shared fixtures for the bothy-settings checks. Imported by the test_*.py files.

Everything runs in a fresh temp directory with a GENERATED key. Nothing here reads
or writes ~/stacks/.env or any real credential: the only secrets are CANARY values
invented below, which exist so a test can grep for them.
"""

from __future__ import annotations

import base64
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from bothy_settings import Store, bootstrap  # noqa: E402

# Long and distinctive on purpose: the scanners skip values under 8 bytes, and a
# short canary could match by chance inside a database page.
CANARY = "canary-S3cr3t-7f3a9c1e-DO-NOT-LEAK-שלום"
CANARY2 = "second-canary-0b8d41aa-NEVER-ON-DISK"
CANARY3 = "third-canary-c94f20e7-STILL-SECRET"


def variants(value: str) -> list[tuple[str, bytes]]:
    """Every plausible on-disk spelling of a plaintext value."""
    raw = value.encode("utf-8")
    return [
        ("utf-8", raw),
        ("utf-16le", value.encode("utf-16-le")),
        ("base64", base64.b64encode(raw)),
        ("urlsafe-base64", base64.urlsafe_b64encode(raw)),
        ("hex", raw.hex().encode()),
        ("json-escaped", value.encode("unicode_escape")),
    ]


def tree_hits(root: str, values: list[str]) -> list[str]:
    """Every (file, spelling) under `root` that contains one of `values`."""
    hits = []
    for dirpath, _d, files in os.walk(root):
        for fn in files:
            p = os.path.join(dirpath, fn)
            with open(p, "rb") as f:
                data = f.read()
            for v in values:
                for label, needle in variants(v):
                    if needle and needle in data:
                        hits.append(f"{os.path.relpath(p, root)} [{label}]")
    return hits


class Crash(Exception):
    """Raised from a rotation hook to simulate the process dying at that step."""


class StoreCase(unittest.TestCase):
    """A bootstrapped store in a fresh temp dir with module `m` registered."""

    FIELDS = {"TOKEN": True, "OTHER": True, "THIRD": True, "NAME": False, "PORT": False}

    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="bothy-settings-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.state = os.path.join(self.root, "state")
        self.kf = os.path.join(self.root, "cfg", "master.key")
        bootstrap(self.state, self.kf)
        self.s = self.open()
        self.s.register_fields("m", self.FIELDS, actor="test")

    def open(self, state: str | None = None, kf: str | None = None) -> Store:
        s = Store.open(state or self.state, kf or self.kf)
        self.addCleanup(s.close)
        return s

    def reopen(self) -> Store:
        self.s.close()
        self.s = self.open()
        return self.s

    def reveal(self, key: str, module: str = "m", store: Store | None = None) -> str:
        return (store or self.s).reveal_for_projection(module, key, actor="test")

    def fill(self) -> None:
        self.s.put_secret("m", "TOKEN", CANARY, actor="alice")
        self.s.put_secret("m", "OTHER", CANARY2, actor="alice")
        self.s.put_secret("m", "THIRD", CANARY3, actor="alice")
        self.s.put_value("m", "NAME", "bothy", actor="alice")

    def rows(self, sql: str, *args: object) -> list:
        return self.s._conn.execute(sql, args).fetchall()
