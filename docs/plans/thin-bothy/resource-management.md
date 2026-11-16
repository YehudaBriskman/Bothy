# Resource management

_Scope (hybrid decision, `hybrid-runtime.md` s6): Kubernetes quotas, priority and eviction
govern **k3s pods only**. Docker modules get a memory limit and an `oom_score_adj` and
nothing more, so the cross-runtime gate below is **advisory for the Docker half**._

"As good as possible" means three things: **every workload declares what it needs,
the platform enforces it, and the operator sees it before and after.** Today the
sum of compose limits (5088 MiB) is a set of unrelated ceilings. This plan makes
it a budget.

## 1. The model

| Layer | Mechanism | Purpose |
|---|---|---|
| Declare | `[module.cost]` in each module (requests, limits, disk) | the source of truth for budgeting |
| Enforce per pod | `resources.requests/limits` set from the declaration | scheduling and OOM boundaries |
| Enforce per module | `ResourceQuota` + `LimitRange` in the module namespace | one module cannot starve another |
| Order under pressure | `PriorityClass`: `bothy-core` > `bothy-module` > `bothy-batch` | kubelet eviction and scheduling order for pods. **It does not affect the kernel OOM killer** (S6) |
| Gate | the **budget gate** in the operator | refuse a k3s apply that would overcommit; **warn** (advisory) for Docker modules, which it can only count by declared limit plus a periodic `docker stats` sample |
| Observe | requests vs actual, per module, in the portal | find lies in declarations |

## 2. Requests, limits and QoS: the rules

