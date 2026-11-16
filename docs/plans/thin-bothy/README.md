# Plan: Thin Bothy - a k3s-native, modular, budgeted Bothy

_Written 2026-11-16. Status: **proposed, reviewed once** (design only, nothing built). **Read `review-findings.md` first: seven independent reviews found this plan internally unreconciled and several claims wrong; the factual errors are fixed, the larger rewrites are queued behind a decision.** Extends
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
| D1 | **The install path and our development effort are k3s-first.** Docker Compose stays for the existing system and for everything that does not need the cluster (it is *not* dev-only; it is simply not the install target). **Refined 2026-11-16, see `hybrid-runtime.md`, which overrides `architecture.md`.** |
| D2 | Mini-by-default on first install; bigger installs are chosen **from the web**. Mini is k3s only and needs no Docker. |
| D3 | **Only core, the things that need a fallback, and "a little more" run on k3s.** Heavy or already-working modules (Keycloak, Grafana, Loki, Postgres) stay on Docker and do not migrate. |
| D4 | The same chart family must be able to run on the OCI free VM (2 OCPU / 12 GB), so the design is sized by that, not by this 24 GB box. |
| D5 | Keycloak and Grafana are **outside mini and standard**; Grafana is full only. (Owner, 2026-11-16) |
| D6 | **Prove it on a real VM first; this box migrates last.** Nothing is installed on the live box until the VM lab passes. (Owner, 2026-11-16) |
| D7 | **If k3s proves too heavy, the fallback is Compose with the module model, settings, web enabling and budgets.** Accepted by the owner, 2026-11-16. |
| D9 | **#326: scrub forward, do not rewrite history.** Rotate anything that was ever a real credential regardless. (Owner, 2026-11-16) |
| D10 | **#325: personal docs move to a private repo**, a new private repository (created, empty; its name is recorded in #325, not here). (Owner, 2026-11-16) |
| D11 | **#316: the settings store is SQLite with envelope encryption**, the key held outside the datastore, secrets write-only (replace or generate, never reveal), `bothy config export` as an age-encrypted bundle, a pluggable secret backend later. Chosen as the professional option. (Owner delegated the choice; 2026-11-16) |
| D12 | Modes get **fun, characterful names**, and `files` is in the smallest mode. Options and microcopy in `mode-names.md`; pick pending. |
| D8 | The installer offers a **reach** choice (Tailscale, SSH, both, local) as part of the install. See `vm-lab-and-connectivity.md`. |

## Reading order

| File | Answers |
|---|---|
| [footprint-and-budgets.md](footprint-and-budgets.md) | What do we use **today** (measured), what does each mode need, what numbers are targets vs guesses |
| [review-findings.md](review-findings.md) | **Read first.** What seven reviewers found, what is already fixed, the rewrite queue, new spikes, and the decision about ordering k3s work |
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
| 0 | **Build the VM lab**, then measure: k3s idle cost, port publishing from a tailnet peer, k3s beside Docker, core surviving a Docker module over its limit | no (a VM) |
| 1 | `bothy-core` chart renders and runs on a throwaway k3s, next to Compose | no |
| 2 | Module declarations (#320) drive **both** Compose and Helm output | no |
| 3 | Settings store (#317) and first-run wizard (#319) in the cluster | no |
| 4 | In-cluster updater (replaces the host spool executor) | opt-in |
| 5 | Move modules one at a time: monitoring, then auth, then data | per module, reversible |
| 6 | Compose demoted to dev; install path is k3s only | yes, announced |

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
