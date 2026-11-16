"""Names that go into SQL keys, associated data and audit rows.

fullmatch, always: `$` matches before a trailing newline, which is how
bothy-control once accepted "grafana\\n" (see apps/bothy-common/bothy_common/names.py).
The patterns carry no anchors so that match() cannot be used by mistake.

The record does not fix an alphabet. These are the narrowest that hold what the
stack uses (module ids such as `monitoring`, keys such as `POSTGRES_PASSWORD`) and
they exclude 0x00, which the associated-data encoding relies on as a separator.
The internal module name `_store` (wrapped store keys) cannot match MODULE, so a
user row can never collide with it.
"""

from __future__ import annotations

import re

from .errors import ValidationError

MODULE = re.compile(r"[a-z][a-z0-9_-]{0,62}")
KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}")
ACTOR = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}")
SURFACES = frozenset({"web", "cli", "api-token", "mcp", "bootstrap", "import"})
INTERNAL_MODULE = "_store"
MAX_VALUE_BYTES = 16 * 1024


def check(value: object, pattern: re.Pattern[str], what: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        # The offending text is NOT echoed: a mis-keyed form can put a value in a name.
        raise ValidationError(f"invalid {what}")
    return value


def module(v: object) -> str:
    return check(v, MODULE, "module name")


def key(v: object) -> str:
    return check(v, KEY, "key name")


def actor(v: object) -> str:
    return check(v, ACTOR, "actor")


def surface(v: object) -> str:
    if v not in SURFACES:
        raise ValidationError("invalid surface")
    return v  # type: ignore[return-value]


def request_id(v: object) -> str | None:
    if v is None:
        return None
    return check(v, re.compile(r"[A-Za-z0-9_.:-]{1,64}"), "request id")
