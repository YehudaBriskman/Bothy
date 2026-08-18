#!/usr/bin/env python3
"""The HTTP surface, over a throwaway copy of this repository's real files.

Run: python3 checks/api.py

Needs nothing running. It starts the REAL handler from app.py on a loopback port
and drives it with urllib, so every assertion goes through the same request
parsing, the same policy load, the same resolve() and the same write path a
browser reaches - not through a function called directly with tidy arguments.
The parent integrates and deploys; this must be runnable before either.

It runs against a COPY of the repo's own compose files rather than a fixture,
for the reason noop_bytes.py gives: a fixture is written by the same person who
wrote the code and agrees with it by construction.

It uses the SHIPPED policy.toml, with only the two paths rewritten - the root and
the snapshot directory, both of which are container paths that do not exist on a
host. Everything that matters (the field allowlist, the deny lists, the suffix
list) is the real thing, so a widening in policy.toml shows up here.

── what it asserts ─────────────────────────────────────────────────────────

  fields          GET returns the current value and an mtime
  patch           the happy path, and the file changes by exactly one line
  UNKNOWN FIELD   a field not in the policy is refused             403
  OUTSIDE ROOT    a path that escapes is refused                   403
  STALE MTIME     a baseMtime that no longer matches               409
  MISSING MTIME   a patch with no baseMtime at all                 400
  AMBIGUOUS       the same field on two services, unqualified      409
  SNAPSHOT        the outgoing bytes are kept before the overwrite
  AUDIT           one line, naming who, the field, and old -> new
  CLASS C         edge/dynamic is unreachable, read and write      403
  NOT YAML        a .md file is not patchable                      403
"""
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(SVC))
sys.path.insert(0, SVC)

# ── a throwaway box ─────────────────────────────────────────────────────────
TMP = tempfile.mkdtemp(prefix="bothy-config-api-")
ROOT = os.path.join(TMP, "stacks")
TRASH = os.path.join(TMP, "trash")
AUDIT = os.path.join(TMP, "audit", "patches.log")
os.makedirs(ROOT)
os.makedirs(TRASH)

# The real compose files, copied. Only the ones carrying a patchable label plus
# one that must stay unreachable.
# data/kafka/compose.yml was in this list until 2026-08-18 as "one that must
# stay unreachable"; it was deleted with the rest of the retired stacks.
# edge/dynamic/portal-files.yml plays that role - a real repo file with no
# patchable label - so the case is still covered.
for rel in ("edge/compose.yml", "auth/compose.yml", "monitoring/compose.yml",
            "edge/dynamic/portal-files.yml", "README.md"):
    src = os.path.join(REPO, rel)
    if not os.path.exists(src):
        continue
    dst = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)

# A file with the SAME field on two services, which the repo does not have and
# which the ambiguity refusal exists for. Written by hand because it is the one
# case no real file demonstrates.
with open(os.path.join(ROOT, "twins.yml"), "w") as fh:
    fh.write("services:\n"
             "  alpha:\n"
             "    image: nginx\n"
             "    labels:\n"
             "      - dev.portal.project=Alpha · Nginx\n"
             "  beta:\n"
             "    # a comment that must survive every patch below\n"
             "    image: nginx\n"
             "    labels:\n"
             "      - dev.portal.project=Beta · Nginx\n")

# The shipped policy, with only the container paths rewritten.
POLICY_SRC = open(os.path.join(SVC, "policy.toml"), encoding="utf-8").read()
for want, got in (('path = "/repos/stacks"', f'path = "{ROOT}"'),
                  ('path = "/var/lib/bothy/config-trash"', f'path = "{TRASH}"')):
    if want not in POLICY_SRC:
        sys.exit(f"checks/api.py cannot find {want!r} in policy.toml - the check "
                 f"rewrites those two paths and has gone out of step with it")
    POLICY_SRC = POLICY_SRC.replace(want, got)
POLICY = os.path.join(TMP, "policy.toml")
open(POLICY, "w", encoding="utf-8").write(POLICY_SRC)

os.environ["POLICY_FILE"] = POLICY
os.environ["AUDIT_LOG"] = AUDIT
os.environ["PORT"] = "0"

import app  # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402

srv = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
ADDR = srv.server_address

bad = 0


def say(ok: bool, label: str, detail: str = "") -> None:
    global bad
    if not ok:
        bad += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label:<52} {detail}")


def call(method: str, path: str, body: dict | None = None,
         ctype: str = "application/json") -> tuple[int, dict]:
    c = http.client.HTTPConnection(*ADDR, timeout=10)
    headers = {"X-Auth-Request-Email": "devssh@example.test"}
    payload = None
    if body is not None:
        payload = json.dumps(body).encode()
        headers["Content-Type"] = ctype
    c.request(method, path, payload, headers)
    r = c.getresponse()
    raw = r.read()
    c.close()
    try:
        return r.status, json.loads(raw)
    except json.JSONDecodeError:
        return r.status, {"raw": raw[:200].decode(errors="replace")}


