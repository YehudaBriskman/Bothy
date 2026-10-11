"""Find one compose `environment:` value, and change exactly that span.

    locate(text, service, key)  -> Site, or raises Refused
    splice(text, site, value)   -> the new text, verified
    write(repo, site, value)    -> writes it, strictly. Returns the new line.

THIS IS apps/bothy-files/yamlpatch.py's IDEA WITHOUT ITS PARSER, and the reason
is the same one pins.py states for the pin line: the host python has no YAML
library, and the host is the last process on this box that should grow a
third-party parser. `/usr/bin/python3` here has no `ruamel`; the updater runs as
devssh, which is in the `docker` group and so root-equivalent over Docker, and it
writes the checkout. Installing a parser into that position to read a file this
repo writes in a two-space style is surface bought for nothing.

  ruamel PARSES and Python SPLICES      (yamlpatch.py, in bothy-files)
  Python SCANS and Python SPLICES       (here, on the host)

The scan is `discover_updates.compose_service`'s - `services:` at column 0, the
service at 2, its keys at 4 - carried one level deeper to `environment:` and its
keys at 6. That function and `pins.locate` have read this repo's compose files
that way since the updater existed, so this does not introduce a reader so much
as extend the one already trusted to find the line a rollback writes.

THE TWO READERS ARE PROVED TO AGREE rather than merely both being present:
apps/bothy-files/checks/composeenv_agrees.py runs this locator and ruamel's
`lc.value()` over every compose file in the repository and fails on a single
character of disagreement in any span. It lives there because that is where
ruamel is installed. "One reader" was not available; "two readers and a proof"
is the next best thing, and it is better than a parser in this process.

── what it refuses, and why each refusal is a file somebody should open ──────

Every one of these means "this value is not in a shape a form may change", and
the answer is Files or an editor, never a guess:

  a quoted scalar          `"false"` and `'false'` parse to a value four or two
                           characters shorter than their source, so splicing at
                           start + len(value) eats the closing quote and leaves a
                           file that does not parse. yamlpatch.py's `_span_of`
                           settles this by comparing the slice with the parsed
                           value; with no parser, the honest move is to refuse
                           every quote outright.
  a `${...}` interpolation the value lives in the gitignored `.env` and the
                           compose line only points at it. Writing a literal over
                           the pointer hard-codes one box's answer into the
                           repository and silently stops `.env` being read. It is
                           also where every secret in these files is, so this is
                           one of the four independent refusals a secret meets.
  a folded or block scalar `>-` and `|` carry the value on the FOLLOWING lines, so
                           there is no span on this line to replace.
                           VictoriaMetrics' whole command is written this way.
  an empty value           "unset" is a different state from "set to something",
                           and every consumer in this repo treats it differently.
  a list-shaped block      `environment:` as `- KEY=value`. Compose accepts it and
                           no file in this repository uses it; a shape nobody
                           writes is a shape nothing should be able to write to.
  more or fewer than one   two `environment:` blocks, or the key twice. "Which one
                           did you mean" has no answer a form can give.

── the verification, on the RESULT ──────────────────────────────────────────

THREE assertions, not yamlpatch.py's four, and the difference is a property of a
line-oriented scanner rather than a corner cut:

  1. the key re-locates in the result, reading exactly the new value
  2. ...on the line the site recorded, so a span pointing somewhere else cannot
     pass by accident
  3. the line count is unchanged AND no line but that one differs, byte for byte.
     That is the comment-preservation guarantee stated directly: a comment cannot
     be lost by a write that provably did not touch its line.

NONE OF THE THREE can be reached by a value the guard at the top of splice()
accepts - every such value produces a correct one-line splice. They exist for a
WRONG SPAN, which is the one fault that guard cannot see and the one
apps/bothy-files/checks/composeenv_agrees.py exists to keep from happening.
checks/test_config_values.py forces three wrong spans and shows each assertion
refusing one; without those three cases, three mutants.sh rows guarding them
could not fail, and the harness said so (2026-10-11).

yamlpatch.py's fourth - every value in the file compared structurally - is the
assertion that catches a locator pointing at the right text in the WRONG PLACE,
and it earns its keep there because ruamel reports an offset that can land inside
a different node. HERE IT CANNOT FIRE INDEPENDENTLY, and that was proved rather
than assumed: a splice writes one contiguous span of a value with no newline in
it, so the lines it can change are exactly the lines its span covers. A span
covering two lines removes a newline and trips (3); a span inside a different
single line leaves the key reading its old value and trips (1); a span whose
recorded line is wrong trips (2). There is no fourth fault left for a fourth
assertion to catch. It was written anyway, this repo's mutation harness found
that the row guarding it could not fail, and it was removed - which is what that
harness is for, including when the author is the one being told.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

from .hostio import atomic_write

# An environment key as compose and this repo write one.
KEY = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
# The quote characters a plain scalar may not begin or end with. A NAMED constant
# rather than a literal at the one place it is used, so that
# scripts/checks/mutants.sh can anchor a row on the line that reads it: the
# literal carried a single AND a double quote, which no single-quoted shell
# argument can express, so the row failed to apply at all and reported ERROR -
# which is the harness being right about a row that proved nothing.
QUOTES = "'\""
# One `KEY: value` line inside an environment block, split so the splice knows
# where the value starts and what follows it. `post` is a trailing comment (the
# socket proxies write a column of them); `v` is the value, and it may not carry
# a quote, a `#` or whitespace - each of those is a refusal below rather than a
# character this strips, because a value that needed stripping was not literal.
_ENVLINE = re.compile(r"(?P<pre>      (?P<k>[A-Z][A-Z0-9_]{0,63}):[ \t]*)(?P<v>[^\s#]*)(?P<post>[ \t].*)?")


class Refused(Exception):
    """This value is not in a shape a form may change. The message names the file."""


@dataclass(frozen=True)
class Site:
    """One patchable environment value, located in the source text.

    `start`/`end` are character offsets into the WHOLE file, like yamlpatch.Site's,
    so a caller never reasons about line endings and a CRLF file cannot be
    silently rewritten to LF. `text` is the whole line as it reads now - the
    strictness anchor every write re-checks, exactly as pins.PinLine does.
    """
    file: str           # repo-relative
    service: str
    key: str
    value: str
    line: int           # 1-based
    text: str           # the whole line, no newline
    start: int
    end: int


def _line_starts(text: str) -> list[int]:
    """Character offset of the first character of every line, plus a sentinel.

    splitlines(keepends=True) rather than split("\\n"), so a file using CRLF is
    measured with the line breaks it actually has - the same reason
    yamlpatch._line_starts gives.
    """
    out, pos = [], 0
    for ln in text.splitlines(keepends=True):
        out.append(pos)
        pos += len(ln)
    out.append(pos)
    return out


def _env_map(text: str) -> dict[tuple[str, str], str]:
    """{(service, key): value} for every environment value in the file.

    Deliberately TOLERANT where locate() is strict: it records a quoted or
    interpolated value as the source reads it, because its job is to ENUMERATE,
    not to decide what may be written.

    It was written as the fourth verification assertion's input, and the header
    says why that assertion is gone. Its callers now are the ones that need the
    whole list: configvalue.rows(), which draws a row for every key of a
    component's services - editable or locked - and checks/test_config_values.py,
    which re-counts the measurement in updates.toml's [config_keys] header so the
    number in that comment cannot quietly stop being true.
    """
    out: dict[tuple[str, str], str] = {}
    svc = ""
    in_services = in_env = False
    for ln in text.splitlines():
        if not ln.strip() or ln.lstrip().startswith("#"):
            continue
        indent = len(ln) - len(ln.lstrip(" "))
        if indent == 0:
            in_services = ln.startswith("services:")
            svc, in_env = "", False
        elif in_services and indent == 2:
            m = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9._-]*):\s*(#.*)?", ln.strip())
            svc, in_env = (m.group(1) if m else ""), False
        elif in_services and svc and indent == 4:
            in_env = ln.strip().rstrip() == "environment:"
        elif in_services and svc and in_env and indent >= 6:
            m = re.fullmatch(r"([A-Z][A-Z0-9_]{0,63}):\s*(.*)", ln.strip())
            if m:
                out[(svc, m.group(1))] = m.group(2).rstrip()
    return out


def locate(text: str, service: str, key: str, rel: str = "") -> Site:
    """The one `key:` line in `service`'s `environment:` block. Raises Refused."""
    if not KEY.fullmatch(key):
        raise Refused(f"{key!r} is not an environment key this will look for")
    where = f"{rel or 'the compose file'}: {service}.{key}"
    lines = text.splitlines()
    starts = _line_starts(text)
    in_services = in_svc = in_env = False
    envs = 0
    found: list[tuple[int, str]] = []
    for i, ln in enumerate(lines, 1):
        if not ln.strip() or ln.lstrip().startswith("#"):
            continue
        indent = len(ln) - len(ln.lstrip(" "))
        if indent == 0:
            in_services = ln.startswith("services:")
            in_svc = in_env = False
            continue
        if not in_services:
            continue
        if indent == 2:
            in_svc = re.fullmatch(rf"{re.escape(service)}:\s*(#.*)?", ln.strip()) is not None
            in_env = False
            continue
        if not in_svc:
            continue
        if indent == 4:
            in_env = ln.strip() == "environment:"
            if in_env:
                envs += 1
            continue
        if in_env and indent >= 6:
            if ln.lstrip().startswith("- "):
                raise Refused(f"{where}: this service writes `environment:` as a list of `KEY=value` "
                              "items, a shape nothing in this repository uses and nothing here writes")
            m = re.fullmatch(r"([A-Z][A-Z0-9_]{0,63}):\s*(.*)", ln.strip())
            if m and m.group(1) == key:
                found.append((i, ln))
    if envs != 1:
        raise Refused(f"{where}: {service} has {envs} `environment:` blocks, not one - edit this file "
                      "by hand")
    if len(found) != 1:
        raise Refused(f"{where}: found {len(found)} lines for it, not one - edit this file by hand")
    n, ln = found[0]
    m = _ENVLINE.fullmatch(ln)
    if not m or m.group("k") != key:
        raise Refused(f"{where}: line {n} is not a plain `      {key}: <value>` line (it is quoted, "
                      "folded, indented differently, or carries something this does not model) - "
                      "edit this file by hand")
    value = m.group("v")
    if not value:
        raise Refused(f"{where}: line {n} sets it to nothing. 'Unset' is a different state from "
                      "'set to something', and this writes values, it does not create them")
    if value[0] in QUOTES or value[-1] in QUOTES:
        raise Refused(f"{where}: line {n} quotes the value. A quoted scalar is longer than the value "
                      "it carries, so there is no span here this can replace safely")
    if value[0] in "|>&*!":
        raise Refused(f"{where}: line {n} starts a folded, block, anchor or tag scalar, whose value "
                      "is not on this line at all")
    if "${" in value or "$(" in value:
        raise Refused(f"{where}: line {n} points at `.env` rather than carrying a value. Writing a "
                      "literal over the pointer would hard-code one box's answer into the repository "
                      "and stop `.env` being read for it at all")
    start = starts[n - 1] + len(m.group("pre"))
    end = start + len(value)
    if text[start:end] != value:
        # Belt and braces over the arithmetic, the way yamlpatch._span_of does:
        # the slice and the value are the same string or we do not know where the
        # value ends. A tab in `pre` measured differently would land here.
        raise Refused(f"{where}: the text at line {n} is not the literal value - edit this file by hand")
    return Site(rel, service, key, value, n, ln, start, end)


