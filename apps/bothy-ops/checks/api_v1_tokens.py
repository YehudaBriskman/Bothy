#!/usr/bin/env python3
"""Bearer tokens through the real /v1 handler (decision D43).

Run: python3 checks/api_v1_tokens.py 2>/dev/null     (stdlib, throwaway dirs; the world is v1_fixture.py's)

The shipped catalog switches NOTHING to exposure "token". Here a fixture catalog (the shipped one,
edited in memory, restored) does, and the real handler is called with real tokens minted by the real
tokenctl into a throwaway store:

  module.list   exposure ["token"], viewer           served to a valid viewer token that lists it
  status        exposure ["socket", "token"]         the socket still works; a token too
  update.status exposure ["token"], role operator    a viewer token is auth.forbidden; an operator one served
  settings.get  exposure ["token"], callers no mcp   an mcp token is auth.forbidden
  events.query  socket only (unchanged)              a VALID token is auth.forbidden, not 401

and refused auth.unauthenticated, in ONE shape, for: expired, revoked, wrong secret, unknown id,
malformed, no store at all, and an edge identity header next to a bearer (ambiguous). Then: the
generator emits exactly ONE exact Path() router, with no sso gate, for a token-exposed op; the
audit log names the token id and never a secret; discover is unchanged.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

import caller  # noqa: E402
import tokenctl  # noqa: E402
import tokenstore as ts  # noqa: E402
import v1_fixture as fx  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


w = fx.build()
cat = w.v1api.CATALOG
call = lambda p, **kw: fx.call(w, p, **kw)  # noqa: E731
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))

# ── the fixture catalog: in memory, restored at the end ──
ops = cat["ops"]
orig = {k: (list(v["exposure"]), v["role"], list(v["callers"])) for k, v in ops.items()}
ops["module.list"]["exposure"] = ["token"]
ops["status"]["exposure"] = ["socket", "token"]
ops["update.status"]["exposure"], ops["update.status"]["role"] = ["token"], "operator"
ops["settings.get"]["exposure"], ops["settings.get"]["callers"] = ["token"], ["web", "cli", "system"]

state = os.path.join(w.tmp, "tokens")
OPSET = set(ops)
now = int(fx.NOW)      # the fixture pins every clock in the process to this


def mint(**kw):
    a = dict(kind="cli", role="viewer", ops=["*"], name="t", ttl=86400, now=now)
    a.update(kw)
    return tokenctl.create(state, a["kind"], a["role"], a["ops"], a["name"], a["ttl"], now=a["now"], catalog_ops=OPSET)


viewer_ml, vrec = mint(ops=["module.list", "status"], name="viewer-ml")
viewer_status_only, _ = mint(ops=["status"], name="status-only")
viewer_all, _ = mint(name="viewer-all")
operator_all, _ = mint(role="operator", name="op-all")
mcp_all, _ = mint(kind="mcp", name="mcp-all")
expired, _ = mint(now=now - 2 * 86400, ttl=86400, name="expired")
revoked, rrec = mint(name="revoked")
tokenctl.revoke(state, rrec["id"], now=now)
bearer = lambda t: {"Authorization": "Bearer " + t}  # noqa: E731
ML, ST, US, SG, EQ = ("/-/api/v1/modules", "/-/api/v1/status", "/-/api/v1/updates/status",
                      "/-/api/v1/settings?module=sso&key=session_ttl", "/-/api/v1/events")

print("── NO STORE: slice-1 behaviour, unchanged ───────────────────────")
caller.set_token_store(None)
st, _, e = call(ML, headers=bearer(viewer_ml))
ok(st == 401 and e["error"]["code"] == "auth.unauthenticated", "with no store configured a well-formed bearer is 401 auth.unauthenticated")

print()
print("── A VALID TOKEN ────────────────────────────────────────────────")
caller.set_token_store(ts.TokenStore(state))
st, hd, b = call(ML, headers=bearer(viewer_ml))
ok(st == 200 and b["ok"], f"a viewer token that lists the op reads a token-exposed op: {st}")
ok(call(ST, headers=bearer(viewer_ml))[0] == 200 and call(ST)[0] == 200, "status is served to the token AND still to the socket (exposure lists both)")
ok(call(ML)[0] == 403 and call(ML)[2]["error"]["details"]["channel"] == "socket", "the token-only op is still refused on the socket")
ok(call(ML, headers=bearer(viewer_all))[0] == 200, "a viewer token with ops '*' is served")
ok(call(US, headers=bearer(operator_all))[0] == 200, "an operator token reads an operator-role op")
ok(call(ML, headers=bearer(mcp_all))[0] == 200, "an mcp token is served an op whose callers include mcp")

print()
print("── A VALID TOKEN THAT IS NOT ALLOWED: 403, not 401 ──────────────")
for label, path, tok in (("a viewer token on an operator-role op", US, viewer_all),
                         ("a token whose allow-list lacks the op", ML, viewer_status_only),
                         ("a mcp token on an op that is not offered to mcp", SG, mcp_all),
                         ("a valid token on a socket-only op", EQ, viewer_all),
                         ("a valid operator token on a socket-only op", EQ, operator_all)):
    st, _, e = call(path, headers=bearer(tok))
    ok(st == 403 and e["error"]["code"] == "auth.forbidden", f"{label}: {st} {e['error']['code']}")
ok(call(SG, headers=bearer(viewer_all))[0] != 403, "(control: the same settings op for a cli token is not refused)")
st, _, e = call(US, headers=bearer(viewer_all))
ok(e["error"]["details"] == {"required": "operator"}, "the role refusal names the needed role and nothing about the token")

print()
print("── REFUSED, ALL THE SAME: 401 ───────────────────────────────────")
secret = viewer_ml.split(".")[1]
shapes = {}
for label, h in (("expired", bearer(expired)), ("revoked", bearer(revoked)),
                 ("wrong secret", bearer(viewer_ml.split(".")[0] + "." + ts.new_secret())),
                 ("unknown id", bearer("bt_" + "0" * 16 + "." + secret)),
                 ("malformed", bearer("nope")), ("Basic scheme", {"Authorization": "Basic Zm9vOmJhcg=="}),
                 ("edge identity + a VALID bearer", {**bearer(viewer_ml), "X-Auth-Request-Email": "v@example.com"})):
    st, hd, e = call(ML, headers=h)
    err = e["error"]
    shapes[label] = (st, err["code"], err["details"], err["hint"], err["message"])
    ok(st == 401 and err["code"] == "auth.unauthenticated", f"{label}: 401 auth.unauthenticated")
    ok(secret not in json.dumps(e) and h.get("Authorization", "x") not in json.dumps(e), f"{label}: the token is never echoed")
plain = {k: v for k, v in shapes.items() if not k.startswith("edge")}
ok(len(set(map(str, plain.values()))) == 1, "expired, revoked, wrong secret, unknown id, malformed, Basic: byte-identical answers")
ok(call(ML, headers=bearer(viewer_ml))[0] == 200, "(control: the valid token still works after all of that)")
st, _, e = call(EQ, headers=bearer("bt_nothing"))
ok(st == 401, "a BAD token on a socket-only op is 401 (authentication happens before authorisation)")
ok(call(ML, method="POST", headers=bearer(viewer_ml))[0] == 403 and call(ML, method="DELETE", headers=bearer(operator_all))[0] == 403,
   "no token of any role can write: every non-GET is auth.forbidden")
rv = call(ML, headers=bearer(revoked))[0]
tokenctl.revoke(state, vrec["id"], now=now)
ok(rv == 401 and call(ML, headers=bearer(viewer_ml))[0] == 401, "a revoke takes effect on the very next request, no restart")

print()
print("── AUDIT: who, never the secret ─────────────────────────────────")
log = open(os.environ["ADMIN_AUDIT_LOG"]).read()
ok(f"token:{vrec['id']}" in log, "the v1 audit line names the token id as the actor")
secrets_ = [t.split(".")[1] for t in (viewer_ml, viewer_all, operator_all, mcp_all, expired, revoked, viewer_status_only)]
alltext = log + open(os.path.join(state, "audit.log")).read() + open(os.path.join(state, "tokens.json")).read()
ok(not any(s in alltext for s in secrets_), "no token secret is in the request audit, the token audit or the store")
ok(sum(1 for line in open(os.path.join(state, "audit.log")) if '"use-denied"' in line) >= 1, "denials are in the token audit")

print()
print("── THE GENERATOR: one exact Path() router, no sso gate ──────────")
src = open(os.path.join(os.path.dirname(HERE), "operations.toml"), encoding="utf-8").read()
fix = src.replace('audit = "v1.module.list"', 'audit = "v1.module.list"\nexposure = ["token"]', 1)
assert fix != src
alt = os.path.join(w.tmp, "token-ml.toml")
open(alt, "w", encoding="utf-8").write(fix)
gen = os.path.join(w.tmp, "gen")
r = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "gen-ops-v1.py"), "--out", gen], capture_output=True, text=True,
                   env={**os.environ, "OPERATIONS_CATALOG": alt})
routers = open(os.path.join(gen, "edge-routers.v1.yml"), encoding="utf-8").read()
ok(r.returncode == 0 and re.findall(r'rule: "([^"]+)"', routers) == ["Path(`/-/api/v1/modules`)"],
   f"a read op with exposure [token] is exactly ONE exact Path() router: {re.findall(r'rule: .*', routers)}")
ok("sso-" not in re.sub(r"sso-errors", "", routers) and "Host(" not in routers and "PathPrefix" not in routers,
   "…with NO sso-<role> gate (the service verifies the bearer), no Host(), no prefix")
ok(not os.path.exists(os.path.join(ROOT, "edge", "dynamic", "bothy-ops-v1.yml")), "…and nothing is installed at the edge by any of this")

# ── restore, then prove the shipped catalog is untouched ──
for k, (e_, r_, c_) in orig.items():
    ops[k]["exposure"], ops[k]["role"], ops[k]["callers"] = e_, r_, c_
caller.set_token_store(ts.TokenStore(state))
ok(all(o["exposure"] == ["socket"] for o in ops.values()), "the SHIPPED catalog switches no op to token: every exposure is still [socket]")
ok(call(ML, headers=bearer(viewer_all))[0] == 403, "…so a valid token on a shipped op is auth.forbidden today")

print()
print(f"{len(fails)} failed" if fails else "all passed")
sys.exit(1 if fails else 0)
