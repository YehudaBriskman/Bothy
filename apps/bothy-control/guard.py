#!/usr/bin/env python3
"""The boundary of Bothy Control, as a pure unit.

Nothing here does IO. That is the point: the entire question "may this request
happen at all" is answerable without a daemon, a network or a container, so
checks/test_guard.py can ask it several hundred times in a second with the stack
down. app.py may not decide anything this module has an opinion about.

Three things live here, and they are the three ways a request can be wrong:

  VERBS          it asked for something that is not one of the three
  valid_name()   it named the container in a way that is not a container name
  severed()      it named a container this service cannot report the outcome of

The first two are boundaries in the security sense. The third is not - it is a
refusal to make a promise this service cannot keep - and the long comment on it
says why that distinction matters.
"""

from __future__ import annotations

import re

# ── the allowlist ───────────────────────────────────────────────────────────
#
# A literal tuple, written out, never derived. The temptation is to build this
# from a dict of handlers or from the routes, and the reason to resist it is
# that a derived allowlist grows when the thing it is derived from grows: add a
# handler for something, and the allowlist quietly agrees. This one only grows
# when a person edits this line, and a person editing this line is exactly the
# review step the whole design is asking for.
#
# `kill` is NOT here, and it is the interesting omission because the socket
# proxy's ALLOW_RESTARTS flag grants it alongside stop and restart (see
# compose.yml - the two are one haproxy rule and cannot be separated). So the
# proxy would pass `kill` and this tuple is the only thing that refuses it.
# That is a fair summary of the whole service: the proxy is a coarse grant and
# this file is the fine one.
VERBS: tuple[str, ...] = ("restart", "stop", "start")

# ── what a container name is ────────────────────────────────────────────────
#
# Docker's own rule, from daemon/names.go: `[a-zA-Z0-9][a-zA-Z0-9_.-]+`. A
# 64-character hex ID matches it too, which is deliberate - the API accepts
# either and so does this.
#
# WHY THIS IS A HARD REFUSAL AND NOT A SANITISE. The name is interpolated into
# a URL path: /containers/<name>/restart. A name containing a slash or a `..`
# segment is not a weird name, it is a different request. Concretely,
#
#     container = "x/../../v1.48/containers/create"
#
# produces the path /containers/x/../../v1.48/containers/create/restart, and
# whether that stays a container-verb call depends entirely on which of haproxy,
# the daemon's mux and Go's net/http normalises `..` and when. That is a
# question with a different answer on every version bump of three separate
# components, so it is not a question this service asks. A name that is not a
# name is refused before a URL is built at all.
#
# Percent-encoding the name instead was considered and rejected for the same
# reason: `%2e%2e%2f` is decoded by haproxy's `path,url_dec` fetch before its
# allow rules run, so encoding would hide the traversal from the proxy's regex
# while the daemon still saw it. Encoding moves the ambiguity; refusing removes
# it.
#
# The 128-character ceiling is not Docker's (it has none) - it is here so that a
# megabyte of legal name characters cannot become a megabyte of URL.
_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")


class Refused(Exception):
    """A request this service will not perform, with the status to say it with."""

    def __init__(self, message: str, status: int = 403) -> None:
        super().__init__(message)
        self.status = status


