# Risks, open questions, and alternatives

## 1. Decisions still needed from the owner

| # | Question | Recommendation | Blocks |
|---|---|---|---|
| Q1 | Is Keycloak in mini? **ANSWERED yes-out, 2026-11-16: not in mini or standard.** | **No**; mini has a built-in `login`; `sso` is a module (see `modes-and-modules.md` s3) | #316, #319 |
| Q2 | Is Grafana in standard? **ANSWERED 2026-11-16: no, full only.** | **No**: portal panels first; Grafana is `full` | module catalogue |
| Q3 | Mini memory target | **<= 1.0 GB including k3s**, to be confirmed by S0 | all budgets |
| Q4 | Settings store: SQLite+envelope (A) | **A** (#316) | #317 |
| Q5 | Rewrite git history for privacy (#326) | decide independently; does not block this plan but ships alongside | #315 |
| Q6 | May an operator *reveal* a secret? | **No reveal**; "replace" and "generate" only | #321 |
| Q7 | Port publishing on k3s | Traefik entrypoint-per-port, if S1 passes | architecture s5 |
| Q8 | Does this box migrate first or last? **ANSWERED: last, on a VM first.** | **Last**, after OCI/a scratch VM prove the path (S5) | phase order |
| Q9 | Operator as Job runner now, CRD controller later | **Job runner** | architecture s3 |
| Q10 | Per-user preferences (#145/#157) | give the store a `user:<id>` scope; decide the UX later | customization s6 |

**New questions raised by the hybrid scope:**

| # | Question | Recommendation |
|---|---|---|
| Q11 | Who controls Docker modules from the cluster? | keep a host executor (`bothy-hostd`), see `hybrid-runtime.md` s4 |
| Q12 | Is `files` on k3s or Docker? | decide in Phase 5 from measurements |
| Q13 | Eviction order across two runtimes | `oom_score_adj` protects core; verify in lab (S6) |
| Q14 | Default `--reach` at install | `local`, see `vm-lab-and-connectivity.md` B.8 |

## 2. Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | k3s and Docker conflict on iptables on this WSL box | medium | **high** (live box) | S5 first; fall back to another distro/VM; migrate this box last |
| R2 | k3s idle cost > 0.8 GB, so "mini <= 1 GB" is impossible | medium | high for the thin goal | measure in S0; options: disable servicelb/metrics-server/coredns replacements, a lighter distro (see s3), or restate mini's target honestly |
| R3 | Wizard/budget gate wrong on WSL2 (sees 24 GB, Windows needs its share) | high | medium | S2; reserve derived from MemTotal/MemAvailable and swap |
| R4 | In-cluster updater has too many rights | medium | **high** | namespaced Roles generated from declarations; CI assertions; no `cluster-admin` |
| R5 | `local-path` does not enforce PVC size; a module fills the disk | medium | medium | measure + alert; evaluate a quota-aware provisioner |
| R6 | Two auth paths (`login`, `sso`) drift | medium | high | one adapter, one test matrix |
| R7 | Compose dev and Helm product drift | high without a fix | medium | one declaration, two outputs, parity check (architecture s4) |
| R8 | The migration takes long and stalls half-way | medium | medium | each phase delivers value alone; dual-run; no flag day |
| R9 | ARM breakage for OCI | medium | medium | arm64 CI job; module `arch` field |
| R10 | Scope: this is a re-platform, and the repo is run by one person | **high** | high | phases are independently shippable; stop after any phase and still have a better Bothy (esp. Phase 2/3) |
| R11 | Losing "everything works with `just up`" ergonomics | medium | medium | Compose kept as dev (D1); `just up` unchanged |
| R12 | The portal's own panels are not good enough without Grafana | medium | medium | design item; `dashboards` stays a one-click module |
| R14 | Two runtimes double the executors, CI checks and failure modes | **certain** | medium | one catalog, one module file, one history page; budget the cost in review |
| R15 | Memory pressure kills core before a Docker module (kernel ignores our priorities) | medium | high | `oom_score_adj`, lab spike S6 |
| R16 | An access change locks the owner out of a remote VM | medium | high | apply-with-timer, console path, `bothy access reset` |
| R13 | Master key lost = settings lost | low | high | export bundle, printed key location, fail-closed with message (#317) |

## 3. Alternatives considered (and why not)

| Alternative | Why not |
|---|---|
| **Keep Compose as the product, add a "mini" profile only** | cheapest, and it already works; but it does not meet D3 (Bothy's own stuff in a cluster), gives no per-module quota/priority/eviction, and leaves the two-update-paths problem. Worth remembering as the **fallback if R1/R2 bite**: the module model (Phase 2) delivers most of the "mini/web-enable" value even on Compose. |
| **Lighter Kubernetes: k0s, microk8s, or "k3s with SQLite and minimal flags"** | k3s is what `oci-free` already runs and documents; consistency beats a few tens of MiB. Revisit only if S0 shows R2. |
| **Nomad / plain systemd units** | no ecosystem of charts or RBAC; abandons the `oci-free` investment |
| **A full operator with CRDs now** | right eventually; too much to secure and keep in memory on a 1 GB budget; the Job-runner covers the need |
| **Vault/OpenBao for secrets** | another stateful service with its own unseal problem (#316 weighed it) |
| **Grafana Cloud / hosted observability** | contradicts "for zero dollars, private" |
| **Multi-node/HA** | out of scope (README non-goals) |
| **Migrating projects (Tals etc.) into Bothy's cluster** | violates rule 3; projects keep their own runtime |

## 4. The fallback ladder (if the plan has to retreat)

1. **Full plan:** k3s product runtime, Compose dev.
2. **If R1/R2 bite (accepted by the owner 2026-11-16, D7):** keep Compose as product *and* dev, but ship the **module
   model and settings** (Phases 2-3). Mini/standard/full become Compose profile sets
   chosen from the web; resource budgets become Compose limits plus a gate. Loses
   "in the cluster", keeps "thin and customisable".
3. **Cluster only on OCI:** Bothy-in-k3s ships for the OCI target, while the local box
   stays Compose. The module declaration makes both possible.

## 5. Issues to file once accepted (not filed yet)

| Title | Parent |
|---|---|
| [tracking] Thin Bothy: k3s-native, modes, budgets | #315 |
| [spike] S0-S5 and `measurements.md` | tracking |
| [feature] Module declaration `[runtime.*]` and `[module.cost]` (extends #320) | #320 |
| [feature] `bothy-core` Helm chart and `bothy render` | tracking |
| [feature] Budget gate and `/-/api/budget` | tracking |
| [feature] `login` module and auth adapter | #319 |
| [feature] In-cluster updater (Job, namespaced RBAC) | #312 |
| [feature] Installer: k3s pinned, receipt, uninstall | #100 |
| [docs] SECURITY.md "In-cluster boundary" | tracking |
| [ci] L2 k3d job, arm64 mini job, budget-sum check | tracking |

## 6. Dead ends already visible (so nobody re-opens them)

- **"Just add a mini profile to Compose"** is the fallback in s4, not the plan, for
  the reasons in s3.
- **Putting the updater back on the host to dodge the new trust boundary** (option C
  in `updates-and-rollback.md`) breaks D3 and re-creates the spool machinery.
- **Auto-scaling.** One node, fixed budgets, human-readable plan.
- **A reveal-secret button** as a convenience: refused (Q6).
- **Resurrecting Host() rules** because k8s Ingress makes them easy: the rule
  (notes README #1) stands.
