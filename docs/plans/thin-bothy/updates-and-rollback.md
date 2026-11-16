# Updates and rollback, in the cluster

_Revised 2026-11-16 for the hybrid decision: there are **two executors**, a k3s Job
for k3s-runtime modules and the host `bothy-hostd` for Docker-runtime modules
(`hybrid-runtime.md` s4, `security-model.md` 6.1). Sections 1 to 8 describe the
**k3s half**; section 10 states the rest and what changed. The first draft's claim that
the host updater is dropped is withdrawn._

The current updater (`docs/plans/updates.md`, `~/claude-notes/stack/updates.md`) is a
**host executor** fed by a spool file. Its design note says why it "cannot be a
container": `SECURITY.md` forbids a browser-reachable proxy with both `POST=1` and
`CONTAINERS=1`, and updating Traefik or bothy-ops severs the request that asked for
it. In a cluster **both reasons change**, so the updater has to be redesigned, not
ported. What must survive unchanged is its *principle*.

## 1. Principles carried over (non-negotiable)

1. **Deploy only what `main` pins.** One source of truth, no local commits, no
   GitHub credential on the box. In the cluster the pin is the chart's
   image-digest values file at the checked-out revision.
2. **A request, never a string.** The browser asks for a *component id* from a closed
   catalog; the executor recomputes the plan and refuses a stale plan id.
