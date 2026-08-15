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
safepath.GIT_ROOTS["docs"] = root
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

print("\n── SECRETS: the control that widening the roots made necessary ─────")
# The roots used to be two markdown trees. They are now the whole box, and a
# survey of the new scope found ~/stacks/.env holding 19 real secret values and
# a real TLS private key under ~/projects. Matching only path COMPONENTS - which
# is what the first version did - would have served both, because `.env` is a
# FILE and `key.pem` is a FILE.
for name in [".env", ".env.production", ".env.local", "id_ed25519", "id_rsa",
             "key.pem", "cert.key", "server.p12", ".netrc", ".pgpass",
             ".git-credentials", "credentials.json", "my-secrets.yml",
             "db_password.txt", "sessions.sqlite", "app.db", "Key.PEM"]:
    open(os.path.join(root, name), "w").write("SENSITIVE\n")
    check(f"secret refused: {name}", R(name), expect_refused=True)

# ...but a committed template is the file you READ to learn what to set, and
# hiding it makes the explorer worse for no gain. Allowed BY NAME so the
# exception can never widen to .env.production.
for name in [".env.example", ".env.sample", ".env.template"]:
    open(os.path.join(root, name), "w").write("PASSWORD=changeme\n")
    check(f"template allowed: {name}", R(name), expect_refused=False)

# A symlink NAMED innocuously but POINTING at a secret must be refused for what
# it reaches. This is the case that a name-only deny-list passes cleanly.
open(os.path.join(tmp, "real.env"), "w").write("SECRET=1\n")
os.symlink(os.path.join(tmp, "real.env"), os.path.join(root, "harmless.md"))
check("symlink named .md pointing at a secret", R("harmless.md"), expect_refused=True)

print("\n── prose is not a secret just because of a word in its name ────────")
# Found by running collect() over the real tree: a documentation page called
# "Change Password.md" was being hidden as a secret by the `*password*` pattern.
# `.md`/`.rst` are formats you write ABOUT credentials in; `.txt` is a format
# people leave them in, so it stays denied.
for name, want_refused in [
    ("Change Password.md", False), ("secrets.md", False), ("password.rst", False),
    ("db_password.txt", True), ("my-secrets.yml", True), ("api_secret.json", True),
]:
    open(os.path.join(root, name), "w").write("x\n")
    check(f"{'refused' if want_refused else 'served '}: {name}",
          R(name), expect_refused=want_refused)

print("\n── archive manifests: collect() == what resolve() allows ───────────")
# THE invariant. collect() owns the walk precisely so a second implementation
# cannot forget the per-entry check; mutation-testing it by deleting the
# resolve() call puts .env straight into a downloadable archive (verified: 647
# members instead of 641, .env present).
os.makedirs(os.path.join(root, "sub"), exist_ok=True)
open(os.path.join(root, "sub", "ok.md"), "w").write("fine\n")
members, skipped = safepath.collect("docs", "", max_entries=10_000, max_total=10**12)
names = {m.res.relpath for m in members}
denied_reasons = {s["path"]: s["why"] for s in skipped}
for planted in [".env", "key.pem", "id_ed25519", "realm-devbox.json", ".git/config"]:
    ok = planted not in names
    bad += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'}  {'never in a manifest: ' + planted:<52} "
          f"want=absent  {denied_reasons.get(planted, 'pruned')[:28]}")
ok = "sub/ok.md" in names
bad += 0 if ok else 1
print(f"{'PASS' if ok else 'FAIL'}  {'but ordinary files ARE collected':<52} want=present {len(members)} members")
# every arcname must be safe for a naive extractor
bad_names = [m.arcname for m in members
             if m.arcname.startswith("/") or ".." in m.arcname.split("/")
             or "\\" in m.arcname]
ok = not bad_names
bad += 0 if ok else 1
print(f"{'PASS' if ok else 'FAIL'}  {'every arcname is extractor-safe':<52} want=safe    {bad_names[:2] or 'all clean'}")

