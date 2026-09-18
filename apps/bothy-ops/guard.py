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
# apps/bothy/compose.socket-proxy.yml - the two are one haproxy rule and cannot be
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
# namespace list, from anything. It grows when a person edits this line; the
# Roles in k8s/rbac/bothy-kube.yaml are GENERATED from it (scripts/gen-ops-
# wiring.py), so the two cannot disagree. `thales` (the production-shaped
# namespace) is deliberately NOT here, nor is anything cluster-scoped: there is
# no ClusterRole, so even a bug that widened this tuple would meet a 403 from
# the apiserver.
NAMESPACES: tuple[str, ...] = ("thales-dev", "thales-pre-prod")

ROLES = ("viewer", "operator")
CONFIRMS = ("none", "click", "type-name")
METHODS = ("GET", "POST")
PARAM_TYPES = ("int", "bool", "name", "image", "configmap-key", "configmap-value")

# What a request names besides the namespace, and the request field that
# carries it. `namespace` names nothing else - the target IS the namespace.
TARGETS: dict[str, str | None] = {
    "namespace": None,
    "deployment": "deployment",
    "pod": "pod",
    "job": "job",
    "template": "template",
    "configmap": "configmap",
}

# Keys every request may carry that are NOT action parameters (plus the action's
# own target field, see _reserved()).
RESERVED = ("namespace", "confirm")

# Ids that are routes of their own, so no action may take the name.
RESERVED_IDS = ("catalog", "healthz")

# A query-string integer: digits only, no sign, no exponent, no whitespace.
_INT_RE = re.compile(r"[0-9]{1,6}")

# ── what an action may declare it needs from the cluster ────────────────────
#
# The Role is GENERATED from these declarations, so this table is where "what
# may bothy-ops' token ever be granted" is decided. A resource missing here
# cannot be declared at all (its API group is unknown, and guessing one is how a
# rule silently grants nothing - or the wrong thing).
RESOURCE_GROUPS: dict[str, str] = {
    "deployments": "apps",
    "replicasets": "apps",
    "pods": "",
    "events": "",
    "services": "",
    "configmaps": "",
    "persistentvolumeclaims": "",
    "resourcequotas": "",
    "limitranges": "",
    "jobs": "batch",
    "routes": "route.openshift.io",
    "ingresses": "networking.k8s.io",
    "networkpolicies": "networking.k8s.io",
}
SUBRESOURCES: dict[str, tuple[str, ...]] = {"deployments": ("scale",), "pods": ("log",)}

# Named so the refusal says WHY, not merely "unknown". Each of these is a way to
# a shell, a credential or the cluster itself.
FORBIDDEN_RESOURCES = {
    "secrets": "a Secret's values are credentials; bothy-ops reads none, in any form",
    "pods/exec": "a shell in a workload",
    "pods/attach": "a shell in a workload",
    "pods/portforward": "a tunnel into the cluster network",
    "pods/proxy": "a tunnel into the cluster network",
    "services/proxy": "a tunnel into the cluster network",
    "serviceaccounts/token": "minting credentials",
    "serviceaccounts": "identities",
    "namespaces": "cluster-scoped: creating or deleting a namespace",
    "nodes": "cluster-scoped",
    "roles": "RBAC changes", "rolebindings": "RBAC changes",
    "clusterroles": "RBAC changes", "clusterrolebindings": "RBAC changes",
}
VERBS_K8S = ("get", "list", "patch", "delete", "create")
FORBIDDEN_VERBS = {
    "*": "a wildcard grants verbs nobody reviewed",
    "watch": "reads are polled; a watch holds the apiserver open for a browser tab",
    "update": "a full replace; the handlers patch",
    "deletecollection": "one call deleting everything that matches",
    "escalate": "RBAC escalation", "bind": "RBAC escalation", "impersonate": "becoming someone else",
    "proxy": "a tunnel",
}
# The WRITE verbs, and the only resources each may name. A handler that needs a
# new pairing adds it here, in review, not in the catalog alone.
WRITES: dict[str, tuple[str, ...]] = {
    "patch": ("deployments", "deployments/scale", "configmaps"),
    "delete": ("pods", "jobs"),
    "create": ("jobs",),
}

