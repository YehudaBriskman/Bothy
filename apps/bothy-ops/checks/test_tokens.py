#!/usr/bin/env python3
"""Bearer tokens (decision D43): the store, the host-only minting script and the caller adapter.

Run: python3 checks/test_tokens.py        (stdlib only; throwaway directories; no network, no docker)

  STORE     secret kept only as a SHA-256 digest; the file is 0600 in a 0700 directory; a looser file or
            directory, or a symlink, REFUSES TO LOAD (and every bearer is refused); writes are atomic
            (no temp file left, a reader never sees half a file); expiry default 30 days, max 1 year
  NO ORACLE malformed / unknown id / wrong secret / expired / revoked / throttled / unreadable store are
            ONE exception with one text; the reason is in the audit line only; a failure never reaches
            the answer. Rate limit per source, bounded memory, a quiet source unaffected
  AUDIT     create, revoke and use-denied are logged; no secret, no raw request text, ever
  TOKENCTL  create prints the token once on stdout and nothing else; list/revoke; refuses a network
            launch; the service image does not contain it and nothing in the service imports it
  CALLER    role, scopes and id come from the RECORD, never from a header; no store = every bearer
            refused; edge identity + bearer = refused as ambiguous
"""
import io
import json
import os
import re
import stat
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SVC))
sys.path.insert(0, SVC)

import caller  # noqa: E402
import tokenctl  # noqa: E402
import tokenstore as ts  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def raises(exc, fn, *a, **k) -> bool:
    try:
        fn(*a, **k)
    except exc:
        return True
    return False


tmp = tempfile.mkdtemp(prefix="bothy-tokens-")
n = [0]


def fresh() -> str:
    n[0] += 1
    d = os.path.join(tmp, f"s{n[0]}")
    return d


OPS = {"status", "module.list", "update.status", "settings.get"}
NOW = 1_800_000_000


def mint(state, kind="cli", role="viewer", ops=("status",), ttl=86400, name="laptop", now=NOW):
    return tokenctl.create(state, kind, role, list(ops), name, ttl, now=now, catalog_ops=OPS)


print("── STORE: what is kept, and how ─────────────────────────────────")
S = fresh()
tok, rec = mint(S)
m = re.fullmatch(r"bt_([0-9a-f]{16})\.([A-Za-z0-9_-]{43})", tok)
ok(m is not None and m.group(1) == rec["id"], "the token is bt_<16 hex id>.<43 chars = 256 bits of secret>")
secret = m.group(2)
raw = open(os.path.join(S, "tokens.json")).read()
ok(secret not in raw and tok not in raw, "the secret is NOT in the store file")
ok(ts.digest_of(secret) in raw and ts.digest_of(secret) != secret, "…only its SHA-256 digest is")
ok(stat.S_IMODE(os.stat(S).st_mode) == 0o700 and stat.S_IMODE(os.stat(os.path.join(S, "tokens.json")).st_mode) == 0o600,
   "the directory is 0700 and the file 0600")
ok(sorted(os.listdir(S)) == ["audit.log", "tokens.json", "tokens.lock"], f"no temp file is left behind: {sorted(os.listdir(S))}")
ok(rec["expires"] - rec["created"] == 86400 and rec["revoked_at"] is None and rec["last_used"] is None
   and rec["ops"] == ["status"] and rec["kind"] == "cli" and rec["role"] == "viewer" and rec["name"] == "laptop",
   "the record: id, kind, role, ops, created, expires, name, revoked_at, last_used")
ok(tokenctl.parse_ttl("30d") == ts.DEFAULT_TTL == 30 * 86400, "the default ttl is 30 days")
ok(tokenctl.parse_ttl("365d") == 365 * 86400 and raises(tokenctl.Refused, tokenctl.parse_ttl, "366d")
   and raises(tokenctl.Refused, tokenctl.parse_ttl, "10s") and raises(tokenctl.Refused, tokenctl.parse_ttl, "forever"),
   "the maximum ttl is one year; shorter than a minute and junk are refused")
