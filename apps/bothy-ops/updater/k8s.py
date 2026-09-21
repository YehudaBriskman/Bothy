"""kubectl and helm for the cluster class (build step 8) - the operator's identity, an explicit context.

SECURITY.md rule 6: bothy-ops' cluster tier holds a namespaced token for two
thales-* namespaces and nothing else. The updater must never borrow it - an
add-on lives in `monitoring` and is installed with cluster-scoped RBAC - and it
must never quietly act on whatever cluster happens to be current. So:

  * every argv names the context (`--context` / `--kube-context`), always -
    `thales-scc` on the box, a throwaway profile's in the end-to-end test;
  * the kubeconfig is the operator's: kubectl's own default (~/.kube/config)
    unless the Config names another file;
  * who that is gets ASKED (`kubectl auth whoami`), and a ServiceAccount - any
    `system:serviceaccount:*` - is refused before a plan exists. bothy-ops'
    token, and any other in-cluster identity, is exactly that.

Nothing here builds a shell string; the argv lists go through hostio.run.
"""

from __future__ import annotations

import json
import os
import re

from .hostio import HostError, run, tail

_NAME = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
_CTX = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.@:-]{0,99}")
REQUEST_TIMEOUT = "15s"


def _ctx(cfg) -> str:
    if not isinstance(cfg.kube_context, str) or not _CTX.fullmatch(cfg.kube_context):
        raise HostError("no usable kube context configured - the updater never uses the current one implicitly")
    return cfg.kube_context


def kubectl(cfg, *args: str) -> list[str]:
    argv = ["kubectl", "--context", _ctx(cfg), f"--request-timeout={REQUEST_TIMEOUT}"]
    if cfg.kubeconfig:
        argv += ["--kubeconfig", cfg.kubeconfig]
    return [*argv, *args]


def helm(cfg, *args: str) -> list[str]:
    argv = ["helm", "--kube-context", _ctx(cfg)]
    if cfg.kubeconfig:
        argv += ["--kubeconfig", cfg.kubeconfig]
    return [*argv, *args]


def env(cfg) -> dict:
    """The environment for `just k8s-monitoring <part>`: the same context and kubeconfig."""
    e = dict(os.environ)
    e["KUBE_CONTEXT"] = _ctx(cfg)
    if cfg.kubeconfig:
        e["KUBECONFIG"] = cfg.kubeconfig
    return e


def get_json(cfg, *args: str, timeout: float = 30) -> dict:
    rc, out, err = run(kubectl(cfg, *args, "-o", "json"), timeout=timeout)
    if rc != 0:
        raise HostError(f"kubectl {' '.join(args)}: {tail(err or out, 200)}")
    try:
        doc = json.loads(out)
    except ValueError:
        raise HostError(f"kubectl {' '.join(args)} answered something that is not JSON") from None
    if not isinstance(doc, dict):
        raise HostError(f"kubectl {' '.join(args)} answered an unexpected shape")
    return doc


def whoami(cfg) -> str:
    """The identity the updater would act as. Refuses a ServiceAccount (rule 6)."""
    doc = get_json(cfg, "auth", "whoami")
    user = ((doc.get("status") or {}).get("userInfo") or {}).get("username")
    if not isinstance(user, str) or not user:
        raise HostError("`kubectl auth whoami` named nobody")
    if user.startswith("system:serviceaccount:"):
        raise HostError(f"the kubeconfig for context {cfg.kube_context} acts as {user}, a ServiceAccount - the "
                        "updater acts only as the operator (never bothy-ops' namespaced token, SECURITY.md rule 6)")
    return user


def helm_release(cfg, namespace: str, name: str) -> dict | None:
    """{revision, chart, status, appVersion} of an installed release, or None."""
    if not (_NAME.fullmatch(namespace) and _NAME.fullmatch(name)):
        raise HostError("a release names an unusable namespace or name")
    # No -a: helm 4 lists every status by default and dropped the flag.
    rc, out, err = run(helm(cfg, "-n", namespace, "list", "-o", "json", "--filter", f"^{re.escape(name)}$"),
                       timeout=30)
    if rc != 0:
        raise HostError(f"helm list: {tail(err or out, 200)}")
    try:
        rows = json.loads(out or "[]")
    except ValueError:
        raise HostError("helm list answered something that is not JSON") from None
    for r in rows if isinstance(rows, list) else []:
        if isinstance(r, dict) and r.get("name") == name:
            try:
                rev = int(r.get("revision"))
            except (TypeError, ValueError):
                raise HostError(f"helm names no revision for {name}") from None
            return {"revision": rev, "chart": str(r.get("chart") or ""), "status": str(r.get("status") or ""),
                    "appVersion": r.get("app_version")}
    return None


def container_image(pod_spec: dict, name: str) -> str | None:
    for c in pod_spec.get("containers") or []:
        if isinstance(c, dict) and c.get("name") == name:
            return c.get("image")
    return None


def ds_rolled_out(ds: dict) -> tuple[bool, str]:
    """A DaemonSet whose every scheduled pod is the current template and ready."""
    meta, st = ds.get("metadata") or {}, ds.get("status") or {}
    want = st.get("desiredNumberScheduled")
    fields = {k: st.get(k) for k in ("updatedNumberScheduled", "numberReady", "numberAvailable")}
    words = (f"generation {meta.get('generation')} observed {st.get('observedGeneration')}, desired {want}, "
             f"updated {fields['updatedNumberScheduled']}, ready {fields['numberReady']}, "
             f"available {fields['numberAvailable']}")
    ok = (isinstance(want, int) and want > 0 and st.get("observedGeneration") == meta.get("generation")
          and all(v == want for v in fields.values()) and not st.get("numberUnavailable"))
    return ok, words


def clean(obj: dict) -> dict:
    """A `kubectl get -o json` object made re-appliable with `kubectl replace`:
    no status, no server-set identity (uid, resourceVersion - an unconditional
    replace), no managedFields. What the object SAYS is kept exactly."""
    o = json.loads(json.dumps(obj))
    o.pop("status", None)
    m = o.get("metadata") or {}
    for k in ("uid", "resourceVersion", "creationTimestamp", "generation", "managedFields", "selfLink"):
        m.pop(k, None)
    return o
