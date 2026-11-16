# Modes and modules

A **mode** is a named set of modules. A **module** is the unit you enable, size and
remove. Modes exist so a first install needs one choice, not twenty.

## 1. The catalogue

Costs are **T**argets (see `footprint-and-budgets.md`); `M` marks a measured figure.

| Module | What it is | Requires | Memory req / limit | Disk | In mode |
|---|---|---|---|---|---|
| `core` | traefik, web, api, settings, operator | - | 170 M / 400 Mi (+k3s) | 0.5 Gi | mini+ (cannot be off) |
| `login` | built-in login: one-time admin password, local users | core | 0 (inside settings) | - | mini+ |
| `files` | notes/docs reader, roots and policy | core | 31 M / 256 Mi | - | standard+ |
| `metrics` | VictoriaMetrics + kubelet/cAdvisor + node metrics | core | 170 M / 400 Mi | 4 Gi | standard+ |
| `logs` | Loki + a collector | metrics | 250 M / 600 Mi | 4 Gi | standard+ |
| `dashboards` | Grafana, provisioned | metrics | 256 M / 384 Mi | 1 Gi | full |
| `alerts` | alert rules, mail routing (`alert-email`) | metrics | small | - | standard+ |
| `sso` | Keycloak + oauth2-proxy, replaces `login` for web SSO | core, postgres | 400 M / 1 Gi | 1 Gi | full |
| `postgres` | the shared dev/ops Postgres and its exporter | core | 85 M / 512 Mi | 5 Gi | full |
| `k8s-ui` | Headlamp-class cluster UI | core | 35 M / 256 Mi | - | full |
| `traces` | Tempo (+ OTel) | logs | 150 M / 512 Mi | 2 Gi | full |
| `backups` | CronJobs per stateful module, restore verification | any stateful | 0 idle | target | standard+ |
| `remote-cluster` | read-only datasources for a second cluster (OCI) | metrics, logs | tiny | - | opt-in |
| `host-timers` | systemd timers that k3s cannot replace | - | host | - | opt-in |
| `windows-host` | WSL keepalive, portproxy repair | - | host | - | opt-in, WSL only |

Memory figures for existing services are the measured resident sizes in
`footprint-and-budgets.md`; the limits there are today's compose limits.

## 2. The modes

> **Open (2026-11-16):** the display names (mini/standard/full are placeholders) and whether `files` joins the smallest mode are decided in [mode-names.md](mode-names.md). The owner asked for `files` in the default and for fun names; ids in code stay `mini`/`standard`/`full`/`custom`.

| Mode | Modules |
|---|---|
| **mini** (default) | `core`, `login` |
| **standard** | mini + `files`, `metrics`, `logs`, `alerts`, `backups` |
| **full** | standard + `dashboards`, `sso`, `postgres`, `k8s-ui`, `traces` |
| **custom** | any closed set (dependencies auto-included and shown) |

A mode is just a **preset list** in `apps/bothy-settings/modes/*.toml`. There is no
mode-specific code: selecting "standard" enables the listed modules through the same
path as enabling one by hand, so the two cannot diverge.

## 3. The questions this forces (decisions, with a recommendation)

**Q1. Is Keycloak in mini?** (#316 left this open.) **No.** Keycloak alone is 387 MiB
(more than all of mini's own services). Mini uses the **`login` module**: a local
admin whose password is generated once, shown once, and must be changed at first
sign-in (#319), plus local viewers/operators. The three roles and the gates stay;
only the identity provider changes. `sso` replaces `login` for people who want
Keycloak, with a one-time user migration. The cost is two auth code paths, so the
role/gate layer must sit *above* both (see `security-model.md`).

**Q2. Is Grafana in standard?** The recommendation above says **no**: standard has
`metrics`, `logs`, `alerts` and the portal's own panels, and `dashboards` is full.
Grafana is 386 MiB for something many people never open. Whether the portal's own
panels are good enough is the real question; tracked as a design item under
"portal live numbers" in `risks-and-open-questions.md`.

**Q3. Where does Postgres go?** Bothy needs none (#316 option A). It is a module
because projects on this box use it and because Keycloak does. Mini and standard
carry none.

## 4. Dependencies and the apply graph

- Every module lists `requires`. Enabling `sso` offers to enable `postgres` and says
  what that adds before you confirm; it never half-enables.
- Disabling is the reverse: it lists dependants and refuses until they are off.
- The operator applies in dependency order and verifies each module's **health
  contract** (below) before the next.
- **Disable != delete data.** Disabling removes workloads and routes, keeps PVCs. A
  separate typed-confirm "purge data" action deletes them, after a backup. This
  mirrors `compose down` vs `down -v` and the existing rule that one command destroys
  data (`f-stack`).

## 5. The health contract

Each module ships a machine-checkable contract, the same shape as today's
`bothy-ops/checks/`:

```toml
[health]
ready   = { kind = "http", path = "/-/health", expect_bytes = "ok" }   # bytes, not just 200
measure = { kind = "mem", warn_over_request = 1.5 }
```

Verification after an apply reads **bytes** (rule 7), not status codes. A module
that does not pass its contract in its timeout is rolled back by the operator
(`updates-and-rollback.md`).

## 6. The first-run wizard

On the first sign-in with the generated password:

1. **Rotate the admin password** (forced, #319).
2. **Choose a mode.** The page shows each mode's *measured* idle memory and disk
   on this node and the node's free budget, e.g. "standard: +1.0 GB; you have 18 GB
   free". Mini is preselected.
3. **Review the plan** (the diff of modules and values), then **Apply**, with the
   operator's live log, verification, and automatic rollback on failure.
4. Land on Overview, which shows only the enabled modules, with disabled ones
   listed as "off - enable" rather than red.

Everything the wizard does is also reachable later from Settings -> Modules (#321),
the CLI, the API and MCP (#322): the wizard is a view over the same API, not a
separate code path.

## 7. What "disabled" means in the UI

`enabled = false` hides cards, removes routes (so a disabled module is a 404, not a
login redirect), removes its alerts, and silences `just doctor`/the checks about it
(already a #320 acceptance criterion). The portal never shows a red tile for
something the operator turned off on purpose.
