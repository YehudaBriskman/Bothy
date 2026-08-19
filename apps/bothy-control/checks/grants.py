#!/usr/bin/env python3
"""The socket-proxy grants are what compose.yml claims they are.

Run: python3 checks/grants.py

Needs nothing running. It reads the shipped compose.yml and the shipped
guard.py, so it is runnable with the stack down and before the parent
integrates - which matters, because everything this file asserts is a property
you want to know is true BEFORE a POST=1 socket proxy starts.

── why this check exists at all ────────────────────────────────────────────

apps/bothy/socket-proxy.yml already says the important thing: "deny-by-default is
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
  the repo       EVERY socket proxy in EVERY compose file here, not just these
                 two - see below for why that is a different question

── the sweep, and the issue that asked for it ──────────────────────────────

Issue #91 wants the console to start a service from a compose file it has never
run. Starting a container that EXISTS is /containers/<name>/start and needs
nothing new. Starting one that does not exist is /containers/create, and the
cheap way to reach that is one character: CONTAINERS: 0 -> 1 on the write proxy.
Nothing would look different. Worse, done on a THIRD proxy in another file,
every assertion above would still pass - they all name `socket-read` and
`socket-write` - and the box would be one bind mount of / away from root.

So the last section stops asking about those two by name and asks about every
service in the repository that runs the socket-proxy image: does any of them
hold POST=1 and CONTAINERS=1 together, and does any of them grant EXEC. Those
questions have an answer for a proxy nobody has written yet, which is the only
kind this file could not otherwise see.
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
from composeenv import Compose, block, container_name, env  # noqa: E402

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
# The uid became configurable so Bothy could be installed by somebody who is not
# uid 1000 - a macOS account is 501, a CI runner is 1001, and this service writes
# an audit log into a bind mount. That parameterisation must not quietly become a
# way to run the docker-socket client as root, so this checks BOTH halves: the
# form is the parameterised one, and its DEFAULT is not 0. bootstrap refuses to
# write PUID=0 for the same reason.
_user = re.search(r'^    user: "([^"]+)"', svc, re.M)
ok(bool(_user), f"bothy-control declares a user ({_user.group(1) if _user else None!r})")
if _user:
    spec = _user.group(1)
    ok(spec == '${PUID:-1000}:${PGID:-1000}',
       f"bothy-control's uid is configurable but pinned by default ({spec})")
    _default = re.match(r'^\$\{PUID:-(\d+)\}', spec)
    ok(bool(_default) and _default.group(1) != "0",
       "bothy-control does not run as root by default")
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
print("── every socket proxy in this repository, by image ─────────────")
#
# NOT by service name and NOT by directory. The two proxies above are found by
# the names this file already knows; a third one added anywhere in the tree is
# found by the only thing it cannot avoid having, which is its image line. That
# is what makes this section able to fail on code nobody has written yet.
#
# `.git` and `node_modules` are skipped: the first holds packed objects that are
# not YAML, the second is somebody else's dependency tree. Neither can define a
# container this box runs.
SOCKET_IMAGE = "tecnativa/docker-socket-proxy"
REPO = os.path.dirname(os.path.dirname(SVC))
# .claude holds AGENT WORKTREES - full copies of this repository - and
# .cleanup-trash is a quarantine of things already removed. Both contain compose
# files that define no container this box runs, and both would be swept: on a
# machine with seven worktrees this walk found 24 proxies instead of 3, so the
# assertion below printed a paragraph and a rogue definition in a throwaway copy
# would have failed CI for a file that is not part of the repository. Same two
# exclusions, for the same reason, as scripts/checks/portability.sh.
SKIP_DIRS = {".git", "node_modules", "dist", ".venv", ".claude", ".cleanup-trash"}

found: list[tuple[str, str, dict[str, str], str]] = []
for walk_root, walk_dirs, walk_files in os.walk(REPO):
    walk_dirs[:] = [d for d in walk_dirs if d not in SKIP_DIRS]
    for fn in sorted(walk_files):
        if not fn.endswith((".yml", ".yaml")):
            continue
        path = os.path.join(walk_root, fn)
        try:
            cf = Compose(path)
        except OSError:
            continue
        # The image name appears in prose in three other files - dependabot's
        # comment, portal-api.yml's, this one's - so the text match only decides
        # whether the file is worth parsing. What SELECTS a service is its own
        # `image:` line.
        if SOCKET_IMAGE not in cf.text:
            continue
        for service in cf.services():
            if not cf.image(service).startswith(SOCKET_IMAGE):
                continue
            found.append((os.path.relpath(path, REPO), service, cf.env(service),
                          cf.block(service)))

# A sweep that finds nothing reports "all clear", which is the silent pass this
# repo keeps rediscovering. The floor is the three proxies that exist today: the
# portal's read-only one and this service's pair. Fewer than three means the
# walk, the extension filter or the image match stopped working - not that the
# box got safer.
ok(len(found) >= 3,
   f"the sweep finds the socket proxies it is meant to find "
   f"({len(found)}: {', '.join(f'{f}:{sv}' for f, sv, _, _ in found)})")

for rel, service, e, blk in found:
    where = f"{rel}:{service}"
    # THE PAIR. Either flag alone is a proxy this repo already ships and trusts:
    # POST=1 with CONTAINERS=0 is four verb paths, CONTAINERS=1 with POST=0 is a
    # read-only inspect. TOGETHER they are every POST under /containers, because
    # the granular ALLOW_* lines are `allow` rules and the broad `^/containers`
    # rule sits below them with no deny in between - so /containers/create is
    # permitted, and a create with a bind mount of / is root on this box.
    ok(not (e.get("POST") == "1" and e.get("CONTAINERS") == "1"),
       f"{where} does not hold POST=1 and CONTAINERS=1 together - that pair "
       f"grants /containers/create (POST={e.get('POST')!r}, "
       f"CONTAINERS={e.get('CONTAINERS')!r})")
    # A proxy that says nothing about POST leaves its mutation surface to an
    # image default, which is the one thing this whole file refuses to accept.
    ok("POST" in e, f"{where} states POST explicitly")
    # CONTAINERS is 0 by default in the image, but "we did not enable it" and
    # "it is off" are different statements - and this is the flag whose absence
    # would make the pair check above pass for the wrong reason.
    ok("CONTAINERS" in e, f"{where} states CONTAINERS explicitly")
    ok(e.get("EXEC") == "0",
       f"{where} EXEC=0 - an exec into a container holding the docker socket is "
       f"a host root shell, and every proxy here holds it")
    ok("/var/run/docker.sock:/var/run/docker.sock:ro" in blk,
       f"{where} mounts the docker socket READ-ONLY")
    ok(not re.search(r"^    ports:", blk, re.M),
       f"{where} publishes NO host port - reachability IS authorisation")

print()
if fails:
    print(f"FAILURES: {len(fails)}")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print("all grant checks passed")
