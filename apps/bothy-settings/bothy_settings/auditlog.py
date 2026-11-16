"""The audit log line (settings-store.md s13.3): one JSON object per entry, on stdout.

The record wants an independent copy of every audit entry in the container's stdout,
so Loki holds one where Loki exists. Python's `logging` drops INFO unless somebody
configured it, and a library that relies on its host to configure logging silently
loses the independent copy - the one property that does not depend on the database.
So:

  * the logger's level is INFO as soon as this module is imported;
  * `configure_audit_logging()` is what a service entrypoint calls: bare JSON lines
    to stdout, once, however many times it is called;
  * and with NO configuration at all, the first emission installs that same handler.
    If the host application already has any handler (its own, or on the root logger)
    the default stays out of the way and the host's configuration decides where the
    lines go.

A line is emitted after the transaction that wrote the row COMMITS, never before
(store.py `_tx`): a change that rolled back leaves no line.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import IO

LOGGER_NAME = "bothy.settings.audit"
logger = logging.getLogger(LOGGER_NAME)
logger.setLevel(logging.INFO)

_MARK = "_bothy_settings_default"


class _StdoutHandler(logging.StreamHandler):  # type: ignore[type-arg]
    """Writes to whatever sys.stdout is NOW, so a redirected or captured stdout still works."""

    def __init__(self) -> None:
        super().__init__()

    @property  # type: ignore[override]
    def stream(self) -> IO[str]:
        return sys.stdout

    @stream.setter
    def stream(self, _value: object) -> None:
        pass


def configure_audit_logging(stream: IO[str] | None = None, level: int = logging.INFO) -> logging.Handler:
    """Send the audit lines to `stream` (default: stdout) as bare JSON, one per line. Idempotent."""
    for h in list(logger.handlers):
        if getattr(h, _MARK, False):
            logger.removeHandler(h)
    handler: logging.Handler = logging.StreamHandler(stream) if stream is not None else _StdoutHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    setattr(handler, _MARK, True)
    logger.addHandler(handler)
    logger.setLevel(level)
    return handler


def emit(record: dict[str, object]) -> None:
    if not logger.hasHandlers():  # no configuration anywhere: do the useful thing
        configure_audit_logging()
    logger.info(json.dumps(record, sort_keys=True))
