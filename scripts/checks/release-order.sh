#!/usr/bin/env bash
# release.yml must make the release self-consistent, in the right order.
#
# v2026.11.1 shipped a checksums.txt written before the manifest existed, so
# `bothy install` refused its own release. The fix is an ORDER, and an order
# can be silently reshuffled by a later edit, so this proves it statically
# (the workflow cannot be run before a real release):
#
#   1. the release-manifest job needs tag, images AND cli (the file it edits
#      is only final once cli has finished uploading it; the digests it
#      records only exist once images has);
#   2. inside it: generate the manifest, THEN build the final checksums.txt with
#      scripts/append-manifest-checksum.sh, THEN upload it (--clobber), THEN
#      attest it AND the manifest, THEN verify, and only then print the pin;
#   3. the cli job prints no pin (its checksums.txt is an intermediate), and
#      the tag job's notice points at the release-manifest job.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
python3 -I - <<'PY'
import re, sys
text = open(".github/workflows/release.yml", encoding="utf-8").read()
fails = []
def fail(m): fails.append(m)
def ok(m): print("PASS ", m)

def job(name):
    m = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  [\w-]+:\n|\Z)", text, re.S | re.M)
    if not m: fail(f"release.yml has no `{name}:` job"); return ""
    return m.group(1)

rm, cli, tag = job("release-manifest"), job("cli"), job("tag")

# 1. needs
m = re.search(r"^    needs:\s*\[([^\]]*)\]", rm, re.M)
needs = {x.strip() for x in m.group(1).split(",")} if m else set()
missing = {"tag", "images", "cli"} - needs
if missing: fail(f"release-manifest must need tag, images and cli; missing {sorted(missing)} (has {sorted(needs)})")
else: ok("release-manifest needs tag, images and cli")

# 2. step order. A step is a "- name:" / "- uses:" item; find the first step
# whose text contains each marker.
steps = re.split(r"^      - (?=name:|uses:)", rm, flags=re.M)[1:]
def idx(pred):
    for i, s in enumerate(steps):
        if pred(s): return i
    return None
order = [
    ("generates the manifest",     lambda s: "gen-release-manifest.py" in s),
    ("builds the final checksums", lambda s: "append-manifest-checksum.sh" in s),
    ("uploads checksums.txt with --clobber",
        lambda s: "gh release upload" in s and "checksums.txt" in s and "--clobber" in s),
    ("attests checksums.txt and the manifest",
        lambda s: "attest-build-provenance" in s and "checksums.txt" in s and "release-manifest.json" in s),
    ("verifies the attestations",  lambda s: s.count("gh attestation verify") >= 2),
    ("prints the pin (summary)",   lambda s: "GITHUB_STEP_SUMMARY" in s and "BOTHY_PIN_CHECKSUMS_SHA256" in s),
]
pos = []
for label, pred in order:
    i = idx(pred)
    if i is None: fail(f"release-manifest has no step that {label}")
    pos.append(i)
if None not in pos:
    if pos != sorted(pos) or len(set(pos)) != len(pos):
        fail("release-manifest steps are out of order; want: " + " < ".join(l for l, _ in order) + f" (found at {pos})")
    else: ok("release-manifest: manifest < final checksums < upload < attest < verify < summary")

# the summary must hash the served file, not something produced earlier
summary = steps[pos[-1]] if pos and pos[-1] is not None else ""
if "sha256sum served/checksums.txt" not in summary: fail("the summary must hash served/checksums.txt (what the release serves)")
else: ok("the pin printed is the hash of the file the release serves")

# 3. the cli job does not print a pin; the tag job points at the right place
if "GITHUB_STEP_SUMMARY" in cli or "sha256sum \"$RUNNER_TEMP/dist/checksums.txt\"" in cli:
    fail("the cli job prints a checksums.txt hash: it is an intermediate file and must not be pinned")
else: ok("the cli job prints no pin")
if "release-manifest job prints" not in tag: fail("the tag job's notice must send the human to the release-manifest job's hash")
else: ok("the tag job's notice names the release-manifest job")

# nothing else may rewrite checksums.txt after the manifest job's upload
if "attest-build-provenance" in cli and "checksums.txt" not in cli: fail("cli no longer attests checksums.txt")

if fails:
    print(); [print("FAIL ", f) for f in fails]; sys.exit(1)
print("\nok - release.yml orders the self-consistent release correctly")
PY