# ── OCI image references ────────────────────────────────────────────────────
#
# The distribution/reference grammar, narrowed: lowercase path components, an
# optional host[:port] first, and a tag or digest REQUIRED - no implicit
# `:latest`, which would make "set the same image" mean a different image every
# pull. No `..` is possible (a separator needs an alphanumeric on each side), no
# whitespace, no scheme. Then, separately, a registry PREFIX allowlist from the
# catalog: the regex says "this is an image reference", the prefix says "and it
# is one of ours".
_COMPONENT = r"[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*"
# A registry host is only a host when it LOOKS like one - a dot, a port, or
# `localhost` - exactly the rule docker uses to tell `thales/backend` (a path on
# the default registry) from `ghcr.io/backend` (a host). Without that rule an
# uppercase first segment would parse as a "host" instead of failing.
_LABEL = r"[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?"
_DOMAIN = (rf"(?:(?:localhost|{_LABEL}(?:\.{_LABEL})+)(?::[0-9]{{1,5}})?"
           rf"|{_LABEL}:[0-9]{{1,5}})")
IMAGE_RE = re.compile(
    rf"(?:{_DOMAIN}/)?{_COMPONENT}(?:/{_COMPONENT})*"
    r"(?::(?P<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?"
    r"(?:@(?P<digest>sha256:[a-f0-9]{64}))?"
)
IMAGE_MAX = 255
CONFIG_VALUE_MAX = 256


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
class Grant:
    """One `rbac` declaration: what a handler calls."""
    resource: str            # "deployments" or "deployments/scale"
    group: str
    verbs: tuple[str, ...]


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
    meaning: str = ""
    rbac: tuple[Grant, ...] = ()


@dataclass(frozen=True)
class ConfigKey:
    key: str
    source: str              # the pattern as written, for the UI
    pattern: re.Pattern[str]
    meaning: str


@dataclass(frozen=True)
class Policy:
    configmaps: tuple[str, ...] = ()
    image_registries: tuple[str, ...] = ()
    job_templates: tuple[str, ...] = ()
    configmap_keys: dict[str, ConfigKey] = field(default_factory=dict)


class Catalog(dict):
    """id -> Action, plus the allowlists the parameters are checked against.

    A dict so every caller that treated the catalog as a mapping of actions
    still does; the policy rides along as an attribute.
    """
    policy: Policy = Policy()


_ACTION_KEYS = {"title", "meaning", "target", "method", "role", "confirm", "stream", "params", "rbac"}
_PARAM_KEYS = {"type", "required", "default", "min", "max"}
_TOP_KEYS = {"actions", "configmaps", "image_registries", "job_templates", "configmap_keys"}
_ID_RE = re.compile(r"[a-z][a-z0-9-]{0,39}")
_CM_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]{0,62}")
_PREFIX_RE = re.compile(r"(?:[a-z0-9.-]+(?::[0-9]{1,5})?/)?[a-z0-9]+(?:[._-][a-z0-9]+)*/")


def _str_list(doc: dict, key: str, check) -> tuple[str, ...]:
    v = doc.get(key, [])
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v) or len(set(v)) != len(v):
        raise CatalogError(f"{key} must be a list of distinct strings")
    for x in v:
        if not check(x):
            raise CatalogError(f"{key}: {x!r} is malformed")
    return tuple(v)


def _policy(doc: dict) -> Policy:
    cms = _str_list(doc, "configmaps", lambda x: names.K8S_NAME.fullmatch(x) is not None)
    regs = _str_list(doc, "image_registries", lambda x: _PREFIX_RE.fullmatch(x) is not None)
    tpls = _str_list(doc, "job_templates", lambda x: names.K8S_NAME.fullmatch(x) is not None)
    raw_keys = doc.get("configmap_keys", {})
    if not isinstance(raw_keys, dict):
        raise CatalogError("configmap_keys must be a table of [configmap_keys.<KEY>]")
    keys: dict[str, ConfigKey] = {}
    for k, v in raw_keys.items():
        where = f"configmap_keys.{k}"
        if not _CM_KEY_RE.fullmatch(k):
            raise CatalogError(f"{where}: not a ConfigMap key")
        if not isinstance(v, dict) or set(v) != {"pattern", "meaning"}:
            raise CatalogError(f"{where}: needs exactly `pattern` and `meaning`")
        if not isinstance(v["pattern"], str) or not v["pattern"] or not isinstance(v["meaning"], str):
            raise CatalogError(f"{where}: pattern and meaning must be strings")
        try:
            pat = re.compile(v["pattern"])
        except re.error as e:
            raise CatalogError(f"{where}: pattern does not compile ({e})") from None
        # A pattern that accepts a newline or the empty string is not a value
        # rule; it is a hole in one.
        if pat.fullmatch("") or pat.fullmatch("\n") or any(pat.fullmatch(s) for s in ("a\nb", " ")):
            raise CatalogError(f"{where}: pattern must not accept an empty, blank or multi-line value")
        keys[k] = ConfigKey(k, v["pattern"], pat, v["meaning"])
    return Policy(cms, regs, tpls, keys)


