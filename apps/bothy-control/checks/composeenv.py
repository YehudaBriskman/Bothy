#!/usr/bin/env python3
"""Read a compose file without a YAML dependency.

Shared by checks/grants.py and checks/transition.py, and the sharing is the
point rather than an economy. grants.py asserts what the socket-proxy grants
ARE; transition.py starts real proxies with those grants and asserts what they
DO. If the two read the compose file differently, one of them is proving
something about a file the other never saw, and the pair stops being a pair.

Why regex and not a parser: this service ships no third-party dependencies (see
app.py's header), and a check that needs one the container does not have is a
check that does not run on a fresh box. compose.yml's environment blocks are
flat `KEY: value` lines under a known service, which this reads correctly - and
a shape change it cannot handle surfaces as a missing key, which every caller
asserts on, rather than as a proxy reported safe because no keys were found.

── one reader, any file ────────────────────────────────────────────────────

The module-level functions still read THIS service's compose.yml and are
unchanged for their two callers. `Compose` is the same reader pointed at an
arbitrary path, which grants.py uses to sweep every compose file in the
repository for a socket proxy: the dangerous grant pair is a property of any
proxy anybody adds, not of the two this directory happens to own, and a check
that can only see its own file would report a clean boundary while a third proxy
next door held POST=1 and CONTAINERS=1 together.
"""
from __future__ import annotations

import os
import re

COMPOSE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "compose.yml")


class Compose:
    """One compose file, read once."""

    def __init__(self, path: str) -> None:
        self.path = path
        with open(path, encoding="utf-8") as fh:
            self.text = fh.read()

    def services(self) -> list[str]:
        """Every service key, and ONLY service keys.

        Scoped to the `services:` block rather than matched across the file,
        because `networks:` and `volumes:` have 2-space children too - a bare
        `^  (\S+):` would report `controlsocknet` as a service and then read an
        empty environment off it, which is the shape of a proxy reported safe
        because nothing was found.
        """
        m = re.search(r"^services:$", self.text, re.M)
        if not m:
            return []
        rest = self.text[m.end():]
        nxt = re.search(r"^\S", rest, re.M)
        body = rest[: nxt.start()] if nxt else rest
        return re.findall(r"^  ([A-Za-z0-9][A-Za-z0-9._-]*):\s*$", body, re.M)

    def block(self, service: str) -> str:
        """The lines of one service, from its 2-space key to the next top-level key."""
        m = re.search(rf"^  {re.escape(service)}:$", self.text, re.M)
        if not m:
            raise SystemExit(f"FAIL: no service {service!r} in {self.path}")
        rest = self.text[m.end():]
        nxt = re.search(r"^(  \S|\S)", rest, re.M)
        return rest[: nxt.start()] if nxt else rest

    def env(self, service: str) -> dict[str, str]:
        """The environment mapping of one service, comments stripped."""
        b = self.block(service)
        m = re.search(r"^    environment:$", b, re.M)
        if not m:
            return {}
        rest = b[m.end():]
        nxt = re.search(r"^    \S", rest, re.M)
        body = rest[: nxt.start()] if nxt else rest
        out: dict[str, str] = {}
        for line in body.splitlines():
            line = line.split("#")[0]
            m2 = re.match(r"^      ([A-Z_][A-Z0-9_]*):\s*(\S*)\s*$", line)
            if m2:
                out[m2.group(1)] = m2.group(2)
        return out

    def container_name(self, service: str) -> str:
        m = re.search(r"^    container_name:\s*(\S+)", self.block(service), re.M)
        return m.group(1) if m else ""

    def image(self, service: str) -> str:
        m = re.search(r"^    image:\s*(\S+)", self.block(service), re.M)
        return m.group(1) if m else ""


# This service's own file, and the four functions its two callers already use.
CONTROL = Compose(COMPOSE)
TEXT = CONTROL.text
block = CONTROL.block
env = CONTROL.env
container_name = CONTROL.container_name
image = CONTROL.image