def splice(text: str, site: Site, value: str) -> str:
    """Replace exactly the site's span, then verify the result. Raises Refused."""
    if not isinstance(value, str) or not value or value.strip() != value:
        raise Refused("the new value is empty or carries leading or trailing space")
    if any(c in value for c in "\n\r\t#'\"") or " " in value:
        raise Refused("the new value carries a newline, a tab, a quote, a `#` or a space - none of "
                      "which can be written as a plain compose scalar on one line")
    out = text[:site.start] + value + text[site.end:]
    _verify(text, out, site, value)
    return out


def _verify(before: str, after: str, site: Site, value: str) -> None:
    """Refuse unless the result is exactly the one change that was asked for.

    Three assertions; the module header says why three and not yamlpatch's four,
    and that the fourth was written and then removed because no mutation could
    reach it. The ORDER matters: the re-locate runs first, because a value that
    changed the line's shape makes every other comparison a comparison of the
    wrong thing.
    """
    got = locate(after, site.service, site.key, site.file)
    if got.value != value:
        raise Refused(f"after the edit, {site.service}.{site.key} reads {got.value!r} rather than "
                      f"{value!r} - the span did not write where the key is")
    if got.line != site.line:
        raise Refused(f"after the edit, {site.service}.{site.key} is on line {got.line}, not "
                      f"{site.line} - not where the site recorded")
    b_lines = before.splitlines(keepends=True)
    a_lines = after.splitlines(keepends=True)
    differing = [i for i, (x, y) in enumerate(zip(b_lines, a_lines)) if x != y]
    # ONE condition carrying both halves of the guarantee - the line count, and
    # that nothing but this line moved - because a span that welds two lines
    # together breaks both at once and neither half can fire without the other.
    #
    # AT MOST that line, not EXACTLY it: writing the same value back over itself
    # changes nothing, and that has to pass rather than fail. It is what makes a
    # no-op provably byte-identical, and it is what the revert does when the
    # value never actually moved.
    if len(b_lines) != len(a_lines) or not set(differing) <= {site.line - 1}:
        raise Refused(f"the edit left {len(a_lines)} lines where there were {len(b_lines)} and "
                      f"touched {[i + 1 for i in differing]} rather than only line {site.line}")