def _grants(where: str, raw: object, role: str) -> tuple[Grant, ...]:
    if not isinstance(raw, list) or not raw:
        raise CatalogError(f"{where}: `rbac` must be a non-empty list of {{resource, verbs, subresource?}}")
    out = []
    for g in raw:
        if not isinstance(g, dict) or not set(g) <= {"resource", "subresource", "verbs"} \
                or "resource" not in g or "verbs" not in g:
            raise CatalogError(f"{where}: an rbac entry is {{resource, verbs, subresource?}}")
        res, sub, verbs = g["resource"], g.get("subresource"), g["verbs"]
        if not isinstance(res, str) or (sub is not None and not isinstance(sub, str)):
            raise CatalogError(f"{where}: resource and subresource must be strings")
        full = f"{res}/{sub}" if sub else res
        if full in FORBIDDEN_RESOURCES or res in FORBIDDEN_RESOURCES:
            why = FORBIDDEN_RESOURCES.get(full) or FORBIDDEN_RESOURCES[res]
            raise CatalogError(f"{where}: {full} is forbidden - {why}")
        if res not in RESOURCE_GROUPS:
            raise CatalogError(f"{where}: {res!r} is not a resource bothy-ops knows the API group of")
        if sub is not None and sub not in SUBRESOURCES.get(res, ()):
            raise CatalogError(f"{where}: {full} is not an allowed subresource")
        if not isinstance(verbs, list) or not verbs or not all(isinstance(v, str) for v in verbs):
            raise CatalogError(f"{where}: verbs must be a non-empty list of strings")
        for v in verbs:
            if v in FORBIDDEN_VERBS:
                raise CatalogError(f"{where}: verb {v!r} is forbidden - {FORBIDDEN_VERBS[v]}")
            if v not in VERBS_K8S:
                raise CatalogError(f"{where}: verb {v!r} is not one of {VERBS_K8S}")
            if v in WRITES and full not in WRITES[v]:
                raise CatalogError(f"{where}: {v} on {full} is not a write bothy-ops may hold "
                                   f"({v} only on {', '.join(WRITES[v])})")
            if v in WRITES and role != "operator":
                raise CatalogError(f"{where}: a viewer action may only get or list, not {v}")
        out.append(Grant(full, RESOURCE_GROUPS[res], tuple(sorted(set(verbs)))))
    return tuple(out)


