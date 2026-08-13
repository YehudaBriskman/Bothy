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
}

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
WRITABLE_SUFFIXES = frozenset({".md", ".markdown", ".txt", ".rst"})

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


class PathRefused(Exception):
    """A path was not proven safe. The message is safe to show a user."""


def is_denied_name(basename: str) -> bool:
    """True if this filename must never be served.

    Case-insensitive, because the filesystem here is case-sensitive but the
    person who named `Key.PEM` did not mean something different by it.
    """
    name = basename.lower()
    if name in ALLOW_FILES:
        return False
    return any(fnmatch.fnmatch(name, pat) for pat in DENY_FILE_PATTERNS)


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
    cur = os.path.dirname(os.path.realpath(path))
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
