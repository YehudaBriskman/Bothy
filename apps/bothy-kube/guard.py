#!/usr/bin/env python3
"""The boundary of bothy-kube, as a pure unit.

Nothing here does IO, on bothy-control's reasoning: "may this request happen at
all" is answerable without an apiserver, a token or a container, so
checks/test_guard.py can ask it hundreds of times with the cluster off. app.py
may not decide anything this module has an opinion about.

The ways a request can be wrong, and where each is refused:

  NAMESPACES        it named a namespace that is not one of the two
  valid_name()      it named a deployment/pod/container in a way that is not a
                    Kubernetes name (and therefore might be a path)
  load_catalog()    it asked for an action the catalog does not declare, or the
                    catalog itself declares something malformed
  check_params()    it passed a parameter the action does not take, or one
                    outside its declared type and bounds
  check_confirm()   it skipped the confirmation the action's level demands

── the catalog is DATA, the handlers are CODE, and neither may grow alone ──

catalog.toml says what each action takes and who may ask. It cannot make
anything happen: every id in it must map to a handler written out by hand in
app.py, and every handler must be declared in it. check_handlers() refuses to
start the service when the two disagree, in either direction. So adding a line
to the catalog adds nothing until somebody writes the code, and writing code
reaches nothing until somebody declares it - two edits, each a review step.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# ── the scope ───────────────────────────────────────────────────────────────
#
# A literal tuple, never derived - from the catalog, from the cluster's
# namespace list, from anything. A derived allowlist grows when its source
# grows. This one grows when a person edits this line AND k8s/rbac/bothy-kube.yaml
# (checks/rbac.py asserts the two name the same namespaces), which is the review.
#
# `thales` (the production-shaped namespace) is deliberately NOT here. Nor is
# anything cluster-scoped: there is no ClusterRole, so even a bug that widened
# this tuple would meet a 403 from the apiserver rather than an action.
NAMESPACES: tuple[str, ...] = ("thales-dev", "thales-pre-prod")

ROLES = ("viewer", "operator")
CONFIRMS = ("none", "click", "type-name")
TARGETS = ("deployment", "namespace")
METHODS = ("GET", "POST")
PARAM_TYPES = ("int", "bool", "name")

# Keys a request carries that are NOT action parameters. Anything else in a
# request must be a parameter the catalog declares for that action.
RESERVED = ("namespace", "deployment", "confirm")

# ── what a name is ──────────────────────────────────────────────────────────
#
# RFC 1123 LABEL: lowercase alphanumerics and '-', starting and ending
# alphanumeric, at most 63 characters. Stricter than a Deployment strictly needs
# (Kubernetes allows dots in a subdomain name) and that is the point: no dot means
# no `..`, no slash means no second path segment, so a name interpolated into
#   /apis/apps/v1/namespaces/<ns>/deployments/<name>/scale
# can only ever be that one segment. Refused, never escaped - on bothy-control's
# reasoning that percent-encoding moves the ambiguity rather than removing it.
# Every workload on the target namespaces today is a plain label.
#
# ALWAYS .fullmatch(), NEVER .match(). In Python `$` also matches just before a
# trailing newline, so `_NAME_RE.match("frontend\n")` SUCCEEDS. checks/test_guard.py
# caught exactly that on its first run.
_NAME_RE = re.compile(r"^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$")

# An integer as a query string carries it: digits only, no sign, no exponent,
# no whitespace. JSON bodies carry real ints and never reach this.
_INT_RE = re.compile(r"^[0-9]{1,6}$")


class Refused(Exception):
    """A request this service will not perform, with the status to say it with."""

    def __init__(self, message: str, status: int = 403) -> None:
        super().__init__(message)
        self.status = status


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


# ── the catalog ─────────────────────────────────────────────────────────────

_ACTION_KEYS = {"title", "target", "method", "role", "confirm", "stream", "params"}
_PARAM_KEYS = {"type", "required", "default", "min", "max"}
_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,39}$")


def load_catalog(doc: dict) -> dict[str, Action]:
    """Parse and validate a catalog document (the result of tomllib.load).

    STRICT ON PURPOSE. An unknown key is an error, not ignored: a typo such as
    `rol = "viewer"` on an operator action would otherwise silently fall back to
    a default, and the one default that must never be reached by accident is
    the permissive one. So there are no permissive defaults either - role,
    confirm, method and target must all be written.
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

        # The coupling rules, which are the security half of the file format.
        #
        # A change is POST and requires operator; a read is GET and viewer. A
        # GET that changes something is a CSRF hole by construction (an <img>
        # tag can issue it), and an operator action with confirm = "none" is a
        # button with no second thought on the one kind of button that needs one.
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
    unhandled = sorted(cat - han)
    undeclared = sorted(han - cat)
    problems = []
    if unhandled:
        problems.append(f"catalog ids with no handler: {unhandled}")
    if undeclared:
        problems.append(f"handlers the catalog does not declare: {undeclared}")
    if problems:
        raise CatalogError("; ".join(problems))


def _is_int(v: object) -> bool:
    # bool is a subclass of int in Python; True must not pass as a replica count.
    return isinstance(v, int) and not isinstance(v, bool)


# ── a request ───────────────────────────────────────────────────────────────

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
            f"namespace {ns[:64]!r} is out of scope - bothy-kube acts on "
            + " and ".join(NAMESPACES) + " only",
            status=403,
        )
    return ns


def valid_name(v: object, what: str = "name") -> str:
    if not isinstance(v, str) or not v:
        raise Refused(f"{what} is required", status=400)
    if not _NAME_RE.fullmatch(v):
        raise Refused(
            f"{what} must be a Kubernetes name (lowercase letters, digits and '-', "
            "at most 63; no dots, no slashes)",
            status=400,
        )
    return v


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

    `req` is either a JSON body (real types) or a query string flattened to one
    string per key (app.py refuses repeated keys before this). Both are accepted
    for every type, and neither is trusted: `True` is not an int, `"3.0"` is not
    an int, `"yes"` is not a bool.
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

    `click` is a property of the interface and has nothing to check here - a
    POST is already a click. `type-name` is different: the UI makes the reader
    type the deployment's name, and if the service did not ask for the same
    string, a forged or scripted request would skip the one step that level
    exists for. It is cheap to require and it makes the level mean the same
    thing from curl as from the page.
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
        raise Refused(f"{aid} is {action.method}, not {method}", status=405)
    ns, target = check_target(action, req)
    params = check_params(action, req)
    check_confirm(action, req, target)
    return action, ns, target, params
