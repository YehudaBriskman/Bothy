"""Resolve a client-supplied path to a real file, or refuse.

This module is the entire security boundary of the write tier, so it is pure and
separately testable: no HTTP, no globals, no filesystem writes. Everything it
returns has already been proven to sit inside an allowlisted root.

The threat is not exotic. This service holds read-write bind mounts on two git
repositories and takes a path from a browser. Every classic escape applies:

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

import os
from dataclasses import dataclass

# Named roots, so a client never sends a filesystem path - only a short key that
# must match this table exactly. An unknown key is refused; there is no default
# and no fallback to "the whole disk".
#
# Both are git repositories, which is the entire versioning story: editing a file
# here produces a commit, and `git log` is the page history. Nothing else needs to
# store versions.
ROOTS: dict[str, str] = {
    "docs": "/repos/stacks/docs",
    "notes": "/repos/notes",
}

# The git repository each root lives inside, which is NOT always the root itself.
#
# `docs` is a subdirectory of the stacks repo. git needs the toplevel (that is
# where .git is), but the EDITABLE surface must stay the subdirectory - otherwise
# mounting the repo so commits work would quietly also make README.md,
# CONTRIBUTING.md and every other markdown file in the repo editable from a
# browser. Two different questions, so two different tables:
#
#   ROOTS      - what a human may open and change
#   GIT_ROOTS  - where the commit is recorded
#
# Collapsing them into one is the easy mistake, and it widens the blast radius
# without changing anything visible.
GIT_ROOTS: dict[str, str] = {
    "docs": "/repos/stacks",
    "notes": "/repos/notes",
}

# Write is restricted to text formats a human edits. This is not about parsing -
# it is a blast-radius limit. Without it, "edit a doc" also means "rewrite
# compose.yml", "rewrite a shell script that cron runs", or "drop a .py that
# something imports". The read side is deliberately wider than the write side.
WRITABLE_SUFFIXES = frozenset({".md", ".markdown", ".txt", ".rst"})

# Never served or listed, at any depth, even though they sit inside a root.
# `.git` is the big one: it holds the repo's own object store and config, and
# .git/config on a repo with a remote can carry a credential.
DENY_COMPONENTS = frozenset({".git", ".env", "node_modules", ".ssh"})

MAX_BYTES = 1_000_000  # a megabyte of markdown is already an unreasonable page


class PathRefused(Exception):
    """A path was not proven safe. The message is safe to show a user."""


@dataclass(frozen=True)
class Resolved:
    root_key: str
    root_dir: str      # the editable content directory
    abspath: str       # the real, resolved location on disk
    relpath: str       # path relative to root_dir - what a human sees
    git_root: str      # the repository toplevel, for `git -C`
    git_relpath: str   # path relative to git_root - what git is given


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
    parts = set(relpath.split(os.sep))
    if parts & DENY_COMPONENTS:
        raise PathRefused("path is in a denied directory")

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

    git_root = os.path.realpath(GIT_ROOTS.get(root_key, root_dir))
    return Resolved(
        root_key=root_key, root_dir=real_root,
        abspath=candidate, relpath=relpath,
        git_root=git_root,
        git_relpath=os.path.relpath(candidate, git_root),
    )
