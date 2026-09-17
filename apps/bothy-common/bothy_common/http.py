"""The HTTP half every Bothy backend shares: server, JSON answer, CSRF, actor.

── none of these services authenticates anybody ─────────────────────────────

Authorisation happens at the edge: Traefik's forwardAuth asks oauth2-proxy
`/oauth2/auth?allowed_groups=<role>`, and a request that fails never reaches the
process. Putting authz in the service as well would be two places to get it
right and two to get it wrong. The consequence, which the socket proxy taught
first: REACHABILITY IS AUTHORISATION. Each backend publishes no host port and
sits on a network it shares with Traefik and nothing else (filesnet, opsnet).

Identity headers are for ATTRIBUTION, never permission - see actor().

── the CSRF gate, and why a service behind a login needs one ────────────────

The oauth2-proxy session cookie is sent to every port on this host, and a page
on the sandbox origin (:8100, where hostile SVG/PDF bytes are served) is
SAME-SITE with the portal. SameSite=lax therefore does NOT block a POST from
there to here. Two halves close it:

  * application/json is REQUIRED on a POST. That is the load-bearing half: a
    text/plain POST is a CORS-"simple" request and skips the preflight, while
    application/json forces one - and the preflight fails because these
    services send no CORS headers at all. (415)
  * Sec-Fetch-Site, when a browser sends it, must say same-origin or none. (403)

It matters most on bothy-ops: a forged write leaves a diff somebody can revert;
a forged `stop postgres` is over before anyone reads anything.
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


class Refused(Exception):
    """A request a service will not perform, with the status to say it with.

    ONE class for every tier, so the shared body/CSRF helpers below can refuse
    in a way each handler already catches. bothy-ops' guard re-exports it as
    guard.Refused.
    """

    def __init__(self, message: str, status: int = 403) -> None:
        super().__init__(message)
        self.status = status


def csrf_refusal(headers, method: str) -> Refused | None:
    """The CSRF refusal for this request, or None. See the module docstring.

    Content-Type first, then Sec-Fetch-Site, which is the order every tier used
    before they were merged - so a cross-site text/plain POST is still a 415.
    """
    if method == "POST":
        ctype = (headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return Refused("Content-Type must be application/json", status=415)
    site = headers.get("Sec-Fetch-Site")
    if site and site not in ("same-origin", "none"):
        return Refused(f"cross-origin requests are refused (Sec-Fetch-Site: {site})")
    return None


class JsonHandler(BaseHTTPRequestHandler):
    """BaseHTTPRequestHandler plus the four things every tier wrote by hand."""

    server_version = "bothy"
    # Sent on JSON answers when set. bothy-ops sets `no-store`: a cached action
    # result or a cached log tail is a lie about the present.
    cache_control: str | None = None

    @property
    def route(self) -> str:
        return urlparse(self.path).path

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if self.cache_control:
            self.send_header("Cache-Control", self.cache_control)
        # Same-origin JSON behind Traefik; never sniffed into anything else.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # noqa: A003
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def actor(self) -> str:
        """Who asked, for the audit line. NEVER for a decision.

        Falls back rather than failing: a missing header means a misconfigured
        edge, and losing the actor's name is not a reason to refuse a legitimate
        request. The edge deletes client-supplied X-Auth-Request-* before
        forwardAuth runs (the *-deidentify middlewares), so the only copy that
        arrives is oauth2-proxy's; if it were spoofable anyway the worst case is a
        wrong name in a log, because the decision was already made upstream.
        """
        return (self.headers.get("X-Auth-Request-Email")
                or self.headers.get("X-Auth-Request-User") or "unknown")

    def check_csrf(self, method: str) -> None:
        refusal = csrf_refusal(self.headers, method)
        if refusal is not None:
            raise refusal

    def read_json_object(self, max_body: int) -> dict:
        """The request body as a JSON object, or Refused.

        The ceiling is per endpoint and small on purpose: nothing but /write has
        a reason to accept a file-sized body.
        """
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length <= 0 or length > max_body:
            raise Refused("body missing or too large", status=413)
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise Refused("body must be JSON", status=400) from None
        if not isinstance(body, dict):
            raise Refused("body must be a JSON object", status=400)
        return body


def serve(port: int, handler: type[BaseHTTPRequestHandler], banner: str) -> None:
    sys.stderr.write(banner + "\n")
    ThreadingHTTPServer(("0.0.0.0", port), handler).serve_forever()
