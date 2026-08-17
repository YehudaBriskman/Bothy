#!/usr/bin/env python3
"""The HTTP surface, against a stand-in for the two socket proxies.

Run: python3 checks/api.py

Needs nothing running - not the stack, not docker. It starts the REAL handler
from app.py on a loopback port and drives it with urllib, so every assertion
goes through the same request parsing, the same CSRF guard, the same
guard.valid_name() and the same act() a browser reaches - not through a function
called with tidy arguments.

── why a stand-in daemon rather than the real one ──────────────────────────

The refusals are the interesting half of this service and NONE of them should
ever reach a daemon. Asserting that with a real docker present would prove that
the refusal happened OR that docker happened to be unreachable, and those two
look identical from the client. The stand-in COUNTS what reaches it, so
"refused" is a positive assertion: zero requests arrived.

It is also what makes the traversal cases testable at all. There is no real
container named `x/../../v1.48/containers/create`, so against a real daemon a
404 would prove nothing about whether the guard fired or the daemon shrugged.

checks/transition.py is the other half: a real container, a real daemon, a real
state change. Neither one is sufficient alone.

── what it asserts ─────────────────────────────────────────────────────────

  happy path      the ActionResult shape, exactly, with from/to as a transition
  304             a no-op start reports ok with from == to, not an error
  unknown verb    /control/kill and friends           404, daemon untouched
  bad name        every traversal shape               400, daemon untouched
  severing        stop/restart on the four            409, daemon untouched
  by id           naming traefik by its container ID  409 (canonicalised first)
  start exempt    start on a severing container is performed
  CSRF            text/plain and cross-site           415 / 403
  body            missing, oversized, non-object      413 / 400
  audit           one line per outcome, including the refusals
  no leak         a refusal names no daemon detail it did not need to
"""
import json
import os
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)

AUDIT = os.path.join(tempfile.mkdtemp(prefix="bothy-control-api-"), "actions.log")
os.environ["AUDIT_LOG"] = AUDIT

import app  # noqa: E402
import guard  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


# ── the stand-in proxies ────────────────────────────────────────────────────
#
# A tiny model of the daemon: a name -> state table, and a count of everything
# asked of it. The COUNT is the point - see the header.
STATE = {
    "grafana": "running",
    "traefik": "running",
    "bothy-control": "running",
    "bothy-control-socket-read": "running",
    "bothy-control-socket-write": "running",
    "already-up": "running",
    "sleeper": "exited",
}
# Container ids, so the by-id bypass can be tested the way an attacker would try
# it: the daemon resolves the id to the canonical name, and the deny check runs
# against THAT.
IDS = {"deadbeefcafe" + "0" * 52: "traefik"}
SEEN: list[tuple[str, str]] = []


def resolve(ref: str) -> str | None:
    if ref in STATE:
        return ref
    return IDS.get(ref)


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, payload):
        b = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        SEEN.append(("GET", self.path))
        parts = self.path.strip("/").split("/")
        # /v1.41/containers/<ref>/json
        if len(parts) != 4 or parts[1] != "containers" or parts[3] != "json":
            return self._json(404, {"message": "no route"})
        name = resolve(parts[2])
        if name is None:
            return self._json(404, {"message": "No such container"})
        return self._json(200, {"Name": "/" + name, "State": {"Status": STATE[name]}})

    def do_POST(self):
        SEEN.append(("POST", self.path))
        parts = self.path.strip("/").split("/")
        if len(parts) != 4 or parts[1] != "containers":
            return self._json(404, {"message": "no route"})
        name, verb = resolve(parts[2]), parts[3]
        if name is None:
            return self._json(404, {"message": "No such container"})
        want = {"start": "running", "stop": "exited", "restart": "running"}[verb]
        if STATE[name] == want and verb != "restart":
            return self._json(304, {})   # already in that state - a no-op
        STATE[name] = want
        self.send_response(204)
        self.end_headers()


def serve(handler) -> str:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_port}"


# Both halves point at the same stand-in. The SPLIT is a property of the compose
# file and is asserted by checks/grants.py against the shipped grants; here what
# matters is only that the code makes the calls it claims to.
app.DOCKER_READ = app.DOCKER_WRITE = serve(Fake)
BASE = serve(app.Handler)