- **Memory:** `request` = the measured p95, `limit` = measured peak plus margin.
  Memory is incompressible, so a limit means an OOM kill; set it from data, not hope.
  The existing notes already do this for compose (cadvisor "p95 46 / peak 54 MiB ->
  128m"); the same table feeds the chart.
- **CPU:** set `requests` (so the scheduler can place). Non-core latency-sensitive
  modules get **no CPU limit** (throttling hurts more than it protects); `batch` jobs
  (backups, discovery, the updater) get one. A single node has no noisy neighbour except
  itself.
- **Core is `Guaranteed`, exactly:** Kubernetes grants that class only when **requests
  equal limits for CPU and memory** on every container. So core *does* carry a CPU limit,
  set generously from the measured p99 so throttling does not bite (this resolves the
  earlier conflict between "no CPU limits" and "Guaranteed-ish"). Why it matters (S6):
  stock k3s add-ons are BestEffort or Burstable with `oom_score_adj` 1000/983 and rank
  ahead of any Docker container in a global OOM; a Guaranteed pod's documented adj is
  -997 (**not measured here**). Eviction ranks by **usage over requests**, so a core pod
  that stays within its requests is evicted last.
- **Docker modules:** `mem_limit` (hard, required), a positive `oom_score_adj`
  (500 to 1000) and `restart: unless-stopped` (S5c, S6). Declared in the module file and
  checked by CI against the compose artifact.
- **Ephemeral storage** requests/limits on log-heavy pods, so a runaway log cannot
  fill the node's disk (the failure #309 is about).

## 3. The budget gate

Before any apply (enable, resize, upgrade), `bothy-operator` computes:

```
node_allocatable_memory
 - system_reserve              (kube + OS; default 1.0 GB, configurable)
 - sum(requests of everything running)
 = free_budget
```

and refuses if `sum(new module requests) > free_budget`, showing the arithmetic. A
second, softer check compares **limits**: if the sum of limits exceeds allocatable by
more than a configured overcommit ratio (default 1.5x), it warns and requires a typed
confirmation. The `system_reserve` is what keeps a 24 GB WSL2 host (shared with
Windows and other projects) honest: **WSL2 sees 24 GB but Windows needs its own**, so
the reserve is computed from `MemTotal`, `MemAvailable` and the root cgroup limit (on this box `free` already shows the 24 GB cap), with `.wslconfig` only as an optional cross-check. **Swap counts**: it is already 6143/6144 MB used here, so the gate treats high swap use as pressure.
The default reserve of 1.0 GB is consistent with S0 (OS 319 MiB plus k3s tax about 656 MiB is
975 MiB), so it is the **floor**, not slack. **Idle memory is measured as cgroup working set or
PSS, not `free`.**

**Swapless hosts:** a global OOM on a swapless 4 GiB guest wedged it for 8+ minutes (S6,
victim unobserved). The preflight therefore **refuses a swapless host under 4 GiB**, and the
gate counts every Docker module's limit so a global OOM is never reached on purpose.
Whether a host with swap degrades more gracefully is **ASSUMPTION; S6 re-run with swap settles it**.

**WSL2 specifics (spike S2):** the cluster's "allocatable" must follow WSL2's memory
cap, read from the kernel (not from `.wslconfig`, which may not exist or be readable). kubelet `--system-reserved` and `--eviction-hard` are set from the **same number** the gate uses, because allocatable has no reserve by default and Docker's memory is invisible to the scheduler. The Windows-side keepalive remains the only thing outside the cluster.

## 4. Eviction order, stated

Kubelet eviction goes by QoS then priority. With the three priority classes:

1. `bothy-batch` (backups, discovery, updater Jobs) are evicted/delayed first.
2. `bothy-module` (k3s modules such as metrics), lowest-value first via per-module `priority`.
3. `bothy-core` is protected by Guaranteed QoS and usage-over-requests ranking.

This is the **kubelet's** order and covers pods only. **Docker modules are outside it**: they
are protected from the core, and the core from them, only by their own memory limit and
`oom_score_adj` (`hybrid-runtime.md` s6). Priority classes do not change who the kernel
kills.

The portal shows this order ("if memory runs out, Loki stops first") so surprise
is not part of the experience.

## 5. Slimming the heavy modules (each is a measured change, not a hope)

Rule: **a change that claims a saving must show before/after for the same load**,
recorded in `measurements.md`, or it is not merged. Candidates, in order of value:

| # | Change | Expected | Verify |
|---|---|---|---|
| 1 | Use the kubelet's cAdvisor; drop the container. **Only in mini**: the kubelet sees k3s containers only, so once any Docker module is enabled the cAdvisor container stays | -37 MiB, -90% series | series count, dashboards still fed |
| 2 | Grafana a module, capped 256 MiB, no unused plugins, provisioned only | -130 MiB when on, -386 when off | RSS over 24 h |
| 3 | Loki: single binary, filesystem store, 3-7 d retention by size, a small ingester | -50 to -100 MiB | ingest and query a fixture |
| 4 | Collector: Alloy trimmed to one pipeline or swap for vmagent/Vector | up to -100 MiB | logs and series parity check |
| 5 | VM: 30-60 s scrape, `-retentionPeriod` plus disk ceiling | disk, ~-30% mem | `vm_*` series, p95 query time |
| 6 | Traefik: access logs sampled, fewer entrypoints | small | RSS |
| 7 | Keycloak: only in `sso`; JVM flags (`-XX:MaxRAMPercentage`, heap caps), `--optimized` build | -100 to -200 MiB when on | startup, login benchmark |

## 6. Disk is a budget too

- `ResourceQuota` on `requests.ephemeral-storage` and per-PVC sizes in the module
  declaration. **Disk budgets are advisory**: `local-path` does not enforce PVC size, so the
  operator measures usage and shows "using 3.1 / 4 Gi" (a hard limit needs a quota-aware
  provisioner or a loop-mounted volume: an open question, R5). The k3s data directory must be
  on ext4, xfs or btrfs, never `9p`, `drvfs` or similar (S13).
- Retention is expressed in **days and bytes**; whichever hits first wins (the
  Prometheus `retention.size` idea the repo already missed when moving to VM).
- Image garbage: k3s has a kubelet image GC with thresholds; the portal's disk page
  (#309) must show *which disk* and offer the safe clean-ups: containerd image prune,
  unused PVC list, build cache (dev only).

## 7. Observability of the budget itself

`bothy-api` exposes `/-/api/budget`: per module, `requests`, `limits`, `p95`, `peak`,
`restarts`, `oom_kills`, and the disk used/declared. The portal's "Resources" page
renders it; alerts fire on **declaration drift** (p95 > 1.3x request for 24 h: "raise
it or fix the leak") and on OOM kills, so the numbers in the module files stay true.

## 8. Anti-patterns refused

- A limit with no measurement behind it.
- A module with `limits` and no `requests` (it would schedule as BestEffort-ish).
- A module that ships `hostPath` or `privileged` without a documented reason in its
  declaration, because those bypass the budget and the sandbox.
- Auto-scaling (VPA/HPA). One node, fixed budgets, a human-readable plan.

## Changed 2026-11-16

- Header, gate row and s4: priority classes do not affect the kernel OOM killer, and the
  gate is advisory for Docker modules (S6; hybrid decision). Docker-module requirements
  (limit, positive `oom_score_adj`, restart policy) added (S5c, S6).
- s2: "Guaranteed-ish" and "no CPU limits for core" contradicted each other; core is
  Guaranteed with CPU limits, other modules keep no CPU limit (Kubernetes QoS rule).
- s3: reserve reconciled with S0; swapless-under-4-GiB refusal added (S6). **INCONCLUSIVE:**
  who the kernel kills in a real global OOM, and whether swap helps.
- s5 row 1 limited to mini (review finding); s6 disk budgets are advisory (review finding).
