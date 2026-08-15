"""Resolve a client-supplied path to a real file, or refuse.

This module is the entire security boundary of the file explorer, so it is pure
and separately testable: no HTTP, no globals, no filesystem writes. Everything it
returns has already been proven to sit inside an allowlisted root.

The threat is not exotic. This service holds bind mounts covering the stack repo,
the notes and every project on the box, and it takes a path from a browser. Every
classic escape applies:

    ../../../../etc/passwd          climbing out with dot-dot
    /etc/passwd                     an absolute path that ignores the root
    docs/link -> /etc               a symlink planted inside the root
    docs/../../.ssh/id_ed25519      dot-dot after a legitimate prefix
    .git/config                     inside the root, but not content

The defence is to resolve FIRST and compare AFTER. Checking the string for ".."
before resolving is the classic mistake: it cannot see a symlink, and it rejects
legitimate names that merely contain the characters. os.path.realpath() collapses
dot-dot AND follows every symlink, so the comparison happens on the real
destination - which is the only thing that matters.
"""

from __future__ import annotations

import fnmatch
import os
import re
import stat
import time
import urllib.parse
from dataclasses import dataclass

# Named roots, so a client never sends a filesystem path - only a short key that
# must match this table exactly. An unknown key is refused; there is no default
# and no fallback to "the whole disk".
#
# These are git repositories (or contain them), which is the entire versioning
# story: editing a file produces a commit, and `git log` is the page history.
# Nothing else needs to store versions.
ROOTS: dict[str, str] = {
    # The whole stack repo, not just docs/ - this is a file explorer now, so
    # compose files, scripts and source are all in scope for READING.
    "stacks": "/repos/stacks",
    "notes": "/repos/notes",
    "projects": "/repos/projects",
    # "any folder you can cd into". Mounted READ-ONLY, and the two rules below
    # (TOPLEVEL_DENY + dot-directories at root level) are what make it safe -
    # see the survey recorded there.
    "home": "/repos/home",
}

# Roots the write tier may touch. Everything else is browse-only.
#
# `home` is deliberately absent: it overlaps stacks and notes, so the same file
# is reachable by two names, and only ONE of them should be able to change it.
# Editing goes through the root that owns the repo.
WRITABLE_ROOTS = frozenset({"stacks", "notes"})

# Per-root policy, because the right rule is NOT the same for every root - and
# discovering that is what forced this table to exist.
#
# A dry run of the `home` root against the real directory served `.bash_history`.
# The dot-DIRECTORY rule missed it because it is a dot-FILE. The obvious fix -
# deny every top-level dotfile - is correct for a home directory, where they are
# all config and credentials, and WRONG for a repository, where `.gitignore`,
# `.env.example` and `.dockerignore` are things you open on purpose.
#
# So "deny top-level dotfiles" is a property of the ROOT, not of the service.
# This is the smallest honest version of per-path access control; it is meant to
# grow into a declared policy rather than stay a Python constant.
ROOT_POLICY: dict[str, dict] = {
    "home": {
        # Every credential store in a home directory is a top-level dot entry,
        # and nothing worth browsing is. Denying the whole class is one
        # auditable rule instead of a list that needs a new line each time
        # somebody installs a tool.
        "deny_toplevel_dots": True,
        "deny_toplevel": frozenset({"backups"}),
    },
}


def root_policy(root_key: str) -> dict:
    return ROOT_POLICY.get(root_key, {})


def prune_dirs(root_key: str, rel_dir: str, dirnames: list[str]) -> list[str]:
    """Which subdirectories a walk should DESCEND into, given the root's policy.

    Exists because policy and traversal drifted apart, and it cost a measured
    1.4 seconds per listing.

    `listing()` pruned DENY_COMPONENTS during the walk, but ROOT_POLICY denies
    `.npm`, `.cache`, `.local` and `backups` at RESOLVE time - so the walk
    happily descended into all of them and then paid a path resolution plus a
    raised exception for every single file, only to throw it away:

        visited 33,567 files -> refused 30,093 -> served 3,474

    90% of the work, discarded. Adding per-root policy without teaching the walk
    about it is what did that, so the fix is to make one function answer both
    questions and call it from every walk. `resolve()` still has the final say -
    this only stops us LOOKING somewhere it would refuse.
    """
    pol = root_policy(root_key)
    toplevel = rel_dir in ("", ".")
    deny_dots = toplevel and pol.get("deny_toplevel_dots")
    named = pol.get("deny_toplevel", ()) if toplevel else ()
    return [d for d in dirnames
            if d not in DENY_COMPONENTS
            and not (deny_dots and d.startswith("."))
            and d not in named]