a, b = mint(S)[0], mint(S)[0]
ok(a != b and a.split(".")[1] != b.split(".")[1], "two mints never repeat an id or a secret")

store = ts.TokenStore(S, touch=False)
got = store.verify(tok, now=NOW + 10)
ok(got["id"] == rec["id"] and got["role"] == "viewer" and got["ops"] == ["status"] and "digest" not in got,
   "a good token verifies to its record, without the digest")

print()
print("── STORE: permissions and symlinks, fail closed ─────────────────")
for label, mutate, undo in (
    ("a group-readable token file", lambda: os.chmod(os.path.join(S, "tokens.json"), 0o640),
     lambda: os.chmod(os.path.join(S, "tokens.json"), 0o600)),
    ("a world-readable token file", lambda: os.chmod(os.path.join(S, "tokens.json"), 0o644),
     lambda: os.chmod(os.path.join(S, "tokens.json"), 0o600)),
    ("a group-searchable state directory", lambda: os.chmod(S, 0o750), lambda: os.chmod(S, 0o700)),
):
    mutate()
    ok(raises(ts.StoreError, ts.read_file, S), f"{label}: the store refuses to load")
    ok(raises(ts.Denied, store.verify, tok, now=NOW + 10), f"{label}: a VALID token is refused (fail closed)")
    undo()
ok(store.verify(tok, now=NOW + 10)["id"] == rec["id"], "(control: restored, the same token verifies again)")
L = fresh()
os.makedirs(L, mode=0o700)
real = os.path.join(tmp, "elsewhere.json")
open(real, "w").write(open(os.path.join(S, "tokens.json")).read())
os.chmod(real, 0o600)
os.symlink(real, os.path.join(L, "tokens.json"))
ok(raises(ts.StoreError, ts.read_file, L), "a token file that is a symlink is refused, however good its target")
ok(raises(ts.Denied, ts.TokenStore(L, touch=False).verify, tok, now=NOW + 10), "…and so is every token in it")
LD = os.path.join(tmp, "linkdir")
os.symlink(S, LD)
ok(raises(ts.StoreError, ts.read_file, LD), "a state DIRECTORY that is a symlink is refused")
os.chmod(S, 0o700)
M = fresh()
ok(raises(ts.StoreError, ts.read_file, M) and raises(ts.Denied, ts.TokenStore(M, touch=False).verify, tok),
   "a missing state directory is not a store: every bearer refused")
D = fresh()
os.makedirs(D, mode=0o700)
fd = os.open(os.path.join(D, "tokens.json"), os.O_WRONLY | os.O_CREAT, 0o600)
os.write(fd, b'{"version": 1, "tokens": [{"id": "x"}]}')
os.close(fd)
ok(raises(ts.StoreError, ts.read_file, D), "a damaged record refuses the whole file")
E = fresh()
os.makedirs(E, mode=0o755)
ok(raises(ts.StoreError, tokenctl.create, E, "cli", "viewer", ["status"], "x", 3600, catalog_ops=OPS),
   "minting into a loose directory refuses too")

print()
print("── NO ORACLE: every failure is the same ─────────────────────────")
S2 = fresh()
good, grec = mint(S2, ttl=3600)
exp_tok, erec = mint(S2, ttl=ts.MIN_TTL, name="short")
rev_tok, rrec = mint(S2, name="gone")
tokenctl.revoke(S2, rrec["id"], now=NOW + 5)
st = ts.TokenStore(S2, touch=False)
cases = {
    "malformed": "bt_nothing",
    "wrong prefix": good.replace("bt_", "xx_", 1),
    "unknown id": "bt_" + "0" * 16 + "." + good.split(".")[1],
    "wrong secret": good.split(".")[0] + "." + ts.new_secret(),
    "expired": exp_tok,
    "revoked": rev_tok,
    "empty": "",
    "oversized": "bt_" + "a" * 5000,
}
seen = set()
for label, presented in cases.items():
    try:
        st.verify(presented, source=f"src-{label}", now=NOW + 1000 if label == "expired" else NOW + 6)
        ok(False, f"{label} is refused")
    except ts.Denied as e:
        seen.add((type(e).__name__, str(e), e.args))
