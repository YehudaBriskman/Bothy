# Migration: Compose to k3s, with the live box running at every step

The epic's fifth rule (#315): **the maintainer's live box keeps running at every
step.** This box runs Keycloak, Grafana, Postgres and projects that depend on them
(Tals, ai-team-site, mpeg). The migration is therefore **side by side, one module at
a time, each step reversible.**

## 1. Principles

1. **Dual-run before cut-over.** The new cluster runs beside Compose, on other ports,
   until a module's parity check passes.
2. **Data moves by copy, never by move.** The Compose volume stays until the module
   has run on the cluster for a defined soak period.
3. **One module per step**, each its own PR, each with a written rollback.
4. **No flag day.** At no point is "k3s or nothing" the only state.
5. **Projects are not migrated.** They keep their compose/k8s (rule 3); only what
   Bothy provides moves.

## 2. Phases, in detail

### Phase 0: measure and spike (no change to the box)

| Spike | Question | Done when |
|---|---|---|
| S0 | k3s idle memory on WSL2 and on an OCI-like VM, with NetworkPolicy, secrets encryption, bundled components on/off | `measurements.md` has the table |
| S1 | Traefik entrypoint-per-port reachable from a **tailnet peer** on WSL2 | works from the phone/laptop, bytes verified |
| S2 | the budget gate reads WSL2's real memory cap | gate math matches `.wslconfig` |
| S3 | `helm upgrade --atomic` from a Job in-cluster, with a namespaced SA | rollback demonstrated |
| S4 | the update Job survives replacing the API pod | status served by the new pod |
| S5 | k3s coexisting with Docker (both want iptables) on this box | no change to the 32 current containers |

S5 matters most for the live box: k3s and Docker both program iptables; the plan
needs proof they coexist before anything is installed here. If they do not, the
cluster runs on **another WSL distro or the OCI VM** for dev, and this box migrates
last.

### Phase 1: core chart on a throwaway cluster

`bothy-core` (traefik config, web, api, settings, operator) renders and runs on a
temporary k3s/k3d in CI **and** on a scratch VM. Nothing on this box.

### Phase 2: one declaration, two outputs

Implement #320 with the `[runtime.*]` sections (`architecture.md` s4). Compose output
is generated and **diffed against today's hand-written compose files**; the diff
must be empty or explained. This is the safety net: the compose path is proven
unchanged before the Helm path is trusted.

### Phase 3: settings store and first run, in-cluster

#317, #319, #321 against the throwaway cluster. The live box keeps using `.env`;
precedence store > `.env` > default (#316) applies, so nothing changes until a value
is imported (#324).

### Phase 4: the in-cluster updater

Built and tested on the throwaway cluster, with the host updater untouched. Opt-in
on the live box only after Phase 5 starts.

### Phase 5: modules move one at a time

Order, safest first, by blast radius:

| # | Module | Why this position | Parity check | Rollback |
|---|---|---|---|---|
| 1 | `metrics` | stateless-ish, easy to rebuild, nothing depends on it for correctness | same series count, same alerts firing on a test | stop the cluster module, Compose metrics never stopped |
| 2 | `logs` | same | a fixture log line found by query | same |
| 3 | `files` | read-mostly; mounts `$HOME` read-only | same tree, same policy | same |
| 4 | `dashboards` | after metrics/logs feed it; provisioned from git | every dashboard renders, alert rules equal | same |
| 5 | `k8s-ui` | trivial once in-cluster | opens and lists | same |
| 6 | `login` / `sso` | **riskiest**: identity gates everything | every route x role passes (security matrix) | DNS/port swap back to Compose Keycloak |
| 7 | `postgres` | **last**: projects depend on it; `pg_dumpall` + restore + checksum | row counts and a project's own tests pass | keep the Compose volume and port |
| 8 | core cut-over | Traefik owns `:80` and the port set | portal bytes, router table, every published port | restore the Compose edge |

Postgres is last and gets the heaviest ceremony because **a database fault looks like
everything else** (rule 8's lesson): connections that time out against a healthy DB.

### Phase 6: Compose becomes dev only

- `just up` keeps working from the same module declarations (a dev runtime).
- The install docs, the installer and CI's install/upgrade/elsewhere workflows
  switch to k3s. The Compose-based `install.yml` is kept as a **dev smoke test**, so
  dev does not rot.
- `docs/ARCHITECTURE.md` and `~/claude-notes/stack/*.md` are rewritten for the new
  model; stale-note hygiene is part of the phase, not after it.

## 3. The ports, concretely

The live box publishes about 40 ports. During dual-run the cluster uses a **second
port range** (offset, as `cvops` does with port offsets), so both stacks answer, and
"cut-over" is a configuration change of the cluster's range to the real one after the
Compose side stops that service. `just urls` prints both columns during the
transition so nothing is lost.

## 4. Data inventory (what moves, from where)

| Data | Today | Moves how |
|---|---|---|
| Postgres (dev DB, Keycloak DB) | named volumes | `pg_dumpall` -> restore into the module PVC; checksums |
| Keycloak realm | in its DB | with the DB; realm export as a second backup |
| Grafana state | volume + provisioning in git | provisioning is in git; the volume only holds edits (audit before move) |
| VM / Loki | volumes | **not migrated**: history restarts (retention is 15 d / 7 d; a deliberate, announced gap) |
| Bothy state (`~/.local/state/bothy`) | host dir | imported into the settings store (#324) and the updater history PVC |
| `.env` secrets | file | #324's one-time verified import |

A **deliberate non-migration** (metrics and logs history) is the single biggest
shortcut; it is acceptable because retention is short, but it is called out here so
nobody discovers it as an incident.

## 5. Parity checks as code

Each module's migration has a `checks/parity-<module>.mjs` that runs against **both**
runtimes and compares results (series counts, dashboard panel queries, route table,
role matrix). The migration step merges only when parity passes in CI against a
fixture and on the live box by hand once.

## 6. What happens to the existing open issues

| Issue | Fate |
|---|---|
| #306, #307, #308 | folded into the in-cluster updater work (`updates-and-rollback.md`) |
| #309 (disk) | folded into resource management s6 |
| #310, #311, #302 | become the `remote-cluster` module |
| #318 | retitled: render Helm values (and compose) from the store |
| #336 | satisfied by the restricted pod baseline |
| #90, #91, #93, #100, #144, #145, #148, #157 | re-read after Phase 3; likely module features or closed |
