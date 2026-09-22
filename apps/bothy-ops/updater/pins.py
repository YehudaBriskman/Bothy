"""Find a compose pin's exact line, and change that one line - strictly.

The updater deploys what `main` pins and never writes a NEWER pin. It writes a
pin in exactly one case: a ROLLBACK puts the previous image back on the line it
came from, so that the next `just up` keeps the version that works.

The edit is the bothy-files yamlpatch.py idea without the YAML library (the host
python has none, and a round-trip serialiser would be the wrong tool anyway): a
single line changes, byte for byte everything else survives - indentation, the
quote style, a trailing `# comment`, every other line. And it is STRICT: the line
must still read exactly what the plan recorded, and the value on it must be
exactly the old image string, or nothing is written.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

from .hostio import HostError, atomic_write

# An image reference as this repo writes one: optional registry[:port]/, a path,
# and a tag and/or a digest. Lowercase path, as registries require.
IMAGE = re.compile(
    r"(?:[a-z0-9][a-z0-9.-]*(?::\d{1,5})?/)?[a-z0-9][a-z0-9._/-]{0,200}"
    r"(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?")
_LINE = re.compile(r"(?P<pre>    image:[ \t]*)(?P<q>['\"]?)(?P<v>[^'\"\s#]+)(?P=q)(?P<post>[ \t]+#.*)?")


@dataclass(frozen=True)
class PinLine:
    file: str          # repo-relative
    service: str
    line: int          # 1-based
    text: str          # the whole line, no newline
    value: str         # the image reference on it, unquoted
    container: str | None


def locate(repo: str, rel: str, service: str) -> PinLine:
    """The `image:` line of `service` in the compose file `rel`.

    The same indentation scan as discover_updates.compose_service (services: at
    column 0, the service at 2, its keys at 4) - so the updater and discovery can
    never disagree about which line is the pin.
    """
    path = os.path.join(repo, rel)
    try:
        lines = open(path, encoding="utf-8").read().split("\n")
    except OSError as e:
        raise HostError(f"{rel} could not be read ({e.strerror})") from None
    in_services = in_svc = False
    found: list[tuple[int, str]] = []
    cname = None
    for i, ln in enumerate(lines, 1):
        if not ln.strip() or ln.lstrip().startswith("#"):
            continue
        indent = len(ln) - len(ln.lstrip(" "))
        if indent == 0:
            in_services = ln.startswith("services:")
            in_svc = False
            continue
        if not in_services:
            continue
        if indent == 2:
            in_svc = re.fullmatch(rf"{re.escape(service)}:\s*(#.*)?", ln.strip()) is not None
            continue
        if in_svc and indent == 4:
            if re.match(r"image:", ln.strip()):
                found.append((i, ln))
            m = re.fullmatch(r"container_name:\s*['\"]?([A-Za-z0-9][A-Za-z0-9_.-]*)['\"]?\s*(#.*)?", ln.strip())
            if m:
                cname = m.group(1)
    if len(found) != 1:
        raise HostError(f"{rel}: expected exactly one image: line for service {service}, found {len(found)}")
    n, text = found[0]
    m = _LINE.fullmatch(text)
    if not m or not IMAGE.fullmatch(m.group("v")):
        raise HostError(f"{rel}:{n} is not a plain `image: <reference>` line")
    return PinLine(rel, service, n, text, m.group("v"), cname)


@dataclass(frozen=True)
class Line:
    """Any one line a rollback may write back (step 8): a chart's `version:`, a
    manifest's `image:`, Postgres' volume mount and declaration."""
    file: str          # repo-relative
    line: int          # 1-based
    text: str          # the whole line as main has it


def find_line(repo: str, rel: str, pattern: str, *, after: str | None = None) -> Line:
    """The ONE line of `rel` that fullmatches `pattern` (after the first line
    fullmatching `after`, when given). Anything but exactly one is an error."""
    path = os.path.join(repo, rel)
    try:
        lines = open(path, encoding="utf-8").read().split("\n")
    except OSError as e:
        raise HostError(f"{rel} could not be read ({e.strerror})") from None
    start = 0
    if after is not None:
        start = next((i + 1 for i, ln in enumerate(lines) if re.fullmatch(after, ln)), -1)
        if start < 0:
            raise HostError(f"{rel}: no line matches {after!r}")
    hits = [(i + 1, ln) for i, ln in enumerate(lines) if i >= start and re.fullmatch(pattern, ln)]
    if len(hits) != 1:
        raise HostError(f"{rel}: expected exactly one line matching {pattern!r}, found {len(hits)}")
    return Line(rel, hits[0][0], hits[0][1])


def swap(line: Line, old: str, new: str) -> str:
    """line.text with the ONE occurrence of `old` replaced by `new`."""
    if not old or line.text.count(old) != 1:
        raise HostError(f"{line.file}:{line.line} does not carry {old!r} exactly once - not editing it")
    return line.text.replace(old, new)


def write_line(repo: str, line: Line, new_text: str) -> str:
    """Rewrite one line - only if it still reads exactly line.text. Returns the new line."""
    if "\n" in new_text or "\r" in new_text:
        raise HostError("a line edit may not add lines")
    path = os.path.join(repo, line.file)
    with open(path, encoding="utf-8") as fh:
        data = fh.read()
    lines = data.split("\n")
    if line.line < 1 or line.line > len(lines) or lines[line.line - 1] != line.text:
        raise HostError(f"{line.file}:{line.line} no longer reads exactly {line.text.strip()!r} - not editing it")
    lines[line.line - 1] = new_text
    mode = os.stat(path).st_mode & 0o777
    atomic_write(path, "\n".join(lines), mode)
    return new_text


def replace(repo: str, pin: PinLine, new_value: str) -> str:
    """Rewrite pin.line from pin.value to new_value. Returns the new line.

    Aborts - writing nothing - unless the line on disk is exactly pin.text and
    the value on it is exactly pin.value.
    """
    if not IMAGE.fullmatch(new_value):
        raise HostError(f"{new_value!r} is not an image reference this will write")
    path = os.path.join(repo, pin.file)
    with open(path, encoding="utf-8") as fh:
        data = fh.read()
    lines = data.split("\n")
    if pin.line < 1 or pin.line > len(lines) or lines[pin.line - 1] != pin.text:
        raise HostError(f"{pin.file}:{pin.line} no longer reads exactly {pin.text.strip()!r} - not editing it")
    m = _LINE.fullmatch(pin.text)
    if not m or m.group("v") != pin.value:
        raise HostError(f"{pin.file}:{pin.line} does not carry exactly {pin.value!r} - not editing it")
    new = f"{m.group('pre')}{m.group('q')}{new_value}{m.group('q')}{m.group('post') or ''}"
    lines[pin.line - 1] = new
    mode = os.stat(path).st_mode & 0o777
    atomic_write(path, "\n".join(lines), mode)
    return new
