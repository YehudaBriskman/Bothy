#!/usr/bin/env python3
"""bothy-ops - everything in Bothy that acts on something RUNNING.

    POST /control/{restart,stop,start}      containers   control.py
    *    /kube/<catalog id>                  workloads    kube.py
    GET  /admin/{users,credentials,backups,audit}  Settings reads  admin.py
    GET  /updates/status                     Settings > Updates   updates.py
    GET  /healthz                            local only, no edge route

Until 2026-09 these were two services, bothy-control and bothy-kube, each with
its own copy of the server, the CSRF gate and the audit writer. They are one
process now because they are one KIND of power - "act on what is running",
gated by the `operator` role at the edge for every change - and two containers
bought nothing but two of everything. What did NOT merge is what the separation
was actually for:

  * the socket proxies stay split, read from write, and this process still
    holds no docker socket (apps/bothy/compose.socket-proxy.yml);
  * the cluster credential is still a namespaced ServiceAccount token that can
    neither exec nor read a secret (k8s/rbac/bothy-kube.yaml);
  * every route is still one exact Path() with its own role gate
    (edge/dynamic/bothy-ops.yml).

── networks: one way in, two ways out ───────────────────────────────────────

  opsnet          traefik + bothy-ops, nothing else. The ONLY way in. This
                  process authenticates nobody, so reachability IS authorisation.
  controlsocknet  bothy-ops + bothy-socket-read + bothy-socket-write. Out, to
                  the daemon. Traefik is NOT on it.
  thales-scc      minikube's network, joined only by compose.cluster.yml when it
                  exists. Out, to the apiserver. Traefik is NOT on it.

── no third-party dependencies ──────────────────────────────────────────────

Standard library plus bothy_common, which is standard library too. This process
holds a path to the Docker daemon and a token that acts on cluster workloads;
every dependency is something that can ship a vulnerability into that position.
"""

from __future__ import annotations

import os
import sys
import tomllib

try:
    import bothy_common  # noqa: F401  (in the image it sits beside this file)
except ImportError:  # a checkout: apps/bothy-common is the package's parent
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    os.pardir, "bothy-common"))

import admin  # noqa: E402
import control  # noqa: E402
import guard  # noqa: E402
import kube  # noqa: E402
import updates  # noqa: E402
from bothy_common.http import JsonHandler, serve  # noqa: E402

PORT = int(os.environ.get("PORT", "8097"))


class Handler(JsonHandler):
    server_version = "bothy-ops"
    cache_control = "no-store"

    def do_GET(self) -> None:  # noqa: N802
        route = self.route
        if route == "/healthz":
            # No route at the edge for this: it is reached by the container's own
            # HEALTHCHECK on 127.0.0.1, and publishing it would put the verb
            # list, the deny list and the namespace scope on the tailnet.
            return self._send(200, {"ok": True, "verbs": list(guard.VERBS),
                                    "severing": sorted(guard.SEVERING),
                                    **kube.health()})
        if route == "/kube/catalog":
            # What the UI draws its cluster controls from: static data out of the
            # image, the same bytes whatever the cluster is doing - so it answers
            # with no token and no apiserver. CSRF-checked like every other read.
            try:
                self.check_csrf("GET")
            except guard.Refused as e:
                return self._send(e.status, {"error": str(e)})
            return self._send(200, kube.catalog_doc())
        if route.startswith("/kube/"):
            return kube.handle(self, "GET", route[len("/kube/"):])
        if route.startswith("/admin/"):
            return admin.handle(self, route[len("/admin/"):])
        if route == "/updates/status":
            return updates.handle(self)
        return self._send(404, {"error": "no such endpoint"})

    def do_POST(self) -> None:  # noqa: N802
        route = self.route
        if route.startswith("/control/"):
            return control.handle(self, route[len("/control/"):])
        if route.startswith("/kube/"):
            return kube.handle(self, "POST", route[len("/kube/"):])
        return self._send(404, {"error": "no such endpoint"})


def main() -> None:
    try:
        kube.CATALOG = kube.load()
        # The update catalog too: a typo in updates.toml is a defect in what was
        # reviewed and built, not a request-time 500 (updates.load_catalog).
        updates.CATALOG = updates.load()
    except (guard.CatalogError, updates.CatalogError, OSError, tomllib.TOMLDecodeError) as e:
        # Refuse to start. A service that ran with half a catalog would be a
        # service whose surface nobody reviewed. (A missing CLUSTER is not this -
        # that is a 503 per request; a malformed CATALOG is a code defect.)
        sys.stderr.write(f"bothy-ops REFUSES TO START: {e}\n")
        sys.exit(2)
    serve(PORT, Handler,
          f"bothy-ops on :{PORT} - verbs {list(guard.VERBS)} via read {control.DOCKER_READ} "
          f"/ write {control.DOCKER_WRITE}; kube actions {sorted(kube.CATALOG)} on "
          f"{list(guard.NAMESPACES)} via {kube.KUBE_API}; {len(updates.CATALOG.components)} update components")


if __name__ == "__main__":
    main()