ok(len(seen) == 1, f"eight different failures, ONE exception, no text: {seen}")
ok(st.verify(good, source="fine", now=NOW + 6)["id"] == grec["id"], "(control: the good one verifies)")
lines = [json.loads(x) for x in open(os.path.join(S2, "audit.log"))]
reasons = {l["reason"] for l in lines if l["event"] == "use-denied"}
ok({"malformed", "unknown", "bad-secret", "expired", "revoked"} <= reasons,
   f"the REASON is in the audit line only: {sorted(reasons)}")
alltext = open(os.path.join(S2, "audit.log")).read()
ok(all(t.split(".")[-1] not in alltext for t in (good, exp_tok, rev_tok)) and "a" * 100 not in alltext,
   "no secret and no raw request string ever reaches the audit log")
ok(any(l["event"] == "create" and l["id"] == grec["id"] for l in lines)
   and any(l["event"] == "revoke" and l["id"] == rrec["id"] for l in lines), "create and revoke are audited")
ok(all(set(l) <= {"ts", "event", "id", "reason", "kind", "role", "name", "ttl"} for l in lines), "audit lines have a closed set of fields")

print()
print("── RATE LIMIT: per source, bounded ──────────────────────────────")
lim = ts.FailureLimiter(per_source=5, window=60, max_keys=50)
st2 = ts.TokenStore(S2, limiter=lim, touch=False)
bad = "bt_" + "1" * 16 + "." + "A" * 43
for i in range(5):
    raises(ts.Denied, st2.verify, bad, source="noisy", now=NOW + i)
ok(lim.blocked("noisy", NOW + 6), "five failures block that source")
ok(raises(ts.Denied, st2.verify, good, source="noisy", now=NOW + 7), "…a valid token from it is refused while blocked")
ok(st2.verify(good, source="quiet", now=NOW + 7)["id"] == grec["id"], "…another source is unaffected (the limit is not global)")
ok(st2.verify(good, source="noisy", now=NOW + 200)["id"] == grec["id"], "…and the block ends with the window")
for i in range(5000):
    lim.fail(f"s{i}", NOW)
ok(lim.size() <= 50, f"memory is bounded: 5000 sources remembered as {lim.size()}")
before = len(open(os.path.join(S2, "audit.log")).read().splitlines())
flood = ts.TokenStore(S2, touch=False)      # one store, as the service has
for i in range(300):
    raises(ts.Denied, flood.verify, bad, source=f"flood{i}", now=NOW + 300)
after = len(open(os.path.join(S2, "audit.log")).read().splitlines())
ok(after - before <= 30, f"denial audit lines are capped per minute ({after - before} lines for 300 failures)")

print()
print("── LAST USED and EXPIRY ─────────────────────────────────────────")
S3 = fresh()
t3, r3 = mint(S3, ttl=7200)
s3 = ts.TokenStore(S3)
s3.verify(t3, now=NOW + 5000 - 5000 % 3600 + 100)
lu = ts.read_file(S3)[0][r3["id"]]["last_used"]
ok(lu is not None and lu % 3600 == 0, f"last_used is recorded coarsely (to the hour): {lu}")
mt = os.stat(os.path.join(S3, "tokens.json")).st_mtime_ns
s3.verify(t3, now=NOW + 5000 - 5000 % 3600 + 200)
ok(os.stat(os.path.join(S3, "tokens.json")).st_mtime_ns == mt, "…and not rewritten again within the hour")
ok(raises(ts.Denied, s3.verify, t3, now=NOW + 7200), "expiry is exact: at `expires` the token is refused")
ok(s3.verify(t3, now=NOW + 7199)["id"] == r3["id"], "…and one second before it, accepted")
os.chmod(S3, 0o500)
try:
    ts.TokenStore(S3).verify(t3, now=NOW + 7100)
    ok(True, "a read-only state directory never fails a good token (touch is best-effort)")
