#!/usr/bin/env python3
"""A real container really transitions, and from/to say so truthfully.

Run: python3 checks/transition.py

THE ONLY CHECK HERE THAT NEEDS DOCKER, and it does not need the stack. It builds
its own everything - a throwaway network, its own pair of socket proxies started
with the grants read out of the shipped compose.yml, and a disposable alpine
container - drives the real app.Handler over HTTP against them, and tears it all
down in a finally block.

IT NEVER TOUCHES A CONTAINER THIS BOX ACTUALLY RUNS. Every container it acts on
is one it created, named `bothy-control-check-*`, and the guard against slipping
is not care but arithmetic: the target name is generated with a random suffix at
import time, so there is nothing for it to collide with. `just up` is not
required and must not be run to make this pass.

── why it starts its own proxies rather than talking to the socket ─────────

Because the proxies are the security control, and a check that bypassed them
would prove that Python can restart a container - which was never in doubt -
while proving nothing about the thing this service is made of. Starting them
from the shipped grants means this also verifies, against a real haproxy and a
real daemon, the two claims compose.yml makes and checks/grants.py can only
assert statically:

  the WRITE proxy performs start/stop/restart          and
  the WRITE proxy REFUSES /containers/create and /containers/<id>/json
  the READ proxy REFUSES every POST

That second pair is the whole argument for splitting one proxy into two. If it
ever fails, `POST=1` has stopped being bounded by anything but this repo's own
Python and the compose comment is a lie.

── what it asserts ─────────────────────────────────────────────────────────

  stop        running -> exited,  and docker agrees
  start       exited  -> running, and docker agrees
  restart     running -> running, with a non-zero tookMs
  no-op       start on something already running: ok, from == to
  proxy       create, inspect-through-write, and POST-through-read are refused
"""
import http.client
import json
import os
import secrets
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)
sys.path.insert(0, HERE)

import composeenv  # noqa: E402

