#!/usr/bin/env python3
"""bothy-config - the typed-lens API behind Bothy's config forms.

A form is a typed lens over a file. It is never a second store. Every
configurable thing on this box is a file in git; if a form wrote to a database
instead, the repository would stop describing the box, `git log` would stop being
its history, and a `git pull` would silently revert somebody's change. Everything
below follows from refusing that.

── why this is a SEPARATE service from portal-files ────────────────────────

`apps/portal-files/app.py` states at the top that it has no third-party
dependencies, "because this container holds read-write bind mounts on two git
repositories, and every dependency is something that can ship a vulnerability
into that position". A YAML round-tripper is a third-party dependency.

So the parser lives here, with its own smaller mount - one repository instead of
four roots - and its own network. portal-files keeps its property; this service
carries the dependency and pays for it with a narrower blast radius. See
docs/plans/editing-model.md §2.

── it authenticates NOBODY ─────────────────────────────────────────────────

Authorisation happens at the edge: Traefik's forwardAuth asks oauth2-proxy
`/oauth2/auth?allowed_groups=editor`, and a request that fails never reaches this
process. Putting authz here as well would mean two places to get it right and two
places to get it wrong.

The consequence is the rule the socket-proxy taught and portal-files repeats:
**reachability IS authorisation.** This publishes no host port and sits on
`confignet`, which holds two containers - Traefik and this. If it is ever put on
devnet, ~20 containers including third-party images get the ability to rewrite
this box's compose files, and nothing will warn you.

Identity headers are for ATTRIBUTION, not permission. X-Auth-Request-Email names
the author in the audit line. If it were spoofable the worst case is a wrong name
in a log, not unauthorised access, because the decision was already made
upstream - and the edge strips client-supplied X-Auth-Request-* anyway.

── what it inherits rather than reinvents ──────────────────────────────────

Everything portal-files already proved, on purpose and by copy where importing
was not possible:

  resolve()     the path boundary, resolve-first-compare-after   safepath.py
  baseMtime     the conflict check                               do_POST below
  snapshot()    the undo net taken before the overwrite          safepath.py
  audit()       one line per write, with who and what            below
  the role gate the edge, not here            edge/dynamic/bothy-config.yml

The one thing it does NOT inherit is the writer. portal-files takes a whole file
of text from a human who can see it; this takes one value from a form. The
difference is yamlpatch.py, and its header explains why a round-tripper was
measured and rejected.

── editing is not applying ─────────────────────────────────────────────────

A patch here changes a FILE. It does not change a running container: a compose
label is fixed at container-creation time, so `dev.portal.project` does not move
on screen until the container is recreated. That is `operator` work and it is not
this service's. The response says so - `applied: false` with a reason - so the UI
can render config drift in the language the collector already uses for
declared-versus-observed, rather than a spinner that lies.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import safepath
import yamlpatch

PORT = int(os.environ.get("PORT", "8098"))
AUDIT_PATH = os.environ.get("AUDIT_LOG", "/audit/patches.log")
_AUDIT_LOCK = threading.Lock()

# Whitespace at either end of a plain YAML scalar is stripped by the parser, so a
# value ending in a space would read back short and yamlpatch would refuse the
# write with "the value changed the document's structure" - which is true and
# tells nobody anything. Caught here for the message, not for the guarantee.
_EDGE_SPACE = re.compile(r"^\s|\s$")


def audit(who: str, action: str, res, field: str, service: str,
          old: str | None = None, new: str | None = None) -> None:
    """Append-only record of every change this service makes.

    One line, tab-separated, `tail`-able, no rotation logic to get wrong and no
    format anything else has to parse.

    It carries the OLD value as well as the new, which the file tier's log does
    not, and that difference is the point of it. portal-files logs that a file
    was written and how many bytes; the file itself is the record of what it
    says, and a person can read the diff. A form write is one value inside a
    file nobody looked at, so "what did this say before" has no other answer
    short of digging the snapshot out of the trash.

    A failure to LOG must never fail the write - losing the record of a save is
    bad, refusing a legitimate save because the log is full is worse - so this
    swallows its own errors and reports them to stderr.
    """
    # Every field is flattened to one line before it is written.
    #
    # The log is tab-separated, one record per line, so a newline in ANY field
    # forges a record: a value containing
    #   "\n<timestamp>\tsomeone@else\tPATCHED\t..."
    # produces a syntactically perfect entry attributing a change to another
    # user. The patched VALUE comes from a form and is the obvious vector;
    # relpath is the same one, because newlines are legal in Linux filenames.
    #
    # The point of this log is that a change is always attributable; a record
    # anyone can forge attributes nothing.
    def flat(v: object) -> str:
        return re.sub(r"[\r\n\t]+", " ", str(v)).strip()

    line = (f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\t{flat(who)}\t"
            f"{flat(action)}\t{flat(res.root_key)}/{flat(res.relpath)}\t"
            f"{flat(service)}\t{flat(field)}")
    if old is not None or new is not None:
        line += f"\t{flat(old)!r} -> {flat(new)!r}"
    sys.stderr.write(line + "\n")
    try:
        with _AUDIT_LOCK:
            os.makedirs(os.path.dirname(AUDIT_PATH), exist_ok=True)
            with open(AUDIT_PATH, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
    except OSError as e:
        sys.stderr.write(f"AUDIT LOG UNWRITABLE ({e}) - the write itself was fine\n")


def read_text(res) -> tuple[str, int]:
    """The file's text and its mtime, through the same guarded open as everything.

    safe_open rather than open(): O_NOFOLLOW closes the window between realpath()
    and open() in which the final component could be swapped for a symlink, and
    the size is checked on the same fd whose bytes we then read, so there is no
    size TOCTOU.
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


