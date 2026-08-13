#!/usr/bin/env python3
"""Truth table for the write tier's security boundary.

Run: python3 checks/test_safepath.py

Every case here is an attack that must be REFUSED, or a legitimate edit that must
be ALLOWED. The point of the file is the first kind: a guard nobody has watched
reject something is a guard nobody should trust, and this repo has now been
bitten four times by checks that ran, were confident, and reported the opposite
of the truth.

The symlink cases are the ones that matter most, because they are the ones a
string-inspecting implementation passes cleanly. They are built on a REAL
filesystem with REAL symlinks rather than mocked, since mocking the thing under
test would prove only that the mock behaves as written.
"""
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import safepath  # noqa: E402

bad = 0
def check(label, fn, *, expect_refused):
    global bad
    try:
        fn()
        ok = not expect_refused
        detail = "allowed"
    except safepath.PathRefused as e:
        ok = expect_refused
        detail = f"refused ({e})"
    except Exception as e:  # noqa: BLE001
        ok = False
        detail = f"UNEXPECTED {type(e).__name__}: {e}"
    if not ok:
        bad += 1
    want = "refuse" if expect_refused else "allow"
    print(f"{'PASS' if ok else 'FAIL'}  {label:<52} want={want:<7} {detail}")


tmp = tempfile.mkdtemp(prefix="safepath-")
root = os.path.join(tmp, "docs")
os.makedirs(os.path.join(root, "kb"))
os.makedirs(os.path.join(root, ".git"))
# A sibling whose name is a PREFIX of the root - the trailing-separator case.
os.makedirs(os.path.join(tmp, "docs-secret"))
open(os.path.join(root, "index.md"), "w").write("# hi\n")
open(os.path.join(root, "kb", "dns.md"), "w").write("# dns\n")
open(os.path.join(root, ".git", "config"), "w").write("[remote]\n")
open(os.path.join(tmp, "docs-secret", "keys.md"), "w").write("secret\n")
open(os.path.join(tmp, "outside.md"), "w").write("outside\n")
open(os.path.join(root, "script.sh"), "w").write("echo hi\n")

# Real symlinks, planted inside the root.
os.symlink(os.path.join(tmp, "outside.md"), os.path.join(root, "escape.md"))
os.symlink(tmp, os.path.join(root, "up"))
os.symlink(os.path.join(root, ".git"), os.path.join(root, "gitlink"))

safepath.ROOTS["docs"] = root
R = lambda p, w=False: (lambda: safepath.resolve("docs", p, for_write=w))  # noqa: E731

print("── legitimate edits must work ──────────────────────────────────────")
check("a file at the root",              R("index.md"),        expect_refused=False)
check("a file in a subdirectory",        R("kb/dns.md"),       expect_refused=False)
check("writing a markdown file",         R("kb/dns.md", True), expect_refused=False)
check("a file that does not exist yet",  R("kb/new.md", True), expect_refused=False)

print("\n── climbing out ────────────────────────────────────────────────────")
check("dot-dot to the parent",           R("../outside.md"),          expect_refused=True)
check("dot-dot after a real prefix",     R("kb/../../outside.md"),    expect_refused=True)
check("deep dot-dot to /etc",            R("../../../../etc/passwd"), expect_refused=True)
check("an absolute path",                R("/etc/passwd"),            expect_refused=True)
# join() would silently discard the root for an absolute path, so this is the
# case that turns "read a doc" into "read anything".
check("absolute path to a real secret",  R("/etc/shadow"),            expect_refused=True)

print("\n── symlinks (a string check passes ALL of these) ────────────────────")
check("symlink pointing outside",        R("escape.md"),        expect_refused=True)
check("writing through that symlink",    R("escape.md", True),  expect_refused=True)
check("path THROUGH a symlinked dir",    R("up/outside.md"),    expect_refused=True)
check("symlink into .git",               R("gitlink/config"),   expect_refused=True)

print("\n── inside the root, but not content ────────────────────────────────")
check(".git by name",                    R(".git/config"),      expect_refused=True)
check("nested .git at depth",            R("kb/../.git/config"), expect_refused=True)

print("\n── the name-prefix trap ────────────────────────────────────────────")
# Without the trailing separator in the startswith() check, "/tmp/x/docs-secret"
# starts with "/tmp/x/docs" and this would be served.
check("sibling dir sharing a prefix",    R("../docs-secret/keys.md"), expect_refused=True)

print("\n── write is narrower than read ─────────────────────────────────────")
check("reading a shell script",          R("script.sh"),        expect_refused=False)
check("WRITING a shell script",          R("script.sh", True),  expect_refused=True)
check("writing a compose file",          R("compose.yml", True), expect_refused=True)

print("\n── repo is mounted, but only the content dir is editable ───────────")
# The compose file mounts the WHOLE stacks repo, because git needs .git at the
# toplevel to commit. If ROOTS pointed at the repo instead of at docs/, every
# markdown file in the repo would become editable from a browser and nothing
# would look different. This asserts the two are genuinely separate.
repo = os.path.join(tmp, "repo")
os.makedirs(os.path.join(repo, "docs", "kb"))
os.makedirs(os.path.join(repo, ".git"))
open(os.path.join(repo, "README.md"), "w").write("# repo readme\n")
open(os.path.join(repo, "docs", "page.md"), "w").write("# page\n")
safepath.ROOTS["docs"] = os.path.join(repo, "docs")
safepath.GIT_ROOTS["docs"] = repo

check("a doc inside the content dir",    R("page.md"),              expect_refused=False)
check("README.md at the REPO toplevel",  R("../README.md"),         expect_refused=True)
check("writing README.md at toplevel",   R("../README.md", True),   expect_refused=True)
check("the repo's own .git",             R("../.git/config"),       expect_refused=True)

# git must still be pointed at the repo, or commits fail even though paths resolve.
res = safepath.resolve("docs", "page.md")
gr_ok = res.git_root == os.path.realpath(repo)
rel_ok = res.git_relpath == os.path.join("docs", "page.md")
print(f"{'PASS' if gr_ok else 'FAIL'}  {'git_root is the repo toplevel':<52} "
      f"want=allow   {res.git_root}")
print(f"{'PASS' if rel_ok else 'FAIL'}  {'git_relpath is repo-relative':<52} "
      f"want=allow   {res.git_relpath}")
bad += (0 if gr_ok else 1) + (0 if rel_ok else 1)

safepath.ROOTS["docs"] = root      # restore for the remaining cases
safepath.GIT_ROOTS["docs"] = root

print("\n── malformed input ─────────────────────────────────────────────────")
check("empty path",                      R(""),                 expect_refused=True)
check("whitespace only",                 R("   "),              expect_refused=True)
check("null byte",                       R("index.md\x00.txt"), expect_refused=True)
check("unknown root",
      lambda: safepath.resolve("nope", "index.md"),             expect_refused=True)

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{bad} FAILED" if bad else "\nall pass")
sys.exit(1 if bad else 0)
