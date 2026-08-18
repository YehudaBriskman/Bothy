#!/usr/bin/env python3
"""The undo net: every overwrite keeps the bytes it destroyed.

Save writes straight to disk and this service has no commit, so from
2026-08-15 the working tree became the ONLY copy of an edit. safepath.snapshot
puts a copy of the outgoing version in the trash first. This asserts it does,
that a save still succeeds when it CANNOT (best-effort, by design), and that the
policy refuses to start when the trash is not mounted.

Every assertion here has a negative control - a case that must FAIL - because a
backup test that cannot fail is how you find out the backup was empty on the day
you needed it.
"""
import os
import re
import subprocess
import sys

import requests

# One resolver for the whole suite - checks/env.py. These were literals in
# twelve files, which put this node's tailnet address in a public repo and
# made the suite unrunnable by anyone but its author.
from env import AUDIT_LOG, BASE, STACKS, TRASH

API = f"{BASE}/-/api/files"
PROBE = "_snap_probe.md"
DISK = f"{STACKS}/{PROBE}"
SNAPS = f"{TRASH}/stacks/{PROBE}"

fails = 0


def check(label, ok, detail=""):
    global fails
    if not ok:
        fails += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label:<54} {detail}")


def snaps():
    try:
        return sorted(f for f in os.listdir(SNAPS) if not f.startswith("."))
    except FileNotFoundError:
        return []


def save(s, text, mtime=None):
    body = {"root": "stacks", "path": PROBE, "content": text}
    if mtime is not None:
        body["baseMtime"] = mtime
    r = s.post(f"{API}/write", json=body, timeout=20)
    return r.status_code, (r.json() if r.headers.get("content-type", "").startswith("application/json") else {})


if os.path.exists(DISK) or snaps():
    sys.exit(f"REFUSING TO RUN: {DISK} or its snapshots already exist")

s = requests.Session()
r = s.get(f"{BASE}/oauth2/start", params={"rd": "/"}, allow_redirects=True, timeout=10)
m = re.search(r'action="([^"]+)"', r.text)
s.post(m.group(1).replace("&amp;", "&"),
       data={"username": os.environ["DEV_LOGIN_USER"],
             "password": os.environ["DEV_LOGIN_PASSWORD"]},
       allow_redirects=True, timeout=10)

try:
    print("── a create has nothing to keep ────────────────────────────────────")
    code, out = save(s, "version one\n")
    check("create succeeds", code == 200 and out.get("created") is True, f"got {code}")
    check("and reports no snapshot", out.get("snapshot") is False,
          f"snapshot={out.get('snapshot')}")
    check("nothing in the trash yet", snaps() == [], f"{len(snaps())} files")

    print("\n── an overwrite keeps the OUTGOING bytes ───────────────────────────")
    code, out = save(s, "version two\n", out.get("mtime"))
    check("overwrite succeeds", code == 200, f"got {code}")
    check("and reports a snapshot", out.get("snapshot") is True,
          f"snapshot={out.get('snapshot')}")
    kept = snaps()
    check("exactly one copy is kept", len(kept) == 1, f"{kept}")
    # THE ASSERTION THAT MATTERS. A file of the right name proves nothing: the
    # whole failure mode is a backup that exists and is empty, or that holds the
    # NEW content because it was taken after the rename.
    body = open(f"{SNAPS}/{kept[0]}").read() if kept else ""
    check("the copy holds the version that was REPLACED",
          body == "version one\n", repr(body[:24]))
    check("and the file on disk holds the new one",
          open(DISK).read() == "version two\n")

    print("\n── a save that changes nothing keeps nothing ───────────────────────")
    # Re-saving identical bytes destroys nothing, so there is nothing to keep.
    # The first version of this compared the outgoing bytes to the LAST SNAPSHOT
    # instead, which is a different question: after v1 -> v2, re-saving v2
    # differs from the stored v1 and banked a copy of the version still on disk.
    # Twenty of those evict the twenty states that actually differed.
    code, out = save(s, "version two\n", out.get("mtime"))
    check("second identical save is fine", code == 200, f"got {code}")
    check("still one copy, not two", len(snaps()) == 1, f"{snaps()}")
    check("and it is still the REPLACED version",
          open(f"{SNAPS}/{snaps()[0]}").read() == "version one\n" if snaps() else False)

    print("\n── best effort: a save must survive a broken net ───────────────────")
    # The negative control for the whole feature. If this fails CLOSED - refuses
    # the write - it destroys the work it exists to protect: unsaved changes in a
    # tab and nowhere to put them.
    # The LEAF directory, not the trash root. Denying write on the root proves
    # nothing once the per-file directory exists: creating a file inside an
    # existing directory never consults its grandparent. The first version of
    # this check made that mistake and passed while the net was fully intact.
    os.chmod(SNAPS, 0o500)
    try:
        code, out = save(s, "version three\n", out.get("mtime"))
        check("the save still succeeds", code == 200, f"got {code}")
        check("and says so honestly: snapshot=false", out.get("snapshot") is False,
              f"snapshot={out.get('snapshot')}")
        check("the write really landed", open(DISK).read() == "version three\n")
        log = subprocess.run(["tail", "-3", AUDIT_LOG],
                             capture_output=True, text=True).stdout
        check("and the failure is in the audit log", "NOSNAPSHOT" in log,
              log.strip().splitlines()[-1][:58] if log.strip() else "(empty)")
    finally:
        os.chmod(SNAPS, 0o700)

    print("\n── the trash must be MOUNTED, or nothing starts ────────────────────")
    # Fail-closed at startup, unlike the write path. A missing net that nobody
    # notices is the bug; a service that will not start is loud.
    probe = subprocess.run(
        ["docker", "exec", "portal-files", "sh", "-c",
         "sed 's|^path = \"/var/lib/bothy/trash\"|path = \"/var/lib/bothy/nope\"|' "
         "/app/policy.toml > /tmp/bad.toml && "
         "POLICY_FILE=/tmp/bad.toml python3 -c 'import safepath' 2>&1"],
        capture_output=True, text=True)
    check("an unmounted trash refuses to start", probe.returncode != 0,
          f"exit {probe.returncode}")
    check("and says why", "is not a directory" in probe.stdout,
          probe.stdout.strip().splitlines()[-1][:60] if probe.stdout.strip() else "(silent)")

finally:
    print("\n── cleanup ─────────────────────────────────────────────────────────")
    if os.path.exists(DISK):
        os.remove(DISK)
    subprocess.run(["rm", "-rf", SNAPS], check=False)
    dirty = subprocess.run(["git", "-C", STACKS, "status", "--porcelain",
                            "--", PROBE], capture_output=True, text=True).stdout.strip()
    check("the probe left nothing behind", not dirty and not os.path.exists(DISK), dirty)

print(f"\n{fails} FAILED" if fails else "\nall pass")
sys.exit(1 if fails else 0)
