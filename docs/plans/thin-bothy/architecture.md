# Architecture

## 1. The picture

```
 ┌───────────────────────── one node (WSL2 / Linux VM / OCI A1) ─────────────────────────┐
 │  k3s (single server)                                                                  │
 │   ns bothy-system   (core: always on)        ns bothy-<module> (one per module)       │
 │    traefik            ◀── :80, per-service ports      monitoring: VM, (Loki), (Grafana)│
 │    bothy-web   (SPA, nginx)                           auth:       (Keycloak, oauth2)   │
 │    bothy-api   (ex bothy-ops: discovery, control)     files:      bothy-files          │
 │    bothy-settings (store, schema, renderer)           data:       (Postgres)           │
 │    bothy-operator (applies modules; the updater)      k8s-ui:     (Headlamp-class)     │
 │   ResourceQuota + PriorityClass + NetworkPolicy per namespace                         │
 └────────────────────────────────────────────────────────────────────────────────────────┘
   host: only k3s, the Windows keepalive (WSL), and the installer. No Docker needed for Bothy.
   dev:  Docker Compose still works from the same module declarations.
```

## 2. Core, modules, and what "in the cluster" means

- **Core** is the smallest set that can show a page, hold settings, and apply a
  module. It cannot be disabled. Its namespace is `bothy-system`.
- **A module** is a self-contained unit with: a schema (settings), a chart or
  manifest set, a declared resource cost, dependencies, and a health contract. One
  namespace per module, so quota, network policy and removal are all per module.
- **Bothy's own services run in the cluster** (D3), as ordinary Deployments in
  `bothy-system`, with images built by CI and pinned by digest, like everything else.
  Nothing Bothy needs runs on the host except the installer and k3s itself.

## 3. Packaging: Helm, Kustomize, or an operator?

| Option | For | Against |
|---|---|---|
| **A. Helm charts (one core chart + one per module), rendered by `bothy-operator`** | `oci-free` already pins Helm charts and CI-renders them; values map 1:1 to settings; `helm upgrade --atomic` gives rollback for free; third parties know it | templating logic in YAML; needs the helm binary or SDK in the operator |
| B. Kustomize overlays | no templating language | overlays per mode multiply; a "form field -> patch" mapping is awkward |
| C. A custom operator with CRDs (`Module`, `BothyInstall`) | most declarative; reconciliation loop; status in the API | the largest build, a controller to secure and test, and one more thing in memory |
| D. Raw `kubectl apply` of rendered YAML (what `oci-free` does for its own manifests) | trivial | no rollback, no values, no diffing |

**Recommendation: A now, C-shaped later.** Modules are Helm charts, values are
generated from the settings store, and `bothy-operator` runs `helm upgrade --atomic
--wait` as a short-lived **Job** (not a long-lived controller). That gives
declarative-enough, rollback-able, and cheap-in-memory. If a reconcile loop proves
necessary (drift correction), the Module CRD in option C can be added without
changing the charts, because the CRD would just carry the same values. This keeps
the "operator" as a Job runner until the need is shown, which matters on a 1 GB
budget.

## 4. One declaration, two runtimes

The module file from #320 gains a runtime section; **Compose output and Helm output
are both generated from it**, so dev and product cannot drift:

```toml
[module]
id = "monitoring"
requires = ["core"]
[module.cost]                 # feeds the budget gate, see resource-management.md
memory_request = "300Mi"
memory_limit   = "700Mi"
disk           = "4Gi"
[[field]]  key = "retention_days"  type = "int"  default = 15  min = 1  max = 90
[runtime.helm]    chart = "charts/monitoring"  values_map = { retention = "{{retention_days}}d" }
[runtime.compose] files = ["monitoring/compose.yml"]
```

`bothy render --runtime=helm|compose` consumes it. This is #318 generalised and
is the single most important decision for keeping dev honest: **a module with no
`[runtime.compose]` section simply is not available in dev**, and CI says so.

## 5. Networking and "pure IP:port" (rule 1) on k3s

The repo's access rule is `http://<tailnet-ip>:<port>`, one published port per
browser-facing service, no Host rules. On k3s there are three ways to keep it:

| Option | How | Verdict |
|---|---|---|
| **1. Traefik entrypoints, one per port** | `--entrypoints.web-grafana.address=:3000`, IngressRoute per service with exact `Path()` | closest to today; Traefik is the one listener; **recommended to spike** |
| 2. Services of type LoadBalancer through k3s ServiceLB | one host port each, kube-proxy-free (klipper) | simple; but adds a pod per port (memory) |
| 3. NodePort with the range widened to 1-65535 | `--service-node-port-range` | no extra pods; ugly ports; conflicts with host services |

The rule "A 200 proves nothing about routing" still holds: the portal catch-all
stays at priority 1, and the verify step (rule 7) reads bytes.

**Spike S1 (Phase 0):** prove option 1 works from a *tailnet peer* on WSL2, since
WSL2's own networking (mirrored vs NAT) and the Windows portproxy history are what
bit us before. If it fails, fall back to 3.

## 6. State and storage

- **local-path-provisioner** (bundled) for volumes: node-local, no replication.
  Fine for one node; backups are the safety net, as today.
- **Settings store (SQLite)** lives on a PVC in `bothy-system`. The **master key** is
  a Kubernetes Secret created at install and *excluded* from backups (printing its
  location), exactly as #317 specifies for the file key.
- **Postgres** is a module, not core: Bothy itself needs none (#316 option A).
- **Backups** become a module that runs a CronJob per stateful module (`pg_dump`,
  volume tar, Settings export) to a configured target, with the existing nightly
  rules and the "verify restore" check carried over.

## 7. Where each current piece goes

| Today | In the cluster |
|---|---|
| `edge/` (Traefik compose) | k3s-bundled Traefik, configured by the core chart; dynamic files become IngressRoute/Middleware CRs |
| `apps/bothy-web` | Deployment in `bothy-system` |
| `apps/bothy-ops` | `bothy-api` Deployment; its Docker discovery becomes Kubernetes discovery |
| `apps/bothy-ops/updater/*` + host systemd units | `bothy-operator` Jobs (`updates-and-rollback.md`) |
| `apps/bothy-files` | `files` module |
| `apps/bothy-collector`, `bothy-socket-*` | deleted; replaced by RBAC |
| `auth/` (Keycloak, oauth2-proxy) | `sso` module; mini uses the built-in login |
| `monitoring/` | `monitoring` (+ `logs`, `dashboards`) modules |
| `data/postgres` | `postgres` module |
| `apps/headlamp` | `k8s-ui` module |
| `k8s/monitoring`, `k8s/rbac` | folded into the core/monitoring charts |
| `host/*` systemd, dnsmasq, windows | `host-timers` and `windows-host` modules shrink to what k3s cannot do |

## 8. What does NOT change

Exact-`Path()` routers, the three roles (viewer, operator, admin) and their gates,
"read bytes not status codes", the doc-facts and router-gate checks (re-targeted,
not dropped), pinned-by-digest images, and the rule that **the updater deploys only
what `main` pins**. Each is carried into the new design in the file that owns it.
