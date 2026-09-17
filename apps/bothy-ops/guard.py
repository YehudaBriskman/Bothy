#!/usr/bin/env python3
"""The boundary of bothy-ops, as a pure unit.

Nothing here does IO. That is the point: the entire question "may this request
happen at all" is answerable without a daemon, an apiserver, a network or a
container, so checks/test_guard.py can ask it several hundred times in a second
with the stack down. control.py and kube.py may not decide anything this module
has an opinion about.

bothy-ops is two tiers in one process since 2026-09 - Control (containers,
through the socket proxies) and Kube (cluster workloads, through the apiserver) -
and this is their ONE guard. The two halves share the refusal type and the name
rule's shape (bothy_common.names, always fullmatch) and nothing else.

── containers ───────────────────────────────────────────────────────────────

  VERBS            it asked for something that is not one of the three
  valid_container  it named the container in a way that is not a container name
  severed()        it named a container this service cannot report the outcome of

── cluster workloads ────────────────────────────────────────────────────────

  NAMESPACES       it named a namespace that is not one of the two
  valid_name()     it named a deployment/pod/container in a way that is not a
                   Kubernetes name (and therefore might be a path)
  load_catalog()   it asked for an action the catalog does not declare, or the
                   catalog itself declares something malformed
  check_params()   a parameter the action does not take, or out of its bounds
  check_confirm()  it skipped the confirmation the action's level demands

The catalog is DATA and the handlers are CODE, and neither may grow alone:
every id in catalog.toml must map to a handler written out by hand in kube.py,
and every handler must be declared in it. check_handlers() refuses to start the
service when the two disagree, in either direction.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from bothy_common import names
from bothy_common.http import Refused

__all__ = ["Refused"]  # re-exported: every caller catches guard.Refused

# ══ containers ═══════════════════════════════════════════════════════════════

# ── the allowlist ───────────────────────────────────────────────────────────
#
# A literal tuple, written out, never derived. A derived allowlist grows when the
# thing it is derived from grows: add a handler, and the allowlist quietly
# agrees. This one only grows when a person edits this line, and a person
# editing this line is exactly the review step the whole design is asking for.
#
# `kill` is NOT here, and it is the interesting omission because the write
# socket proxy's ALLOW_RESTARTS flag grants it alongside stop and restart (see
# apps/bothy/socket-proxy.yml - the two are one haproxy rule and cannot be
# separated). So the proxy would pass `kill` and this tuple is the only thing
# that refuses it: the proxy is a coarse grant and this file is the fine one.
VERBS: tuple[str, ...] = ("restart", "stop", "start")


def valid_container(container: object) -> str:
    """Return the name, or refuse (400).

    The name is interpolated into /containers/<name>/<verb>. Concretely,
    `x/../../v1.48/containers/create` would produce a path whose meaning depends
    on which of haproxy, the daemon's mux and Go's net/http normalises `..` and
    when - so it is refused before a URL is built. Percent-encoding was rejected
    too: haproxy's `path,url_dec` decodes `%2e%2e%2f` before its allow rules run,
    hiding the traversal from the proxy while the daemon still saw it.
    """
    return names.check(container, names.DOCKER_NAME, what="container",
                       rule=names.DOCKER_RULE)


# ── the containers this service will not stop or restart ────────────────────
#
# THE RULE IS MECHANICAL, NOT A TASTE JUDGEMENT, and that is the only reason a
# deny list belongs in a service rather than only in the UI.
#
#   A container is on this list if stopping it prevents THIS REQUEST from
#   completing and reporting its own outcome.
#
# That is derivable from the request path, and it comes out at exactly four:
#
#   traefik             the request arrives through it. Kill it and the response
#                       has nowhere to go - the daemon still performs the action,
#                       so the operator sees a network error and cannot tell
#                       whether it worked.
#   bothy-ops           the process holding the request. It dies with the
#                       container, mid-response.
#   bothy-socket-read   every action begins with an inspect, which is what
#                       produces `from` and what canonicalises the name for the
#                       deny check. Without it this service cannot answer.
#   bothy-socket-write  the POST is in flight through it - and it is the one that
#                       is genuinely irrecoverable from the product: once it is
#                       stopped, `start` on it is unreachable too. A button whose
#                       effect is to delete the button is a trap, not a feature.
#
# The names changed on 2026-09 (bothy-control, bothy-control-socket-read and
# -write became bothy-ops and bothy-socket-read/-write when the tiers merged).
# The old names are deliberately NOT kept here: SEVERING refuses by name, and a
# name that no longer runs anything is a refusal nobody can reason about.
#
# WHY THIS IS NARROWER THAN THE UI'S WARNING LIST. `consequenceOf` in
# apps/bothy-web/web/src/lib/actions.ts warns about more - bothy-web,
# bothy-files, keycloak, oauth2-proxy - and those are NOT refused here. Stopping
# them degrades the interface, but the action completes and this service reports
# it truthfully. The UI warns about what you might regret; the service refuses
# what it cannot describe.
#
# WHY `start` IS EXEMPT. Starting something cannot remove a dependency - it is
# the recovery verb, and denying it would deny the recovery.
#
# THE NAMES MUST MATCH the compose files' container_name values. If they drift,
# this list silently stops matching. checks/grants.py asserts they agree.
SEVERING: dict[str, str] = {
    "traefik": (
        "the request arrived through Traefik, so stopping it would leave this "
        "action with no way to report what it did. Use a terminal: "
        "`docker restart traefik`."
    ),
    "bothy-ops": (
        "this is the process handling the request. It cannot report an outcome "
        "it does not survive. Use a terminal."
    ),
    "bothy-socket-read": (
        "every action here begins by inspecting the container through this "
        "proxy. Stopping it leaves this service unable to answer at all. Use a "
        "terminal."
    ),
    "bothy-socket-write": (
        "this is the only path this service has to the Docker daemon. Stopping "
        "it means nothing here can start it again, including this. Use a "
        "terminal."
    ),
}


def check_verb(verb: str) -> str:
    """Return the verb, or refuse (404 - a verb is a PATH, /control/<verb>).

    In production an unknown verb cannot reach this - the edge declares exactly
    three exact Path() rules. That is precisely why the check is here as well:
    the day it becomes reachable is the day somebody widened a rule to
    PathPrefix, and this is what refuses on that day. The message names the
    allowlist, so a caller guessing learns what exists, not which guess was close.
    """
    if verb not in VERBS:
        raise Refused(
            f"{verb[:64]!r} is not one of the three verbs - this service does "
            + ", ".join(VERBS)
            + " and nothing else",
            status=404,
        )
    return verb


def severed(container: str, verb: str) -> str | None:
    """The reason this verb on this container is refused, or None.

    Case-sensitive on purpose: Docker names are case-sensitive, and the
    canonicalisation in control.inspect() is what makes a case-only bypass
    impossible in practice.
    """
    if verb == "start":
        return None
    return SEVERING.get(container)


# ══ cluster workloads ════════════════════════════════════════════════════════

# ── the scope ───────────────────────────────────────────────────────────────
#
# A literal tuple, never derived - from the catalog, from the cluster's
# namespace list, from anything. It grows when a person edits this line AND
# k8s/rbac/bothy-kube.yaml (checks/wiring.py asserts the two name the same
# namespaces). `thales` (the production-shaped namespace) is deliberately NOT
# here, nor is anything cluster-scoped: there is no ClusterRole, so even a bug
# that widened this tuple would meet a 403 from the apiserver.
NAMESPACES: tuple[str, ...] = ("thales-dev", "thales-pre-prod")

ROLES = ("viewer", "operator")
CONFIRMS = ("none", "click", "type-name")
TARGETS = ("deployment", "namespace")
METHODS = ("GET", "POST")
PARAM_TYPES = ("int", "bool", "name")

# Keys a request carries that are NOT action parameters.
RESERVED = ("namespace", "deployment", "confirm")

# A query-string integer: digits only, no sign, no exponent, no whitespace.
_INT_RE = re.compile(r"[0-9]{1,6}")


class CatalogError(Exception):
    """The catalog is malformed. Raised at startup; the service does not start."""


@dataclass(frozen=True)
class Param:
    name: str
    type: str
    required: bool = False
    default: object = None
    min: int | None = None
    max: int | None = None


@dataclass(frozen=True)
class Action:
    id: str
    title: str
    target: str
    method: str
    role: str
    confirm: str
    stream: bool
    params: dict[str, Param] = field(default_factory=dict)


_ACTION_KEYS = {"title", "target", "method", "role", "confirm", "stream", "params"}
_PARAM_KEYS = {"type", "required", "default", "min", "max"}
_ID_RE = re.compile(r"[a-z][a-z0-9-]{0,39}")


def load_catalog(doc: dict) -> dict[str, Action]:
    """Parse and validate a catalog document (the result of tomllib.load).

    STRICT ON PURPOSE. An unknown key is an error, not ignored: a typo such as
    `rol = "viewer"` on an operator action would otherwise silently fall back to
    a default, and the one default that must never be reached by accident is the
    permissive one. So there are no defaults either - all must be written.
    """
    if not isinstance(doc, dict) or set(doc) != {"actions"}:
        raise CatalogError("catalog must contain exactly one table: [actions.<id>]")
    actions = doc["actions"]
    if not isinstance(actions, dict) or not actions:
        raise CatalogError("catalog declares no actions")

    out: dict[str, Action] = {}
    for aid, raw in actions.items():
        where = f"actions.{aid}"
        if not _ID_RE.fullmatch(aid):
            raise CatalogError(f"{where}: id must be lowercase letters, digits and '-'")
        if not isinstance(raw, dict):
            raise CatalogError(f"{where}: must be a table")
        extra = set(raw) - _ACTION_KEYS
        if extra:
            raise CatalogError(f"{where}: unknown keys {sorted(extra)}")
        for k in ("title", "target", "method", "role", "confirm", "stream"):
            if k not in raw:
                raise CatalogError(f"{where}: `{k}` is required (no defaults here)")
        if raw["target"] not in TARGETS:
            raise CatalogError(f"{where}: target must be one of {TARGETS}")
        if raw["method"] not in METHODS:
            raise CatalogError(f"{where}: method must be one of {METHODS}")
        if raw["role"] not in ROLES:
            raise CatalogError(f"{where}: role must be one of {ROLES}")
        if raw["confirm"] not in CONFIRMS:
            raise CatalogError(f"{where}: confirm must be one of {CONFIRMS}")
        if not isinstance(raw["stream"], bool) or not isinstance(raw["title"], str):
            raise CatalogError(f"{where}: stream must be a bool and title a string")

        # The coupling rules, which are the security half of the file format. A
        # change is POST and operator; a read is GET and viewer. A GET that
        # changes something is a CSRF hole by construction (an <img> tag can
        # issue it), and an operator action with confirm = "none" is a button
        # with no second thought on the one kind of button that needs one.
        if raw["role"] == "operator" and raw["method"] != "POST":
            raise CatalogError(f"{where}: an operator action must be POST")
        if raw["role"] == "viewer" and raw["method"] != "GET":
            raise CatalogError(f"{where}: a viewer action must be GET (a read)")
        if raw["role"] == "operator" and raw["confirm"] == "none":
            raise CatalogError(f"{where}: an operator action must confirm (click or type-name)")
        if raw["stream"] and raw["method"] != "GET":
            raise CatalogError(f"{where}: only a GET can stream")

        params: dict[str, Param] = {}
        for pname, p in (raw.get("params") or {}).items():
            pwhere = f"{where}.params.{pname}"
            if pname in RESERVED or not _ID_RE.fullmatch(pname):
                raise CatalogError(f"{pwhere}: reserved or malformed parameter name")
            if not isinstance(p, dict):
                raise CatalogError(f"{pwhere}: must be a table")
            extra = set(p) - _PARAM_KEYS
            if extra:
                raise CatalogError(f"{pwhere}: unknown keys {sorted(extra)}")
            ptype = p.get("type")
            if ptype not in PARAM_TYPES:
                raise CatalogError(f"{pwhere}: type must be one of {PARAM_TYPES}")
            required = p.get("required", False)
            if not isinstance(required, bool):
                raise CatalogError(f"{pwhere}: required must be a bool")
            lo, hi, default = p.get("min"), p.get("max"), p.get("default")
            if ptype == "int":
                # An int with no bounds is an unbounded int, and "scale to 10000"
                # is exactly the request the bounds are for. Both are mandatory.
                if not (_is_int(lo) and _is_int(hi)) or lo < 0 or lo > hi:
                    raise CatalogError(f"{pwhere}: an int needs integer min <= max, min >= 0")
                if default is not None and not (_is_int(default) and lo <= default <= hi):
                    raise CatalogError(f"{pwhere}: default outside [{lo}, {hi}]")
            else:
                if lo is not None or hi is not None:
                    raise CatalogError(f"{pwhere}: min/max only apply to int")
                if ptype == "bool" and default is not None and not isinstance(default, bool):
                    raise CatalogError(f"{pwhere}: default must be a bool")
                if ptype == "name" and default is not None:
                    raise CatalogError(f"{pwhere}: a name parameter takes no default")
            if required and default is not None:
                raise CatalogError(f"{pwhere}: required and default are contradictory")
            params[pname] = Param(pname, ptype, required, default, lo, hi)

        out[aid] = Action(aid, raw["title"], raw["target"], raw["method"], raw["role"],
                          raw["confirm"], raw["stream"], params)
    return out


def check_handlers(catalog_ids: set[str] | list[str], handler_ids: set[str] | list[str]) -> None:
    """Refuse to start when the catalog and the hard-coded handlers disagree."""
    cat, han = set(catalog_ids), set(handler_ids)
    problems = []
    if cat - han:
        problems.append(f"catalog ids with no handler: {sorted(cat - han)}")
    if han - cat:
        problems.append(f"handlers the catalog does not declare: {sorted(han - cat)}")
    if problems:
        raise CatalogError("; ".join(problems))


def _is_int(v: object) -> bool:
    # bool is a subclass of int in Python; True must not pass as a replica count.
    return isinstance(v, int) and not isinstance(v, bool)


def check_action(catalog: dict[str, Action], aid: str) -> Action:
    """The action, or 404. The message names what exists, not the closest guess."""
    action = catalog.get(aid)
    if action is None:
        raise Refused(
            f"{aid[:64]!r} is not an action - this service does "
            + ", ".join(sorted(catalog)) + " and nothing else",
            status=404,
        )
    return action


def check_namespace(ns: object) -> str:
    if not isinstance(ns, str) or not ns:
        raise Refused("namespace is required", status=400)
    if ns not in NAMESPACES:
        # 403, not 400: the request is well-formed, it is the scope that says no.
        raise Refused(
            f"namespace {ns[:64]!r} is out of scope - bothy-ops acts on "
            + " and ".join(NAMESPACES) + " only",
            status=403,
        )
    return ns


def valid_name(v: object, what: str = "name") -> str:
    """A Kubernetes name, or 400. fullmatch - see bothy_common.names."""
    return names.check(v, names.K8S_NAME, what=what, rule=names.K8S_RULE)


def check_target(action: Action, req: dict) -> tuple[str, str]:
    """(namespace, target name). For a namespace action the target IS the namespace."""
    ns = check_namespace(req.get("namespace"))
    if action.target == "deployment":
        return ns, valid_name(req.get("deployment"), "deployment")
    if "deployment" in req:
        raise Refused(f"{action.id} acts on a namespace and takes no deployment", status=400)
    return ns, ns


def check_params(action: Action, req: dict) -> dict[str, object]:
    """Coerced parameters, defaults applied. Unknown keys are refused, not ignored.

    `req` is a JSON body (real types) or a query string flattened to one string
    per key (app.py refuses repeated keys first). Neither is trusted: `True` is
    not an int, `"3.0"` is not an int, `"yes"` is not a bool.
    """
    unknown = sorted(k for k in req if k not in RESERVED and k not in action.params)
    if unknown:
        raise Refused(
            f"{action.id} takes no parameter {unknown[0][:40]!r}"
            + (f" - it takes {', '.join(sorted(action.params))}" if action.params else ""),
            status=400,
        )
    out: dict[str, object] = {}
    for p in action.params.values():
        if p.name not in req:
            if p.required:
                raise Refused(f"{p.name} is required", status=400)
            out[p.name] = p.default
            continue
        raw = req[p.name]
        if p.type == "int":
            if _is_int(raw):
                val = raw
            elif isinstance(raw, str) and _INT_RE.fullmatch(raw):
                val = int(raw)
            else:
                raise Refused(f"{p.name} must be a whole number", status=400)
            assert p.min is not None and p.max is not None
            if not p.min <= val <= p.max:
                raise Refused(f"{p.name} must be between {p.min} and {p.max}", status=400)
            out[p.name] = val
        elif p.type == "bool":
            if isinstance(raw, bool):
                out[p.name] = raw
            elif raw in ("true", "1"):
                out[p.name] = True
            elif raw in ("false", "0"):
                out[p.name] = False
            else:
                raise Refused(f"{p.name} must be true or false", status=400)
        else:  # name
            out[p.name] = valid_name(raw, p.name)
    return out


def check_confirm(action: Action, req: dict, target: str) -> None:
    """Enforce `type-name` on the server as well as in the dialog.

    `click` is a property of the interface - a POST is already a click.
    `type-name` is different: if the service did not ask for the same string the
    dialog does, a forged or scripted request would skip the one step that level
    exists for.
    """
    if action.confirm != "type-name":
        if "confirm" in req:
            raise Refused(f"{action.id} takes no confirm field", status=400)
        return
    if req.get("confirm") != target:
        raise Refused(
            f"{action.id} must be confirmed by typing the name of what it acts on "
            f"(confirm must equal {target!r})",
            status=400,
        )


def check_request(catalog: dict[str, Action], aid: str, method: str,
                  req: dict) -> tuple[Action, str, str, dict[str, object]]:
    """Everything, in order. Returns (action, namespace, target, params)."""
    action = check_action(catalog, aid)
    if method != action.method:
        raise Refused(f"{aid[:64]} is {action.method}, not {method}", status=405)
    ns, target = check_target(action, req)
    params = check_params(action, req)
    check_confirm(action, req, target)
    return action, ns, target, params