def write(repo: str, rel: str, service: str, key: str, expect_text: str, expect_value: str,
          value: str) -> tuple[Site, str]:
    """Write the one value, strictly. Returns (the site as found, the new line).

    IT RE-LOCATES RATHER THAN TRUSTING OFFSETS IT WAS HANDED. A caller holding a
    Site from minutes ago holds character offsets into a file that may have been
    edited in Files since - and splicing at a stale offset is the one way this
    module could corrupt a file rather than refuse one. So the file is read, the
    value is located again here, and the write happens only if the line reads
    exactly `expect_text` and the value on it is exactly `expect_value`.

    That is pins.replace()'s rule, for the same reason it has it: between
    deciding to write and writing, somebody may have changed the thing, and a
    write that assumed otherwise discards their change silently. The file's mode
    is preserved and the write is atomic.
    """
    path = os.path.join(repo, rel)
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    site = locate(text, service, key, rel)
    if site.text != expect_text:
        raise Refused(f"{rel}:{site.line} no longer reads exactly {expect_text.strip()!r} - "
                      "not editing it")
    if site.value != expect_value:
        raise Refused(f"{rel}:{site.line} carries {site.value!r}, not the expected {expect_value!r} - "
                      "not editing it")
    out = splice(text, site, value)
    atomic_write(path, out, os.stat(path).st_mode & 0o777)
    return site, out.splitlines()[site.line - 1]
