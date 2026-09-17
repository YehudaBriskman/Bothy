#!/usr/bin/env python3
"""bothy_common as a pure unit: names, the audit writer, the CSRF gate, bodies.

Run: python3 apps/bothy-common/checks/test_common.py

Both backends run this first, because everything they assert about their own
refusals sits on top of these four things. Needs nothing running.

── what it asserts ─────────────────────────────────────────────────────────

  NAMES   fullmatch, always - a trailing newline is refused for both name kinds
          (bothy-control's guard accepted "grafana\\n" until 2026-09)
  AUDIT   a newline or tab in ANY field cannot forge a second record, and an
          unwritable log never raises
  CSRF    text/plain POST 415, cross-site 403, same-origin and absent pass,
          and a GET is never asked for a content type
  BODY    missing/oversized 413, non-JSON 400, non-object 400
"""
import io
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bothy_common import names  # noqa: E402
from bothy_common.audit import AuditLog, flat  # noqa: E402
from bothy_common.http import JsonHandler, Refused, csrf_refusal  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def refused(fn, status: int) -> bool:
    try:
        fn()
    except Refused as e:
        return e.status == status
    return False


print("── names: fullmatch, never match ────────────────────────────────")
for pat, rule, good, what in ((names.DOCKER_NAME, names.DOCKER_RULE, "grafana", "docker"),
                              (names.K8S_NAME, names.K8S_RULE, "frontend", "k8s")):
    ok(names.check(good, pat, what="x", rule=rule) == good, f"{what}: {good!r} is a name")
    for bad in (good + "\n", good + "\r\n", "\n" + good, good + "/x", "../" + good, ""):
        ok(refused(lambda b=bad: names.check(b, pat, what="x", rule=rule), 400),
           f"{what}: {bad!r} is refused (400)")
    for bad in (None, 7, [good]):
        ok(refused(lambda b=bad: names.check(b, pat, what="x", rule=rule), 400),
           f"{what}: a {type(bad).__name__} is refused (400)")
ok(names.DOCKER_NAME.pattern[0] != "^" and names.K8S_NAME.pattern[-1] != "$",
   "the patterns carry no anchors - fullmatch is the only way to use them")

print()
print("── audit: one record per line, whatever the fields hold ─────────")
tmp = tempfile.mkdtemp(prefix="bothy-common-")
log = AuditLog(os.path.join(tmp, "sub", "a.log"))
log.write("who\n2026-01-01T00:00:00Z\tforged@x\tACTED", "ACTED\t", "x\r\ny", suffix="\tNms")
lines = open(log.path, encoding="utf-8").read().splitlines()
ok(len(lines) == 1, f"a newline in a field forges no second record ({len(lines)} line)")
ok(lines and lines[0].count("\t") == 4, "timestamp + three fields + the suffix: exactly four tabs")
ok(flat(" a\tb\nc ") == "a b c", "flat() collapses tabs and newlines and strips")
ro = AuditLog("/proc/definitely/not/writable.log")
try:
    ro.write("who", "ACTED")
    ok(True, "an unwritable log never raises - the request itself was fine")
except Exception as e:  # noqa: BLE001
    ok(False, f"an unwritable log raised {type(e).__name__}")

print()
print("── CSRF: the shape of the request ───────────────────────────────")
H = lambda **h: {k.replace("_", "-"): v for k, v in h.items()}  # noqa: E731
r = csrf_refusal(H(Content_Type="text/plain"), "POST")
ok(r is not None and r.status == 415, "a text/plain POST -> 415 (a CORS-simple request)")
ok(csrf_refusal(H(), "POST").status == 415, "a POST with no Content-Type -> 415")
r = csrf_refusal(H(Content_Type="application/json; charset=utf-8", Sec_Fetch_Site="cross-site"), "POST")
ok(r is not None and r.status == 403, "a cross-site JSON POST -> 403")
ok(csrf_refusal(H(Content_Type="application/json", Sec_Fetch_Site="same-site"), "POST").status == 403,
   "same-SITE is not same-ORIGIN (the :8100 sandbox is same-site) -> 403")
ok(csrf_refusal(H(Content_Type="application/json", Sec_Fetch_Site="same-origin"), "POST") is None,
   "a same-origin JSON POST passes")
ok(csrf_refusal(H(Content_Type="application/json"), "POST") is None,
   "no Sec-Fetch-Site (curl, an old browser) passes on the JSON half alone")
ok(csrf_refusal(H(Content_Type="text/plain", Sec_Fetch_Site="cross-site"), "POST").status == 415,
   "content type is checked first, as every tier did before the merge")
ok(csrf_refusal(H(), "GET") is None, "a GET is never asked for a content type")
ok(csrf_refusal(H(Sec_Fetch_Site="cross-site"), "GET").status == 403, "a cross-site GET -> 403")

print()
print("── bodies ───────────────────────────────────────────────────────")


class Fake(JsonHandler):
    def __init__(self, body: bytes, length: str | None = None):  # noqa: D107 - no socket
        self.headers = {"Content-Length": str(len(body)) if length is None else length}
        self.rfile = io.BytesIO(body)


ok(Fake(b'{"a": 1}').read_json_object(100) == {"a": 1}, "a JSON object is returned")
ok(refused(lambda: Fake(b"").read_json_object(100), 413), "an empty body -> 413")
ok(refused(lambda: Fake(b"x" * 101).read_json_object(100), 413), "a body over the ceiling -> 413")
ok(refused(lambda: Fake(b"{}", length="nope").read_json_object(100), 413), "a junk Content-Length -> 413")
ok(refused(lambda: Fake(b"not json").read_json_object(100), 400), "a non-JSON body -> 400")
ok(refused(lambda: Fake(b"[1, 2]").read_json_object(100), 400), "a JSON array -> 400")
ok(refused(lambda: Fake(b'"s"').read_json_object(100), 400), "a JSON string -> 400")

print()
if fails:
    print(f"FAILURES: {len(fails)}")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print("bothy_common: all passed")
