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
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Callable

from .hostio import docker_json, dotenv, run, tail

PROBE = r'''
import base64, re, sys, urllib.error, urllib.request
method, url, pat = sys.argv[1], sys.argv[2], sys.argv[3]
body = sys.argv[4].encode() if len(sys.argv) > 4 else b""
cred = sys.stdin.read().strip()
req = urllib.request.Request(url, method=method, data=body if method in ("POST", "PUT") else None)
if len(sys.argv) > 5:
    req.add_header("Content-Type", sys.argv[5])
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
    plan: dict = field(default_factory=dict)   # the plan being executed: from/to versions

    def expected_tag(self) -> str | None:
        """The tag that should be running in this phase: the new one only in verify."""
        side = self.plan.get("to" if self.phase == "verify" else "from") or {}
        return side.get("tag")


@dataclass(frozen=True)
class Canary:
    describe: str
    check: Callable[[Ctx], tuple[bool, str]]
    history: bool = False            # the data-loss probe of a time-series component
    retry: bool = True               # False: a failure is final, verify does not wait it out


def probe(ctx: Ctx, url: str, pattern: str = "", *, method: str = "GET", cred: str = "",
          body: str | None = None, ctype: str | None = None, container: str | None = None) -> tuple[int, str]:
    """(status, body) of one request from inside `container` (default: the
    component's). `cred` - `user:password` for basic auth - goes in on STDIN;
    `body` is argv and must never carry a secret."""
    extra = [] if body is None else [body] + ([ctype] if ctype else [])
    rc, out, err = run(["docker", "run", "--rm", "-i", "--network", f"container:{container or ctx.container}",
                        ctx.cfg.helper_image, "python3", "-c", PROBE, method, url, pattern, *extra],
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


# ── Grafana (app-db, one-way) ─────────────────────────────────────────────────
#
# Its admin login is read from the checkout's .env (GRAFANA_USER / _PASSWORD,
# the same defaults monitoring/compose.yml falls back to) and handed to the probe
# on STDIN. /api/health needs no login; the dashboard and datasource reads do.

def _env(ctx: Ctx) -> dict:
    return dotenv(ctx.cfg.repo)


def _grafana_cred(ctx: Ctx) -> str:
    e = _env(ctx)
    return f"{e.get('GRAFANA_USER') or 'admin'}:{e.get('GRAFANA_PASSWORD') or 'admin'}"


def _json(body: str):
    try:
        return json.loads(body)
    except ValueError:
        return None


def grafana_health() -> Canary:
    def check(ctx: Ctx) -> tuple[bool, str]:
        st, body = probe(ctx, "http://127.0.0.1:3000/api/health")
        j = _json(body) if st == 200 else None
        if not isinstance(j, dict) or j.get("database") != "ok":
            return False, f"{st}: /api/health does not say database ok ({tail(body, 120)})"
        want = (ctx.expected_tag() or "").lstrip("v")
        if want and j.get("version") != want:
            return False, f"/api/health says version {j.get('version')}, expected {want}"
        return True, f"database ok, version {j.get('version')}"
    return Canary("Grafana: /api/health says database ok and names the expected version", check)


def grafana_dashboards() -> Canary:
    """No dashboard lost: the count through the API is at least pre-flight's."""
    def check(ctx: Ctx) -> tuple[bool, str]:
        st, body = probe(ctx, "http://127.0.0.1:3000/api/search?type=dash-db&limit=5000", cred=_grafana_cred(ctx))
        j = _json(body) if st == 200 else None
        if not isinstance(j, list):
            return False, f"{st}: /api/search did not answer a list ({tail(body, 120)})"
        n = len(j)
        if ctx.phase == "preflight":
            ctx.baseline["dashboards"] = n
            return True, f"{n} dashboards"
        n0 = ctx.baseline.get("dashboards")
        if n0 is None:
            return False, "no pre-flight dashboard count"
        return n >= n0, f"{n} dashboards, {n0} before the update"
    return Canary("Grafana: at least as many dashboards (API search) as before the update", check)


def grafana_datasource(uid: str = "prometheus") -> Canary:
    def check(ctx: Ctx) -> tuple[bool, str]:
        st, body = probe(ctx, f"http://127.0.0.1:3000/api/datasources/uid/{uid}/health", cred=_grafana_cred(ctx))
        j = _json(body)
        if st == 200 and isinstance(j, dict) and j.get("status") == "OK":
            return True, f"datasource {uid}: OK"
        why = j.get("message") if isinstance(j, dict) else body
        return False, f"{st}: datasource {uid} is not OK ({tail(str(why), 120)})"
    return Canary(f"Grafana: datasource uid={uid} answers its /health with OK", check)


# ── Keycloak (app-db, one-way) ────────────────────────────────────────────────

REALM = "devbox"
KC = "http://127.0.0.1:8080"
# scripts/keycloak-admin-client.sh keeps the service account's secret here.
ADMIN_CLIENT = "bothy-admin"
ADMIN_SECRET = os.path.join("apps", "bothy-ops", "secrets", "keycloak-admin-client-secret")


def kc_issuer() -> Canary:
    def check(ctx: Ctx) -> tuple[bool, str]:
        st, body = probe(ctx, f"{KC}/realms/{REALM}/.well-known/openid-configuration")
        j = _json(body) if st == 200 else None
        iss = j.get("issuer") if isinstance(j, dict) else None
        if not isinstance(iss, str) or not iss.endswith(f"/realms/{REALM}"):
            return False, f"{st}: no issuer for realm {REALM} ({tail(body, 120)})"
        if ctx.phase == "preflight":
            ctx.baseline["issuer"] = iss
            return True, f"issuer {iss}"
        was = ctx.baseline.get("issuer")
        return iss == was, f"issuer {iss}" + ("" if iss == was else f", was {was}")
    return Canary(f"Keycloak: the discovery document's issuer is unchanged (realm {REALM})", check)


def kc_realm() -> Canary:
    def check(ctx: Ctx) -> tuple[bool, str]:
        st, body = probe(ctx, f"{KC}/realms/{REALM}")
        j = _json(body) if st == 200 else None
        ok = isinstance(j, dict) and j.get("realm") == REALM and bool(j.get("public_key"))
        return ok, f"{st} realm {j.get('realm') if isinstance(j, dict) else tail(body, 80)}"
    return Canary(f"Keycloak: realm {REALM} exists and publishes its key", check)


def kc_admin_token() -> Canary:
    """The client-credentials grant of bothy-admin (scripts/keycloak-admin-client.sh).
    The secret is read from its file and goes to the probe on stdin; the token
    that comes back is never written anywhere - only that there was one."""
    def check(ctx: Ctx) -> tuple[bool, str]:
        path = os.path.join(ctx.cfg.repo, ADMIN_SECRET)
        try:
            with open(path, encoding="utf-8") as fh:
                secret = fh.read().strip()
        except OSError:
            return False, f"no {ADMIN_SECRET} - run `just admin-client`"
        if not secret:
            return False, f"{ADMIN_SECRET} is empty"
        st, body = probe(ctx, f"{KC}/realms/{REALM}/protocol/openid-connect/token", method="POST",
                         cred=f"{ADMIN_CLIENT}:{secret}", body="grant_type=client_credentials",
                         ctype="application/x-www-form-urlencoded")
        j = _json(body)
        if (st == 200 and isinstance(j, dict) and j.get("access_token")
                and str(j.get("token_type")).lower() == "bearer"):
            return True, f"token issued to {ADMIN_CLIENT} (expires in {j.get('expires_in')} s)"
        err = j.get("error") if isinstance(j, dict) else None
        return False, f"{st}: no token for {ADMIN_CLIENT} ({err or 'unexpected body'})"
    return Canary(f"Keycloak: the admin token endpoint issues {ADMIN_CLIENT} a token (client credentials)", check)


def kc_init_ran(container: str = "keycloak-init") -> Canary:
    """keycloak-init exited 0 - and, after a recreate, it ran AFTER Keycloak started."""
    def check(ctx: Ctx) -> tuple[bool, str]:
        i = docker_json(["inspect", "--type", "container", container])
        k = docker_json(["inspect", "--type", "container", ctx.container])
        if not i or not k:
            return False, f"{container} or {ctx.container} does not exist"
        st, kst = i[0].get("State") or {}, k[0].get("State") or {}
        if st.get("Status") != "exited" or st.get("ExitCode") != 0:
            return False, f"{container} is {st.get('Status')} with exit code {st.get('ExitCode')}"
        if ctx.phase != "preflight" and str(st.get("StartedAt")) < str(kst.get("StartedAt")):
            return False, f"{container} last ran at {st.get('StartedAt')}, before {ctx.container} started"
        return True, f"{container} exited 0 at {str(st.get('FinishedAt'))[:19]}"
    return Canary("Keycloak: keycloak-init ran after it and exited 0", check)


# A real sign-in, from inside oauth2-proxy's network namespace: /oauth2/start ->
# Keycloak's login form -> the callback (rewritten to this listener, since the
# configured redirect URL goes through the edge) -> a session cookie. Then the
# question the whole boundary rests on: a role the user holds is admitted (202),
# `shell`, which nobody holds, is refused (403). Without a session both would be
# 401, which proves nothing. The login comes from the checkout's .env
# (DEV_LOGIN_USER / _PASSWORD - the seeded user keycloak-init maintains), on STDIN.
LOGIN = r'''
import html, re, sys, urllib.error, urllib.parse, urllib.request
from http.cookiejar import CookieJar
user, _, pw = sys.stdin.read().partition("\n")
pw = pw.rstrip("\n")
base = "http://127.0.0.1:4180"
class Stay(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()), Stay)
def go(url, data=None):
    for _ in range(12):
        try:
            r = op.open(urllib.request.Request(url, data=data), timeout=20)
            return r.status, url, r.read().decode(errors="replace")
        except urllib.error.HTTPError as e:
            if e.code not in (301, 302, 303, 307, 308):
                return e.code, url, e.read().decode(errors="replace")
            nxt = urllib.parse.urljoin(url, e.headers.get("Location", ""))
            u = urllib.parse.urlsplit(nxt)
            if u.path == "/oauth2/callback":
                nxt = base + "/oauth2/callback?" + u.query
            url, data = nxt, None
    return 0, url, "too many redirects"