except Exception as e:  # noqa: BLE001
    ok(False, f"a read-only state directory never fails a good token: {e!r}")
os.chmod(S3, 0o700)

# STATIC (stated: `==` and compare_digest answer alike for every input a test can send, and the timing
# difference is not testable here): the source of the verify path must use hmac.compare_digest.
src_ts = open(os.path.join(SVC, "tokenstore.py"), encoding="utf-8").read()
ok("hmac.compare_digest(" in src_ts and not re.search(r"\bgot\s*[!=]=|[!=]=\s*\(?rec\[.digest", src_ts),
   "(static) the secret digest is compared with hmac.compare_digest, never ==")

print()
print("── TOKENCTL: host only ──────────────────────────────────────────")
S4 = fresh()
NULL = os.open(os.devnull, os.O_RDONLY)     # the harness's own stdin may be a socket, which tokenctl refuses
out, err = io.StringIO(), io.StringIO()
rc = tokenctl.main(["--state", S4, "create", "--kind", "mcp", "--role", "viewer", "--ops", "*", "--name", "agent"], out, err, NULL)
printed = out.getvalue()
ok(rc == 0 and re.fullmatch(r"bt_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}\n", printed) is not None,
   "create prints the token, once, as the ONLY thing on stdout")
ok(printed.split(".")[1].strip() not in err.getvalue() and "secret" in err.getvalue(),
   "…and the secret is not on stderr; stderr says it was shown once")
out2, err2 = io.StringIO(), io.StringIO()
tokenctl.main(["--state", S4, "list"], out2, err2, NULL)
ok(printed.split(".")[1].strip() not in out2.getvalue() and "agent" in out2.getvalue() and "active" in out2.getvalue(),
   "list shows id, status, kind, role, expiry, ops, name - never a secret or a digest")
tid = printed.split(".")[0][3:]
ok(tokenctl.main(["--state", S4, "revoke", tid], io.StringIO(), io.StringIO(), NULL) == 0
   and raises(ts.Denied, ts.TokenStore(S4, touch=False).verify, printed.strip()), "revoke takes effect on the next verification")
ok(tokenctl.main(["--state", S4, "revoke", "f" * 16], io.StringIO(), io.StringIO(), NULL) == 1, "revoking an unknown id is an error")
ok(tokenctl.main(["--state", S4, "create", "--kind", "cli", "--role", "viewer", "--ops", "no.such.op", "--name", "x"],
                 io.StringIO(), io.StringIO(), NULL) == 1, "an op id the catalog does not have is refused")
ok(tokenctl.main(["--state", S4, "create", "--kind", "cli", "--role", "viewer", "--ops", "*", "--name", "bad\nname"],
                 io.StringIO(), io.StringIO(), NULL) == 1, "a name with a control character is refused")
ok(tokenctl.main(["--state", S4, "create", "--kind", "cli", "--role", "viewer", "--ops", "*", "--name", "x", "--ttl", "400d"],
                 io.StringIO(), io.StringIO(), NULL) == 1, "a ttl past a year is refused")
ok(raises(tokenctl.Refused, tokenctl.refuse_if_network, {"REQUEST_METHOD": "GET"})
   and raises(tokenctl.Refused, tokenctl.refuse_if_network, {"GATEWAY_INTERFACE": "CGI/1.1"})
   and raises(tokenctl.Refused, tokenctl.refuse_if_network, {"HTTP_HOST": "x"}), "it refuses a CGI/web-request environment")
