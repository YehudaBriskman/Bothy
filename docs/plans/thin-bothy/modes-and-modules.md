# Modes and modules

A **mode** is a named set of modules. A **module** is the unit you enable, size and
remove. Modes exist so a first install needs one choice, not twenty.

## 1. The catalogue

Costs are **T**argets (see `footprint-and-budgets.md`); `M` marks a measured figure.

| Module | What it is | Runtime | Requires | Memory req / limit | Disk | In mode |
|---|---|---|---|---|---|---|
| `core` | traefik, web, api, settings, operator | k3s | - | 170 M / 400 Mi (+k3s tax about 656 MiB, S0) | 0.5 Gi | all (cannot be off) |
| `login` | built-in login: one-time admin password, local users | k3s | core | 0 (inside settings) | - | mini+ |
| `files` | notes/docs reader, roots and policy | k3s | core | 31 M / 256 Mi | - | **mini+** (D12) |
| `network` | reach: how the node is reachable, SSH and tailnet state (`vm-lab-and-connectivity.md` B.6); changes go through `bothy-hostd` | k3s + host | core | small | - | mini+ (read-only until hostd exists) |
| `metrics` | VictoriaMetrics + kubelet/cAdvisor + node metrics | k3s | core | 170 M / 400 Mi | 4 Gi | standard+ |
| `logs` | Loki + a collector | **Docker** | metrics | 250 M / 600 Mi | 4 Gi | standard+ |
| `alerts` | alert rules, mail routing (`alert-email`), dead-man heartbeat | k3s | metrics | small | - | standard+ |
| `backups` | host `backup.sh` + timer for Docker data; k3s CronJob for k3s state | host + k3s | any stateful | 0 idle | target (off-node) | standard+ |
| `dashboards` | Grafana, provisioned | **Docker** | metrics | 256 M / 384 Mi | 1 Gi | full |
| `sso` | Keycloak + oauth2-proxy, replaces `login` for web SSO | **Docker** | core, postgres | 400 M / 1 Gi | 1 Gi | full |
| `postgres` | the shared dev/ops Postgres and its exporter | **Docker** | core | 85 M / 512 Mi | 5 Gi | full |
| `k8s-ui` | Headlamp-class cluster UI | Docker or k3s | core | 35 M / 256 Mi | - | full |
| `traces` | Tempo (+ OTel) | **Docker** | logs | 150 M / 512 Mi | 2 Gi | full |
| `remote-cluster` | read-only datasources for a second cluster (OCI) | k3s | metrics, logs | tiny | - | opt-in |
| `host-timers` | systemd timers that k3s cannot replace | host | - | host | - | opt-in |
| `windows-host` | WSL keepalive, portproxy repair | host | - | host | - | opt-in, WSL only |

**Docker-runtime modules** (`logs`, `dashboards`, `sso`, `postgres`, `traces`) each carry a
memory limit, a positive `oom_score_adj` and `restart: unless-stopped` (S5c, S6) and are
driven by `bothy-hostd`. Enabling the first one **installs Docker** (with the firewall backend
pinned, S10) and shows the added memory before you confirm. A mode lists modules, not runtimes,
so `postgres` sitting in `full` is correct: it is not a k3s mode member, it is a module the
operator enables through the other executor. **Open (design tension):** `standard` includes
`logs` (Docker), so `standard` on a k3s host is the first install that needs Docker and therefore
the whole S5b/S6/S10 hazard set. Either accept that, or make `logs` opt-in in `standard`. Not decided;
the owner's D3 says heavy modules stay on Docker, D5 only moved Keycloak and Grafana out of standard.

Memory figures for existing services are the measured resident sizes in
`footprint-and-budgets.md`; the limits there are today's compose limits.

## 2. The modes

> **Decided 2026-11-16 (D12, [mode-names.md](mode-names.md)):** display names **Bivvy / Bothy / Basecamp / Cairn**, and `files` is in the smallest mode. Ids in code stay `mini`/`standard`/`full`/`custom`; names are i18n display strings only.