st, url, body = go(base + "/oauth2/start?rd=%2F")
m = re.search(r'action="([^"]+)"', body)
if not m:
    print(f"LOGIN no login form at {urllib.parse.urlsplit(url).path} ({st})")
    sys.exit()
st, url, body = go(html.unescape(m.group(1)), urllib.parse.urlencode({"username": user, "password": pw}).encode())
codes = {}
for g in ("viewer", "shell"):
    try:
        codes[g] = op.open(base + "/oauth2/auth?allowed_groups=" + g, timeout=20).status
    except urllib.error.HTTPError as e:
        codes[g] = e.code
print(f"CODES viewer={codes['viewer']} shell={codes['shell']} after {urllib.parse.urlsplit(url).path} ({st})")
'''


def oauth2_shell_denied(container: str = "oauth2-proxy") -> Canary:
    def check(ctx: Ctx) -> tuple[bool, str]:
        e = _env(ctx)
        user, pw = e.get("DEV_LOGIN_USER"), e.get("DEV_LOGIN_PASSWORD")
        if not user or not pw:
            return False, "DEV_LOGIN_USER / DEV_LOGIN_PASSWORD are not in .env"
        rc, out, err = run(["docker", "run", "--rm", "-i", "--network", f"container:{container}",
                            ctx.cfg.helper_image, "python3", "-c", LOGIN], stdin=f"{user}\n{pw}\n", timeout=120)
        line = (out.strip().splitlines() or [""])[-1]
        if rc != 0 or not line:
            return False, f"the sign-in probe could not run: {tail(err or out, 160)}"
        return line.startswith("CODES viewer=202 shell=403"), line[:200]
    return Canary("oauth2-proxy: a signed-in user gets 202 for allowed_groups=viewer and 403 for "
                  "allowed_groups=shell", check)


# ── cluster add-ons (class cluster, build step 8) ──────────────────────────────
#
# Read with the operator's kubeconfig and an explicit context (k8s.py), and
# through the box's own VictoriaMetrics and Loki - the two places a person would
# look. `ctx.plan["cluster"]` says what to read; `ctx.baseline["appliedAt"]` is
# when apply (or the rollback) finished, so "fresh" means "after the change".

def _since(ctx: Ctx, floor: int = 30) -> int:
    t = ctx.baseline.get("appliedAt")
    return max(floor, int(time.time() - t) + 5) if ctx.phase != "preflight" and t else 120


def ksm_nodeport() -> Canary:
    """kube-state-metrics' /metrics, through its NodePort, carries kube_node_info -
    the path VictoriaMetrics scrapes (monitoring/scrape.d/kubernetes.yml)."""
    def check(ctx: Ctx) -> tuple[bool, str]:
        from . import k8s
        c = ctx.plan.get("cluster") or {}
        try:
            svc = k8s.get_json(ctx.cfg, "-n", c.get("namespace", ""), "get", "service", c.get("service", ""))
            ports = [p.get("nodePort") for p in (svc.get("spec") or {}).get("ports") or [] if p.get("nodePort")]
            nodes = k8s.get_json(ctx.cfg, "get", "nodes")
        except Exception as e:  # noqa: BLE001 - a canary answers, it does not raise
            return False, f"the cluster did not say where the NodePort is: {e}"
        ips = [a.get("address") for n in nodes.get("items") or []
               for a in (n.get("status") or {}).get("addresses") or [] if a.get("type") == "InternalIP"]
        if not ports or not ips:
            return False, f"no NodePort ({ports}) or node address ({ips})"
        url = f"http://{ips[0]}:{ports[0]}/metrics"
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                body = r.read(64 * 1024 * 1024).decode(errors="replace")
                st = r.status
        except (urllib.error.URLError, OSError) as e:
            return False, f"{url}: {str(e)[:120]}"
        m = re.search(r"^kube_node_info\{[^\n]*", body, re.M)
        return st == 200 and m is not None, (f"{url} {st}: {m.group(0)[:120]}" if m else
                                             f"{url} {st}: no kube_node_info ({tail(body, 80)})")
    return Canary("kube-state-metrics: /metrics through its NodePort carries kube_node_info", check)


def vm_job_up(job: str | None = None) -> Canary:
    """VictoriaMetrics' up{job=...} is 1 for the cluster - and, after the change, from
    a scrape that happened AFTER it (a stale 1 from before the upgrade proves nothing)."""
    def check(ctx: Ctx) -> tuple[bool, str]:
        j = job or (ctx.plan.get("cluster") or {}).get("job") or ""
        sel = f'up{{job="{j}",cluster="{ctx.cfg.kube_cluster_label}"}}'
        q = urllib.parse.quote(f"max(timestamp({sel} == 1))")
        st, body = probe(ctx, f"http://127.0.0.1:8428/api/v1/query?query={q}", cred=_vm_cred_of(ctx),
                         container=ctx.cfg.vm_container)
        r = _vector(body) if st == 200 else None
        if not r:
            return False, f"{st}: {sel} is not 1 ({tail(body, 120)})"
        ts = _scalar_sum(r)
        t0 = ctx.baseline.get("appliedAt") if ctx.phase != "preflight" else None
        if t0 and ts <= t0:
            return False, f"{sel} == 1 only from a scrape at {int(ts)}, before the change ({int(t0)})"
        return True, f"{sel} == 1 (scraped at {int(ts)})"
    return Canary('VictoriaMetrics: up{job="kube-state-metrics"} is 1, from a scrape after the change', check)


def _vm_cred_of(ctx: Ctx) -> str:
    return _vm_cred(Ctx(ctx.cfg, ctx.cfg.vm_container))


def ds_ready() -> Canary:
    """The DaemonSet is rolled out and ready on every node, and every pod runs the
    image this phase expects - by the digest the node actually pulled, when known."""
    def check(ctx: Ctx) -> tuple[bool, str]:
        from . import k8s
        c = ctx.plan.get("cluster") or {}
        side = ctx.plan.get("to" if ctx.phase == "verify" else "from") or {}
        want, digest = side.get("image"), side.get("digest")
        try:
            ds = k8s.get_json(ctx.cfg, "-n", c.get("namespace", ""), "get", "daemonset", c.get("name", ""))
        except Exception as e:  # noqa: BLE001
            return False, str(e)[:200]
        tpl = ((ds.get("spec") or {}).get("template") or {}).get("spec") or {}
        img = k8s.container_image(tpl, c.get("container", ""))
        if img != want:
            return False, f"the DaemonSet's template runs {img}, not {want}"
        done, words = k8s.ds_rolled_out(ds)
        if not done:
            return False, f"not rolled out: {words}"
        labels = ((ds.get("spec") or {}).get("selector") or {}).get("matchLabels") or {}
        sel = ",".join(f"{k}={v}" for k, v in sorted(labels.items()))
        try:
            pods = k8s.get_json(ctx.cfg, "-n", c.get("namespace", ""), "get", "pods", "-l", sel)
        except Exception as e:  # noqa: BLE001
            return False, str(e)[:200]
        items = [p for p in pods.get("items") or [] if not (p.get("metadata") or {}).get("deletionTimestamp")]
        bad = []
        for p in items:
            for cs in (p.get("status") or {}).get("containerStatuses") or []:
                if cs.get("name") != c.get("container"):
                    continue
                iid = str(cs.get("imageID") or "")
                if not cs.get("ready") or (digest and not iid.endswith(digest)):
                    bad.append(f"{(p.get('metadata') or {}).get('name')} ready={cs.get('ready')} {iid[-19:]}")
        if not items or bad:
            return False, f"pods: {', '.join(bad) or 'none'}"
        return True, f"{words}; {len(items)} pod(s) on {want}" + (f" ({digest[:19]}…)" if digest else "")
    return Canary("the DaemonSet is rolled out and ready on every node, every pod on the planned image", check)


def loki_cluster_fresh() -> Canary:
    """Loki receives the cluster's lines - written after the change."""
    def check(ctx: Ctx) -> tuple[bool, str]:
        n = _since(ctx)
        sel = f'{{cluster="{ctx.cfg.kube_cluster_label}"}}'
        st, body = probe(ctx, _loki_q(f"sum(count_over_time({sel}[{n}s]))"), container=ctx.cfg.loki_container)
        r = _vector(body) if st == 200 else None
        got = _scalar_sum(r or [])
        if r is None:
            return False, f"{st}: {tail(body, 120)}"
        return got > 0, f"{got:g} lines for {sel} in the last {n} s"
    return Canary("Loki: fresh {cluster=...} lines, written after the change", check)


# By the plan's cluster kind: a helm release, or a DaemonSet in a manifest.
CLUSTER_CANARIES = {
    "helm": lambda: [ksm_nodeport(), vm_job_up()],
    "daemonset": lambda: [ds_ready(), loki_cluster_fresh()],
}


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
    "grafana": [grafana_health(), grafana_dashboards(), grafana_datasource("prometheus")],
    "keycloak": [kc_issuer(), kc_realm(), kc_init_ran("keycloak-init"), kc_admin_token(),
                 oauth2_shell_denied("oauth2-proxy")],
}


def for_component(cfg, cid: str) -> list[Canary]:
    return list(getattr(cfg, "canaries", {}).get(cid) or CANARIES.get(cid) or [])
