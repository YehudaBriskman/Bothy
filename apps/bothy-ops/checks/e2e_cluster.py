#!/usr/bin/env python3
"""The cluster class (build step 8) END TO END, on a THROWAWAY minikube profile. Needs docker and minikube.

Run: python3 checks/e2e_cluster.py            (about ten minutes, most of it the profile)

NEVER thales-scc. Everything here is its own, and every name starts with
`bothy-cluster-e2e`:

  a cluster      `minikube start -p bothy-cluster-e2e` (docker driver, 2 CPU, 2.2 GB),
                 its context written to a TEMPORARY kubeconfig only - the
                 operator's ~/.kube/config and its current context are untouched
                 (asserted) - and `minikube delete`d at the end
  VictoriaMetrics and Loki
                 throwaway containers on the profile's docker network: VM scrapes
                 kube-state-metrics through its NodePort (job kube-state-metrics,
                 cluster=bothy-cluster-e2e), Loki receives what alloy ships
  a git repo     a bare "origin" and a clone on main with COPIES of the real
                 k8s/monitoring files and scripts/k8s-monitoring.sh (alloy.yaml
                 pointed at the throwaway Loki and labelled for this cluster), a
                 justfile with `k8s-monitoring *part`, and the live catalog entries

and it drives the REAL executor, with the real canaries plus one injected
failure:

  1  KSM      chart 8.4.2 -> 8.5.0 with a forced verify failure -> `helm rollback`
              to the recorded revision, 8.4.2 answers again, the old version back
              on Chart.yaml's line (uncommitted); then, the tree reset, 8.5.0
              succeeds: kube_node_info through the NodePort, up == 1 in VM from a
              scrape after the upgrade
  2  ALLOY    v1.19.1 -> v1.19.2 with a forced failure -> the saved DaemonSet and
              ConfigMap replaced, v1.19.1 rolled out again; then v1.19.2
              succeeds: rolled out on every node on the planned DIGEST, fresh
              {cluster="bothy-cluster-e2e"} lines in Loki
  3  RULE 6   every kubectl/helm the executor ran named the throwaway context
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(SVC))
sys.path.insert(0, SVC)
os.environ.setdefault("ADMIN_AUDIT_LOG", os.devnull)

import updater  # noqa: E402,F401
from updater import canaries, executor, hostio, k8s, plans, record  # noqa: E402
from updater.config import Config  # noqa: E402

P = "bothy-cluster-e2e"
VM, LOKI = f"{P}-vm", f"{P}-loki"
VM_IMG = "victoriametrics/victoria-metrics:v1.152.0"
LOKI_IMG = "grafana/loki:3.7.8"
KSM_OLD, KSM_NEW = "8.4.2", "8.5.0"
ALLOY_OLD, ALLOY_NEW = "grafana/alloy:v1.19.1", "grafana/alloy:v1.19.2"
assert P != "thales-scc"

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label, flush=True)
    if not cond:
        fails.append(label)


def sh(*argv: str, cwd: str | None = None, check: bool = True, env: dict | None = None,
       timeout: int = 900) -> subprocess.CompletedProcess:
    p = subprocess.run(list(argv), cwd=cwd, capture_output=True, text=True, env=env, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(argv[:6])}: {p.stderr.strip()[-800:] or p.stdout.strip()[-800:]}")
    return p


def main() -> int:
    if not (shutil.which("minikube") and shutil.which("helm") and shutil.which("kubectl")):
        print("SKIPPED: needs minikube, helm and kubectl on PATH")
        return 0
    # A SECOND minikube node beside thales-scc runs out of inotify instances at the
    # default 128: its kube-proxy crash-loops with "too many open files" (measured
    # 2026-09-22) and nothing in it becomes ready. Raising it is a host decision.
    try:
        inst = int(open("/proc/sys/fs/inotify/max_user_instances").read())
    except (OSError, ValueError):
        inst = 0
    if inst < 512:
        print(f"SKIPPED: fs.inotify.max_user_instances is {inst}; a second minikube node needs >= 512 - "
              "`sudo sysctl fs.inotify.max_user_instances=512` for the run (it resets at boot)")
        return 0
    tmp = tempfile.mkdtemp(prefix=f"{P}-")
    os.environ["E2E_TMP"] = tmp
    kubeconfig = os.path.join(tmp, "kubeconfig")
    kenv = {**os.environ, "KUBECONFIG": kubeconfig}
    home_ctx = sh("kubectl", "config", "current-context", check=False).stdout.strip()
    calls: list[list[str]] = []
    real_run = k8s.run

    def spy(argv, **kw):
        calls.append(list(argv))
        return real_run(argv, **kw)

    k8s.run = spy

    def cleanup() -> None:
        sh("docker", "rm", "-f", VM, LOKI, check=False)
        sh("minikube", "delete", "-p", P, env=kenv, check=False, timeout=300)

    try:
        cleanup()
        t0 = time.monotonic()
        # The docker runtime and thales-scc's Kubernetes version: the preload is cached,
        # and a pod's imageID carries the pulled digest the DaemonSet check compares.
        sh("minikube", "start", "-p", P, "--driver=docker", "--container-runtime=docker",
           "--kubernetes-version=v1.35.1", "--cpus=2", "--memory=2200", "--wait=apiserver,system_pods,node_ready",
           env=kenv, timeout=900)
        print(f"  (profile {P} up in {int(time.monotonic() - t0)}s)", flush=True)
        ok(sh("kubectl", "config", "current-context", check=False).stdout.strip() == home_ctx,
           f"the operator's kubeconfig still names {home_ctx or 'nothing'} - the profile went to a temporary file")
        node = sh("minikube", "-p", P, "ip", env=kenv).stdout.strip()

        # The box's side, throwaway: VictoriaMetrics scraping the NodePort, a Loki.
        scrape = os.path.join(tmp, "prometheus.yml")
        open(scrape, "w").write("global:\n  scrape_interval: 5s\nscrape_configs:\n  - job_name: kube-state-metrics\n"
                                f"    static_configs:\n      - targets: ['{node}:30808']\n"
                                f"        labels:\n          cluster: {P}\n")
        os.chmod(tmp, 0o755)
        os.chmod(scrape, 0o644)
        sh("docker", "run", "-d", "--name", VM, "--network", P, "-v", f"{scrape}:/etc/prometheus/prometheus.yml:ro",
           VM_IMG, "-promscrape.config=/etc/prometheus/prometheus.yml")
        sh("docker", "run", "-d", "--name", LOKI, "--network", P, LOKI_IMG, "-config.file=/etc/loki/local-config.yaml")
        loki_ip = json.loads(sh("docker", "inspect", LOKI).stdout)[0]["NetworkSettings"]["Networks"][P]["IPAddress"]

        # The repo: copies of the real files, the Loki URL and cluster label this cluster's.
        repo, origin = os.path.join(tmp, "repo"), os.path.join(tmp, "origin.git")
        G = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]
        sh("git", "init", "-q", "--bare", "-b", "main", origin)
        sh("git", "clone", "-q", origin, repo)
        sh(*G, "checkout", "-q", "-b", "main", cwd=repo)

        def put(rel: str, text: str) -> None:
            p = os.path.join(repo, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "w", encoding="utf-8").write(text)

        def real(rel: str) -> str:
            return open(os.path.join(ROOT, rel), encoding="utf-8").read()

        def merge(msg: str) -> None:
            sh(*G, "add", "-A", cwd=repo)
            sh(*G, "commit", "-q", "-m", msg, cwd=repo)
            sh(*G, "push", "-q", "origin", "main", cwd=repo)

        alloy = real("k8s/monitoring/alloy.yaml").replace("http://host.minikube.internal:3100",
                                                          f"http://{loki_ip}:3100")
        alloy = alloy.replace('cluster = "thales-scc"', f'cluster = "{P}"')
        assert f'cluster = "{P}"' in alloy and loki_ip in alloy
        chart = real("k8s/monitoring/Chart.yaml")

        def files(ksm: str, img: str) -> None:
            put("k8s/monitoring/Chart.yaml", chart.replace(f"version: {KSM_NEW}", f"version: {ksm}"))
            put("k8s/monitoring/alloy.yaml", alloy.replace(f"image: {ALLOY_NEW}", f"image: {img}"))

        for f in ("k8s/monitoring/namespace.yaml", "k8s/monitoring/kube-state-metrics.values.yaml",
                  "scripts/k8s-monitoring.sh"):
            put(f, real(f))
        os.chmod(os.path.join(repo, "scripts/k8s-monitoring.sh"), 0o755)
        put("justfile", "k8s-monitoring *part:\n    ./scripts/k8s-monitoring.sh {{part}}\n")
        cat = real("apps/bothy-ops/updates.toml")
        body = cat[cat.index("[policy]"):cat.index("# ══ stateless")]
        for cid in ("kube-state-metrics", "alloy-cluster"):
            s = cat.index(f"[components.{cid}]")
            body += "\n" + cat[s:cat.find("\n[", s + 1)].strip() + "\n"
        put("apps/bothy-ops/updates.toml", body)
        files(KSM_OLD, ALLOY_OLD)
        merge("the old add-ons")
        e = {**kenv, "KUBE_CONTEXT": P}
        sh("kubectl", "--context", P, "apply", "-f", os.path.join(repo, "k8s/monitoring/namespace.yaml"), env=e)
        sh("kubectl", "--context", P, "-n", "default", "run", "logger", "--image=busybox:1.37", "--restart=Never",
           "--", "sh", "-c", "while true; do echo tick; sleep 2; done", env=e)
        for part in ("ksm", "alloy"):
            sh(os.path.join(repo, "scripts/k8s-monitoring.sh"), part, env=e, timeout=900)
        print(f"  (old add-ons installed, {int(time.monotonic() - t0)}s in)", flush=True)
        files(KSM_NEW, ALLOY_NEW)
        merge("bump both add-ons (as Dependabot would)")

        state = os.path.join(tmp, "state")
        cfg = Config(repo=repo, catalog=os.path.join(repo, "apps/bothy-ops/updates.toml"), state=state,
                     backups=os.path.join(tmp, "backups"), textfile=None, kube_context=P, kubeconfig=kubeconfig,
                     kube_cluster_label=P, vm_container=VM, loki_container=LOKI, cluster_verify_timeout=300)
        digest = next(d.split("@")[1] for d in json.loads(sh("docker", "image", "inspect", ALLOY_NEW).stdout)[0]
                      ["RepoDigests"] if d.startswith("grafana/alloy@"))

        def inject(cid: str) -> canaries.Canary:
            def check(ctx):
                if ctx.phase == "verify" and os.path.exists(os.path.join(tmp, f"inject-{cid}")):
                    return False, "FORCED (a test)"
                return True, "not injected"
            return canaries.Canary(f"e2e: an injected failure ({cid})", check, retry=False)

        cfg.canaries = {c: [inject(c)] for c in ("kube-state-metrics", "alloy-cluster")}

        # The throwaway VictoriaMetrics and Loki need a scrape and a push before the
        # "healthy NOW" pre-flight can hold (it rightly refuses before that).
        ready = {"kube-state-metrics": canaries.vm_job_up("kube-state-metrics"),
                 "alloy-cluster": canaries.loki_cluster_fresh()}
        for cid, cn in ready.items():
            end = time.monotonic() + 240
            while not (res := cn.check(canaries.Ctx(cfg, "", phase="preflight", plan={})))[0] \
                    and time.monotonic() < end:
                time.sleep(5)
            ok(res[0], f"the throwaway observer sees the old {cid} ({res[1][:80]})")

        def run(cid: str, force: bool) -> dict:
            hostio.ensure_dir(state, 0o700)
            hostio.write_json(cfg.available, {"version": 1, "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                              "components": {
                "kube-state-metrics": {"image": "x", "current": {"tag": KSM_NEW, "float": False}},
                "alloy-cluster": {"image": "docker.io/grafana/alloy",
                                  "current": {"tag": "v1.19.2", "float": False, "resolved": digest}}}})
            got = plans.write_all(cfg)
            doc = plans.read_plan(cfg, cid)
            if not doc.get("ok"):
                ok(False, f"{cid}: a plan ({got[cid]})")
                return {}
            flag = os.path.join(tmp, f"inject-{cid}")
            if force:
                open(flag, "w").close()
            elif os.path.exists(flag):
                os.unlink(flag)
            hostio.ensure_dir(cfg.spool, 0o700)
            jid = os.urandom(16).hex()
            hostio.write_json(os.path.join(cfg.spool, f"{jid}.json"), {
                "v": 1, "jobId": jid, "component": cid, "planId": doc["plan"]["id"], "confirm": True,
                "requestedBy": "op@example.com", "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ")})
            t = time.monotonic()
            executor.run_spool(cfg, log=lambda *_: None)
            h = next(x for x in record.history(cfg, 20) if x["id"] == jid)
            st = hostio.read_json(cfg.status_file)["job"]
            print(f"  (job {cid} {h['state']} in {int(time.monotonic() - t)}s: "
                  f"{[(s['name'], s['state']) for s in st['steps']]})", flush=True)
            if h["state"] not in ("succeeded", "rolled_back"):
                print(f"    error: {h.get('error')}\n    last: {[s.get('detail') for s in st['steps']][-3:]}")
            return h

        def helm_now() -> dict:
            return k8s.helm_release(cfg, "monitoring", "kube-state-metrics") or {}

        def ds_image() -> str | None:
            ds = k8s.get_json(cfg, "-n", "monitoring", "get", "daemonset", "alloy")
            return k8s.container_image(ds["spec"]["template"]["spec"], "alloy")

        print("── 1  KSM: helm, forced failure then success ────────────────────", flush=True)
        rev0 = helm_now().get("revision")
        h = run("kube-state-metrics", True)
        r = helm_now()
        ok(h.get("state") == "rolled_back" and r.get("chart") == f"kube-state-metrics-{KSM_OLD}"
           and r.get("revision", 0) > rev0 + 1, f"rolled back with helm rollback: {r}")
        ok(f"version: {KSM_OLD}" in sh(*G, "diff", cwd=repo).stdout, "the old chart version is back on its line, uncommitted")
        snaps = sorted(os.listdir(cfg.snapshots)) if os.path.isdir(cfg.snapshots) else []
        ok(any(n.endswith("-kube-state-metrics") and {"values.yaml", "manifest.yaml", "cluster.json"} <=
               set(os.listdir(os.path.join(cfg.snapshots, n))) for n in snaps), "the snapshot: helm values, manifest, revision")
        sh(*G, "checkout", "-q", "--", ".", cwd=repo)
        h = run("kube-state-metrics", False)
        r = helm_now()
        ok(h.get("state") == "succeeded" and r.get("chart") == f"kube-state-metrics-{KSM_NEW}",
           f"8.5.0 succeeded: {r} ({h.get('error') or ''})")

        print("── 2  ALLOY: the DaemonSet, forced failure then success ─────────", flush=True)
        h = run("alloy-cluster", True)
        ok(h.get("state") == "rolled_back" and ds_image() == ALLOY_OLD, f"rolled back: the DaemonSet runs {ds_image()}")
        done, words = k8s.ds_rolled_out(k8s.get_json(cfg, "-n", "monitoring", "get", "daemonset", "alloy"))
        ok(done, f"…rolled out and ready again ({words})")
        ok(f"image: {ALLOY_OLD}" in sh(*G, "diff", cwd=repo).stdout, "the old image is back on alloy.yaml's line")
        sh(*G, "checkout", "-q", "--", ".", cwd=repo)
        h = run("alloy-cluster", False)
        ok(h.get("state") == "succeeded" and ds_image() == ALLOY_NEW,
           f"v1.19.2 succeeded, on the planned digest, lines in Loki ({h.get('error') or 'ok'})")

        print("── 3  RULE 6: the context, every time ───────────────────────────", flush=True)
        bad = [c for c in calls if (c[0] == "kubectl" and c[c.index("--context") + 1] != P)
               or (c[0] == "helm" and c[c.index("--kube-context") + 1] != P)]
        ok(calls and not bad and all("--kubeconfig" in c for c in calls),
           f"all {len(calls)} kubectl/helm calls named {P} and the test's kubeconfig")
        ok(sh("kubectl", "config", "current-context", check=False).stdout.strip() == home_ctx,
           "the operator's current context never moved")
    finally:
        cleanup()
        shutil.rmtree(tmp, ignore_errors=True)
    left = sh("minikube", "profile", "list", "-o", "json", check=False).stdout
    ok(P not in left and not sh("docker", "ps", "-aq", "--filter", f"name={P}", check=False).stdout.strip()
       and sh("docker", "network", "inspect", P, check=False).returncode != 0,
       "cleanup: no profile, container or network of this test is left")
    print()
    if fails:
        print(f"FAILED: {len(fails)}")
        return 1
    print("cluster e2e: all passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
