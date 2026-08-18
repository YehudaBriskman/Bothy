#!/usr/bin/env python3
"""Does oauth2-proxy honour a PER-ROUTE role requirement?

This decides the whole shape of the write tier. If `/oauth2/auth?allowed_groups=X`
is enforced, one oauth2-proxy instance can gate every future route by role and the
requirement lives in the Traefik middleware. If it is NOT enforced, every role
needs its own oauth2-proxy container and its own cookie, which is a much worse
design - so it must be established before anything is built on top of it.

The test is falsifiable by construction: user `devssh` holds viewer/editor/operator
but deliberately NOT `shell`. So:

    allowed_groups=editor  MUST pass    (they have it)
    allowed_groups=shell   MUST be denied (they do not)

If BOTH pass, the parameter is being ignored and a shell-gated route would be
wide open to any logged-in user. That is the failure this script exists to catch.

TWO HALVES, and the second was added with /delete. Proving the gate works is not
proving that a route stands behind it - a mutating endpoint wired to `sso-viewer`
or to nothing at all would sail past everything above. So section 5 reads
Traefik's runtime router table and asserts which middleware each portal-files
route carries, then confirms an anonymous delete is refused by the edge.
"""
import os
import re
import sys
import urllib.parse
import requests

# One resolver for the whole suite - checks/env.py. These were literals in
# twelve files, which put this node's tailnet address in a public repo and
# made the suite unrunnable by anyone but its author.
from env import BASE
USER = os.environ["DEV_LOGIN_USER"]
PASS = os.environ["DEV_LOGIN_PASSWORD"]

s = requests.Session()

# 1. Start the flow. oauth2-proxy redirects to Keycloak with PKCE.
r = s.get(f"{BASE}/oauth2/start", params={"rd": "/"}, allow_redirects=True, timeout=10)
if "openid-connect/auth" not in r.url and "8090" not in r.url:
    sys.exit(f"FAIL: did not land on Keycloak, got {r.url}")

# 2. Keycloak's login form. Its action carries the session/execution tokens.
m = re.search(r'action="([^"]+)"', r.text)
if not m:
    sys.exit("FAIL: no login form found on the Keycloak page")
action = m.group(1).replace("&amp;", "&")

r = s.post(action, data={"username": USER, "password": PASS},
           allow_redirects=True, timeout=10)

# 3. We should be back on the portal with an oauth2-proxy session cookie.
if not any(c.name.startswith("_oauth2_proxy") for c in s.cookies):
    sys.exit(f"FAIL: no session cookie after login. Landed on {r.url}\n"
             f"      (an 'Invalid username or password' page means the creds are wrong)")

print(f"  logged in as {USER}")
print(f"  session cookie: {[c.name for c in s.cookies if c.name.startswith('_oauth2_proxy')]}")

# 4. The actual question.
def probe(label, params):
    rr = s.get(f"{BASE}/oauth2/auth", params=params, allow_redirects=False, timeout=10)
    return rr.status_code, label

cases = [
    ("no role required",        {}),
    ("allowed_groups=viewer",   {"allowed_groups": "viewer"}),
    ("allowed_groups=editor",   {"allowed_groups": "editor"}),
    ("allowed_groups=operator", {"allowed_groups": "operator"}),
    ("allowed_groups=shell",    {"allowed_groups": "shell"}),      # user does NOT have this
    ("allowed_groups=nonsense", {"allowed_groups": "no-such-role"}),
]

print("\n  code  case")
results = {}
for label, params in cases:
    code, _ = probe(label, params)
    results[label] = code
    print(f"  {code}   {label}")

held = results["allowed_groups=editor"]
not_held = results["allowed_groups=shell"]
bogus = results["allowed_groups=nonsense"]

print()
if held == 202 and not_held != 202 and bogus != 202:
    print("  VERDICT: per-route roles ARE enforced.")
    print("           One oauth2-proxy can gate every route; the requirement")
    print("           lives in the Traefik middleware. Design is viable.")
    rc = 0
elif held == 202 and not_held == 202:
    print("  VERDICT: allowed_groups IS IGNORED - a role-gated route would be")
    print("           open to ANY logged-in user. Do NOT build on this.")
    print("           Fall back to one oauth2-proxy instance per role.")
    rc = 1
else:
    print(f"  VERDICT: unexpected. editor={held} shell={not_held} bogus={bogus}")
    rc = 2

# ── 5. and WHICH gate each route is actually wired to ───────────────────────
#
# Everything above proves the gate WORKS. It says nothing about whether any given
# route USES it, and that is the half that protects a file. A mutating endpoint
# routed with `sso-viewer` - or with no middleware at all - would be open to
# every logged-in user while this script still printed its cheerful verdict.
#
# devssh holds `editor`, so there is no authenticated session on this box that
# lacks it and the per-route refusal cannot be observed directly. The wiring can
# be, and combined with the verdict above it is the same claim: this route
# demands a role, and that demand is enforced.
#
# Read from Traefik's RUNTIME router table rather than from the YAML on disk.
# That is deliberate: edge/dynamic is rendered as a Go template first, and a
# doubled brace anywhere - including inside a comment - voids the whole file
# while it still looks perfect on disk. A router that failed to render is exactly
# the failure this section exists to catch, and it is invisible to anything that
# reads the source.
print("\n  code  route wiring")
route_fail = 0
routers = {r["name"]: r for r in
           requests.get(f"{BASE}/-/api/traefik/http/routers", timeout=10).json()}

for name, want in (("portal-files-read@file", "sso-viewer@file"),
                   ("portal-files-write@file", "sso-editor@file"),
                   ("portal-files-delete@file", "sso-editor@file")):
    r = routers.get(name)
    mws = r.get("middlewares", []) if r else []
    ok = bool(r) and want in mws and r.get("status") == "enabled"
    route_fail |= 0 if ok else 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name:<26} "
          f"{want if ok else (mws or 'NO SUCH ROUTER - did the template void the file?')}")

# The one session on this box that provably lacks `editor` is no session at all.
# The path is deliberately a file that does NOT exist: if the gate were open this
# probe must not be the thing that destroys something, and the 404 it would get
# instead is itself the tell - a 404 means the request reached the service, which
# means the edge let an anonymous delete through.
r = requests.post(f"{BASE}/-/api/files/delete",
                  json={"root": "notes", "path": "_authz-probe-no-such-file.md"},
                  timeout=10)
ok = r.status_code in (401, 403)
route_fail |= 0 if ok else 1
print(f"  {'PASS' if ok else 'FAIL'}  anonymous /delete is refused   "
      f"got {r.status_code}"
      f"{' - it reached the SERVICE, the edge is not gating it' if r.status_code == 404 else ''}")

sys.exit(rc if rc else route_fail)
