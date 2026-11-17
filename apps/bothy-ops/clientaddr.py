"""Who is the client behind the edge: the trusted-proxy rule for the failure rate limit.   (s1.9a)

Behind Traefik every TCP peer is Traefik's address on opsnet, so a limiter keyed on the peer is ONE
bucket for the whole tailnet (one noisy client locks everyone out). Traefik, on an entrypoint that
trusts no forwarded headers (the default; edge/compose.yml sets none, and checks/wiring_clientaddr.py
holds that), REPLACES X-Forwarded-For with the connecting address. This module honours that header, and
only under these conditions, otherwise it returns the peer:

  1. BOTHY_TRUSTED_PROXIES is set and the TCP peer is one of its entries. Unset or empty (the default) =
     NEVER honour the header, whatever it says. Entries, comma separated: an IP, a CIDR, or `@name` (a host
     name resolved lazily, cached 30 s, e.g. `@traefik` on opsnet; an unresolvable name trusts nobody).
  2. The request carries exactly ONE X-Forwarded-For field holding exactly ONE bare IPv4 or IPv6
     address: no list, no port, no brackets, no zone, no spaces inside, at most 45 characters. A list
     (a hop that appended instead of replaced) is rejected, not "take the last one": a rejected header
     falls back to the peer, which is the old, safe, shared bucket and never a spoofable one.

The key is the address, with IPv6 collapsed to its /64 (a client owns a /64, so rotating the low 64 bits
must not buy a fresh bucket) and an IPv4-mapped IPv6 address unmapped. Standard library only.
"""

from __future__ import annotations

import ipaddress
import socket
import time

HEADER = "X-Forwarded-For"
MAX_LEN = 45
TTL = 30.0

_nets: list = []          # ip_network objects
_names: list[str] = []    # `@name` entries
_cache: dict[str, tuple[float, set]] = {}


def configure(spec: str | None) -> None:
    """Parse BOTHY_TRUSTED_PROXIES. A bad entry is a startup error (ValueError), not a silent no-trust."""
    global _nets, _names
    nets, names = [], []
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        if part.startswith("@"):
            if not part[1:].replace("-", "").replace(".", "").replace("_", "").isalnum():
                raise ValueError(f"bad trusted-proxy name {part!r}")
            names.append(part[1:])
        else:
            nets.append(ipaddress.ip_network(part, strict=False))
    _nets, _names = nets, names
    _cache.clear()


def _unmap(a):
    return a.ipv4_mapped if a.version == 6 and a.ipv4_mapped else a


def _name_addrs(name: str, now: float) -> set:
    hit = _cache.get(name)
    if hit and now - hit[0] < TTL:
        return hit[1]
    try:
        found = {_unmap(ipaddress.ip_address(i[4][0].split("%")[0])) for i in socket.getaddrinfo(name, None)}
    except (OSError, ValueError):
        found = set()
    _cache[name] = (now, found)
    return found


def trusted(peer: str, now: float | None = None) -> bool:
    if not (_nets or _names):
        return False
    try:
        p = _unmap(ipaddress.ip_address(peer))
    except ValueError:
        return False
    if any(p in n for n in _nets if n.version == p.version):
        return True
    if _names:
        now = time.monotonic() if now is None else now
        return any(p in _name_addrs(n, now) for n in _names)
    return False


def parse_one(value: str | None):
    """The single bare address in `value`, or None (list, garbage, port, empty, oversized)."""
    if not isinstance(value, str) or not value or len(value) > MAX_LEN or value != value.strip():
        return None
    if any(c in value for c in ", []%/\t") or value.count(":") == 1:     # one colon is host:port
        return None
    try:
        a = _unmap(ipaddress.ip_address(value))
    except ValueError:
        return None
    if a.is_unspecified or a.is_multicast:
        return None
    return a


def key_of(a) -> str:
    if a.version == 6:
        return "v6:" + str(ipaddress.ip_network(f"{a}/64", strict=False))
    return str(a)


def source(peer: str, headers, now: float | None = None) -> str:
    """The limiter key for this request: the forwarded client if the peer is a trusted proxy and the
    header parses, else the peer itself (IPv6 peers collapse to /64 too)."""
    peer = peer or "-"
    if hasattr(headers, "get_all"):
        fields = headers.get_all(HEADER) or []
    else:
        fields = [headers[HEADER]] if headers.get(HEADER) is not None else []
    if fields and trusted(peer, now):
        a = parse_one(fields[0]) if len(fields) == 1 else None
        if a is not None:
            return key_of(a)
    try:
        return key_of(_unmap(ipaddress.ip_address(peer)))
    except ValueError:
        return peer[:64]