import socket  # noqa: E402
a_, b_ = socket.socketpair()
ok(raises(tokenctl.Refused, tokenctl.refuse_if_network, {}, a_.fileno()), "it refuses to run with a socket as its input")
a_.close(), b_.close()
ok(not raises(tokenctl.Refused, tokenctl.refuse_if_network, {}, os.open(os.devnull, os.O_RDONLY)), "(control: a normal terminal/file is fine)")
svc_src = "".join(open(os.path.join(SVC, f), encoding="utf-8").read() for f in ("app.py", "v1api.py", "caller.py", "tokenstore.py"))
ok("tokenctl" not in re.sub(r"#.*|\"\"\"[\s\S]*?\"\"\"", "", svc_src), "no code of the service imports or calls tokenctl")
ok("tokenctl" not in open(os.path.join(SVC, "Dockerfile")).read() and "tokenctl" not in open(os.path.join(ROOT, "apps", ".dockerignore")).read(),
   "the service image does not contain tokenctl.py")
catalog_text = open(os.path.join(SVC, "operations.toml"), encoding="utf-8").read()
import opscatalog  # noqa: E402
cat = opscatalog.load()
ok(not any(re.search(r"token|mint|credential", o["id"] + o["http"] + o["audit"] + o["mcp"]["tool"], re.I)
           for o in [*cat["ops"].values(), cat["endpoints"]["discover"]] if o.get("mcp"))
   and all(o["http"].startswith("GET ") for o in cat["ops"].values()),
   "no op, route or tool in operations.toml is about minting tokens, and every route is a GET: there is no mint route")

print()
print("── CALLER: the adapter ──────────────────────────────────────────")
S5 = fresh()
ct, crec = mint(S5, kind="mcp", role="operator", ops=("status", "module.list"), name="mcp-a")
caller.set_token_store(ts.TokenStore(S5, touch=False))
H = {"Authorization": "Bearer " + ct}
c = caller.from_request(H, "viewer", "10.0.0.1")
ok(c == caller.Caller("token", "operator", ("status", "module.list"), crec["id"], "mcp"),
   f"kind token; role, scopes, id and client kind are the RECORD's: {c}")
c = caller.from_request({**H, "X-Bothy-Role": "viewer", "X-Auth-Request-Groups": "viewer"}, "viewer")
ok(c.role == "operator", "the role is the record's even when the edge's role is viewer and headers say otherwise")
c = caller.from_request({"Authorization": "bearer " + ct}, "viewer")
ok(c.kind == "token", "the scheme is case-insensitive")
EDGE = {"X-Auth-Request-Email": "v@example.com"}
for label, h in (("edge identity + a VALID bearer", {**EDGE, **H}), ("edge user + a bearer", {"X-Auth-Request-User": "u", **H})):
    ok(raises(caller.Unauthenticated, caller.from_request, h, "viewer"), f"{label}: refused as ambiguous")
msgs = set()
for h in ({"Authorization": "Bearer nonsense"}, {"Authorization": "Basic Zm9vOmJhcg=="}, {"Authorization": "Bearer " + "x" * 500},
          {"Authorization": "Bearer bt_" + "0" * 16 + "." + "A" * 43}, {"Authorization": "Bearer"}, {"Authorization": "Bearer " + exp_tok}):
    try:
        caller.from_request(h, "viewer")
        ok(False, f"refused: {list(h.values())[0][:30]}")
    except caller.Unauthenticated as e:
        msgs.add(str(e))
ok(msgs == {caller.GENERIC}, f"every bad bearer gets the one generic message: {msgs}")
caller.set_token_store(None)
ok(raises(caller.Unauthenticated, caller.from_request, H, "viewer"), "no store configured: even a valid-looking bearer is refused (slice-1 behaviour)")


class Broken:
    def verify(self, *a, **k):
        raise RuntimeError("boom: secret-in-message")


