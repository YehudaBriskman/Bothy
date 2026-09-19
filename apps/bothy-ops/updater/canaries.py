"""What "it works" means for each component - checked on BODIES, never on status.

Rule 7 of ~/claude-notes (and SECURITY.md rule 3): a 200 proves nothing on this
box. So every canary here reads the response and looks for a specific thing in
it - a metric NAME in an exporter's /metrics, `ready` in Loki's /ready, series in
VictoriaMetrics' answer to `up`, log lines in Loki's answer to a count.

── how a canary reaches the component ─────────────────────────────────────────

From INSIDE the component's network namespace, with a borrowed helper container
(`docker run --rm --network container:<name> python:3.13-alpine`) - the method
scripts/lib/backup-lib.sh's bk_http already uses. So a canary needs no published
port (headlamp has none, alloy binds 127.0.0.1), the target image needs no curl
(loki is distroless), and nothing is left running. Basic-auth credentials, when a
target has them (VictoriaMetrics), go in on stdin, never in an argv.

A pattern is matched INSIDE the helper, so an exporter's multi-megabyte /metrics
never crosses the pipe - only "MATCH <line>" or "NOMATCH <first bytes>".

── the history probe: how data loss is told apart from a bad release ──────────

A time-series component also carries a `history` canary: a query evaluated AT A
FIXED MOMENT T0 in the past (one minute before pre-flight). Pre-flight records
its answer; verify asks the same question again. Data written before T0 does not
change, so a smaller answer after the update means history became unreadable.
What the executor does with that is its rollback rule (executor.py).
"""

from __future__ import annotations

import json
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Callable

from .hostio import run, tail

PROBE = r'''
import base64, re, sys, urllib.error, urllib.request
method, url, pat = sys.argv[1], sys.argv[2], sys.argv[3]
cred = sys.stdin.read().strip()
req = urllib.request.Request(url, method=method, data=b"" if method == "POST" else None)
if cred:
    req.add_header("Authorization", "Basic " + base64.b64encode(cred.encode()).decode())
def out(status, body):
    print(status)
    if pat:
        m = re.search(pat, body, re.M)
        print(("MATCH " + m.group(0)[:200]) if m else ("NOMATCH " + body[:200].replace("\n", " ")))
    else:
        sys.stdout.write(body[:1048576])
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        out(r.status, r.read(64 * 1024 * 1024).decode(errors="replace"))
except urllib.error.HTTPError as e:
    out(e.code, e.read(65536).decode(errors="replace"))
except Exception as e:
    print(0)
    print("ERROR " + str(e)[:200])
'''


@dataclass
class Ctx:
    """What a canary run knows: where, which phase, and the pre-flight baseline."""
    cfg: object
    container: str
    phase: str = "verify"            # preflight | verify | rollback
    baseline: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Canary:
    describe: str
    check: Callable[[Ctx], tuple[bool, str]]
    history: bool = False            # the data-loss probe of a time-series component


def probe(ctx: Ctx, url: str, pattern: str = "", *, method: str = "GET", cred: str = "") -> tuple[int, str]:
    rc, out, err = run(["docker", "run", "--rm", "-i", "--network", f"container:{ctx.container}",
                        ctx.cfg.helper_image, "python3", "-c", PROBE, method, url, pattern],
                       stdin=cred, timeout=90)
    if rc != 0:
        return 0, f"the probe could not run: {tail(err or out, 200)}"
    status, _, body = out.partition("\n")
    try:
        return int(status.strip()), body
    except ValueError:
        return 0, tail(out, 200)


def body_matches(url: str, pattern: str, describe: str) -> Canary:
    def check(ctx: Ctx) -> tuple[bool, str]:
        st, body = probe(ctx, url, pattern)
        ok = st == 200 and body.startswith("MATCH ")
        return ok, f"{st} {body.strip()[:160]}"
    return Canary(describe, check)


# ── VictoriaMetrics ────────────────────────────────────────────────────────────

def _vm_cred(ctx: Ctx) -> str:
    """Read from the files the running container enforces, like bk_vm_cred."""
    u = run(["docker", "exec", ctx.container, "cat", "/etc/prometheus/prom-username.txt"], timeout=15)
    p = run(["docker", "exec", ctx.container, "cat", "/etc/prometheus/prom-password.txt"], timeout=15)
    if u[0] != 0 or p[0] != 0:
        return ""
    return f"{u[1].strip()}:{p[1].strip()}"


def _vector(body: str) -> list | None:
    try:
        j = json.loads(body)
    except ValueError:
        return None
    if not isinstance(j, dict) or j.get("status") != "success":
        return None
    r = (j.get("data") or {}).get("result")
    return r if isinstance(r, list) else None


