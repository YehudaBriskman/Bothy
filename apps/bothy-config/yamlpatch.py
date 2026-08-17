"""Change one declared value in a YAML file without touching anything else.

THIS MODULE IS THE WHOLE JOB. Everything else in this service is plumbing around
it, and the reason is a measurement rather than a preference.

── the constraint ──────────────────────────────────────────────────────────

Half of this repository's compose files are comments:

    edge/compose.yml                174 lines, 124 comments   71%
    auth/compose.yml                459 lines, 299 comments   65%
    apps/portal-files/compose.yml   112 lines,  70 comments   62%
    all compose.yml files         1,485 lines, 754 comments   50%

They are the most valuable content in the repository. Several are the only record
of a security decision, and the README advertises them as the point of the thing.
The naive implementation - `yaml.safe_load()`, mutate the dict, `yaml.dump()` -
deletes all 754 of them, reformats everything else, and returns success.

── what was measured, and why this file does not round-trip ────────────────

The obvious defence is `ruamel.yaml` in round-trip mode, which preserves
comments. Run over this repo's 12 compose files and 6 `edge/dynamic/*.yml` files,
loading and dumping with nothing changed:

    YAML(typ='rt'), defaults                     11 of 18 files damaged
    ...plus indent(mapping=2, sequence=4, offset=2)
    ...plus preserve_quotes, width=1<<30           4 of 18 files damaged

The four survivors of every setting we could find are the interesting part:

  1. `apps/portal/compose.yml` loses HAND-ALIGNED COLUMNS. The socket-proxy's
     deny block is written as a column of `POST:         0   # no mutation`, and
     ruamel re-emits it as `POST: 0           # no mutation`. The comments are
     all still there; the table they were arranged into is not. 42 lines change
     in a patch that was supposed to change none.

  2. Three files in `edge/dynamic/` are ENTIRELY COMMENTS - retired routes and
     worked examples kept as the record of why. A YAML document with no content
     loads as `None`, and dumping `None` emits the word null, a newline, and a
     document-end marker: nine bytes. Measured: `host-services.yml` goes from
     1,702 bytes to those nine. Every word of the explanation gone, silently,
     with the service still starting.

So round-trip mode is close, and close is the failure mode this whole design
exists to avoid: it produces a diff too large to read that looks like it worked.

── what this file does instead ─────────────────────────────────────────────

    ruamel PARSES. Python SPLICES. Nothing is ever re-serialised.

The round-trip loader is used only as a LOCATOR: `CommentedSeq.lc.item(i)` and
`CommentedMap.lc.value(k)` give the exact (line, column) of a scalar in the
source. From that we compute a byte span, replace exactly that span in the
original text, and leave every other byte alone. Byte-identity on a no-op is
then true by construction rather than by hope, and a patch cannot damage a
comment because it never writes to a line a comment is on.

The cost is honest and worth stating: this can only change scalars that already
exist. It cannot add a key, delete one, or reorder anything. That is a feature
here - §3 of docs/plans/editing-model.md restricts forms to declared, allowlisted
fields, and every one of those is a value that is already written down.

── the refusal rule ────────────────────────────────────────────────────────

§8 of the plan: "a form that silently drops what it did not understand" is
refused. So every step that could be ambiguous raises RewriteRefused instead of
guessing:

  * the source text at the located span must equal the parsed scalar exactly. If
    it does not, the scalar was quoted, folded, or otherwise not literal, and we
    do not know where it ends;
  * the spliced result must re-parse, and the field must then read back as
    EXACTLY the value asked for - so a value that would change the YAML's
    structure (`a: b` inside a plain scalar, a `#` starting a comment) is caught
    by the parser rather than by a character blocklist we hoped was complete;
  * every line except the one patched must be byte-identical;
  * the whole document, compared structurally, must differ in exactly the one
    place.

Any of those failing means the file is written in a shape this module does not
model, and the correct answer is "open it in Files", not "write something".
"""

