#!/usr/bin/env python3
"""The boundary as a pure unit. Needs nothing running - not even docker.

Run: python3 checks/test_guard.py

guard.py does no IO, which is what makes this possible and what makes it fast:
every question the service asks before touching the daemon is asked here a few
hundred times in well under a second, with the stack down and before the parent
integrates anything.

── what it asserts ─────────────────────────────────────────────────────────

  VERBS         the allowlist is exactly three, and every other verb - including
                the ones the socket proxy would happily pass - is refused
  NAMES         a container name that is not a plain container name is refused,
                with the path-traversal shapes enumerated rather than sampled
  SEVERING      stop and restart on the four self-severing containers are
                refused; start on them is not; everything else is allowed
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import guard  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}")
        fails.append(label)


def refuses(fn, *args, label: str = "", status: int | None = None) -> None:
    try:
        fn(*args)
    except guard.Refused as e:
        if status is not None and e.status != status:
            ok(False, f"{label} (refused, but {e.status} not {status})")
            return
        ok(True, f"{label} -> {e.status}")
        return
    ok(False, f"{label} (NOT REFUSED)")


def allows(fn, *args, label: str = "") -> None:
    try:
        fn(*args)
        ok(True, label)
    except guard.Refused as e:
        ok(False, f"{label} (refused: {e})")


print("── the verb allowlist is an allowlist, not a suggestion ────────")

ok(guard.VERBS == ("restart", "stop", "start"),
   f"exactly three verbs, in a literal tuple: {guard.VERBS}")

for v in guard.VERBS:
    allows(guard.check_verb, v, label=f"{v} is allowed")

# `kill` first and on its own line, because it is the one that would otherwise
# WORK. The write socket proxy's ALLOW_RESTARTS flag grants
# /containers/<name>/(stop|restart|kill) as a single haproxy regex - the three
# cannot be separated by configuration - so guard.VERBS is the only thing on
# this box that refuses it. If this assertion ever fails, a POST to
# /control/kill would reach the daemon and succeed.
refuses(guard.check_verb, "kill",
        label="kill is refused (the proxy WOULD pass it - this is the only gate)",
        status=404)

for v in ("exec", "create", "rm", "remove", "pause", "unpause", "update",
          "attach", "commit", "export", "rename", "resize", "wait", "prune",
          "Restart", "RESTART", "restart ", " restart", "restart/../kill",
          "restart?x=1", "", "json", "logs", "top", "stats", "archive",
          "changes", "kill?signal=SIGKILL"):
    refuses(guard.check_verb, v, label=f"verb {v!r} is refused", status=404)

print()
print("── a container name must be a container name ───────────────────")

for n in ("grafana", "postgres", "bothy-control-check-abc", "a1", "x",
          "portal_socket_proxy", "some.name-1.2", "A", "0",
          "9e4b9e7517a6" * 1 + "0" * 52):  # a 64-char id is a legal reference
    allows(guard.valid_name, n, label=f"{n[:24]!r} is a name")

# The traversal shapes, enumerated. Every one of these is a name that would be
# interpolated into /containers/<name>/restart and would stop being that
# request. `..` normalisation happens in haproxy, in the daemon's mux and in
# Go's net/http, at different times in different versions - so none of them are
# relied on, and all of these are refused before a URL exists.
for n in ("../etc/passwd",
          "..",
          ".",
          "a/../b",
          "x/../../v1.48/containers/create",
          "grafana/json",
          "grafana/../traefik",
          "/grafana",
          "grafana/",
          "//grafana",
          "grafana%2f..%2fcreate",     # would be url_dec'd by haproxy before its regex
          "%2e%2e%2fcreate",
          "grafana?x=1",
          "grafana#frag",
          "grafana restart",
          "grafana\nX",
          "grafana\ttab",
          "grafana\r\nSet-Cookie: x",
          "-leading-dash",             # docker's own rule: must start alnum
          "_leading-underscore",
          ".leading-dot",
          "a" * 129,                   # over the length ceiling
          "grafana\x00",
          "grafana;rm -rf /",
          "grafana|cat",
          "grafana`id`",
          "grafana$(id)",
          "café",                       # non-ASCII: docker will not create it
          "http://elsewhere/containers/x/create"):
    refuses(guard.valid_name, n, label=f"name {n[:36]!r} is refused", status=400)

refuses(guard.valid_name, None, label="a null container is refused", status=400)
refuses(guard.valid_name, 42, label="a numeric container is refused", status=400)
refuses(guard.valid_name, ["grafana"], label="a list container is refused", status=400)
refuses(guard.valid_name, {"name": "grafana"}, label="an object container is refused",
        status=400)

print()
print("── the self-severing set ───────────────────────────────────────")

SEVERING_EXPECTED = {"traefik", "bothy-control",
                     "bothy-control-socket-read", "bothy-control-socket-write"}
ok(set(guard.SEVERING) == SEVERING_EXPECTED,
   f"exactly the four containers on this request's own path: {sorted(guard.SEVERING)}")

for name in sorted(guard.SEVERING):
    for verb in ("stop", "restart"):
        ok(guard.severed(name, verb) is not None, f"{verb} {name} is refused")
    # start is the RECOVERY verb and is never refused - denying it would deny
    # the way back. The contract agrees: consequenceOf() returns
    # selfAffecting: false for every start.
    ok(guard.severed(name, "start") is None, f"start {name} is allowed")

# The containers the UI warns about but the service deliberately does NOT refuse.
# Stopping any of these degrades the interface; the action still completes and
# reports its own outcome truthfully, which is the line this service draws.
for name in ("portal-next", "portal-socket-proxy", "portal-files", "bothy-config",
             "keycloak", "oauth2-proxy", "grafana", "postgres"):
    for verb in guard.VERBS:
        ok(guard.severed(name, verb) is None,
           f"{verb} {name} is allowed (the UI warns; the service does not refuse)")

# Case sensitivity, asserted rather than assumed. Docker names are
# case-sensitive, so a case-insensitive deny list would refuse a legitimately
# different container - and the canonicalisation in app.inspect() is what makes
# a case-only bypass impossible in practice.
ok(guard.severed("Traefik", "stop") is None,
   "the deny list is case-sensitive (canonicalisation is what closes the gap)")

print()
if fails:
    print(f"FAILURES: {len(fails)}")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print("all guard checks passed")