# ── the containers this service will not stop or restart ────────────────────
#
# THE RULE IS MECHANICAL, NOT A TASTE JUDGEMENT, and that is the only reason a
# deny list belongs in a service rather than only in the UI.
#
#   A container is on this list if stopping it prevents THIS REQUEST from
#   completing and reporting its own outcome.
#
# That is derivable from the request path rather than argued, and it comes out
# at exactly four containers:
#
#   traefik                      the request arrives through it. Kill it and the
#                                response has nowhere to go - the daemon still
#                                performs the action, so the operator sees a
#                                network error and cannot tell whether it worked.
#   bothy-control                the process holding the request. It dies with
#                                the container, mid-response.
#   bothy-control-socket-read    every action begins with an inspect, which is
#                                what produces `from` and what canonicalises the
#                                name for the deny check below. Without it this
#                                service cannot answer anything.
#   bothy-control-socket-write   the POST is in flight through it.
#
# WHY THIS IS NARROWER THAN THE UI'S WARNING LIST. `consequenceOf` in
# apps/portal-next/web/src/lib/actions.ts warns about seven containers, and the
# other three - portal-next, portal-socket-proxy, portal-files, bothy-config,
# keycloak, oauth2-proxy - are deliberately NOT refused here. Stopping any of
# them degrades the interface, sometimes badly (stopping oauth2-proxy locks
# every gated tier until somebody opens a terminal), but the action completes
# and this service reports it truthfully. A truthful report of a decision an
# operator made on purpose is not this service's business to override. The UI
# says the sentence; the operator decides.
#
# The line, then, is: the UI warns about what you might regret, and the service
# refuses what it cannot describe. Those are different questions and conflating
# them is how a deny list turns into a list of things somebody once found scary,
# which drifts and which nobody can audit.
#
# WHY `start` IS EXEMPT. Starting something cannot remove a dependency - it is
# the recovery verb, and denying it would deny the recovery. `start traefik`
# when traefik is somehow down is unreachable for a different reason (the
# request could not have arrived), so the exemption costs nothing and the
# contract already agrees: consequenceOf() returns selfAffecting: false for
# every start.
#
# WHY THE OWN-PROXY ENTRIES ARE NOT MERELY THEORETICAL. `stop
# bothy-control-socket-write` is the one that is genuinely irrecoverable from
# the product: this service's only capability is through that proxy, so once it
# is stopped, `start` on it is unreachable too. A button whose effect is to
# delete the button is not a feature with a warning attached, it is a trap.
#
# THE NAMES MUST MATCH compose.yml's container_name VALUES. If they drift, this
# list silently stops matching and nothing looks wrong. checks/grants.py asserts
# the two agree, because that is the failure mode a comment cannot prevent.
SEVERING: dict[str, str] = {
    "traefik": (
        "the request arrived through Traefik, so stopping it would leave this "
        "action with no way to report what it did. Use a terminal: "
        "`docker restart traefik`."
    ),
    "bothy-control": (
        "this is the process handling the request. It cannot report an outcome "
        "it does not survive. Use a terminal."
    ),
    "bothy-control-socket-read": (
        "every action here begins by inspecting the container through this "
        "proxy. Stopping it leaves this service unable to answer at all. Use a "
        "terminal."
    ),
    "bothy-control-socket-write": (
        "this is the only path this service has to the Docker daemon. Stopping "
        "it means nothing here can start it again, including this. Use a "
        "terminal."
    ),
}


def check_verb(verb: str) -> str:
    """Return the verb, or refuse.

    404 rather than 400, because a verb is a PATH here (/control/<verb>) and the
    honest answer to an unrouted path is that it does not exist. The message
    names the allowlist rather than the verb, on bothy-config's reasoning: a
    caller guessing at verb names should learn what exists, not which of their
    guesses was closest.

    In production an unknown verb cannot reach this function - the edge declares
    exactly three exact Path() rules. That is precisely why the check is here as
    well: the day it becomes reachable is the day somebody widened a rule to
    PathPrefix, and this is what refuses on that day.
    """
    if verb not in VERBS:
        raise Refused(
            f"{verb!r} is not one of the three verbs - this service does "
            + ", ".join(VERBS)
            + " and nothing else",
            status=404,
        )
    return verb


def valid_name(container: object) -> str:
    """Return the name, or refuse. See _NAME_RE for why refusing, not escaping."""
    if not isinstance(container, str):
        raise Refused("container must be a string", status=400)
    if not container:
        raise Refused("container is required", status=400)
    if not _NAME_RE.match(container):
        raise Refused(
            "container must be a plain Docker name or id "
            "(letters, digits, and _ . - ; no slashes, no path segments)",
            status=400,
        )
    return container


def severed(container: str, verb: str) -> str | None:
    """The reason this verb on this container is refused, or None.

    Case-sensitive on purpose: Docker container names are case-sensitive, so a
    case-insensitive match here would refuse a legitimately different container
    named `Traefik`. There is no such container on this box and there never
    should be, but a deny list that refuses names it was not asked about is a
    deny list nobody can reason about.
    """
    if verb == "start":
        return None
    return SEVERING.get(container)
