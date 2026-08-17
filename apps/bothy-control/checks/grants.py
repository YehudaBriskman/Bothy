#!/usr/bin/env python3
"""The socket-proxy grants are what compose.yml claims they are.

Run: python3 checks/grants.py

Needs nothing running. It reads the shipped compose.yml and the shipped
guard.py, so it is runnable with the stack down and before the parent
integrates - which matters, because everything this file asserts is a property
you want to know is true BEFORE a POST=1 socket proxy starts.

── why this check exists at all ────────────────────────────────────────────

apps/portal/compose.yml already says the important thing: "deny-by-default is
the image's behaviour, but a socket proxy is the last place to trust a default
surviving an image bump. Say it out loud." Saying it out loud is a comment, and
a comment is not a check. This is the check.

It is not hypothetical. tecnativa/docker-socket-proxy:0.3.0 ships EVENTS=1,
PING=1 and VERSION=1 as image defaults - three families that are ON unless a
compose file turns them off. Read out of the image while writing this:

    docker image inspect tecnativa/docker-socket-proxy:0.3.0 \
      --format '{{range .Config.Env}}{{println .}}{{end}}'

So "we did not enable it" and "it is off" are different statements, and this
file only accepts the second.

── what it asserts ─────────────────────────────────────────────────────────

  the split      there are exactly two proxies and they have opposite grants
  read half      POST=0, so it can never mutate anything
  write half     CONTAINERS=0, so POST=1 cannot reach /containers/create
  EXEC           0 on both, stated explicitly, never left to a default
  families       nothing beyond the containers family is enabled anywhere
  socket         mounted :ro on both, and NOT mounted into bothy-control at all
  ports          no proxy publishes a host port
  names          compose's container_name values and guard.SEVERING agree
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)
sys.path.insert(0, HERE)

import guard  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


# compose.yml is read through checks/composeenv.py, which checks/transition.py
# also uses. Sharing the reader is deliberate: this file asserts what the grants
# ARE and transition.py starts real proxies with those grants and asserts what
# they DO, so the two must be looking at the same bytes read the same way.
from composeenv import block, container_name, env  # noqa: E402

READ, WRITE, SVC_NAME = "socket-read", "socket-write", "bothy-control"

# Every endpoint family the image gates, from its haproxy.cfg.template. Listed
# here rather than derived, so a family the image ADDS in a later version shows
# up as a name this file does not know rather than as a silent gap. The three
# granular POST flags are separate because they are not families.
FAMILIES = [
    "AUTH", "BUILD", "COMMIT", "CONFIGS", "CONTAINERS", "DISTRIBUTION", "EVENTS",
    "EXEC", "GRPC", "IMAGES", "INFO", "NETWORKS", "NODES", "PING", "PLUGINS",
    "SECRETS", "SERVICES", "SESSION", "SWARM", "SYSTEM", "TASKS", "VERSION",
    "VOLUMES",
]
GRANULAR = ["ALLOW_RESTARTS", "ALLOW_START", "ALLOW_STOP"]
# Defaults that are ON in the image. Leaving any of these unstated in a compose
# file is not "off", it is "on".
ON_BY_DEFAULT = {"EVENTS", "PING", "VERSION"}

r, w = env(READ), env(WRITE)

print("── the split: two proxies with opposite grants ─────────────────")
ok(bool(r) and bool(w), "both socket proxies declare an environment block")
ok(r.get("POST") == "0",
   "READ proxy POST=0 - the first haproxy rule denies every non-GET, so no "
   "allow line below it can make this proxy mutate anything")
ok(w.get("POST") == "1", "WRITE proxy POST=1 (the only one on this box)")
ok(r.get("CONTAINERS") == "1", "READ proxy CONTAINERS=1 (it must inspect)")
ok(w.get("CONTAINERS") == "0",
   "WRITE proxy CONTAINERS=0 - this is what makes POST=1 safe. At 1 it would "
   "also grant /containers/create, and a bind mount of / is root on this box")

print()
print("── EXEC, said out loud on both, never left to a default ────────")
for name, e in ((READ, r), (WRITE, w)):
    ok("EXEC" in e, f"{name} states EXEC explicitly")
    ok(e.get("EXEC") == "0", f"{name} EXEC=0 (container exec is root on this box)")

print()
print("── no family beyond containers is enabled, anywhere ────────────")
for name, e in ((READ, r), (WRITE, w)):
    for fam in FAMILIES:
        if fam == "CONTAINERS":
            continue
        ok(fam in e, f"{name} states {fam} explicitly"
           + (" (image default is 1)" if fam in ON_BY_DEFAULT else ""))
        ok(e.get(fam) == "0", f"{name} {fam}=0")

print()
print("── the granular POST flags are stated on both halves ───────────")
for g in GRANULAR:
    ok(r.get(g) == "0", f"READ proxy {g}=0 (inert under POST=0, stated anyway)")
    ok(w.get(g) == "1", f"WRITE proxy {g}=1 - the three verb paths, and only those")

print()
print("── the socket itself ───────────────────────────────────────────")
for name in (READ, WRITE):
    b = block(name)
    ok("/var/run/docker.sock:/var/run/docker.sock:ro" in b,
       f"{name} mounts the docker socket READ-ONLY")
    ok(not re.search(r"^    ports:", b, re.M),
       f"{name} publishes NO host port - it must never be reachable from the host")
    ok("controlsocknet" in b and "controlnet\n" not in b,
       f"{name} is on controlsocknet only - traefik cannot reach it")

svc = block(SVC_NAME)
ok("docker.sock" not in svc,
   "bothy-control mounts NO docker socket - it reaches the daemon only through "
   "the two proxies")
ok(not re.search(r"^    ports:", svc, re.M),
   "bothy-control publishes NO host port - reachability IS authorisation")
ok("no-new-privileges:true" in svc, "bothy-control cannot gain privileges")
ok('user: "1000:1000"' in svc, "bothy-control does not run as root")
ok("read_only: true" in svc, "bothy-control's own filesystem is read-only")

print()
print("── the names in guard.py and in compose.yml agree ──────────────")
#
# This is the failure a comment cannot prevent. guard.SEVERING refuses by NAME;
# if somebody renames a container here and not there, the deny list silently
# stops matching its own containers and nothing looks wrong.
for service in (SVC_NAME, READ, WRITE):
    cn = container_name(service)
    ok(bool(cn), f"{service} declares a container_name ({cn!r})")
    ok(cn in guard.SEVERING,
       f"{cn!r} is in guard.SEVERING - this service cannot stop its own path")

ok("traefik" in guard.SEVERING,
   "traefik is in guard.SEVERING - the request arrives through it")
ok(len(guard.SEVERING) == 4,
   f"guard.SEVERING is exactly the four containers on the request path, no more "
   f"({sorted(guard.SEVERING)})")

print()
print("── the verb allowlist is narrower than the proxy's grant ───────")
#
# The one place where "bounded by code you wrote" is literally true. The write
# proxy's ALLOW_RESTARTS regex is /containers/<name>/(stop|restart|kill) - one
# rule, three verbs, no way to split them by configuration. So `kill` is
# reachable at the proxy and refused only by guard.VERBS.
ok("kill" not in guard.VERBS,
   "kill is NOT in guard.VERBS - the proxy would pass it; this is the only gate")
ok(set(guard.VERBS) == {"restart", "stop", "start"},
   f"guard.VERBS is exactly the three: {guard.VERBS}")

print()
if fails:
    print(f"FAILURES: {len(fails)}")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print("all grant checks passed")
