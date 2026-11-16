# Footprint and budgets

What Bothy costs today, what each mode should cost, and which numbers are measured
versus guessed. A plan whose premises are wrong is worse than no plan, so every
figure here is labelled **M** (measured), **E** (estimated from general knowledge,
must be measured in Phase 0) or **T** (a target we choose).

## 1. What is running now (M, `docker stats`, 2026-11-16)

This box: 24 GB RAM visible to WSL2, 10 CPUs, 32 containers in total. Only the six
compose projects that **Bothy owns** count here (`auth`, `bothy`, `edge`,
`headlamp`, `monitoring`, `postgres`: 18 containers). The rest are projects
(the maintainer's own projects), which Bothy does not provide.

| Group | Container | Resident | Compose limit |
|---|---|---|---|
| Edge | traefik | 64-85 MiB (varies by sample) | 128m |
| Portal | bothy-web | 8 | 64m |
| | bothy-files | 31 | 256m |
| | bothy-ops | 33 | 96m |
| | bothy-socket-read / -write | 4 + 5 | 32m each |
| Auth | keycloak | 387 | 1g |
| | oauth2-proxy (+ headlamp's) | 9 + 4 | 128m / 64m |
| Data | postgres | 67 | 1g |
| | postgres-exporter | 17 | 128m |
| Metrics | victoriametrics | 169 | 512m |
| | cadvisor | 37 | 128m |
| | node-exporter | 19 | 64m |
| Logs | loki | 151 | 384m |
| | alloy | 160 | 256m |
| Dashboards | **grafana** | **386** | 512m |
| | headlamp | 33 | 256m |
| **Total** | 18 containers | **about 1.6 GB** | |

Three things carry about 78% of it (1253 of 1605 MiB): **Grafana (386), Keycloak (387) and the
logs/metrics trio Loki + Alloy + VictoriaMetrics (480).** Everything that is
*Bothy itself* (web, files, ops, both socket proxies, traefik) is about 170 MiB.

Also measured elsewhere (`docs/plans/all-open-issues.md` §0): cAdvisor was 52% of
the TSDB with ~90% of its series never queried. That is a disk cost, not memory,
and it matters for the thin goal (section 4).

The **sum of the 18 compose limits is 5088 MiB (about 5.0 GiB)**, recomputed from
`docker inspect` on 2026-11-16 (an earlier draft said 5.9 GB; that was wrong). It is
not a budget anyone enforces: each limit is per-container, and nothing stops all of
them being needed at once.

## 2. What k3s adds, and what it removes

**Adds (M, S0, 2026-11-16):** stock k3s v1.37.2 on a 2 GiB Ubuntu 24.04 guest: OS 319 MiB
before, 975 MiB after settling, so a **tax of about 656 MiB** (server RSS 694). Stock pods are
small (Traefik 18, metrics-server 16, CoreDNS 10, local-path 6, svclb 0). Disabling
`metrics-server` and `servicelb` saved only about 27 MiB: **trimming does not change the order
of magnitude.** This is the VM's Ubuntu kernel, not WSL (S12/S13 are config checks only).

**Removes (real, because the cluster provides them):**

| Today | In-cluster replacement | Saves |
|---|---|---|
| `cadvisor` container | the kubelet already serves cAdvisor metrics, **for k3s containers only** (Docker modules stay invisible to it; see `hybrid-runtime.md`) | 37 MiB in mini only |
| `bothy-socket-read/write` | Kubernetes RBAC and a ServiceAccount (see `security-model.md`) | 9 MiB and the most security-critical doc in the repo |
| `bothy-collector` + `kube-auth/` token files | in-cluster ServiceAccount token | a host process and its secrets |
| `headlamp` + its own oauth2-proxy | a module, optional | 37 MiB when off |
| host `bothy-updater` units | an in-cluster Job (see `updates-and-rollback.md`) | host systemd coupling |
| `compose.cluster.yml` overlay | gone: there is only one cluster | a whole code path |

So the honest accounting: **k3s costs more than it removes in the mini install**.
That is the price of D1/D3, and mini's budget must start from it, not hide it.

## 3. Budgets per mode

"Idle resident" is what `free` should show for Bothy's whole footprint (cluster
included), with nothing else running. All of this is **T** until Phase 0 measures
the k3s line.

| Mode | Contains | Idle target (T) | Hard memory budget (T) |
|---|---|---|---|
| **mini** | k3s, Traefik, portal (web), settings store + API, a built-in login, ops/updater | **<= 1.0 GB** | 1.5 GB |
| **standard** | mini + Files + slim monitoring (metrics, logs, a lighter dashboard path) + Postgres-for-Bothy if a module needs it | <= 2.0 GB | 3 GB |
| **full** | standard + Keycloak SSO, Grafana, Headlamp-class k8s UI, the maintainer's remote-cluster module, Tempo | <= 3.5 GB | 5 GB |
| **custom** | any set of modules | the sum, shown **before** you apply | refused if it exceeds the node's budget |

Mini's budget, itemised (M where measured, E otherwise):

| Part | MiB |
|---|---|
| k3s server + containerd + CoreDNS (stock, S0) | about 656 (M) |
| Traefik (64-85 MiB across samples; the cause of the variation is unverified) | 64-85 (M) |
| bothy-web | 8 (M) |
| bothy-ops (becomes the in-cluster API/updater front) | 33 (M) |
| bothy-settings (new, SQLite + crypto) | 40 (E, same class as bothy-ops) |
| headroom for the first apply of any module | 150 |
| **Total** | **about 0.9 - 1.0 GB** (core itself still E) |

The mini target "about 1 GB including k3s" **holds on k3s** (656 measured plus about 170 for
core, without `files` or the first-apply headroom) but with almost no margin, and **adding `files`
to mini (D12, +31 MiB resident) uses the margin up**. The k3s line is now measured (R2
resolved in direction: k3s is not thin in absolute terms; it buys self-healing, atomic
upgrades and resource policy at about 0.65 GiB, and decision S0 draws the line at **4 GiB
hosts**). The same core under Compose is about 0.17 GiB; that is the install below the floor.
The 4 GiB floor is a judgement from one number; confirm with a `lab-std` run once core exists.

## 4. Where the big savings are (thinning monitoring)

Monitoring (grafana, loki, alloy, victoriametrics, cadvisor, node-exporter) is about 0.9 GB of the 1.6 GB (57%) and is the main lever for "thinner".

| Lever | Saves | Trade-off |
|---|---|---|
| Drop the cAdvisor container, scrape the kubelet's | 37 MiB, ~90% of TSDB series | **only valid while no Docker-runtime module is enabled**: the kubelet's cAdvisor sees only k3s containers, so Docker modules need the cadvisor container (or Docker API stats) kept |
| **Grafana is a module, not core.** Mini has none | 386 MiB | no dashboards in mini; the portal shows its own live numbers |
| Replace Alloy (160) with a smaller collector (vmagent, or Alloy with fewer pipelines) | up to ~100 MiB | a migration of the log pipeline |
| Logs: in mini, read `kubectl logs` through the portal; Loki is a standard-mode module | 151 MiB | no search across history in mini |
| VictoriaMetrics single binary, scrape interval 30-60 s, retention by size | disk and ~30% memory | coarser graphs |
| Grafana in standard: cap at 256 MiB, disable unused plugins/features | ~130 MiB | needs a tested config |

None of these is free of design work; each is a row in `resource-management.md`
with a measure-before-and-after rule.

## 5. Disk (not only memory)

Docker here holds 37.5 GB of images (54% reclaimable), 21.6 GB of volumes and
6.8 GB of build cache (M, `docker system df`). Issue #309 already says "which disk
is full". k3s changes the shape (containerd image store, local-path volumes), and
mini should state its disk budget too: **T: <= 6 GB images + 2 GB state for mini**
(to verify). Disk is listed as a first-class budget in `resource-management.md`,
not an afterthought.

## 6. What to do with these numbers

1. Phase 0 produces `docs/plans/thin-bothy/measurements.md` with the k3s idle line
   and a per-pod table on a throwaway cluster, on WSL2 **and** on an OCI-like VM.
2. Every module declares `requests`/`limits` in its TOML (see `modes-and-modules.md`);
   a CI check fails if the sum for a mode exceeds that mode's budget above.
3. The targets in section 3 are edited here, once, when measured, never silently.

## Changed 2026-11-16

- s2 and s3: the k3s line was an estimate (500-700 MiB, E); S0 measured about 656 MiB. The
  4 GiB floor and the Compose install below it are from the S0 decision.
- **Still estimated (E):** every Bothy-owned core figure on k3s (`bothy-settings`, the operator);
  nothing has run under k3s yet. Docker-module limits are counted in the budget but not scheduled.
