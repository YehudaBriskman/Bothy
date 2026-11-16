# Hybrid runtime: what is on k3s, what stays on Docker

_Added 2026-11-16 after the owner clarified scope. **This file overrides_
`architecture.md` **wherever they disagree** (that file was written assuming "all of
Bothy in the cluster"; the owner's decision is narrower)._

## 1. The decision

- **The install path and Bothy's development effort are k3s-first, for hosts with at
  least 4 GiB RAM** (S0: stock k3s idles at about 650 MiB). **Below 4 GiB the install is
  Compose**, a supported path, not a failure mode. A fresh install on a 4 GiB or larger
  host is k3s plus a small core.
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
| `backups` | **two parts.** k3s CronJob for **k3s state** only; the **host** `backup.sh` and its timer for **Docker data** | a k3s CronJob cannot back up Docker volumes without the socket or host files (review finding); the host unit also survives k3s being down |
| `network` (reach, Access page) | **k3s** | reads and changes how the node is reachable (`vm-lab-and-connectivity.md` B.6); needs `bothy-hostd` for host-side changes |
| `alerts` + dead-man heartbeat | **k3s** | rule 2: tiny, must outlive the rest |
| `metrics-lite` (VictoriaMetrics + kubelet cAdvisor) | **k3s** | small, rules 2 and 4: the budget gate needs numbers |
| `files` | **k3s** (Compose on the Compose install) | **decided 2026-11-16:** `files` is in the smallest mode (D12) and mini needs no Docker, so it cannot be a Docker module. Closes Q12 |
| `sso` (Keycloak + oauth2-proxy) | **Docker** | heavy; JVM; its own Postgres |
| `postgres` | **Docker** | stateful, projects depend on it, already works |
| `logs` (Loki + collector) | **Docker** | heavy, already works |
| `dashboards` (Grafana) | **Docker** | heavy, optional (full only) |
| `k8s-ui` (Headlamp) | Docker, or k3s | tiny either way; follows `sso` |
| `traces` (Tempo) | **Docker** | heavy, optional |
| `remote-cluster` | k3s | a small read-only config, rule 3 |
| projects | **never Bothy's** | rule 3 |

So **on a k3s host, mini = k3s only. It needs no Docker at all.** Docker is installed by
Bothy the first time a Docker-runtime module is enabled, and only then, with the firewall
backend **pinned** at that moment (S10; never switched in place) and the preflight of
`install-and-bootstrap.md` s2 re-run. On a Compose host (under 4 GiB), mini is the same
module set run by Compose; the two runtimes of one mode double the install test matrix
(R14), which is the price of the floor.

## 4. The control problem this creates (and the answer)

If the operator lives in k3s but Keycloak lives in Docker, **something has to start,
stop and update the Docker modules.** The first draft deleted the host updater and
the socket proxies; that no longer works. Options:

| Option | How | Verdict |
|---|---|---|
| **A. Keep the host executor for Docker modules** (the existing spool pattern: a request file, a host unit, fixed argv, re-validation) | `bothy-api` writes a request; a small **`bothy-hostd`** on the host runs allow-listed `docker compose` argv | **Chosen.** Reuses the proven, documented design (`stack/updates.md`); the in-cluster Job handles k3s modules; two executors, one catalog. Request schema and spool hardening are specified in `security-model.md` 6.1 |
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
- **Eviction order across runtimes is a real gap, and it is now measured (S6).** The
  kernel OOM killer picks by `oom_score_adj`, not by Bothy's priorities, and **a
  Docker module's limit, not priority, is what protects the core**:
  - A container that hits **its own** memory limit is the only thing killed; k3s, kubepods
    and docker cgroups saw zero OOM events (PASS).
  - `oom_score_adj` measured: `k3s-server` -999, `dockerd` -500, Docker containers 0,
    **stock k3s pods BestEffort 1000 / Burstable 983**. Under a *global* OOM every
    BestEffort pod (stock Traefik, CoreDNS) **outranks any Docker container**, whatever its
    size. So an unlimited Docker module is not "killed first"; the stock pods are.
  - **Therefore:** every Docker module carries a memory limit, a **positive**
    `oom_score_adj` (500 to 1000) and `restart: unless-stopped` (live-restore is off,
    S5c); Bothy's own k3s core pods are **Guaranteed** (requests = limits, CPU too;
    documented adj -997, **not measured**); the budget gate counts Docker limits so a
    global OOM is never reached by design.
  - **A real global OOM was not survivable in the lab:** an unlimited container allocating
    5 GB on a swapless 4 GiB guest wedged it for 8+ minutes (the oom-killer was invoked
    by `k3s-server`, journald stopped, **the victim was not observed**). INCONCLUSIVE on
    who dies; part of the stall may be the lab's serial console. **Re-measure on a host
    with swap before the go/no-go is final** (`README.md` go/no-go).
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

## 8. Hard rules that came out of the lab (all measured; spike ids in brackets)

1. **No `hostPort`** in any Bothy k3s workload. It never fails `bind()`, silently shadows
   host listeners and Docker ports, and the winning DNAT rule flips after a Docker restart
   [S5b]. Docker ports and k3s service ports come from **one** registry.
2. **Preflight reads three listener views plus both firewall views:** `ss -ltnH`, Docker's
   published ports, and `--dport` in **both** `iptables-save -t nat` **and** `nft list
   ruleset` (Docker's nftables backend hides rules from `iptables-save`) [S5b, S10].
3. **Docker modules:** memory limit, positive `oom_score_adj`, `restart: unless-stopped`
   [S5c, S6]. Without a restart policy a Docker restart leaves a module `Exited` while k3s
   carries on.
4. **Core pods Guaranteed** [S6]; stock BestEffort add-ons are not acceptable in core.
5. **Pin Docker's firewall backend; never switch it in place.** An in-place switch to
   nftables lost container egress until reboot [S10]. Legacy (non-nft) iptables untested.
6. **k3s and Docker coexist:** either daemon can restart without breaking the other, and
   `k3s-killall.sh` and the uninstall script leave Docker's rules identical (314 k3s lines
   removed, 0 added, 29 Docker lines unchanged) [S5c, S9]. "Remove k3s" is a safe rollback.
7. **Mount propagation:** if `findmnt` shows `/` as `private` (it does on WSL), the
   installer adds a oneshot unit `mount --make-rshared /`, ordered before `k3s.service` and
   `docker.service`; Bothy modules avoid `rslave`/`rshared` mounts unless it is present [S11].
   Persistence across a WSL restart is untested.
8. **Not tested, so not claimed:** `wsl --shutdown` recovery, minikube coexistence (the
   10.42/16 and 10.43/16 non-overlap is reasoning only), legacy iptables, the WSL kernel
   running k3s at all (S12 is config-only; S13 is a read-only check), and everything
   needing Tailscale (S1, S7, S8, S14).

## Changed 2026-11-16

- s1: the 4 GiB floor (S0). s3: `backups` split (host plus k3s state), `network` added,
  `files` fixed on k3s (resolves Q12 against D12), Docker install is on demand with a
  pinned firewall backend. s4: hostd chosen. s6: eviction text replaced by S6 measurements;
  the earlier "lower `oom_score_adj` for the k3s cgroup" idea is moot because `k3s-server` is
  already -999; the mitigation that matters is Docker limits plus Guaranteed core.
- s7 table row "Rollback ... Compose already stays" still holds. Section 8 is new.
- ASSUMPTION: that a Guaranteed core pod survives a global OOM ahead of a limited Docker
  module is documented (adj -997), not measured. S6 re-run on a swap-enabled `lab-mid`.