# Directories denied when they are a DIRECT CHILD of a root.
#
# Everything dangerous in a home directory sits at its top level, and a survey of
# this one before mounting it found exactly that:
#
#   .claude/.credentials.json   live OAuth credentials
#   .config/gh/hosts.yml        a GitHub token
#   .ssh/ .gnupg/               private keys
#   .kube/config .docker/       cluster and registry credentials
#   .minikube/*.key             CA private keys
#   .bash_history               every command ever typed, secrets included
#
# ...and every one of those is a DOT directory, while every directory worth
# browsing (projects, stacks, claude-notes) is not. So the rule is: dot
# directories are denied at the top level of a root and allowed below it. That
# single line removes every credential store AND ~165,000 cache files
# (.npm 69k, .cache 76k, .local 18k) that would have made the explorer useless -
# while `.github/` inside a repo still opens, which a blanket dot-deny would
# have broken.
#
# The non-dot exceptions the survey turned up live in ROOT_POLICY below.

# The git repository each root lives inside, which is NOT always the root itself.
#
# A root is not always a repository, and a repository is not always a root. git
# needs the toplevel (that is where .git is); the browsable surface is whatever
# ROOTS says. Two different questions, so two different tables:
#
#   ROOTS      - what a human may open and change
#   GIT_ROOTS  - where the commit is recorded
#
# Collapsing them into one is the easy mistake, and it widens the blast radius
# without changing anything visible.
GIT_ROOTS: dict[str, str] = {
    "stacks": "/repos/stacks",
    "notes": "/repos/notes",
    # ~/projects is NOT one repo - it contains several unrelated ones (CVOps,
    # Tals, monorepo-inherited), each with its own .git. So there is no single
    # toplevel to commit against. git_root_for() walks up to find the right one
    # per file; a file under no repo at all is readable but cannot be committed,
    # which the write path reports honestly rather than silently not versioning.
}

# Write is restricted to text formats a human edits. This is not about parsing -
# it is a blast-radius limit. Without it, "edit a doc" also means "rewrite
# compose.yml", "rewrite a shell script that cron runs", or "drop a .py that
# something imports". The read side is deliberately wider than the write side.
# .svg and .html were added 2026-08-13 with their viewers. Worth stating plainly:
# a writable .html or .svg in a repo that some OTHER app serves is a stored-XSS
# vector in that app. That is a property of the repo rather than of this service,
# and it is a real widening of what the editor can change - not a formatting
# detail.
WRITABLE_SUFFIXES = frozenset({
    ".md", ".markdown", ".txt", ".rst", ".svg", ".html", ".htm", ".xml",
})

# Directories never served or listed, at any depth.
#
# `.git` is the big one: it holds the repo's own object store and config, and
# .git/config on a repo with a remote can carry a credential. node_modules and
# the build/venv dirs are excluded for volume rather than secrecy - they are tens
# of thousands of files nobody browses, and including them would make the tree
# useless and the listing slow.
DENY_COMPONENTS = frozenset({
    ".git", ".ssh", ".gnupg", "node_modules", ".venv", "venv",
    "__pycache__", ".mypy_cache", ".pytest_cache", "dist", "build",
    ".next", ".turbo", ".cache", "target",
})

# Files never served, matched on the FILENAME rather than on a path component.
#
# This is the control that widening the roots made necessary, and it is the
# reason read is now authenticated as well. Before this, the roots were two
# markdown trees; now they are the whole box, and a survey found what that
# actually contains:
#
#   ~/stacks/.env                       19 real secret values (postgres, the
#                                       shared dev login, grafana admin)
#   ~/projects/.../cert/key.pem         a real TLS private key
#
# Matching only path COMPONENTS - as the first version did - would never have
# caught either of those, because `.env` is a file and `key.pem` is a file. A
# deny-list that cannot see filenames is not a deny-list for secrets.
#
# fnmatch patterns, tested against the lowercased basename.
DENY_FILE_PATTERNS = (
    ".env", ".env.*", "*.env",          # NOT .env.example - allowed below
    "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore",
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "*.ppk",
    "*.kdbx", "*.gpg", "*.asc",
    ".netrc", ".pgpass", ".htpasswd", ".git-credentials",
    "credentials", "credentials.*", "*secret*", "*password*",
    "*.sqlite", "*.db",                 # may hold sessions/tokens
    # Keycloak realm exports. Added after this exact file - auth/realm-devbox.json -
    # was served to an authenticated viewer WITH a live client secret in it. Its
    # name suggests nothing; every pattern above missed it. It is the case that
    # proves a name-based deny-list is a filter and not a boundary, which is why
    # scan_for_secret() below exists as well.
    "realm-*.json", "*-realm.json", "realm.json",
)

