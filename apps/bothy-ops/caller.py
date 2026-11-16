"""Who is asking: one identity object, one adapter per credential kind.   (decision D41)

docs/plans/thin-bothy/cli-and-control-plane.md section 1.8. v1api.py turns every request into a
`Caller` at the door; an operation sees only that object, never a header. A new way to log in is a
new adapter here and no change to any operation, the catalog or the web UI. Standard library only.

  kind     adapter            what vouches for it                               role
  -------  -----------------  ------------------------------------------------  -----------------------
  socket   socket()           the trusted local listener: reachability is       SOCKET_ROLE (a constant)
                              authorisation (SECURITY.md rule 2)
  session  session()          the edge's forward-auth result: oauth2-proxy's    the role the edge GATED
                              identity header, which the edge's *-deidentify    on: the matched router's
                              middleware deletes from a client first            sso-<role>, generated from
                                                                                the same catalog row
  token    token()            a verified bearer token - STUB: always refuses    (slice 2)
  system   system(role)       in-process host code (the night job); there is    given by the caller
                              no HTTP adapter for it, so a request never is one

The role is NEVER read from a request field. The edge forwards no role header today (only
X-Auth-Request-User/-Email/-Preferred-Username, bothy-gates.yml), so a session's role is what the
edge enforced for the route it matched, passed in by the caller of `from_request`; the socket's is a
constant. A header such as X-Bothy-Role is ignored by every adapter (checks pin it).

How the HTTP listener identifies itself (the one decision here): bothy-ops has ONE listener, :8097,
reachable only on opsnet (traefik + bothy-ops), and no /v1 router exists at the edge in slice 1
(D40). So a request with NO edge identity header is the trusted local channel -> kind `socket`. A
request WITH the identity header came through the edge -> kind `session`. The header can only move a
request from socket to session, which is the narrower grant (a socket-only op then refuses it); a
bearer `Authorization` header is always the token adapter, which refuses.
"""

from __future__ import annotations

from dataclasses import dataclass

KINDS = ("socket", "session", "token", "system")
EXPOSURES = ("socket", "session", "token")     # the channels an operation may list (system is not one)
EDGE_EXPOSURES = ("session", "token")          # the ones that need a router at the edge
SOCKET_ROLE = "viewer"                         # slice 1 is read-only: the local channel reads as a viewer


class Unauthenticated(Exception):
    """No credential this adapter accepts (v1api maps it to auth.unauthenticated, 401)."""


@dataclass(frozen=True)
class Caller:
    kind: str
    role: str
    scopes: tuple[str, ...] = ()
    token_id: str | None = None


def socket(_headers) -> Caller:
    return Caller("socket", SOCKET_ROLE)


def session(headers, edge_role: str) -> Caller:
    """`edge_role`: the role the edge's gate enforced on the matched route (never a request field)."""
    if not (headers.get("X-Auth-Request-User") or headers.get("X-Auth-Request-Email")):
        raise Unauthenticated("no edge identity on this request")
    return Caller("session", edge_role)


def token(_headers) -> Caller:
    raise Unauthenticated("bearer tokens are not accepted yet (they arrive with slice 2)")


def system(role: str) -> Caller:
    return Caller("system", role)


def from_request(headers, edge_role: str) -> Caller:
    """The Caller for one HTTP request, or Unauthenticated."""
    if headers.get("Authorization"):
        return token(headers)
    if headers.get("X-Auth-Request-User") or headers.get("X-Auth-Request-Email"):
        return session(headers, edge_role)
    return socket(headers)
