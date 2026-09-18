"""The typed-lens API behind Bothy's config forms: /config/fields and /config/patch.

A form is a typed lens over a file. It is never a second store. Every
configurable thing on this box is a file in git; if a form wrote to a database
instead, the repository would stop describing the box, `git log` would stop being
its history, and a `git pull` would silently revert somebody's change. Everything
below follows from refusing that.

── why this is a MODULE of bothy-files now, and what that cost ──────────────

It was a separate service, bothy-config, until 2026-09, and the reason was one
sentence in bothy-files' header: no third-party dependencies, because that
container holds read-write mounts on two git repositories. A YAML round-tripper
is a dependency, so the parser lived elsewhere with a narrower mount.

The merge relaxes that doctrine ON PURPOSE, and SECURITY.md records it: ruamel.yaml
(pinned exactly, pure-Python, no C accelerator) is now the one third-party
package in bothy-files. What was traded for it: one container, one network, one
copy of safepath instead of a drifting derivative, and one audit mechanism. What
was NOT traded: this module's scope is still resolve_config() - one root, YAML
only, edge/dynamic/ unreachable, an exact field allowlist - so the dependency can
only ever be handed bytes from a file a form is allowed to change.

── editing is not applying ─────────────────────────────────────────────────

A patch changes a FILE, not a running container: a compose label is fixed at
container-creation time. The response says so - `applied: false` with a reason -
so the UI renders config drift rather than a spinner that lies.
"""

from __future__ import annotations

import os
import re
import tempfile

import yamlpatch
from bothy_common import safepath
from bothy_common.audit import AuditLog, flat
from bothy_common.http import Refused

# A patch body is a path, a field name and one form value. Sixty kilobytes is
# already absurd for that; this endpoint has no reason to accept a file-sized body.
MAX_BODY = 64_000

LOG = AuditLog(os.environ.get("CONFIG_AUDIT_LOG", "/audit/patches.log"))

# Whitespace at either end of a plain YAML scalar is stripped by the parser, so a
# value ending in a space would read back short and yamlpatch would refuse with
# "the value changed the document's structure" - true, and tells nobody
# anything. Caught here for the message, not for the guarantee.
_EDGE_SPACE = re.compile(r"^\s|\s$")


# EDITING IS NOT APPLYING, said per kind: what makes the change live differs.
APPLIED_NOTE = {
    "compose-label": (
        "written to the file. A compose label is read at "
        "container-creation time, so this takes effect when the "
        "service is recreated - that is operator work, not this "
        "service's."),
    "placement-rule": (
        "written to the file. The collector re-reads placement.yml on its next "
        "run (every 30 seconds), and the Overview follows on its next poll."),
}


def audit(who: str, action: str, res, field: str, service: str,
          old: str | None = None, new: str | None = None) -> None:
    """One line per change: who, what, which field on which service, old -> new.

        time  who  PATCHED|NOSNAPSHOT  root/relpath  service  field  ['old' -> 'new']

    It carries the OLD value, which the editor's log does not: a form write is
    one value inside a file nobody looked at, so "what did this say before" has
    no other answer short of digging the snapshot out of the trash.
    """
    suffix = ""
    if old is not None or new is not None:
        suffix = f"\t{flat(old)!r} -> {flat(new)!r}"
    LOG.write(who, action, f"{flat(res.root_key)}/{flat(res.relpath)}", service, field,
              suffix=suffix)


def read_text(res) -> tuple[str, int]:
    """The file's text and its mtime, through the same guarded open as everything.

    safe_open, not open(): O_NOFOLLOW closes the realpath()-to-open() window, and
    the size is checked on the same fd whose bytes are read.
    """
    fd, st = safepath.safe_open(res.abspath)
    if st.st_size > safepath.MAX_BYTES:
        os.close(fd)
        raise safepath.PathRefused("file too large to patch")
    with os.fdopen(fd, "rb") as fh:
        raw = fh.read()
    try:
        return raw.decode("utf-8"), int(st.st_mtime)
    except UnicodeDecodeError as e:
        raise safepath.PathRefused("file is not valid UTF-8") from e


def _limit(field: str) -> int:
    return min(int(safepath.CONFIG_FIELDS[field].get("max_length", safepath.CONFIG_MAX_VALUE)),
               safepath.CONFIG_MAX_VALUE)


