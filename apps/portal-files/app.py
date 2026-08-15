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

**Save writes to DISK. Committing is separate.** A save used to be a git commit,
which was right for a docs editor and wrong for an explorer over the whole box -
most saves are work in progress and should not each become a commit. Git is a
deliberate act in its own area now.

Two things follow, and both are load-bearing rather than tidy:

  * The conflict check is no longer optional. While a save was a commit, git was
    a safety net - a clobber sat in the object store and was recoverable.
    Writing straight to disk removes that net, so the baseMtime comparison in
    do_POST is the ONLY thing between a stale editor tab and someone else's
    work. The failure it prevents is silent, which is why it is the server's job.

  * The audit trail had to be rebuilt. Every write used to carry an author
    because every write was a commit; see audit().
"""

from __future__ import annotations

import io
import json
import os
import stat
import subprocess
import sys
import tarfile
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
    # Range is deliberately not implemented - see _raw(). Advertising none stops
    # a client asking.
    "Accept-Ranges": "none",
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
    line = (f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\t{who}\t"
            f"{action}\t{res.root_key}/{res.relpath}"
            f"{f'   {size} bytes' if size is not None else ''}"
            f"{f'   {extra}' if extra else ''}")
    sys.stderr.write(line + "\n")
    try:
        with _AUDIT_LOCK:
            os.makedirs(os.path.dirname(AUDIT_PATH), exist_ok=True)
            with open(AUDIT_PATH, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
    except OSError as e:
        sys.stderr.write(f"AUDIT LOG UNWRITABLE ({e}) - the write itself was fine\n")


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

            if route == "/repos":
                return self._send(200, repos(q.get("root", ""), q.get("path", "")))

            if route == "/status":
                return self._send(200, status(q.get("root", ""), q.get("path", "")))

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

    # ── write ───────────────────────────────────────────────────────────────
    def do_POST(self) -> None:  # noqa: N802
        route = urlparse(self.path).path
        if route != "/write":
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

            os.makedirs(os.path.dirname(res.abspath), exist_ok=True)
            # Write to a temp file in the same directory, then rename. rename is
            # atomic within a filesystem, so a crash mid-write leaves the old file
            # intact rather than a truncated one.
            tmp = res.abspath + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(content)
            os.replace(tmp, res.abspath)
            mtime = int(os.stat(res.abspath).st_mtime)

            # ── NO COMMIT ────────────────────────────────────────────────────
            #
            # Save used to mean commit. That was right for a docs editor and
            # wrong for a file explorer over the whole box, where most saves are
            # work in progress that should not each become a commit. Committing
            # is now a deliberate act in the git area.
            #
            # The cost is the audit trail: every write USED to be attributable,
            # because every write was a commit with an author. audit() replaces
            # that - see its docstring.
            audit(who, "WROTE", res, len(content.encode()))
            return self._send(200, {
                "ok": True, "path": res.relpath, "mtime": mtime,
                "created": not existed, "author": who,
                "bytes": len(content.encode()),
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
            sys.stderr.write(f"ERROR /write: {type(e).__name__}: {e}\n")
            return self._send(500, {"error": "internal error"})


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
        try:
            if st.st_size > safepath.MAX_RAW_BYTES:
                os.close(fd)
                return self._send(413, {
                    "error": f"file too large to download "
                             f"({st.st_size // 1_000_000} MB, limit "
                             f"{safepath.MAX_RAW_BYTES // 1_000_000} MB)"})

            head = os.pread(fd, 16, 0) if st.st_size else b""
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

            self._send_bytes_headers(200, {
                "Content-Type": ctype,
                "Content-Length": st.st_size,
                "Content-Disposition": self._disposition(disp, res.relpath),
            })
            with os.fdopen(fd, "rb", closefd=True) as fh:
                fd = -1
                remaining = st.st_size
                while remaining > 0:
                    chunk = fh.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            sys.stderr.write(f"RAW aborted by client: {res.relpath}\n")
        finally:
            if fd >= 0:
                os.close(fd)

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
            members, skipped = safepath.collect(q.get("root", ""), q.get("path", ""))
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