def comment_lines(rel: str) -> int:
    text = open(os.path.join(ROOT, rel), encoding="utf-8").read()
    return sum(1 for ln in text.splitlines() if ln.lstrip().startswith("#"))


print("── it starts, and says what it can do ──────────────────────────────")
code, doc = call("GET", "/healthz")
say(code == 200 and doc.get("fields") == ["dev.portal.project"],
    "healthz names the one patchable field", f"{code} {doc}")

print()
print("── reading what is patchable ───────────────────────────────────────")
code, doc = call("GET", "/config/fields?root=stacks&path=edge/compose.yml")
say(code == 200, "GET /config/fields on a real compose file", str(code))
fields = doc.get("fields", [])
say(len(fields) == 1 and fields[0]["field"] == "dev.portal.project",
    "it finds exactly the declared label", str(fields))
say(fields and fields[0]["value"] == "Edge · Traefik",
    "and reads its value, middle dot intact",
    repr(fields[0]["value"]) if fields else "-")
say(isinstance(doc.get("mtime"), int), "and returns the mtime to patch against",
    str(doc.get("mtime")))
EDGE_MTIME = doc.get("mtime")

code, doc = call("GET", "/config/fields?root=stacks&path=README.md")
say(code == 403, "a .md file is not patchable", f"{code} {doc.get('error')}")

code, doc = call("GET", "/config/fields?root=stacks&path=edge/dynamic/portal-files.yml")
say(code == 403, "edge/dynamic is unreachable even for READING",
    f"{code} {doc.get('error')}")

print()
print("── the refusals ────────────────────────────────────────────────────")
code, doc = call("POST", "/config/patch", {
    "root": "stacks", "path": "edge/compose.yml",
    "field": "image", "value": "nginx", "baseMtime": EDGE_MTIME})
say(code == 403 and "not a patchable field" in doc.get("error", ""),
    "a field NOT in the policy is refused", f"{code} {doc.get('error')}")

code, doc = call("POST", "/config/patch", {
    "root": "stacks", "path": "edge/compose.yml",
    "field": "privileged", "value": "true", "baseMtime": EDGE_MTIME})
say(code == 403, "a class C field is refused like any other",
    f"{code} {doc.get('error')}")

code, doc = call("POST", "/config/patch", {
    "root": "stacks", "path": "../../../etc/passwd",
    "field": "dev.portal.project", "value": "x", "baseMtime": 1})
say(code == 403 and "escapes" in doc.get("error", ""),
    "a path outside the roots is refused", f"{code} {doc.get('error')}")

code, doc = call("POST", "/config/patch", {
    "root": "stacks", "path": "edge/dynamic/portal-files.yml",
    "field": "dev.portal.project", "value": "x", "baseMtime": 1})
say(code == 403, "and so is anything under edge/dynamic",
    f"{code} {doc.get('error')}")

code, doc = call("POST", "/config/patch", {
    "root": "stacks", "path": "edge/compose.yml",
    "field": "dev.portal.project", "value": "Renamed · By A Form"})
say(code == 400 and "baseMtime" in doc.get("error", ""),
    "a patch with NO baseMtime is refused", f"{code} {doc.get('error')}")

code, doc = call("POST", "/config/patch", {
    "root": "stacks", "path": "edge/compose.yml",
    "field": "dev.portal.project", "value": "Renamed · By A Form",
    "baseMtime": EDGE_MTIME - 500})
say(code == 409 and doc.get("currentMtime") == EDGE_MTIME,
    "a STALE baseMtime gets a 409", f"{code} {doc.get('error')}")
say(bool(doc.get("theirs")), "...carrying what the file says now, for the UI",
    str(doc.get("theirs")))

code, doc = call("POST", "/config/patch", {
    "root": "stacks", "path": "edge/compose.yml",
    "field": "dev.portal.project", "value": "a value with a: colon in it",
    "baseMtime": EDGE_MTIME})
say(code == 403 and "key" in doc.get("error", ""),
    "a value YAML cannot carry is refused, not mangled",
    f"{code} {doc.get('error')}")

code, doc = call("POST", "/config/patch", {
    "root": "stacks", "path": "edge/compose.yml",
    "field": "dev.portal.project", "value": "x", "baseMtime": EDGE_MTIME},
    ctype="text/plain")
say(code == 415, "a non-JSON content type is refused (CSRF)", str(code))

print()
print("── the ambiguous case ──────────────────────────────────────────────")
code, doc = call("GET", "/config/fields?root=stacks&path=twins.yml")
TWIN_MTIME = doc.get("mtime")
say(len(doc.get("fields", [])) == 2,
    "two services, two sites, both reported", str(len(doc.get("fields", []))))
code, doc = call("POST", "/config/patch", {
    "root": "stacks", "path": "twins.yml",
    "field": "dev.portal.project", "value": "Ambiguous", "baseMtime": TWIN_MTIME})