caller.set_token_store(Broken())
try:
    caller.from_request(H, "viewer")
    ok(False, "a broken store refuses")
except caller.Unauthenticated as e:
    ok(str(e) == caller.GENERIC, "a broken store fails closed with the generic message")
caller.set_token_store(None)
ok(caller.from_request({}, "viewer").kind == "socket" and caller.from_request(EDGE, "operator").kind == "session",
   "socket and session adapters are unchanged")

print()
print("GO-MINTED TOKENS (cli/internal/tokens; golden fixtures, no Go toolchain needed to replay them)")
GOLD = os.path.join(HERE, "golden", "tokens")


def load_store(doc_store: dict) -> str:
    """Write a fixture's store the way the host would have: 0600 file in a 0700 directory."""
    d = fresh()
    os.makedirs(d, mode=0o700)
    p = os.path.join(d, ts.FILE)
    with open(p, "w") as f:
        json.dump(doc_store, f)
    os.chmod(p, 0o600)
    return d


go = json.load(open(os.path.join(GOLD, "gotokens.json")))
gstate = load_store(go["store"])
recs, _ = ts.read_file(gstate)
ok(len(recs) == len(go["store"]["tokens"]) and all("digest" in r for r in recs.values()),
   "a store Go wrote passes the Python reader's strict record validation")
ok(not any(re.search(r"\.([A-Za-z0-9_-]{43})", r["digest"]) for r in recs.values()),
   "digests are hex (no secret in the store)")
gstore = ts.TokenStore(gstate, touch=False)
for c in go["cases"]:
    try:
        rec = gstore.verify(c["presented"], now=c["at"])
        got = "ok"
    except ts.Denied:
        rec, got = None, "denied"
    ok(got == c["expect"], f"Go-minted: {c['name']} -> {c['expect']}")
    if got == "ok" and c["expect"] == "ok":
        ok((rec["kind"], rec["role"], rec["ops"]) == (c["kind"], c["role"], c["ops"]),
           f"  …and the record's kind, role and ops are what Go minted ({c['name']})")
cl = [c for c in go["cases"] if c["expect"] == "ok"]
ok(len(cl) >= 3 and any(c["expect"] == "denied" and "revoked" in c["name"] for c in go["cases"])
   and any("expiry" in c["name"] for c in go["cases"]) and any("wrong secret" in c["name"] for c in go["cases"]),
   "the fixture really covers valid, revoked, expired and wrong-secret")
revoked = [r for r in recs.values() if r["revoked_at"] is not None]
ok(len(revoked) == 1 and revoked[0]["role"] == "operator", "Go's revoke wrote revoked_at into the store")

# And the reverse: what the Python tokenctl wrote is what Go reads (replayed on the Go side), and it still verifies.
py = json.load(open(os.path.join(GOLD, "pytokens.json")))
pstate = load_store(py["store"])
try:
    pr = ts.TokenStore(pstate, touch=False).verify(py["presented"], now=NOW + 60)
    ok(pr["id"] == py["id"], "the Python-minted golden still verifies (Go reads this very file)")
except ts.Denied:
    ok(False, "the Python-minted golden still verifies")

alog = os.path.join(tmp, "denials.log")
gstate = load_store(go["store"])
ro = ts.TokenStore(gstate, touch=False, audit_log=alog)
os.chmod(gstate, 0o500)            # a read-only store, like the compose mount
try:
    ro.verify("bt_" + "0" * 16 + "." + "A" * 43, now=NOW)
except ts.Denied:
    pass
os.chmod(gstate, 0o700)
ok(os.path.exists(alog) and "use-denied" in open(alog).read() and not os.path.exists(os.path.join(gstate, ts.AUDIT)),
   "with a read-only store a denial is audited to the separate writable log, not lost")

print()
print(f"{len(fails)} failed" if fails else "all passed")
sys.exit(1 if fails else 0)