# Content patterns that mean "this file carries a live credential", checked on
# the bytes rather than on the name.
#
# The name-based list above is necessary and insufficient: it catches the files
# somebody thought of. This catches the one nobody did, and it is the control
# that would have caught realm-devbox.json without anyone knowing it existed.
#
# Tuned to require an actual VALUE, because this repo's documentation talks about
# secrets constantly - README.md names POSTGRES_PASSWORD a dozen times, and
# refusing to serve the README would be a worse outcome than the risk. So a
# placeholder (`changeme`, `${VAR}`, `<your-password>`, `xxx`) does not trip it;
# a long opaque literal assigned to a secret-shaped key does.
_SECRET_KEY = r"(?:client[_-]?secret|api[_-]?key|access[_-]?token|private[_-]?key|password|passwd|secret)"
# Prefix matches, not exact: measured against the real tree, the two commonest
# false positives were `changeme-generate-one` (a placeholder with a suffix) and
# `${POSTGRES_PASSWORD:?set` (a shell variable reference, truncated by the value
# pattern at the first space). Both were flagged as live credentials by an exact
# match. Anchored at the start only, so anything BEGINNING like a placeholder or
# an interpolation is treated as one.
_PLACEHOLDER = re.compile(
    r"^(?:change[-_]?me|placeholder|example|sample|test|dummy|none|null|true|false"
    r"|your[-_]|my[-_]|xxx|\.\.\.|<|\$\{|\$[A-Z_]|__[A-Z_]|\*|redacted|todo)",
    re.I,
)
_SECRET_PATTERNS = (
    # "clientSecret": "aBc123..."   /   "secret": "aBc123..."
    re.compile(rf'"{_SECRET_KEY}"\s*:\s*"([^"]{{16,}})"', re.I),
    # PASSWORD=aBc123...  (unquoted or quoted)
    re.compile(rf'^\s*[A-Z_]*{_SECRET_KEY}[A-Z_]*\s*[=:]\s*["\']?([^\s"\'#]{{16,}})',
               re.I | re.M),
    # PEM private key blocks, whatever the file is called
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----"),
)


def scan_for_secret(text: str) -> str | None:
    """Return a short reason if the text looks like it carries a credential.

    ADVISORY ONLY. This does NOT refuse the file, and the distinction was decided
    by measurement rather than by taste.

    Run across all 3,369 readable text files on this box, the blocking version
    flagged 45. Inspecting them showed the top hits were `.env.example`,
    `auth/compose.yml` and several README files - precisely the files you most
    need to open in a file explorer. Two of the three sampled were outright false
    positives (a placeholder with a suffix; a `${VAR}` interpolation). Refusing
    those would have broken the tool for real content in order to hide dev
    passwords from someone who already holds the `viewer` role and can read the
    compose files anyway.

    So the honest arrangement is:
      - the NAME deny-list is the hard boundary for known secret files,
      - the `viewer` role is the actual access boundary,
      - and this marks a file so the UI can caution before showing it.

    A filter that pretends to be a boundary is worse than one that admits what it
    is - which is exactly why realm-*.json is denied BY NAME above rather than
    left to this.
    """
    for pat in _SECRET_PATTERNS:
        m = pat.search(text)
        if not m:
            continue
        if m.re.groups == 0:          # the PEM block - no value to inspect
            return "contains a private key block"
        val = m.group(1)
        if _PLACEHOLDER.match(val):
            continue
        return "contains what looks like a live credential"
    return None

# Explicit exceptions to the patterns above. A committed `.env.example` is a
# TEMPLATE full of placeholders - it is the file you read to learn what to set,
# and hiding it makes the explorer worse for no gain. It is allowed BY NAME so
# that the exception can never widen: `.env.example` is listed, `.env.production`
# is not.
ALLOW_FILES = frozenset({
    ".env.example", ".env.sample", ".env.template", ".env.test.example",
    ".env.local.template", ".env.production.template", ".env.defaults",
})