3. **Plan, backup, act, verify, rollback**, in that order, for every risky step
   (#312's standard).
4. **Verify bytes, not status codes** (rule 7).
5. **Dirty pin line = deliberate rollback marker**, not drift (rule 13).

## 2. What changes

| Today | In the cluster |
|---|---|
| Host systemd path unit consumes a spool file | `bothy-api` creates a **`bothy-update` Job** (labelled, one at a time) from a fixed template |
| Executor runs fixed argv on the host as the install user | the Job's container runs `helm`/`kubectl` with a **dedicated ServiceAccount** |
| Updating `bothy-ops` severs its own request | the Job is not `bothy-api`: it keeps running while the API pod is replaced; the page polls the Job's status from a ConfigMap/`status` file the new API reads |
| Compose `up` of one service group | `helm upgrade --atomic --wait --timeout` per module release |
| Rollback = restore the previous pin and `up` | `helm rollback` to the prior revision, plus restore of a pre-update backup when state changed |
| `git pull` on the host | the Job's **git-sync** step: fetch `main`, fast-forward only, re-discover (this is #306, "Sync with main", now a first-class step) |

## 3. The new trust boundary (the part that needs the most care)

The Job needs rights to change workloads. Options:

| Option | Boundary | Verdict |
|---|---|---|
| **A. Per-module Role + the update Job impersonates it** | each update can touch only its module's namespace | best; the operator picks the Role from the catalog |
| B. One `cluster-admin` ServiceAccount for the Job | simple | a compromised Job image owns the cluster; reject |
| C. Keep a host executor, reaching k3s over its kubeconfig | the old boundary (spool) | **rejected for k3s modules**; but the host executor is **required for Docker modules** anyway (`bothy-hostd`), so it is not the new unit this row once said it was |

**Recommendation: A for k3s modules**, with these hard rules, each a CI-checked assertion.
Correction: A says "the Job impersonates the Role". That is the wrong model (the Job runs
as a bound ServiceAccount and Helm needs Secret access in the module namespace); see
`security-model.md` s2.1 and 6.2.
- The Job template is **fixed in the chart**; `bothy-api` fills in only a component
  id and plan id from allow-lists (the same discipline as `grants.py` sweeps today).
- `bothy-api` itself has **no** rights to patch workloads; it may only create
  `Job` objects from the one template in `bothy-system` and read their status.
- The update ServiceAccount's Roles are generated from the module declarations, so
  a module cannot be updated with rights beyond its own namespace.
- The Job's image is **digest-pinned and built by CI**; it does not run user input.
- **A ValidatingAdmissionPolicy enforces the above in the cluster** (pinned image, fixed
  command, allow-listed SA, no Secret mounts), because RBAC cannot constrain what a
  `create` contains. This is a prerequisite for the k3s install, not a later hardening.
- **One update at a time per module** (a lock) and a reaper for releases stuck in
  `pending-upgrade`.
- **The updater's own RBAC and Job template ship as a separate release** from the core
  chart, so a bad core upgrade cannot remove the rights needed to roll it back, and a
  **host-side `bothy rollback`** exists that needs no in-cluster rights at all.

This replaces the socket-proxy sweep with an RBAC sweep (see `security-model.md`).

## 4. Update classes and the nightly job

The `updates.toml` classes (auto vs manual, paused) carry over unchanged in meaning:

- **auto** components (patch bumps with green `upgrade.yml`) are applied by a nightly
  `CronJob` that creates the same `bothy-update` Job; "nothing eligible" is still a
  valid, recorded outcome (`auto.json`).
- **manual** components wait for a click, a plan view, and (for destructive ones) a
  typed confirmation.
- **paused** survive rollback: a rolled-back component is paused so the nightly job
  does not retry it into the same failure.

## 5. Self-update (the circular case)

Updating Bothy's own core is the case that broke earlier designs. The sequence:

1. The Job takes a backup (Settings DB, Helm release history).
2. `helm upgrade --atomic` the core chart. The API pod is replaced; the Job keeps
   running because it is a separate pod.
3. The Job verifies: SPA bytes, API JSON, the router table (rule 2 and 7), settings
   readable, a login works.
4. On failure, `helm rollback`. On success, the Job records the result **to a
   ConfigMap** that the new API serves; the page polls that, so the UI recovers even
   if it was disconnected during the swap.

If the Job itself needs updating, it is updated **last**, by the previous Job
version (a Job never replaces itself), and the chart keeps the previous Job image
digest available for rollback.

## 6. Kubernetes and k3s themselves

k3s is a **component** with its own class, **manual only**, and the riskiest row:

- A k3s minor upgrade is a plan with a backup of the datastore (SQLite is a consistent
  file copy; there is no etcd snapshot), a version-skew check, and a typed confirmation.
  **The host step is primary**: stop k3s, copy the datastore, upgrade, start, verify.
  The system-upgrade-controller is **dropped** (a pod that upgrades its own node, and
  more memory on a node whose k3s tax is already about 650 MiB, S0). The page prints the
  plan and the host command; this is an honest exception to "everything from the web".
- `k3s-killall.sh` and the uninstall script are safe for Docker modules (S9: Docker's
  rules identical after both) but roll back k3s only; they do not restore Bothy state.
- **Version-skew rule (the tailscale lesson, rule 11):** after any k3s change the
  verify step checks the node is `Ready`, the apiserver answers, and DNS resolves
  from a pod. Green status that drops packets must fail verification.

## 7. Postgres and other stateful majors

The existing `pgmajor.py` flow (backup, new volume, restore, switch, keep the old
volume for rollback) is a **module upgrade strategy**, declared in the module:
`strategy = "blue-green-volume"`. Minor/patch updates (#307) use
`strategy = "rolling"` plus the companions that share the pin (the `keycloak-db-init`
recreation becomes a declared `post_upgrade` hook, not a remembered step).

## 8. Rollback, precisely

| Failure | Action | Proof |
|---|---|---|
| Chart fails `--atomic` | automatic Helm rollback | release revision back, workloads ready |
| Verify fails after success | `helm rollback` + restore backup if data changed | verify re-run passes on the old revision |
| Backup missing/unverified | **refuse to start** (no backup, no risky step) | the plan says so |
| Rollback itself fails | stop, keep the Job and logs, raise a critical alert, print the one break-glass command | human takes over; shell is break-glass, not normal |

"Undo later" (#312 s6) keeps the pre-update backup for N days with a one-click
"restore backup from run X".

## 9. What is dropped (k3s modules only)

- For **k3s modules** the host spool and its claimer kinds (`<job>`, `unpause-`, ...)
  become Job objects and ConfigMaps. **The spool itself stays** for Docker modules and
  is hardened (`security-model.md` 6.1).
- For k3s modules the `bothy-updater.*` and `bothy-updates-discover.*` units become
  CronJobs; **they remain for Docker modules** as `bothy-hostd`'s timers.
- For k3s modules the Job mounts a read-only clone in a PVC and fast-forwards it. The
  host checkout remains the source of truth for Docker modules, so **two clones of
  `main` exist**; both must be at the same revision before either executor acts
  (one plan id covers both).

## 10. Caveats the Helm path does not remove, and supply chain

- `helm upgrade --atomic` does **not** revert CRDs, PVC contents or data migrations.
  Each chart declares `migrations = "reversible" | "forward-only"`; a forward-only chart
  takes a **PVC copy first** and refuses to start without room for it.
- **Supply chain:** an `auto` update waits a **72 h cooldown** after a pin lands;
  commits or tags are signed; image signatures are checked where available
  (`security-model.md` 6.3).
- **Day-2 chores the updater must own or at least report:** k3s client-certificate
  rotation, containerd image GC and `DiskPressure` (the kubelet evicts core pods first
  when disk runs out), Helm `--history-max`, audit-log growth, chart bumps.
- **Docker half:** a module without `restart: unless-stopped` stays down after a Docker
  restart (live-restore is off, S5c). The executor's verify step checks restart policy,
  memory limit and `oom_score_adj` (S6) as part of every Docker-module apply.

## Changed 2026-11-16

- Header, section 3 option C, section 9: the host updater is **not** dropped; Docker
  modules need it (hybrid decision).
- Section 3: "impersonates the Role" replaced; admission policy, lock, reaper and a
  separately released updater RBAC added (review findings, **inference not yet run**).
- Section 6: system-upgrade-controller dropped, host step primary (review finding, budget
  reasoning from S0).
- Section 10 is new. The restart-policy check is from S5c; memory limit and
  `oom_score_adj` from S6.
- **ASSUMPTION:** the two-clone consistency in section 9 is a design, never exercised.
  Settled when the first Docker module is applied by `bothy-hostd` on a VM.