fails: list[str] = []
TAG = secrets.token_hex(4)
TARGET = f"bothy-control-check-{TAG}"
NET = f"bothy-control-check-net-{TAG}"
PROXY_READ = f"bothy-control-check-read-{TAG}"
PROXY_WRITE = f"bothy-control-check-write-{TAG}"
MADE: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def dock(*args, check=True) -> str:
    r = subprocess.run(["docker", *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise SystemExit(f"FAIL: docker {' '.join(args)}\n{r.stderr.strip()}")
    return r.stdout.strip()


if subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
    # SKIP rather than FAIL. A box without a reachable daemon is not a broken
    # boundary, and every other check in this directory still runs there.
    print("SKIP: no reachable docker daemon - the other checks do not need one")
    sys.exit(0)


def published(name: str) -> int:
    """The host port docker chose for 2375 in this container."""
    out = dock("port", name, "2375/tcp")
    return int(out.splitlines()[0].rsplit(":", 1)[1])


def proxy(name: str, service: str) -> str:
    """Start one socket proxy with the grants the SHIPPED compose.yml declares.

    Read out of the file rather than written here, so a widening in compose.yml
    is exercised by this check instead of being contradicted by a second copy of
    the settings that agrees with itself.
    """
    env = composeenv.env(service)
    if not env:
        raise SystemExit(f"FAIL: no environment block for {service!r} in compose.yml")
    args = ["run", "-d", "--name", name, "--network", NET,
            # 127.0.0.1 only. This is a socket proxy; even a throwaway one must
            # not be reachable from the tailnet for the life of this check.
            "-p", "127.0.0.1::2375",
            "-v", "/var/run/docker.sock:/var/run/docker.sock:ro"]
    for k, v in sorted(env.items()):
        args += ["-e", f"{k}={v}"]
    args.append(composeenv.image(service))
    dock(*args)
    MADE.append(name)
    return name


def raw(port: int, method: str, path: str, body: bytes | None = None,
        timeout: int = 60) -> int:
    """Straight at a proxy, past bothy-control. Returns the status code.

    The 60s default is not paranoia, it is a measurement. `sleep 300` runs as
    PID 1 in the target container, and PID 1 has no default SIGTERM handler
    installed by the kernel - so `docker restart` sends SIGTERM, waits the full
    10s StopTimeout, and only then SIGKILLs. Timed here: 10.3 seconds for what
    reads like an instant operation.

    That is the number behind app.ACTION_TIMEOUT being 180 rather than something
    that looks generous. A refusal is a container that ignores SIGTERM, which is
    common, and reporting a slow-but-successful stop as a failure while the
    daemon goes on and does it anyway is the worst available outcome.
    """
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        c.request(method, path, body=body,
                  headers={"Content-Type": "application/json"} if body else {})
        return c.getresponse().status
    finally:
        c.close()


def post(base: str, verb: str, container: str):
    req = urllib.request.Request(
        f"{base}/control/{verb}",
        data=json.dumps({"container": container}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except json.JSONDecodeError:
            return e.code, {}


def docker_state(name: str) -> str:
    return dock("inspect", "-f", "{{.State.Status}}", name)


try:
    print("── building a throwaway box ────────────────────────────────────")
    dock("network", "create", NET)
    MADE.append("net:" + NET)
    proxy(PROXY_READ, "socket-read")
    proxy(PROXY_WRITE, "socket-write")
    rp, wp = published(PROXY_READ), published(PROXY_WRITE)
    print(f"  read proxy on 127.0.0.1:{rp}, write proxy on 127.0.0.1:{wp}")

    # The disposable target. `sleep 300` so it stays up on its own and dies on
    # its own if this check is ever killed before the finally runs.
    dock("run", "-d", "--name", TARGET, "alpine", "sleep", "300")
    MADE.append(TARGET)
    print(f"  target container {TARGET}")

    import app  # noqa: E402  - imported AFTER the proxies exist
    app.DOCKER_READ = f"http://127.0.0.1:{rp}"
    app.DOCKER_WRITE = f"http://127.0.0.1:{wp}"
    app.AUDIT_PATH = os.path.join("/tmp", f"bothy-control-check-{TAG}.log")

    srv = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    BASE = f"http://127.0.0.1:{srv.server_port}"

    print()
    print("── the proxies do what compose.yml claims, against a real daemon ──")

    # The WRITE proxy: the three verbs are the ONLY thing it will pass.
    ok(raw(wp, "POST", f"/v1.41/containers/{TARGET}/restart") in (204, 304),
       "write proxy PERFORMS restart")
    ok(raw(wp, "POST", "/v1.41/containers/create",
           body=b'{"Image":"alpine"}') == 403,
       "write proxy REFUSES /containers/create - this is the claim that makes "
       "POST=1 safe here, and it is the one a single-proxy design would lose")
    ok(raw(wp, "GET", f"/v1.41/containers/{TARGET}/json") == 403,
       "write proxy REFUSES inspect - it cannot read a container's Env either")
    ok(raw(wp, "POST", f"/v1.41/exec/{TARGET}/start") == 403,
       "write proxy REFUSES /exec")
    ok(raw(wp, "GET", "/v1.41/images/json") == 403, "write proxy REFUSES /images")
    ok(raw(wp, "GET", "/v1.41/volumes") == 403, "write proxy REFUSES /volumes")

    # The READ proxy: POST=0 is the first haproxy rule and nothing gets past it.
    ok(raw(rp, "GET", f"/v1.41/containers/{TARGET}/json") == 200,
       "read proxy PERFORMS inspect")
    ok(raw(rp, "POST", f"/v1.41/containers/{TARGET}/stop") == 403,
       "read proxy REFUSES stop - POST=0 denies before any allow rule runs")
    ok(raw(rp, "POST", f"/v1.41/containers/{TARGET}/start") == 403,
       "read proxy REFUSES start")
    ok(raw(rp, "POST", "/v1.41/containers/create", body=b'{"Image":"alpine"}') == 403,
       "read proxy REFUSES create")
    ok(docker_state(TARGET) == "running",
       "and after all of that the target is still running")

    print()
    print("── a real transition, reported truthfully ──────────────────────")

    ok(docker_state(TARGET) == "running", "the target starts out running")

    code, r = post(BASE, "stop", TARGET)
    ok(code == 200, f"stop -> {code}")
    ok(r.get("from") == "running" and r.get("to") == "exited",
       f"stop reports {r.get('from')} -> {r.get('to')}")
    ok(docker_state(TARGET) == "exited",
       "and DOCKER agrees the container is exited - the report is not a guess")
    ok(isinstance(r.get("tookMs"), int) and r["tookMs"] > 0,
       f"tookMs is a real measurement ({r.get('tookMs')} ms)")
    ok(r.get("container") == TARGET and r.get("verb") == "stop" and r.get("ok"),
       "the rest of ActionResult is what was asked")

    code, r = post(BASE, "start", TARGET)
    ok(code == 200 and r.get("from") == "exited" and r.get("to") == "running",
       f"start reports {r.get('from')} -> {r.get('to')}")
    ok(docker_state(TARGET) == "running", "and docker agrees it is running")

    code, r = post(BASE, "restart", TARGET)
    ok(code == 200 and r.get("from") == "running" and r.get("to") == "running",
       f"restart reports {r.get('from')} -> {r.get('to')}")
    ok(docker_state(TARGET) == "running", "and docker agrees it is running")
    ok(r.get("tookMs", 0) > 0, f"restart took {r.get('tookMs')} ms")

    # The no-op. Docker answers 304; the honest report is ok with from == to,
    # and this is the case a client could not work out for itself.
    code, r = post(BASE, "start", TARGET)
    ok(code == 200 and r.get("ok") and r.get("from") == r.get("to") == "running",
       "start on something already running is ok with from == to, not an error")

    # By container ID, which is the reference form the deny list has to survive.
    cid = dock("inspect", "-f", "{{.Id}}", TARGET)
    code, r = post(BASE, "stop", cid)
    ok(code == 200 and r.get("container") == TARGET,
       "acting by container ID canonicalises to the NAME in the result")
    ok(docker_state(TARGET) == "exited", "and it really stopped")

    code, r = post(BASE, "restart", "no-such-container-" + TAG)
    ok(code == 404, f"a container that does not exist -> {code}")

finally:
    print()
    print("── tearing it down ─────────────────────────────────────────────")
    for made in reversed(MADE):
        if made.startswith("net:"):
            dock("network", "rm", made[4:], check=False)
        else:
            dock("rm", "-f", made, check=False)
    left = [n for n in (TARGET, PROXY_READ, PROXY_WRITE)
            if dock("ps", "-aq", "-f", f"name=^{n}$", check=False)]
    ok(not left, f"every throwaway container is gone{(' - LEFT: ' + str(left)) if left else ''}")

print()
if fails:
    print(f"FAILURES: {len(fails)}")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print("all transition checks passed")
