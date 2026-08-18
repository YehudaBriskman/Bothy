#!/usr/bin/env python3
"""Where this box is, and where its files are - resolved, not written down.

Every check in this directory used to open by writing down two answers - this
node's literal tailnet address, and a literal path under one person's home
directory - which made the whole suite unrunnable by anyone else and put that
address into a public repository twelve times over. scripts/checks/portability.sh
counts exactly that, and this file is deliberately written so that it does not
add to the count itself: the old values are described here, never quoted.

This module is the single place those answers are worked out, so there is one
thing to fix when the box moves rather than twelve.

WHY A MODULE AND NOT AN EXPORTED ENVIRONMENT. The checks are run directly
(`python3 checks/e2e.py`) as often as through run.sh, and a check that only works
when its wrapper has already exported six variables is a check people stop
running. Everything below has a default that is correct on an unconfigured
machine, and nothing here requires the caller to have done anything.

Nothing in here is a policy decision - the values mirror what
apps/portal-files/compose.yml already mounts, deliberately. If a name here
disagrees with a name there, the container and the check are looking at two
different directories and every assertion becomes a coin toss.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import urllib.parse
from pathlib import Path

# ---------------------------------------------------------------------------
# The repository root: DERIVED from this file, never declared.
#
# .../apps/portal-files/checks/env.py -> checks -> portal-files -> apps -> root,
# which is `parents[3]`. A configured STACKS_ROOT was the obvious alternative and
# it is worse in the one way that matters: a declared path can disagree with
# reality. After a `mv` or a clone under a different name the variable still
# points at the old location, the checks read a directory the service is not
# serving, and every "the write really landed" assertion fails somewhere far from
# the cause. A path derived from __file__ cannot be stale by construction.
#
# This is the same argument apps/portal-files/compose.yml makes for mounting
# `../..` instead of an absolute path - one repo, one rule.
STACKS = str(Path(__file__).resolve().parents[3])


def _dotenv(path: str) -> dict[str, str]:
    """The repo `.env`, parsed well enough for the handful of names below.

    Read HERE rather than left to the caller because run.sh already sets the
    precedent (`. "$HERE/../../../.env"`), and because a check invoked directly
    has no wrapper to do it. Not a full shell parser on purpose: this reads
    `KEY=value` lines and nothing else, so a `.env` containing command
    substitution is ignored rather than executed - the checks are not a reason
    to run arbitrary code from a file.
    """
    values: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except OSError:
        # No .env is normal - a fresh clone has not copied .env.example yet, and
        # every value below still resolves. Missing config must not be a crash.
        return values
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        key, sep, val = line.partition("=")
        if not sep:
            continue
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        values[key.strip()] = val
    return values


_ENV = _dotenv(os.path.join(STACKS, ".env"))

# And PUT IT IN THE ENVIRONMENT, because the checks read more out of .env than
# the names below: DEV_LOGIN_USER and DEV_LOGIN_PASSWORD are read straight from
# os.environ by six of them. run.sh already does this (`set -a; . .env`), so
# under the runner nothing changes - what changes is that `python3
# checks/e2e.py` on its own now works instead of dying on a KeyError, which is
# how these are run while something is being fixed.
#
# setdefault, never assignment: an explicitly exported variable is a deliberate
# override for one run and must outrank a committed file.
for _k, _v in _ENV.items():
    os.environ.setdefault(_k, _v)


def _conf(name: str, default: str = "") -> str:
    """A real environment variable beats the file, and the file beats nothing.

    That order and not the reverse: `BOTHY_BASE=... python3 checks/e2e.py` has to
    win over a committed default, or the override rung below is decorative.
    """
    val = os.environ.get(name) or _ENV.get(name) or ""
    return val.strip() or default


def _tailscale_ip() -> str:
    """This node's tailnet address, asked of tailscale rather than remembered.

    Guarded three ways because this runs on machines that have never heard of
    tailscale: shutil.which for "not installed", returncode for "installed but
    the daemon is down" (it exits non-zero and prints to stderr), and a timeout
    because a wedged tailscaled blocks instead of failing - the exact behaviour
    network/tailnet-troubleshooting.md was written about.
    """
    exe = shutil.which("tailscale")
    if not exe:
        return ""
    try:
        proc = subprocess.run([exe, "ip", "-4"], capture_output=True,
                              text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return ""
    if proc.returncode != 0:
        return ""
    # `tailscale ip -4` can print more than one address; the first is this node.
    addrs = proc.stdout.split()
    return addrs[0] if addrs else ""


def _box_host() -> str:
    """The host the portal answers on, in four rungs, most explicit first.

    1. $BOX_IP, from the environment or the repo .env. THE canonical name for
       this value already: auth/compose.yml builds Keycloak's KC_HOSTNAME, the
       oauth2-proxy redirect URI, the OIDC issuer and the cookie whitelist from
       it, and warns at length that they must all agree. Inventing a second name
       for the same address is precisely how they stop agreeing - the issuer in
       the token and the issuer oauth2-proxy expects differ by one letter and
       login fails with a message about neither.
    2. `tailscale ip -4`, for a box that has a tailnet but no .env yet. This is
       the same fallback `just urls` uses (justfile line 77), in the same order.
    3. 127.0.0.1, so a bare clone with nothing configured still runs the checks
       against a locally published portal instead of dying on a KeyError.
    """
    return _conf("BOX_IP") or _tailscale_ip() or "127.0.0.1"


# $BOTHY_BASE outranks all of the above and is a whole ORIGIN, not a host: CI and
# tunnels reach this service on a name and a port that no amount of IP resolution
# would ever produce (https://, a forwarded 8443, a hostname). Anything narrower
# than a full origin cannot express those.
_OVERRIDE = _conf("BOTHY_BASE").rstrip("/")

if _OVERRIDE:
    BASE = _OVERRIDE
    _split = urllib.parse.urlsplit(BASE)
    HOST = _split.hostname or "127.0.0.1"
    _SCHEME = _split.scheme or "http"
else:
    HOST = _box_host()
    BASE = f"http://{HOST}"
    _SCHEME = "http"

# The sandbox origin: the SAME host, port 8100. Same host and a different port is
# the entire point - the raw/archive endpoints are served from a second origin so
# the browser treats them as cross-origin, and a sandbox that shared BASE's
# origin would be no sandbox at all. Overridable separately because a tunnel that
# reaches BASE has no reason to also expose 8100 on the same name.
SANDBOX = _conf("BOTHY_SANDBOX").rstrip("/") or f"{_SCHEME}://{HOST}:8100"

# ---------------------------------------------------------------------------
# Host paths. Every name below is the one apps/portal-files/compose.yml already
# uses for the same mount, with the same default - see the WHY at the top.

# `${HOME_ROOT:-${HOME}}` -> /repos/home. The `home` root, and the parent the
# probe corpora are planted under (never inside a git repo - links_index.py's
# docstring explains what happened the time one was).
HOME_DIR = _conf("HOME_ROOT") or os.path.expanduser("~")

# `${NOTES_ROOT:-${HOME}/claude-notes}` -> /repos/notes. Outside the repository,
# so unlike STACKS it genuinely has to be configurable; a default rather than a
# requirement so an unedited .env still works.
NOTES = _conf("NOTES_ROOT") or os.path.join(HOME_DIR, "claude-notes")

# `${PROJECTS_ROOT:-${HOME}/projects}` -> /repos/projects, mounted `ro`.
PROJECTS = _conf("PROJECTS_ROOT") or os.path.join(HOME_DIR, "projects")

# `${STATE_ROOT:-${HOME}/.local/state}/bothy/trash` -> /var/lib/bothy/trash. The
# undo net: the checks read it directly to prove the bytes a save destroyed are
# really there, which a response field claiming `snapshot: true` cannot.
STATE = _conf("STATE_ROOT") or os.path.join(HOME_DIR, ".local", "state")
TRASH = os.path.join(STATE, "bothy", "trash")

# `./audit:/audit` in the same compose file, i.e. relative to the service
# directory - so it is derived from STACKS and not from HOME.
AUDIT_LOG = os.path.join(STACKS, "apps", "portal-files", "audit", "writes.log")


def _sh() -> str:
    """The same answers, as shell `export` lines, for the ONE check that is not
    python: checks/sandbox_escape.mjs.

    run.sh evals this in a subshell before running node, so the browser check
    reads the values out of process.env instead of resolving them a second time.
    Re-implementing the four rungs in javascript is the alternative and it is the
    worse one - two resolvers disagree eventually, and the first symptom would be
    a security check quietly probing the wrong origin and passing.

    Single quotes with the standard `'\\''` escape: a path can contain anything.
    """
    out = []
    for name, val in (("BOTHY_BASE", BASE), ("BOTHY_SANDBOX", SANDBOX),
                      ("NOTES_ROOT", NOTES), ("HOME_ROOT", HOME_DIR)):
        out.append("export %s='%s'" % (name, val.replace("'", "'\\''")))
    return "\n".join(out)


if __name__ == "__main__":
    import sys

    if "--sh" in sys.argv[1:]:
        print(_sh())
        raise SystemExit(0)

    # `python3 checks/env.py` prints what the suite is about to talk to. Worth a
    # main block: "the check failed" and "the check was pointed at the wrong box"
    # look identical from a failing assertion, and this separates them in one
    # command.
    rung = ("$BOTHY_BASE" if _OVERRIDE else
            "$BOX_IP" if _conf("BOX_IP") else
            "tailscale ip -4" if _tailscale_ip() else
            "127.0.0.1 fallback")
    print(f"BASE      {BASE}   (from {rung})")
    print(f"SANDBOX   {SANDBOX}")
    print(f"STACKS    {STACKS}   (derived from {__file__})")
    print(f"NOTES     {NOTES}")
    print(f"HOME_DIR  {HOME_DIR}")
    print(f"PROJECTS  {PROJECTS}")
    print(f"TRASH     {TRASH}")
    print(f"AUDIT_LOG {AUDIT_LOG}")
