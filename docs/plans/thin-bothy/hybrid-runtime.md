# Hybrid runtime: what is on k3s, what stays on Docker

_Added 2026-11-16 after the owner clarified scope. **This file overrides_
`architecture.md` **wherever they disagree** (that file was written assuming "all of
Bothy in the cluster"; the owner's decision is narrower)._

## 1. The decision

- **The install path and Bothy's development effort are k3s-first.** A fresh install
  is k3s plus a small core.
- **Docker Compose stays** for the existing system and for everything that does not
  need to be in the cluster. It is not "dev only": it keeps running things in
  production on a box that has Docker. It is simply not the install target.
- **Only core, "things that need a fallback", and a little more go on k3s.** Not
  everything is moved. Moving less is the point: the thinner Bothy is, the less it
  has to carry.

## 2. The rule for "does this belong on k3s?"

A module goes on **k3s** when it answers *yes* to at least one:

1. It is the **control plane** (edge, portal, API, settings, operator/updater).
2. It must **survive and self-heal** when other things fail (auto-restart,
   priority, atomic upgrade with rollback): the login, backups, the alert
   dead-man's switch.
3. It needs **cluster permissions** (RBAC) rather than host access.
4. It is **small**, so the cluster tax is worth the guarantees.

It stays on **Docker Compose** when:

1. It is **heavy and self-contained** (Keycloak, Grafana, Loki, Postgres).
2. It is **already working** and its move buys nothing.
3. It is a **project's** service (the maintainer's own projects): never Bothy's to move.
4. It needs a host device, host network, or privileged access.

## 3. Placement (revised catalogue)

| Module | Runtime | Why |
|---|---|---|
| `core` (traefik, web, api, settings, operator) | **k3s** | control plane, rule 1 |
| `login` (built-in admin/users) | **k3s** | must work when others are down, rule 2 |
| `backups` | **k3s** (CronJobs) | needs to run even if a module is broken, rule 2 |
| `alerts` + dead-man heartbeat | **k3s** | rule 2: tiny, must outlive the rest |
| `metrics-lite` (VictoriaMetrics + kubelet cAdvisor) | **k3s** | small, rules 2 and 4: the budget gate needs numbers |
| `files` | k3s (optional) or Docker | small; either works, **decided in Phase 5** |
| `sso` (Keycloak + oauth2-proxy) | **Docker** | heavy; JVM; its own Postgres |
| `postgres` | **Docker** | stateful, projects depend on it, already works |
| `logs` (Loki + collector) | **Docker** | heavy, already works |
| `dashboards` (Grafana) | **Docker** | heavy, optional (full only) |
| `k8s-ui` (Headlamp) | Docker, or k3s | tiny either way; follows `sso` |
| `traces` (Tempo) | **Docker** | heavy, optional |
| `remote-cluster` | k3s | a small read-only config, rule 3 |
| projects | **never Bothy's** | rule 3 |

So **mini = k3s only. It needs no Docker at all.** Docker is installed by Bothy the
first time a Docker-runtime module is enabled, and only then. That is thinner than
anything in the first draft.

## 4. The control problem this creates (and the answer)

If the operator lives in k3s but Keycloak lives in Docker, **something has to start,
stop and update the Docker modules.** The first draft deleted the host updater and
the socket proxies; that no longer works. Options:

| Option | How | Verdict |
|---|---|---|
| **A. Keep the host executor for Docker modules** (the existing spool pattern: a request file, a host unit, fixed argv, re-validation) | `bothy-api` writes a request; a small **`bothy-hostd`** on the host runs allow-listed `docker compose` argv | **Recommended.** Reuses the proven, documented design (`stack/updates.md`); the in-cluster Job handles k3s modules; two executors, one catalog |
| B. Restricted Docker socket proxy mounted into a pod | a pod reaches the Docker API through a filtered proxy | the old critical boundary, now crossing a pod; more risk, less reuse |
| C. A privileged pod with the real socket | simplest | root on the host from a web-reachable pod; **rejected** |
| D. Run the Docker modules inside k3s too | no second runtime | exactly what you chose not to do |

**Recommendation: A.** It also means the migration (Phase 4) is much smaller: the
existing updater is *kept* and *split*, not rewritten.

```
 browser ─▶ bothy-api (k3s) ─┬─▶ Job (k3s modules)     helm --atomic, namespaced RBAC
                             └─▶ request file ─▶ bothy-hostd (host) ─▶ fixed-argv docker compose
```

`updates-and-rollback.md` therefore describes **half** of the updater (the k3s half);
the Docker half is today's updater, trimmed to Docker modules. One catalog, one plan
format, one history page, two executors.

## 5. What this does to the other files

| File | Change |
|---|---|
| `footprint-and-budgets.md` | Mini and standard shrink further; Docker modules' memory is **budgeted but not scheduled** (see s6). The k3s cost is paid once, even if the cluster hosts little. |
| `architecture.md` s2, s7 | Read "in the cluster" as "core + k3s-runtime modules". The table of where pieces go is superseded by s3 above. |
| `security-model.md` s1 | The socket proxies **stay** for Docker-runtime modules (read proxy for discovery, `bothy-hostd` for writes). The new RBAC section applies to k3s modules. Both boundaries get CI checks. |
| `modes-and-modules.md` | Each module gains `runtime = "k3s" \| "compose"`. Modes list modules, not runtimes. |
| `resource-management.md` | See s6 below. |
| `migration.md` | Phases 4-5 shrink: only the **k3s-runtime** modules move. Keycloak, Postgres, Loki and Grafana **do not migrate**; they stay exactly where they are. The riskiest steps (auth, Postgres) disappear. |

## 6. Resource management across two runtimes

Kubernetes quotas, priority classes and eviction apply **only to pods**. Docker
modules get `mem_limit`/`cpus`, which is enforcement per container, with **no shared
priority**. So:

- The **budget gate counts both**: `node_allocatable - reserve - k3s requests -
  Docker module limits`. It refuses an enable that would overcommit either way.
- **Eviction order across runtimes is a real gap.** Under memory pressure the kernel
  OOM killer picks by `oom_score_adj`, not by Bothy's priorities. Mitigation: set a
  lower `oom_score_adj` for the k3s cgroup/kubelet (protect core) and a higher one
  for Docker modules (they die first); verify in the lab that **core survives a
  Docker module going over its limit** (spike S6).
- Disk and CPU: same story; the gate shows both runtimes in one table.

## 7. Why this is better than "everything on k3s"

| | All on k3s | Hybrid |
|---|---|---|
| Risk to the live box | high (Keycloak, Postgres migrate) | low (they do not move) |
| Memory floor | k3s + everything in pods | k3s + core only; Docker only when needed |
| Rewrite size | the whole updater, all charts | core charts and the k3s half of the updater |
| Fallback | Compose-only (a retreat) | Compose already stays: **the fallback is built in** |
| Cost | uniform tooling | **two runtimes to understand and test** |

The cost row is the honest one: two runtimes means two executors, two sets of CI
checks and two failure modes. The owner chose this; the plan's job is to keep that
cost visible and bounded (one catalog, one module file, one history page).
