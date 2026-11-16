"""The age-encrypted export bundle (settings-store.md s11): the ENCRYPT half only.

Nothing is invented here. The `age` binary does the encryption, called the one
documented way (`age -r <recipient>`, plaintext on stdin, ciphertext on stdout),
and this module only moves bytes. Two properties the record asks for:

  * the plaintext never touches disk: it goes to the child's stdin pipe, and only
    the ciphertext the child prints is written, to a 0600 file, atomically.
  * the plaintext is not in argv (visible in /proc and `ps`) or in the environment.

DEFERRED, deliberately (documented TODOs, not stubs that pretend):

  TODO(#317 follow-up) decrypt side: `age -d -i <identity>` into Store.import_document.
      Not written because it needs the identity file handling and a real age to
      test against in CI; the bundle round-trip IS exercised in checks/test_export.py
      when an `age` binary is present (BOTHY_AGE_BIN or on PATH) and skipped
      otherwise, loudly.
  TODO(#317 follow-up) passphrase mode (`age -p`): age reads the passphrase from the
      terminal, not stdin, so it needs a pty; and a generated passphrase has to be
      shown once. A recipient (`age1...`) is the form the record recommends.
  TODO(#317 follow-up) installing `age` checksum-pinned on the host (record s11).
  TODO(#317 follow-up) `--with-audit`.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
from collections.abc import Mapping
from typing import Any

from .errors import SettingsError

# bech32 charset, lower case. Deliberately not the full bech32 checksum: age
# validates the recipient itself and exits non-zero on a bad one.
_RECIPIENT = re.compile(r"age1[02-9ac-hj-np-z]{20,200}")


class ExportError(SettingsError):
    pass


def find_age(explicit: str | None = None) -> str | None:
    return explicit or os.environ.get("BOTHY_AGE_BIN") or shutil.which("age")


def age_encrypt(document: Mapping[str, Any], recipient: str, dest: str | os.PathLike[str],
                *, age_bin: str | None = None, timeout: float = 30.0) -> int:
    """Encrypt `document` (from Store.export_document) to an age recipient and write it to `dest`.

    Returns the ciphertext size. Refuses to overwrite `dest`.
    """
    if not isinstance(recipient, str) or _RECIPIENT.fullmatch(recipient) is None:
        raise ExportError("recipient must be an age1... public key")
    binary = find_age(age_bin)
    if binary is None:
        raise ExportError("the `age` binary was not found (set BOTHY_AGE_BIN or install it)")
    dest = os.fspath(dest)
    if os.path.lexists(dest):
        raise ExportError(f"{dest} already exists; a bundle is never overwritten")
    payload = json.dumps(document, sort_keys=True, ensure_ascii=True).encode("ascii")
    # No inherited secrets in the child's environment, and a plain argv.
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    try:
        proc = subprocess.run([binary, "-r", recipient], input=payload, capture_output=True,
                              timeout=timeout, env=env, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ExportError("running age failed") from None
    if proc.returncode != 0 or not proc.stdout:
        # age's stderr names the problem (a bad recipient); it never echoes stdin.
        raise ExportError(f"age exited {proc.returncode}: "
                          f"{proc.stderr.decode('utf-8', 'replace').strip()[:200]}")
    tmp = f"{dest}.tmp.{os.getpid()}.{secrets.token_hex(4)}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(proc.stdout)
            f.flush()
            os.fsync(f.fileno())
        os.link(tmp, dest)
    finally:
        os.unlink(tmp)
    return len(proc.stdout)
