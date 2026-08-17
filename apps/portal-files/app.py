#!/usr/bin/env python3
"""portal-files - the read/write file API behind the portal's editor tier.

This is the first service on this box that can CHANGE anything, so a few
decisions are deliberate and worth stating rather than discovering later.

**No third-party dependencies.** stdlib http.server only. A framework would be
more comfortable, but this container holds read-write bind mounts on two git
repositories, and every dependency is something that can ship a vulnerability
into that position. There is not enough here to justify the surface.

**It does not authenticate or authorise anybody.** That happens at the edge:
Traefik's forwardAuth asks oauth2-proxy `/oauth2/auth?allowed_groups=editor`, and
a request that fails never reaches this process. Verified empirically before this
was written - a user holding editor got 202, the same user asking for `shell` got
403. Putting authz here as well would mean two places to get it right and two
places to get it wrong.

The consequence is the same rule the socket-proxy learned: **reachability IS
authorisation.** This publishes no host port and sits on its own network with
only Traefik. If it is ever put on devnet, ~20 containers get write access to the
docs, and nothing will warn you.

**Identity headers are for attribution, not permission.** X-Auth-Request-Email
names the git author. If it were spoofable the worst case is a wrong name in a
commit - not unauthorised access - because the decision was already made upstream.
The edge strips client-supplied X-Auth-Request-* anyway; see
edge/dynamic/portal-files.yml.

**Save writes to DISK, and this service does not commit at all.** A save used to
BE a git commit, which was right for a docs editor and wrong for an explorer over
the whole box - most saves are work in progress and should not each become a
commit. That produced a git area with stage/commit/discard/pull/push, and on
2026-08-15 those were removed too: git actions move to an in-browser command
surface, and a second narrower path to them here would be a duplicate to keep in
sync and a second thing to secure.

What remains of git here is READING - /repos, /status and /git/diff. Nothing in
this service changes a repository's history or its index.

Two things follow from save-writes-to-disk, and both are load-bearing rather than
tidy:

  * The conflict check is no longer optional. While a save was a commit, git was
    a safety net - a clobber sat in the object store and was recoverable.
    Writing straight to disk removes that net, so the baseMtime comparison in
    do_POST is the ONLY thing between a stale editor tab and someone else's
    work. The failure it prevents is silent, which is why it is the server's job.

  * The audit trail had to be rebuilt. Every write used to carry an author
    because every write was a commit; see audit().

**DELETE exists, and ONLY because the undo net does.** Removal was deliberately
absent while this service had no way to give a file back - `discard` was taken
out on 2026-08-15 for being the one irreversible verb here, and a delete with no
copy anywhere would have put that back under a friendlier name. The snapshot
trash changed the arithmetic rather than the appetite: /delete keeps the outgoing
bytes exactly as /write does, so removing a file is a thing you can walk back
from. That is also why the snapshot is the ONE place this service fails CLOSED
where the write path fails open - see _delete().
"""

from __future__ import annotations

import fnmatch
import io
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import safepath

PORT = int(os.environ.get("PORT", "8099"))

# A hard ceiling on one listing. ~/projects alone holds tens of thousands of
# files once you stop pruning; without a cap the JSON is tens of megabytes and
# the browser stalls. The cap is REPORTED (`truncated: true`) rather than applied
# quietly, because a tree that silently stops is how you conclude a file is
# missing when it is only past the cutoff.
MAX_LISTING = 4000

# Language hints for the editor's highlighter. Extension first, then whole
# filename for the ones that have no extension at all.
LANGS = {
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript",
    ".jsx": "javascript", ".mjs": "javascript", ".json": "json",
    ".py": "python", ".sh": "bash", ".bash": "bash", ".zsh": "bash",
    ".yml": "yaml", ".yaml": "yaml", ".toml": "toml", ".ini": "ini",
    ".md": "markdown", ".markdown": "markdown", ".rst": "rst",
    ".css": "css", ".html": "html", ".sql": "sql", ".go": "go",
    ".rs": "rust", ".txt": "text", ".env.example": "bash",
    "Dockerfile": "dockerfile", "justfile": "make", "Makefile": "make",
    ".gitignore": "text", ".dockerignore": "text",
}
GIT_TIMEOUT = 15

# An archive is the first expensive request this service serves.
# ThreadingHTTPServer spawns an unbounded thread per connection, so without this
# a handful of concurrent archive requests over a 2,748-file root would be the
# whole box's CPU. /raw is cheap and deliberately NOT gated - it must not queue
# behind a zip.
_ARCHIVE_SLOTS = threading.BoundedSemaphore(4)

# Sent on every /raw and /archive response.
#
# The CSP looks like it should break image display and does not, which is worth
# stating because it is counter-intuitive: CSP is enforced on DOCUMENTS and
# workers, never on subresource responses. When the portal renders
# <img src="/-/api/files/raw?...">, the browser applies the PAGE's CSP, not the
# image response's - so this header is inert on the normal path. The one place it
# IS enforced is a top-level navigation straight to the raw URL, where the
# browser synthesises an image document: `sandbox` gives that document an opaque
# origin, so any script that somehow got there is orphaned from the portal.
# That asymmetry is exactly what we want, which is why the directive stays short.
BYTE_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    # CORP is deliberately the PERMISSIVE value, and the route to it was two
    # measured failures rather than one decision - worth recording, because both
    # wrong answers look obviously right.
    #
    #   same-origin -> ERR_BLOCKED_BY_RESPONSE.NotSameOrigin
    #       Copied in from a single-origin design. But this endpoint exists
    #       precisely to serve a DIFFERENT origin, so it forbade the only request
    #       it was built for. Images silently vanished.
    #
    #   same-site   -> ERR_BLOCKED_BY_RESPONSE.NotSameSite
    #       The obvious fix, and also wrong: Chromium does not treat
    #       http://IP:80 and http://IP:8100 as same-site here. Verified in a real
    #       browser - no amount of reading settles it, because CORP is enforced
    #       by the browser and nowhere else.
    #
    # cross-origin is safe HERE because CORP is not what protects these bytes -
    # the session cookie is. It is SameSite=lax, and lax does NOT attach cookies
    # to cross-site SUBRESOURCE loads. So an unrelated website embedding
    # <img src="http://IP:8100/-/api/files/raw?..."> sends no cookie, hits
    # sso-viewer, and gets a 401 with no body. CORP would be refusing a request
    # that already fails.
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
    # Range IS implemented now, narrowly - video needs it to scrub. See
    # parse_range() for exactly how narrowly, and why.
    "Accept-Ranges": "bytes",
}


# Where the write log lands. A mounted path so it survives a container rebuild;
# stderr as well, so it shows up in `docker logs` without a second lookup.
AUDIT_PATH = os.environ.get("AUDIT_LOG", "/audit/writes.log")

_AUDIT_LOCK = threading.Lock()