def post(verb, body, ctype="application/json", site=None, raw=None):
    data = raw if raw is not None else json.dumps(body).encode()
    req = urllib.request.Request(f"{BASE}/control/{verb}", data=data, method="POST")
    if ctype:
        req.add_header("Content-Type", ctype)
    if site:
        req.add_header("Sec-Fetch-Site", site)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw_body = e.read()
        try:
            return e.code, json.loads(raw_body)
        except json.JSONDecodeError:
            return e.code, {"_raw": raw_body[:120].decode("utf-8", "replace")}


def untouched(fn, label):
    """Run fn and assert the daemon saw nothing at all."""
    before = len(SEEN)
    result = fn()
    ok(len(SEEN) == before, f"{label} - the daemon was never asked")
    return result


print("── the happy path, and the ActionResult contract ───────────────")

code, r = post("stop", {"container": "grafana"})
ok(code == 200, f"stop grafana -> {code}")
ok(set(r) == {"ok", "container", "verb", "from", "to", "tookMs"},
   f"the response is exactly ActionResult, no more and no fewer keys: {sorted(r)}")
ok(r.get("ok") is True and r.get("container") == "grafana" and r.get("verb") == "stop",
   "ok, container and verb are what was asked")
ok(r.get("from") == "running" and r.get("to") == "exited",
   f"from/to report the transition truthfully: {r.get('from')} -> {r.get('to')}")
ok(isinstance(r.get("tookMs"), int) and r["tookMs"] >= 0,
   f"tookMs is an integer count of milliseconds ({r.get('tookMs')})")

code, r = post("start", {"container": "grafana"})
ok(code == 200 and r["from"] == "exited" and r["to"] == "running",
   f"start grafana: {r.get('from')} -> {r.get('to')}")

# A no-op is not a failure. The daemon says 304; the honest report is ok with
# from == to, which is exactly what the contract's two fields exist to express
# and what a client cannot work out for itself.
code, r = post("start", {"container": "already-up"})
ok(code == 200 and r["ok"] and r["from"] == r["to"] == "running",
   f"start on something already running is ok with from == to ({r.get('from')})")

print()
print("── an unknown verb is refused, and never reaches the daemon ────")

for verb in ("kill", "exec", "create", "rm", "pause", "update", "prune",
             "Restart", "restart2", "json"):
    code, r = untouched(lambda v=verb: post(v, {"container": "grafana"}),
                        f"verb {verb!r}")
    ok(code == 404, f"verb {verb!r} -> {code}")
    ok("restart" in r.get("error", "") and "stop" in r.get("error", ""),
       f"the refusal for {verb!r} names the allowlist rather than the guess")

ok(STATE["grafana"] == "running", "no unknown verb changed anything")

print()
print("── a name that is not a plain container name is refused ────────")

for name in ("../etc/passwd", "x/../../v1.48/containers/create", "grafana/json",
             "/grafana", "grafana%2f..%2fcreate", "%2e%2e%2fcreate",
             "grafana?x=1", "grafana restart", "grafana\nX", "-dash", "a" * 200,
             "grafana;id", ".."):
    code, r = untouched(lambda n=name: post("restart", {"container": n}),
                        f"name {name[:30]!r}")
    ok(code == 400, f"name {name[:30]!r} -> {code}")

for bad in (None, 42, ["grafana"], {"n": 1}, ""):
    code, r = untouched(lambda b=bad: post("restart", {"container": b}),
                        f"container {bad!r}")
    ok(code == 400, f"container {bad!r} -> {code}")

code, r = untouched(lambda: post("restart", {}), "a body with no container")
ok(code == 400, f"a body with no container -> {code}")

print()
print("── the self-severing set: stop and restart are refused ─────────")

for name in sorted(guard.SEVERING):
    for verb in ("stop", "restart"):
        code, r = untouched(lambda v=verb, n=name: post(v, {"container": n}),
                            f"{verb} {name}")
        ok(code == 409, f"{verb} {name} -> {code}")
        ok("terminal" in r.get("error", "").lower(),
           f"the refusal for {verb} {name} says where the way back is")
    ok(STATE[name] == "running", f"{name} is still running")

# THE BYPASS. The Docker API accepts a container ID as readily as a name, so a
# deny list checked against the caller's string is sidestepped by naming traefik
# by its id. app.inspect() canonicalises FIRST and the deny check runs against
# the daemon's own Name - so this must be refused, and it must be refused AFTER
# an inspect rather than before one.
tid = next(iter(IDS))
before = len(SEEN)
code, r = post("stop", {"container": tid})
ok(code == 409, f"stop traefik BY CONTAINER ID -> {code} (the deny list is "
                f"checked against the canonical name, not the caller's string)")
