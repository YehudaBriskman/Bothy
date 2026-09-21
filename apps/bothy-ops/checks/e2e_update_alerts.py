#!/usr/bin/env python3
"""The update alert rules, loaded into a THROWAWAY Grafana and evaluated. Needs docker.

Run: python3 checks/e2e_update_alerts.py        (about two minutes)

Grafana's own provisioning is the only parser whose verdict counts: a rule file
that YAML accepts can still be refused at start (a bad refId, an unknown
evaluator), and a PromQL typo only shows when a rule is evaluated. So this
starts, on a private network with nothing published beyond 127.0.0.1:

  bothy-alerts-test-vm        VictoriaMetrics (the live image), fed series in the
                              exact shapes the updater writes, with timestamps
                              spanning 15 days
  bothy-alerts-test-grafana   Grafana (the live image) provisioned with THE REPO'S
                              monitoring/provisioning/alerting/*.yml unchanged, and
                              a datasource with the live uid (`prometheus`) aimed at
                              the VM above

and asserts that the three update rules load, and that each one is firing or
pending for exactly the series it is about:

  update_failed        web ended rolled_back -> firing (for: 0s); web2's last
                       result is succeeded -> nothing
  update_auto_paused   web paused -> pending (for: 5m); loki's 0 -> nothing
  update_stale         loki's patch on offer for 15 days -> pending (for: 1h);
                       web2's for 2 days -> nothing

Never the live stack: its own names, network and volumes, removed in a finally.
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
P = "bothy-alerts-test"
NET, VM, GF = f"{P}-net", f"{P}-vm", f"{P}-grafana"

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label, flush=True)
    if not cond:
        fails.append(label)


def sh(*argv: str, check: bool = True) -> str:
    p = subprocess.run(list(argv), capture_output=True, text=True)
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(argv)} -> {p.returncode}: {p.stderr[-600:]}")
    return p.stdout.strip()


def image(service: str) -> str:
    import yaml
    doc = yaml.safe_load(open(os.path.join(REPO, "monitoring", "compose.yml")))
    return doc["services"][service]["image"]


def cleanup() -> None:
    subprocess.run(["docker", "rm", "-f", VM, GF], capture_output=True)
    subprocess.run(["docker", "network", "rm", NET], capture_output=True)


if shutil.which("docker") is None or subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
    print("SKIP: no docker daemon")
    sys.exit(0)

cleanup()
TMP = tempfile.mkdtemp(prefix="bothy-alerts-e2e-")
try:
    sh("docker", "network", "create", NET)
    sh("docker", "run", "-d", "--name", VM, "--network", NET, "-p", "127.0.0.1::8428", image("victoriametrics"),
       "-retentionPeriod=30d", "-search.latencyOffset=0s")
    vm = "http://127.0.0.1:" + sh("docker", "port", VM, "8428/tcp").splitlines()[0].rsplit(":", 1)[1]
    for _ in range(60):
        try:
            if urllib.request.urlopen(vm + "/health", timeout=2).read().strip() == b"OK":
                break
        except OSError:
            time.sleep(0.5)

    # ── the series, as the updater and discovery write them ─────────────────
    now = int(time.time())
    lines = []
    for t in range(now - 15 * 86400, now + 1, 1800):
        ms = t * 1000
        lines.append(f'bothy_update_available{{component="loki",level="patch"}} 1 {ms}')
        if t > now - 2 * 86400:
            lines.append(f'bothy_update_available{{component="web2",level="patch"}} 1 {ms}')
    for t in range(now - 1800, now + 1, 30):
        ms = t * 1000
        lines += [f'bothy_update_last_result{{component="web",result="rolled_back"}} 1 {ms}',
                  f'bothy_update_last_result{{component="web",result="succeeded"}} 0 {ms}',
                  f'bothy_update_last_result{{component="web2",result="rolled_back"}} 0 {ms}',
                  f'bothy_update_last_result{{component="web2",result="succeeded"}} 1 {ms}',
                  f'bothy_update_paused{{component="web"}} 1 {ms}',
                  f'bothy_update_paused{{component="loki"}} 0 {ms}']
    urllib.request.urlopen(urllib.request.Request(vm + "/api/v1/import/prometheus",
                                                  data="\n".join(lines).encode(), method="POST"), timeout=30)
    urllib.request.urlopen(vm + "/internal/force_flush", timeout=10)

    # ── Grafana with the repo's alerting provisioning, unchanged ────────────
    prov = os.path.join(TMP, "provisioning")
    shutil.copytree(os.path.join(REPO, "monitoring", "provisioning", "alerting"), os.path.join(prov, "alerting"))
    for d in ("datasources", "dashboards", "plugins"):
        os.makedirs(os.path.join(prov, d))
    with open(os.path.join(prov, "datasources", "ds.yml"), "w") as fh:
        fh.write(f"apiVersion: 1\ndatasources:\n  - name: Prometheus\n    uid: prometheus\n    type: prometheus\n"
                 f"    access: proxy\n    url: http://{VM}:8428\n    isDefault: true\n")
    os.chmod(TMP, 0o755)
    for root, dirs, files in os.walk(prov):
        for d in dirs:
            os.chmod(os.path.join(root, d), 0o755)
        for f in files:
            os.chmod(os.path.join(root, f), 0o644)
    sh("docker", "run", "-d", "--name", GF, "--network", NET, "-p", "127.0.0.1::3000",
       "-e", "ALERT_EMAIL_TO=alerts@example.com", "-e", "GF_SECURITY_ADMIN_PASSWORD=throwaway",
       "-v", f"{prov}:/etc/grafana/provisioning:ro", image("grafana"))
    gf = "http://127.0.0.1:" + sh("docker", "port", GF, "3000/tcp").splitlines()[0].rsplit(":", 1)[1]
    auth = "Basic " + base64.b64encode(b"admin:throwaway").decode()

    def api(path: str) -> object:
        req = urllib.request.Request(gf + path, headers={"Authorization": auth})
        return json.loads(urllib.request.urlopen(req, timeout=10).read())

    for _ in range(120):
        try:
            if api("/api/health").get("database") == "ok":
                break
        except OSError:
            pass
        time.sleep(1)
    logs = subprocess.run(["docker", "logs", GF], capture_output=True, text=True)
    errs = [ln for ln in (logs.stdout + logs.stderr).splitlines()
            if "level=error" in ln and ("provision" in ln.lower() or "alert" in ln.lower())]
    ok(not errs, f"Grafana provisioned the repo's alerting files without an error {errs[:2]}")
    rules = {r["uid"]: r for r in api("/api/v1/provisioning/alert-rules")}
    ok({"instance_down", "kube_cluster_down", "update_failed", "update_auto_paused", "update_stale"} <= set(rules),
       f"every rule loaded, the old ones too: {sorted(rules)}")
    ok(rules.get("update_failed", {}).get("labels", {}).get("severity") == "critical"
       and rules.get("update_stale", {}).get("labels", {}).get("severity") == "info", "severities as written")
    pol = api("/api/v1/provisioning/policies")
    ok(any(r.get("repeat_interval") in ("24h", "1d") and ["severity", "=", "info"] in r.get("object_matchers", [])
           for r in pol.get("routes") or []), f"the notices route: severity=info, once a day ({pol.get('routes')})")

    # ── evaluated: firing / pending for exactly the right series ────────────
    def states() -> dict:
        out: dict = {}
        doc = api("/api/prometheus/grafana/api/v1/rules")
        for g in doc["data"]["groups"]:
            for r in g["rules"]:
                for a in r.get("alerts") or []:
                    if a["state"].lower() == "normal":
                        continue
                    out.setdefault(r["name"], []).append(
                        (a["labels"].get("component"), a["labels"].get("result"), a["state"].lower()))
        return out

    want = {"Update rolled back or failed", "Automatic updates paused", "Update waiting for over 14 days"}
    st: dict = {}
    for _ in range(90):
        st = states()
        if all(st.get(n) for n in want):
            break
        time.sleep(2)
    fired = st.get("Update rolled back or failed", [])
    ok([(c, r) for c, r, s in fired] == [("web", "rolled_back")] and fired[0][2].startswith("alerting"),
       f"update_failed: web/rolled_back is FIRING, web2 (succeeded) is not: {fired}")
    paused = st.get("Automatic updates paused", [])
    ok([c for c, _, _ in paused] == ["web"] and paused[0][2] == "pending", f"update_auto_paused: web pending (for 5m), loki not: {paused}")
    stale = st.get("Update waiting for over 14 days", [])
    ok([c for c, _, _ in stale] == ["loki"] and stale[0][2] == "pending",
       f"update_stale: loki (15 days) pending (for 1h), web2 (2 days) not: {stale}")
finally:
    cleanup()
    shutil.rmtree(TMP, ignore_errors=True)

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("update alerts in a throwaway grafana: all passed")
