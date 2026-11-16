#!/usr/bin/env python3
"""The own-code `unreleased` fact (docs/plans/thin-bothy/cli-and-control-plane.md 4.2), as units.

Run: python3 checks/test_unreleased.py

THE LESSON IT ANSWERS (2026-11-16): the `bothy` row said "up to date" while main
was 138 commits past the newest v* tag, because it compares with the newest GREEN
RELEASE TAG - the right rule - and showed nothing about the gap. The fix is a FACT
beside the rule, never a new deploy path. A throwaway bare origin with annotated
tags and a clone, no docker, no network. Pinned here:

  COUNT     5 commits past v2026.1.0 on origin/main -> commits_ahead 5, since_tag
            v2026.1.0, latest_main the tip's 7 characters
  BLOCKER   VERSION unchanged -> version-not-bumped (what release.yml waits for);
            VERSION bumped and CI unknown -> `unknown`, never a guess; CI red names
            install / upgrade / ci; CI green -> none (the tag is merely pending)
  NEWEST    the newest tag by VERSION arithmetic, not by name or date
  OFFLINE   the answer costs only `git` calls on refs the checkout already has: a
            fetch is never made, and hostio.run is only ever asked for git
  ZERO      on the tag itself: commits_ahead 0, blocker none
  WRITE     state/unreleased.json is written 600 by the host and served through an
            allow-list by bothy-ops (a hostile field is dropped, a bad blocker is
            `unknown`); no origin/main removes a stale file rather than keep a number
"""
import json
import os
import stat
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)
os.environ.setdefault("ADMIN_AUDIT_LOG", os.devnull)

TMP = tempfile.mkdtemp(prefix="bothy-unreleased-unit-")
STATE = os.path.join(TMP, "state")
os.makedirs(STATE)
os.environ["UPDATES_AVAILABLE"] = os.path.join(STATE, "available.json")

import updater  # noqa: E402,F401
import updates  # noqa: E402
from updater import hostio, owncode  # noqa: E402
from updater.config import Config  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


ORIGIN = os.path.join(TMP, "origin.git")
DEV = os.path.join(TMP, "dev")
REPO = os.path.join(TMP, "repo")
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false",
       "-c", "tag.gpgsign=false"]