MAX_BYTES = 1_000_000  # a megabyte of markdown is already an unreasonable page

# ── serving raw bytes ───────────────────────────────────────────────────────
#
# THE ORDERING RULE, and it is the security property of this whole section:
#
#   resolve() runs FIRST, always. The content-type table may only NARROW what
#   resolve() already allowed. It may never be a reason to serve something.
#
# The tempting implementation - "look up the extension, if it is an image, serve
# it" - inverts that and turns a `.pem` into a download.

MAX_RAW_INLINE_BYTES = 25_000_000    # above this, demote to a download
MAX_RAW_BYTES = 200_000_000          # above this, refuse outright

# Extension -> (mime, accepted magic prefixes). Hardcoded on purpose.
#
# NOT mimetypes.guess_type(): its table is platform-dependent (it reads
# /etc/mime.types on some images) and already contains image/svg+xml and
# text/html. A security-relevant header must not be decided by a table that
# varies with the base image.
#
# Raster formats only. Every one of these is inert - it carries pixels, not
# script - which is exactly why the list is short and why SVG is not on it.
INLINE_TYPES: dict[str, tuple[str, tuple[bytes, ...]]] = {
    ".png": ("image/png", (b"\x89PNG\r\n\x1a\n",)),
    ".jpg": ("image/jpeg", (b"\xff\xd8\xff",)),
    ".jpeg": ("image/jpeg", (b"\xff\xd8\xff",)),
    ".gif": ("image/gif", (b"GIF87a", b"GIF89a")),
    ".webp": ("image/webp", (b"RIFF",)),      # plus a WEBP check at offset 8
    ".bmp": ("image/bmp", (b"BM",)),
    ".ico": ("image/vnd.microsoft.icon", (b"\x00\x00\x01\x00",)),
    ".avif": ("image/avif", ()),              # checked at offset 4, below
}

# Never inline, at any content-type, on any origin. A tripwire rather than the
# mechanism - INLINE_TYPES is an allowlist, so these are already excluded. The
# set exists so that widening the allowlist trips a test instead of shipping.
#
# SVG is the one people want and it is the one that matters most: an SVG is a
# document, it can carry <script>, and inline on the portal's origin that script
# can read every file in three roots and commit as the signed-in user. It already
# renders safely as highlighted SOURCE through /read - that is the answer, and it
# already ships. Do not build a second, dangerous path to the same file.
# Formats that must never be served inline ON THE PORTAL'S OWN ORIGIN. They are
# all documents that can carry script, and there the script would run beside the
# session cookie.
#
# They ARE served inline on the sandbox origin (:8100), which is the entire
# reason that origin exists: a different port is a different origin, so a script
# escaping one of these lands somewhere holding no portal DOM, under
# `default-src 'none'; sandbox`. FRAMED_TYPES below is that list.
#
# The distinction is worth stating because the two lists look contradictory: this
# one is "never on :80", not "never anywhere".
NEVER_INLINE = frozenset({
    ".swf",   # no viewer, no reason, and a byword for this whole problem
})

# Document formats rendered in a sandboxed frame on :8100.
#
# `sandbox` with no allow-* tokens gives the framed document an OPAQUE origin,
# which is what makes this safe: it cannot read :8100's other responses, cannot
# reach the portal, and `default-src 'none'` denies it script and network
# entirely. That is an assumption about browser behaviour, so it is tested
# empirically (checks/sandbox_escape.py) rather than trusted.
FRAMED_TYPES: dict[str, str] = {
    ".svg": "image/svg+xml",
    ".svgz": "image/svg+xml",
    ".html": "text/html",
    ".htm": "text/html",
    ".xhtml": "application/xhtml+xml",
    ".xht": "application/xhtml+xml",
    ".xml": "text/xml",
}

# Video, so the browser can play it. Needs Range - see _raw().
MEDIA_TYPES: dict[str, str] = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
    ".ogv": "video/ogg", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
    ".ogg": "audio/ogg", ".flac": "audio/flac",
}

