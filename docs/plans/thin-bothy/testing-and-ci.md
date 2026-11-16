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
k3s path. The Compose versions stay as a **dev smoke** job.

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

## 3. The mutation table, extended

The repo's rule that "every check can fail" continues: each new check gets a
*mutation row* that breaks the property (remove a `resources` block, add `hostPath`,
return a secret from a GET, exceed the budget) and asserts the check goes red. The
CI `mutants` shards already do this for existing checks; new checks join them.

## 4. What CI cannot prove (and the manual step)

- **WSL2 behaviour** (tailnet reachability, memory cap, keepalive). CI runs on plain
  Linux. Each WSL-specific claim has a manual runbook in the spike docs and a
  one-line entry in a "verified on" table (date, who, what), not a silent assumption.
- **Visual correctness** of the wizard and Settings -> Modules. Playwright with a
  screenshot, as the notes require (jsdom cannot see layout; mind the rAF-polling
  rule, use `{ polling: 500 }`).
- **Real OCI**: the A1 behaviour (ARM images, the idle-reclaim rule that needs
  memory above 20%) is **documented** in `oci-free/docs/infrastructure.md`, not checked by its CI (which has only `ci.yml` and `secret-scan.yml`); verify by a manual soak and add a check if wanted.

## 5. Multi-arch

OCI is **ARM**; this box is x86. Every image must exist for both, or the module
declares `arch = ["amd64"]` and is unavailable on ARM (the budget gate and the
wizard say so). A CI job builds and runs mini on **arm64** (QEMU or a native runner)
so a core service never silently loses ARM.

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