def git(*args: str, cwd: str = DEV) -> str:
    return subprocess.run([*GIT, *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def commit(msg: str, version: str | None = None) -> None:
    if version is not None:
        with open(os.path.join(DEV, "VERSION"), "w") as fh:
            fh.write(version + "\n")
    with open(os.path.join(DEV, "log.txt"), "a") as fh:
        fh.write(msg + "\n")
    git("add", "-A")
    git("commit", "-q", "-m", msg)


def release(version: str) -> None:
    commit(f"release {version}", version)
    git("tag", "-a", f"v{version}", "-m", f"v{version}")
    git("push", "-q", "origin", "main", f"v{version}")


def sync() -> None:
    git("push", "-q", "origin", "main", cwd=DEV)
    git("fetch", "-q", "--tags", "origin", cwd=REPO)


subprocess.run(["git", "init", "-q", "--bare", "-b", "main", ORIGIN], check=True)
subprocess.run(["git", "clone", "-q", ORIGIN, DEV], check=True, capture_output=True)
git("checkout", "-q", "-b", "main")
release("2026.1.0")
release("2026.1.1")
# A tag that sorts later by NAME and by creation but is OLDER by version: the
# newest must be chosen by arithmetic. (v2026.1.10 > v2026.1.9 numerically.)
release("2026.1.9")
release("2026.1.10")
subprocess.run(["git", "clone", "-q", ORIGIN, REPO], check=True, capture_output=True)
cfg = Config(repo=REPO, catalog="", state=STATE, backups=os.path.join(TMP, "b"), textfile=None)

# ── OFFLINE: only git is ever run, and no fetch ────────────────────────────────
ran: list[list[str]] = []
real_run = hostio.run


def spy_run(argv, **kw):
    ran.append(list(argv))
    return real_run(argv, **kw)


def no_fetch(_cfg):
    raise AssertionError("unreleased() must never fetch")


hostio.run = spy_run
owncode.fetch = no_fetch
owncode.run = spy_run

print("── ZERO: on the newest tag nothing is ahead ─────────────────────")
f = owncode.unreleased(cfg)
ok(f["commits_ahead"] == 0 and f["since_tag"] == "v2026.1.10" and f["release_blocked_by"] == "none",
   f"on the tag: {f}")

print()
print("── COUNT and BLOCKER: five commits, VERSION unmoved ─────────────")
for i in range(5):
    commit(f"feature {i}")
sync()
tip = git("rev-parse", "origin/main", cwd=REPO)
f = owncode.unreleased(cfg)
ok(f["commits_ahead"] == 5, f"commits_ahead is 5: {f['commits_ahead']}")
ok(f["since_tag"] == "v2026.1.10", f"the NEWEST tag by version arithmetic, not v2026.1.9: {f['since_tag']}")
ok(f["latest_main"] == tip[:7], "latest_main is the tip's 7 characters")
ok(f["release_blocked_by"] == "version-not-bumped", f"the cause is the unbumped VERSION: {f['release_blocked_by']}")
ok(set(f) == {"commits_ahead", "since_tag", "latest_main", "release_blocked_by", "last_tag_attempt"},
   f"the exact key set: {sorted(f)}")

print()
print("── BLOCKER: VERSION bumped, no tag yet ──────────────────────────")
commit("bump", "2026.2.0")
sync()
tip = git("rev-parse", "origin/main", cwd=REPO)
f = owncode.unreleased(cfg)
ok(f["commits_ahead"] == 6 and f["release_blocked_by"] == "unknown",
   f"CI unknown and offline is `unknown`, never a guess: {f['release_blocked_by']}")
cases = [({"green": False, "detail": "1 of 9 check runs did not pass: Install (failure)"}, "install-red"),
         ({"green": False, "detail": "1 of 9 check runs did not pass: Upgrade (failure)"}, "upgrade-red"),
         ({"green": False, "detail": "1 of 9 check runs did not pass: tree (failure)"}, "ci-red"),
         ({"green": True, "detail": "all 9 check runs passed"}, "none")]
for verdict, want in cases:
    got = owncode.unreleased(cfg, checks=lambda sha, v=verdict: v)["release_blocked_by"]
    ok(got == want, f"a CI verdict {verdict['detail'][:42]!r} -> {want}: {got}")
os.makedirs(os.path.join(STATE, "own"), exist_ok=True)
hostio.write_json(os.path.join(STATE, "own", f"checks-{tip}.json"), {"green": True, "at": 1})
ok(owncode.unreleased(cfg)["release_blocked_by"] == "none", "a cached GREEN verdict is read without any network")

print()
print("── OFFLINE: what was run ────────────────────────────────────────")
non_git = [a for a in ran if a[:1] != ["git"]]
ok(not non_git, f"hostio.run was asked for nothing but git ({len(ran)} calls)")
ok(not any("fetch" in a or "ls-remote" in a for a in ran), "no fetch, no ls-remote")

print()
print("── NO TAG: a repository with no release is not 0 ahead ──────────")
bare = os.path.join(TMP, "bare2.git")
w = os.path.join(TMP, "w2")
subprocess.run(["git", "init", "-q", "--bare", "-b", "main", bare], check=True)
subprocess.run(["git", "clone", "-q", bare, w], check=True, capture_output=True)
subprocess.run([*GIT, "checkout", "-q", "-b", "main"], cwd=w, check=True)
with open(os.path.join(w, "VERSION"), "w") as fh:
    fh.write("2026.1.0\n")
subprocess.run([*GIT, "add", "-A"], cwd=w, check=True)
subprocess.run([*GIT, "commit", "-q", "-m", "x"], cwd=w, check=True)
subprocess.run([*GIT, "push", "-q", "origin", "main"], cwd=w, check=True)
cfg2 = Config(repo=w, catalog="", state=os.path.join(TMP, "s2"), backups=os.path.join(TMP, "b2"), textfile=None)
f = owncode.unreleased(cfg2)
ok(f["commits_ahead"] is None and f["since_tag"] is None and f["release_blocked_by"] == "unknown",
   f"no tag: commits_ahead is null, not 0: {f}")
cfg3 = Config(repo=os.path.join(TMP, "not-a-repo"), catalog="", state=os.path.join(TMP, "s3"),
              backups=os.path.join(TMP, "b3"), textfile=None)
ok(owncode.unreleased(cfg3) is None, "no origin/main at all: None")

print()
print("── WRITE and SERVE ──────────────────────────────────────────────")
owncode.write_unreleased(cfg)
path = os.path.join(STATE, "unreleased.json")
ok(stat.S_IMODE(os.stat(path).st_mode) == 0o600, "state/unreleased.json is mode 600")
updates.UPDATES_DIR = STATE
got = updates._unreleased()
ok(got["commits_ahead"] == 6 and got["since_tag"] == "v2026.1.10" and got["release_blocked_by"] == "none",
   f"bothy-ops serves what the host wrote: {got}")
doc = json.load(open(path))
doc["fact"].update(release_blocked_by="deploy-main-now", since_tag="v1; rm -rf /", evil="x", commits_ahead=-3)
doc["fact"]["latest_main"] = "<script>"
json.dump(doc, open(path, "w"))
got = updates._unreleased()
ok(got["release_blocked_by"] == "unknown" and got["since_tag"] is None and got["commits_ahead"] is None
   and got["latest_main"] is None and "evil" not in got,
   f"a hostile file is re-filtered field by field: {got}")
os.unlink(os.path.join(STATE, "unreleased.json"))
ok(updates._unreleased() is None, "no file: no fact (which is not `0 commits ahead`)")
owncode.write_unreleased(cfg)
owncode.write_unreleased(cfg3)  # no origin/main
ok(not os.path.exists(os.path.join(cfg3.state, "unreleased.json")), "no origin/main writes nothing")
os.makedirs(cfg3.state, exist_ok=True)
hostio.write_json(os.path.join(cfg3.state, "unreleased.json"), {"version": 1, "fact": {"commits_ahead": 138}})
owncode.write_unreleased(cfg3)
ok(not os.path.exists(os.path.join(cfg3.state, "unreleased.json")),
   "a stale number is REMOVED when the fact can no longer be computed")

print()
print("── NO DEPLOY-MAIN: nothing here can name a target ───────────────")
src = open(os.path.join(SVC, "updater", "owncode.py"), encoding="utf-8").read()
seg = src[src.index("def unreleased("):src.index("# ── what runs now")]
ok(not any(f'"{w}"' in seg for w in ("merge", "checkout", "reset", "pull", "fetch", "clone")) and "spool" not in seg,
   "unreleased() reads refs only: no merge, checkout, reset, pull, fetch or spool in it")

print()
print(f"{len(fails)} failed" if fails else "all passed")
sys.exit(1 if fails else 0)
