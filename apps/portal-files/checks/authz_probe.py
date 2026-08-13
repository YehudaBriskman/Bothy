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
"""
import os
import re
import sys
import urllib.parse
import requests

BASE = "http://100.117.176.85"
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
    sys.exit(0)
elif held == 202 and not_held == 202:
    print("  VERDICT: allowed_groups IS IGNORED - a role-gated route would be")
    print("           open to ANY logged-in user. Do NOT build on this.")
    print("           Fall back to one oauth2-proxy instance per role.")
    sys.exit(1)
else:
    print(f"  VERDICT: unexpected. editor={held} shell={not_held} bogus={bogus}")
    sys.exit(2)