def validate(field: object, value: object) -> str:
    """Refuse a value the policy does not allow. Returns it unchanged.

    Refuses rather than sanitising: silently trimming a hostile value into a
    legal one means an attack and a typo produce the same quiet success.
    """
    if not isinstance(field, str) or field not in safepath.CONFIG_FIELDS:
        # Names the allowlist rather than the field, so a caller guessing at
        # field names learns what exists instead of which guess was close.
        raise safepath.PathRefused(
            f"{str(field)[:64]!r} is not a patchable field - the policy declares "
            + ", ".join(sorted(safepath.CONFIG_FIELDS)))
    if not isinstance(value, str):
        raise safepath.PathRefused("value must be a string")
    limit = _limit(field)
    if len(value) > limit:
        raise safepath.PathRefused(f"value is longer than {limit} characters")
    if not value:
        # Deleting a field is a different act from changing it, and not one this
        # module offers: compose would keep an empty label and Bothy would render
        # a card with no title.
        raise safepath.PathRefused("value must not be empty")
    for ch in ("\n", "\r", "\t", "\0"):
        if ch in value:
            raise safepath.PathRefused(
                "value must not contain newlines, tabs or null bytes")
    if _EDGE_SPACE.search(value):
        raise safepath.PathRefused(
            "value must not start or end with whitespace - YAML would strip it")
    # The two sequences a PLAIN YAML scalar cannot carry. yamlpatch is the
    # guarantee (it re-parses its own output); these exist for the message.
    #   " #"  opens a COMMENT - the value silently reads back short.
    #   ": "  opens a MAPPING - the label stops being a string at all.
    # Quoting instead was rejected: it rewrites the whole label item, so the span
    # the locator proved literal is no longer the span being written.
    if " #" in value:
        raise safepath.PathRefused(
            "value must not contain ' #' - YAML would read the rest as a comment")
    if ": " in value or value.endswith(":"):
        raise safepath.PathRefused(
            "value must not contain ': ' or end with ':' - YAML would read it "
            "as a key")
    return value


def fields_in(res) -> dict:
    """What is patchable in this file, what it says now, and its mtime - in ONE read.

    A client that fetched values and mtime separately could read a file, have it
    change, then send a patch that passes the conflict check carrying the older
    value. One read, one stat, one answer.
    """
    text, mtime = read_text(res)
    fields = safepath.config_fields_for(res.relpath)
    sites = yamlpatch.locate(text, fields)
    return {
        "root": res.root_key,
        "path": res.relpath,
        "mtime": mtime,
        "fields": [
            {"field": s.field, "service": s.service, "value": s.value,
             "line": s.line, "kind": s.kind, "maxLength": _limit(s.field)}
            for s in sites
        ],
        "patchable": sorted(fields),
    }


def _errors(h, route: str, fn) -> None:
    """The config tier's status mapping, kept exactly as it was."""
    try:
        return fn()
    except Refused as e:
        return h._send(e.status, {"error": str(e)})
    except safepath.PathRefused as e:
        return h._send(403, {"error": str(e)})
    except yamlpatch.RewriteRefused as e:
        # 422: the request was well-formed and the caller is not at fault - the
        # FILE is in a shape a form will not change. The answer is Bothy Files.
        return h._send(422, {"error": str(e)})
    except FileNotFoundError:
        return h._send(404, {"error": "no such file"})


def handle_get(h, q: dict) -> None:
    """GET /config/fields?root=&path="""
    def run():
        # for_write on a READ, deliberately: a file the write path would refuse
        # must not be listed as though it had editable fields. A form that
        # renders and then 403s on submit is worse than one that never rendered.
        res = safepath.resolve_config(q.get("root", ""), q.get("path", ""), for_write=True)
        return h._send(200, fields_in(res))
    return _errors(h, "/config/fields", run)


