"""The bearer-token store: what bothy-ops verifies a `bt_<id>.<secret>` against.   (decision D43)

docs/plans/thin-bothy/cli-and-control-plane.md sections 1.6 and 1.8. Standard library only.

  token      bt_<id>.<secret>      id = 16 hex (public, names the record); secret = 256 random bits,
                                   urlsafe base64 (43 chars). The secret exists in ONE place after
                                   minting: the terminal of whoever ran tokenctl. The store keeps only
                                   its SHA-256 digest (a 256-bit random secret needs no slow KDF).
  record     {id, kind: cli|mcp, role: viewer|operator, ops: [op id...] or ["*"], created, expires,
              name, revoked_at, last_used, digest}                         times are epoch seconds
  file       <state>/tokens.json   mode 0600, in a 0700 directory, owned by the process's user (or
                                   root), never a symlink. Looser, or a symlink: the store REFUSES TO
                                   LOAD and every bearer is refused (fail closed, said once on stderr).
  writes     temp file in the same directory + fsync + rename + fsync of the directory, under an flock
             on <state>/tokens.lock; a concurrent reader sees the old file or the new one, never half.
  audit      <state>/audit.log     append-only JSON lines: create, revoke, use-denied. Never a secret,
                                   never a raw request string (an id is logged only if it is 16 hex).

What this module is NOT: it has no mint or revoke. Those live in tokenctl.py, a HOST-ONLY script that
the service image does not contain (decision D43: minting is never an API). This file holds the
read side the service needs, plus the file primitives (`update_file`, `audit`) both sides share.

NO ORACLE. Every way a presented token can fail - malformed, unknown id, wrong secret, expired,
revoked, an unreadable store, a throttled source - is the one exception `Denied`, after the same
work (a digest and a constant-time compare against the record's digest or a dummy one), so neither
the answer nor (to a first approximation) the time says which. The reason goes to the audit line only.
Failures are rate-limited per source with bounded memory; a throttled source is refused without even
a compare, and a valid token from it is refused too (the price of a limit; the limit is per source,
never global, so one noisy client cannot lock out the rest).
"""

from __future__ import annotations

import base64
import collections
import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import sys
import threading
import time

KINDS = ("cli", "mcp")
ROLES = ("viewer", "operator")
ALL_OPS = "*"
DEFAULT_TTL = 30 * 86400
MAX_TTL = 365 * 86400
MIN_TTL = 60
COARSE = 3600                       # last_used is rounded to the hour and written at most once an hour
MAX_FILE = 1 << 20
MAX_RECORDS = 2000

ID_RE = re.compile(r"[0-9a-f]{16}")
TOKEN_RE = re.compile(r"bt_([0-9a-f]{16})\.([A-Za-z0-9_-]{43})")
NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._@:-]{0,63}")
OP_RE = re.compile(r"[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*")
REASONS = ("malformed", "unknown", "bad-secret", "revoked", "expired", "store", "throttled")

FILE = "tokens.json"
LOCK = "tokens.lock"
AUDIT = "audit.log"
_DUMMY = hashlib.sha256(b"bothy-token-dummy").hexdigest()


class Denied(Exception):
    """A presented token is not good. One class, no reason: callers map it to auth.unauthenticated."""


class StoreError(Exception):
    """The store itself is unusable (permissions, a symlink, damage). Fails closed."""


def digest_of(secret: str) -> str:
    return hashlib.sha256(secret.encode("ascii")).hexdigest()


def new_secret() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")


def new_id() -> str:
    return secrets.token_hex(8)


# ── the files ────────────────────────────────────────────────────────────────

def _owner_ok(st: os.stat_result) -> bool:
    return st.st_uid in (os.geteuid(), 0)


def check_dir(state: str) -> None:
    try:
        st = os.lstat(state)
    except OSError as e:
        raise StoreError(f"state directory unreadable: {e.strerror}") from None
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        raise StoreError("the state path is a symlink or not a directory")
    if st.st_mode & 0o077:
        raise StoreError(f"state directory mode is {stat.S_IMODE(st.st_mode):04o}; it must be 0700")
    if not _owner_ok(st):
        raise StoreError("state directory is owned by someone else")


def _check_fd(fd: int) -> os.stat_result:
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        raise StoreError("the token file is not a regular file")
    if st.st_mode & 0o077:
        raise StoreError(f"token file mode is {stat.S_IMODE(st.st_mode):04o}; it must be 0600")
    if not _owner_ok(st):
        raise StoreError("the token file is owned by someone else")
    if st.st_size > MAX_FILE:
        raise StoreError("the token file is implausibly large")
    return st


def _valid_record(r) -> bool:
    return (isinstance(r, dict) and isinstance(r.get("id"), str) and ID_RE.fullmatch(r["id"])
            and r.get("kind") in KINDS and r.get("role") in ROLES
            and isinstance(r.get("digest"), str) and re.fullmatch(r"[0-9a-f]{64}", r["digest"])
            and isinstance(r.get("expires"), int) and isinstance(r.get("created"), int)
            and isinstance(r.get("ops"), list) and r["ops"]
            and all(isinstance(o, str) and (o == ALL_OPS or OP_RE.fullmatch(o)) for o in r["ops"])
            and isinstance(r.get("name"), str)
            and (r.get("revoked_at") is None or isinstance(r["revoked_at"], int))
            and (r.get("last_used") is None or isinstance(r["last_used"], int)))