from __future__ import annotations

import io
from dataclasses import dataclass

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq
from ruamel.yaml.error import YAMLError


class RewriteRefused(Exception):
    """The file is not in a shape this module can change safely."""


def _reader() -> YAML:
    """A parser, never a writer.

    `width` is set absurdly high even though nothing here dumps, because the one
    place a YAML object escapes this module is the naive-dump demonstration in
    checks/, and the default width of 80 silently reflows long lines - which
    would make that measurement wrong in the flattering direction.
    """
    y = YAML(typ="rt")
    y.preserve_quotes = True
    y.width = 1 << 30
    return y


@dataclass(frozen=True)
class Site:
    """One patchable value, located in the source text.

    `start`/`end` are character offsets into the whole file, not into the line.
    Splicing works on offsets so that the caller never has to reason about line
    endings, and a file with CRLF cannot be silently rewritten to LF.
    """
    field: str          # the policy key, e.g. "dev.portal.project"
    kind: str           # the locator that found it, e.g. "compose-label"
    service: str        # the compose service the value belongs to
    value: str          # what it says now
    line: int           # 1-based, for a UI that wants to link into Files
    start: int
    end: int


# ── locators ────────────────────────────────────────────────────────────────
#
# A locator answers "where in this text is field X?" for one SHAPE of file. The
# policy names a kind per field, so adding `dev.portal.name` and
# `dev.portal.desc` is one line each in policy.toml - they are the same shape.
#
# Adding a genuinely new shape (an env var, a published port) is a new function
# here plus a name in this table, and that is the right amount of friction: a new
# shape is a new set of ways to be wrong about where a value ends.


def _span_of(text: str, lines: list[int], line0: int, col0: int,
             literal: str, what: str) -> tuple[int, int]:
    """Character offsets of `literal`, asserted to start at (line0, col0).

    THE ASSERTION IS THE POINT. ruamel reports where a scalar begins; it does not
    report where it ends, and the end is what a splice needs. For a PLAIN scalar
    the source text and the parsed value are the same string, so the end is
    start + len(value) - but only if the source really is plain. A single-quoted
    scalar parses `'it''s'` to `it's`, four source characters longer than the
    value, and splicing at start+len would eat the closing quote and leave a file
    that does not parse.

    Comparing the source slice against the parsed value settles it in one line,
    for every quoting style at once, without a table of them.
    """
    if line0 < 0 or line0 >= len(lines):
        raise RewriteRefused(f"{what}: reported line {line0 + 1} is outside the file")
    start = lines[line0] + col0
    end = start + len(literal)
    if text[start:end] != literal:
        raise RewriteRefused(
            f"{what}: the text at line {line0 + 1} is not the literal value "
            f"(quoted, folded, or spanning lines) - edit this file in Files instead")
    return start, end


def _line_starts(text: str) -> list[int]:
    """Character offset of the first character of every line.

    splitlines(keepends=True) rather than split('\\n') so that a file using CRLF,
    or an old Mac CR, is measured with the line breaks it actually has. ruamel
    counts lines the same way, so the two agree.
    """
    out, pos = [], 0
    for ln in text.splitlines(keepends=True):
        out.append(pos)
        pos += len(ln)
    out.append(pos)   # a trailing sentinel, so the last line has an end
    return out


