# Testing and CI

Every claim in this plan needs a check that **can fail**. The repo already holds
that bar (a mutation table proves each check can fail, ~600 offline assertions,
install/upgrade/elsewhere workflows). This document says what is added, and what
the existing ones become.

## 1. Test layers

| Layer | Runs | Proves | Cost |
|---|---|---|---|
| L0 static | every PR, offline | module TOML schema; `helm template` per mode; `kubeconform`; the security assertions (`security-model.md` s3); budgets sum under each mode's ceiling | seconds |
| L1 unit | every PR | validator, renderer (settings -> values), budget gate arithmetic, crypto round-trip, auth adapter | seconds |
| L2 cluster | every PR touching charts/operator | a throwaway **k3d/k3s** in CI: install mini, apply a module, verify bytes, rollback on a broken chart, reject a privileged pod | minutes |
| L3 install | PR (today's `install.yml` has **no schedule**: push, PR, `workflow_call`) | the real installer on a clean VM/container: mini comes up, first-run flow, uninstall leaves nothing | minutes |
| L4 upgrade | nightly | install `HEAD^1`, upgrade to `HEAD`: data survives, no PVC recreated, second apply is a no-op | minutes |
| L5 elsewhere | nightly | odd paths, spaces, non-default state root, unusual users | minutes |
| L6 live (manual) | per migration step | parity checks against the live box | human |

L3-L5 are today's `install.yml`, `upgrade.yml`, `elsewhere.yml`, re-pointed at the
k3s path. The Compose versions stay as a **dev smoke** job, and, because Compose is also the
**install path below 4 GiB** (S0), they are no longer "dev only": the Compose install is a
supported target with its own gate.

**Which layer needs what (review finding).** L0 and L1 run anywhere. **L2 runs on k3d** (or kind):
it proves charts, RBAC, admission and Pod Security, **not** the kernel, iptables or OOM behaviour.
**L3 to L5, and everything in section 2b, need a real VM** with systemd, because hosted runners
have no systemd-in-container for the real installer and no control of the firewall backend or
cgroups. Pinned image digests must be **multi-arch manifest-list digests**.

## 2. The checks specific to this plan

| Check | Failure it prevents |
|---|---|
| **Budget sum** per mode | a PR that makes mini 300 MiB fatter without anyone choosing it |
| **Declaration vs reality** (L2): after settling, each pod's RSS is within 1.5x its request | requests that are fiction |
| **Compose parity**: generated compose equals the hand-written file until retired | dev and product drifting |
| **Both-runtime render**: every module that declares both runtimes passes both | a module only working in one |
| **No secret in values/ConfigMap/args**: grep fixtures with a canary secret | the Basic-header leak class (rule 2) |
| **Privileged pod rejected** (live) | PSA silently permissive |
| **Role x route x provider matrix** | an auth path that works for `login` and not `sso` |
| **Disable leaves no routes/alerts/cards** | "disabled" modules still being half-visible |
| **Bytes not status** in every verify step | rule 7 regression |
| **Updater: stale plan refused**, **no-backup refuses**, **rollback restores** | the three ways an updater hurts you |
| **Kill the API during self-update** (L2) | the circular update case |
| **Lost master key fails closed** | silent data loss on a missing key |

## 2b. Checks that exist because of the lab (all need a VM, not k3d)

| Check | Failure it prevents | Source |
|---|---|---|
| **Coexistence diff:** `iptables-save -t nat` **and** `nft list ruleset` before and after install; only additions, no Docker line changed | k3s disturbing Docker's rules | S5b, S9, S10 |
| **No `hostPort`** in any rendered Bothy manifest | a silent shadow of a host or Docker listener | S5b |
| **Port registry:** a Docker module port equal to a k3s service port fails | the same collision from the other side | S5b |
| **Docker-module contract:** memory limit, positive `oom_score_adj`, `restart: unless-stopped` present in the compose artifact **and** in `docker inspect` of the running container | an unbounded or non-restarting module | S5c, S6 |
| **OOM isolation:** a limited container exceeds its limit; assert `memory.events` (`oom_kill`) moves in **its** cgroup and stays zero in `kubepods.slice` and `k3s.service` (adj alone is not proof) | core hurt by a module | S6 |
| **Docker restart:** `systemctl restart docker` with k3s up; pods untouched, containers with a policy back, pod and container egress OK | a restart orphaning modules | S5c, S10 |
| **Propagation:** with `/` private, the installer's unit makes `rslave` and `rshared` mounts work | the WSL default breaking mounts | S11 |
| **k3s removal:** killall and uninstall leave Docker's rules identical | uninstall damaging Docker | S9 |
| **Preflight refusals:** swapless under 4 GiB, a 9p data dir, a busy port in any view | an install that cannot succeed or wedges the host | S6, S13, S5b |
| **hostd:** hostile spool files (symlink, `nlink` over 1, foreign UID, unknown component) refused; no argv from text | the host executor becoming a root shell | `security-model.md` 6.1 |
| **Admission (live):** privileged, hostPath and foreign-image Jobs rejected | RBAC alone being unable to constrain a `create` | `security-model.md` 6.2 |

Not yet measured: the **WSL kernel** running any of this (S12/S13 are config checks), `wsl --shutdown`
recovery, minikube coexistence, legacy iptables, and anything needing Tailscale (S1, S7, S8, S14).

## 3. The mutation table, extended

The repo's rule that "every check can fail" continues: each new check gets a
*mutation row* that breaks the property (remove a `resources` block, add `hostPath`,
return a secret from a GET, exceed the budget) and asserts the check goes red. The
CI `mutants` shards already do this for existing checks; new checks join them.

## 4. What CI cannot prove (and the manual step)

- **WSL2 behaviour** (tailnet reachability, memory cap, keepalive, `/` propagation, the WSL
  kernel's netfilter modules). CI runs on plain Linux. Each WSL-specific claim has a manual
  runbook in the spike docs and a one-line entry in a "verified on" table (date, who, what), not a
  silent assumption. They need **a schedule or a self-hosted WSL runner**, not ad-hoc runs.
- **Visual correctness** of the wizard and Settings -> Modules. Playwright with a
  screenshot, as the notes require (jsdom cannot see layout; mind the rAF-polling
  rule, use `{ polling: 500 }`).
- **Real OCI**: the A1 behaviour (ARM images, the idle-reclaim rule that needs
  memory above 20%) is **documented** in `oci-free/docs/infrastructure.md`, not checked by its CI (which has only `ci.yml` and `secret-scan.yml`); verify by a manual soak and add a check if wanted.

## 5. Multi-arch

OCI is **ARM**; this box is x86. Every image must exist for both, or the module
declares `arch = ["amd64"]` and is unavailable on ARM (the budget gate and the
wizard say so). A **weekly, non-blocking** CI job builds and runs mini on **arm64** (QEMU or a native runner)
so a core service never silently loses ARM; it blocks a release, not a PR.

## 6. Test data and fixtures

A small **fixture cluster state** (settings DB with a canary secret, a log line, a
metric) is shared by the checks above, so "no route returns a secret" and "parity"
run against the same, known data.

## 7. Cost control

The Spending-context rule applies to CI as well: PRs run only what a change can
reach (the existing "only the mutation rows a PR can reach" pattern, #327). L2 runs
only when charts, the operator, settings or module files change. Nightlies carry
the full set. The repo is public, so minutes are free; the goal is fast feedback,
not savings.

## Changed 2026-11-16

- s1: Compose is a supported install below 4 GiB (S0), not dev-only; which layers need a VM (review
  finding). Section 2b is new, one row per spike result; arm64 made weekly and non-blocking (review
  finding); WSL checks need a schedule.
- The lab VM is not a sandbox (S15), so a lab run proves our own code, never third-party code.