# PDF is inline-able HERE and would not be on the portal's origin.
#
# Browser PDF viewers do execute JavaScript - Firefox's pdf.js runs in the
# embedding page's origin and CVE-2024-4367 was exactly arbitrary JS from a
# crafted PDF. That is precisely why these bytes are served from :8100 and
# nowhere else: a script that escapes the viewer lands on an origin that holds no
# portal DOM, and the response also carries `default-src 'none'; sandbox`, so an
# embedded PDF document gets an opaque origin and no script permission at all.
#
# SVG stays in NEVER_INLINE above even so, because it has a good alternative that
# PDF does not: an SVG is text, so /read already shows it as highlighted source.
# There is no reason to build a second, riskier path to a file that is already
# viewable.
PDF_TYPE = ("application/pdf", (b"%PDF-",))

# ── archives ────────────────────────────────────────────────────────────────
ARCHIVE_MAX_ENTRIES = 2_000
ARCHIVE_MAX_TOTAL = 100_000_000      # sum of member sizes
ARCHIVE_MAX_MEMBER = 25_000_000      # one file
ARCHIVE_MAX_DEPTH = 32
ARCHIVE_WALK_SECONDS = 20            # phase-1 wall clock


class PathRefused(Exception):
    """A path was not proven safe. The message is safe to show a user."""


# Patterns that describe a WORD in a filename rather than a file format, and so
# must not apply to prose. Found by running collect() over the real tree: a
# documentation page called "Change Password.md" was being hidden as a secret.
#
# Only true documentation formats are exempt. `.txt` deliberately is NOT -
# `db_password.txt` is exactly the shape of a file someone leaves a credential
# in, while `.md` and `.rst` are formats you write ABOUT credentials in. The
# content scanner still inspects these files and can flag them as sensitive; it
# just no longer removes them from the explorer entirely.
_WORDY_PATTERNS = frozenset({"*secret*", "*password*"})
_PROSE_SUFFIXES = frozenset({".md", ".markdown", ".rst"})


def is_denied_name(basename: str) -> bool:
    """True if this filename must never be served.

    Case-insensitive, because the filesystem here is case-sensitive but the
    person who named `Key.PEM` did not mean something different by it.
    """
    name = basename.lower()
    if name in ALLOW_FILES:
        return False
    prose = os.path.splitext(name)[1] in _PROSE_SUFFIXES
    for pat in DENY_FILE_PATTERNS:
        if prose and pat in _WORDY_PATTERNS:
            continue
        if fnmatch.fnmatch(name, pat):
            return True
    return False


def content_policy(basename: str, head: bytes) -> tuple[str, str]:
    """Decide (content_type, disposition) for raw bytes.

    Allowlist plus magic-byte confirmation. `nosniff` alone would in fact be
    enough - a .png full of HTML, served image/png with nosniff, is not rendered
    as HTML by any current browser - but that puts the entire property on one
    header surviving every future refactor and every proxy in the chain. A
    16-byte prefix check costs one read() and removes the dependency.

    On a magic MISMATCH the file is demoted to a download rather than refused: a
    mismatched extension is far more often a misnamed file than an attack, and
    refusing would make the explorer lie about a file that plainly exists.
    """
    ext = os.path.splitext(basename)[1].lower()
    if ext in NEVER_INLINE:
        return "application/octet-stream", "attachment"
    if ext in FRAMED_TYPES:
        return FRAMED_TYPES[ext], "inline"
    if ext in MEDIA_TYPES:
        return MEDIA_TYPES[ext], "inline"
    if ext == ".pdf":
        mime, magics = PDF_TYPE
        return (mime, "inline") if head.startswith(magics[0]) \
            else ("application/octet-stream", "attachment")
    if ext not in INLINE_TYPES:
        return "application/octet-stream", "attachment"

    mime, magics = INLINE_TYPES[ext]
    ok = False
    if ext == ".avif":
        ok = head[4:12] in (b"ftypavif", b"ftypavis")
    elif ext == ".webp":
        ok = head.startswith(b"RIFF") and head[8:12] == b"WEBP"
    else:
        ok = any(head.startswith(m) for m in magics)

    if not ok:
        return "application/octet-stream", "attachment"
    return mime, "inline"


# A header value may never contain CR or LF. Checked rather than trusted, because
# BaseHTTPRequestHandler.send_header does no escaping whatsoever.
_CTL = re.compile(r"[\r\n\x00]")


