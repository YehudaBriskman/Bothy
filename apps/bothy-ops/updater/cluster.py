"""Cluster add-ons through the updater (class `cluster`, build step 8).

Two components, the same rule as everything else - deploy only what `main` pins:

  kube-state-metrics   source helm: the chart version in k8s/monitoring/Chart.yaml.
                       What runs is the release's chart version (`helm list`).
  alloy-cluster        source manifest: the DaemonSet image in k8s/monitoring/alloy.yaml.
                       What runs is the DaemonSet's template image (`kubectl get`).

A plan is "the cluster runs W; the checked-out main pins X". The flow is the
image classes' - validate, preflight, snapshot, apply, verify, rollback - with
the cluster's own pieces:

  snapshot   helm: `helm get values` (and `get manifest`) plus the REVISION.
             DaemonSet: `kubectl get -o yaml` of it and of every ConfigMap its
             pods mount (a new alloy.yaml may change the config too), and a
             cleaned JSON copy of each that `kubectl replace` can put back.
  apply      `just k8s-monitoring ksm|alloy` - the narrow part of the same
             scripts/k8s-monitoring.sh a person runs, so this updates ONE add-on
             and never also applies the other's pending pin with no snapshot.
  verify     kube-state-metrics answers /metrics with kube_node_info through its
             NodePort, and VictoriaMetrics' up{job="kube-state-metrics"} is 1 from
             a scrape AFTER the change; the DaemonSet is rolled out and ready on
             every node, every pod on the planned image (by the digest the node
             pulled), and Loki receives {cluster="thales-scc"} lines written after it.
  rollback   `helm rollback <release> <revision>`; `kubectl replace` of the saved
             ConfigMap(s) and DaemonSet, then the rollout. The previous pin goes
             back on its line, left uncommitted, like every other rollback here -
             so the next `just k8s-monitoring` keeps the version that works.

Identity (SECURITY.md rule 6): the operator's kubeconfig, `--context thales-scc`
on every argv, and a ServiceAccount identity refused outright (k8s.py). Channel
`notify`: never automatic (`AUTO_CLASSES` excludes `cluster`).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time

import updates
from discover_updates import helm_pin, same_image, split_image

from . import canaries, classes, hostio, k8s, pins, record
from .config import Config
from .hostio import HostError, iso, run, tail
from .plans import PLAN_VERSION, PlanRefused, _git_gate, _home, _material_id, load_available

PART = {"helm": "ksm", "daemonset": "alloy"}


class Refuse(Exception):
    """Pre-flight said no."""


class StepError(Exception):
    """A step failed after pre-flight."""


# ══ the pin lines ═════════════════════════════════════════════════════════════

def chart_line(repo: str, rel: str, name: str) -> pins.Line:
    """The `version:` line of the `- name: <name>` dependency in a Chart.yaml -
    the same scan as discover_updates.chart_dependency, with a line number."""
    lines = open(os.path.join(repo, rel), encoding="utf-8").read().split("\n")
    in_deps = in_entry = False
    for i, ln in enumerate(lines, 1):
        if not ln.strip() or ln.lstrip().startswith("#"):
            continue
        if not ln.startswith((" ", "-")):
            in_deps, in_entry = ln.rstrip() == "dependencies:", False
            continue
        if not in_deps:
            continue
        m = re.match(r"\s*-\s*name:\s*(\S+)", ln)
        if m:
            in_entry = m.group(1).strip("'\"") == name
            continue
        if in_entry and re.match(r"\s+version:\s*\S+", ln):
            return pins.Line(rel, i, ln)
    raise HostError(f"{rel}: no `version:` for the dependency {name}")


def manifest_line(repo: str, rel: str, container: str) -> pins.Line:
    """The `image:` line of the container named `container` in a manifest - the
    same scan as discover_updates.manifest_image, with a line number."""
    lines = open(os.path.join(repo, rel), encoding="utf-8").read().split("\n")
    hits = []
    for i, ln in enumerate(lines):
        m = re.fullmatch(r"(\s*)-\s+name:\s*(\S+)\s*", ln)
        if not m or m.group(2).strip("'\"") != container:
            continue
        key = len(m.group(1)) + 2
        for j in range(i + 1, len(lines)):
            nxt = lines[j]
            if not nxt.strip() or nxt.lstrip().startswith("#"):
                continue
            ind = len(nxt) - len(nxt.lstrip(" "))
            if ind < key or (ind == key - 2 and nxt.lstrip().startswith("-")):
                break
            if ind == key and re.fullmatch(r"\s*image:\s*\S+(\s+#.*)?", nxt):
                hits.append(pins.Line(rel, j + 1, nxt))
                break
    if len(hits) != 1:
        raise HostError(f"{rel}: expected one image: line for container {container}, found {len(hits)}")
    return hits[0]


def _value(line: pins.Line) -> str:
    v = line.text.split(":", 1)[1].split("#", 1)[0].strip().strip("'\"")
    if not v:
        raise HostError(f"{line.file}:{line.line} carries no value")
    return v


# ══ the plan ══════════════════════════════════════════════════════════════════

def _discovered(available: dict, comp: updates.Component) -> dict:
    e = available["components"].get(comp.id)
    if not isinstance(e, dict):
        raise PlanRefused("not discovered yet - run `just updates-discover`")
    return e


def plan(comp: updates.Component, cfg: Config, catalog: updates.Catalog, available: dict | None,
         target: str | None = None) -> dict:
    if comp.source not in ("helm", "manifest") or len(comp.pins) != 1:
        raise PlanRefused("a cluster add-on is a helm chart or a manifest image, with one pin")
    rel, name = comp.pin_parts(0)
    name = name or ""
    head = _git_gate(cfg, [rel])
    available = available if available is not None else load_available(cfg)
    e = _discovered(available, comp)
    cur = e.get("current") if isinstance(e.get("current"), dict) else {}
    try:
        user = k8s.whoami(cfg)
    except HostError as err:
        raise PlanRefused(f"the cluster ({cfg.kube_context}) cannot be asked: {err}") from None
    try:
        if comp.source == "helm":
            return _helm_plan(comp, cfg, available, e, cur, rel, name, head, user, target)
        return _ds_plan(comp, cfg, available, e, cur, rel, name, head, user, target)
    except HostError as err:
        raise PlanRefused(str(err)) from None


def _level(frm: str, to: str, what: str, target: str | None, pinned: str) -> tuple[updates.Version, updates.Version, str]:
    from_v, to_v = updates.parse_version(frm), updates.parse_version(to)
    if not to_v or len(to_v.parts) < 3:
        raise PlanRefused(f"main pins {pinned}, not an exact version - pin one first")
    if not from_v or from_v.shape != to_v.shape:
        raise PlanRefused(f"the cluster runs {what} {frm}, which cannot be compared with {to}")
    if from_v == to_v:
        raise PlanRefused(f"nothing to deploy: the cluster runs what main pins ({pinned})")
    level = updates.classify(from_v, to_v)
    if level is None:
        raise PlanRefused(f"{pinned} is not newer than what runs ({frm}) - a downgrade is done by hand")
    if level == "major":
        raise PlanRefused(f"a major ({from_v.text} -> {to_v.text}) is a manual procedure")
    if target is not None and target not in (to, pinned, to_v.text):
        raise PlanRefused(f"{target} is not what main pins ({pinned}) - the updater deploys only what main pins; "
                          "merge its Dependabot PR and pull the checkout first")
    return from_v, to_v, level


def _helm_plan(comp, cfg, available, e, cur, rel, name, head, user, target) -> dict:
    if not rel.endswith("Chart.yaml"):
        raise PlanRefused(f"{rel}: the updater moves a chart pinned in a Chart.yaml dependency")
    if not comp.release or not comp.chart:
        raise PlanRefused("updates.toml gives no release or chart for it")
    line = chart_line(cfg.repo, rel, name)
    pinned = _value(line)
    if pinned != helm_pin(rel, open(os.path.join(cfg.repo, rel), encoding="utf-8").read(), name):
        raise PlanRefused(f"{rel}: the pin line and discovery's reader disagree")
    if cur.get("tag") != pinned:
        raise PlanRefused(f"discovery is older than the checkout (it saw {cur.get('tag')}, {rel} pins {pinned}) - "
                          "run `just updates-discover`")
    ns, rname = comp.release.split("/")
    rel_now = k8s.helm_release(cfg, ns, rname)
    if rel_now is None:
        raise PlanRefused(f"helm release {comp.release} is not installed in {cfg.kube_context} - install it by hand "
                          "first (`just k8s-monitoring`); the updater only upgrades a running add-on")
    if rel_now["status"] != "deployed":
        raise PlanRefused(f"helm release {comp.release} is {rel_now['status']!r}, not deployed - look at "
                          f"`helm -n {ns} history {rname}` and fix it by hand first")
    if not rel_now["chart"].startswith(comp.chart + "-"):
        raise PlanRefused(f"{comp.release} runs chart {rel_now['chart']}, not {comp.chart}")
    installed = rel_now["chart"][len(comp.chart) + 1:]
    from_v, to_v, level = _level(installed, pinned, "chart", target, pinned)
    k = {"kind": "helm", "context": cfg.kube_context, "identity": user, "namespace": ns, "release": rname,
         "service": rname, "job": rname, "revision": rel_now["revision"], "chart": comp.chart,
         "chartRepo": comp.chart_repo, "part": PART["helm"]}
    frm = {"image": f"{comp.chart}-{installed}", "tag": installed, "version": from_v.text, "digest": None,
           "container": rname, "revision": rel_now["revision"]}
    to = {"image": f"{comp.chart}-{pinned}", "tag": pinned, "version": to_v.text, "digest": None}
    return _assemble(comp, cfg, available, head, line, pinned, k, frm, to, level, extra={
        "downtime": ("~10-60 s: kube-state-metrics' pod is replaced (helm --wait); the cluster panels in Grafana "
                     "miss a scrape or two. Nothing else in the cluster is touched"),
        "snapshot": (f"`helm get values` of {rname} and its revision {rel_now['revision']} (plus `helm get "
                     "manifest`), and the pin line"),
        "verify": [f"helm says {rname} is deployed at chart {pinned}, a newer revision than "
                   f"{rel_now['revision']}",
                   "kube-state-metrics' /metrics, through its NodePort, carries kube_node_info",
                   f'VictoriaMetrics: up{{job="{rname}",cluster="{cfg.kube_cluster_label}"}} is 1, from a scrape '
                   "after the upgrade"],
        "rollback": (f"`helm rollback {rname} {rel_now['revision']}` (--wait), then the same checks on the "
                     f"old chart; {rel}:{line.line} goes back to {installed} (uncommitted, on purpose) so the next "
                     "`just k8s-monitoring` keeps the version that works"),
    })


def _ds_plan(comp, cfg, available, e, cur, rel, name, head, user, target) -> dict:
    if not comp.workload:
        raise PlanRefused("updates.toml gives no workload for it")
    ns, kind, wname = comp.workload.split("/")
    if kind != "daemonset":
        raise PlanRefused(f"the updater moves a DaemonSet's image; {comp.workload} is a {kind}")
    line = manifest_line(cfg.repo, rel, name)
    pinned = _value(line)
    to = split_image(pinned)
    if e.get("image") != to["ref"] or cur.get("tag") != to["tag"]:
        raise PlanRefused(f"discovery is older than the checkout (it saw {e.get('image')}:{cur.get('tag')}, "
                          f"{rel} pins {pinned}) - run `just updates-discover`")
    if cur.get("float"):
        raise PlanRefused(f"{pinned} is a floating pin - pin an exact version first")
    to_digest = to["digest"] or cur.get("resolved")
    if not isinstance(to_digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", to_digest):
        raise PlanRefused(f"the digest of {pinned} is unknown - discovery could not resolve it")
    ds = k8s.get_json(cfg, "-n", ns, "get", "daemonset", wname)
    tpl = ((ds.get("spec") or {}).get("template") or {}).get("spec") or {}
    running = k8s.container_image(tpl, name)
    if not running:
        raise PlanRefused(f"{comp.workload} has no container {name}")
    if same_image(running, pinned):
        raise PlanRefused(f"nothing to deploy: {comp.workload} runs what main pins ({pinned})")
    frm = split_image(running)
    if frm["ref"] != to["ref"]:
        raise PlanRefused(f"{comp.workload} runs {frm['ref']}, main pins {to['ref']} - a different image, not an "
                          "update; do it by hand")
    from_v, to_v, level = _level(frm["tag"] or "", to["tag"] or "", "image", target, pinned)
    cms = sorted({(v.get("configMap") or {}).get("name") for v in tpl.get("volumes") or []
                  if isinstance(v, dict) and (v.get("configMap") or {}).get("name")})
    gen = (ds.get("metadata") or {}).get("generation")
    k = {"kind": "daemonset", "context": cfg.kube_context, "identity": user, "namespace": ns, "name": wname,
         "container": name, "configMaps": cms, "generation": gen, "part": PART["daemonset"]}
    fr = {"image": running, "tag": frm["tag"], "version": from_v.text, "digest": frm["digest"],
          "container": comp.workload, "generation": gen}
    t = {"image": pinned, "tag": to["tag"], "version": to_v.text, "digest": to_digest}
    return _assemble(comp, cfg, available, head, line, pinned, k, fr, t, level, extra={
        "downtime": ("a rolling restart of the Alloy pod on each node (~10-30 s each): the cluster's pod logs pause "
                     "and resume from alloy's saved positions - nothing is lost"),
        "snapshot": (f"`kubectl get -o yaml` of the DaemonSet {wname} and of the ConfigMap(s) it mounts "
                     f"({', '.join(cms) or 'none'}), a copy `kubectl replace` can put back, and the pin line"),
        "verify": [f"the DaemonSet {wname} is rolled out and ready on every node, every pod on {pinned} "
                   f"({to_digest[:19]}…)",
                   f'Loki receives {{cluster="{cfg.kube_cluster_label}"}} lines written after the rollout'],
        "rollback": (f"`kubectl replace` of the saved ConfigMap(s) and DaemonSet (back to {running}), and a wait for "
                     f"the rollout; {rel}:{line.line} goes back to {running} (uncommitted, on purpose) so the next "
                     "`just k8s-monitoring` keeps the version that works"),
    })


def _assemble(comp, cfg, available, head, line, pinned, k, frm, to, level, extra) -> dict:
    material = {
        "v": PLAN_VERSION, "component": comp.id, "class": comp.cls, "container": frm["container"],
        "from": {kk: frm[kk] for kk in ("image", "digest") if kk in frm} | {
            "state": frm.get("revision", frm.get("generation"))},
        "to": {"image": to["image"], "digest": to["digest"]},
        "pin": {"file": line.file, "service": None, "line": line.line, "text": line.text, "commit": head},
        "recipe": f"{comp.apply} {k['part']}",
        "cluster": {kk: k[kk] for kk in ("kind", "context", "identity", "namespace")},
    }
    return {
        **material,
        "id": _material_id(material),
        "kind": "cluster",
        "title": comp.title,
        "createdAt": iso(),
        "discoveredAt": available.get("generatedAt"),
        "level": level,
        "confirm": "click",
        "from": {**material["from"], **frm},
        "to": to,
        "pin": {**material["pin"], "service": comp.pin_parts(0)[1]},
        "pins": [{"file": line.file, "service": comp.pin_parts(0)[1], "line": line.line, "text": line.text,
                  "container": None}],
        "changelog": updates.changelog_url(comp.changelog, to["version"]),
        "oneWay": comp.one_way, "oneWayWhy": comp.one_way_why,
        "restarts": [f"{k['namespace']}/{k.get('release') or k.get('name')} in {k['context']}", *comp.dependants],
        "downtime": extra["downtime"],
        "signedOut": "nobody - nothing that signs anyone in is touched",
        "snapshot": {"kind": k["kind"], "what": extra["snapshot"],
                     "dir": _home(os.path.join(cfg.snapshots, f"<time>-{comp.id}")) + "/", "estimateBytes": 0},
        "preflight": [
            "the plan is still current: recomputed from main, the cluster and discovery, it has this id",
            f"the cluster is reached as {k['identity']} with --context {k['context']} - the operator's kubeconfig, "
            "never a ServiceAccount token (bothy-ops' included)",
            f"{frm['container']} is what the plan saw ({'revision' if k['kind'] == 'helm' else 'generation'} "
            f"{frm.get('revision', frm.get('generation'))}), and its checks pass NOW",
            f"`{comp.apply} {k['part']}` touches this add-on only",
            "no other update is running (one global lock)",
        ],
        "verify": extra["verify"],
        "rollback": extra["rollback"],
        "cluster": k,
    }


# ══ the executor ══════════════════════════════════════════════════════════════

class ClusterExecution:
    def __init__(self, cfg: Config, rec: record.Recorder, comp: updates.Component, plan_: dict) -> None:
        self.cfg = cfg
        self.rec = rec
        self.comp = comp
        self.plan = plan_
        self.k = plan_["cluster"]
        self.ctx = canaries.Ctx(cfg, "", phase="preflight", plan=plan_)
        self.canaries = [*(cfg.canaries.get(comp.id) or []), *canaries.CLUSTER_CANARIES[self.k["kind"]]()]
        self.line = pins.Line(plan_["pin"]["file"], plan_["pin"]["line"], plan_["pin"]["text"])
        self.snap: str | None = None

    def step(self, name: str, fn):
        self.rec.step(name, "running")
        try:
            out = fn()
        except (Refuse, StepError) as e:
            self.rec.step(name, "failed", str(e))
            raise
        except Exception as e:  # noqa: BLE001 - a bug must still end in a record and a rollback
            self.rec.step(name, "failed", f"{type(e).__name__}: {e}")
            raise StepError(f"{name}: {type(e).__name__}: {e}") from None
        self.rec.step(name, "ok", out if isinstance(out, str) else None)
        return out

    def go(self) -> str:
        try:
            self.step("preflight", self.preflight)
        except Refuse as e:
            return self.rec.finish("refused", str(e))["state"]
        try:
            self.step("snapshot", self.snapshot)
        except StepError as e:
            return self.rec.finish("aborted", f"{e} - nothing in the cluster was changed")["state"]
        try:
            self.step("apply", self.apply)
            self.step("verify", lambda: self.verify("verify"))
        except StepError as e:
            return self.rollback(e)
        return self.rec.finish("succeeded", note=f"{self.plan['container']} runs {self.plan['to']['image']}, which "
                                                 "main already pins - the tree is unchanged")["state"]

    # ── what runs now ──
    def _state(self) -> str:
        if self.k["kind"] == "helm":
            r = k8s.helm_release(self.cfg, self.k["namespace"], self.k["release"])
            if not r:
                return "not installed"
            return f"{r['chart']} revision {r['revision']} {r['status']}"
        ds = k8s.get_json(self.cfg, "-n", self.k["namespace"], "get", "daemonset", self.k["name"])
        tpl = ((ds.get("spec") or {}).get("template") or {}).get("spec") or {}
        return f"{k8s.container_image(tpl, self.k['container'])} generation {(ds.get('metadata') or {}).get('generation')}"

    def preflight(self) -> str:
        try:
            who = k8s.whoami(self.cfg)
        except HostError as e:
            raise Refuse(str(e)) from None
        if who != self.k["identity"]:
            raise Refuse(f"the kubeconfig now acts as {who}, the plan was made as {self.k['identity']}")
        want = (f"{self.k['chart']}-{self.plan['from']['tag']} revision {self.plan['from']['revision']} deployed"
                if self.k["kind"] == "helm" else
                f"{self.plan['from']['image']} generation {self.plan['from']['generation']}")
        try:
            now = self._state()
        except HostError as e:
            raise Refuse(f"the cluster did not answer: {e}") from None
        if now != want:
            raise Refuse(f"{self.plan['container']} changed since the plan was made: {now}, the plan saw {want}")
        if not hostio.which("just"):
            raise Refuse("`just` is not on PATH")
        self.ctx.phase = "preflight"
        done = []
        for cn in self.canaries:
            ok, d = False, ""
            for _ in range(3):
                ok, d = cn.check(self.ctx)
                if ok:
                    break
                time.sleep(3)
            if not ok:
                raise Refuse(f"before the update, {cn.describe} does not hold ({d})")
            done.append(d)
        return f"as {who} on {self.k['context']}; {now}; checks green now ({len(done)})"

    # ── snapshot ──
    def snapshot(self) -> str:
        hostio.ensure_dir(self.cfg.snapshots, 0o700)
        d = os.path.join(self.cfg.snapshots, f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{self.comp.id}")
        os.mkdir(d, 0o700)
        self.snap = d
        self.rec.set(snapshot=d)
        hostio.write_json(os.path.join(d, "plan.json"), self.plan)
        shutil.copyfile(os.path.join(self.cfg.repo, self.line.file), os.path.join(d, os.path.basename(self.line.file)))
        os.chmod(os.path.join(d, os.path.basename(self.line.file)), 0o600)
        ns = self.k["namespace"]
        if self.k["kind"] == "helm":
            rel, rev = self.k["release"], str(self.plan["from"]["revision"])
            for what, fn in (("values", "values.yaml"), ("manifest", "manifest.yaml")):
                rc, out, err = run(k8s.helm(self.cfg, "-n", ns, "get", what, rel, "--revision", rev,
                                            *(["-o", "yaml"] if what == "values" else [])), timeout=60)
                if rc != 0:
                    raise StepError(f"helm get {what} {rel}: {tail(err or out, 200)}")
                hostio.atomic_write(os.path.join(d, fn), out)
            hostio.write_json(os.path.join(d, "cluster.json"), {"kind": "helm", "context": self.k["context"],
                                                                "namespace": ns, "release": rel, "revision": int(rev),
                                                                "chart": self.plan["from"]["image"]})
            detail = f"helm get values/manifest of {rel} at revision {rev}"
        else:
            objs = [("daemonset", self.k["name"]), *(("configmap", c) for c in self.k["configMaps"])]
            saved = []
            for kind, name in objs:
                rc, out, err = run(k8s.kubectl(self.cfg, "-n", ns, "get", kind, name, "-o", "yaml"), timeout=30)
                if rc != 0:
                    raise StepError(f"kubectl get {kind} {name}: {tail(err or out, 200)}")
                hostio.atomic_write(os.path.join(d, f"{kind}-{name}.yaml"), out)
                obj = k8s.get_json(self.cfg, "-n", ns, "get", kind, name)
                hostio.write_json(os.path.join(d, f"{kind}-{name}.json"), k8s.clean(obj))
                saved.append(f"{kind}/{name}")
            hostio.write_json(os.path.join(d, "cluster.json"), {"kind": "daemonset", "context": self.k["context"],
                                                                "namespace": ns, "objects": saved})
            detail = f"kubectl get -o yaml of {', '.join(saved)}"
        rx = re.compile(rf"\d{{8}}T\d{{6}}Z-{re.escape(self.comp.id)}")
        mine = sorted(n for n in os.listdir(self.cfg.snapshots) if rx.fullmatch(n))
        for n in mine[:-self.cfg.keep_snapshots]:
            shutil.rmtree(os.path.join(self.cfg.snapshots, n), ignore_errors=True)
        return f"{d}: {detail}"

    # ── apply: the narrow part of scripts/k8s-monitoring.sh ──
    def apply(self) -> str:
        just = hostio.which("just")
        if not just:
            raise StepError("`just` is not on PATH")
        recipe = self.comp.apply.split()[1]
        rc, out, err = run([just, "--justfile", os.path.join(self.cfg.repo, "justfile"),
                            "--working-directory", self.cfg.repo, recipe, self.k["part"]],
                           timeout=self.cfg.cluster_timeout, cwd=self.cfg.repo, env=k8s.env(self.cfg))
        self.ctx.baseline["appliedAt"] = time.time()
        if rc != 0:
            raise StepError(f"`{self.comp.apply} {self.k['part']}` exited {rc}: {tail(err or out, 300)}")
        return f"`{self.comp.apply} {self.k['part']}` done; now {self._state()}"

    # ── verify ──
    def _helm_at(self, version: str, newer_than: int | None) -> tuple[bool, str]:
        r = k8s.helm_release(self.cfg, self.k["namespace"], self.k["release"])
        if not r:
            return False, "the release is gone"
        ok = (r["chart"] == f"{self.k['chart']}-{version}" and r["status"] == "deployed"
              and (newer_than is None or r["revision"] > newer_than))
        return ok, f"{r['chart']} revision {r['revision']} {r['status']}"

    def check(self, phase: str) -> tuple[bool, str]:
        self.ctx.phase = phase
        deadline = time.monotonic() + self.cfg.cluster_verify_timeout
        side = self.plan["to" if phase == "verify" else "from"]
        words = []
        if self.k["kind"] == "helm":
            while True:
                ok, d = self._helm_at(side["tag"], self.plan["from"]["revision"])
                if ok or time.monotonic() > deadline:
                    break
                time.sleep(3)
            if not ok:
                return False, f"helm: {d}"
            words.append(d)
        for cn in self.canaries:
            while True:
                ok, d = cn.check(self.ctx)
                if ok or not cn.retry or time.monotonic() > deadline:
                    break
                time.sleep(5)
            if not ok:
                return False, f"{cn.describe}: {d}"
            words.append(d)
        return True, "; ".join(w[:120] for w in words)

    def verify(self, phase: str) -> str:
        ok, detail = self.check(phase)
        if not ok:
            raise StepError(detail)
        return detail

    # ── rollback ──
    def rollback(self, cause: Exception) -> str:
        self.rec.step("rollback", "running", f"because {cause}")
        ns = self.k["namespace"]
        try:
            if self.k["kind"] == "helm":
                rev = str(self.plan["from"]["revision"])
                rc, out, err = run(k8s.helm(self.cfg, "-n", ns, "rollback", self.k["release"], rev, "--wait",
                                            "--timeout", "5m"), timeout=self.cfg.cluster_timeout)
                if rc != 0:
                    raise StepError(f"helm rollback {self.k['release']} {rev}: {tail(err or out, 300)}")
            else:
                for cm in self.k["configMaps"]:
                    self._replace(os.path.join(self.snap or "", f"configmap-{cm}.json"))
                self._replace(os.path.join(self.snap or "", f"daemonset-{self.k['name']}.json"))
                rc, out, err = run(k8s.kubectl(self.cfg, "-n", ns, "rollout", "status", f"daemonset/{self.k['name']}",
                                               "--timeout=180s"), timeout=240)
                if rc != 0:
                    raise StepError(f"the rollout back did not finish: {tail(err or out, 200)}")
        except (StepError, HostError, OSError) as e:
            self.rec.step("rollback", "failed", str(e))
            return self.rec.finish("failed", f"{cause}; and the rollback failed: {e}", note=self._note(False))["state"]
        self.ctx.baseline["appliedAt"] = time.time()
        pinned = self._write_back()
        ok, detail = self.check("rollback")
        if not ok:
            self.rec.step("rollback", "failed", detail)
            return self.rec.finish("failed", f"{cause}; after the rollback: {detail}", note=self._note(pinned))["state"]
        self.rec.step("rollback", "ok", f"{self.plan['from']['image']} is back: {detail}")
        return self.rec.finish("rolled_back", str(cause), note=self._note(pinned))["state"]

    def _replace(self, path: str) -> None:
        if not os.path.isfile(path):
            raise StepError(f"the snapshot has no {os.path.basename(path)}")
        with open(path, encoding="utf-8") as fh:
            obj = json.load(fh)
        if (obj.get("metadata") or {}).get("namespace") != self.k["namespace"]:
            raise StepError(f"{os.path.basename(path)} is not in namespace {self.k['namespace']} - not applying it")
        rc, out, err = run(k8s.kubectl(self.cfg, "replace", "-f", path), timeout=60)
        if rc != 0:
            raise StepError(f"kubectl replace -f {os.path.basename(path)}: {tail(err or out, 200)}")

    def _write_back(self) -> bool:
        old = self.plan["from"]["tag"] if self.k["kind"] == "helm" else self.plan["from"]["image"]
        new = self.plan["to"]["tag"] if self.k["kind"] == "helm" else self.plan["to"]["image"]
        try:
            pins.write_line(self.cfg.repo, self.line, pins.swap(self.line, new, old))
            return True
        except (HostError, OSError) as e:
            self.rec.audit("rollback", "note", f"the pin line was not written back: {e}")
            return False

    def _note(self, pinned: bool) -> str:
        f = self.line.file
        if not pinned:
            return (f"The cluster was put back, but {f}:{self.line.line} still pins {self.plan['to']['image']} - the "
                    f"next `just k8s-monitoring` would re-apply it. `git diff {f}`, then look before running it.")
        return (f"{f}:{self.line.line} now pins {self.plan['from']['image']} LOCALLY (uncommitted, on purpose) so the "
                f"next `just k8s-monitoring` keeps the version that works; main still pins {self.plan['to']['image']}. "
                f"Find out why it failed, then `git checkout -- {f}` and deploy again. Snapshot: {self.snap}")
