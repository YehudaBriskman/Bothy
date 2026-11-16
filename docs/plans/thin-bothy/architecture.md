# Architecture

_**Superseded by `hybrid-runtime.md` where they disagree** (it says so too). Read every
"in the cluster" below as "core + k3s-runtime modules"; Docker-runtime modules stay on
Docker. This file's diagram and s7 were corrected 2026-11-16 (see the end)._

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
   host: k3s, `bothy-hostd` (the executor for Docker modules), the Windows keepalive (WSL),
         and the installer. Docker is installed only when a Docker-runtime module is enabled.
   Compose: the install path below 4 GiB RAM (S0) and the home of the Docker modules.
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

The module file from #320 gains a runtime section. **The declaration holds metadata**
(cost, fields, requires, health, `runtime`); **each runtime artifact (chart or compose
file) is hand-written and CI-validated against it**, not generated. "One declaration
generates both" was over-promised: a generator for arbitrary charts is a project of its
own. What is generated is the settings form, the budget row, the health check and the
**validation** that the chart or compose file honours the declared cost and ports:

```toml
[module]
id = "monitoring"
requires = ["core"]
[module.cost]                 # feeds the budget gate, see resource-management.md
memory_request = "300Mi"
memory_limit   = "700Mi"
disk           = "4Gi"
[[field]]  key = "retention_days"  type = "int"  default = 15  min = 1  max = 90
[runtime]  kind = "k3s"        # or "compose"; exactly one primary runtime per module
[runtime.helm]    chart = "charts/monitoring"  values_map = { retention = "{{retention_days}}d" }
[runtime.compose] files = ["monitoring/compose.yml"]
```