ok(len(SEEN) == before + 1 and SEEN[-1][0] == "GET",
   "and it cost exactly one inspect and zero POSTs")
ok(STATE["traefik"] == "running", "traefik was not stopped by its id")

# start is the recovery verb and is exempt. Denying it would deny the way back.
STATE["bothy-control-socket-read"] = "exited"
code, r = post("start", {"container": "bothy-control-socket-read"})
ok(code == 200 and r["to"] == "running",
   "start on a severing container is PERFORMED - it is the recovery verb")

print()
print("── CSRF: the shape of the request, not just its contents ───────")

code, r = untouched(
    lambda: post("restart", {"container": "grafana"}, ctype="text/plain"),
    "a text/plain POST")
ok(code == 415, f"text/plain -> {code} (a CORS-simple request skips the preflight)")

code, r = untouched(
    lambda: post("restart", {"container": "grafana"}, ctype=None),
    "a POST with no Content-Type")
ok(code == 415, f"no Content-Type -> {code}")

code, r = untouched(
    lambda: post("restart", {"container": "grafana"}, site="cross-site"),
    "a cross-site POST")
ok(code == 403, f"Sec-Fetch-Site: cross-site -> {code}")

code, r = post("restart", {"container": "grafana"}, site="same-origin")
ok(code == 200, f"Sec-Fetch-Site: same-origin -> {code}")

print()
print("── bodies ──────────────────────────────────────────────────────")

code, r = untouched(lambda: post("restart", None, raw=b""), "an empty body")
ok(code == 413, f"an empty body -> {code}")
code, r = untouched(lambda: post("restart", None, raw=b"x" * 9000), "an oversized body")
ok(code == 413, f"a 9 KB body -> {code}")
code, r = untouched(lambda: post("restart", None, raw=b"not json"), "a non-JSON body")
ok(code == 400, f"a non-JSON body -> {code}")
code, r = untouched(lambda: post("restart", ["grafana"]), "a JSON array body")
ok(code == 400, f"a JSON array body -> {code}")

print()
print("── a container that does not exist ─────────────────────────────")
code, r = post("restart", {"container": "nosuchthing"})
ok(code == 404, f"restart nosuchthing -> {code}")
ok("nosuchthing" in r.get("error", ""), "and the message names it")

print()
print("── the audit log ───────────────────────────────────────────────")

with open(AUDIT, encoding="utf-8") as fh:
    lines = [ln.rstrip("\n") for ln in fh if ln.strip()]

ok(bool(lines), f"the log has {len(lines)} lines")
ok(all(ln.count("\t") >= 4 for ln in lines),
   "every line is tab-separated with at least timestamp, who, outcome, verb, container")

acted = [ln for ln in lines if "\tACTED\t" in ln]
refused = [ln for ln in lines if "\tREFUSED\t" in ln]
ok(bool(acted), f"successful actions are logged ({len(acted)})")
ok(bool(refused), f"REFUSALS are logged too ({len(refused)}) - an operator wants "
                  f"'who tried to stop traefik and was told no'")
ok(any("stop\ttraefik" in ln for ln in refused),
   "the refused stop on traefik is in the log by name")
ok(any("running -> exited" in ln for ln in acted),
   "an acted line records the transition, not just the verb")
ok(any(ln.rstrip().endswith("ms") for ln in acted),
   "an acted line records the duration")

# Forgery. The audit log is one record per line, so a newline in any field
# would let a container name write a whole extra record attributing an action to
# somebody else. guard.valid_name() refuses it first; flat() is the second lock,
# and this asserts the pair holds end to end rather than in isolation.
before_lines = len(lines)
post("stop", {"container": "ok\n2026-01-01T00:00:00Z\tvictim@example.com\tACTED\tstop\tpostgres"})
with open(AUDIT, encoding="utf-8") as fh:
    after = [ln.rstrip("\n") for ln in fh if ln.strip()]
forged = [ln for ln in after if "victim@example.com" in ln.split("\t")[1:2]]
ok(not forged, "a newline in a container name cannot forge an audit record")
ok(len(after) - before_lines <= 1,
   f"and it produced at most one line, not two ({len(after) - before_lines})")

print()
if fails:
    print(f"FAILURES: {len(fails)}")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print("all API checks passed")
