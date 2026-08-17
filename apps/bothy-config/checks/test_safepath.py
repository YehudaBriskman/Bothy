#!/usr/bin/env python3
"""Truth table for the config tier's path boundary.

Run: python3 checks/test_safepath.py

safepath.py here is a COPY of apps/portal-files/safepath.py, and its header says
so. A copy's real risk is drift: someone closes a hole in the original and not in
this one, and nothing anywhere notices. This file is the thing that notices - it
runs the same class of cases portal-files' own truth table runs, so a case added
there and not here is a case that fails here.

Every case is an attack that must be REFUSED, or a legitimate patch that must be
ALLOWED. The symlink cases matter most, because they are the ones a
string-inspecting implementation passes cleanly. They are built on a REAL
filesystem with REAL symlinks rather than mocked, since mocking the thing under
test would prove only that the mock behaves as written.
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

# The policy is loaded at import and validates that every root is a real
# directory - so importing safepath on the HOST, where /repos/stacks does not
# exist, fails by design. That is the fail-closed behaviour working; it just
# means this file has to bring its own policy.
#
# Which it should anyway. A unit test of the boundary that depends on the
# PRODUCTION policy tests two things at once and fails for the wrong reason when
# somebody edits a root.
_BOOT = tempfile.mkdtemp(prefix="bothy-config-boot-")
_POLICY = os.path.join(_BOOT, "policy.toml")
with open(_POLICY, "w") as _f:
    _f.write(
        f'[roots.stacks]\npath = "{_BOOT}"\nwritable = true\n'
        f'[roots.readonly]\npath = "{_BOOT}"\n'
        f'[patch]\nsuffixes = [".yml", ".yaml"]\n'
        f'deny_prefixes = ["edge/dynamic/"]\n'
        f'deny_relpaths = ["monitoring/prometheus-web.yml"]\n'
        f'[fields]\n"dev.portal.project" = {{ kind = "compose-label" }}\n'
        f'[deny]\n'
        f'components = [".git", ".ssh", ".gnupg", "node_modules", ".venv",'
        f' "venv", "__pycache__", ".mypy_cache", ".pytest_cache", "dist",'
        f' "build", ".next", ".turbo", ".cache", "target"]\n'
        f'file_patterns = [".env", ".env.*", "*.env", "*.pem", "*.key",'
        f' "*.p12", "*.pfx", "*.jks", "*.keystore", "*.kdbx", "*.gpg", "*.asc",'
        f' ".netrc", ".pgpass", ".htpasswd", ".git-credentials", "credentials",'
        f' "credentials.*", "*secret*", "*password*", "realm-*.json",'
        f' "*-realm.json", "realm.json", "dozzle-users.yml"]\n'
        f'[snapshots]\npath = "{_BOOT}"\n')
os.environ["POLICY_FILE"] = _POLICY

import safepath  # noqa: E402

bad = 0


def check(label, fn, *, expect_refused):
    global bad
    try:
        fn()
        ok = not expect_refused
        detail = "allowed"
    except safepath.PathRefused as e:
        ok = expect_refused
        detail = f"refused ({e})"
    except Exception as e:  # noqa: BLE001
        ok = False
        detail = f"UNEXPECTED {type(e).__name__}: {e}"
    if not ok:
        bad += 1
    want = "refuse" if expect_refused else "allow"
    print(f"{'PASS' if ok else 'FAIL'}  {label:<50} want={want:<7} {detail}")


tmp = tempfile.mkdtemp(prefix="bothy-config-")
root = os.path.join(tmp, "stacks")
outside = os.path.join(tmp, "outside")
for d in (root, outside,
          os.path.join(root, "edge", "dynamic"),
          os.path.join(root, "monitoring"),
          os.path.join(root, ".git")):
    os.makedirs(d, exist_ok=True)

open(os.path.join(root, "compose.yml"), "w").write("services: {}\n")
open(os.path.join(root, "edge", "dynamic", "portal-files.yml"), "w").write("http: {}\n")
open(os.path.join(root, "monitoring", "prometheus-web.yml"), "w").write("basic_auth_users: {}\n")
open(os.path.join(root, ".git", "config.yml"), "w").write("x: 1\n")
open(os.path.join(root, "notes.md"), "w").write("# not yaml\n")
open(os.path.join(root, "db-password.yml"), "w").write("x: 1\n")
open(os.path.join(outside, "compose.yml"), "w").write("services: {}\n")

# REAL symlinks, because the whole point is that a string check cannot see them.
os.symlink(outside, os.path.join(root, "link-out"))
os.symlink(os.path.join(outside, "compose.yml"),
           os.path.join(root, "innocent.yml"))
os.symlink(os.path.join(root, "edge", "dynamic", "portal-files.yml"),
           os.path.join(root, "shortcut.yml"))

safepath.ROOTS["stacks"] = root
safepath.ROOTS["readonly"] = root
safepath.WRITABLE_ROOTS = frozenset({"stacks"})

W = dict(for_write=True)

print("── the ordinary case ──────────────────────────────────────────────")
check("a compose file in the root",
      lambda: safepath.resolve("stacks", "compose.yml", **W), expect_refused=False)
check("a nested compose file",
      lambda: safepath.resolve("stacks", "./compose.yml", **W), expect_refused=False)

print()
print("── climbing out ───────────────────────────────────────────────────")
check("dot-dot to the parent",
      lambda: safepath.resolve("stacks", "../outside/compose.yml", **W),
      expect_refused=True)
check("dot-dot after a legitimate prefix",
      lambda: safepath.resolve("stacks", "edge/../../outside/compose.yml", **W),
      expect_refused=True)
check("an absolute path",
      lambda: safepath.resolve("stacks", "/etc/passwd", **W), expect_refused=True)
check("an absolute path to a real yaml",
      lambda: safepath.resolve("stacks", os.path.join(outside, "compose.yml"), **W),
      expect_refused=True)
check("a null byte",
      lambda: safepath.resolve("stacks", "compose.yml\x00.md", **W),
      expect_refused=True)
check("an empty path",
      lambda: safepath.resolve("stacks", "", **W), expect_refused=True)
check("an unknown root",
      lambda: safepath.resolve("nowhere", "compose.yml", **W), expect_refused=True)

print()
print("── symlinks: refused for where they POINT, not what they are called ")
check("a symlinked DIRECTORY out of the root",
      lambda: safepath.resolve("stacks", "link-out/compose.yml", **W),
      expect_refused=True)
check("a symlinked FILE out of the root",
      lambda: safepath.resolve("stacks", "innocent.yml", **W), expect_refused=True)
check("a symlink INTO a denied directory",
      lambda: safepath.resolve("stacks", "shortcut.yml", **W), expect_refused=True)
check("...and reading through it is refused too",
      lambda: safepath.resolve("stacks", "shortcut.yml"), expect_refused=True)

print()
print("── policy: what may be patched at all ─────────────────────────────")
check("a markdown file",
      lambda: safepath.resolve("stacks", "notes.md", **W), expect_refused=True)
check("anything under edge/dynamic",
      lambda: safepath.resolve("stacks", "edge/dynamic/portal-files.yml", **W),
      expect_refused=True)
check("a file denied by exact path",
      lambda: safepath.resolve("stacks", "monitoring/prometheus-web.yml", **W),
      expect_refused=True)
check("a filename matching the secret patterns",
      lambda: safepath.resolve("stacks", "db-password.yml", **W), expect_refused=True)
check("anything inside .git",
      lambda: safepath.resolve("stacks", ".git/config.yml", **W), expect_refused=True)
check("a read-only root",
      lambda: safepath.resolve("readonly", "compose.yml", **W), expect_refused=True)
check("...which is still READABLE",
      lambda: safepath.resolve("readonly", "compose.yml"), expect_refused=False)

print()
print("── the prefix trap ────────────────────────────────────────────────")
# Without the trailing separator in the startswith() comparison, a sibling
# directory sharing a name prefix passes: "/tmp/x/stacks-secret" starts with
# "/tmp/x/stacks".
sibling = root + "-secret"
os.makedirs(sibling, exist_ok=True)
open(os.path.join(sibling, "compose.yml"), "w").write("services: {}\n")
check("a sibling directory sharing the root's name prefix",
      lambda: safepath.resolve("stacks", "../stacks-secret/compose.yml", **W),
      expect_refused=True)

shutil.rmtree(tmp, ignore_errors=True)
shutil.rmtree(_BOOT, ignore_errors=True)
print()
print("PASS: the boundary refuses everything it should" if not bad
      else f"FAIL: {bad} case(s) went the wrong way")
sys.exit(1 if bad else 0)