| Mode (id, display) | Modules |
|---|---|
| **mini**, "Bivvy" (default) | `core`, `login`, `files`, `network` |
| **standard**, "Bothy" | mini + `metrics`, `logs`, `alerts`, `backups` |
| **full**, "Basecamp" | standard + `dashboards`, `sso`, `postgres`, `k8s-ui`, `traces` |
| **custom**, "Cairn" | any closed set (dependencies auto-included and shown) |

Keycloak (`sso`) and Grafana (`dashboards`) are **outside mini and standard** (D5). On a host
under 4 GiB the same mode sets run on Compose (`hybrid-runtime.md` s1).

A mode is just a **preset list** in `apps/bothy-settings/modes/*.toml`. There is no
mode-specific code: selecting "standard" enables the listed modules through the same
path as enabling one by hand, so the two cannot diverge.

## 3. The questions this forces (decisions, with a recommendation)

**Q1. Is Keycloak in mini?** (#316 left this open.) **No (answered, D5).** Keycloak alone is 387 MiB
(more than all of mini's own services). Mini uses the **`login` module**: a local
admin whose password is generated once, shown once, and must be changed at first
sign-in (#319), plus local viewers/operators. The three roles and the gates stay;
only the identity provider changes. `sso` replaces `login` for people who want
Keycloak, with a one-time user migration. The cost is two auth code paths, so the
role/gate layer must sit *above* both (see `security-model.md`).

**The auth adapter interface** is a forward-auth endpoint: it receives the request and answers
200 with `X-Forwarded-User` and `X-Forwarded-Role` (viewer, editor, operator) or 401/403. `login`
implements it in k3s (`bothy-api`). `sso` implements it through oauth2-proxy, **which is Docker**;
a k3s Traefik therefore reaches a Docker auth service by host address (`architecture.md` 5.2).
ASSUMPTION: this cross-runtime forward-auth hop works and fails closed when oauth2-proxy is down;
settle on a VM with `sso` enabled.

**`login` needs a threat spec before it is built** (review finding): argon2id with parameters
recorded and benchmarked on the smallest target (ASSUMPTION: OWASP-class minimum, to be measured
on `lab-mini`); rate limit and lockout per account and per source; session cookie
`HttpOnly; Secure` where TLS exists, `SameSite=Strict`; CSRF and `Origin` checks on every
state-changing route; session revocation on password reset and role change; **refuse or loudly
warn on plain-HTTP LAN reach** (the first-run password crosses it). The first-run credential
handling is in `install-and-bootstrap.md` s4.

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

## 8. Observability of the platform itself (added 2026-11-16)

Nothing in the first draft alerted when **k3s itself** was down, and the dead-man heartbeat had
no named receiver outside the cluster. Required, in mini already:

- A **host watchdog** (a systemd timer, not a pod) that checks `k3s.service`, `docker.service`
  (when Docker modules exist) and `bothy-hostd`, and writes the result where the portal can read it.
- **At least one off-cluster notification channel** (mail via `alert-email`, or a push endpoint the
  operator configures) and an **off-box dead-man receiver**. Without one, "healthy" and "dead" look
  the same to everyone who is not looking.
- Runbooks to write: `runbook-cluster-down` (k3s dead, Docker up: S5c shows Docker modules keep
  running), a monthly automated restore into a scratch VM, and a `preflight-coexist` check run
  after any Docker, WSL or k3s upgrade.

## Changed 2026-11-16

- s1: `runtime` column added; `postgres`, `logs`, `dashboards`, `sso`, `traces` are Docker
  (hybrid decision); `network` added; `backups` split (host plus k3s state); `files` moved to mini.
- s2: modes and display names decided (D12); the "Open" box removed. **Disagreement resolved:**
  this file put `files` in standard while D12 and `mode-names.md` put it in the smallest mode.
- s3: auth adapter interface and `login` threat spec added (review findings); the cross-runtime
  forward-auth hop is an **ASSUMPTION** (settled by the first `sso` run on a VM).
- Section 8 is new. **Open:** `standard` pulls in Docker via `logs` (see s1).