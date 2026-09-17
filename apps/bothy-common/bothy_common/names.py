"""What a name is, for the two kinds of name Bothy interpolates into a URL.

Both backends build request paths out of names a browser sent:

    /containers/<name>/restart                                   (bothy-ops, docker)
    /apis/apps/v1/namespaces/<ns>/deployments/<name>/scale       (bothy-ops, kube)

A name containing a slash or a `..` segment is not a weird name, it is a
different request. So a name that is not a name is REFUSED before a URL exists -
never escaped: percent-encoding moves the ambiguity to whichever of haproxy, the
daemon's mux or Go's net/http decodes first, and that answer changes between
versions of three separate components.

── ALWAYS fullmatch() ───────────────────────────────────────────────────────

In Python `$` also matches just before a trailing newline, so
`re.compile(r"^[a-z]+$").match("frontend\\n")` SUCCEEDS. bothy-kube's
checks/test_guard.py caught that on its first run; bothy-control's guard.py had
the same `^...$` + `.match()` shape and accepted `"grafana\\n"` until the two
guards were merged onto this module (2026-09). The patterns below carry no
anchors at all, because fullmatch() is the anchor - there is no way to call
check() that does a prefix match.
"""

from __future__ import annotations

import re

from .http import Refused

# Docker's own rule, from daemon/names.go: `[a-zA-Z0-9][a-zA-Z0-9_.-]+`. A
# 64-character hex id matches too, which is deliberate - the API accepts either.
# The 128-character ceiling is not Docker's (it has none): it stops a megabyte of
# legal name characters becoming a megabyte of URL.
DOCKER_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}")
DOCKER_RULE = ("a plain Docker name or id "
               "(letters, digits, and _ . - ; no slashes, no path segments)")

# RFC 1123 LABEL: lowercase alphanumerics and '-', starting and ending
# alphanumeric, at most 63. Stricter than a Deployment needs (Kubernetes allows
# dots in a subdomain name) and that is the point: no dot means no `..`, no slash
# means no second path segment.
K8S_NAME = re.compile(r"[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?")
K8S_RULE = ("a Kubernetes name (lowercase letters, digits and '-', "
            "at most 63; no dots, no slashes)")


def check(value: object, pattern: re.Pattern[str], *, what: str, rule: str) -> str:
    """Return the value, or raise Refused(400). Refuses; never sanitises."""
    if not isinstance(value, str):
        raise Refused(f"{what} must be a string", status=400)
    if not value:
        raise Refused(f"{what} is required", status=400)
    if not pattern.fullmatch(value):
        raise Refused(f"{what} must be {rule}", status=400)
    return value