def _scalar_sum(result: list) -> float:
    total = 0.0
    for s in result:
        try:
            total += float(s["value"][1])
        except (KeyError, IndexError, TypeError, ValueError):
            pass
    return total


def vm_up() -> Canary:
    def check(ctx: Ctx) -> tuple[bool, str]:
        st, body = probe(ctx, "http://127.0.0.1:8428/api/v1/query?query=up", cred=_vm_cred(ctx))
        r = _vector(body) if st == 200 else None
        if not r:
            return False, f"{st}: `up` returned no series ({tail(body, 120)})"
        return True, f"`up` returned {len(r)} series"
    return Canary("VictoriaMetrics: `up` returns series", check)


def _history(describe: str, query_url: Callable[[float], str], cred: Callable[[Ctx], str]) -> Canary:
    def check(ctx: Ctx) -> tuple[bool, str]:
        if ctx.phase == "preflight":
            t0 = int(time.time()) - 60
            st, body = probe(ctx, query_url(t0), cred=cred(ctx))
            r = _vector(body) if st == 200 else None
            n0 = _scalar_sum(r or [])
            if n0 <= 0:
                return False, f"no history to compare against at T0={t0} ({st})"
            ctx.baseline.update(t0=t0, value=n0)
            return True, f"baseline {n0:g} at T0={t0}"
        t0, n0 = ctx.baseline.get("t0"), ctx.baseline.get("value")
        if t0 is None:
            return False, "no pre-flight baseline"
        st, body = probe(ctx, query_url(t0), cred=cred(ctx))
        r = _vector(body) if st == 200 else None
        n1 = _scalar_sum(r or [])
        if r is None:
            return False, f"{st}: the history query failed ({tail(body, 120)})"
        return n1 >= n0, f"{n1:g} at T0={t0}, was {n0:g}"
    return Canary(describe, check, history=True)


def vm_history() -> Canary:
    return _history("VictoriaMetrics: history before the update is still readable (count(up) at T0 unchanged)",
                    lambda t0: "http://127.0.0.1:8428/api/v1/query?query=count(up)&time=" + str(t0),
                    _vm_cred)


# ── Loki ───────────────────────────────────────────────────────────────────────

_LOKI_ALL = '{container=~".+"}'


def _loki_q(expr: str, t: float | None = None) -> str:
    q = "http://127.0.0.1:3100/loki/api/v1/query?query=" + urllib.parse.quote(expr)
    return q + (f"&time={int(t)}" if t is not None else "")


def loki_ready() -> Canary:
    def check(ctx: Ctx) -> tuple[bool, str]:
        st, body = probe(ctx, "http://127.0.0.1:3100/ready")
        return st == 200 and body.strip() == "ready", f"{st} {body.strip()[:80]!r}"
    return Canary("Loki: /ready says `ready`", check)


def loki_fresh() -> Canary:
    def check(ctx: Ctx) -> tuple[bool, str]:
        st, body = probe(ctx, _loki_q(f"sum(count_over_time({_LOKI_ALL}[2m]))"))
        r = _vector(body) if st == 200 else None
        n = _scalar_sum(r or [])
        return n > 0, f"{n:g} lines in the last 2 minutes" if r is not None else f"{st}: {tail(body, 120)}"
    return Canary("Loki: fresh lines in the last 2 minutes", check)


def loki_history() -> Canary:
    return _history("Loki: history before the update is still readable (line count at T0 unchanged)",
                    lambda t0: _loki_q(f"sum(count_over_time({_LOKI_ALL}[5m]))", t0),
                    lambda ctx: "")


# ── the table: component id -> canaries (the container comes from its pin) ────

CANARIES: dict[str, list[Canary]] = {
    "cadvisor": [body_matches("http://127.0.0.1:8080/metrics", r"^container_memory_working_set_bytes\{",
                              "cAdvisor: /metrics carries container_memory_working_set_bytes")],
    "node-exporter": [body_matches("http://127.0.0.1:9100/metrics", r"^node_cpu_seconds_total\{",
                                   "node-exporter: /metrics carries node_cpu_seconds_total")],
    "postgres-exporter": [body_matches("http://127.0.0.1:9187/metrics", r"^pg_up 1$",
                                       "postgres-exporter: /metrics says pg_up 1")],
    "alloy": [body_matches("http://127.0.0.1:12345/-/ready", r"[Rr]eady",
                           "Alloy: /-/ready says it is ready")],
    "headlamp": [body_matches("http://127.0.0.1:4466/config", r"\"clusters\"\s*:",
                              "Headlamp: /config answers its cluster list")],
    "victoriametrics": [vm_up(), vm_history()],
    "loki": [loki_ready(), loki_fresh(), loki_history()],
}


def for_component(cfg, cid: str) -> list[Canary]:
    return list(getattr(cfg, "canaries", {}).get(cid) or CANARIES.get(cid) or [])