def _locate_compose_label(doc, text: str, lines: list[int],
                          field: str) -> list[Site]:
    """Find `field` as a docker-compose label, in either shape compose accepts.

    Both shapes are real and both appear on this box, so both are handled rather
    than one being declared canonical:

        labels:                                 labels:
          - dev.portal.project=Edge · Traefik     dev.portal.project: Edge · Traefik

    The LIST shape is what every compose file here uses today, and it is the
    awkward one: the label is a single scalar `key=value`, so the value's span is
    an offset INTO that scalar rather than a node ruamel can point at. The `=` is
    found in the source slice we already proved literal, so the arithmetic never
    leaves ground the assertion covered.
    """
    sites: list[Site] = []
    if not isinstance(doc, CommentedMap):
        return sites
    services = doc.get("services")
    if not isinstance(services, CommentedMap):
        return sites

    for name, svc in services.items():
        if not isinstance(svc, CommentedMap):
            continue
        labels = svc.get("labels")

        if isinstance(labels, CommentedSeq):
            prefix = field + "="
            for i, item in enumerate(labels):
                if not isinstance(item, str) or not item.startswith(prefix):
                    continue
                lc = labels.lc.item(i)
                if lc is None:
                    raise RewriteRefused(
                        f"{field}: ruamel reported no position for the label on "
                        f"service {name!r}")
                start, end = _span_of(text, lines, lc[0], lc[1], item,
                                      f"{field} on {name}")
                sites.append(Site(field=field, kind="compose-label",
                                  service=str(name), value=item[len(prefix):],
                                  line=lc[0] + 1,
                                  start=start + len(prefix), end=end))

        elif isinstance(labels, CommentedMap) and field in labels:
            val = labels[field]
            if not isinstance(val, str):
                # A label whose value YAML read as a number or a bool. Compose
                # would stringify it; we will not, because writing a string back
                # over it would change the file's type as well as its value and
                # that is a bigger change than the form asked for.
                raise RewriteRefused(
                    f"{field} on service {name!r} is not a plain string")
            lc = labels.lc.value(field)
            if lc is None:
                raise RewriteRefused(
                    f"{field}: ruamel reported no position for the label on "
                    f"service {name!r}")
            start, end = _span_of(text, lines, lc[0], lc[1], val,
                                  f"{field} on {name}")
            sites.append(Site(field=field, kind="compose-label",
                              service=str(name), value=val,
                              line=lc[0] + 1, start=start, end=end))

    return sites


LOCATORS = {
    "compose-label": _locate_compose_label,
}


# ── the public surface ──────────────────────────────────────────────────────

def parse(text: str):
    """Load for LOCATION ONLY. The result is never dumped."""
    try:
        return _reader().load(text)
    except YAMLError as e:
        raise RewriteRefused(f"this file does not parse as YAML: {e}") from e


def locate(text: str, fields: dict[str, dict]) -> list[Site]:
    """Every patchable site in `text`, given the policy's field table.

    Order is by position in the file, so a UI listing them shows them in the
    order a person reading the file would meet them.
    """
    doc = parse(text)
    lines = _line_starts(text)
    sites: list[Site] = []
    for field, cfg in fields.items():
        locator = LOCATORS.get(cfg["kind"])
        if locator is None:
            # A policy naming a kind with no implementation is a startup-class
            # error that only shows up on the request that needs it, so it is
            # loud rather than an empty result.
            raise RewriteRefused(
                f"policy declares field {field!r} with unknown kind {cfg['kind']!r}")
        sites.extend(locator(doc, text, lines, field))
    return sorted(sites, key=lambda s: s.start)


def splice(text: str, site: Site, new_value: str) -> str:
    """Replace exactly the site's span. Verified, then returned.

    The verification runs on the RESULT rather than on the input, which is the
    whole reason it can be short. Anything a hostile or merely awkward value
    could do to the document - close a scalar early, open a comment, turn a
    sequence item into a mapping - shows up as the reparsed value not matching,
    and one comparison covers all of them.
    """
    out = text[:site.start] + new_value + text[site.end:]
    _verify(text, out, site, new_value)
    return out


def _plain(node):
    """Strip ruamel's types so two documents can be compared for content alone.

    CommentedMap and CommentedSeq compare equal to dict and list, so this is
    strictly speaking unnecessary - but `==` on them also drags in their comment
    attachments in some ruamel versions, and a structural comparison that
    quietly starts comparing comments would fail every legitimate patch. Making
    the shape explicit costs six lines and removes the dependency on that
    behaviour.
    """
    if isinstance(node, dict):
        return {k: _plain(v) for k, v in node.items()}
    if isinstance(node, (list, tuple)):
        return [_plain(v) for v in node]
    return node