def validate(field: str, value: object) -> str:
    """Refuse a value the policy does not allow. Returns it unchanged.

    Refuses rather than sanitising, on the same reasoning as resolve(): silently
    trimming a hostile value into a legal one means an attack and a typo produce
    the same quiet success.
    """
    cfg = safepath.FIELDS.get(field)
    if cfg is None:
        # The message names the allowlist rather than the field, so a caller
        # guessing at field names learns what exists instead of learning which
        # of their guesses is close.
        raise safepath.PathRefused(
            f"{field!r} is not a patchable field - the policy declares "
            + ", ".join(sorted(safepath.FIELDS)))
    if not isinstance(value, str):
        raise safepath.PathRefused("value must be a string")
    limit = min(int(cfg.get("max_length", safepath.MAX_VALUE_LENGTH)),
                safepath.MAX_VALUE_LENGTH)
    if len(value) > limit:
        raise safepath.PathRefused(f"value is longer than {limit} characters")
    if not value:
        # An empty label is legal YAML and meaningless configuration: compose
        # would keep the key with an empty value, and Bothy would render a card
        # with no title. Deleting a field is a different act from changing it and
        # it is not one this service offers.
        raise safepath.PathRefused("value must not be empty")
    for ch in ("\n", "\r", "\t", "\0"):
        if ch in value:
            raise safepath.PathRefused(
                "value must not contain newlines, tabs or null bytes")
    if _EDGE_SPACE.search(value):
        raise safepath.PathRefused(
            "value must not start or end with whitespace - YAML would strip it")

    # ── the two sequences a PLAIN YAML scalar cannot carry ──────────────────
    #
    # yamlpatch is the guarantee: it re-parses its own output and refuses if the
    # value does not read back exactly. These two checks exist because that
    # refusal, on its own, says "the value changed the document's structure",
    # which is true and tells a person nothing about what to type instead.
    #
    #   " #"   opens a COMMENT. `title=a # b` parses as the scalar `title=a`
    #          with `b` as a comment, so the value silently reads back short.
    #   ": "   opens a MAPPING. `- title=a: b` is not a string at all - it is a
    #          one-key map, and the label disappears entirely.
    #
    # A trailing colon is the same case with the space supplied by the newline.
    # A leading `#` is NOT refused: in the `key=value` label shape it is never
    # preceded by whitespace, so it is an ordinary character.
    #
    # The obvious alternative is to QUOTE the value instead of refusing it, and
    # it is rejected on purpose: quoting rewrites the whole label item rather
    # than the value inside it, so the span the locator proved literal is no
    # longer the span being written. That is a real feature and it needs its own
    # locator, not a special case bolted onto this one.
    if " #" in value:
        raise safepath.PathRefused(
            "value must not contain ' #' - YAML would read the rest as a comment")
    if ": " in value or value.endswith(":"):
        raise safepath.PathRefused(
            "value must not contain ': ' or end with ':' - YAML would read it "
            "as a key")
    return value