def handle_post(h) -> None:
    """POST /config/patch {root, path, field, value, baseMtime, service?}"""
    def run():
        h.check_csrf("POST")
        body = h.read_json_object(MAX_BODY)
        res = safepath.resolve_config(body.get("root", ""), body.get("path", ""),
                                      for_write=True)
        field = body.get("field", "")
        value = validate(field, body.get("value"))
        fields = safepath.config_fields_for(res.relpath)
        if field not in fields:
            # Declared, but scoped to other files by its `paths` - a placement
            # field is refused on a compose file before the file is even read.
            raise safepath.PathRefused(
                f"{field!r} is not patchable in {res.relpath} - the policy scopes it to "
                + ", ".join(safepath.CONFIG_FIELDS[field].get("paths", [])))
        want_service = body.get("service")
        who = h.actor()

        text, current = read_text(res)

        # ── THE CONFLICT CHECK ───────────────────────────────────────────────
        #
        # REQUIRED here, where /write makes it optional - a deliberate
        # divergence. In the editor a missing baseMtime means a script, and the
        # human sent the whole file so they saw what they replaced. A form sends
        # one value for a file it never showed anybody, so a patch with no
        # baseMtime is a patch against a version nobody can name.
        base_mtime = body.get("baseMtime")
        if base_mtime is None:
            return h._send(400, {
                "error": "baseMtime is required - GET /config/fields returns it"})
        try:
            base_mtime = int(base_mtime)
        except (TypeError, ValueError):
            return h._send(400, {"error": "baseMtime must be a number"})
        if base_mtime != current:
            return h._send(409, {
                "error": "the file changed on disk since the form was loaded",
                "path": res.relpath,
                "baseMtime": base_mtime, "currentMtime": current,
                "yours": value,
                "theirs": [
                    {"field": s.field, "service": s.service, "value": s.value}
                    for s in yamlpatch.locate(text, fields)
                    if s.field == field
                ],
            })

        # ── which site ───────────────────────────────────────────────────────
        # An ambiguous patch is REFUSED rather than applied to the first match:
        # the caller knows which service it meant, and guessing is the quiet
        # wrongness this whole design exists to avoid.
        sites = [s for s in yamlpatch.locate(text, fields)
                 if s.field == field
                 and (want_service is None or s.service == want_service)]
        if not sites:
            return h._send(404, {
                "error": f"{field} is not declared in this file"
                         + (f" on service {want_service!r}" if want_service else ""),
                "path": res.relpath})
        if len(sites) > 1:
            return h._send(409, {
                "error": f"{field} is declared on more than one service here - "
                         f"name one with `service`",
                "services": sorted(s.service for s in sites)})
        site = sites[0]

        if site.value == value:
            # Writes nothing. Not an optimisation: writing would move the mtime
            # and 409 every other tab holding a baseMtime that is still correct.
            return h._send(200, {
                "ok": True, "path": res.relpath, "field": field,
                "service": site.service, "value": value,
                "mtime": current, "changed": False, "snapshot": False,
                "applied": False,
                "appliedNote": "nothing changed, so nothing to apply"})

        # Raises RewriteRefused - never writes a file it cannot verify.
        new_text = yamlpatch.splice(text, site, value)

        # THE UNDO NET, taken before the rename while the outgoing bytes still
        # have a name. The config net, not the editor's - see policy.toml.
        kept = safepath.snapshot(res.root_key, res.relpath, res.abspath,
                                 new_text.encode(), net=safepath.CONFIG_NET)

        # A UNIQUE temp file in the same directory, then an atomic rename: two
        # threads patching one file cannot interleave into one fixed temp path.
        tmpfd, tmp = tempfile.mkstemp(
            dir=os.path.dirname(res.abspath),
            prefix=f".{os.path.basename(res.abspath)}.", suffix=".tmp")
        try:
            # newline="" keeps CRLF files CRLF - the invisible whole-file change
            # this module exists to not make.
            with os.fdopen(tmpfd, "w", encoding="utf-8", newline="") as fh:
                fh.write(new_text)
            os.replace(tmp, res.abspath)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
        mtime = int(os.stat(res.abspath).st_mtime)

        audit(who, "PATCHED", res, field, site.service, site.value, value)
        if kept is None:
            audit(who, "NOSNAPSHOT", res, field, site.service)

        return h._send(200, {
            "ok": True, "path": res.relpath, "field": field,
            "service": site.service, "value": value,
            "previous": site.value, "mtime": mtime, "changed": True,
            "author": who,
            "snapshot": bool(kept),
            # EDITING IS NOT APPLYING - said in the response, not left for the UI
            # to know. This box was bitten by it when a `Role · Vendor` rename
            # changed six labels and nothing on screen moved until every affected
            # container was recreated.
            "applied": False,
            "appliedNote": APPLIED_NOTE.get(site.kind, APPLIED_NOTE["compose-label"]),
        })
    return _errors(h, "/config/patch", run)