def _verify(before: str, after: str, site: Site, new_value: str) -> None:
    """Refuse unless the result is exactly the one change that was asked for.

    Four assertions, each catching something the others cannot:

      1. it parses, and the field reads back as the exact new value. Catches
         every way a value can change the document's SHAPE rather than its
         content.
      2. the line count is unchanged. A value carrying a newline would otherwise
         split one line into two, and every subsequent line number - including
         those in the audit log and in any UI linking into Files - would be
         wrong.
      3. every line except the patched one is byte-identical. This is the
         comment-preservation guarantee stated directly: a comment cannot be
         lost by a write that provably did not touch its line.
      4. structurally, the two documents differ only where they were meant to.
         Cheap, and it is the one that would catch a locator pointing at the
         right text in the wrong place - two services with the same label value,
         say, where assertion 1 would happily pass on the wrong one.
    """
    doc = parse(after)
    lines = _line_starts(after)
    found = [s for s in LOCATORS[site.kind](doc, after, lines, site.field)
             if s.service == site.service]
    if len(found) != 1:
        raise RewriteRefused(
            f"after the patch, {site.field} appears {len(found)} times on service "
            f"{site.service!r} - refusing to write")
    if found[0].value != new_value:
        raise RewriteRefused(
            f"after the patch, {site.field} reads {found[0].value!r} rather than "
            f"{new_value!r} - the value changed the document's structure")

    b_lines = before.splitlines(keepends=True)
    a_lines = after.splitlines(keepends=True)
    if len(b_lines) != len(a_lines):
        raise RewriteRefused(
            f"the patch changed the line count ({len(b_lines)} -> {len(a_lines)})")
    differing = [i for i, (x, y) in enumerate(zip(b_lines, a_lines)) if x != y]
    # AT MOST the one line, not EXACTLY it. Writing the same value back over
    # itself changes nothing at all, and that must be a pass rather than a
    # failure - it is precisely the case checks/noop_bytes.py exists to assert,
    # and requiring a change here would make the gating check impossible to
    # write. `<=` on the set says "nowhere else", which is the actual property.
    if not set(differing) <= {site.line - 1}:
        raise RewriteRefused(
            "the patch changed lines "
            f"{[i + 1 for i in differing]} rather than only line {site.line}")

    expect = _plain(parse(before))
    got = _plain(doc)
    if _clear_site(expect, site) != _clear_site(got, site):
        raise RewriteRefused(
            "the patch changed the document somewhere other than the field asked "
            "for - refusing to write")


def _clear_site(doc, site: Site):
    """Blank the patched value so the rest of two documents can be compared.

    Removing the label outright would be wrong: a list-shaped `labels:` would
    then have a different LENGTH before and after, and every entry after it a
    different index, so the comparison would report a difference that is only the
    hole we punched. Overwriting it in place keeps the shapes aligned.
    """
    try:
        svc = doc["services"][site.service]
        labels = svc["labels"]
    except (KeyError, TypeError):
        return doc
    if isinstance(labels, list):
        prefix = site.field + "="
        svc["labels"] = [f"{prefix}\0" if isinstance(x, str) and x.startswith(prefix)
                         else x for x in labels]
    elif isinstance(labels, dict) and site.field in labels:
        labels[site.field] = "\0"
    return doc


def naive_dump(text: str) -> str:
    """Load and dump with nothing changed - the thing this module refuses to do.

    Lives here rather than in the check so that the comparison is against the
    exact same parser configuration this module uses for locating. A measurement
    of a straw man is not a measurement. See checks/naive_dump_damage.py.
    """
    y = _reader()
    y.indent(mapping=2, sequence=4, offset=2)
    buf = io.StringIO()
    y.dump(y.load(text), buf)
    return buf.getvalue()