def audit(who: str, action: str, res, size: int | None = None,
          extra: str = "") -> None:
    """Append-only record of every change this service makes.

    This exists because decoupling save from commit removed the audit trail
    without anyone asking for that. Every write USED to be a git commit with an
    author, so "who changed this file" was always answerable. Once save writes
    straight to disk, a file changes and nothing records who or when - and that
    is a property worth keeping deliberately rather than losing as a side effect.

    Append-only and boring on purpose: one line, `tail`-able, no rotation logic
    to get wrong, no format anything else has to parse. A failure to LOG must
    never fail the write - losing the record of a save is bad, refusing a
    legitimate save because the log is full is worse - so this swallows its own
    errors and reports them to stderr.
    """
    # Every field is flattened to one line before it is written.
    #
    # The log is tab-separated and one record per line, so a newline in ANY field
    # forges a record. `extra` carries the client's commit message and git accepts
    # multi-line messages, so a message containing
    #   "\n<timestamp>\tsomeone@else\tDISCARDED\tstacks/compose.yml"
    # produced a syntactically perfect entry attributing a destructive action to
    # another user. `relpath` is the same vector - newlines are legal in Linux
    # filenames.
    #
    # The point of this log is that a change is always attributable; a record
    # anyone can forge attributes nothing.
    def flat(v: object) -> str:
        return re.sub(r"[\r\n\t]+", " ", str(v)).strip()

    line = (f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\t{flat(who)}\t"
            f"{flat(action)}\t{flat(res.root_key)}/{flat(res.relpath)}"
            f"{f'   {int(size)} bytes' if size is not None else ''}"
            f"{f'   {flat(extra)}' if extra else ''}")
    sys.stderr.write(line + "\n")
    try:
        with _AUDIT_LOCK:
            os.makedirs(os.path.dirname(AUDIT_PATH), exist_ok=True)
            with open(AUDIT_PATH, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
    except OSError as e:
        sys.stderr.write(f"AUDIT LOG UNWRITABLE ({e}) - the write itself was fine\n")


# userinfo in a URL: scheme://<anything>@host. The token lives in that group.
_CREDS_IN_URL = re.compile(r"(\w+://)[^/\s@]+@")


def _redact(text: str) -> str:
    """Strip credentials out of anything git says before we repeat it."""
    return _CREDS_IN_URL.sub(r"\1<redacted>@", text)


def parse_range(header: str, size: int) -> tuple[int, int] | None | str:
    """Parse a Range header. Returns (start, end) inclusive, None, or "bad".

    Range was deliberately NOT implemented at first, and that was right while
    nothing was served inline that needed it: hand-rolled range parsing is a
    known-bad surface. A 72 MB video with no scrubbing is what changed the
    balance, so it is implemented as narrowly as possible instead of generally.

    What is supported: exactly ONE range, `bytes=start-end`, `bytes=start-`, and
    the suffix form `bytes=-N` (the last N bytes).

    What is refused, on purpose:
      * MULTIPLE ranges. They require multipart/byteranges framing, and they are
        also the amplification vector - one request asking for a thousand
        overlapping ranges costs the server a thousand times the file. Nothing
        here needs them.
      * Any unit other than bytes.
      * A start beyond the end of the file (416, per RFC 9110).

    Returning the string "bad" rather than raising keeps the caller's shape
    simple: None means "no range asked for", a tuple means honour it, "bad"
    means 416.
    """
    if not header:
        return None
    header = header.strip()
    if not header.startswith("bytes="):
        return "bad"
    spec = header[len("bytes="):].strip()
    if "," in spec:
        return "bad"                      # multi-range: refused, see above
    if "-" not in spec:
        return "bad"
    first, _, last = spec.partition("-")
    try:
        if not first:                     # bytes=-N  -> the final N bytes
            n = int(last)
            if n <= 0:
                return "bad"
            # A zero-length file has no last N bytes. Without this the branch
            # returned (0, -1) - it sits BEFORE the validation below, so nothing
            # else caught it - and _raw then emitted
            # `206 Content-Range: bytes 0--1/0`, which is not a parseable field
            # value. RFC 9110 wants 416 here. Reachable with any empty file in a
            # repo (.keep, py.typed, a freshly touched file).
            if size == 0:
                return "bad"
            return (max(0, size - n), size - 1)
        start = int(first)
        end = int(last) if last else size - 1
    except ValueError:
        return "bad"
    if start < 0 or end < start or start >= size:
        return "bad"
    return (start, min(end, size - 1))


def git(root: str, *args: str) -> subprocess.CompletedProcess:
    """Run git with argv, never a shell.

    subprocess with a list means a filename containing `;` or `$(...)` is an
    argument and can never become a command. The whole class of shell-injection
    bugs is removed by construction rather than by escaping.
    """
    return subprocess.run(
        ["git", "-C", root, *args],
        capture_output=True, text=True, timeout=GIT_TIMEOUT,
    )


# ~/projects is mounted read-only, so nothing under it can be written no matter
# what the extension is. Saying so in the listing means the UI never offers a
# save button that can only fail.
# Derived from safepath.WRITABLE_ROOTS rather than restated, because restating
# it is what let the two drift: WRITABLE_ROOTS said {stacks, notes} and this set
# said "everything except projects", so `home` - which mounts /home/devssh and
# therefore ALIASES every other root - was reported to the UI as writable.
#
# Three things followed. /roots and /tree advertised `readOnly: false` and
# `writable: true` for files under home, which is precisely what this flag exists
# to prevent. A write through home reached open() and died on the read-only bind
# mount as an opaque 500 instead of a 403. And /git/push through
# home/projects/<repo> passed the read-only check that the `projects` root
# exists to enforce, because home was not in the set.
READONLY_ROOTS = frozenset(safepath.ROOTS) - safepath.WRITABLE_ROOTS


def listing(root_key: str) -> tuple[list[dict], bool]:
    """Every readable file under a root. Returns (files, truncated)."""
    writable_root = root_key not in READONLY_ROOTS
    root = safepath.ROOTS[root_key]
    real = os.path.realpath(root)
    out: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(real, followlinks=False):
        # Prune in place so os.walk never descends where policy would refuse.
        # Must go through prune_dirs(), not a bare DENY_COMPONENTS test: the
        # per-root rules (top-level dotfiles, ~/backups) are otherwise applied
        # only at resolve() time, and the walk pays for 30,093 files it discards.
        dirnames[:] = safepath.prune_dirs(
            root_key, os.path.relpath(dirpath, real), dirnames)
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            try:
                res = safepath.resolve(root_key, os.path.relpath(full, real))
            except safepath.PathRefused:
                # A symlink out of the root lands here. Skipped, not surfaced:
                # the listing is a menu, and an entry that cannot be opened is
                # worse than an absent one.
                continue
            try:
                st = os.stat(res.abspath)
            except OSError:
                continue
            out.append({
                "path": res.relpath,
                "dir": os.path.dirname(res.relpath),   # so a UI can build a tree
                "size": st.st_size,
                "mtime": int(st.st_mtime),
                # Writable now means only "the root allows writes". The suffix
                # allowlist that used to narrow this is gone - see [write] in
                # policy.toml - so the explorer no longer greys out a compose
                # file it is perfectly able to save.
                "writable": writable_root,
                # The LABEL, not a refusal. A name-shaped credential is served
                # and marked; the client decides how loudly to say so.
                "sensitive": safepath.is_sensitive_name(fn),
                "lang": LANGS.get(os.path.splitext(fn)[1].lower())
                        or LANGS.get(fn),
            })
            if len(out) >= MAX_LISTING:
                # A cap, and it is REPORTED rather than silently applied - a
                # truncated tree that claims to be complete is how you conclude a
                # file does not exist when it is only past the cutoff.
                return sorted(out, key=lambda f: f["path"]), True
    return sorted(out, key=lambda f: f["path"]), False


def is_binary(path: str) -> bool:
    """Cheap, and honest about being cheap.

    A NUL byte in the first 8 KB is what `git` and `file` both use, and it is
    right far more often than a extension list would be - this tree contains
    images, sqlite files and compiled artefacts under names nobody predicted.
    Dumping those bytes into a browser as "text" produces a hung tab, so the
    read endpoint reports `binary: true` and sends no content at all.
    """
    try:
        with open(path, "rb") as fh:
            return b"\x00" in fh.read(8192)
    except OSError:
        return True


# ── search ──────────────────────────────────────────────────────────────────
#
# Full-text search across every markdown file - and every other text file - on the
# box. The explorer's filter searches NAMES only, over a tree the browser already
# holds; this reads file BYTES on the server. They are different questions and
# this answers the second one.
#
# THE WALK GOES THROUGH safepath.collect(), and that is the whole security design
# of this feature. collect()'s own docstring argues it: listing() doing its own
# os.walk was "correct, but a PATTERN, and a second implementation can copy a
# pattern incorrectly". A search endpoint is precisely where a forgotten
# resolve() puts a line of ~/stacks/.env into a result snippet - the file is
# denied by name, but only if something asks. collect() already applies
# prune_dirs, resolve, is_denied_name, the per-root top-level rules, symlink
# refusal and safe_open to every path it returns, so nothing here can widen the
# served set. It takes its limits as arguments for exactly this reason: a second
# consumer with different bounds, not a second walk.
SEARCH_MAX_FILES = 20_000        # candidate files enumerated, per request
SEARCH_MAX_FILE_BYTES = 2_000_000  # bigger than this is not prose; skipped
SEARCH_MAX_MATCHES = 500         # the browser renders every one of these
SEARCH_MAX_PER_FILE = 20         # one generated file must not fill the page
SEARCH_SECONDS = 10.0            # the READ phase; collect() bounds the walk
SEARCH_LINE_CHARS = 400          # a minified line is not a search result


def searchable_roots() -> list[str]:
    """Roots to search when the caller asks for all of them.

    Every root except the ones that ALIAS another. `home` mounts /home/devssh and
    therefore reaches `stacks`, `notes` and `projects` a second time, so searching
    all four returns every hit twice under two different names - and the second
    name is the one whose root cannot be written to, so clicking it opens a
    read-only view of a file that is editable elsewhere.

    THE DERIVED VERSION DOES NOT WORK, and this is worth recording because it is
    the obvious implementation. "Skip a root whose directory contains another
    root's directory" is correct on the host and blind inside the container:
    compose mounts each root separately at /repos/<name>, so /repos/home does not
    contain /repos/stacks by any path comparison available to this process. It
    was written that way first, and checks/search_denied.py caught it - the
    endpoint answered, the results looked plausible, and every file appeared
    twice.

    So the overlap is DECLARED, in policy.toml, next to the mount it is a
    property of. The containment test stays as a second, automatic guard for the
    case somebody does nest two roots inside one mount, where it does work.
    """
    real = {k: os.path.realpath(p) for k, p in safepath.ROOTS.items()}
    return sorted(
        k for k, p in real.items()
        if k not in safepath.ALIAS_ROOTS
        and not any(q != p and q.startswith(p + os.sep) for q in real.values())
    )


def _excerpt(line: str, at: int, width: int = SEARCH_LINE_CHARS) -> tuple[str, int]:
    """Trim a long line to a window around the hit. Returns (text, new offset).

    The offset is returned because the UI highlights the match by position, and a
    trimmed line whose offset still refers to the untrimmed one highlights the
    wrong characters - which looks like a bug in the search rather than in the
    rendering.
    """
    line = line.rstrip("\n").replace("\t", "    ")
    if len(line) <= width:
        return line, at
    start = max(0, at - width // 3)
    text = line[start:start + width]
    return ("…" + text if start else text), at - start + (1 if start else 0)


def search(root_keys: list[str], rel: str, needle: str, *,
           case: bool = False, glob: str | None = None,
           limit: int = SEARCH_MAX_MATCHES) -> dict:
    """Literal substring search over file CONTENT and file NAMES.

    LITERAL, not a regex, and that is a decision rather than an omission. A
    caller-supplied regex over a few thousand files is a CPU denial of service
    that needs no privilege at all - one nested quantifier and this process, which
    holds read-write handles on two repositories, stops answering. If a regex mode
    is ever wanted it needs a per-file timeout, which stdlib `re` cannot give;
    passing the pattern straight through is not the cheap version of that, it is
    the broken one.

    Content hits and name hits are returned SEPARATELY. Merging them would make
    the count meaningless: a file whose name matches has no line number, and the
    UI has to say which question it answered.
    """
    if not needle:
        raise safepath.PathRefused("empty query")
    deadline = time.monotonic() + SEARCH_SECONDS
    hay_fold = None if case else str.lower
    target = needle if case else needle.lower()

    matches: list[dict] = []
    names: list[dict] = []
    scanned = 0
    skipped = 0
    truncated: dict | None = None

    for root_key in root_keys:
        if truncated:
            break
        # collect() raises ArchiveRefused when a bound bites, and that propagates
        # to a 413 carrying the numbers. Deliberate: a *walk* that ran out of
        # budget has seen an unknown fraction of the tree, so "here are some
        # results" would be a claim we cannot support. The MATCH bounds below are
        # different - they stop after a complete-enough look, so they truncate and
        # say so.
        members, skips = safepath.collect(
            root_key, rel,
            max_entries=SEARCH_MAX_FILES,
            max_total=1 << 40,          # not building an archive; size is not the bound
            max_member=SEARCH_MAX_FILE_BYTES,
            walk_seconds=max(1.0, deadline - time.monotonic()),
        )
        skipped += len(skips)

        for m in members:
            if time.monotonic() > deadline:
                truncated = {"reason": "took too long", "seconds": SEARCH_SECONDS,
                             "scanned": scanned}
                break
            if len(matches) >= limit:
                truncated = {"reason": "too many matches", "limit": limit,
                             "scanned": scanned}
                break

            res = m.res
            base = os.path.basename(res.relpath)
            if glob and not fnmatch.fnmatch(base.lower(), glob.lower()):
                continue

            if target in (base if case else base.lower()):
                names.append({"root": root_key, "path": res.relpath,
                              "size": m.size, "mtime": m.mtime})

            # A file is read only for CONTENT. The name half above still answers
            # for a binary or an oversized file, which is the useful half there.
            if m.size > SEARCH_MAX_FILE_BYTES or is_binary(res.abspath):
                skipped += 1
                continue
            try:
                with open(res.abspath, encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except OSError:
                skipped += 1
                continue
            scanned += 1

            # One pass over the whole file before splitting it into lines: the
            # overwhelming majority of files do not match at all, and splitlines()
            # on every one of them is most of the cost of the endpoint.
            hay = text if case else hay_fold(text)
            if target not in hay:
                continue

            hits = 0
            for n, line in enumerate(text.splitlines(), 1):
                col = (line if case else line.lower()).find(target)
                if col < 0:
                    continue
                shown, at = _excerpt(line, col)
                # TWO offsets, because two different consumers need two
                # different origins and conflating them puts the highlight in
                # the wrong place in one of them:
                #   col  - into `text`, which may have been trimmed. The result
                #          list marks the run here.
                #   srcCol - into the real line in the file. The editor selects
                #          this range when you click through to the file, and on
                #          a trimmed line it is NOT the same number.
                matches.append({"root": root_key, "path": res.relpath,
                                "line": n, "col": at, "srcCol": col,
                                "text": shown})
                hits += 1
                if hits >= SEARCH_MAX_PER_FILE:
                    matches[-1]["more"] = True
                    break
                if len(matches) >= limit:
                    break

    return {
        "query": needle,
        "roots": root_keys,
        "path": rel,
        "matches": matches,
        "names": names,
        "scanned": scanned,
        "skipped": skipped,
        # Always present, null when nothing was cut. A truncation field that only
        # appears when it fired is one a caller forgets to check.
        "truncated": truncated,
    }


# ── backlinks ───────────────────────────────────────────────────────────────
#
# "3 documents link here". A markdown corpus is a graph and the reader only ever
# sees one direction of it: the links OUT of the page they are on. The edges
# pointing IN are the ones that say whether a note is load-bearing or orphaned,
# and no document knows its own.
#
# THE WALK GOES THROUGH safepath.collect(), for the reason the search comment
# above gives at length: a second os.walk is a second chance to forget the
# per-entry resolve(), and that is exactly how `.env` ends up in an index. This
# is a READ, like search, so it does NOT pass for_archive - that flag is the
# difference between "a credential file is excluded from a bulk download" and "an
# index lies about what is on disk", and only the archive endpoints want it.
#
# MARKDOWN ONLY, and the constraint is doing real work rather than being tidy.
# A link graph over `.py`, `.png` and `.sqlite` is not a document graph; those
# files are not documents, cannot carry a wikilink, and including them turns a
# few hundred reads into a whole-tree read of every byte in the root for edges
# that cannot exist.
LINKS_MAX_FILES = SEARCH_MAX_FILES        # candidates the WALK may enumerate
LINKS_MAX_DOCS = 2_000                    # markdown files actually indexed
LINKS_MAX_FILE_BYTES = 1_000_000          # per file; bigger than this is not prose
LINKS_SECONDS = 10.0                      # the READ phase; collect() bounds the walk
# The title is looked for in the HEAD of the file only. A `# heading` that is not
# in the first couple of lines is not the document's title - it is a section - so
# scanning further would find the wrong string, and it would do it while reading
# every byte of every document a second time. 200 bytes clears a front-matter-less
# `# Title` line with room for a leading blank line or two.
LINKS_TITLE_BYTES = 200
MARKDOWN_SUFFIXES = (".md", ".markdown")

# `[label](target)` - deliberately the same shape as the link arm of INLINE_RE in
# md.tsx. If the two disagree, the reader sees a link the index does not count or
# counts one the reader cannot follow, and both look like a bug in the backlinks
# rather than in the parser.
_RE_INLINE_LINK = re.compile(r"\[[^\]\n]*\]\(([^)\s]+)\)")
# `[[target]]` and `[[target|label]]` - the notes' own convention (see the
# "Cross-link liberally with wikilinks" rule in claude-notes/README.md). The
# renderer does not resolve these yet; the index does, because a wikilink is the
# commonest edge in the corpus this feature exists for.
_RE_WIKI_LINK = re.compile(r"\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]")
# A fence opens and closes with the SAME character, and the closer must be at
# least as long as the opener - so a ```` ``` ```` inside a ```` ```` ```` block
# does not end it. Up to three leading spaces, per CommonMark.
_RE_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
# An inline code span is literal, and md.tsx already treats it that way - its
# INLINE_RE puts the backtick arm FIRST, so `[foo](bar)` inside backticks renders
# as code and never as a link. Blanked here so the two agree.
_RE_CODESPAN = re.compile(r"`[^`\n]+`")
# Anything carrying a scheme, or a protocol-relative `//host/x`, is a URL and not
# a path into this root - the same test md.tsx applies before it will resolve
# anything. A bare `#anchor` names a place INSIDE the document, so it is not an
# edge between documents either.
_RE_SCHEME = re.compile(r"^([a-z][a-z0-9+.-]*:|//)", re.I)
_RE_TITLE = re.compile(r"^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$", re.M)


def _doc_title(head: str, relpath: str) -> str:
    """The first `# heading` in `head`, or the filename made readable."""
    m = _RE_TITLE.search(head)
    if m:
        return m.group(1).strip()
    # Only the first character is capitalised. Title-casing the rest turns `dns`
    # into "Dns" and `wsl.md` into "Wsl", which is worse than leaving them alone -
    # this fallback exists for the untitled file, not to rename anything.
    stem = os.path.splitext(os.path.basename(relpath))[0].replace("-", " ").replace("_", " ")
    return stem[:1].upper() + stem[1:] if stem else relpath


def _link_targets(text: str) -> list[tuple[str, bool]]:
    """Every (target, is_wikilink) in a document, code excluded.

    FENCED BLOCKS ARE SKIPPED ENTIRELY, and that is not a nicety: this repo's
    documentation is largely about shell commands and config, so a code sample
    containing `[foo](bar)` or a glob that looks like `[[x]]` is common. Counting
    those would make the backlink number a count of code samples, which is the
    one number nobody asked for.
    """
    out: list[tuple[str, bool]] = []
    fence = ""
    for line in text.splitlines():
        m = _RE_FENCE.match(line)
        if m:
            mark = m.group(1)
            if not fence:
                fence = mark
            elif mark[0] == fence[0] and len(mark) >= len(fence):
                fence = ""
            continue
        if fence:
            continue
        line = _RE_CODESPAN.sub(" ", line)
        for w in _RE_WIKI_LINK.finditer(line):
            out.append((w.group(1).strip(), True))
        for i in _RE_INLINE_LINK.finditer(line):
            out.append((i.group(1).strip(), False))
    return out


def _resolve_link(src_dir: str, target: str, wiki: bool,
                  index: dict, by_base: dict[str, list[str]]) -> str | None:
    """Which document in THIS INDEX a target names, or None.

    RESOLUTION IS A LOOKUP IN THE INDEX, never a stat() of a path built from file
    content, and that is the security shape of this function. The index holds
    exactly what safepath.collect() proved readable, so an edge can only ever name
    a file that walk already allowed - a link that says `../../../.env` or
    `~/.ssh/id_ed25519` resolves to nothing at all, because those are not keys in
    the dict. Touching the filesystem here would put a second, weaker path to the
    same question beside the one that is already correct.

    The joining rules are md.tsx's resolveRelative(), for the reason the shapes
    above are shared: a link the reader can click and the index cannot count is
    indistinguishable from a broken backlink count.
    """
    rel = target.split("#", 1)[0].split("?", 1)[0].strip()
    if not rel or _RE_SCHEME.match(rel):
        return None
    # A leading slash means "from the top of this root" - there is no other
    # document root here for it to mean.
    parts = [] if rel.startswith("/") else [p for p in src_dir.split("/") if p]
    for seg in rel.split("/"):
        if not seg or seg == ".":
            continue
        if seg == "..":
            if not parts:
                return None      # climbing out of the root is not an edge
            parts.pop()
            continue
        parts.append(seg)
    if not parts:
        return None
    cand = "/".join(parts)
    if cand in index:
        return cand
    # A wikilink carries no extension, and neither does a hand-written relative
    # link to a sibling note. Both spellings are what a human means by the file.
    for suffix in MARKDOWN_SUFFIXES:
        if cand + suffix in index:
            return cand + suffix
        if f"{cand}/index{suffix}" in index:
            return f"{cand}/index{suffix}"
    if not wiki:
        # Only wikilinks get the basename fallback. An inline `[x](notes)` that
        # points nowhere is a broken link in the document and should read as one;
        # inventing a target for it would put an edge on the page that the reader
        # cannot follow.
        return None
    # `[[dns]]` means the document called dns.md wherever it lives - the notes are
    # written that way on purpose ("cross-link liberally") and a wikilink is a
    # NAME, not a path. Both spellings are tried, because `[[dns.md]]` is the same
    # link written by someone who knew the extension.
    base = os.path.basename(cand).lower()
    hits = [p for name in (base, base + ".md", base + ".markdown")
            for p in by_base.get(name, [])]
    if not hits:
        return None
    if len(hits) == 1:
        return hits[0]
    # AMBIGUITY IS RESOLVED DETERMINISTICALLY, not by walk order. Two files named
    # `dns.md` in different folders would otherwise attach the backlink to
    # whichever one os.walk reached first, so the same tree would answer
    # differently after a rename somewhere else entirely. Nearest first (same
    # directory as the linking document), then the shallowest path, then the name.
    return sorted(hits, key=lambda p: (os.path.dirname(p) != src_dir,
                                       p.count("/"), p))[0]


# The cache, keyed on (max mtime, file count) over the markdown files the walk
# returned.
#
# WHAT IT REMOVES is the READ, which is all of the cost: the walk is stat-only
# and takes tens of milliseconds, while opening and parsing several hundred
# documents is the second that a reader waits for on every page they open. So the
# walk still runs on every request and is what produces the key - a cache that
# skipped the walk could not know it was stale.
#
# WHY MTIME-MAX IS ENOUGH, and it is worth being precise because it is a
# heuristic and not a hash: any edit to any indexed file sets that file's mtime to
# now, so the maximum moves and the key changes. That covers the only mutation
# this service performs itself (a save) and every edit made from a shell.
#
# WHAT IT MISSES: a DELETE leaves the surviving files' mtimes alone, so the
# maximum can be unchanged - which is exactly why the count is half the key. What
# survives both halves is a change that cancels out: deleting one file while
# restoring another with a preserved old mtime (`cp -p`, `git checkout`, `rsync
# -t`) in the same instant, or an edit that deliberately rewinds the mtime with
# `touch -d`. Both are recoverable by touching any file in the tree, and neither
# is worth hashing several hundred documents on every request to catch.
_LINKS_CACHE: dict[tuple[str, str], tuple[tuple[int, int], dict]] = {}
_LINKS_CACHE_LOCK = threading.Lock()
# Per root AND per scope, bounded. ThreadingHTTPServer is one long-lived process,
# so an unbounded dict keyed on a caller-supplied path is a memory leak with a
# public trigger: `?path=` takes any directory in the root.
_LINKS_CACHE_MAX = 8


def links(root_key: str, rel: str = "") -> dict:
    """A markdown adjacency list over one root: who links out, who links in.

    `in` IS THE INVERSE OF `out`, computed by inverting the map rather than by a
    second pass over the corpus. A second pass would read every file twice to
    answer a question the first pass already answered, and - worse - it would be a
    second implementation of resolution, so the two directions could disagree.
    "3 documents link here" that does not match the three documents' own link
    lists is a bug nobody can see from either end.
    """
    deadline = time.monotonic() + LINKS_SECONDS
    members, _skipped = safepath.collect(
        root_key, rel,
        max_entries=LINKS_MAX_FILES,
        max_total=1 << 40,          # not building an archive; size is not the bound
        max_member=LINKS_MAX_FILE_BYTES,
        walk_seconds=max(1.0, deadline - time.monotonic()),
    )
    docs = [m for m in members
            if os.path.splitext(m.res.relpath)[1].lower() in MARKDOWN_SUFFIXES]

    truncated: dict | None = None
    if len(docs) > LINKS_MAX_DOCS:
        # Reported rather than applied quietly, exactly as /search and /tree do: a
        # backlink list that silently stops is how a reader concludes a page is an
        # orphan when it is only past the cutoff.
        truncated = {"reason": "too many documents", "limit": LINKS_MAX_DOCS,
                     "found": len(docs)}
        docs = sorted(docs, key=lambda m: m.res.relpath)[:LINKS_MAX_DOCS]

    stamp = (max((m.mtime for m in docs), default=0), len(docs))
    key = (root_key, rel or "")
    with _LINKS_CACHE_LOCK:
        cached = _LINKS_CACHE.get(key)
    if cached and cached[0] == stamp:
        return {**cached[1], "cached": True}

    index: dict[str, dict] = {}
    by_base: dict[str, list[str]] = {}
    raw: dict[str, list[tuple[str, bool]]] = {}
    scanned = 0

    for m in docs:
        if time.monotonic() > deadline:
            truncated = truncated or {"reason": "took too long",
                                      "seconds": LINKS_SECONDS, "scanned": scanned}
            break
        path = m.res.relpath
        try:
            with open(m.res.abspath, encoding="utf-8", errors="replace") as fh:
                text = fh.read(LINKS_MAX_FILE_BYTES)
        except OSError:
            # One unreadable file must not lose the other six hundred - the same
            # split collect() makes between per-file problems and whole-request
            # limits.
            continue
        scanned += 1
        index[path] = {"title": _doc_title(text[:LINKS_TITLE_BYTES], path),
                       "out": [], "in": []}
        by_base.setdefault(os.path.basename(path).lower(), []).append(path)
        raw[path] = _link_targets(text)

    for src, targets in raw.items():
        seen: list[str] = []
        for target, wiki in targets:
            dst = _resolve_link(os.path.dirname(src), target, wiki, index, by_base)
            # A document that links to itself is not a backlink. Left in, every
            # page with a table of contents would report that one document links
            # here - itself - which is the one answer the reader already has.
            if dst is None or dst == src or dst in seen:
                continue
            seen.append(dst)
        index[src]["out"] = sorted(seen)

    for src, doc in index.items():
        for dst in doc["out"]:
            # `out` only ever names a key of `index`, so this cannot raise and
            # cannot invent a node. That is the same property that keeps a denied
            # file out of the graph: it was never indexed, so nothing can point at
            # it and it can point at nothing.
            index[dst]["in"].append(src)
    for doc in index.values():
        doc["in"].sort()

    payload = {
        "root": root_key,
        "path": rel,
        "docs": index,
        "scanned": scanned,
        "edges": sum(len(d["out"]) for d in index.values()),
        # Always present, null when nothing was cut - see /search.
        "truncated": truncated,
    }
    with _LINKS_CACHE_LOCK:
        if len(_LINKS_CACHE) >= _LINKS_CACHE_MAX and key not in _LINKS_CACHE:
            _LINKS_CACHE.pop(next(iter(_LINKS_CACHE)))
        _LINKS_CACHE[key] = (stamp, payload)
    return {**payload, "cached": False}


def history(res: safepath.Resolved, limit: int = 20) -> list[dict]:
    # A file under no repository has no history. Real state, not an error: it is
    # why the write path also reports `committed: false` rather than pretending.
    if not res.git_root:
        return []
    p = git(res.git_root, "log", f"-{limit}", "--follow",
            "--format=%H%x1f%an%x1f%aI%x1f%s", "--", res.git_relpath)
    if p.returncode != 0:
        return []
    out = []
    for line in p.stdout.splitlines():
        parts = line.split("\x1f")
        if len(parts) == 4:
            out.append({"sha": parts[0][:9], "author": parts[1],
                        "date": parts[2], "subject": parts[3]})
    return out


def repos(root_key: str, rel: str = "") -> dict:
    """Repositories at the TOP LEVEL of a scoped directory, and nothing deeper.

    Deliberately not a recursive search. ~/projects contains three repos at its
    top level and a great many more nested inside node_modules, vendor
    directories and fixtures - listing those would bury the three you meant under
    dozens you did not, which is exactly the complaint that prompted scoping.

    So: direct children only, plus the scoped directory itself if it is a repo.
    Scoping to `projects/army/Tals` gives you Tals; scoping to `projects` gives
    you the three; neither gives you a fixture repo six levels down.
    """
    base = safepath.resolve(root_key, rel or ".")
    found = []

    def describe(path: str, name: str) -> dict | None:
        if not os.path.isdir(os.path.join(path, ".git")):
            return None
        head = git(path, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        last = git(path, "log", "-1", "--format=%h%x1f%s%x1f%aI").stdout.strip()
        sha, subject, when = (last.split("\x1f") + ["", "", ""])[:3]
        dirty = [l for l in git(path, "status", "--porcelain").stdout.splitlines() if l]
        return {
            "name": name,
            "path": os.path.relpath(path, base.root_dir),
            "branch": head or "(detached)",
            "lastSha": sha, "lastSubject": subject, "lastDate": when,
            "dirty": len(dirty),
        }

    def children_of(path: str):
        try:
            entries = sorted(os.scandir(path), key=lambda e: e.name)
        except OSError:
            return
        for e in entries:
            if not e.is_dir(follow_symlinks=False) or e.name in safepath.DENY_COMPONENTS:
                continue
            try:
                safepath.resolve(root_key, os.path.relpath(e.path, base.root_dir))
            except safepath.PathRefused:
                continue
            yield e

    here = describe(base.abspath, os.path.basename(base.abspath) or root_key)
    if here:
        found.append(here)
    else:
        for e in children_of(base.abspath):
            d = describe(e.path, e.name)
            if d:
                found.append(d)
                continue
            # DEPTH 2, and only when the child is not itself a repo.
            #
            # Strict "direct children only" is defensible and useless in the
            # common case: ~/projects holds `army/`, which is not a repo, so
            # scoping to projects found NOTHING while the three repos sat one
            # level below. Descending once more finds them.
            #
            # It stops at two on purpose. That is the difference between "the
            # repos in this folder" and "every repo on the disk" - the latter
            # buries the three you meant under fixtures and vendored copies,
            # which is the complaint scoping exists to answer.
            for g in children_of(e.path):
                dd = describe(g.path, f"{e.name}/{g.name}")
                if dd:
                    found.append(dd)
    return {"root": root_key, "scope": base.relpath, "repos": found,
            "searchDepth": 2}


def status(root_key: str, rel: str = "") -> dict:
    """Which files have uncommitted changes, for the repo covering `rel`.

    This is what lets the explorer mark a changed file the way an editor does.
    Paths are returned RELATIVE TO THE ROOT so the UI can match them against the
    tree without knowing where the repository boundary sits - the boundary is a
    fact about the server's mounts, not something a client should have to model.
    """
    base = safepath.resolve(root_key, rel or ".")
    if not base.git_root:
        return {"root": root_key, "repo": None, "files": [], "branch": None}

    out = []
    p = git(base.git_root, "status", "--porcelain=v1", "-z", "--untracked-files=normal")
    # -z: NUL-separated, so a filename containing a space, a quote or a newline
    # parses correctly. The default format quotes and escapes those, and every
    # hand-written parser of it is wrong for some real filename.
    fields = [f for f in p.stdout.split("\0") if f]
    i = 0
    while i < len(fields):
        entry = fields[i]
        code, name = entry[:2], entry[3:]
        if code.startswith("R"):
            i += 1  # rename carries the old path as the next field; skip it
        try:
            res = safepath.resolve(root_key, os.path.relpath(
                os.path.join(base.git_root, name), safepath.ROOTS[root_key]))
            shown = res.relpath
        except (safepath.PathRefused, ValueError):
            # A change to a file the explorer will not show. Counted, not named -
            # otherwise the panel would advertise a path that 403s when clicked.
            shown = None
        out.append({"code": code.strip() or "?", "path": shown,
                    "staged": code[0] not in " ?", "untracked": code == "??"})
        i += 1
    branch = git(base.git_root, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    return {"root": root_key, "repo": os.path.basename(base.git_root),
            "branch": branch, "files": out}


class Handler(BaseHTTPRequestHandler):
    server_version = "portal-files"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # This API is same-origin behind Traefik and must never be usable
        # cross-origin: a page on another site could otherwise ride the user's
        # session cookie and commit on their behalf.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes_headers(self, code: int, extra: dict) -> None:
        """Write headers for a byte response, refusing to emit CR/LF in a value.

        send_header does no escaping at all - it is literally
        ("%s: %s\r\n" % (kw, value)).encode("latin-1", "strict") - so a value
        carrying CRLF injects arbitrary headers. Nothing in this service put user
        input in a header until Content-Disposition; this assertion is what keeps
        that true as the file grows.
        """
        self.send_response(code)
        for k, v in {**BYTE_HEADERS, **extra}.items():
            if "\r" in str(v) or "\n" in str(v):
                raise ValueError(f"refusing to write a header containing CR/LF: {k}")
            self.send_header(k, str(v))
        self.end_headers()

    def _disposition(self, disp: str, name: str) -> str:
        ascii_name, encoded = safepath.header_filename(name)
        return f"{disp}; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded}"

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
                return self._send(200, {"ok": True, "roots": sorted(safepath.ROOTS)})

            if route == "/roots":
                return self._send(200, {"roots": [
                    {"key": k,
                     "readOnly": k in READONLY_ROOTS,
                     }
                    for k in sorted(safepath.ROOTS)
                ]})

            if route == "/tree":
                root = q.get("root", "")
                if root not in safepath.ROOTS:
                    return self._send(400, {"error": f"unknown root {root!r}"})
                files, truncated = listing(root)
                return self._send(200, {"root": root, "files": files,
                                        "truncated": truncated,
                                        "readOnly": root in READONLY_ROOTS})

            if route == "/search":
                # `root=*` is every root that does not contain another - see
                # searchable_roots(). Anything else must name a root exactly;
                # there is no default and no "search everything" fallback, for
                # the same reason resolve() has no default root.
                root = q.get("root", "")
                if root == "*":
                    roots = searchable_roots()
                elif root in safepath.ROOTS:
                    roots = [root]
                else:
                    return self._send(400, {"error": f"unknown root {root!r}"})
                try:
                    limit = min(int(q.get("limit", SEARCH_MAX_MATCHES)),
                                SEARCH_MAX_MATCHES)
                except ValueError:
                    return self._send(400, {"error": "limit must be a number"})
                return self._send(200, search(
                    roots, q.get("path", ""), q.get("q", ""),
                    case=q.get("case") == "1",
                    glob=q.get("glob") or None,
                    limit=max(1, limit)))

            if route == "/links":
                # NO `root=*`, unlike /search, and the reason is the shape of the
                # answer rather than caution: `docs` is keyed on a path relative to
                # ONE root, and a link inside a document cannot name another root -
                # there is no syntax for it. A merged graph would have to key on
                # (root, path) tuples to stay honest, and every hit under `home`
                # would duplicate a node that already exists under stacks or notes.
                root = q.get("root", "")
                if root not in safepath.ROOTS:
                    return self._send(400, {"error": f"unknown root {root!r}"})
                # `path` scopes the graph to a subtree, like /search's. Backlinks
                # are read while a document is open, so the useful scope is often
                # the folder it lives in rather than a 3,000-file root.
                return self._send(200, links(root, q.get("path", "")))

            if route == "/read":
                res = safepath.resolve(q.get("root", ""), q.get("path", ""))
                if not os.path.isfile(res.abspath):
                    return self._send(404, {"error": "not a file"})
                st = os.stat(res.abspath)
                base = {
                    "root": res.root_key, "path": res.relpath,
                    "size": st.st_size, "mtime": int(st.st_mtime),
                    "versioned": res.git_root is not None,
                    "lang": LANGS.get(os.path.splitext(res.abspath)[1].lower())
                            or LANGS.get(os.path.basename(res.abspath)),
                    "writable": res.root_key not in READONLY_ROOTS,
                    # What this edit costs, if anything, decided from the path
                    # alone so it is known before a byte is read. None for the
                    # ordinary case.
                    "caution": safepath.caution_for(res.relpath),
                }
                # Binary is decided BEFORE the size check: a 40 MB png should
                # report "binary" rather than "too large to edit", which would
                # imply that a smaller one could be edited as text.
                if is_binary(res.abspath):
                    return self._send(200, {**base, "binary": True,
                                            "content": None, "writable": False,
                                            "history": history(res)})
                if st.st_size > safepath.MAX_BYTES:
                    return self._send(413, {"error": "file too large to open"})
                with open(res.abspath, encoding="utf-8", errors="replace") as fh:
                    content = fh.read()
                # Advisory, never a refusal - see scan_for_secret's docstring for
                # the measurement that settled it. The UI shows a caution; the
                # file still opens.
                #
                # TWO SOURCES, and the NAME is checked first because it is the
                # one that catches an empty or as-yet-unwritten credential file.
                # The content scan reads what is actually there; the name scan
                # knows what the file is FOR. `.env` with one commented line is
                # still the place secrets go, and only the name says so.
                sensitive = (
                    "the filename is the shape of a credential store"
                    if safepath.is_sensitive_name(os.path.basename(res.abspath))
                    else safepath.scan_for_secret(content)
                )
                return self._send(200, {**base, "binary": False,
                                        "content": content,
                                        "sensitive": sensitive,
                                        "history": history(res)})

            if route == "/history":
                res = safepath.resolve(q.get("root", ""), q.get("path", ""))
                return self._send(200, {"path": res.relpath, "history": history(res)})

            if route == "/repos":
                return self._send(200, repos(q.get("root", ""), q.get("path", "")))

            if route == "/status":
                return self._send(200, status(q.get("root", ""), q.get("path", "")))

            if route == "/git/diff":
                res = safepath.resolve(q.get("root", ""), q.get("path", ""))
                if not res.git_root:
                    return self._send(200, {"path": res.relpath, "diff": None,
                                            "reason": "not inside a git repository"})
                staged = q.get("staged") == "1"
                args = ["diff", "--no-color"] + (["--cached"] if staged else [])
                p = git(res.git_root, *args, "--", res.git_relpath)
                # An empty diff is a fact, not a failure: the file matches HEAD,
                # or the change is on the other side of the staging line.
                return self._send(200, {
                    "path": res.relpath, "staged": staged,
                    "diff": p.stdout, "empty": not p.stdout.strip()})

            if route == "/raw":
                return self._raw(q)

            if route == "/archive":
                return self._archive(q)

            return self._send(404, {"error": "no such endpoint"})
        except safepath.ArchiveRefused as e:
            # 413 with the numbers, so "select a smaller folder" is actionable
            # rather than a shrug. Raised during the PRE-WALK, so nothing has been
            # streamed and a normal JSON error is still possible - which is the
            # entire reason the walk happens before the write.
            return self._send(413, {"error": str(e), **e.facts})
        except safepath.PathRefused as e:
            # 403, not 404: the path was understood and deliberately refused.
            return self._send(403, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"ERROR {route}: {type(e).__name__}: {e}\n")
            return self._send(500, {"error": "internal error"})

    # ── write and delete ────────────────────────────────────────────────────
    def do_POST(self) -> None:  # noqa: N802
        route = urlparse(self.path).path
        # Every mutating endpoint goes through the same guard below. Adding one
        # that skips it is the failure mode this shape exists to prevent, so the
        # list is here rather than each handler remembering.
        # /write and /delete are the ONLY mutating endpoints on this service, and
        # they are named in ONE place on purpose. The CSRF, content-type and body
        # limits below are shared, so a third verb that dispatched itself before
        # reaching them would silently be the unprotected one - which is exactly
        # how a per-handler check goes wrong.
        #
        # /git/stage, /git/unstage, /git/discard, /git/commit, /git/pull and
        # /git/push were removed on 2026-08-15. Git actions are moving to an
        # in-browser command surface, so a second, narrower way to do them here
        # would be a duplicate to keep in sync and a second thing to secure.
        #
        # Removing them took three real risks with them: `discard`, the only
        # irreversible action this service had (git restore --worktree throws
        # away content that was never in the object store); the push credential,
        # which was the ONLY secret this container was ever going to hold; and
        # the `operator` tier, which existed solely to gate sync.
        #
        # /delete is NOT `discard` coming back, and the difference is the whole
        # licence for it: discard destroyed content that had never been anywhere
        # else, while a delete here refuses unless the snapshot trash took a copy
        # first. Removal is offered because the net exists, not despite it.
        if route not in ("/write", "/delete"):
            return self._send(404, {"error": "no such endpoint"})
        # ── CSRF, and why it is needed HERE and not before ──────────────────
        #
        # Raw bytes are served from a SANDBOX ORIGIN on another port so a hostile
        # SVG or PDF cannot touch the portal. That works for reading - a
        # different port is a different origin, so it cannot read the portal DOM
        # or the JSON API's responses.
        #
        # But COOKIES IGNORE PORTS. The oauth2-proxy session cookie is sent to
        # :8100 as well, and :8100 is SAME-SITE with the portal, so SameSite=lax
        # does NOT block a POST from a page there to /write here. Introducing the
        # sandbox origin is what creates this hole, so it is closed in the same
        # change.
        #
        # Requiring JSON is the load-bearing half. This handler calls
        # json.loads() on the body regardless of content type, so a text/plain
        # POST - which is a CORS-"simple" request and therefore skips the
        # preflight entirely - would otherwise be accepted. Demanding
        # application/json forces a preflight cross-origin, and the preflight
        # fails because this service sends no CORS headers at all.
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return self._send(415, {
                "error": "Content-Type must be application/json"})
        # Belt and braces for browsers that send it: an explicit statement that
        # the request did not come from another origin.
        site = self.headers.get("Sec-Fetch-Site")
        if site and site not in ("same-origin", "none"):
            return self._send(403, {
                "error": f"cross-origin writes are refused (Sec-Fetch-Site: {site})"})

        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > safepath.MAX_BYTES:
                return self._send(413, {"error": "body missing or too large"})
            body = json.loads(self.rfile.read(length))

            # Dispatched AFTER the guards above, never before them. _delete does
            # its own resolve() because a delete has no `content` and no temp
            # file, but it reaches this line having already paid the same CSRF,
            # content-type and body-size tolls as a save.
            if route == "/delete":
                return self._delete(body)

            res = safepath.resolve(body.get("root", ""), body.get("path", ""),
                                   for_write=True)
            # Belt and braces with the `ro` bind mount: the kernel would refuse
            # this anyway, but failing here gives a readable reason instead of an
            # EROFS traceback, and keeps the rule visible in the code.
            if res.root_key in READONLY_ROOTS:
                return self._send(403, {
                    "error": f"the {res.root_key!r} root is read-only"})
            content = body.get("content")
            if not isinstance(content, str):
                return self._send(400, {"error": "content must be a string"})
            if len(content.encode()) > safepath.MAX_BYTES:
                return self._send(413, {"error": "content too large"})

            # Attribution only - see the module docstring. Falls back rather than
            # failing: a missing header means a misconfigured edge, and losing the
            # author name is not a reason to refuse a legitimate edit.
            who = (self.headers.get("X-Auth-Request-Email")
                   or self.headers.get("X-Auth-Request-User") or "unknown")

            # ── THE CONFLICT CHECK ───────────────────────────────────────────
            #
            # This is load-bearing now in a way it was not before. While a save
            # WAS a commit, git was the safety net: a clobber sat in the object
            # store and could be recovered. Writing straight to disk removes that
            # net entirely, so this check is the only thing standing between a
            # stale editor tab and somebody else's work.
            #
            # The failure it prevents is silent, which is why it must be the
            # server's job and not the client's: you open a file, leave the tab,
            # a `git pull` or another editor rewrites it, and your tab still
            # holds the old content looking perfectly current. Saving would
            # revert the newer version with nothing anywhere saying "conflict".
            #
            # baseMtime is OPTIONAL, and that is deliberate - a client that does
            # not send it (curl, a script) is not blocked. But a client that DOES
            # send it gets the guarantee, and the UI always sends it.
            base_mtime = body.get("baseMtime")
            existed = os.path.exists(res.abspath)
            if base_mtime is not None and existed:
                current = int(os.stat(res.abspath).st_mtime)
                if int(base_mtime) != current:
                    with open(res.abspath, encoding="utf-8", errors="replace") as fh:
                        theirs = fh.read()
                    return self._send(409, {
                        "error": "the file changed on disk since you opened it",
                        "path": res.relpath,
                        "baseMtime": int(base_mtime), "currentMtime": current,
                        # BOTH versions, so the UI can offer keep/take/compare
                        # rather than making the user guess what they would lose.
                        "yours": content, "theirs": theirs,
                    })

            # ── THE UNDO NET ─────────────────────────────────────────────────
            #
            # Keep the outgoing bytes BEFORE the rename, while they are still
            # reachable. After os.replace the old content has no name and the
            # only reference to it is gone.
            #
            # The conflict check above stops you overwriting somebody ELSE's
            # work. Nothing stopped you overwriting your own - and since save
            # stopped committing, and the git verbs went with it, there was no
            # copy of the previous version anywhere on the box. This is that
            # copy. See safepath.snapshot for why it is best-effort.
            kept = (safepath.snapshot(res.root_key, res.relpath, res.abspath,
                                      content.encode())
                    if existed else None)

            os.makedirs(os.path.dirname(res.abspath), exist_ok=True)
            # Write to a temp file in the same directory, then rename. rename is
            # atomic within a filesystem, so a crash mid-write leaves the old file
            # intact rather than a truncated one.
            # A UNIQUE temp name per write, not a fixed `<path>.tmp`.
            #
            # This is a threaded server, so two saves of one file could both open
            # the same fixed temp path, interleave their writes, and the first
            # rename would move the SECOND's partial content into place while the
            # second failed with ENOENT. The mtime conflict check does not help:
            # both requests can legitimately hold the same baseMtime.
            #
            # Same directory, so os.replace stays an atomic rename within one
            # filesystem. mkstemp also means a real file called `x.md.tmp` in the
            # tree is never clobbered.
            tmpfd, tmp = tempfile.mkstemp(
                dir=os.path.dirname(res.abspath),
                prefix=f".{os.path.basename(res.abspath)}.", suffix=".tmp")
            try:
                with os.fdopen(tmpfd, "w", encoding="utf-8") as fh:
                    fh.write(content)
                os.replace(tmp, res.abspath)
            except BaseException:
                # Never leave the temp behind - it would be listed and served as
                # ordinary content by /tree and /read.
                if os.path.exists(tmp):
                    os.unlink(tmp)
                raise
            mtime = int(os.stat(res.abspath).st_mtime)

            # ── NO COMMIT ────────────────────────────────────────────────────
            #
            # Save used to mean commit. That was right for a docs editor and
            # wrong for a file explorer over the whole box, where most saves are
            # work in progress that should not each become a commit. Committing
            # is done with `git` in a terminal; this service has no verb for it.
            #
            # The cost is the audit trail: every write USED to be attributable,
            # because every write was a commit with an author. audit() replaces
            # that - see its docstring.
            audit(who, "WROTE", res, len(content.encode()))
            # A save whose previous version was NOT kept is worth a line of its
            # own. It is rare and it is the moment the net was missing.
            if existed and kept is None:
                audit(who, "NOSNAPSHOT", res, len(content.encode()))
            return self._send(200, {
                "ok": True, "path": res.relpath, "mtime": mtime,
                "created": not existed, "author": who,
                "bytes": len(content.encode()),
                # Whether the previous version was kept. Reported rather than
                # assumed, so "there is an undo net" is never something the UI
                # claims on the service's behalf.
                "snapshot": bool(kept),
                # Still reported so the UI can show whether this file is even
                # versioned, and offer the git area when it is.
                "versioned": res.git_root is not None,
                "history": history(res),
            })
        except safepath.PathRefused as e:
            return self._send(403, {"error": str(e)})
        except json.JSONDecodeError:
            return self._send(400, {"error": "body must be JSON"})
        except Exception as e:  # noqa: BLE001
            # The ROUTE, not a hardcoded "/write". Two verbs share this handler
            # now, and a 500 attributed to the wrong one sends whoever reads the
            # log to the wrong half of the file.
            sys.stderr.write(f"ERROR {route}: {type(e).__name__}: {e}\n")
            return self._send(500, {"error": "internal error"})

    # ── delete ──────────────────────────────────────────────────────────────
    def _delete(self, body: dict) -> None:
        """Remove one regular file, after keeping a copy of it.

        Reached only through do_POST, so the CSRF and body guards have already
        run. Every refusal below returns with the file still on disk; that is the
        property the checks assert, because a 403 that deleted anyway would look
        identical from the status code.
        """
        # Deleting IS a write, so it goes through the SAME resolve() with the
        # same for_write rules: containment proved on the resolved path, no
        # writing through a symlink, and nothing under a read-only root. A
        # narrower check written here would be a second boundary to keep correct,
        # which is the duplication safepath exists to prevent.
        res = safepath.resolve(body.get("root", ""), body.get("path", ""),
                               for_write=True)
        # Belt and braces with the `ro` bind mount, exactly as /write does it. The
        # kernel refuses regardless, but EROFS surfaces as an opaque 500, and the
        # rule is worth being able to read in the code.
        if res.root_key in READONLY_ROOTS:
            return self._send(403, {
                "error": f"the {res.root_key!r} root is read-only"})

        # lstat, not stat, and the FileNotFoundError branch is the 404 the caller
        # was promised would be DISTINGUISHABLE from a refusal. "there is nothing
        # here" and "you may not touch this" send someone to two different
        # places, and collapsing them into one code is how a deleted-by-someone-
        # else file gets reported as a permissions problem.
        try:
            st = os.lstat(res.abspath)
        except FileNotFoundError:
            return self._send(404, {"error": "no such file", "path": res.relpath})
        except OSError as e:
            return self._send(403, {"error": f"cannot stat: {e.strerror}"})

        # A DIRECTORY IS REFUSED EXPLICITLY, and that is the whole point of this
        # branch existing at all. os.unlink would raise EISDIR and land in the
        # 500 handler - a refusal by accident, which reads as a bug in the
        # service rather than as a decision, and which stops holding the moment
        # somebody "fixes" the 500 with rmtree. Recursive delete is out of scope:
        # one click that removes a subtree has no proportionate undo, because the
        # snapshot net below is per file.
        if stat.S_ISDIR(st.st_mode):
            return self._send(403, {
                "error": "refusing to delete a directory - one regular file at a time",
                "path": res.relpath})
        if not stat.S_ISREG(st.st_mode):
            # A fifo, socket or device node. os.walk puts these in filenames, so
            # they are reachable; none of them has bytes a snapshot could keep,
            # so removing one would be the unrecoverable case wearing a filename.
            return self._send(403, {
                "error": "not a regular file", "path": res.relpath})

        # Attribution only, same header and same fallback as /write - see the
        # module docstring. A missing header means a misconfigured edge, and
        # losing the name is not a reason to refuse a legitimate action.
        who = (self.headers.get("X-Auth-Request-Email")
               or self.headers.get("X-Auth-Request-User") or "unknown")

        # ── THE CONFLICT CHECK, for the reason /write has one ────────────────
        #
        # Deleting a file somebody rewrote a minute ago is the same class of
        # mistake as overwriting it: the tab you are looking at is stale and
        # nothing on the screen says so. If anything it is the worse half - an
        # overwrite leaves a file behind to notice, a delete leaves an absence.
        #
        # OPTIONAL exactly as it is on the write path, so curl and scripts are
        # not blocked; a client that sends it gets the guarantee, and the UI
        # always sends it.
        base_mtime = body.get("baseMtime")
        if base_mtime is not None:
            current = int(st.st_mtime)
            if int(base_mtime) != current:
                return self._send(409, {
                    "error": "the file changed on disk since you opened it",
                    "path": res.relpath,
                    "baseMtime": int(base_mtime), "currentMtime": current,
                    # The SIZE, not the bytes. /write returns both versions
                    # because it has keep/take/compare to offer; there is no
                    # merge to offer for a delete, and the file may be a 200 MB
                    # binary that a 409 body has no business carrying.
                    "size": st.st_size,
                })

        # ── THE UNDO NET, AND IT FAILS CLOSED HERE ───────────────────────────
        #
        # /write treats a missing snapshot as survivable and reports it: refusing
        # a save would destroy the very work the net exists to protect - unsaved
        # changes in a tab with nowhere to put them. A DELETE inverts that
        # argument completely. Refusing costs the caller nothing, because the
        # file they asked to remove is still sitting there; proceeding without a
        # copy is the one outcome on this service that nothing can walk back.
        #
        # So this is the single place where the net is a PRECONDITION.
        # safepath.snapshot returns None for a real failure - an unwritable
        # trash, or a file above SNAPSHOT_MAX_BYTES - and both are reasons to
        # stop rather than to shrug. The 16 MB ceiling means a very large file
        # cannot be removed through this API at all; that is a deliberate
        # consequence of the guarantee, and the error says so rather than
        # pretending the path was refused.
        kept = safepath.snapshot(res.root_key, res.relpath, res.abspath)
        if kept is None:
            # Logged even though nothing changed. The write path logs its
            # equivalent (NOSNAPSHOT) for the same reason: "the trash stopped
            # working" is precisely what this log gets read for afterwards, and a
            # refusal that leaves no trace is one nobody finds out about until a
            # delete that mattered.
            audit(who, "DELETE-REFUSED", res, st.st_size, "no snapshot was kept")
            return self._send(403, {
                "error": "refusing to delete: the previous version could not be "
                         "kept, so this would not be undoable",
                "path": res.relpath, "size": st.st_size})

        try:
            os.unlink(res.abspath)
        except FileNotFoundError:
            # Removed by somebody else between the lstat and here. Their outcome
            # is the one that was asked for, so it is not an error - but it is a
            # 404 and not a 200, because THIS request did not do it and the
            # audit line below would otherwise credit it.
            return self._send(404, {"error": "no such file", "path": res.relpath})
        except OSError as e:
            return self._send(403, {"error": f"cannot delete: {e.strerror}"})

        # The same audit line /write writes, through the same function, with the
        # same attribution. It matters more here than anywhere else: for every
        # other change the file itself is evidence of what happened, and after a
        # delete this line is the only record that the file ever existed.
        audit(who, "DELETED", res, st.st_size)
        return self._send(200, {
            "ok": True, "root": res.root_key, "path": res.relpath,
            "author": who, "bytes": st.st_size,
            # Always true by the time we reach this line - the refusal above is
            # the alternative. Reported anyway, so "you can undo this" is
            # something the UI reads from the response rather than something it
            # assumes about the server.
            "snapshot": True,
            "versioned": res.git_root is not None,
        })

    # ── raw bytes ───────────────────────────────────────────────────────────
    def _raw(self, q: dict) -> None:
        """Serve a file's bytes.

        THE ORDERING RULE: resolve() runs first, always. The content-type table
        may only NARROW what resolve() already allowed; it may never be a reason
        to serve something. A .pem is 403 here before any extension is examined,
        because resolve() refuses it - not because this function checks for it.

        Consequence worth stating: /raw is wider than /read in BYTES (it sends
        binaries, and files above /read's 1 MB ceiling) but the FILE SET is
        exactly identical, because both go through the same resolve(). That
        equality is the security invariant, and checks/test_safepath.py asserts
        it.

        Range is not implemented and not advertised. Nothing here is served
        inline that needs it, and hand-rolled range parsing is a genuinely
        bug-prone surface: suffix ranges, open-ended ranges, multipart/byteranges
        framing, and the overlapping-range amplification where one request costs
        N times the file.
        """
        res = safepath.resolve(q.get("root", ""), q.get("path", ""))
        fd, st = safepath.safe_open(res.abspath)
        # ONE owner for the descriptor, and it is this `with`.
        #
        # The previous shape closed the fd inline on the 413 and 416 branches and
        # ALSO had a `finally: if fd >= 0: os.close(fd)`, with only the success
        # path setting the fd = -1 sentinel. So both early returns closed the
        # same descriptor twice - and a second close does NOT reliably raise. It
        # succeeds and closes whatever file inherited that number in the
        # meantime, which on a ThreadingHTTPServer is ANOTHER REQUEST'S file:
        # thread A refuses a bad Range, thread B opens a file and is handed the
        # freed number, thread A's stray close silently breaks it, and thread B
        # serves a truncated body or 500s. Verified: closing a reused fd twice
        # succeeded and corrupted the second file.
        #
        # os.fdopen takes ownership immediately, so every exit - return, raise,
        # or the stream completing - closes exactly once and there is no
        # sentinel to keep in sync.
        with os.fdopen(fd, "rb", closefd=True) as fh:
            if st.st_size > safepath.MAX_RAW_BYTES:
                return self._send(413, {
                    "error": f"file too large to download "
                             f"({st.st_size // 1_000_000} MB, limit "
                             f"{safepath.MAX_RAW_BYTES // 1_000_000} MB)"})

            head = os.pread(fh.fileno(), 16, 0) if st.st_size else b""
            ctype, disp = safepath.content_policy(os.path.basename(res.abspath), head)

            # A big image is still a legitimate download - demote rather than
            # refuse, so the explorer does not lie about a file that exists.
            if disp == "inline" and st.st_size > safepath.MAX_RAW_INLINE_BYTES:
                ctype, disp = "application/octet-stream", "attachment"
            # The client may only ever DOWNGRADE to attachment. There is
            # deliberately no ?inline=1: a client-controllable disposition is the
            # exact primitive that turns the SVG refusal back into an XSS.
            if q.get("download") == "1":
                ctype, disp = "application/octet-stream", "attachment"

            rng = parse_range(self.headers.get("Range", ""), st.st_size)
            if rng == "bad":
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{st.st_size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

            start, end = rng if rng else (0, st.st_size - 1)
            length = end - start + 1
            extra = {
                "Content-Type": ctype,
                "Content-Length": length,
                "Content-Disposition": self._disposition(disp, res.relpath),
            }
            if rng:
                extra["Content-Range"] = f"bytes {start}-{end}/{st.st_size}"
            self._send_bytes_headers(206 if rng else 200, extra)

            try:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                sys.stderr.write(f"RAW aborted by client: {res.relpath}\n")

    # ── archives ────────────────────────────────────────────────────────────
    def _archive(self, q: dict) -> None:
        """Stream a zip or tar.gz of a file or folder.

        TWO PHASES, and the split is the design.

        Streaming alone cannot report a failure once the headers are out: a cap
        hit halfway leaves a truncated archive that looks complete. Buffering
        alone costs up to 143 MB of RAM in a container whose filesystem is
        read_only with only a tmpfs. So: walk and check EVERYTHING first, build a
        manifest (~300 KB at the entry cap), enforce every whole-request limit
        while a JSON error is still possible - then stream, where only a per-file
        OSError remains.

        tarfile.add() and shutil.make_archive() are BANNED here. They recurse on
        their own, bypassing collect() and therefore bypassing resolve() on every
        file below the first, and they copy uid/gid/mode/symlink-type off disk.
        They are by a wide margin the most likely way the per-entry check gets
        defeated. addfile(TarInfo(...), fileobj) only.
        """
        fmt = q.get("format", "zip")
        if fmt not in ("zip", "tgz"):
            return self._send(400, {"error": "format must be zip or tgz"})

        if not _ARCHIVE_SLOTS.acquire(blocking=False):
            self.send_response(503)
            self.send_header("Retry-After", "5")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        try:
            # Phase 1: everything that can fail cleanly.
            # for_archive=True is what excludes credential files from the zip.
            # They remain readable one at a time; see the comment on that check.
            members, skipped = safepath.collect(q.get("root", ""), q.get("path", ""),
                                                for_archive=True)
            if not members:
                return self._send(404, {"error": "nothing to archive here",
                                        "skipped": len(skipped)})

            stamp = max((m.mtime for m in members), default=0)
            name = f"{members[0].arcname.split('/')[0]}.{'zip' if fmt == 'zip' else 'tar.gz'}"
            self._send_bytes_headers(200, {
                "Content-Type": "application/zip" if fmt == "zip" else "application/gzip",
                "Content-Disposition": self._disposition("attachment", name),
                "X-Files-Entries": len(members),
                "X-Files-Skipped": len(skipped),
            })

            # Phase 2. wfile is a raw SocketIO with wbufsize=0, so every small
            # zipfile write would otherwise be its own send() syscall.
            out = io.BufferedWriter(self.wfile, 65536)
            note = _skip_note(skipped, len(members))
            try:
                if fmt == "zip":
                    _stream_zip(out, members, note, stamp)
                else:
                    _stream_tar(out, members, note, stamp)
                out.flush()
            except (BrokenPipeError, ConnectionResetError):
                sys.stderr.write("ARCHIVE aborted by client\n")
        finally:
            _ARCHIVE_SLOTS.release()


def _skip_note(skipped: list[dict], kept: int) -> bytes:
    """SKIPPED.txt - the archive says what it does not contain.

    An archive that silently omits files is how you conclude a file does not
    exist. Written as the FIRST entry so it is the first thing an extractor
    shows.
    """
    lines = [f"{kept} file(s) included, {len(skipped)} skipped.", ""]
    lines += [f"{s['why']:<48} {s['path']}" for s in skipped]
    return ("\n".join(lines) + "\n").encode()


def _zinfo(name: str, mtime: int) -> zipfile.ZipInfo:
    zi = zipfile.ZipInfo(name, date_time=time.localtime(mtime)[:6])
    zi.compress_type = zipfile.ZIP_DEFLATED
    # 0644, never the on-disk mode: a setuid or 0777 bit has no business
    # surviving into something a browser downloads.
    zi.external_attr = 0o644 << 16
    return zi


def _stream_zip(out, members, note: bytes, stamp: int) -> None:
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        prefix = members[0].arcname.split("/")[0]
        z.writestr(_zinfo(f"{prefix}/SKIPPED.txt", stamp or int(time.time())), note)
        for m in members:
            try:
                with open(m.res.abspath, "rb") as fh:
                    z.writestr(_zinfo(m.arcname, m.mtime), fh.read())
            except OSError:
                continue


def _stream_tar(out, members, note: bytes, stamp: int) -> None:
    # PAX, not the GNU/USTAR default: those truncate at 100 characters and paths
    # under ~/projects are already longer than that.
    with tarfile.open(fileobj=out, mode="w|gz", format=tarfile.PAX_FORMAT,
                      compresslevel=6) as t:
        prefix = members[0].arcname.split("/")[0]
        ti = tarfile.TarInfo(f"{prefix}/SKIPPED.txt")
        ti.size, ti.mtime, ti.mode = len(note), stamp or int(time.time()), 0o644
        t.addfile(ti, io.BytesIO(note))
        for m in members:
            ti = tarfile.TarInfo(m.arcname)
            ti.size, ti.mtime = m.size, m.mtime
            # Forced, never copied off disk - same reasoning as the zip mode.
            ti.mode, ti.uid, ti.gid, ti.type = 0o644, 0, 0, tarfile.REGTYPE
            ti.uname = ti.gname = ""
            try:
                with open(m.res.abspath, "rb") as fh:
                    t.addfile(ti, fh)
            except OSError:
                continue


if __name__ == "__main__":
    missing = [k for k, v in safepath.ROOTS.items() if not os.path.isdir(v)]
    if missing:
        sys.stderr.write(f"FATAL: roots not mounted: {missing}\n")
        sys.exit(1)
    sys.stderr.write(f"portal-files on :{PORT} roots={sorted(safepath.ROOTS)}\n")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
