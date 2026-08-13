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

**Git is the version store.** Both roots are repositories, so a write is a commit
and history is `git log`. No separate revision table, no custom format, and the
history stays readable with ordinary tools if this service disappears.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
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
READONLY_ROOTS = frozenset({"projects"})


def listing(root_key: str) -> tuple[list[dict], bool]:
    """Every readable file under a root. Returns (files, truncated)."""
    writable_root = root_key not in READONLY_ROOTS
    root = safepath.ROOTS[root_key]
    real = os.path.realpath(root)
    out: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(real, followlinks=False):
        # Prune denied directories in place so os.walk never descends into them.
        dirnames[:] = [d for d in dirnames if d not in safepath.DENY_COMPONENTS]
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
                "writable": (writable_root
                             and os.path.splitext(fn)[1].lower()
                             in safepath.WRITABLE_SUFFIXES),
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
                     "writableSuffixes": sorted(safepath.WRITABLE_SUFFIXES)}
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
                    "writable": (res.root_key not in READONLY_ROOTS
                                 and os.path.splitext(res.abspath)[1].lower()
                                 in safepath.WRITABLE_SUFFIXES),
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
                return self._send(200, {**base, "binary": False,
                                        "content": content,
                                        "sensitive": safepath.scan_for_secret(content),
                                        "history": history(res)})

            if route == "/history":
                res = safepath.resolve(q.get("root", ""), q.get("path", ""))
                return self._send(200, {"path": res.relpath, "history": history(res)})

            return self._send(404, {"error": "no such endpoint"})
        except safepath.PathRefused as e:
            # 403, not 404: the path was understood and deliberately refused.
            return self._send(403, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"ERROR {route}: {type(e).__name__}: {e}\n")
            return self._send(500, {"error": "internal error"})

    # ── write ───────────────────────────────────────────────────────────────
    def do_POST(self) -> None:  # noqa: N802
        route = urlparse(self.path).path
        if route != "/write":
            return self._send(404, {"error": "no such endpoint"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > safepath.MAX_BYTES:
                return self._send(413, {"error": "body missing or too large"})
            body = json.loads(self.rfile.read(length))

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

            os.makedirs(os.path.dirname(res.abspath), exist_ok=True)
            # Write to a temp file in the same directory, then rename. rename is
            # atomic within a filesystem, so a crash mid-write leaves the old file
            # intact rather than a truncated one.
            tmp = res.abspath + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(content)
            os.replace(tmp, res.abspath)

            msg = (body.get("message") or "").strip() or f"docs: edit {res.relpath}"
            if not res.git_root:
                # Written, but not versioned. Reported as such rather than
                # silently succeeding - "saved" and "saved with history" are
                # different promises and the UI needs to be able to tell them
                # apart.
                sys.stderr.write(f"WRITE {res.root_key}/{res.relpath} by={who} "
                                 f"UNVERSIONED (no git repo)\n")
                return self._send(200, {
                    "ok": True, "path": res.relpath, "committed": False,
                    "unversioned": True, "sha": None, "author": who,
                    "message": msg, "history": []})
            git(res.git_root, "add", "--", res.git_relpath)
            commit = git(
                res.git_root,
                "-c", f"user.name={who}",
                "-c", f"user.email={who if '@' in who else who + '@devbox.local'}",
                "commit", "-m", msg, "--only", "--", res.git_relpath,
            )
            # "nothing to commit" is a success: the content matched what was
            # already there. Reporting it as an error would make saving an
            # unchanged file look like a failure.
            committed = commit.returncode == 0
            nothing = "nothing to commit" in (commit.stdout + commit.stderr)

            sha = git(res.git_root, "rev-parse", "--short", "HEAD").stdout.strip()
            sys.stderr.write(
                f"WRITE {res.root_key}/{res.relpath} by={who} "
                f"committed={committed} sha={sha}\n"
            )
            return self._send(200, {
                "ok": True, "path": res.relpath, "committed": committed,
                "unchanged": nothing and not committed, "sha": sha,
                "author": who, "message": msg,
                "history": history(res),
            })
        except safepath.PathRefused as e:
            return self._send(403, {"error": str(e)})
        except json.JSONDecodeError:
            return self._send(400, {"error": "body must be JSON"})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"ERROR /write: {type(e).__name__}: {e}\n")
            return self._send(500, {"error": "internal error"})


if __name__ == "__main__":
    missing = [k for k, v in safepath.ROOTS.items() if not os.path.isdir(v)]
    if missing:
        sys.stderr.write(f"FATAL: roots not mounted: {missing}\n")
        sys.exit(1)
    sys.stderr.write(f"portal-files on :{PORT} roots={sorted(safepath.ROOTS)}\n")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