print("\n── per-root top-level policy (the `home` root) ─────────────────────")
# Widening to "any folder you can cd into" meant mounting a home directory. A dry
# run against the REAL one before trusting it found .bash_history being served -
# the rule denied dot-DIRECTORIES and that is a dot-FILE. The fix could not be
# global: `stacks/.gitignore` and `.env.example` are opened on purpose, so
# "deny top-level dotfiles" is a property of the ROOT, not of the service.
home = os.path.join(tmp, "home")
os.makedirs(os.path.join(home, ".ssh"))
os.makedirs(os.path.join(home, "backups", "env"))
os.makedirs(os.path.join(home, "projects", "app"))
open(os.path.join(home, ".bash_history"), "w").write("export TOKEN=live\n")
open(os.path.join(home, ".bashrc"), "w").write("x\n")
open(os.path.join(home, ".ssh", "id_ed25519"), "w").write("KEY\n")
open(os.path.join(home, "backups", "env", "env-1"), "w").write("PASSWORD=live\n")
open(os.path.join(home, "projects", "app", "README.md"), "w").write("# app\n")
safepath.ROOTS["home"] = home
safepath.ROOT_POLICY["home"] = {"deny_toplevel_dots": True,
                                "deny_toplevel": frozenset({"backups"})}
H = lambda p: (lambda: safepath.resolve("home", p))  # noqa: E731

check("home: a top-level dot FILE",      H(".bash_history"),      expect_refused=True)
check("home: another top-level dotfile", H(".bashrc"),            expect_refused=True)
check("home: a top-level dot DIR",       H(".ssh/id_ed25519"),    expect_refused=True)
check("home: the backups directory",     H("backups/env/env-1"),  expect_refused=True)
check("home: ordinary project files",    H("projects/app/README.md"), expect_refused=False)

# ...and the SAME shapes must still be served from a repo root, or the explorer
# becomes useless for the thing it is mostly used on.
open(os.path.join(root, ".gitignore"), "w").write("node_modules\n")
os.makedirs(os.path.join(root, ".github"), exist_ok=True)
open(os.path.join(root, ".github", "ci.yml"), "w").write("on: push\n")
check("repo root: .gitignore is served",  R(".gitignore"),        expect_refused=False)
check("repo root: .github/ is served",    R(".github/ci.yml"),    expect_refused=False)

print("\n── the walk must not look where policy will refuse ─────────────────")
# A performance bug expressed as a correctness invariant, because that is what it
# actually is: policy and traversal drifted apart. listing() pruned
# DENY_COMPONENTS during the walk while ROOT_POLICY denied .npm/.cache/.local at
# RESOLVE time, so the walk descended into all of them and paid a resolution plus
# a raised exception per file to discard it - 33,567 files visited to serve
# 3,474. Asserting "the walk visits roughly what it serves" catches that class
# returning, which a timing assertion would do flakily and a unit test of
# prune_dirs alone would miss entirely.
walkroot = os.path.join(tmp, "wr")
for d in (".npm/deep/deeper", ".cache/x", "backups/env", "src/lib", "src/.github"):
    os.makedirs(os.path.join(walkroot, d), exist_ok=True)
for d, n in ((".npm/deep/deeper", 40), (".cache/x", 40), ("backups/env", 10),
             ("src/lib", 5), ("src/.github", 2)):
    for i in range(n):
        open(os.path.join(walkroot, d, f"f{i}.txt"), "w").write("x")
safepath.ROOTS["wr"] = walkroot
safepath.ROOT_POLICY["wr"] = {"deny_toplevel_dots": True,
                              "deny_toplevel": frozenset({"backups"})}
visited = refused = 0
for dp, dn, fn in os.walk(walkroot):
    dn[:] = safepath.prune_dirs("wr", os.path.relpath(dp, walkroot), dn)
    for f in fn:
        visited += 1
        try:
            safepath.resolve("wr", os.path.relpath(os.path.join(dp, f), walkroot))
        except safepath.PathRefused:
            refused += 1
served = visited - refused
ok = visited < served * 2          # unpruned this is ~137 visited for 7 served
bad += 0 if ok else 1
print(f"{'PASS' if ok else 'FAIL'}  {'walk visits ~what it serves, not 20x more':<52} "
      f"want=lean    visited={visited} served={served} refused={refused}")
# ...and the pruning must not have hidden anything legitimate.
# 5 in src/lib + 2 in src/.github. The nesting matters: a dot directory is
# denied at a root's TOP level and allowed below it, which is what lets
# `stacks/.github/` open while `~/.ssh` does not.
ok = served == 7
bad += 0 if ok else 1
print(f"{'PASS' if ok else 'FAIL'}  {'and still serves src/ and a nested .github/':<52} "
      f"want=7       served={served}")