def read_file(state: str) -> tuple[dict, tuple]:
    """({id: record}, stamp). Raises StoreError for loose permissions, a symlink or damage.
    A missing file is an empty store (nothing minted yet); a missing DIRECTORY is StoreError."""
    check_dir(state)
    try:
        fd = os.open(os.path.join(state, FILE), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        return {}, ("missing",)
    except OSError as e:           # ELOOP is a symlink; anything else is unreadable
        raise StoreError(f"the token file cannot be opened safely: {e.strerror}") from None
    try:
        st = _check_fd(fd)         # checked on the OPEN fd: no window between check and read
        raw = os.read(fd, MAX_FILE + 1)
    finally:
        os.close(fd)
    try:
        doc = json.loads(raw)
        recs = doc["tokens"]
        if doc.get("version") != 1 or not isinstance(recs, list) or len(recs) > MAX_RECORDS:
            raise ValueError
        out = {}
        for r in recs:
            if not _valid_record(r) or r["id"] in out:
                raise ValueError
            out[r["id"]] = r
    except (ValueError, KeyError, TypeError):
        raise StoreError("the token file is damaged") from None
    return out, (st.st_ino, st.st_mtime_ns, st.st_size)


def ensure_dir(state: str) -> None:
    os.makedirs(state, mode=0o700, exist_ok=True)
    check_dir(state)


def update_file(state: str, mutate) -> object:
    """Read-modify-write under an flock; `mutate(list_of_records) -> result` edits the list in place.
    Atomic: temp file (0600, O_EXCL) + fsync + rename + fsync of the directory."""
    ensure_dir(state)
    lock = os.open(os.path.join(state, LOCK), os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        cur, _ = read_file(state)
        recs = list(cur.values())
        result = mutate(recs)
        body = (json.dumps({"version": 1, "tokens": recs}, indent=1, sort_keys=True) + "\n").encode()
        tmp = os.path.join(state, f".{FILE}.{os.getpid()}.{secrets.token_hex(4)}")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, body)
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.rename(tmp, os.path.join(state, FILE))
        except OSError:
            os.unlink(tmp)
            raise
        dfd = os.open(state, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
        return result
    finally:
        os.close(lock)


def _clean(v: object) -> str:
    s = str(v)
    return s if NAME_RE.fullmatch(s) or s == "-" else "-"


def audit(state: str, event: str, token_id: str = "-", *, path: str | None = None, **fields: object) -> None:
    """One JSON line, appended. Best effort: failing to log never changes an auth decision. The id is
    kept only if it is 16 hex; every other field is a fixed word, an int or a validated name."""
    rec = {"ts": int(time.time()), "event": event, "id": token_id if ID_RE.fullmatch(str(token_id)) else "-"}
    for k, v in fields.items():
        rec[k] = v if isinstance(v, int) else _clean(v)
    try:
        fd = os.open(path or os.path.join(state, AUDIT),
                     os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            os.write(fd, (json.dumps(rec, sort_keys=True) + "\n").encode())
        finally:
            os.close(fd)
    except OSError as e:
        sys.stderr.write(f"token audit not written: {e.strerror}\n")


# ── failure rate limiting, bounded ───────────────────────────────────────────

class FailureLimiter:
    """At most `per_source` failures per `window` seconds per source; at most `max_keys` sources
    remembered (the oldest evicted), so memory is bounded however many sources probe."""

    def __init__(self, per_source: int = 10, window: float = 60.0, max_keys: int = 1024):
        self.per_source, self.window, self.max_keys = per_source, window, max_keys
        self._d: collections.OrderedDict[str, collections.deque] = collections.OrderedDict()
        self._lock = threading.Lock()

    def _prune(self, q: collections.deque, now: float) -> None:
        while q and now - q[0] > self.window:
            q.popleft()

    def blocked(self, source: str, now: float) -> bool:
        with self._lock:
            q = self._d.get(source)
            if q is None:
                return False
            self._prune(q, now)
            return len(q) >= self.per_source

    def fail(self, source: str, now: float) -> None:
        with self._lock:
            q = self._d.get(source)
            if q is None:
                q = self._d[source] = collections.deque(maxlen=self.per_source)
                while len(self._d) > self.max_keys:
                    self._d.popitem(last=False)
            else:
                self._d.move_to_end(source)
            self._prune(q, now)
            q.append(now)

    def size(self) -> int:
        return len(self._d)


class IdFailures:
    """A coarse, per-token-id count of WRONG-SECRET attempts. It is deliberately not a gate.

    A token id is not a secret (it is in `bothy token list`, in audit lines, in the operator's shell
    history), so anyone can name a victim's id. Any rule of the form "after N failures for this id,
    refuse that id" is therefore a denial of service against its owner, however it is dressed. This
    counter can never do that: it is consulted only AFTER the constant-time compare has already said the
    secret is wrong, it is never read on the success path, and a correct secret is accepted at any count.
    What it does is bound the NOISE: past `quiet_after` wrong secrets for one id in `window` seconds,
    further ones for that id stop writing audit lines (the first N and the `hot` flag are the signal),
    so a flood aimed at one id cannot bury every other id's denials in the 30-a-minute audit budget.
    Brute force is a non-issue by entropy (a 256-bit secret), which is why no refusal is added."""

    def __init__(self, quiet_after: int = 20, window: float = 600.0, max_keys: int = 1024):
        self.quiet_after, self.window, self.max_keys = quiet_after, window, max_keys
        self._d: collections.OrderedDict[str, collections.deque] = collections.OrderedDict()
        self._lock = threading.Lock()

    def fail(self, token_id: str, now: float) -> bool:
        """Record one wrong secret for `token_id`; True when it is within the audit allowance."""
        with self._lock:
            q = self._d.get(token_id)
            if q is None:
                q = self._d[token_id] = collections.deque()
                while len(self._d) > self.max_keys:
                    self._d.popitem(last=False)
            else:
                self._d.move_to_end(token_id)
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) < self.quiet_after * 2:        # bounded: the count saturates, memory does not grow
                q.append(now)
            return len(q) <= self.quiet_after

    def size(self) -> int:
        return len(self._d)


# ── the read side the service uses ───────────────────────────────────────────

class TokenStore:
    def __init__(self, state: str, limiter: FailureLimiter | None = None, touch: bool = True,
                 audit_log: str | None = None):
        # `audit_log`: where denials go when the state directory is mounted READ-ONLY (the service's
        # normal case): a writable file elsewhere, never inside `state`. None = <state>/audit.log.
        self.state = state
        self.audit_log = audit_log
        self.limiter = limiter or FailureLimiter()
        self.id_failures = IdFailures()
        self.touch = touch
        self._lock = threading.Lock()
        self._warned: str | None = None
        self._deny_logged: list[float] = []

    def _load(self) -> dict:
        # Read on EVERY request (<= 1 MB, 2000 records): a revoke takes effect on the next one, and the
        # permission check re-runs, so "refuses to load if looser" holds when someone loosens it later.
        return read_file(self.state)[0]

    def _deny(self, reason: str, token_id: str, source: str, now: float) -> None:
        if reason in ("malformed", "unknown", "bad-secret", "revoked", "expired", "store"):
            self.limiter.fail(source, now)
        # Per-id: wrong secrets only, counted AFTER the compare, only ever shaping the audit (never a refusal).
        id_quiet = reason == "bad-secret" and ID_RE.fullmatch(token_id) and not self.id_failures.fail(token_id, now)
        if id_quiet:
            return
        with self._lock:                       # bound the audit volume: 30 denial lines a minute
            self._deny_logged = [t for t in self._deny_logged if now - t < 60]
            quiet = len(self._deny_logged) >= 30
            if not quiet:
                self._deny_logged.append(now)
        if not quiet:
            audit(self.state, "use-denied", token_id, path=self.audit_log, reason=reason)

    def verify(self, presented: str, source: str = "-", now: float | None = None) -> dict:
        """The record (no digest) of a good token, or Denied - always Denied, never a reason."""
        now = time.time() if now is None else now
        source = (source or "-")[:64]
        if self.limiter.blocked(source, now):
            self._deny("throttled", "-", source, now)
            raise Denied
        m = TOKEN_RE.fullmatch(presented) if isinstance(presented, str) and len(presented) <= 128 else None
        reason = None
        try:
            db = self._load()
        except StoreError as e:
            db, reason = {}, "store"
            if self._warned != str(e):
                self._warned = str(e)
                sys.stderr.write(f"bothy-ops token store REFUSES to load, every bearer is refused: {e}\n")
        rec = db.get(m.group(1)) if m else None
        # The same work whatever happened above: one digest, one constant-time compare.
        got = digest_of(m.group(2)) if m else _DUMMY
        match = hmac.compare_digest(got, rec["digest"] if rec else _DUMMY)
        if reason is None:
            if m is None:
                reason = "malformed"
            elif rec is None:
                reason = "unknown"
            elif not match:
                reason = "bad-secret"
            elif rec.get("revoked_at") is not None:
                reason = "revoked"
            elif now >= rec["expires"]:
                reason = "expired"
        if reason is not None:
            self._deny(reason, m.group(1) if m else "-", source, now)
            raise Denied
        self._touch(rec, now)
        return {k: v for k, v in rec.items() if k != "digest"}

    def _touch(self, rec: dict, now: float) -> None:
        coarse = int(now - now % COARSE)
        if not self.touch or (rec.get("last_used") or 0) >= coarse:
            return

        def mut(recs):
            for r in recs:
                if r["id"] == rec["id"]:
                    r["last_used"] = coarse
        try:
            update_file(self.state, mut)
        except (OSError, StoreError):
            pass                                # a read-only mount must never fail a good token