def fields_in(res) -> dict:
    """What is patchable in this file, what it says now, and when it last changed.

    The mtime is returned WITH the values, in one response, and that is not
    incidental. A client that fetched the values and the mtime separately could
    read a file, have it change, then read the newer mtime and send a patch that
    passes the conflict check while carrying the older value. One read, one
    stat, one answer.
    """
    text, mtime = read_text(res)
    sites = yamlpatch.locate(text, safepath.FIELDS)
    return {
        "root": res.root_key,
        "path": res.relpath,
        "mtime": mtime,
        "fields": [
            {"field": s.field, "service": s.service, "value": s.value,
             "line": s.line, "kind": s.kind,
             "maxLength": min(
                 int(safepath.FIELDS[s.field].get("max_length",
                                                  safepath.MAX_VALUE_LENGTH)),
                 safepath.MAX_VALUE_LENGTH)}
            for s in sites
        ],
        # Named here rather than left for the client to know, so a UI can say
        # "nothing on this page is a form field" without a hardcoded list.
        "patchable": sorted(safepath.FIELDS),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "bothy-config"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _query(self) -> dict:
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    def log_message(self, fmt, *args):  # noqa: A003
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ── read ────────────────────────────────────────────────────────────────
    def do_GET(self) -> None:  # noqa: N802
        route = urlparse(self.path).path
        q = self._query()
        try:
            if route == "/healthz":
                return self._send(200, {"ok": True,
                                        "roots": sorted(safepath.ROOTS),
                                        "fields": sorted(safepath.FIELDS)})

            if route == "/config/fields":
                res = safepath.resolve(q.get("root", ""), q.get("path", ""),
                                       for_write=True)
                # for_write on a READ, deliberately. This endpoint answers "what
                # can a form change here", so a file the write path would refuse
                # must not be listed as though it had editable fields - a form
                # that renders and then 403s on submit is worse than one that
                # never rendered.
                return self._send(200, fields_in(res))

            return self._send(404, {"error": "no such endpoint"})
        except safepath.PathRefused as e:
            return self._send(403, {"error": str(e)})
        except yamlpatch.RewriteRefused as e:
            return self._send(422, {"error": str(e)})
        except FileNotFoundError:
            return self._send(404, {"error": "no such file"})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"ERROR {route}: {type(e).__name__}: {e}\n")
            return self._send(500, {"error": "internal error"})

    # ── write ───────────────────────────────────────────────────────────────
    def do_POST(self) -> None:  # noqa: N802
        route = urlparse(self.path).path
        if route != "/config/patch":
            return self._send(404, {"error": "no such endpoint"})

        # ── CSRF ────────────────────────────────────────────────────────────
        #
        # Same shape as portal-files' /write, and needed for the same reason: the
        # oauth2-proxy session cookie is sent to every port on this host, so a
        # page on the sandbox origin (:8100) is SAME-SITE with the portal and
        # SameSite=lax does not block a POST from there to here.
        #
        # Requiring JSON is the load-bearing half. This handler calls json.loads
        # on the body regardless of content type, so a text/plain POST - a
        # CORS-"simple" request, which skips the preflight entirely - would
        # otherwise be accepted. Demanding application/json forces a preflight
        # cross-origin, and the preflight fails because this service sends no
        # CORS headers at all.
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return self._send(415, {"error": "Content-Type must be application/json"})
        site_hdr = self.headers.get("Sec-Fetch-Site")
        if site_hdr and site_hdr not in ("same-origin", "none"):
            return self._send(403, {
                "error": f"cross-origin writes are refused (Sec-Fetch-Site: {site_hdr})"})

        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 64_000:
                # A patch body is a path, a field name and one form value. Sixty
                # kilobytes is already absurd for that, and the ceiling is here
                # rather than at MAX_BYTES because this endpoint has no reason to
                # accept a file-sized body at all.
                return self._send(413, {"error": "body missing or too large"})
            body = json.loads(self.rfile.read(length))

            res = safepath.resolve(body.get("root", ""), body.get("path", ""),
                                   for_write=True)
            field = body.get("field", "")
            value = validate(field, body.get("value"))
            want_service = body.get("service")

            # Attribution only. Falls back rather than failing: a missing header
            # means a misconfigured edge, and losing the author name is not a
            # reason to refuse a legitimate edit.
            who = (self.headers.get("X-Auth-Request-Email")
                   or self.headers.get("X-Auth-Request-User") or "unknown")

            text, current = read_text(res)

            # ── THE CONFLICT CHECK ───────────────────────────────────────────
            #
            # Two edit paths on one file is the ORDINARY case here, not the
            # exotic one: a form in one tab, Bothy Files in another, and `vim` on
            # the box. The file tier already solved it, and the form path sends
            # the same baseMtime and gets the same 409 rather than inventing a
            # second policy.
            #
            # It is REQUIRED here, where portal-files makes it optional. That is
            # a deliberate divergence. In Files a missing baseMtime means a
            # script or curl, and the human sent the whole file so they at least
            # saw what they were replacing. A form sends one value for a file it
            # never showed anybody - so a patch with no baseMtime is a patch
            # against a version nobody can name, and there is no version of that
            # which is safe to accept quietly.
            base_mtime = body.get("baseMtime")
            if base_mtime is None:
                return self._send(400, {
                    "error": "baseMtime is required - GET /config/fields returns it"})
            try:
                base_mtime = int(base_mtime)
            except (TypeError, ValueError):
                return self._send(400, {"error": "baseMtime must be a number"})
            if base_mtime != current:
                return self._send(409, {
                    "error": "the file changed on disk since the form was loaded",
                    "path": res.relpath,
                    "baseMtime": base_mtime, "currentMtime": current,
                    # The CURRENT state of the field, so the UI can offer
                    # keep/take/compare rather than making someone guess what
                    # they would lose. The file tier returns both whole texts;
                    # here the values are the whole of what a form knows.
                    "yours": value,
                    "theirs": [
                        {"field": s.field, "service": s.service, "value": s.value}
                        for s in yamlpatch.locate(text, safepath.FIELDS)
                        if s.field == field
                    ],
                })

            # ── which site ───────────────────────────────────────────────────
            #
            # A compose file may declare several services, and more than one can
            # carry the same label. An ambiguous patch is REFUSED rather than
            # applied to the first match: guessing which service the form meant
            # is exactly the kind of quiet wrongness this whole design exists to
            # avoid, and the caller already knows the answer.
            sites = [s for s in yamlpatch.locate(text, safepath.FIELDS)
                     if s.field == field
                     and (want_service is None or s.service == want_service)]
            if not sites:
                return self._send(404, {
                    "error": f"{field} is not declared in this file"
                             + (f" on service {want_service!r}" if want_service else ""),
                    "path": res.relpath})
            if len(sites) > 1:
                return self._send(409, {
                    "error": f"{field} is declared on more than one service here - "
                             f"name one with `service`",
                    "services": sorted(s.service for s in sites)})
            site = sites[0]

            if site.value == value:
                # A patch that changes nothing writes nothing. Not an
                # optimisation: writing would move the mtime, which would 409
                # every other tab holding a baseMtime that is still correct.
                return self._send(200, {
                    "ok": True, "path": res.relpath, "field": field,
                    "service": site.service, "value": value,
                    "mtime": current, "changed": False, "snapshot": False,
                    "applied": False,
                    "appliedNote": "nothing changed, so nothing to apply"})

            # Raises RewriteRefused - never writes a file it cannot verify.
            new_text = yamlpatch.splice(text, site, value)

            # ── THE UNDO NET ─────────────────────────────────────────────────
            #
            # Taken BEFORE the rename, while the outgoing bytes are still
            # reachable. After os.replace the old content has no name.
            kept = safepath.snapshot(res.root_key, res.relpath, res.abspath,
                                     new_text.encode())

            # Write to a temp file in the same directory, then rename. rename is
            # atomic within a filesystem, so a crash mid-write leaves the old
            # file intact rather than a truncated one.
            #
            # A UNIQUE temp name per write: this is a threaded server, so two
            # patches to one file could both open a fixed `<path>.tmp`,
            # interleave their writes, and the first rename would move the
            # SECOND's partial content into place. The mtime check does not help
            # - both requests can legitimately hold the same baseMtime.
            tmpfd, tmp = tempfile.mkstemp(
                dir=os.path.dirname(res.abspath),
                prefix=f".{os.path.basename(res.abspath)}.", suffix=".tmp")
            try:
                with os.fdopen(tmpfd, "w", encoding="utf-8", newline="") as fh:
                    # newline="" so that a file with CRLF endings keeps them.
                    # The default translates every "\n" to os.linesep on write,
                    # which would rewrite every line ending in the file - the
                    # exact class of invisible whole-file change this service
                    # exists to not make.
                    fh.write(new_text)
                os.replace(tmp, res.abspath)
            except BaseException:
                if os.path.exists(tmp):
                    os.unlink(tmp)
                raise
            mtime = int(os.stat(res.abspath).st_mtime)

            audit(who, "PATCHED", res, field, site.service, site.value, value)
            # A patch whose previous version was NOT kept is worth a line of its
            # own. It is rare, and it is the moment the net was missing.
            if kept is None:
                audit(who, "NOSNAPSHOT", res, field, site.service)

            return self._send(200, {
                "ok": True, "path": res.relpath, "field": field,
                "service": site.service, "value": value,
                "previous": site.value, "mtime": mtime, "changed": True,
                "author": who,
                # Reported rather than assumed, so "there is an undo net" is
                # never something the UI claims on the service's behalf.
                "snapshot": bool(kept),
                # ── EDITING IS NOT APPLYING ──────────────────────────────────
                #
                # Said in the response rather than left for the UI to know. A
                # compose label is fixed at container-creation time: this box was
                # already bitten by that when the `Role · Vendor` rename changed
                # six labels and nothing on screen moved until every affected
                # container was recreated. The file now says one thing and the
                # running container another, which is config drift - the same
                # shape as "declared but not running" - and it should render in
                # that language rather than as a spinner that lies.
                "applied": False,
                "appliedNote": (
                    "written to the file. A compose label is read at "
                    "container-creation time, so this takes effect when the "
                    "service is recreated - that is operator work, not this "
                    "service's."),
            })
        except safepath.PathRefused as e:
            return self._send(403, {"error": str(e)})
        except yamlpatch.RewriteRefused as e:
            # 422, not 400 and not 500. The request was well-formed and the
            # caller is not at fault: the FILE is in a shape this service will
            # not change. The message says so, and the answer is Bothy Files.
            return self._send(422, {"error": str(e)})
        except FileNotFoundError:
            return self._send(404, {"error": "no such file"})
        except json.JSONDecodeError:
            return self._send(400, {"error": "body must be JSON"})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"ERROR /config/patch: {type(e).__name__}: {e}\n")
            return self._send(500, {"error": "internal error"})


def main() -> None:
    sys.stderr.write(
        f"bothy-config on :{PORT} - roots {sorted(safepath.ROOTS)}, "
        f"fields {sorted(safepath.FIELDS)}\n")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