print("\n── the archive walk must use ROOT-relative paths ───────────────────")
# collect() passed a SUBTREE-relative path to prune_dirs, whose contract is
# root-relative. prune_dirs decides "am I at the top of this root" from that
# path, so archiving a subtree applied the ROOT's deny_toplevel rules at the
# SUBTREE's first level - and a pruned directory never reaches `skipped`, so the
# archive silently lacked content while claiming to list what it omitted.
wr2 = os.path.join(tmp, "wr2")
for d in ("projects/app/.github", "projects/app/src", ".cache/junk"):
    os.makedirs(os.path.join(wr2, d), exist_ok=True)
for d, n in (("projects/app/.github", "ci.yml"), ("projects/app/src", "main.ts"),
             (".cache/junk", "x")):
    open(os.path.join(wr2, d, n), "w").write("x")
safepath.ROOTS["wr2"] = wr2
safepath.GIT_ROOTS.pop("wr2", None)
safepath.ROOT_POLICY["wr2"] = {"deny_toplevel_dots": True,
                               "deny_toplevel": frozenset({"backups"})}

sub, _ = safepath.collect("wr2", "projects/app", max_entries=999, max_total=10**9)
subnames = {m.res.relpath for m in sub}
ok = any(".github" in n for n in subnames)
bad += 0 if ok else 1
print(f"{'PASS' if ok else 'FAIL'}  {'a subtree archive keeps ITS dot-dirs':<52} "
      f"want=present {sorted(subnames)}")

whole, _ = safepath.collect("wr2", "", max_entries=999, max_total=10**9)
ok = not any(".cache" in m.res.relpath for m in whole)
bad += 0 if ok else 1
print(f"{'PASS' if ok else 'FAIL'}  {'...while the ROOT still denies its own dot-dirs':<52} "
      f"want=absent  {len(whole)} members")

print("\n── the advisory scanner: ADVISORY, and measured ────────────────────")
# scan_for_secret marks a file; it never refuses one. That was decided by running
# the blocking version over all 3,369 readable text files on this box: it flagged
# 45, and the top hits were .env.example, auth/compose.yml and several READMEs -
# the files you most need to open in an explorer. Two of three sampled were
# outright false positives. These cases pin that behaviour so it cannot silently
# become a blocker, or silently stop noticing.
_fp = [
    ("a placeholder with a suffix",     "PASSWORD=changeme-generate-one"),
    ("a shell interpolation",           "POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set it}"),
    ("prose about a secret",            "Set POSTGRES_PASSWORD in .env before starting."),
    ("an angle-bracket placeholder",    'client_secret: "<your-client-secret>"'),
    ("a short value",                   "password=abc"),
]
for label, text in _fp:
    got = safepath.scan_for_secret(text)
    ok = got is None
    bad += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'}  {'not flagged: ' + label:<52} want=quiet   {got or 'quiet'}")

_tp = [
    ("a long opaque client secret",  '"clientSecret": "kJ8x2mQ9vB4nR7wZ1pL6yT3hF5gD0sA8"'),
    ("a bcrypt hash",                "password: $2a$11$wmPDdQ2QqFmNLLiWMDz5DTCypmXzW"),
    ("a PEM private key block",      "-----BEGIN RSA PRIVATE KEY-----\nMIIE..."),
]
for label, text in _tp:
    got = safepath.scan_for_secret(text)
    ok = got is not None
    bad += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'}  {'flagged: ' + label:<52} want=flag    {got or 'quiet'}")

# The file that proved a name-based list is a filter, not a boundary: it was
# served to an authenticated viewer WITH a live client secret in it, and nothing
# in its name suggested anything. Now denied by name.
open(os.path.join(root, "realm-devbox.json"), "w").write('{"secret":"x"}')
check("keycloak realm export refused",  R("realm-devbox.json"), expect_refused=True)

print("\n── malformed input ─────────────────────────────────────────────────")
check("empty path",                      R(""),                 expect_refused=True)
check("whitespace only",                 R("   "),              expect_refused=True)
check("null byte",                       R("index.md\x00.txt"), expect_refused=True)
check("unknown root",
      lambda: safepath.resolve("nope", "index.md"),             expect_refused=True)

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{bad} FAILED" if bad else "\nall pass")
sys.exit(1 if bad else 0)
