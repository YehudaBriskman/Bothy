# Updates and rollback, in the cluster

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
| C. Keep a host executor, reaching k3s over its kubeconfig | the old boundary (spool) | works, but reintroduces a host unit and breaks D3 ("not external") |

**Recommendation: A**, with these hard rules, each a CI-checked assertion:
- The Job template is **fixed in the chart**; `bothy-api` fills in only a component
  id and plan id from allow-lists (the same discipline as `grants.py` sweeps today).
- `bothy-api` itself has **no** rights to patch workloads; it may only create
  `Job` objects from the one template in `bothy-system` and read their status.
- The update ServiceAccount's Roles are generated from the module declarations, so
  a module cannot be updated with rights beyond its own namespace.
- The Job's image is **digest-pinned and built by CI**; it does not run user input.

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

- A k3s minor upgrade is a plan with a backup of the datastore (SQLite snapshot),
  a version-skew check, and a typed confirmation. The updater runs it with k3s's
  system-upgrade-controller **only if** that is shown to fit the budget; otherwise
  it is a documented host step with a plan the page prints (honest about the
  exception to "everything from the web").
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

## 9. What is explicitly dropped

- The host spool directory and the four claimer kinds (`<job>`, `unpause-`, ...):
  their jobs become Job objects and ConfigMaps, which Kubernetes already persists.
- The system units `bothy-updater.*`, `bothy-updates-discover.*`: replaced by
  CronJobs.
- Detecting the box's checkout from the host: the Job mounts a read-only clone in a
  PVC and fast-forwards it.