`bothy render` turns settings into **Helm values or compose env** (#318). CI renders each
artifact and fails when it drifts from the declaration (limits, ports, `restart` policy,
`oom_score_adj`, memory limit for Docker modules). A module declares its **runtime**
(`k3s` or `compose`, `hybrid-runtime.md` s3); a module with only one artifact is
available only in that runtime, and the wizard says so.

## 5. Networking and "pure IP:port" (rule 1) on k3s

The repo's access rule is `http://<tailnet-ip>:<port>`, one published port per
browser-facing service, no Host rules. On k3s there are three ways to keep it:

| Option | How | Verdict |
|---|---|---|
| **1. Traefik entrypoints, one per port** | `--entrypoints.web-grafana.address=:3000`, IngressRoute per service with exact `Path()` | closest to today; Traefik is the one listener; **recommended to spike** |
| **2. Services of type LoadBalancer through k3s ServiceLB** | one host port each (klipper) | simple; but one DaemonSet pod per **Service** (not per port), and **ASSUMPTION (K, not checked): its svclb pods publish via `hostPort`**, which this plan now forbids (S5b); check before choosing it |
| 3. NodePort with the range widened to 1-65535 | `--service-node-port-range` | no extra pods; ugly ports; conflicts with host services; a NodePort is a kube-proxy DNAT, so it probably has the same silent-shadow property as hostPort (reasoning from S5b, **not run**) |

The rule "A 200 proves nothing about routing" still holds: the portal catch-all
stays at priority 1, and the verify step (rule 7) reads bytes.

**Spike S1 (Phase 0):** prove option 1 works from a *tailnet peer* on WSL2, since
WSL2's own networking (mirrored vs NAT) and the Windows portproxy history are what
bit us before. If it fails, fall back to 3. **S1 has not been run** (needs Tailscale in
the lab, like S7, S8, S14).

**Measured constraint (S5b): Bothy's k3s modules never use `hostPort`.** A hostPort never
fails `bind()`, adds a second DNAT rule, and which rule wins depends on the packet path
and on which daemon last touched the chain (the order flipped after `systemctl restart
docker`); it also silently shadows a plain host listener. So the edge is published one of
two ways, both to be settled in the lab (S1/S8): **(a) Traefik with `hostNetwork`**,
where a clash is a real `bind()` error (loud, the property we want), at the cost of a
named `hostNetwork` exemption from the restricted baseline for that one pod; or **(b)** a
`LoadBalancer`/NodePort Service on a port preflight has proven free, which keeps pods
unprivileged but keeps DNAT's silent-shadow property. **Current lean: (a) with
`--disable servicelb`** (S0 measured servicelb off, with metrics-server, at about 27 MiB
saved). ASSUMPTION; S1/S8 settle it.

### 5.1 Packaging facts for k3s's Traefik (K, from k3s docs, unverified in the lab)

- k3s's Traefik is a packaged `HelmChart`: configure it with a `HelmChartConfig` in
  `kube-system`, **or** start k3s with `--disable traefik` and run our own pinned release.
  Pinning by digest (our rule) points to the second.
- Cross-namespace middlewares need `allowCrossNamespace` or a per-namespace copy (as
  `oci-free` does).
- Stock Traefik and CoreDNS are **BestEffort** (`oom_score_adj` 1000, S6) and rank ahead
  of Docker containers in a global OOM: our own release must be Guaranteed, and CoreDNS
  needs requests = limits set through its chart values.

### 5.2 Edge: who owns `:80` and how a Docker service is reached

**Proposal (not yet built or measured):**

- **k3s Traefik owns `:80`** on a k3s-installed host. It routes only core routes
  (the portal catch-all at priority 1, `/-/api/*` exact `Path()`s). There is **one**
  Traefik on the host in this mode.
- **Docker modules publish their own host ports** (rule 1, pure IP:port) and are **not
  proxied through the cluster edge** by default. Each is allocated from the **same port
  registry** as k3s service ports (S5b), so no two collide. A Docker service that needs
  Bothy's login keeps a forward-auth or oauth2-proxy in front of its own port.
- A k3s router that must reach a Docker backend uses the host's address for the backend
  (a Service without selector plus an Endpoints object); never a bare compose name (rule 8).
- The **live box keeps its Docker Traefik on `:80`** until it migrates last (D6); two
  Traefiks on one host is a Phase-5 cut-over question, not a steady state.
- **Which gate protects a Docker service:** the existing SSO boundary and
  `router-gates.sh` keep applying to Docker modules; the k3s role middlewares cover k3s
  routes. A route table that spans both is read through the portal, not Traefik's
  dashboard (notes rule 2).

### 5.3 Discovery

The **module catalog is the truth**; discovery is two adapters behind one interface:
Kubernetes (RBAC read) and Docker (the read proxy, via `bothy-hostd`'s side). A pod never
gets a hostNetwork or hostPath proxy that exposes `docker inspect` environment values.

### 5.4 State ownership

| State | Owner | Where |
|---|---|---|
| Settings and secrets (non-secret rows, wrapped DEKs) | `bothy-settings` | SQLite on a PVC (k3s) or a host dir (Compose), on ext4 (S13) |
| Master key (KEK) | the installer, root | **a host file outside the datastore** (`settings-store.md` s9) |
| Update history and plans | the updater (Job and `bothy-hostd`) | one history, written through one API |
| Module declarations | the repo (built in) and `modules.d/` (user) | files |
| Backups | host backup scripts (Docker data), host-side k3s-state backup | off-node target required (`install-and-bootstrap.md` s9) |

## 6. State and storage

- **local-path-provisioner** (bundled) for volumes: node-local, no replication.
  Fine for one node; backups are the safety net, as today.
- **Settings store (SQLite)** lives on a PVC in `bothy-system`, on **ext4** (S13;
  never `/mnt/c` or another 9p-class mount). The **master key** is a **host file outside
  the datastore**, root-owned (corrected 2026-11-16: a cluster Secret cannot be "excluded
  from backups"); the settings pod gets a projected copy only once the admission policy
  is enforced (`settings-store.md` s9.2, Q4; `security-model.md` 6.2).
- **Postgres** is a module, not core: Bothy itself needs none (#316 option A).
- **Backups:** a k3s CronJob cannot back up **Docker** data (it would need the socket,
  the volumes or host files). Docker data keeps the host `backup.sh` and its timer; the
  k3s module backs up **k3s state** only. See `hybrid-runtime.md` s3 and
  `install-and-bootstrap.md` s9.

## 7. Where each current piece goes

| Today | In the cluster |
|---|---|
| `edge/` (Traefik compose) | k3s-bundled Traefik, configured by the core chart; dynamic files become IngressRoute/Middleware CRs |
| `apps/bothy-web` | Deployment in `bothy-system` |
| `apps/bothy-ops` | `bothy-api` Deployment; its Docker discovery becomes Kubernetes discovery |
| `apps/bothy-ops/updater/*` + host systemd units | `bothy-operator` Jobs (`updates-and-rollback.md`) |
| `apps/bothy-files` | `files` module |
| `apps/bothy-collector`, `bothy-socket-*` | the k3s core uses RBAC; **the socket proxies stay for Docker modules** (`security-model.md` s1) |
| `auth/` (Keycloak, oauth2-proxy) | `sso` module, **Docker runtime**; mini uses the built-in login |
| `monitoring/` | `metrics` on k3s; `logs` and `dashboards` **stay on Docker** |
| `data/postgres` | `postgres` module, **Docker runtime** |
| `apps/headlamp` | `k8s-ui` module |
| `k8s/monitoring`, `k8s/rbac` | folded into the core/monitoring charts |
| `host/*` systemd, dnsmasq, windows | `host-timers` and `windows-host` modules shrink to what k3s cannot do |

## 8. What does NOT change

Exact-`Path()` routers, the three roles (viewer, editor, operator) and their gates,
"read bytes not status codes", the doc-facts and router-gate checks (re-targeted,
not dropped), pinned-by-digest images, and the rule that **the updater deploys only
what `main` pins**. Each is carried into the new design in the file that owns it.

## Changed 2026-11-16

- Diagram footer and s7: "No Docker needed" and "deleted; replaced by RBAC" contradicted
  `hybrid-runtime.md`; Docker is installed on demand and the socket proxies stay for it.
- s4: the declaration holds metadata, artifacts are hand-written and validated (review
  finding); `runtime` added to the module file.
- s5: hostPort forbidden (S5b); ServiceLB's use of hostPort is an **ASSUMPTION** (K);
  5.1 to 5.4 (edge, discovery, state ownership) are proposals, none built; **S1/S8** settle
  the publishing choice. The master key is a host file (s6), per `settings-store.md`.
