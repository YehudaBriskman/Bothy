#!/usr/bin/env python3
"""Mint, list and revoke bearer tokens.  HOST-ONLY (decision D43) - a local script, never an API.

    python3 apps/bothy-ops/tokenctl.py [--state DIR] create --kind cli|mcp --role viewer|operator \\
                                          --ops op.id[,op.id...]|'*' --name NAME [--ttl 30d]
    python3 apps/bothy-ops/tokenctl.py [--state DIR] list
    python3 apps/bothy-ops/tokenctl.py [--state DIR] revoke <id>

`create` prints the token `bt_<id>.<secret>` to STDOUT, once, and nothing else there; the facts about
it (id, role, expiry) go to stderr. The secret is never stored (only its SHA-256 digest), never put in
the audit log, never in an error message: lose it and mint another.

Why it is a script and not a route: minting through the API would let any credential that can reach
the API make a stronger one. The service image does not even contain this file (the Dockerfile COPYs
tokenstore.py only), no catalog op or route mentions it, and checks pin both. It also refuses to run
when it looks network-launched: a CGI/HTTP environment, or stdin being a socket (inetd, a socket
activator, `nc -e`). An operator reaching the box over Tailscale SSH is a local process and is fine.

State: --state, else $BOTHY_TOKEN_STATE, else ${STATE_ROOT:-~/.local/state}/bothy/tokens. Created 0700.
--ops is validated against operations.toml; `*` means every op the role allows (the role is the cap).
Defaults: ttl 30d, at most 365d. Standard library only.
"""

from __future__ import annotations

import argparse
import os
import re
import stat
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import tokenstore as ts  # noqa: E402

_TTL = re.compile(r"(\d{1,9})([smhd]?)")
_UNIT = {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}


class Refused(Exception):
    pass


def parse_ttl(text: str) -> int:
    m = _TTL.fullmatch(text.strip())
    if not m:
        raise Refused(f"--ttl '{text}' is not like 90m, 12h, 30d or a number of seconds")
    secs = int(m.group(1)) * _UNIT[m.group(2)]
    if secs < ts.MIN_TTL or secs > ts.MAX_TTL:
        raise Refused(f"--ttl must be between {ts.MIN_TTL} seconds and {ts.MAX_TTL // 86400} days")
    return secs


def refuse_if_network(env=None, stdin_fd: int = 0) -> None:
    env = os.environ if env is None else env
    if env.get("GATEWAY_INTERFACE") or env.get("REQUEST_METHOD") or any(k.startswith("HTTP_") for k in env):
        raise Refused("tokenctl is a local script: it will not run from a web request")
    try:
        if stat.S_ISSOCK(os.fstat(stdin_fd).st_mode):
            raise Refused("tokenctl is a local script: it will not run with a network socket as its input")
    except OSError:
        pass


def default_state(env=None) -> str:
    env = os.environ if env is None else env
    if env.get("BOTHY_TOKEN_STATE"):
        return env["BOTHY_TOKEN_STATE"]
    root = env.get("STATE_ROOT") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(root, "bothy", "tokens")


def known_ops() -> set[str]:
    import opscatalog
    return set(opscatalog.load()["ops"])