def load_catalog(doc: dict) -> Catalog:
    """Parse and validate a catalog document (the result of tomllib.load).

    STRICT ON PURPOSE. An unknown key is an error, not ignored: a typo such as
    `rol = "viewer"` on an operator action would otherwise silently fall back to
    a default, and the one default that must never be reached by accident is the
    permissive one. So there are no defaults either - all must be written. The
    one exception is the policy lists, whose absence is the EMPTY allowlist, and
    an action that needs a list that is empty refuses to load.
    """
    if not isinstance(doc, dict) or "actions" not in doc or not set(doc) <= _TOP_KEYS:
        raise CatalogError("catalog must contain [actions.<id>] and only "
                           + ", ".join(sorted(_TOP_KEYS - {"actions"})) + " besides")
    actions = doc["actions"]
    if not isinstance(actions, dict) or not actions:
        raise CatalogError("catalog declares no actions")
    policy = _policy(doc)

    out = Catalog()
    out.policy = policy
    for aid, raw in actions.items():
        where = f"actions.{aid}"
        if not _ID_RE.fullmatch(aid):
            raise CatalogError(f"{where}: id must be lowercase letters, digits and '-'")
        if aid in RESERVED_IDS:
            raise CatalogError(f"{where}: {aid!r} is a route of its own, not an action")
        if not isinstance(raw, dict):
            raise CatalogError(f"{where}: must be a table")
        extra = set(raw) - _ACTION_KEYS
        if extra:
            raise CatalogError(f"{where}: unknown keys {sorted(extra)}")
        for k in ("title", "meaning", "target", "method", "role", "confirm", "stream", "rbac"):
            if k not in raw:
                raise CatalogError(f"{where}: `{k}` is required (no defaults here)")
        if raw["target"] not in TARGETS:
            raise CatalogError(f"{where}: target must be one of {tuple(TARGETS)}")
        if raw["method"] not in METHODS:
            raise CatalogError(f"{where}: method must be one of {METHODS}")
        if raw["role"] not in ROLES:
            raise CatalogError(f"{where}: role must be one of {ROLES}")
        if raw["confirm"] not in CONFIRMS:
            raise CatalogError(f"{where}: confirm must be one of {CONFIRMS}")
        if not isinstance(raw["stream"], bool) or not isinstance(raw["title"], str) \
                or not isinstance(raw["meaning"], str):
            raise CatalogError(f"{where}: stream must be a bool, title and meaning strings")

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
        if raw["target"] == "template" and not policy.job_templates:
            raise CatalogError(f"{where}: targets a template but job_templates is empty")
        if raw["target"] == "configmap" and not policy.configmaps:
            raise CatalogError(f"{where}: targets a configmap but configmaps is empty")

        grants = _grants(where, raw["rbac"], raw["role"])

        params: dict[str, Param] = {}
        own_field = TARGETS[raw["target"]]
        for pname, p in (raw.get("params") or {}).items():
            pwhere = f"{where}.params.{pname}"
            if pname in RESERVED or pname == own_field or not _ID_RE.fullmatch(pname):
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
                if ptype not in ("int", "bool") and default is not None:
                    raise CatalogError(f"{pwhere}: a {ptype} parameter takes no default")
            if required and default is not None:
                raise CatalogError(f"{pwhere}: required and default are contradictory")
            if ptype == "image" and not policy.image_registries:
                raise CatalogError(f"{pwhere}: an image parameter needs image_registries")
            if ptype == "configmap-key" and not policy.configmap_keys:
                raise CatalogError(f"{pwhere}: a configmap-key parameter needs [configmap_keys]")
            params[pname] = Param(pname, ptype, required, default, lo, hi)

        kinds = [q.type for q in params.values()]
        if "configmap-value" in kinds and kinds.count("configmap-key") != 1:
            raise CatalogError(f"{where}: a configmap-value parameter needs exactly one configmap-key "
                               "parameter to be checked against")
        if kinds.count("configmap-value") > 1:
            raise CatalogError(f"{where}: at most one configmap-value parameter")

        out[aid] = Action(aid, raw["title"], raw["target"], raw["method"], raw["role"],
                          raw["confirm"], raw["stream"], params, raw["meaning"], grants)
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


def catalog_json(catalog: Catalog) -> dict:
    """What GET /kube/catalog serves, and what the generator writes for `vite dev`.

    Everything the interface needs to draw a control and explain a refusal
    before the click - and nothing about the Role, which is the cluster's
    business and is published in the repository anyway.
    """
    pol = catalog.policy
    return {
        "namespaces": list(NAMESPACES),
        "actions": [
            {"id": a.id, "title": a.title, "meaning": a.meaning, "target": a.target,
             "method": a.method, "role": a.role, "confirm": a.confirm, "stream": a.stream,
             "params": {p.name: {k: v for k, v in (("type", p.type), ("required", p.required),
                                                   ("default", p.default), ("min", p.min),
                                                   ("max", p.max)) if v is not None}
                        for p in a.params.values()}}
            for a in catalog.values()
        ],
        "configmaps": list(pol.configmaps),
        "configmapKeys": {k.key: {"pattern": k.source, "meaning": k.meaning}
                          for k in pol.configmap_keys.values()},
        "imageRegistries": list(pol.image_registries),
        "jobTemplates": list(pol.job_templates),
    }


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


def valid_image(v: object, registries: tuple[str, ...], what: str = "image") -> str:
    """An OCI reference with a tag or digest, from an allowed registry - or refuse.

    400 for something that is not an image reference at all; 403 for a real
    reference from a registry outside the allowlist (well-formed, out of scope -
    the same split as a namespace).
    """
    if not isinstance(v, str) or not v:
        raise Refused(f"{what} is required", status=400)
    m = IMAGE_RE.fullmatch(v) if len(v) <= IMAGE_MAX else None
    if m is None:
        raise Refused(f"{what} must be an image reference like thales/backend:0.1.7 "
                      "(lowercase, no spaces, no scheme)", status=400)
    if not m.group("tag") and not m.group("digest"):
        raise Refused(f"{what} needs a tag or a digest - an implicit :latest is refused", status=400)
    if not any(v.startswith(r) for r in registries):
        raise Refused(f"{what} {v[:80]!r} is not from an allowed registry - bothy-ops sets images "
                      "from " + ", ".join(registries) + " only", status=403)
    return v


