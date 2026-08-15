#!/usr/bin/env python3
"""Does anything the portal SERVES look like a credential?

The deny list catches the secret files somebody thought of, and nothing else.
That is not a theory: `.env` was missed until a survey, `*.pem` until a survey,
and `auth/realm-devbox.json` was served to an authenticated viewer with a live
Keycloak client secret in it - nothing in its name suggests one, and every
pattern in the policy missed it. Each was found by a human looking. This is that
look, on demand.

It runs INSIDE the container and enumerates through safepath.resolve, so it sees
exactly what the service would serve - the same policy, the same mounts, the same
refusals. A scanner pointed at the host directories would test a different
question and pass while the real one leaked.

WHY A BASELINE, AND NOT "FAIL ON ANY HIT". Measured across 3,369 readable files,
the detector flags 45, and the top hits are `.env.example`, `auth/compose.yml`
and several READMEs - the files you most need to open in a file explorer. A check
that cries 45 times is a check nobody reads. So the accepted set is recorded, and
this fails only on something NEW.

WHY THE BASELINE IS HASHED. This repository is public. A list of paths reading
"these files look like they hold credentials" is a map for anyone who later gets
read access, and publishing it would trade one exposure for a better-indexed one.
The hash proves membership without naming anything; the full path is printed
HERE, on the box, where whoever runs it can already read the file anyway.

  just files-check              runs it
  python3 checks/served_secrets.py --update   accepts the current set
"""
import hashlib
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASELINE = os.path.join(HERE, "served-secrets.baseline")
CONTAINER = "portal-files"

# Runs in the container. Enumerates with the REAL policy and refuses through the
# real gate, so "served" here means what /read would actually hand over.
PROBE = r'''
import json, os, sys
import safepath

MAX = 512 * 1024
found = []
for root in sorted(safepath.ROOTS):
    base = safepath.ROOTS[root]
    for dirpath, dirnames, filenames in os.walk(base, topdown=True):
        rel_dir = os.path.relpath(dirpath, base)
        rel_dir = "" if rel_dir == "." else rel_dir
        dirnames[:] = safepath.prune_dirs(root, rel_dir, dirnames)
        for fn in filenames:
            rel = os.path.join(rel_dir, fn) if rel_dir else fn
            try:
                res = safepath.resolve(root, rel)
            except Exception:
                continue                      # refused: not served, not our problem
            try:
                fd, st = safepath.safe_open(res.abspath)
            except Exception:
                continue
            try:
                if st.st_size > MAX or st.st_size == 0:
                    continue
                with os.fdopen(fd, "rb") as fh:
                    data = fh.read()
            except Exception:
                continue
            if b"\x00" in data[:8192]:
                continue                      # binary: nothing to read a secret out of
            why = safepath.scan_for_secret(data.decode("utf-8", errors="replace"))
            if why:
                found.append({"root": root, "path": rel, "why": why})
print(json.dumps(found))
'''


def key(f):
    """What the baseline stores. Path and reason, never the value."""
    raw = f"{f['root']}\0{f['path']}\0{f['why']}".encode()
    return hashlib.sha256(raw).hexdigest()[:16]


def load_baseline():
    try:
        with open(BASELINE) as fh:
            return {l.strip() for l in fh if l.strip() and not l.startswith("#")}
    except FileNotFoundError:
        return set()


def main():
    proc = subprocess.run(["docker", "exec", "-i", CONTAINER, "python3", "-"],
                          input=PROBE, capture_output=True, text=True, timeout=600)
    if proc.returncode != 0:
        # A scanner that cannot run must FAIL, never skip. "The check passed"
        # and "the check never ran" have to look different from the outside.
        print(f"FAIL  the scan could not run (exit {proc.returncode})")
        print((proc.stderr or "").strip()[-400:])
        return 1
    try:
        found = json.loads(proc.stdout)
    except json.JSONDecodeError:
        print("FAIL  the scan produced no usable output")
        print((proc.stdout or "")[-400:])
        return 1

    seen = {key(f): f for f in found}

    if "--update" in sys.argv:
        # SHOW WHAT IS BEING ACCEPTED, by name. Writing a baseline blind is how
        # it stops being a baseline: a leftover probe file was once swept in
        # here, and from then on the check reported "nothing new" while the
        # planted secret sat in the accepted set. An update you cannot see is
        # indistinguishable from a suppression.
        was = load_baseline()
        added = [f for h, f in sorted(seen.items()) if h not in was]
        dropped = len(was - set(seen))
        for f in added:
            print(f"  + accepting  {f['root']}:{f['path']}  - {f['why']}")
        if dropped:
            print(f"  - dropping   {dropped} finding(s) no longer present")
        with open(BASELINE, "w") as fh:
            fh.write("# Accepted results of checks/served_secrets.py - see its docstring.\n")
            fh.write("# Hashes of root+path+reason. Deliberately NOT the paths: this\n")
            fh.write("# repository is public, and the list of files that look like they\n")
            fh.write("# hold credentials is exactly the map not to publish.\n")
            fh.write("#\n")
            fh.write(f"# {len(seen)} accepted. Regenerate with --update after INSPECTING\n")
            fh.write("# what changed; accepting a finding you have not opened defeats it.\n")
            for h in sorted(seen):
                fh.write(h + "\n")
        print(f"baseline written: {len(seen)} accepted")
        return 0

    baseline = load_baseline()
    new = [f for h, f in sorted(seen.items()) if h not in baseline]
    gone = len(baseline - set(seen))

    print(f"scanned what the portal serves: {len(found)} flagged, "
          f"{len(baseline)} accepted, {len(new)} new")
    if gone:
        # Not a failure: a file being deleted or denied is the good direction.
        print(f"  ({gone} accepted finding(s) no longer present - "
              f"run --update to tidy the baseline)")
    if not new:
        print("PASS  nothing new looks like a credential")
        return 0
    for f in new:
        print(f"FAIL  NEW  {f['root']}:{f['path']}  - {f['why']}")
    print("\nEither the file should not be served - add a rule to policy.toml -\n"
          "or it is a false positive, in which case run --update to accept it.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