say(code == 409 and doc.get("services") == ["alpha", "beta"],
    "an unqualified patch is refused, not applied to the first",
    f"{code} {doc.get('error')}")

before = open(os.path.join(ROOT, "twins.yml"), encoding="utf-8").read()
code, doc = call("POST", "/config/patch", {
    "root": "stacks", "path": "twins.yml", "service": "beta",
    "field": "dev.portal.project", "value": "Beta · Renamed",
    "baseMtime": TWIN_MTIME})
after = open(os.path.join(ROOT, "twins.yml"), encoding="utf-8").read()
say(code == 200 and doc.get("service") == "beta",
    "naming the service resolves it", f"{code} {doc.get('error', '')}")
changed = [i for i, (a, b) in enumerate(zip(before.splitlines(),
                                            after.splitlines())) if a != b]
say(len(changed) == 1, "and changes exactly one line", str(changed))
say("# a comment that must survive every patch below" in after,
    "the comment between the two services survives")

print()
print("── the happy path, on a real file ──────────────────────────────────")
before = open(os.path.join(ROOT, "edge/compose.yml"), encoding="utf-8").read()
before_comments = comment_lines("edge/compose.yml")
code, doc = call("POST", "/config/patch", {
    "root": "stacks", "path": "edge/compose.yml",
    "field": "dev.portal.project", "value": "Edge · Renamed By A Form",
    "baseMtime": EDGE_MTIME})
after = open(os.path.join(ROOT, "edge/compose.yml"), encoding="utf-8").read()
say(code == 200 and doc.get("changed") is True, "the patch applies",
    f"{code} {doc.get('error', '')}")
say(doc.get("previous") == "Edge · Traefik",
    "the response names the old value as well as the new",
    repr(doc.get("previous")))
say(doc.get("applied") is False and bool(doc.get("appliedNote")),
    "and says the FILE changed but the container did not")
say(doc.get("snapshot") is True, "the outgoing bytes were kept")
changed = [i for i, (a, b) in enumerate(zip(before.splitlines(),
                                            after.splitlines())) if a != b]
say(len(changed) == 1, "exactly one line differs", str(changed))
say(comment_lines("edge/compose.yml") == before_comments,
    f"all {before_comments} comment lines are still there",
    str(comment_lines("edge/compose.yml")))
say(len(before.splitlines()) == len(after.splitlines()),
    "the line count is unchanged")

# The undo net actually holds the previous bytes, not just a file.
kept = []
for dirpath, _d, filenames in os.walk(TRASH):
    kept += [os.path.join(dirpath, f) for f in filenames if f != ".last-sweep"]
say(any(open(k, encoding="utf-8").read() == before for k in kept),
    "and the snapshot is byte-identical to what was overwritten",
    f"{len(kept)} snapshot(s)")

# Patching again with the SAME value must not write, so other tabs holding the
# current mtime do not get a spurious 409.
code, doc = call("GET", "/config/fields?root=stacks&path=edge/compose.yml")
m2 = doc["mtime"]
code, doc = call("POST", "/config/patch", {
    "root": "stacks", "path": "edge/compose.yml",
    "field": "dev.portal.project", "value": "Edge · Renamed By A Form",
    "baseMtime": m2})
say(code == 200 and doc.get("changed") is False and doc.get("mtime") == m2,
    "a patch that changes nothing writes nothing", f"{code} {doc}")

print()
print("── the audit line ──────────────────────────────────────────────────")
log = open(AUDIT, encoding="utf-8").read().splitlines() if os.path.exists(AUDIT) else []
hit = [ln for ln in log if "edge/compose.yml" in ln and "PATCHED" in ln]
say(len(hit) == 1, "exactly one line for the one write", str(len(hit)))
if hit:
    parts = hit[0].split("\t")
    say("devssh@example.test" in parts, "it names WHO, from X-Auth-Request-Email")
    say("dev.portal.project" in parts, "and WHAT field")
    say("Edge · Traefik" in hit[0] and "Edge · Renamed By A Form" in hit[0],
        "and the old value -> the new one")

# A newline in a value must never forge a second record. The value is refused
# outright, which is the strongest version of that - assert the log is untouched.
n_before = len(open(AUDIT, encoding="utf-8").read().splitlines())
code, doc = call("POST", "/config/patch", {
    "root": "stacks", "path": "edge/compose.yml",
    "field": "dev.portal.project",
    "value": "x\n2026-01-01T00:00:00Z\tvictim@example.test\tPATCHED\tstacks/x",
    "baseMtime": m2})
n_after = len(open(AUDIT, encoding="utf-8").read().splitlines())
say(code == 403 and n_after == n_before,
    "a value carrying a newline forges no audit record", f"{code}")

srv.shutdown()
shutil.rmtree(TMP, ignore_errors=True)
print()
print("PASS: the API behaves" if not bad else f"FAIL: {bad} assertion(s)")
sys.exit(1 if bad else 0)