def check_target(action: Action, req: dict, policy: Policy) -> tuple[str, str]:
    """(namespace, target name). For a namespace action the target IS the namespace."""
    ns = check_namespace(req.get("namespace"))
    fld = TARGETS[action.target]
    if fld is None:
        return ns, ns
    name = valid_name(req.get(fld), fld)
    if action.target == "template" and name not in policy.job_templates:
        raise Refused(f"template {name!r} does not exist - bothy-ops runs "
                      + ", ".join(policy.job_templates) + " only", status=404)
    if action.target == "configmap" and name not in policy.configmaps:
        raise Refused(f"configmap {name!r} is out of scope - bothy-ops reads "
                      + ", ".join(policy.configmaps) + " only", status=403)
    return ns, name


def check_params(action: Action, req: dict, policy: Policy | None = None) -> dict[str, object]:
    """Coerced parameters, defaults applied. Unknown keys are refused, not ignored.

    `req` is a JSON body (real types) or a query string flattened to one string
    per key (kube.handle refuses repeated keys first). Neither is trusted: `True`
    is not an int, `"3.0"` is not an int, `"yes"` is not a bool.
    """
    policy = policy or Policy()
    allowed = set(RESERVED) | {TARGETS[action.target]} - {None}
    unknown = sorted(k for k in req if k not in allowed and k not in action.params)
    if unknown:
        raise Refused(
            f"{action.id} takes no parameter {unknown[0][:40]!r}"
            + (f" - it takes {', '.join(sorted(action.params))}" if action.params else ""),
            status=400,
        )
    out: dict[str, object] = {}
    # configmap-value is checked LAST: it is only meaningful against its key.
    ordered = sorted(action.params.values(), key=lambda q: q.type == "configmap-value")
    for p in ordered:
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
        elif p.type == "image":
            out[p.name] = valid_image(raw, policy.image_registries, p.name)
        elif p.type == "configmap-key":
            if not isinstance(raw, str) or raw not in policy.configmap_keys:
                shown = raw[:64] if isinstance(raw, str) else type(raw).__name__
                raise Refused(f"key {shown!r} is not one bothy-ops may change - it changes "
                              + ", ".join(policy.configmap_keys) + " only", status=403)
            out[p.name] = raw
        elif p.type == "configmap-value":
            key = next(out[q.name] for q in action.params.values() if q.type == "configmap-key")
            rule = policy.configmap_keys[key]  # type: ignore[index]
            if not isinstance(raw, str) or len(raw) > CONFIG_VALUE_MAX or not rule.pattern.fullmatch(raw):
                raise Refused(f"{key} must match {rule.source}", status=400)
            out[p.name] = raw
        else:  # name
            out[p.name] = valid_name(raw, p.name)
    return {p: out[p] for p in action.params}


def confirm_name(action: Action, target: str, params: dict[str, object]) -> str:
    """What `type-name` asks the operator to type: the target's name - or, for a
    configmap action that changes one key, that KEY. Typing `thales` for every
    key would be a confirmation that confirms nothing."""
    if action.target == "configmap":
        for p in action.params.values():
            if p.type == "configmap-key":
                return str(params[p.name])
    return target


def check_confirm(action: Action, req: dict, target: str, params: dict[str, object] | None = None) -> None:
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
    want = confirm_name(action, target, params or {})
    if req.get("confirm") != want:
        raise Refused(
            f"{action.id} must be confirmed by typing the name of what it acts on "
            f"(confirm must equal {want!r})",
            status=400,
        )


def check_request(catalog: dict[str, Action], aid: str, method: str,
                  req: dict) -> tuple[Action, str, str, dict[str, object]]:
    """Everything, in order. Returns (action, namespace, target, params)."""
    policy = getattr(catalog, "policy", None) or Policy()
    action = check_action(catalog, aid)
    if method != action.method:
        raise Refused(f"{aid[:64]} is {action.method}, not {method}", status=405)
    ns, target = check_target(action, req, policy)
    params = check_params(action, req, policy)
    check_confirm(action, req, target, params)
    return action, ns, target, params
