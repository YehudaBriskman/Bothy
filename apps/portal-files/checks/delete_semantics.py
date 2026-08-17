#!/usr/bin/env python3
"""Delete removes a file, keeps the bytes it removed, and refuses six things.

THE ASSERTION THAT EARNS THIS VERB is not "the file is gone" - that half is
trivial and a broken implementation passes it. It is "the bytes are in the trash
AND they are the right bytes". A snapshot that is empty, or that holds the wrong
version, is exactly as destructive as no snapshot at all and looks identical from
the response, which reports only `snapshot: true`.

The six refusals are each checked WITH THE FILE STILL ON DISK AFTERWARDS, for the
same reason: a 403 that deleted anyway is indistinguishable from a correct 403 if
you only read status codes. That mistake is cheap to make and expensive to find.

Everything here runs through HTTP, so it exercises the Traefik route and the
edge's role gate as well as the handler - checks/test_safepath.py already covers
the boundary in-process, and a second in-process copy would prove nothing new.
"""
import os
import re
import subprocess
import sys

import requests

BASE = "http://100.117.176.85"
API = f"{BASE}/-/api/files"
# ~/claude-notes, not ~/stacks. e2e.py ends in `git reset --hard` on stacks and
# snapshots.py plants its probe at the top of it; sharing a repo with either
# means one check's cleanup is another's missing file.
REPO = "/home/devssh/claude-notes"
TRASH = "/home/devssh/.local/state/bothy/trash"
PROBE = "_delete_probe.md"
PROBE_DIR = "_delete_probe_dir"
DISK = f"{REPO}/{PROBE}"
SNAPS = f"{TRASH}/notes/{PROBE}"
KEEP = "keep me - this is the version a delete must preserve\n"

fails = 0


def check(label, ok, detail=""):
    global fails
    if not ok:
        fails += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label:<56} {detail}")


def snaps():
    try:
        return sorted(f for f in os.listdir(SNAPS) if not f.startswith("."))
    except FileNotFoundError:
        return []


def delete(sess, root, path, mtime=None, **kw):
    body = {"root": root, "path": path}
    if mtime is not None:
        body["baseMtime"] = mtime
    r = sess.post(f"{API}/delete", json=body, timeout=20, **kw)
    ctype = r.headers.get("content-type", "")
    return r.status_code, (r.json() if ctype.startswith("application/json") else {})


# Refuse to run rather than clean up first. A leftover probe from an interrupted
# run would make the "nothing in the trash yet" assertions pass or fail for
# reasons that have nothing to do with the code under test.
if os.path.exists(DISK) or snaps() or os.path.exists(f"{REPO}/{PROBE_DIR}"):
    sys.exit(f"REFUSING TO RUN: {DISK}, {REPO}/{PROBE_DIR} or its snapshots "
             f"already exist")

s = requests.Session()
r = s.get(f"{BASE}/oauth2/start", params={"rd": "/"}, allow_redirects=True, timeout=10)
m = re.search(r'action="([^"]+)"', r.text)
s.post(m.group(1).replace("&amp;", "&"),
       data={"username": os.environ["DEV_LOGIN_USER"],
             "password": os.environ["DEV_LOGIN_PASSWORD"]},
       allow_redirects=True, timeout=10)