def create(state: str, kind: str, role: str, ops: list[str], name: str, ttl: int, now: int | None = None,
           catalog_ops: set[str] | None = None) -> tuple[str, dict]:
    """(the token string, the public record). The only place a secret exists is this return value."""
    if kind not in ts.KINDS or role not in ts.ROLES:
        raise Refused("kind must be cli or mcp and role viewer or operator")
    if not ts.NAME_RE.fullmatch(name):
        raise Refused("--name must be 1-64 letters, digits, space or . _ @ : - and start with a letter or digit")
    if not ops or (ts.ALL_OPS in ops and len(ops) > 1) or len(set(ops)) != len(ops):
        raise Refused("--ops is a list of op ids without repeats, or just '*'")
    if ops != [ts.ALL_OPS]:
        valid = known_ops() if catalog_ops is None else catalog_ops
        bad = [o for o in ops if o not in valid]
        if bad:
            raise Refused(f"unknown op id(s): {', '.join(bad)}")
    if ttl < ts.MIN_TTL or ttl > ts.MAX_TTL:
        raise Refused("ttl out of range")
    now = int(time.time()) if now is None else now
    tid, secret = ts.new_id(), ts.new_secret()
    rec = {"id": tid, "kind": kind, "role": role, "ops": list(ops), "name": name, "created": now,
           "expires": now + ttl, "revoked_at": None, "last_used": None, "digest": ts.digest_of(secret)}

    def mut(recs):
        if len(recs) >= ts.MAX_RECORDS:
            raise Refused("too many tokens: revoke and prune some")
        recs.append(rec)
    ts.update_file(state, mut)
    ts.audit(state, "create", tid, kind=kind, role=role, name=name, ttl=ttl)
    return f"bt_{tid}.{secret}", {k: v for k, v in rec.items() if k != "digest"}


def revoke(state: str, tid: str, now: int | None = None) -> bool:
    """True if this call revoked it, False if it already was; Refused for an unknown id."""
    if not ts.ID_RE.fullmatch(tid):
        raise Refused("a token id is 16 hex characters (the part after bt_ and before the dot)")
    now = int(time.time()) if now is None else now
    state_ = {"found": False, "did": False}

    def mut(recs):
        for r in recs:
            if r["id"] == tid:
                state_["found"] = True
                if r["revoked_at"] is None:
                    r["revoked_at"] = now
                    state_["did"] = True
    ts.update_file(state, mut)
    if not state_["found"]:
        raise Refused(f"no token {tid}")
    if state_["did"]:
        ts.audit(state, "revoke", tid)
    return state_["did"]


def listing(state: str, now: int | None = None) -> list[str]:
    now = int(time.time()) if now is None else now
    recs, _ = ts.read_file(state)
    iso = lambda t: "-" if t is None else time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime(t))  # noqa: E731
    rows = []
    for r in sorted(recs.values(), key=lambda r: r["created"]):
        status = "revoked" if r["revoked_at"] is not None else "expired" if now >= r["expires"] else "active"
        rows.append(f"{r['id']}  {status:<7}  {r['kind']:<3}  {r['role']:<8}  expires {iso(r['expires'])}  "
                    f"used {iso(r['last_used'])}  ops {','.join(r['ops'])}  {r['name']}")
    return rows


def main(argv=None, out=None, err=None, stdin_fd: int = 0) -> int:
    out, err = out or sys.stdout, err or sys.stderr
    ap = argparse.ArgumentParser(prog="tokenctl", description=__doc__.split("\n")[0])
    ap.add_argument("--state", default=None)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create")
    c.add_argument("--kind", required=True, choices=ts.KINDS)
    c.add_argument("--role", required=True, choices=ts.ROLES)
    c.add_argument("--ops", required=True)
    c.add_argument("--name", required=True)
    c.add_argument("--ttl", default="30d")
    sub.add_parser("list")
    r = sub.add_parser("revoke")
    r.add_argument("id")
    a = ap.parse_args(argv)
    try:
        refuse_if_network(stdin_fd=stdin_fd)
        state = a.state or default_state()
        if a.cmd == "create":
            tok, rec = create(state, a.kind, a.role, [o for o in a.ops.split(",") if o], a.name, parse_ttl(a.ttl))
            out.write(tok + "\n")
            err.write(f"created token {rec['id']} ({a.kind}, {a.role}, expires "
                      f"{time.strftime('%Y-%m-%d', time.gmtime(rec['expires']))}). The secret was printed once "
                      f"and is not stored; lose it and mint another.\n")
        elif a.cmd == "list":
            for row in listing(state):
                out.write(row + "\n")
        else:
            err.write(("revoked " if revoke(state, a.id) else "already revoked ") + a.id + "\n")
        return 0
    except (Refused, ts.StoreError) as e:
        err.write(f"tokenctl: {e}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
