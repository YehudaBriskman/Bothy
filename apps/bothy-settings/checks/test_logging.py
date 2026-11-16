#!/usr/bin/env python3
"""The audit log line (record s13.3) reaches stdout with NO logging configuration.

Run: python3 apps/bothy-settings/checks/test_logging.py   (needs `cryptography`)

Each case runs in a clean interpreter: this process's own logging setup must not be able to
make the test pass. A library whose log line needs its host to configure logging loses the
independent copy of the audit trail without anybody noticing.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)

BODY = """
import sys
sys.path.insert(0, sys.argv[1])
from bothy_settings import Store, bootstrap
root = sys.argv[2]
state, kf = root + "/state", root + "/keys/master.key"
{setup}
bootstrap(state, kf)
with Store.open(state, kf) as s:
    s.register_fields("m", {{"TOKEN": True}}, actor="t")
    s.put_secret("m", "TOKEN", "canary-value-for-the-log-test-0123", actor="t")
"""


class NoLoggingConfig(unittest.TestCase):
    def run_child(self, setup: str = "") -> list[str]:
        root = tempfile.mkdtemp(prefix="bothy-log-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        p = subprocess.run([sys.executable, "-I", "-c", BODY.format(setup=setup), PKG, root],
                           capture_output=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr.decode()[-500:])
        self.assertNotIn("canary-value", p.stdout.decode() + p.stderr.decode())
        return [ln for ln in p.stdout.decode().splitlines() if ln.strip()]

    def test_the_line_appears_on_stdout_with_no_logging_configured(self) -> None:
        lines = self.run_child()
        recs = [json.loads(ln) for ln in lines]  # every line is bare JSON
        self.assertIn(("set", "TOKEN"), [(r["action"], r.get("key")) for r in recs])
        self.assertTrue(all("mac" not in r for r in recs))

    def test_configuring_twice_does_not_double_the_lines(self) -> None:
        once = self.run_child("from bothy_settings.auditlog import configure_audit_logging as c\nc()\nc()\nc()")
        base = self.run_child()
        self.assertEqual(len(once), len(base))

    def test_a_host_that_configured_logging_keeps_control(self) -> None:
        lines = self.run_child("import logging\nlogging.getLogger('bothy.settings.audit').addHandler(logging.NullHandler())")
        self.assertEqual(lines, [], "a host handler means the default stays out of the way")


if __name__ == "__main__":
    unittest.main(verbosity=1)