try:
    print("── anonymous: the route is gated before anything else is asked ─────")
    # No session at all. This is the cheap half of the role check -
    # authz_probe.py proves the `editor` gate is enforced and that this route is
    # the one wired to it; here we only establish that SOMETHING refuses an
    # unauthenticated delete, and that it refuses before touching the disk.
    open(DISK, "w").write(KEEP)
    code, _ = delete(requests.Session(), "notes", PROBE)
    check("an anonymous delete is refused", code in (401, 403), f"got {code}")
    check("and the file is still there", os.path.exists(DISK))

    print("\n── the CSRF guard covers the NEW verb too ──────────────────────────")
    # /write and /delete share one do_POST, and the guards sit above the
    # dispatch precisely so a second verb cannot skip them. That arrangement is
    # invisible from outside, so it is asserted from outside: a text/plain POST
    # is a CORS-simple request, which is why demanding JSON is the load-bearing
    # half of the protection rather than a content negotiation nicety.
    r = s.post(f"{API}/delete", data='{"root":"notes","path":"' + PROBE + '"}',
               headers={"Content-Type": "text/plain"}, timeout=20)
    check("a text/plain delete is refused (no preflight = no protection)",
          r.status_code == 415, f"got {r.status_code}")
    check("and the file survived it", os.path.exists(DISK))

    print("\n── the refusals, each with the file still on disk afterwards ───────")
    code, out = delete(s, "notes", "../../etc/passwd")
    check("a path outside the root is refused", code == 403, f"got {code}")

    code, out = delete(s, "notes", "/etc/passwd")
    check("an absolute path is refused", code == 403, f"got {code}")

    # ~/projects is read-only in policy AND mounted `ro`. The path is a file that
    # really exists, deliberately: pointing at a missing one would let a 404 pass
    # for a read-only refusal and the check would still look green.
    victim = "army/CVOps/docs/01-principles-and-architecture.md"
    code, out = delete(s, "projects", victim)
    check("the read-only projects root is refused", code == 403, f"got {code}")
    check("...and it named the ROOT, not the path", "read-only" in str(out.get("error")),
          out.get("error"))
    check("...and that real file is untouched",
          os.path.exists(f"/home/devssh/projects/{victim}"))

    # A directory must be refused ON PURPOSE. If this ever returns 500 the
    # refusal has become an accident of os.unlink raising EISDIR, which is one
    # well-meant "fix" away from being a recursive delete.
    os.makedirs(f"{REPO}/{PROBE_DIR}", exist_ok=True)
    open(f"{REPO}/{PROBE_DIR}/inside.md", "w").write("still here\n")
    code, out = delete(s, "notes", PROBE_DIR)
    check("a directory is refused", code == 403, f"got {code}")
    check("...deliberately, not by a 500 from EISDIR",
          "directory" in str(out.get("error")), out.get("error"))
    check("...and the directory and its contents remain",
          os.path.exists(f"{REPO}/{PROBE_DIR}/inside.md"))

    # 404, and it must be TELLABLE from the 403s above. A missing file reported
    # as a refusal sends the caller looking for a permissions problem that does
    # not exist.
    code, out = delete(s, "notes", "_delete_no_such_file.md")
    check("a missing file is 404, not 500", code == 404, f"got {code}")
    check("...and 404 is distinct from every refusal above", code != 403,
          out.get("error"))

    print("\n── THE CONFLICT: a stale delete is refused, and the file stays ─────")
    r = s.get(f"{API}/read", params={"root": "notes", "path": PROBE}, timeout=15)
    check("the probe reads back", r.status_code == 200, f"got {r.status_code}")
    stale = r.json()["mtime"] - 1        # what a tab opened one edit ago holds

    code, out = delete(s, "notes", PROBE, mtime=stale)
    check("a stale delete is REFUSED with 409", code == 409, f"got {code}")
    check("and the file is STILL THERE", os.path.exists(DISK)
          and open(DISK).read() == KEEP)
    check("the response says which mtimes disagreed",
          out.get("baseMtime") != out.get("currentMtime"),
          f"{out.get('baseMtime')} vs {out.get('currentMtime')}")
    check("nothing was snapshotted by a refusal", snaps() == [], f"{snaps()}")

    print("\n── the delete itself, and the copy it must leave behind ────────────")
    cur = s.get(f"{API}/read", params={"root": "notes", "path": PROBE},
                timeout=15).json()["mtime"]
    code, out = delete(s, "notes", PROBE, mtime=cur)
    check("a current delete is accepted", code == 200, f"got {code}")
    check("the file is gone from disk", not os.path.exists(DISK))
    check("the response reports the undo net", out.get("snapshot") is True,
          f"snapshot={out.get('snapshot')}")
    check("...and who did it", out.get("author") == os.environ["DEV_LOGIN_USER"],
          out.get("author"))

    kept = snaps()
    check("exactly one copy is in the trash", len(kept) == 1, f"{kept}")
    # THE ASSERTION THIS FILE EXISTS FOR. A file of the right name proves
    # nothing; the failure mode is a snapshot that is empty because it was taken
    # after the unlink, or one that never happened while the response still said
    # `snapshot: true`.
    body = open(f"{SNAPS}/{kept[0]}").read() if kept else ""
    check("and it holds the bytes that were REMOVED", body == KEEP, repr(body[:32]))

    print("\n── the audit log is the only record a deleted file leaves ──────────")
    log = subprocess.run(["docker", "exec", "portal-files", "cat", "/audit/writes.log"],
                         capture_output=True, text=True).stdout
    lines = [l for l in log.splitlines() if PROBE in l and "DELETED" in l]
    check("the delete is in the audit log", bool(lines))
    check("...with the same attribution a write gets",
          bool(lines) and os.environ["DEV_LOGIN_USER"] in lines[-1])
    if lines:
        print("      " + lines[-1])

    print("\n── deleting the same file twice is 404, not a second success ───────")
    code, out = delete(s, "notes", PROBE)
    check("the second delete is 404", code == 404, f"got {code}")
    check("and it did not bank a second snapshot", len(snaps()) == 1, f"{snaps()}")

finally:
    print("\n── cleanup ─────────────────────────────────────────────────────────")
    for p in (DISK, f"{REPO}/{PROBE_DIR}/inside.md"):
        if os.path.exists(p):
            os.remove(p)
    if os.path.isdir(f"{REPO}/{PROBE_DIR}"):
        os.rmdir(f"{REPO}/{PROBE_DIR}")
    subprocess.run(["rm", "-rf", SNAPS], check=False)
    # git_ops.py refuses to run against a dirty ~/claude-notes, so leaving one
    # file behind here fails a check three sections away from the cause.
    dirty = subprocess.run(["git", "-C", REPO, "status", "--porcelain"],
                           capture_output=True, text=True).stdout.strip()
    check("the probe left nothing behind", not dirty, dirty)

print(f"\n{fails} FAILED" if fails else "\nall pass")
sys.exit(1 if fails else 0)
