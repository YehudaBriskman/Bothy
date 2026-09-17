"""The append-only audit log, one TSV line per request.

Every tier on this box that can change something writes one of these, and until
2026-09 each wrote it with its own copy of the same twenty lines. The FIELDS are
still each tier's own - a file write, a form patch, a container action and a
cluster action record different facts - so the field list is the caller's and
only the mechanics live here:

    <UTC timestamp> \\t <field> \\t <field> ... [suffix]

── why every field is flattened ─────────────────────────────────────────────

The log is tab-separated, one record per line, so a newline in ANY field forges
a record. A container name, a form value, a commit message or a filename (Linux
allows newlines in those) containing

    "\\n<timestamp>\\tsomeone@else\\tACTED\\tstop\\tpostgres"

would produce a syntactically perfect entry attributing an action to somebody
else. Guards upstream refuse most of those inputs first; flat() is the second
lock, and it also covers the fields no guard sees - the actor header and error
strings this process did not write.

── why a failure to LOG never fails the request ─────────────────────────────

Losing the record of a restart or a save is bad; refusing a legitimate restart
or save because the disk is full is worse. So write() swallows its own OSError
and says so on stderr, which `docker logs` shows. Every line goes to stderr as
well, so the record survives an unwritable bind mount in the container log.
"""

from __future__ import annotations

import os
import re
import sys
import threading
import time

_FLAT = re.compile(r"[\r\n\t]+")


def flat(v: object) -> str:
    """One field, on one line, with no tab in it."""
    return _FLAT.sub(" ", str(v)).strip()


class AuditLog:
    """One log file. Thread-safe: every tier runs a ThreadingHTTPServer."""

    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.Lock()

    def write(self, *fields: object, suffix: str = "") -> str:
        """Append one record: timestamp, the flattened fields, then `suffix`.

        `suffix` is appended verbatim and is for the tiers whose historical
        format is not purely tab-separated (bothy-files' `   N bytes`). Anything
        a caller puts in it must already have been through flat().
        """
        line = "\t".join([time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                          *(flat(f) for f in fields)]) + suffix
        sys.stderr.write(line + "\n")
        try:
            with self._lock:
                os.makedirs(os.path.dirname(self.path), exist_ok=True)
                with open(self.path, "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
        except OSError as e:
            sys.stderr.write(f"AUDIT LOG UNWRITABLE ({e}) - the request itself was fine\n")
        return line
