# Plan: Thin Bothy - a k3s-native, modular, budgeted Bothy

_Written 2026-11-16. Status: **reconciled with the owner's decisions and the first lab measurements** (design only; the VM lab and the settings library are the only things built). **Read `review-findings.md` first (seven reviews), then the go/no-go section below.** Extends
the "Bothy for anyone" epic (#315) and the "operable from the web" epic (#312)._

## The goal in one paragraph

Bothy installs as a **small default** (the *mini* mode) that runs **inside a
k3s cluster it installs itself**, the way `oci-free` runs a whole platform in one
k3s node. From the web, an operator then turns on more: *standard*, *full*, or
individual modules, each with a **declared resource cost** that the platform
**enforces**. Everything Bothy itself needs (portal, files, updater, settings,
auth, edge) runs *in* the cluster, not beside it. Docker Compose stays, but only
as the **development** runtime. The result is thinner, budgeted, and much more
customisable than today's "everything on, edit `.env`".

## Decisions already made (by the owner, 2026-11-16)

| # | Decision |
|---|---|
| D1 | **The install path and our development effort are k3s-first, for hosts with at least 4 GiB RAM (S0).** Docker Compose stays: for the existing system, for everything that does not need the cluster, **and as the supported install below 4 GiB** (it is *not* dev-only). **Refined 2026-11-16, see `hybrid-runtime.md`, which overrides `architecture.md`.** |
| D2 | Mini-by-default on first install; bigger installs are chosen **from the web**. Mini is k3s only and needs no Docker. |
| D3 | **Only core, the things that need a fallback, and "a little more" run on k3s.** Heavy or already-working modules (Keycloak, Grafana, Loki, Postgres) stay on Docker and do not migrate. |
| D4 | The same chart family must be able to run on the OCI free VM (2 OCPU / 12 GB), so the design is sized by that, not by this 24 GB box. |
| D5 | Keycloak and Grafana are **outside mini and standard**; Grafana is full only. (Owner, 2026-11-16) |
| D6 | **Prove it on a real VM first; this box migrates last.** Nothing is installed on the live box until the VM lab passes. (Owner, 2026-11-16) |
| D7 | **If k3s proves too heavy, the fallback is Compose with the module model, settings, web enabling and budgets.** Accepted by the owner, 2026-11-16. |
| D9 | **#326: scrub forward, do not rewrite history.** Rotate anything that was ever a real credential regardless. (Owner, 2026-11-16) |
| D10 | **#325: personal docs move to a private repo**, a new private repository (created, empty; its name is recorded in #325, not here). (Owner, 2026-11-16) |
| D11 | **#316: the settings store is SQLite with envelope encryption**, the key held outside the datastore, secrets write-only (replace or generate, never reveal), `bothy config export` as an age-encrypted bundle, a pluggable secret backend later. Chosen as the professional option. (Owner delegated the choice; 2026-11-16) |
| D12 | Modes get **fun, characterful names**, and `files` is in the smallest mode. Options and microcopy in `mode-names.md`; **decided: Bivvy / Bothy / Basecamp / Cairn** (Owner, 2026-11-16). |
| D13 | **The k3s floor is 4 GiB; below it the install is Compose** (S0: stock k3s costs about 656 MiB idle). The installer's preflight refuses k3s below the floor and a swapless host under 4 GiB (S6). (Owner, 2026-11-16) |
| D14 | **Hybrid runtime:** k3s core, Docker modules, a host executor `bothy-hostd`; **modes** mini / standard / full / custom shown as Bivvy / Bothy / Basecamp / Cairn; the **settings store is option A**, recorded in `settings-store.md`, library merged as `apps/bothy-settings` (#360). (Owner, 2026-11-16) |
| D8 | The installer offers a **reach** choice (Tailscale, SSH, both, local) as part of the install. See `vm-lab-and-connectivity.md`. |

## Reading order

| File | Answers |
|---|---|
| [footprint-and-budgets.md](footprint-and-budgets.md) | What do we use **today** (measured), what does each mode need, what numbers are targets vs guesses |
| [review-findings.md](review-findings.md) | **Read first.** What seven reviewers found, what is already fixed, the rewrite queue, new spikes, and the decision about ordering k3s work |
| [box-specific-inventory.md](box-specific-inventory.md) | Every box-specific default in code and config (328 sites), classified and mapped to a proposed module setting: the work list for #323 |
| [spike-results.md](spike-results.md) | Measured results from the VM lab: what k3s costs at idle (about 650 MiB) and the resulting 4 GiB floor for the k3s install |
| [mode-names.md](mode-names.md) | Fun names for the modes (Bivvy / Bothy / Basecamp / Cairn and alternatives), the microcopy that gives it personality, and the rules that keep fun from hiding information |
| [hybrid-runtime.md](hybrid-runtime.md) | **Read first after this file.** What is on k3s, what stays on Docker, and who controls the Docker half |
| [vm-lab-and-connectivity.md](vm-lab-and-connectivity.md) | The disposable VM we build on (not this box); the install-time Tailscale/SSH choice and not locking yourself out |
| [architecture.md](architecture.md) | (superseded where `hybrid-runtime.md` disagrees) The runtime, namespaces, packaging, how core and modules are laid out, what disappears |
| [modes-and-modules.md](modes-and-modules.md) | mini / standard / full / custom; the module catalogue, dependencies, the first-run wizard |
| [resource-management.md](resource-management.md) | requests, limits, quotas, priority, the budget gate, eviction order, slimming monitoring |
| [install-and-bootstrap.md](install-and-bootstrap.md) | First install on WSL2, a plain Linux box, and OCI; the one-time admin; uninstall |
| [updates-and-rollback.md](updates-and-rollback.md) | The updater when it lives in the cluster; self-update; Postgres majors; rollback |
| [customization.md](customization.md) | How settings become Helm values; per-module overrides; third-party modules; escape hatches |
| [../settings-store.md](../settings-store.md) | **Decision record for the settings and secrets store (D11, #316)**: options weighed, key hierarchy, schema, rotation, backup, export, threat model |
| [security-model.md](security-model.md) | RBAC replacing the socket proxies, NetworkPolicy, secrets, the new trust boundaries |
| [migration.md](migration.md) | Getting from Compose to k3s with the live box running at every step |
| [testing-and-ci.md](testing-and-ci.md) | How every claim above is held by a check |
| [risks-and-open-questions.md](risks-and-open-questions.md) | Decisions still needed, risk register, dead ends and alternatives rejected |

## Phases (summary; detail in `migration.md`)

| Phase | Result | Live box affected? |
|---|---|---|
| 0 | **Build the VM lab** (done), then measure: k3s idle cost (done, S0), k3s beside Docker (done, S5b/S5c/S9/S10), a limited Docker module over its limit (done, S6), **port publishing from a tailnet peer (not run, S1/S8)** | no (a VM) |
| 1 | `bothy-core` chart renders and runs on a throwaway k3s, next to Compose | no |
| 2 | Module declarations (#320) drive **both** Compose and Helm output | no |
| 3 | Settings store (#317) and first-run wizard (#319) in the cluster | no |
| 4 | In-cluster updater (replaces the host spool executor) | opt-in |
| 5 | Move modules one at a time: monitoring, then auth, then data | per module, reversible |
| 6 | k3s is the install target on hosts of at least 4 GiB; **Compose stays** (below the floor, for Docker modules, as the fallback) | yes, announced |

## How this relates to existing issues

- **Builds on:** #315 (tracking), #316 (store decision), #317 (store), #319
  (first run), #320 (modules), #321 (Settings -> Modules), #322 (one API, four
  surfaces), #323 (no box-specific defaults), #312 (operable from the web).
- **Changes the assumption of:** #318 (render *compose* env from the store - becomes
  render *Helm values*, with the compose renderer kept for dev), #306/#307
  (updater features, which now target a cluster-native updater).
- **Supersedes in spirit:** #90 (shell), #91 (any compose file) and #93 (grouping)
  need a re-read once modules exist; some become module features.
- **New issues to file** once this plan is accepted are listed in
  `risks-and-open-questions.md`.

## Non-goals

- Multi-node or HA clusters. One node, k3s single-server. (Adding agents is possible
  later; nothing here forbids it; nothing here designs it.)
- Replacing Keycloak, Grafana or Postgres with in-house code. They become *modules*,
  not rewrites.
- Hosting other people's applications. Projects keep their own compose/k8s
  (rule 3 of the notes: the stack provides what projects do not ship).

## Go / no-go (2026-11-16)

This is the written gate the review asked for. **Verdict: GO for a first installable Bivvy on a VM, with
two named blockers that must close before the gate is final. NO-GO for installing anything on the live
box or on a WSL host until they close, and until S12b is run.**

### What is proven (in the lab: Ubuntu 24.04 guest, kernel 6.8, Docker 29.1.3, k3s v1.37.2; not the WSL kernel)

| Claim | Spike |
|---|---|
| Stock k3s idles at about 656 MiB; trimming saves about 27 MiB. Hence the 4 GiB floor | S0 |
| k3s and Docker coexist: either can restart without breaking the other, pod and container egress survive | S5c, S10 |
| A hostPort never fails `bind()`, silently shadows host and Docker listeners, and the winning rule flips after a Docker restart. Hence **no hostPort** | S5b |
| A Docker container over its own limit is the only thing killed; the k3s cgroups see zero OOM events. Hence **every Docker module needs a limit** | S6 |
| `k3s-killall.sh` and the uninstall script leave Docker's rules identical (314 lines removed, 0 added) | S9 |
| Docker's firewall backend must be pinned; switching in place lost container egress until reboot | S10 |
| `/` as `private` (the WSL default) breaks `rslave`/`rshared`; `mount --make-rshared /` fixes it | S11 |
| The kube-router network policy controller works in the guest; the WSL kernel's config has the modules | S12 (config only on WSL) |
| The guest is not isolated from the host loopback | S15 |

### What blocks

1. **The global-OOM victim is unknown, and the host wedged for 8+ minutes** (S6, swapless 4 GiB guest).
   Stock BestEffort pods (`oom_score_adj` 1000) rank ahead of an unlimited Docker container, so the
   core's protection rests on Docker limits being set and honest, and the gate for the Docker half is
   advisory. Re-measure with swap (S6b).
2. **How the edge is published is undecided and untested.** `hostPort` is forbidden; k3s's default
   ServiceLB probably uses it (S5d); hostNetwork Traefik needs an exemption from the restricted
   baseline; and every tailnet-side check (S1, S7, S8, S14) needs a Tailscale key in the lab.

### What must still be re-measured, and what is only assumed

| Item | Status | Settled by |
|---|---|---|
| Core idle memory on k3s (every Bothy figure is an estimate) | ASSUMPTION | S17 |
| The 4 GiB floor (a judgement from one number) | ASSUMPTION | S17 on `lab-std` |
| Guaranteed pod `oom_score_adj` -997 and its survival in a global OOM | documented, not measured | S6b |
| `ValidatingAdmissionPolicy` on the bundled apiserver | ASSUMPTION | S16 |
| `bothy-hostd`, the two-clone updater, the cross-runtime forward-auth hop | designs, never run | first Docker module on a VM |
| `wsl --shutdown` recovery, rshared persistence, k3s on the WSL kernel, minikube, legacy iptables | not tested | S12b, a WSL host that is not the live box |
| Tailnet exposure, node IP stability, Tailscale SSH beside sshd | not tested | S1, S7, S8, S14 |

### Ordered next steps to a first installable Bivvy on a VM

1. **Close the lab gaps (small, no product code):** S5d, S6b (a swap-enabled `lab-mid`), S16.
2. **Decide the edge publication** from S5d, then run S1/S8 with a Tailscale key in the lab.
3. **In parallel, the work that does not depend on k3s** (the D7 fallback; no work is wasted whichever
   way the gate ends): #323/#324 defaults, the module declaration as metadata plus `runtime` (#320), the
   settings service wrapped around `apps/bothy-settings` (#317), first-run login (#319).
4. **Core chart:** Guaranteed pods, no hostPort, restricted baseline, the admission policy, the budget
   arithmetic; L2 on k3d. The install of the k3s path is blocked until the admission policy lands
   (`settings-store.md` Q4).
5. **Installer:** the preflight list (`install-and-bootstrap.md` s2), the rshared unit, pinned k3s, the
   receipt, killall-safe uninstall. Run it on `lab-mid`, then on `lab-mini` (which must take the
   **Compose** path), checking the coexistence diff (`testing-and-ci.md` 2b).
6. **Bivvy itself:** `login` with the claim token, `files` on k3s, bytes-verified portal, `network`
   read-only. Measure real core memory (S17) and revise the 4 GiB floor if it moves.
7. **Then** the first Docker-runtime module through `bothy-hostd` (this is what `standard` needs, via
   `logs`), with the Docker-module contract checks. Only after that, standard and full.
8. **Last:** a WSL host that is not the live box (S12b), then the live box (D6).

### Where the evidence presses on the decisions (not re-litigated; recorded)

- **"Docker only when a Docker module is enabled" does not hold for `standard`:** `logs` (Loki) is a
  Docker module, so the second rung of the ladder already needs Docker and the whole S5b/S6/S10
  hazard set. Open item in `modes-and-modules.md` s1.
- **k3s's resource guarantees cover the small part.** Under the hybrid decision the heavy things
  (Keycloak, Grafana, Loki, Postgres, about three quarters of today's 1.6 GB) are Docker modules that
  quotas, priority and eviction do not govern, while k3s costs about 656 MiB against Bothy's own
  roughly 170 MiB. What k3s buys is self-healing and atomic upgrades for that small part. The review's
  suggestion to build the Compose track first is strengthened, not weakened, by S0 and S6; the plan
  honours it by making steps 3 and 7 independent of the k3s gate.
- **"Protect core with `oom_score_adj`" was the wrong lever:** `k3s-server` is already -999 and
  `dockerd` -500; what ranks first in a global OOM is stock BestEffort pods at 1000.

### Disagreements between documents resolved on 2026-11-16

| Between | Was | Now |
|---|---|---|
| `modes-and-modules.md` vs D12 / `mode-names.md` | `files` in standard | `files` in mini |
| `architecture.md`, `security-model.md`, `updates-and-rollback.md` vs `hybrid-runtime.md` | "everything in k3s", proxies and host updater deleted | hybrid wins; both stay for Docker modules |
| `architecture.md` s6 vs `settings-store.md` s9 | master key a cluster Secret, excluded from backups | a host file is canonical; a Secret is a gated projection |
| `install-and-bootstrap.md` vs k3s default (S5c) | kubeconfig mode `0640` | `0600` |
| `resource-management.md` | "no CPU limits for core" and "Guaranteed-ish" | core Guaranteed with CPU limits; others none |
| `migration.md` Phase 6 vs D1, D7, D13 | "Compose becomes dev only" | Compose stays supported |
| `risks-and-open-questions.md` dead ends vs `hybrid-runtime.md` | "no host updater" | host executor stays for Docker modules |
| `footprint-and-budgets.md` | k3s 500-700 MiB (E) | about 656 MiB (M) |

## Changed 2026-11-16

- Header, D1, D13, D14, the phase table and the go/no-go section above. The reading order is unchanged;
  `hybrid-runtime.md` still overrides `architecture.md`.
