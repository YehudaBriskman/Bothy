"""The audit chain (settings-store.md s13.3).

Each row carries mac = HMAC-SHA256(audit_key, prev_mac || canonical_entry). The
table's triggers refuse UPDATE and DELETE; the chain is what notices a DB-only
attacker who dropped the triggers and edited a row (a flipped field, a removed
row in the middle). Deleting rows from the TAIL (or all of them) is caught by the HEAD:
`meta.audit_head` holds the newest row's (id, mac), MAC'd with audit_key, and is
rewritten in the same transaction as every append. A DB-only attacker cannot forge
a head for a shorter chain. Root holding the KEK can recompute the whole chain and
the head: the record says so (s13.3) and so does this docstring. Each entry is also
logged as one JSON line, which is the independent copy where a log collector exists.

`id` is part of the MAC so that renumbering a row is also a break.

What goes in a row: names, "changed" for secrets, old/new JSON for non-secrets
ONLY. The value of a secret and its fingerprint are never audited (the record:
a fingerprint in the audit is an oracle for guessing).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import sqlite3
from dataclasses import dataclass

GENESIS = bytes(32)
HEAD_KEY = "audit_head"
_HEAD_TAG = b"bothy/v1/audit-head\x00"

ACTIONS = frozenset({
    "set", "delete", "generate", "rotate-kek", "rotate-dek", "export", "import",
    "restore", "projection", "migrate", "read-denied",
    "register",  # not in the record's list: classification changes are security-relevant
})


def canonical(row_id: int, at: str, actor: str, surface: str, action: str,
              module: str | None, key: str | None, old_json: str | None,
              new_json: str | None, detail: str | None, request_id: str | None) -> bytes:
    return json.dumps([row_id, at, actor, surface, action, module, key, old_json,
                       new_json, detail, request_id],
                      separators=(",", ":"), ensure_ascii=True).encode("ascii")


def append(c: sqlite3.Connection, audit_key: bytes, *, at: str, actor: str, surface: str,
           action: str, module: str | None = None, key: str | None = None,
           old_json: str | None = None, new_json: str | None = None,
           detail: str | None = None, request_id: str | None = None) -> dict[str, object]:
    """Insert one row in the CALLER's transaction. Returns the log record."""
    if action not in ACTIONS:
        raise ValueError(f"unknown audit action {action!r}")
    prev = c.execute("SELECT mac FROM audit ORDER BY id DESC LIMIT 1").fetchone()
    prev_mac = bytes(prev[0]) if prev else GENESIS
    seq = c.execute("SELECT seq FROM sqlite_sequence WHERE name='audit'").fetchone()
    nid = (seq[0] if seq else 0) + 1
    mac = hmac.new(audit_key, prev_mac + canonical(nid, at, actor, surface, action, module,
                                                   key, old_json, new_json, detail, request_id),
                   hashlib.sha256).digest()
    c.execute("INSERT INTO audit(id, at, actor, surface, action, module, key, old_json, "
              "new_json, detail, request_id, mac) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
              (nid, at, actor, surface, action, module, key, old_json, new_json, detail,
               request_id, mac))
    c.execute("INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)", (HEAD_KEY, _head(audit_key, nid, mac)))
    return {"id": nid, "at": at, "actor": actor, "surface": surface, "action": action,
            "module": module, "key": key, "old": old_json, "new": new_json,
            "detail": detail, "request_id": request_id}


def _head(audit_key: bytes, row_id: int, mac: bytes) -> bytes:
    body = row_id.to_bytes(8, "big") + mac
    return body + hmac.new(audit_key, _HEAD_TAG + body, hashlib.sha256).digest()


@dataclass(frozen=True)
class Verification:
    ok: bool
    checked: int
    first_bad_id: int | None
    reason: str | None = None


def verify(c: sqlite3.Connection, audit_key: bytes) -> Verification:
    prev_mac = GENESIS
    n = 0
    last_id = 0
    for r in c.execute("SELECT id, at, actor, surface, action, module, key, old_json, "
                       "new_json, detail, request_id, mac FROM audit ORDER BY id"):
        n += 1
        mac = hmac.new(audit_key, prev_mac + canonical(*r[:11]), hashlib.sha256).digest()
        if not isinstance(r[11], bytes) or not hmac.compare_digest(mac, r[11]):
            return Verification(False, n, r[0], "a row does not match its MAC")
        if n > 1 and r[0] <= last_id:
            return Verification(False, n, r[0], "ids are not increasing")
        last_id = r[0]
        prev_mac = mac
    # The head: without it a chain that stops early, or is empty, verifies perfectly.
    row = c.execute("SELECT v FROM meta WHERE k=?", (HEAD_KEY,)).fetchone()
    if row is None:
        return Verification(False, n, None, "the audit head is missing")
    head = bytes(row[0])
    if len(head) != 8 + 32 + 32 or not hmac.compare_digest(head, _head(audit_key, int.from_bytes(head[:8], "big"),
                                                                       head[8:40])):
        return Verification(False, n, None, "the audit head does not authenticate")
    head_id, head_mac = int.from_bytes(head[:8], "big"), head[8:40]
    if n == 0:
        if head_id != 0:
            return Verification(False, 0, None, f"every audit row is gone (the head names row {head_id})")
    elif head_id != last_id or not hmac.compare_digest(head_mac, prev_mac):
        return Verification(False, n, last_id, f"the chain ends at row {last_id} but the head names row {head_id}")
    return Verification(True, n, None)
