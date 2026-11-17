#!/usr/bin/env python3
"""The trusted client address and the per-id failure counter (s1.9a).   Stdlib only.

Run: python3 checks/test_clientaddr.py

  clientaddr.py   honoured only from a trusted peer; one bare address; IPv6 by /64; lists and garbage
                  fall back to the peer; the default (nothing configured) never honours it
  IdFailures      cannot be used to lock a valid token id out: it is read only after the compare,
                  never on the success path, and only shapes the audit
"""
import json
import os
import sys
import tempfile
from email.message import Message

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

import clientaddr as ca  # noqa: E402
import tokenctl  # noqa: E402
import tokenstore as ts  # noqa: E402

fails: list[str] = []


def ok(cond, label):
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def hdrs(*values):
    m = Message()
    for v in values:
        m["X-Forwarded-For"] = v
    return m


print("── parse: one bare address or nothing ───────────────────────────")
good = {"198.51.100.7": "198.51.100.7", "2001:db8:1:2:3:4:5:6": "v6:2001:db8:1:2::/64", "::ffff:198.51.100.7": "198.51.100.7"}
for raw, key in good.items():
    a = ca.parse_one(raw)
    ok(a is not None and ca.key_of(a) == key, f"{raw!r} -> {key}")
for raw in ("", " 1.2.3.4", "1.2.3.4 ", "1.2.3.4, 5.6.7.8", "1.2.3.4:80", "[::1]", "[::1]:80", "fe80::1%eth0", "1.2.3.4/32",
            "nope", "999.1.1.1", "0.0.0.0", "::", "224.0.0.1", "1" * 46, None, "1.2.3.4\t"):
    ok(ca.parse_one(raw) is None, f"rejected: {raw!r}")
ok(ca.key_of(ca.parse_one("2001:db8:1:2::1")) == ca.key_of(ca.parse_one("2001:db8:1:2:ffff:ffff:ffff:ffff")),
   "IPv6 low 64 bits do not change the key")
ok(ca.key_of(ca.parse_one("2001:db8:1:2::1")) != ca.key_of(ca.parse_one("2001:db8:1:3::1")), "another /64 is another key")

print()
print("── trust: only a configured peer ────────────────────────────────")
ca.configure(None)
ok(ca.source("10.0.0.2", hdrs("198.51.100.7")) == "10.0.0.2", "DEFAULT (nothing configured): the header is never honoured")
ca.configure("")
ok(ca.source("10.0.0.2", hdrs("198.51.100.7")) == "10.0.0.2", "empty setting: never honoured")
ca.configure("10.0.0.2, 192.0.2.0/28")
ok(ca.source("10.0.0.2", hdrs("198.51.100.7")) == "198.51.100.7", "the trusted peer's header is honoured")
ok(ca.source("192.0.2.5", hdrs("198.51.100.7")) == "198.51.100.7", "a peer inside a trusted CIDR is honoured")
ok(ca.source("10.0.0.3", hdrs("198.51.100.7")) == "10.0.0.3", "SPOOF: the same header from a peer that is not trusted is ignored")
ok(ca.source("::ffff:10.0.0.2", hdrs("198.51.100.7")) == "198.51.100.7", "an IPv4-mapped peer address is unmapped before the compare")
ok(ca.source("10.0.0.2", hdrs("198.51.100.7", "203.0.113.9")) == "10.0.0.2", "two header fields: rejected, peer used")
ok(ca.source("10.0.0.2", hdrs("198.51.100.7, 203.0.113.9")) == "10.0.0.2", "a list in one field: rejected, peer used (never 'take the last')")
ok(ca.source("10.0.0.2", Message()) == "10.0.0.2", "no header: peer used")
ok(ca.source("2001:db8:9:9::5", Message()) == "v6:2001:db8:9:9::/64", "an IPv6 peer is keyed by /64 too")
ok(ca.source("-", Message()) == "-", "an unknown peer is a key, not a crash")
try:
    ca.configure("not-an-address")
    ok(False, "a bad entry is refused at configure time")
except ValueError:
    ok(True, "a bad entry is refused at configure time (the service refuses to start, never silently trusts nobody)")
ca.configure("@localhost")
ok(ca.source("127.0.0.1", hdrs("198.51.100.7")) == "198.51.100.7", "a trusted NAME is resolved (localhost -> 127.0.0.1)")
ok(ca.source("10.9.9.9", hdrs("198.51.100.7")) == "10.9.9.9", "…and a peer the name does not resolve to is not trusted")
ca.configure("@no-such-host.invalid")
ok(ca.source("127.0.0.1", hdrs("198.51.100.7")) == "127.0.0.1", "an unresolvable trusted name trusts nobody")
ca.configure(None)

print()
print("── per-id counter: it can shape the audit, never refuse ─────────")
tmp = tempfile.mkdtemp()
state = os.path.join(tmp, "t")
NOW = 1_800_000_000
OPSET = {"status"}
tok, rec = tokenctl.create(state, "cli", "viewer", ["*"], "v", 86400, now=NOW, catalog_ops=OPSET)
tok2, rec2 = tokenctl.create(state, "cli", "viewer", ["*"], "other", 86400, now=NOW, catalog_ops=OPSET)
store = ts.TokenStore(state, touch=False)
store.id_failures = ts.IdFailures(quiet_after=5, window=600, max_keys=50)
wrong = lambda r: f"bt_{r['id']}." + ts.new_secret()  # noqa: E731
for i in range(400):                                   # 400 sources, each under the per-source cap
    try:
        store.verify(wrong(rec), source=f"s{i}", now=NOW + i % 20)
    except ts.Denied:
        pass
try:
    got = store.verify(tok, source="victim", now=NOW + 21)
    ok(got["id"] == rec["id"], "LOCK-OUT DoS: after 400 wrong secrets naming the id, the correct secret is accepted")
except ts.Denied:
    ok(False, "LOCK-OUT DoS: after 400 wrong secrets naming the id, the correct secret is accepted")
lines = [json.loads(x) for x in open(os.path.join(state, "audit.log")) if '"use-denied"' in x]
mine = [x for x in lines if x["id"] == rec["id"]]
ok(len(mine) <= 5, f"…and the audit holds at most quiet_after lines for that id ({len(mine)} for 400 wrong secrets)")
try:
    store.verify(wrong(rec2), source="elsewhere", now=NOW + 22)
except ts.Denied:
    pass
lines = [json.loads(x) for x in open(os.path.join(state, "audit.log")) if '"use-denied"' in x]
ok(any(x["id"] == rec2["id"] for x in lines), "another id still gets its denial audited (one hot id does not hide the rest)")
for i in range(5000):
    store.id_failures.fail(f"{i:016x}", NOW)
ok(store.id_failures.size() <= 50, f"memory is bounded: 5000 ids remembered as {store.id_failures.size()}")
ok(store.verify(tok, source="victim", now=NOW + 23)["id"] == rec["id"], "the correct secret is still accepted at saturation")
src = open(os.path.join(os.path.dirname(HERE), "tokenstore.py"), encoding="utf-8").read()
ok(src.count("id_failures.fail(") == 1 and "id_failures" not in src.split("def verify", 1)[1].split("def _touch", 1)[0],
   "static: the counter is written in _deny only and never read on the verify path")

print()
print(f"{len(fails)} failed" if fails else "all passed")
sys.exit(1 if fails else 0)