def header_filename(name: str) -> tuple[str, str]:
    """Return (ascii_fallback, rfc5987) for a Content-Disposition header.

    This exists because Content-Disposition is the FIRST place user input reaches
    a response header in this service, and `send_header` is literally
    `("%s: %s\\r\\n" % (kw, value)).encode('latin-1', 'strict')`. So:

      - a filename containing CRLF (legal on Linux) injects arbitrary headers;
      - a filename with any non-latin-1 character - a CJK or emoji name - raises
        UnicodeEncodeError halfway through a response, leaving headers written
        and the request 500ing.

    The percent-encoded form is ASCII by construction, so latin-1 strict is
    satisfied and CRLF becomes %0D%0A.
    """
    base = os.path.basename(name) or "download"
    ascii_fallback = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._") or "download"
    return ascii_fallback[:100], urllib.parse.quote(base, safe="")


def safe_open(abspath: str) -> tuple[int, os.stat_result]:
    """Open a regular file, closing three races at once. Caller must os.close().

    O_NOFOLLOW  - closes the window between realpath() and open() in which the
                  final component could be swapped for a symlink.
    O_NONBLOCK  - stops open() blocking FOREVER on a FIFO. os.walk puts FIFOs in
                  filenames; without this, one mkfifo in a root pins a handler
                  thread permanently. There are none today, and there is no
                  reason to be one away from a hang.
    fstat on fd - the size checked and the bytes sent are the same inode, so
                  there is no size TOCTOU.
    """
    try:
        fd = os.open(abspath, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as e:
        raise PathRefused(f"cannot open: {e.strerror}") from e
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise PathRefused("not a regular file")
    except Exception:
        os.close(fd)
        raise
    return fd, st


_UNSAFE_ARCNAME = re.compile(r"[\\:\x00-\x1f]")


def safe_arcname(prefix: str, relpath: str) -> str | None:
    """Name an archive entry, or None if it cannot be named safely.

    Zip-slip is the EXTRACTOR's bug, but a well-behaved producer makes it
    unreachable. Names come from the resolved relpath and never from anything the
    client sent.

    The backslash rejection is the non-obvious one: a filename containing `\\` is
    perfectly legal on Linux and becomes a PATH SEPARATOR on a Windows extractor,
    i.e. traversal. Rejected rather than mangled, because mangling collides.

    The single top-level prefix is the tarbomb fix: a naive `unzip` in $HOME
    creates one directory instead of scattering 600 files.
    """
    rel = relpath.replace(os.sep, "/")
    if not rel or rel == ".":
        return None
    if rel.startswith("/") or ".." in rel.split("/") or _UNSAFE_ARCNAME.search(rel):
        return None
    name = f"{prefix}/{rel}"
    # Final tripwire: anything normpath would rewrite is something an extractor
    # might interpret differently from us.
    if os.path.normpath(name).replace(os.sep, "/") != name:
        return None
    return name


def git_root_for(path: str, stop_at: str) -> str | None:
    """Walk up from `path` to the nearest directory containing .git.

    ~/projects holds several unrelated repositories rather than one, so the
    repository a file belongs to is a property of the FILE, not of the root.
    Returns None when the file is under no repository at all - which is a real
    state worth reporting rather than papering over, because it means an edit
    cannot be versioned.

    Never walks above `stop_at`, so a file in an unversioned corner of a root
    cannot accidentally resolve to a repository outside it.
    """
    stop_at = os.path.realpath(stop_at)
    real = os.path.realpath(path)
    # Start AT the path when it is a directory, not at its parent. Walking from
    # the parent is right for a file and wrong for a directory: asking about
    # `projects/army/Tals/frontend` would skip `frontend/.git` and report the
    # repo above it, or none at all. Found by a test that expected a read-only
    # refusal and got "not a git repository" instead.
    cur = real if os.path.isdir(real) else os.path.dirname(real)
    while cur.startswith(stop_at):
        if os.path.isdir(os.path.join(cur, ".git")):
            return cur
        if cur == stop_at:
            break
        cur = os.path.dirname(cur)
    return None


@dataclass(frozen=True)
class Resolved:
    root_key: str
    root_dir: str      # the editable content directory
    abspath: str       # the real, resolved location on disk
    relpath: str       # path relative to root_dir - what a human sees
    # None when the file is under no git repository - readable, but an edit
    # cannot be versioned, and the write path says so rather than pretending.
    git_root: str | None      # the repository toplevel, for `git -C`
    git_relpath: str | None   # path relative to git_root - what git is given


def resolve(root_key: str, rel: str, *, for_write: bool = False) -> Resolved:
    """Return a Resolved, or raise PathRefused.

    Deliberately refuses rather than sanitising. Silently "fixing" a hostile path
    into a nearby legal one means an attack and a typo produce the same quiet
    success, and neither shows up anywhere.
    """
    root_dir = ROOTS.get(root_key)
    if root_dir is None:
        raise PathRefused(f"unknown root {root_key!r}")

    if not isinstance(rel, str) or not rel.strip():
        raise PathRefused("empty path")

    # A NUL truncates the path in any C-level call underneath us, so the check
    # above it could inspect one string while open() acts on a shorter one.
    if "\x00" in rel:
        raise PathRefused("path contains a null byte")

    # An absolute path would make os.path.join discard the root entirely -
    # join("/roots/docs", "/etc/passwd") == "/etc/passwd". Refuse before joining.
    if os.path.isabs(rel):
        raise PathRefused("path must be relative to the root")

    real_root = os.path.realpath(root_dir)
    candidate = os.path.realpath(os.path.join(real_root, rel))

    # THE check. Compare resolved-to-resolved, with a trailing separator so that
    # a sibling directory sharing a name prefix cannot pass: without it,
    # "/roots/docs-secret" starts with "/roots/docs" and would be accepted.
    if candidate != real_root and not candidate.startswith(real_root + os.sep):
        raise PathRefused("path escapes its root")

    relpath = os.path.relpath(candidate, real_root)

    # Check components of the RESOLVED path, so a symlink that lands inside .git
    # is caught by where it points rather than by what it is called.
    parts = relpath.split(os.sep)
    if set(parts) & DENY_COMPONENTS:
        raise PathRefused("path is in a denied directory")

    # Top-level rules, per root. Checked on the RESOLVED relpath, so a symlink
    # that lands in ~/.ssh is caught by where it points, not by what it is named.
    if parts and parts[0] != ".":
        pol = root_policy(root_key)
        head = parts[0]
        if head in pol.get("deny_toplevel", ()):
            raise PathRefused(
                "that directory is excluded - it holds credentials or backups")
        if pol.get("deny_toplevel_dots") and head.startswith("."):
            raise PathRefused(
                "top-level dot entries are excluded in this root - they are "
                "config and credentials")

    # Then the FILENAME, which is where secrets actually live. Checked on the
    # resolved basename for the same reason: a symlink named `notes.md` pointing
    # at `.env` must be refused for what it reaches, not for what it is called.
    if is_denied_name(os.path.basename(candidate)):
        raise PathRefused("this file is excluded as a possible secret")

    if for_write:
        if os.path.splitext(candidate)[1].lower() not in WRITABLE_SUFFIXES:
            raise PathRefused(
                "only " + ", ".join(sorted(WRITABLE_SUFFIXES)) + " files may be written"
            )
        # Writing THROUGH a symlink would let someone plant a link inside the root
        # and have us overwrite its target. The realpath check above already
        # proves the destination is inside the root, so this only forbids the
        # confusing case where the name and the target differ.
        if os.path.islink(os.path.join(real_root, rel)):
            raise PathRefused("refusing to write through a symlink")

    # A declared GIT_ROOT wins; otherwise find the repo this particular file
    # lives in, because a root may contain many (~/projects) or none.
    git_root = GIT_ROOTS.get(root_key)
    git_root = os.path.realpath(git_root) if git_root else git_root_for(candidate, real_root)
    return Resolved(
        root_key=root_key, root_dir=real_root,
        abspath=candidate, relpath=relpath,
        git_root=git_root,
        git_relpath=os.path.relpath(candidate, git_root) if git_root else None,
    )


@dataclass(frozen=True)
class Member:
    """One file that will go into an archive. Already proven safe."""
    res: Resolved
    size: int
    mtime: int
    arcname: str


class ArchiveRefused(Exception):
    """The request asked for too much. Carries counts for a useful 413 body."""

    def __init__(self, message: str, **facts):
        super().__init__(message)
        self.facts = facts


def collect(
    root_key: str,
    rel: str = "",
    *,
    max_entries: int = ARCHIVE_MAX_ENTRIES,
    max_total: int = ARCHIVE_MAX_TOTAL,
    max_member: int = ARCHIVE_MAX_MEMBER,
    max_depth: int = ARCHIVE_MAX_DEPTH,
    walk_seconds: float = ARCHIVE_WALK_SECONDS,
) -> tuple[list[Member], list[dict]]:
    """Walk a subtree and return (members, skipped) with every check applied.

    THIS FUNCTION OWNS THE WALK, and that is the point of it existing.

    `listing()` in app.py used to do its own os.walk and then call resolve() -
    correct, but a PATTERN, and a second implementation can copy a pattern
    incorrectly. Making collect() the only way the application can learn a set of
    paths means the security check is not something the caller has to remember;
    it is the thing the caller called. The archive walk is the second consumer,
    and it is exactly the place where a forgotten resolve() would put `.env` into
    a downloadable zip.

    Two failure modes, deliberately different:
      - whole-request limits (entries, total bytes, wall clock) raise
        ArchiveRefused, because they mean "narrow your selection" and a truncated
        archive would be a lie;
      - per-file problems are SKIPPED and reported, because one unreadable file
        should not lose you the other six hundred.
    """
    safepath_prune = prune_dirs
    base = resolve(root_key, rel or ".")
    members: list[Member] = []
    skipped: list[dict] = []
    total = 0
    started = time.monotonic()

    def skip(path: str, why: str) -> None:
        skipped.append({"path": path, "why": why})

    if os.path.isfile(base.abspath):
        walk_root, prefix_rel = os.path.dirname(base.abspath), os.path.dirname(base.relpath)
        singles = [(walk_root, [], [os.path.basename(base.abspath)])]
    else:
        walk_root, prefix_rel = base.abspath, base.relpath
        singles = os.walk(walk_root, followlinks=False,
                          onerror=lambda e: skip(getattr(e, "filename", "?"), "unreadable directory"))

    # `.` is what relpath returns for the root itself; it must not become part
    # of the archive's top-level directory name ("notes-." rather than "notes").
    prefix_rel = "" if prefix_rel in (".", "") else prefix_rel
    slug = os.path.basename(prefix_rel.rstrip("/")) if prefix_rel else ""
    prefix = f"{root_key}-{slug}" if slug else root_key

    for dirpath, dirnames, filenames in singles:
        if time.monotonic() - started > walk_seconds:
            raise ArchiveRefused("took too long to scan; select a smaller folder",
                                 seconds=walk_seconds, entries=len(members))
        # Prune denied dirs, and symlinked dirs. followlinks=False already
        # declines to descend, so the islink clause is redundant - kept because
        # it puts the intent at the point of the decision instead of in a doc.
        # Same prune as listing(), through the same function - two walks with
        # two ideas of what to skip is how the 1.4s bug happened in the first
        # place. The islink clause is extra here: followlinks=False already
        # declines to descend, kept so the intent sits at the decision.
        dirnames[:] = [d for d in safepath_prune(root_key,
                                                 os.path.relpath(dirpath, walk_root),
                                                 dirnames)
                       if not os.path.islink(os.path.join(dirpath, d))]
        depth = os.path.relpath(dirpath, walk_root).count(os.sep)
        if depth >= max_depth:
            skip(os.path.relpath(dirpath, walk_root), "deeper than the depth limit")
            dirnames[:] = []
            continue

        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            shown = os.path.relpath(full, walk_root)
            # A symlink to a file INSIDE the root resolves fine, but res.relpath
            # is then the TARGET's path - so the archive would carry two entries
            # with different names for the same bytes, and a duplicate name in a
            # zip is silently overwritten by a naive extractor. Skip all links.
            if os.path.islink(full):
                skip(shown, "symlink")
                continue
            try:
                res = resolve(root_key, os.path.relpath(full, base.root_dir))
            except PathRefused as e:
                skip(shown, str(e))
                continue
            try:
                fd, st = safe_open(res.abspath)
                os.close(fd)
            except PathRefused as e:
                skip(shown, str(e))
                continue
            if st.st_size > max_member:
                skip(shown, f"larger than the {max_member // 1_000_000} MB per-file limit")
                continue
            arc = safe_arcname(prefix, os.path.relpath(res.abspath, walk_root))
            if arc is None:
                skip(shown, "name cannot be represented safely in an archive")
                continue

            total += st.st_size
            if len(members) >= max_entries:
                raise ArchiveRefused(
                    "too many files; select a smaller folder",
                    entries=len(members), limit=max_entries)
            if total > max_total:
                raise ArchiveRefused(
                    "too large; select a smaller folder",
                    bytes=total, limit=max_total)
            members.append(Member(res=res, size=st.st_size,
                                  mtime=int(st.st_mtime), arcname=arc))

    return members, skipped
