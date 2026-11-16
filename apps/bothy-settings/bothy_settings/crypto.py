"""The only module that touches `cryptography`. Primitives exactly as the record
names them (settings-store.md s6.2) and nothing invented:

  * AES-256-GCM via `cryptography`'s AESGCM, 96-bit random nonce, 128-bit tag.
  * every value encrypted under its own random DEK, which is wrapped under the KEK
    with AES-256-GCM as well (GCM, not RFC 3394 key wrap, because it carries
    associated data).
  * associated data binds the store, module and key (and, for a wrap, the key id):

        value: "bothy/v1/value" 0x00 store_id 0x00 module 0x00 key
        wrap : "bothy/v1/wrap"  0x00 store_id 0x00 module 0x00 key 0x00 key_id

    `store_id` is fixed-length (16 bytes), and module/key cannot contain 0x00
    (names.py), so the encoding is unambiguous.
  * fingerprint: first 4 bytes, hex, of HMAC-SHA256(fp_key, module 0x00 key 0x00 value).

NONCES. The risk with random 96-bit nonces is a bug, not chance (record s6.3):
a code path that reuses one. So every nonce comes through ONE function that
remembers what it handed out and raises NonceReuseError on a repeat. The memory is
bounded (100k most recent) so it cannot grow without limit in a long-lived service;
past that bound it is a probabilistic backstop, which is all it needs to be.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import threading

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .errors import NonceReuseError

NONCE_LEN = 12
KEY_LEN = 32
TAG_LEN = 16
_SEEN_CAP = 100_000

# Indirection so a test can swap in a constant source ("a monkeypatched constant
# nonce is caught by a test hook", record s16.2).
_random = os.urandom


class AuthFailure(Exception):
    """A GCM tag did not verify. Carries nothing: callers add module.key."""


class _NonceGuard:
    def __init__(self, cap: int = _SEEN_CAP):
        self._cap = cap
        self._seen: set[bytes] = set()
        self._order: list[bytes] = []
        self._lock = threading.Lock()

    def fresh(self) -> bytes:
        n = _random(NONCE_LEN)
        if len(n) != NONCE_LEN:
            raise NonceReuseError("nonce source returned the wrong length")
        with self._lock:
            if n in self._seen:
                raise NonceReuseError("the nonce source repeated a nonce; refusing to encrypt")
            self._seen.add(n)
            self._order.append(n)
            if len(self._order) > self._cap:
                drop = self._order[: len(self._order) // 2]
                del self._order[: len(drop)]
                self._seen.difference_update(drop)
        return n


_guard = _NonceGuard()


def new_key() -> bytes:
    return os.urandom(KEY_LEN)


def aad_value(store_id: bytes, module: str, key: str) -> bytes:
    return b"bothy/v1/value\x00" + store_id + b"\x00" + module.encode() + b"\x00" + key.encode()


def aad_wrap(store_id: bytes, module: str, key: str, key_id: str) -> bytes:
    return (b"bothy/v1/wrap\x00" + store_id + b"\x00" + module.encode() + b"\x00"
            + key.encode() + b"\x00" + key_id.encode())


def seal(key: bytes, plaintext: bytes, aad: bytes) -> tuple[bytes, bytes]:
    """-> (nonce, ciphertext||tag)."""
    if len(key) != KEY_LEN:
        raise ValueError("AES-256 key must be 32 bytes")
    nonce = _guard.fresh()
    return nonce, AESGCM(key).encrypt(nonce, plaintext, aad)


def open_(key: bytes, nonce: bytes, ciphertext: bytes, aad: bytes) -> bytes:
    # AESGCM accepts nonces of 8..128 bytes; a stored nonce of any other length
    # is tampering, not a valid row.
    if len(key) != KEY_LEN or len(nonce) != NONCE_LEN or len(ciphertext) < TAG_LEN:
        raise AuthFailure()
    try:
        return AESGCM(key).decrypt(nonce, ciphertext, aad)
    except InvalidTag:
        raise AuthFailure() from None


def fingerprint(fp_key: bytes, module: str, key: str, value: bytes) -> str:
    mac = hmac.new(fp_key, module.encode() + b"\x00" + key.encode() + b"\x00" + value,
                   hashlib.sha256).digest()
    return mac[:4].hex()
