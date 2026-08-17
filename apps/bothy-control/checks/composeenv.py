#!/usr/bin/env python3
"""Read the shipped compose.yml without a YAML dependency.

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
"""
from __future__ import annotations

import os
import re

COMPOSE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "compose.yml")

with open(COMPOSE, encoding="utf-8") as _fh:
    TEXT = _fh.read()


def block(service: str) -> str:
    """The lines of one service, from its 2-space key to the next top-level key."""
    m = re.search(rf"^  {re.escape(service)}:$", TEXT, re.M)
    if not m:
        raise SystemExit(f"FAIL: no service {service!r} in {COMPOSE}")
    rest = TEXT[m.end():]
    nxt = re.search(r"^(  \S|\S)", rest, re.M)
    return rest[: nxt.start()] if nxt else rest


def env(service: str) -> dict[str, str]:
    """The environment mapping of one service, comments stripped."""
    b = block(service)
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


def container_name(service: str) -> str:
    m = re.search(r"^    container_name:\s*(\S+)", block(service), re.M)
    return m.group(1) if m else ""


def image(service: str) -> str:
    m = re.search(r"^    image:\s*(\S+)", block(service), re.M)
    return m.group(1) if m else ""
