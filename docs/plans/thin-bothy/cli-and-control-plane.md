# The `bothy` CLI, the MCP server and the one control plane

_Written 2026-11-16. Status: **a proposal for the owner**: design only, nothing here is built, and nothing
here is decided until the table in section 7 is answered. It extends the "one API, four surfaces" goal of
#322 and the update epic (#312), and it sits on top of the decided list D1 to D14 in `README.md`
without reopening any of it. Every external claim carries a URL; anything I could not verify is marked
**ASSUMPTION**; measured figures say where they were measured._

## 0. The answer in ten lines

1. **One control plane.** A single **operation catalog** (a TOML file, the pattern `apps/bothy-ops/catalog.toml`
   already proves) declares every operation once: its role, its effect, its confirmation tier. The web UI, the
   `bothy` CLI and the MCP server are **generated or checked against it**; none holds business logic.
2. **Two channels, one vocabulary.** The **network API** (`/-/api/v1/*`, exact paths, role-gated, what the
   browser, remote CLI and MCP use) and the **host channel** (`bothy-hostd`'s unix socket, peer-credential
   checked, what the CLI on the box uses for the few things that must never cross the network: decrypt, install,
   offline rollback).
3. **The CLI is a Go static binary and a thin client.** All logic stays server-side in the Python that exists.
   Deciding evidence: section 2.1 (the official MCP SDK serves the current spec in Go; every comparable tool
   ships as a static Go binary; Python cannot be a static binary and bash cannot speak JSON-RPC).
4. **Release = GitHub Release assets + `checksums.txt` + a GitHub build-provenance attestation**, installed by
   the existing "download, read, run" `bothy.sh` pattern with the per-arch sha256 pinned in it. Cosign and SLSA
   level chasing are not worth a solo maintainer's time in v1 (section 2.2).
5. **MCP: stdio first, read-only by default, over `ssh box bothy mcp`.** Streamable HTTP and OAuth only when the
   `sso` module exists and TLS does. The spec current today is **2026-07-28** (stateless; no `initialize`).
6. **Writes from an agent never execute directly.** An MCP write creates a job in `awaiting_approval`; a human
   approves it on a surface whose credential kind the model cannot hold (browser session, or a TTY on the box).
7. **Update controls are a policy overlay that can only tighten** what the reviewed `updates.toml` allows, so
   a user can pause, hold, choose notify over auto, set a window, and never reach a class the catalog forbids.
8. **The two lessons of the week become structured facts**, not prose: "N commits ahead of the last release"
   and a machine-readable refusal `scope.group-available` that carries the group-apply offer (section 4).
9. **First slice, about 17 focused days:** `bothy status`, `bothy update status|plan`, `bothy mcp` (read-only),
   one static binary, one release pipeline, run on the VM lab. Biggest risk: a Go copy of a schema that Python
   writes drifting from it.
10. **Fourteen decisions are open** (section 7); none blocks slice 1 except D15 (language) and D16 (API shape).

## 0.1 The baseline this builds on (verified in this worktree on 2026-11-16)

| Piece | Fact | Source |
|---|---|---|
| `bothy` today | a 377-line bash script: native `init`, `download`, `upgrade`, `self-update`, `version`, `doctor --pre`, plus a `resolve()` dispatcher to `just` recipes; written to be bash 3.2 clean | `scripts/bothy`, `docs/guide/the-cli.md` |
| The updater | about 8,800 lines of Python in `apps/bothy-ops/updater/` (plans, classes, groups, own-code, auto, spool, record, pgmajor, cluster); a host process; **argv lists only**, never a shell string (`hostio.run` raises on a string) | `apps/bothy-ops/updater/*.py` |
| What the browser calls | `/-/api/updates/{status,plan,request,job,discover,autorun}` plus kube, control, docker, files, config, admin, loki, prom, traefik reads | `apps/bothy-ops/*.py`, `edge/dynamic/*.yml` |
| One catalog, generated wiring | `catalog.toml` generates the Traefik routers (one exact `Path()` each, role from `role`), the Role and the `can-i` probes; `confirm` is `none`, `click` or `type-name`, and an operator action may not be `none` | `apps/bothy-ops/catalog.toml`, `scripts/gen-ops-wiring.py` |
| The update catalog | `updates.toml`: classes `stateless`, `boundary`, `edge`, `timeseries`, `app-db`, `database`, `own-code`, `cluster`; channels `auto`/`notify`/`manual`; `auto` legal only for `AUTO_CLASSES`; any major is manual; a window `03:30` to `05:00`; `max_auto_per_night = 1`; `pause_on_failure = true` | `apps/bothy-ops/updates.toml` |
| Request path | browser -> `POST /-/api/updates/request` `{component\|group, planId, confirm}` -> spool file -> host path unit -> executor that **re-derives the plan** and refuses a stale `planId` | `updater/spool.py` |
| Own code | deploys only the newest `v*` tag on `origin/main` whose commit's `VERSION` matches and whose check runs are all green; `VERSION` is `2026.9.0`; `main` is 138 commits past `v2026.9.0` in this worktree | `updater/owncode.py`, `git log` |
| Releases | `release.yml` tags `v$VERSION` when CI, Install and Upgrade are green on the same commit; the Release carries **zero assets** today; the installer pins a commit SHA, not a checksum | `.github/workflows/release.yml`, `scripts/bothy.sh` |
| Settings library | `apps/bothy-settings` is merged (#360); **only the host CLI decrypts**; every other surface sees `set / updated / fingerprint`; its audit row already has `surface` (`web`, `cli`, `api-token`, `mcp`, `bootstrap`, `import`) | `docs/plans/settings-store.md` s9.3, s13.3 |
| Gap found while reading | `docs/plans/updates.md` s6 promises `just update-rollback <component>`; **no such recipe exists** (`just --list`). Rollback today is automatic on failure and by the own-code timer; a deliberate "undo this applied update" is not a verb anywhere | `justfile` |

## 1. The one control plane

### 1.1 The principle: one operation catalog, four surfaces

Four surfaces (web, CLI, token API, MCP) must not become four implementations. The repo has already solved
exactly this once, for the cluster half: `catalog.toml` is the only hand-written wiring and
`gen-ops-wiring.py` generates the routers, RBAC and probes from it, with a check that re-runs the generator and
fails on drift. This plan **generalises that file's idea to every operation**:

```toml
# apps/bothy-ops/operations.toml   (name provisional; replaces nothing, absorbs catalog.toml's shape)
[ops."update.plan"]
title    = "Show what applying a component would do"
http     = "GET /-/api/v1/updates/plan"      # exact path; ids travel in the query or body (see 1.3)
role     = "viewer"                          # lowest role that may call it
effect   = "read"                            # read | tighten | loosen | destructive | host-only
confirm  = "none"                            # none | click | type-name | host
callers  = ["web", "cli", "mcp", "system"]   # who may call it at all
mcp      = { tool = "bothy_update_plan", scope = "read" }
cli      = "update plan"
idempotent = true

[ops."update.apply"]
title    = "Apply a plan"
http     = "POST /-/api/v1/updates/apply"
role     = "operator"
effect   = "loosen"          # it changes what runs; see 1.6 for what each effect forces
confirm  = "click"           # or type-name, decided by the PLAN, never by the caller
callers  = ["web", "cli", "mcp"]
mcp      = { tool = "bothy_update_request_apply", scope = "write", approval = "human" }
cli      = "update apply"
idempotent = false
```

From this one file, CI (and the generator) produce or verify:

| Output | Replaces / extends | Held by |
|---|---|---|
| the Traefik router per op (exact `Path()`, role middleware, CSRF where `POST`) | `edge/dynamic/bothy-ops.yml` generation | `checks/wiring.py` pattern: regenerate and diff |
| `GET /-/api/v1/discover`: the live list of ops the server supports, with role, effect and confirm | `GET /-/api/kube/catalog` (the UI already reads a catalog at run time) | contract test |
| the CLI verb table (a verb names an op id; an unknown verb is refused by name, as today) | `resolve()` in `scripts/bothy` and `scripts/checks/cli-commands.sh` | `cli-commands` check, extended |
| the MCP tool list: a tool exists only for an op with `mcp = {...}`; annotations (`readOnlyHint`, `destructiveHint`) are derived from `effect` | nothing today | `mcp-catalog` check |
| the OpenAPI document for third parties | nothing today | generated, not hand-written |

**Why this is the right amount of machinery.** Adding an operation is one table plus one handler (today's cost
for a kube action) and the four surfaces cannot disagree about who may call it or whether it confirms. The cost
is a generator and a dozen checks; the repo already pays that cost for 29 cluster actions and 56 routers.

### 1.2 The resource model

Nine nouns, as asked. Each has an id format, an owner (who may write it), and where its truth lives today.

| Resource | Is | Id | Truth today | Writers | v1 verbs |
|---|---|---|---|---|---|
| **module** | a unit you enable, size and remove (`core`, `files`, `logs`, `sso`...); has a runtime (`k3s` or `compose`), a cost, a health contract | `sso` | module declarations (#320, not built); today `just up-*` groups | operator, via a job | list, show, enable, disable, add, remove (user modules), health |
| **component** | the closed-catalog thing the updater can move (`grafana`, `loki`, `traefik`, `bothy`...); belongs to one module | `grafana` | `updates.toml` | nobody at run time: it is reviewed code | list, show, status |
| **release** | a version of a component: what `main` pins, what runs, what upstream offers; for `bothy` itself a `v*` tag, plus the unreleased tip | `grafana@12.4.1`, `bothy@v2026.9.0` | `available.json`, `plans/*.json`, git tags | discovery (system) | list, show, notes (untrusted text) |
| **plan** | the host's computed, hashed answer to "what would applying this do", including every refusal | `p_<hash>` (the existing plan id) | `plans/<component>.json`, `groups/<recipe>.json` | host only (`discover`); never a caller | show, diff |
| **job** | one execution of a plan or action, through its states (below); owns steps, logs, verdict | `j_<ulid>` (the existing `jobId`) | `history.jsonl`, spool, the cluster Job's status | executors (hostd, in-cluster Job) | list, show, wait, cancel (queued only), approve, deny, logs |
| **backup** | a snapshot set: pre-update snapshots, the nightly backup, the settings export | `b_<ts>_<kind>` | the backup root, `stacks-backup.service` | the backup unit, executors | list, show, run, verify, restore (plan-first) |
| **setting** | a non-secret module field with a schema | `sso.session_ttl` | `apps/bothy-settings` | operator (editor for some) | get, set, diff, schema |
| **secret** | a write-only field: metadata only on every surface that is not the host CLI | `sso.client_secret` | `apps/bothy-settings` | operator can replace or generate, never read | list (metadata), set, generate, rotate, delete |
| **event** | an append-only fact: job transition, audit row, health transition, discovery result | `e_<ulid>` | audit files, `history.jsonl`, `auto.json`, k8s events | everyone, by writing the thing it derives from | query, follow |

**Job states** (one machine for both executors): `awaiting_approval` -> `queued` -> `running` ->
`verifying` -> `succeeded`; failure ends are `failed` (nothing changed), `rolled_back` (changed, restored, verified),
`rollback_failed` (stop and page a human), `aborted`, `denied`, `expired` (an approval nobody gave in time).
`awaiting_approval` is new; everything else maps onto what `record.py` already writes.

**Approval is not a tenth resource.** It is a state of a job plus a single-use grant bound to
(`plan id`, `requesting credential id`, expiry), described in 1.6.

### 1.3 The API: shape and conventions

* **Base path `/-/api/v1/`**, JSON in and out, one envelope: `{"ok": true, "data": ..., "warnings": []}` or
  `{"ok": false, "error": {"code", "message", "details", "hint"}}`.
* **Exact paths only.** Rule 1 of the notes (and `router-gates.sh`) holds Traefik to one exact `Path()` router per
  route. A REST path parameter (`/modules/{id}`) would need `PathPrefix` and would break that invariant, so
  **ids go in the query string (`GET`) or the body (`POST`)**: `GET /-/api/v1/updates/plan?component=grafana`,
  which is how `?group=` already works today. The router table stays enumerable and generated.
* **Async by default for anything that changes the box.** `POST` returns `202` and a `job` id; `GET
  /-/api/v1/job?id=` polls; `GET /-/api/v1/events?since=<cursor>` is the cursor-based feed. (Server-sent events are
  a later optimisation; polling is what the updater page does today and survives the API restarting mid-update,
  the circular case `updates.md` s6 spent a section on.)
* **Plan first.** Every `effect != read` op accepts `dry_run=true` and returns the plan or diff instead of acting.
  Applying takes a **plan id**, never a free-form request: "a request is a component id from a closed catalog,
  never a string" is a decided rule and the API schema encodes it (`component` is an enum served by `discover`).
* **Idempotency.** Mutations accept an `Idempotency-Key`; replaying one returns the original job. Independently,
  most ops are naturally idempotent (enable an enabled module = `200`, `data.changed = false`).
* **Stable error codes**, dotted, never reworded: `auth.unauthenticated`, `auth.forbidden`,
  `plan.stale`, `plan.refused`, `scope.group-available`, `scope.config-drift`, `precondition.no-backup`,
  `precondition.dirty-tree`, `skew.client-too-old`, `busy.job-running`, `approval.required`, `approval.expired`,
  `rate.limited`. The CLI maps them to exit codes (2.7); MCP returns them as `isError` results with the same code.
* **Versioning.** `v1` is additive-only; a breaking change is `v2` served beside it for one release. `GET
  /-/api/v1/discover` returns `{serverVersion, apiVersion, minClient, ops: [...]}`.
* **Untrusted text is typed.** Any field that carries text a third party wrote (container log lines, release
  notes, commit and PR titles, a changelog, a plan's `reason` that quotes a file) is returned inside
  `{"text": "...", "trust": "untrusted", "source": "container-log|release-notes|commit|file"}`, never as a bare
  string. This is for the MCP surface's benefit (3.4), but it is a property of the API so the three surfaces cannot
  diverge, and the web already needs to render these safely.

### 1.4 Two channels, and where the existing pieces sit

```
  browser ──(session cookie, forward-auth, CSRF)──┐
  bothy CLI, remote ─(bearer token)───────────────┼──▶  bothy-api  (today: bothy-ops, Python)
  bothy mcp (stdio, API-only backend) ─(token)────┘       │  validates against operations.toml, audits,
                                                          │  RE-READS plans from the host's read-only state mount
                                                          ▼
                                                 spool file  (the only way API -> host; API may only create)
                                                          ▼
                              bothy-hostd (host, Python: the existing updater, trimmed to Docker modules + host tasks)
                                  ▲     │  fixed argv only; re-derives the plan; claims by rename; writes job records
   bothy CLI on the box ──────────┘     └──▶  in-cluster `bothy-update` Job for k3s modules (updates-and-rollback.md)
   (unix socket, SO_PEERCRED uid check;
    decrypt, install, offline rollback,
    token minting, approval-by-TTY)
```

* **Why two channels.** Anything that can leave the host must be role-gated, CSRF-protected and token-scoped
  (the API). Anything that must **never** leave the host (the master key path, installing k3s, minting the first
  token, rolling back when the API pod is the thing that is broken) goes through the socket, where the authority
  is "you are the install user or root on this box", exactly the authority `settings-store.md` already assigns the
  host CLI. The socket is not a second API: it serves the **same operations** plus ops marked `effect = "host-only"`.
* **The API never reaches the host except by spool**, unchanged from `security-model.md` 6.1: a closed schema
  `{id, component|group, action, plan_id, confirm, note?}`, a distinct-UID spool, `O_NOFOLLOW`, claim by rename,
  re-validation against a freshly computed plan.
* **k3s modules** get the same job record written by the in-cluster Job (a ConfigMap the API reads), so a `job`
  looks identical to every surface whichever executor ran it (`updates-and-rollback.md` s2).

### 1.5 What is kept, what is rewritten

| Piece | Fate | Why |
|---|---|---|
| `bothy-ops` (`app.py`, `guard.py`, `catalog.toml`, CSRF, audit writer) | **Kept**, evolves into `bothy-api`; `operations.toml` absorbs the shape of `catalog.toml` | It is the reviewed, tested gate; a second gate would be a second thing to get wrong |
| `/-/api/updates/*` | **Kept**; re-exposed unchanged under `/v1`; old paths stay as aliases until the web migrates | The web already depends on them; payload shapes are the contract |
| `/-/api/kube`, `control`, `docker`, `files`, `config`, `admin`, `loki`, `prom`, `traefik` | **Kept, untouched**; they stay web-console domain endpoints | The CLI and MCP do not wrap a Docker or kube pass-through (`kubectl` exists, and a pass-through is exactly the over-broad tool a prompt injection wants); they reach these only through named, higher-level ops |
| The spool and the host updater (Python, about 8,800 lines) | **Kept**, renamed `bothy-hostd` when it grows the socket | The only part that has run on real boxes; `hybrid-runtime.md` s4 already chose it |
| `record.py` job records, `history.jsonl` | **Kept**, become the `job` store; gain `caller` fields | Already the single history page |
| Audit: bothy-ops `audit/`, `updater/audit.log`, settings `audit` table | **Unified schema** (1.7), three writers remain | Executor's record must not be editable by the process that asked (an existing rule) |
| `scripts/bothy` (bash) | **Rewritten** as the Go binary; `bothy.sh` stays as the tiny bootstrap | bash cannot be an MCP server or a typed API client (2.1) |
| The `just` recipes | **Kept** as the Compose driver and as contributor tooling (2.8) | "Treat what exists as the baseline to evolve" |
| The cluster Job updater (`updates-and-rollback.md`) | **Kept as designed**; it becomes the second executor behind the same job and plan model | One catalog, one plan format, one history |
| Python updater **ported to Go** | **No.** Not now, probably never | A rewrite of 8,800 reviewed lines buys nothing a thin client does not; it would also fork `docs/plans/updates.md`'s hard-won refusals |

### 1.6 AuthN and AuthZ per surface

| Surface | How a caller is identified | Credential kind | What it can reach |
|---|---|---|---|
| **Web** | the existing forward-auth chain: `login` (mini) or Keycloak with oauth2-proxy (`sso`); the edge supplies the role; CSRF on every `POST` | session | role-gated ops; may **approve** |
| **CLI on the box** | the unix socket, `SO_PEERCRED`: uid is the install user or root, and the socket's file mode is `0600` or group-limited | peer credential | every op the API serves **plus** `host-only` ops; may approve **from a TTY only** |
| **CLI remote** | `Authorization: Bearer bt_<id>.<secret>`; secret is 256 random bits, stored as a SHA-256 digest; token carries role, optional op allow-list, optional expiry | `token(kind=cli)` | API ops within its role and allow-list; never `host-only`; may not approve unless issued with `--can-approve` (default off) |
| **MCP** | a separate token, `token(kind=mcp)`, minted on the box by `bothy token create --kind mcp`; the `mcp` subcommand constructs an **API-only backend** and has **no code path to the socket** (a `go list -deps` CI check, 3.4) | `token(kind=mcp)` | ops whose `callers` include `mcp`; read scope by default; **can never approve** |
| **Tailnet identity** | v1: the tailnet is the network boundary, not an identity (access is IP:port). **Later:** bind a token to a tailnet node by asking tailscaled who owns the source address (`tailscale whois`), so a stolen token is useless off its device. **ASSUMPTION:** workable through the local API for direct connections; not tested | optional token binding | narrows, never widens |
| **Keycloak** | when `sso` is on: browser sessions as today; `bothy login` later uses the OAuth 2.0 device authorization grant (RFC 8628) so a CLI can obtain a user's token without a stored secret. v2. | OIDC token | same roles |

**Roles stay what they are**: `viewer`, `editor`, `operator` (the repo's `shell` role is unused; there is no `admin`).
**Scopes are a projection of `effect`**: `read` = viewer ops; `tighten` = hold, pause, channel-down, window-narrow;
`loosen` = apply, enable, restore; `destructive` = purge, remove, uninstall; `host-only` = not on the API at all.

**Confirmation tiers, and who may satisfy each.** This is the heart of the threat model, so it is stated as rules:

1. Confirmation is **chosen by the plan, not by the caller**: a plan says `confirm: click` or `type-name`
   (the existing `plans.py` field), and the op catalog says `host` for things that never leave the box.
2. A `type-name` confirmation is **typed text read from a TTY (`/dev/tty`, not stdin) or from a browser form with
   a CSRF token**. A pipe cannot satisfy it. `--yes` satisfies `click` only; `type-name` in a script needs
   `--confirm <exact id>`, which is the same discipline the spool already enforces (`confirm` must equal the
   component id).
3. **An MCP caller never carries a confirmation.** It creates a job in `awaiting_approval`. The grant is
   single-use, bound to (`plan id`, `token id`), valid 15 minutes (ASSUMPTION: a UX number, tune in the lab),
   and redeemable **only** by a credential of kind `session` or `peer-credential`-with-TTY. The server derives the
   kind from the credential, never from a request field; a `token(kind=mcp)` or `token(kind=cli)` presenting an
   approval is refused `auth.forbidden`.
4. **Direction matters.** `tighten` ops (hold, pause, move a channel from `auto` to `notify`, narrow a window) are
   low risk and reversible; they run without approval, audited, and emit an event. `loosen` and `destructive`
   from MCP always need an approval, whatever the plan says. This keeps an agent useful for the safe half
   ("pause grafana updates until Friday") without a human in the loop for each click.
5. MCP's own `elicitation` (a client-side prompt, in the 2026-07-28 spec carried as an `InputRequiredResult`) is
   **welcome as UX and worthless as authority**: the server cannot tell whether a person or the client's
   auto-accept answered. The spec itself says only that there **SHOULD** be a human in the loop and that clients
   **MUST** treat annotations as untrusted (spec, Tools). So the out-of-band approval above is the control.

### 1.7 The audit trail

One row schema for all three writers, append-only, written by whoever **executes** (so an API compromise cannot
edit the executor's account of what it did; the existing rule for `audit.log`):

```json
{"ts":"2026-11-16T03:41:07Z","request_id":"r_...","op":"update.apply",
 "caller":{"kind":"mcp","id":"tok_8f2c","label":"laptop-claude","client":"claude-code 2.x (self-reported, untrusted)"},
 "human":false,"surface":"mcp","resource":{"kind":"component","id":"grafana"},
 "plan_id":"p_...","approval":{"id":"a_...","by":{"kind":"session","id":"u_..."},"at":"..."},
 "args_digest":"sha256:...","outcome":"awaiting_approval","job":"j_...","prev":"sha256:..."}
```

* **Caller kind** is one of `web`, `cli` (peer credential), `token` (remote CLI), `mcp`, `system` (the night job,
  timers). `human` is `true` only for a browser session or a TTY. This extends the `surface` column that
  `settings-store.md` s13.3 already defines, so settings rows and update rows read the same.
* **`args_digest`, not args**, for anything that may carry a value; a secret never appears in any row.
* **A hash chain** (`prev`) makes truncation or edit of the executor's file detectable. It protects against the API
  process misbehaving; it does **not** protect against root on the host (same statement as the settings threat
  model). Cheap, so included; **ASSUMPTION** it is worth the 1 day it costs; it is the first thing to cut.
* **MCP `clientInfo` is recorded as a self-reported label**, never trusted for a decision.
* Retention and shape of display: Settings > Audit log already pages the bothy-ops audit; it gains the `caller` column.

### 1.8 How `/v1` is exposed, and who a caller is (D40 to D43)

Decided by the owner's delegation on 2026-11-17: "make the system secure and easy, and adding things later must
touch as little existing code as possible". Each decision below says what it buys for that second goal.

* **D40. Slice 1 does not route `/v1` at the edge.** The first slice is read-only and its service authenticates
  nobody (the edge gates, bothy-ops trusts the edge). A new network path needs a credential the service can verify
  itself, and that does not exist until slice 2. So in slice 1 the CLI on the box talks to the host socket
  (peer credential), and a remote operator runs `ssh <box> bothy ...` (Tailscale SSH is already the access path;
  `bothy mcp` is already designed to run that way). **Why:** zero new network surface now, and the generated
  routers in `apps/bothy-ops/generated/` stay inert, so no router count in SECURITY.md, the README or the guide moves.
* **D41. One identity object, one adapter per credential kind.** Every request is turned into
  `Caller{kind, role, scopes, token_id}` at the door, by an adapter: `session` (the edge's forward-auth result),
  `token` (a verified bearer token), `socket` (peer uid), `system` (the night job). Operations see only the
  `Caller`. The role is read from the verified credential and never from a request field. **Why:** a new way to
  log in (a device-grant CLI login, a Tailscale node identity, a CI key) is one new adapter and no change to any
  operation, the catalog or the web UI.
* **D42. Exposure is data.** `operations.toml` gains `exposure = ["socket"]` (the default) with `"session"` and
  `"token"` as the other values. The generator emits an edge router only for an op that lists an edge exposure, and
  the existing drift check holds the result. **Why:** adding an operation, or opening one to a new channel, is a
  catalog edit plus `just ops-v1`; no handler, router file, CLI verb or MCP tool is written by hand. Documents
  state the router **invariant** (zero Host rules, exact `Path()` only) and not a total, so growth does not
  force prose edits.
* **D43. Token authentication is slice 2, read tokens first.** *(Python side built in slice 2A, section 1.9; nothing is exposed yet.)* `bothy token create` is host-only (the socket);
  tokens are stored as SHA-256 digests, carry a role and an optional op allow-list, and are verified **inside
  bothy-ops** (not by an edge middleware, so the secret never sits in dumpable router config; see the Traefik
  rule in `claude-notes`). The first routed ops are the eight read ops with `exposure = ["socket","token"]`; writes
  wait for the approval design. The "no bearer token over plain HTTP" rule already admits the Tailscale range
  (RFC 6598), where the transport is encrypted.

### 1.9 Slice 2A: bearer tokens for the read API (built 2026-11-17, Python side only)

**Built and checked** (`apps/bothy-ops/`: `tokenstore.py`, `tokenctl.py`, the `token` adapter in `caller.py`, two
checks `checks/test_tokens.py` and `checks/api_v1_tokens.py`, 16 mutation rows in `scripts/checks/mutants.sh`):

* **Token** `bt_<id>.<secret>`: id 16 hex, secret 256 random bits (urlsafe base64). Only the SHA-256 digest is
  stored; compared with `hmac.compare_digest`. A record is `{id, kind: cli|mcp, role: viewer|operator, ops (op ids or
  "*"), created, expires, name, revoked_at, last_used}`. TTL default 30 days, at most 1 year, at least 1 minute.
* **Store** `<state>/tokens.json` (default `${STATE_ROOT:-~/.local/state}/bothy/tokens/`), file 0600 in a 0700
  directory owned by the process user (or root), not a symlink: anything looser and the store refuses to load and
  every bearer is refused (fail closed). Writes are temp file + fsync + rename under an `flock`; readers never see a
  half file. It is re-read on every request, so a revoke is effective on the next one. `audit.log` beside it is
  append-only JSON lines for `create`, `revoke` and `use-denied`; it carries no secret and no raw request text.
* **No oracle:** malformed, unknown id, wrong secret, expired, revoked, throttled and unreadable-store are one
  exception and one `auth.unauthenticated` body (same code, message, details, hint); the reason is only in the audit
  line. Failed verifications are rate-limited per source (10 a minute), with bounded memory (1024 sources) and a cap
  on denial audit lines (30 a minute). `last_used` is rounded to the hour and best-effort (a read-only mount never
  fails a good token).
* **The adapter** (`caller.token`) reads `Authorization: Bearer`, asks the store (a seam, `caller.set_token_store`;
  the service starts with none, so every bearer is still 401 unless `BOTHY_TOKEN_STATE` names a state directory), and
  builds `Caller{kind: token, role, scopes (= the record's ops), token_id}` from the **record**. An edge identity
  header together with a bearer is refused as ambiguous. In `v1api` the op's `exposure` must list `token`, the
  token's client kind (`cli`/`mcp`) must be in the op's `callers`, the op id must be in the record's ops (or `*`),
  and the role must be held; each is `auth.forbidden` (a valid token on a socket-only op is forbidden, not
  unauthenticated). The audit actor becomes `token:<id>`.
* **Mint and revoke are host-only (D43):** `tokenctl.py create|list|revoke` is a local script. It prints the secret
  once on stdout, refuses to run with a CGI/HTTP environment or a socket as stdin, validates `--ops` against
  `operations.toml`, and is not in the Dockerfile COPY list; no route or catalog op mentions it, and a check pins that
  the service imports none of it.
* **Nothing is exposed:** `operations.toml` still lists `exposure = ["socket"]` for every op; no edge router is
  installed; router counts and every golden are unchanged.

**Not built, said plainly:** no compose mount or env for a token state directory (so the running service has no
store); no edge router; no CLI (Go) or MCP code that sends a token; no `bothy token` verb (the host script is the
only mint); no tailnet binding; no tokens for write ops (there are none); the rate limit keys on the TCP peer, which
behind Traefik is Traefik's address, so it is effectively one bucket for all edge traffic until the edge forwards a
trusted client address (not designed yet); the timing uniformity is "the same work", not measured.

**Checklist: switching a read op to `exposure = ["socket","token"]`** (a deliberate step, never a side effect):

1. Confirm the op is `effect = "read"`, `role = "viewer"` (or the lowest role that should see it), and that its
   output schema types every free-text field `untrusted`.
2. Edit `exposure` in `operations.toml`; list `callers` so that `cli` and/or `mcp` are only present if that client
   should reach it (a token's kind must be in `callers`).
3. `just ops-v1` (regenerates `apps/bothy-ops/generated/`); `python3 scripts/gen-ops-v1.py --check` must pass. The
   generated router for a token op is one exact `Path()` with **no** `sso-<role>` gate (the service verifies the
   bearer); it stays inert in `generated/` until the edge slice installs it.
4. Run `bash apps/bothy-ops/checks/run.sh --offline`; the goldens move only if `discover` lists the new exposure
   (regenerate with `python3 apps/bothy-ops/checks/v1_fixture.py --write` and review the diff).
5. Mint a token for the test box with `tokenctl.py create --ops <op id>`; check a 200 with it, a 403 without the op
   in its allow-list, and a 401 after `revoke`.
6. Only when the edge router is installed: update the router-count prose (`router-gates.sh`, SECURITY.md, README,
   the guide) by the invariant (zero Host rules, exact `Path()` only), not a new total.

## 2. The CLI

### 2.1 Language and packaging: the decision, with evidence

**Recommendation: Go, static binary, a thin client.** Candidates, measured or sourced:

| | Go | Rust | Python single file | Keep bash |
|---|---|---|---|---|
| Static binary, no runtime | yes (`CGO_ENABLED=0`) | yes (musl) | **no**: needs an interpreter (a zipapp or PyInstaller bundle is a different, larger thing) | n/a |
| linux amd64 and arm64 from one CI job | trivial (`GOOS`/`GOARCH`) | needs a musl cross toolchain per target | n/a | n/a |
| Speaks the current MCP spec, officially | **yes: `modelcontextprotocol/go-sdk` v1.7.0 added 2026-07-28 and v1.8.0 (2026-09-14) is current** ([releases](https://github.com/modelcontextprotocol/go-sdk/releases)) | official `rmcp` is at 3.10.0 (2026-11-12); its changelog lists "reject requests to 2026-07-28 clients" ([releases](https://github.com/modelcontextprotocol/rust-sdk/releases)). **ASSUMPTION:** that means it does not yet serve the current spec | the Python SDK exists; a bundled interpreter plus pydantic's native wheel is arch-specific | cannot speak JSON-RPC sanely |
| Direct dependencies of the MCP SDK | 6 (`jwt`, `jsonschema-go`, `segmentio/encoding`, `uritemplate`, `oauth2`, `x/time`; from its `go.mod`) | larger tree (tokio, serde, ...) **ASSUMPTION** | pydantic, httpx, anyio... | none |
| Startup | measured here: helm (Go) 38 ms, flyctl (Go) 299 ms | measured: `just` (Rust) 0.7 ms | measured: `python3 -I -c pass` 13.9 ms before any import | ms |
| Size | measured: helm 62 MB, kubectl 57 MB, flyctl 111 MB, k9s 126 MB, all static Go **because they embed Kubernetes or API client trees**; Rust `just` 6 MB. A client that is `net/http` + a CLI library + the MCP SDK should be **about 10 to 16 MB stripped. ASSUMPTION: measure in slice 1; budget below** | smallest | n/a | n/a |
| Who can contribute | moderate; the repo is Python and TypeScript, so Go is a **third language**. Judgement: the Go surface is small (a client) and typed | smallest pool, steepest | everyone already here | everyone, until it must parse JSON |
| Comparable tools | `docker compose`, `tilt`, `talosctl`, `flyctl`, `k3s` are all **Go** (repository languages queried with the GitHub API on 2026-11-16: [compose](https://github.com/docker/compose), [tilt](https://github.com/tilt-dev/tilt), [talos](https://github.com/siderolabs/talos), [flyctl](https://github.com/superfly/flyctl), [k3s](https://github.com/k3s-io/k3s)) | `just` is Rust ([casey/just](https://github.com/casey/just)) | none of the five | none |

Two lessons the measurements add, both worth a CI budget: **(1) size follows dependencies, not language**
(flyctl at 111 MB and 299 ms to print its version is the cautionary tale: the cost is start-up work and embedded
trees, and a thin client avoids both by not linking client-go or a cloud SDK). **(2)** Python's 14 ms is only the
interpreter; real imports of an MCP SDK are slower, and the interpreter must be present, which on a Compose
host under 4 GiB is true but on a macOS or Windows client is not.

**Why not simply keep the Python the updater already is.** The updater is **the server side** and stays Python.
The CLI is the part that runs on a laptop, on a mac, on a box with no checkout, and as `ssh box bothy mcp`; there
the absence of a runtime is the feature. A Python CLI would be a second way of failing to start on exactly the
machines this plan is about.

**Why not Rust.** It is the better systems language and the smaller binary, and I would pick it if this were a
daemon. The deciding facts are narrower: the current MCP spec is served by the Go SDK today and, as far as I can
tell, not yet by the Rust one; and the maintainer's cost of a third language is lower for a typed client of a
few thousand lines in the language the ecosystem's operators already read.

**Guard rails that make "Go as a third language" safe:**

* **Dependency budget:** direct dependencies are a list in `go.mod`, a CI check refuses a new one without a
  line in the PR (the repo's `portability.baseline` and `served-secrets.baseline` pattern: accept the current set,
  fail on new). Expected set: a CLI library (cobra, for completion and help), the MCP SDK, `x/term`, `x/sys`.
* **Size and speed budget in CI:** `bothy version` under 50 ms; linux/amd64 under 25 MiB stripped; both are
  failing checks, with the measured number recorded the way `footprint-and-budgets.md` records memory.
* **`govulncheck`** on every PR and weekly; builds use `-trimpath` and a pinned toolchain so two builds of one
  commit produce one hash (a CI check, 2.2).
* **No business logic in Go**: any `if` that decides whether something is allowed lives in the server. The Go
  code parses, renders, confirms and talks. This is what keeps the Go/Python schema contract small (section 8, R-C1).

### 2.2 Release process, signatures and provenance (an honest take)

**Pipeline** (added to the existing `release.yml` after the tag step, which already waits for CI, Install and
Upgrade to be green on one commit):

1. Build `bothy` for `linux/amd64` and `linux/arm64` (required, tested), plus `darwin/arm64`, `darwin/amd64` and
   `windows/amd64` as **client-only** targets (they cannot manage a local box; they manage a remote one through
   a context, 2.10). Client targets are built and smoke-tested with `bothy version` only.
2. Assets named `bothy_<version>_<os>_<arch>.tar.gz` (`.zip` on Windows), plus `checksums.txt` (SHA-256),
   plus an SBOM (SPDX or CycloneDX, generated, not hand-written). That naming also makes
   `mise use github:YehudaBriskman/Bothy` work with no packaging effort (**ASSUMPTION:** mise's GitHub backend
   resolves by that convention; check in slice 1).
3. **A GitHub build-provenance attestation** for each archive (`actions/attest-build-provenance`, needs
   `id-token: write` and `attestations: write`; verification is `gh attestation verify <file> -R <owner>/<repo>`;
   [GitHub docs](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)).
4. **A reproducibility check:** build twice from the same commit and toolchain, compare hashes. Free in Go with
   `-trimpath`; it turns "the binary is what the source says" from a claim into a test.
5. The release's own-code updater (`owncode.py`) additionally downloads, verifies and **caches the matching CLI
   binary on the box** during a Bothy update (2.4), so skew and air-gap have a local answer.

**The honest cost/value take, for a solo maintainer:**

| Control | Cost | What it actually buys | Verdict |
|---|---|---|---|
| `checksums.txt` | 0 | integrity against corruption and a bad CDN node; **not** against a compromised release, because the checksum is published beside the file | do it, say what it is |
| **The installer pins the sha256 inside `bothy.sh`** (extends today's pinned commit SHA) | one follow-up PR per release (the pin PR already exists as a manual step; `installer-pin.sh` holds it) | tamper-evidence for anyone who read the script first, which is the documented path | **do it: this is the control that matters** |
| GitHub artifact attestation | about an hour; two permissions | a signed statement "this archive was built by this workflow at this commit", checkable with `gh` | **do it**: best value per minute |
| cosign keyless signing of `checksums.txt` (GoReleaser can do it, [docs](https://goreleaser.com/customization/sign/)) | a few lines plus a pinned identity string in the docs; verifier must install cosign | the same claim as the attestation, by a second, more portable tool; depends on Sigstore's public-good services for fresh verification ([cosign docs](https://docs.sigstore.dev/cosign/verifying/verify/)) | **skip in v1**; it duplicates the attestation for a solo project |
| SLSA level targeting, a dedicated signing key, a transparency monitor, two-person release | days and a custody problem (a long-lived signing key is a new secret to lose) | assurance against an attacker who already controls the repo's Actions | **not worth it now.** The real risk is the maintainer's account and workflow integrity: keep passkeys/2FA, branch and tag protection, actions pinned by SHA, `release` environment with a required reviewer even if it is yourself (a deliberate pause) |

The attestation proves **where it was built**, not that the **source was reviewed**; "deploy only what is
reviewed" is still held by branch protection and the green-check gate, not by any signature.

### 2.3 The install one-liner and its risks

```
curl -fsSL https://raw.githubusercontent.com/YehudaBriskman/Bothy/main/scripts/bothy.sh -o bothy.sh
less bothy.sh        # short; names every path it writes
sh bothy.sh          # downloads the pinned bothy for this os/arch, verifies, installs, prints `bothy install`
```

* **Keep the existing order** (download, read, run); `curl ... | sh` stays "the convenience, not the documented
  path", as `bothy.sh` already says. A piped installer cannot be read first and truncation mid-download can run half
  a script (mitigation: the script defines everything in functions and calls `main` on the last line).
* `bothy.sh` stays **POSIX sh, no bashisms** (dash on Ubuntu), and now does: detect `uname -sm`, fetch the
  archive and `checksums.txt` for the **pinned** version, compare with the sha256 **embedded in the script**,
  install to `~/.local/bin` (or `/usr/local/bin` with `sudo` only if asked), print the next command. It does not
  start anything, generate a secret or write outside `$HOME` unless told: unchanged from today's contract.
* If `gh` is present it also runs `gh attestation verify`; if not, it says that step was skipped.
* **Residual risks, named:** the pin and the script come from the same repo (a compromised repo can change both),
  so the out-of-band hash `security-model.md` 6.3 asks for matters: publish the installer's hash on a second
  surface the owner controls (a release note, a pinned issue, the docs site). **Packages:** a `.deb`/`.rpm` or a
  Homebrew tap is possible with GoReleaser, but an apt repository is hosting and signing work, and a package
  runs maintainer scripts as root. **Not v1**; the asset naming above is what lets `mise`/`ubi` users install
  without it.

### 2.4 Self-update, and the `upgrade` versus `self-update` confusion

Today (`the-cli.md`): `bothy upgrade` updates the box; `bothy self-update` copies the checkout's script over the
`bothy` on PATH; they are separate **because the CLI is a copy of a file in a repository**. That reason
disappears: a release binary is independent of any checkout. So the confusion is resolved by **naming**, not
by explaining:

| Today | In the new CLI | Why |
|---|---|---|
| `bothy upgrade` | **`bothy update apply bothy`** (the own-code component), with `bothy upgrade` kept as a **deprecated alias for two releases** that prints the new spelling | "upgrade" and "update" mean the same word to a reader; the box's updates all live under one noun, `update` |
| `bothy self-update` | **`bothy self update`** (`--check`, `--from-box`, `--version v...`) | the CLI updating itself is a property of `self`, never confused with the box |
| `bothy version` | `bothy version` (client, server, API, skew verdict) | one place to see both halves |

Mechanics of `bothy self update`: download the archive for this os/arch **from the box** (`--from-box`, default
when a context is configured: the box holds the CLI that matches it, verified when the box did its own-code update)
or from GitHub Releases; verify the sha256 against `checksums.txt` and, with `gh`, the attestation; write beside
the target and `rename(2)` into place (the existing script's reason: a half-written interpreter cannot repair
itself; a half-written static binary is the same hazard); refuse if the running binary's path is not writable
rather than choosing another path (the existing rule). It never runs as part of `bothy update apply bothy`; the
two are separate on purpose and `bothy version` says when they have drifted.

### 2.5 Version skew between CLI and server

* Every request carries `Bothy-Client: cli/<version> api=1`; every response carries `Bothy-Server: <version>
  api=1 min-client=<x>`. `GET /-/api/v1/discover` is the capability list.
* **Rules:** (1) the CLI never sends an op the server's `discover` does not list; it prints `this box runs Bothy
  2026.9.0, which has no "module add"; update the box or use CLI 2026.9.x`. (2) If the server's `min-client` is
  above the CLI, **reads continue, writes are refused** with `skew.client-too-old` and the exact `bothy self
  update` command. (3) A CLI newer than the server is fine for everything `discover` lists. (4) Unknown fields
  in a response are ignored; a missing required field is an error naming the field. (5) **Never run a write when
  skew is unknown** (an unreachable `discover` means read-only mode).
* This is the posture Kubernetes takes with `kubectl`, supported within one minor either side of the API server
  ([version skew policy](https://kubernetes.io/releases/version-skew-policy/)), but enforced by capability
  discovery rather than by a published matrix, because Bothy has one maintainer and no matrix.

### 2.6 Offline and air-gapped behaviour

* **No verb needs the internet except those whose purpose is the internet:** `update check` (discovery),
  `self update` from GitHub, `install` fetching k3s and charts. Everything else works from local state.
* `status`, `update status`, `update plan`, `doctor`, `logs`, `events`, `job *`, `settings get` read local or box
  state. Discovery's staleness is already a first-class fact (the page calls it stale after two missed runs); the
  CLI prints `discovery: 31 h old (offline?)` and still answers, with exit `0`.
* `update apply` of a plan whose images are not local fails **at preflight**, before anything changes, with the
  pull list and `bothy download`'s replacement (`bothy bundle` is the air-gap story and is **out of v1**; the
  k3s images-tarball route is noted in `install-and-bootstrap.md` s3).
* `bothy self update --from-box` and `--file <archive>` work with no GitHub at all; the sha256 is checked against
  the box's recorded value.

### 2.7 The command tree

**Grammar:** `bothy <noun> <verb>`, with a short list of top-level verbs for the commonest daily acts (the shape
`docker`, `fly` and `talosctl` converge on). A word that is not a verb is refused by name, with the usage (today's
rule: "a dispatcher that passed unknown words through would be a way to run arbitrary recipes by typo").

```
Daily
  bothy status [--watch] [--urls]        the one health view: modules, jobs, updates, backups, alerts, drift
  bothy up [module...]                   converge to the desired state (compose: runs the recipe; k3s: applies modules)
  bothy down [module...]                 stop workloads, keep data (never k3s itself unless --runtime)
  bothy ps                               alias of `status --containers`
  bothy logs <module|component> [-f] [--since 1h] [--lines 200]
  bothy events [-f] [--since <cursor|1h>] [--type job|audit|health|discovery]
  bothy doctor [--pre] [--strict] [--fix [--dry-run]]
  bothy verify                           the edge routing checks (today `just verify`); `check` is an alias
  bothy urls                             what answers where
Install (host only)
  bothy install [--mode mini|standard|full|custom] [--reach tailscale|ssh|both|local] [--dry-run]
  bothy uninstall [--purge]              typed confirmation; keeps PVCs and keys unless --purge
  bothy admin init | reset               first credential (claim token), host-only reset
Modes and modules
  bothy mode show | set <mode> [--dry-run]
  bothy module list | show <id> | enable <id> | disable <id> | add <dir|url> | remove <id> | purge-data <id> | health <id>
Updates (section 4)
  bothy update status [<component>] [--unreleased] [--tonight]
  bothy update check                     run discovery now (the "check for updates now" ask)
  bothy update plan <component|--group g> [--dry-run is implicit]
  bothy update apply <component> --plan <id> [--confirm <id>] [--wait]
  bothy update apply-group <recipe> --plan <id> --confirm <recipe> [--wait]
  bothy update rollback <component> [--to <revision>] --plan <id>      (new; section 4.6)
  bothy update history [<component>] [--limit 20]
  bothy update hold <c> [--until <date>] --reason "..." | unhold <c>
  bothy update channel <c> auto|notify|manual                          (tighten-only; ceiling is the catalog's)
  bothy update window set --days mon-fri --from 03:30 --to 05:00 | show
  bothy update skip <c> <version>        hide an upstream version on this box (display only; see 4.3)
  bothy update pauses | unpause <c>      (today's `update-pauses`, `update-unpause`)
Jobs and approvals
  bothy job list | show <id> | wait <id> [--timeout 30m] | logs <id> | cancel <id>
  bothy job approve <id> | deny <id>     TTY or session only; refuses a token
Data
  bothy backup list | run | verify <id> | restore <kind> <id> --plan <id>
  bothy settings list | get <key> | set <key> <value> [--dry-run] | diff | schema <module>
  bothy secrets list | set <key> (value on /dev/tty) | generate <key> | rotate <key> | delete <key>   (never prints a value)
  bothy config export | import         host only: the age-encrypted bundle
Access
  bothy token create --kind cli|mcp --role viewer|operator [--ttl 30d] [--ops a,b] [--name n] | list | revoke <id>   (create is host-only)
  bothy context add <name> --url <u> [--token-file f] | list | use <name> | rm <name>
  bothy kubeconfig issue collector|headlamp|ops|prom|oci-grafana [--rotate|--revoke]    (host only; the `just *-token` recipes)
Platform
  bothy mcp [--read-only (default)] [--allow tool,tool] [--write]      stdio MCP server (section 3)
  bothy dev [dir] [--keep]               module author loop (2.9)
  bothy self update [--check|--from-box|--file f] | bothy version | bothy completion bash|zsh|fish
  bothy psql                             convenience, host only (compose: `just psql`)
```

**Global flags:** `--context <name>`, `--json` (or `-o json`), `--no-color` (also `NO_COLOR`), `-q/--quiet`,
`--yes` (click tier only), `--timeout`, `--insecure-http` (see below).

**Output modes.** Human is the default on a TTY: aligned, one-screen, never a wall; a `status` fits 24 lines for a
healthy mini. `--json` emits the API envelope unchanged (so a script parses what the MCP server returns), one
document per invocation; streaming verbs (`logs -f`, `events -f`) emit JSON Lines. Human output is **not** a
stable interface; `--json` is, and carries `apiVersion`. Text that came from a third party is printed with control
characters and ANSI escapes stripped, so a log line cannot repaint the terminal.

**Exit codes** (stable; a script can branch without parsing):

| Code | Meaning |
|---|---|
| 0 | success, or nothing to do (including "already applied") |
| 1 | failure not covered below |
| 2 | usage error |
| 3 | box unreachable or API down (`status` still prints what the host knows) |
| 4 | unauthenticated or forbidden |
| 5 | refused by a precondition (plan refused, stale plan, dirty tree, no backup, skew, busy) |
| 6 | needs a confirmation or approval that was not given (non-interactive without `--confirm`, or `awaiting_approval`) |
| 7 | applied but verification failed |
| 8 | failed and **rolled back** cleanly |
| 9 | rollback itself failed: a human must act now |
| 10 | `--wait` timed out (the job is still running) |
| 20 | `doctor`/`status --strict`: warnings present |
| 21 | `doctor`: a fault present |

**Idempotency and plan-first.** `up`, `enable`, `hold`, `channel`, `set` converge and report `changed: false` with
exit `0` when there is nothing to do. **Every `effect != read` verb has `--dry-run`**, which is the API's
`dry_run=true`: it returns the plan or diff and exits. On a TTY, `apply` shows the plan then asks; off a TTY it
requires `--plan <id>` (the plan the human saw; a stale id is refused `plan.stale`, exactly the executor's rule) and,
for `type-name` plans, `--confirm <exact id>`. There is no verb that both computes and applies in one silent step
without having shown the plan.

**Tokens over plain HTTP.** The CLI refuses to send a bearer token to an `http://` URL that is not loopback or
inside the carrier-grade NAT range Tailscale assigns from (RFC 6598), unless `--insecure-http`. Access is `IP:port` over plain HTTP by
decision, and a token on a LAN is a sniffable credential (the same reason `modes-and-modules.md` s3 warns about the
first-run password); inside the tailnet the transport is already encrypted.

**Completion.** `bothy completion bash|zsh|fish` from the CLI library; component ids, module ids and job ids are
completed **from `discover`** (a closed catalog, so completion is exact and cannot suggest a string the server
refuses).

### 2.8 Every `just` recipe a user needs, as a `bothy` verb

| `just` recipe | `bothy` | Driver in v1 | Notes |
|---|---|---|---|
| `up`, `up-edge`, `up-data`, `up-auth`, `up-monitoring`, `up-apps` | `up [module]` | `just` (compose) / API (k3s) | `up-*` are internal steps of `up`; a user says a module |
| `down`, `down-headlamp` | `down [module]` | same | |
| `ps` | `ps` / `status` | `just` | |
| `logs <svc>` | `logs <id>` | `just` -> API | `logs` over MCP is untrusted text (3.4) |
| `doctor [strict]` | `doctor [--strict]` | `just` -> API | exit `20`/`21` |
| `verify` | `verify` (`check`) | `just` | |
| `urls` | `urls` | `just` -> API | |
| `psql` | `psql` | `just` | host only |
| `backup` | `backup run` | `just` -> API | |
| `restore-env/-grafana/-loki/-postgres/-victoriametrics` | `backup restore <kind> <id>` | `just` -> hostd | plan first; typed confirmation; the restore recipes' own refusals stay |
| `update-status`, `update-plan`, `update-groups`, `update-auto`, `update-pauses`, `update-unpause`, `updates-discover` | `update status`, `plan`, `plan --group`, (night job: `update tonight` is the dry run), `pauses`, `unpause`, `check` | hostd | section 4 |
| `install-updater` | `host install` is folded into `bothy install`; `bothy update apply bothy` switches updater copies as today | hostd | the updater "never replaces itself in the same run" rule is kept |
| `bootstrap` | step of `up`; `doctor --pre` for prerequisites | `just` | |
| `admin-client`, `admin-inventory` | `module health sso`, `credential` views in `status` | hostd | |
| `collector-token`, `headlamp-token`, `kube-token`, `kube-prom-token`, `oci-grafana-token`, `bothy-prom-route` | `kubeconfig issue <kind>` | `just` -> hostd | host only |
| `k8s-monitoring` | `update apply kube-state-metrics` / `alloy-cluster` (they are catalog components) | hostd | |
| `nuke` | `uninstall --purge` (typed); **no top-level `nuke`** | hostd | deliberate: today's table exposes it with no confirmation flag |
| `release`, `diagrams`, `dash-normalise`, `ops-wiring`, `portability`, `files-check`, `ops-check`, `settings-check`, `ci-install`, `network`, `default` | **contributor-only: stay `just`** | none | they operate on the repository, not a running box; a user never needs them |

**`just` going forward.** It stays the Compose driver and every contributor's tool. The seam in today's
`resolve()` ("moving one command off `just` is editing one line") survives: each verb names a **driver**
(`just:<recipe>` or `api:<op>`), `cli-commands.sh` asserts each resolves, and a verb moves from `just` to `api` as
the logic moves server-side. Nothing is deleted from the justfile on the strength of this plan.

### 2.9 `bothy dev`: the module author's loop

Not a second Tilt. The owner's projects already use Tilt (`projects/cvops.md`), and re-implementing its live-update
engine would be the most expensive part of the CLI for the smallest audience. `bothy dev` is the **thin, Bothy-aware
layer** on top of what exists:

1. **Validate.** Read `module.toml` in the directory; check it against the module schema and, for a user module,
   the **untrusted-module lint** of `customization.md` s5 on the *rendered* manifests or compose file (reserved
   ids, no cluster-scoped kinds, cost declared, `mem_limit` and a positive `oom_score_adj` for `runtime =
   "compose"`). Print the budget-gate arithmetic: "this adds 256 MiB; you have 4.1 GiB free".
2. **Register as an ephemeral dev module** (`bothy-dev-<id>` project or namespace), never touching the real
   module list; routes only as a host-published port from the registry (rule 1 and `hybrid-runtime.md` hard rule 1).
3. **Run the loop with the tool that does it:** for `runtime = "compose"`, `docker compose watch` with the
   `develop.watch` rules in the module's compose file (actions `sync`, `rebuild`, `sync+restart`; works only for
   services built from local source; [Compose docs](https://docs.docker.com/compose/how-tos/file-watch/));
   for `runtime = "k3s"`, hand off to Tilt if a `Tiltfile` exists, else rebuild and `helm upgrade` on change.
4. **Show what the platform will judge:** the module's health contract result (bytes, not status), its logs,
   and the events it generates.
5. **On exit remove it** (`--keep` leaves it). Nothing it created is in the real receipt, so uninstall stays clean.

It reuses the API only for validation and the budget gate (`dry_run`), so a dev module can never do more than a
user module can. `bothy dev` is **out of v1** (it needs the module declaration, #320, which does not exist); the
slot and the schema are reserved so it does not become a rewrite.

### 2.10 Local versus remote: managing another box

* **Yes, over the tailnet, through contexts**, the model `docker context` and `kubectl config` made familiar:
  `bothy context add lab --url http://<box-tailnet-ip>:<port> --token-file ~/.config/bothy/lab.token`.
  A remote context uses the **network API only**; `host-only` verbs refuse with a message naming the box and the
  one-line way to run them there (`ssh <box> bothy <verb>`; port 22 is Tailscale SSH for the install user, rule 12).
* Contexts and tokens live in `$XDG_CONFIG_HOME/bothy/` with mode `0600`; the token file is read, never
  interpolated into argv (no secret in `ps`).
* **Fleet operations (one command against many boxes) are out of scope.** One context at a time; a shell loop is
  the fleet tool. The decision is the owner's only if Bothy becomes a product for multi-box operators (D21).
* The local default context is "the socket on this machine, if there is one, else the context named in
  `BOTHY_CONTEXT`, else the legacy `BOTHY_HOME` checkout (compose driver)". `BOTHY_HOME` keeps working exactly as
  `the-cli.md` documents, including "if it is set and is not a Bothy checkout, fail there rather than falling
  through".

## 3. The MCP server

### 3.1 Transport and where it runs

The current MCP specification is **2026-07-28** (`/specification/latest` resolves to it;
[transports](https://modelcontextprotocol.io/specification/latest/basic/transports),
[streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md),
[versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning.md)). Facts that shape the design:
it is **stateless**: there is no `initialize` handshake and no session; each request carries its own `_meta`
(protocol version, client info); a server that needs input from the client mid-call returns an input-required
result and the client retries (the "MRTR" pattern); HTTP servers must validate `Origin`; HTTP authorization is
OAuth 2.1 with protected-resource metadata (RFC 9728) and resource indicators (RFC 8707)
([authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)). The Go SDK v1.7.0 added
2026-07-28 support and v1.8.0 (2026-09-14) is current; its HTTP handler is stateless only
([releases](https://github.com/modelcontextprotocol/go-sdk/releases)).

| Option | Verdict |
|---|---|
| **stdio**, spawned by the client as `bothy mcp` (local) or `ssh <box> bothy mcp` (remote, over Tailscale SSH) | **v1 default.** No listening port, no OAuth, no token on the wire; the authority is the OS user who started it. Remote use rides the SSH identity the owner already has (rule 12). |
| Streamable HTTP on the box, behind the edge | **Later**, when `sso` and TLS exist. Needs OAuth 2.1 resource-server behaviour, `Origin` checks, and token audience binding. Plain-HTTP bearer tokens on a LAN are the failure the spec's security guidance warns about ([security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices.md)). |
| A dedicated MCP container | **No.** One more always-on process and a second place to hold a credential, for a client that can spawn a binary. |

`bothy mcp` is **the same binary** as the CLI: a subcommand, so there is one release artefact and one version.

### 3.2 Read by default, write opt-in

* Default (`bothy mcp`) registers **read tools only**. `--write` (or a token scope `write`) registers the write
  tools; `--allow a,b` registers exactly those. A tool that is not registered does not exist to the model.
* Writes **never execute**: they create a job in `awaiting_approval` and return its id and the plan (1.6, rule 3).
  `tighten` ops are the one exception and run immediately.
* There is **no generic tool**: no `run_command`, no `kubectl`, no `docker`, no `read_file`, no "call any API path".
  Every tool is one catalog op with a closed schema (`component` is an enum). A prompt-injected model can only ask
  for what a person could click.

### 3.3 Example tool catalog (12)

| Tool | Scope | Effect | Input (closed) | Returns |
|---|---|---|---|---|
| `bothy_status` | read | read | `{}` | modules, health, job counts, updates summary, backup age, alerts |
| `bothy_module_list` | read | read | `{}` | modules with mode, runtime, health, cost |
| `bothy_update_status` | read | read | `{component?: enum, include_unreleased?: bool}` | rows with current, available, class, channel, `ahead_of_release` (section 4) |
| `bothy_update_plan` | read | read | `{component: enum} or {group: enum}` | the plan, every refusal with its stable code, `confirm` tier |
| `bothy_update_history` | read | read | `{component?: enum, limit?: 1..50}` | job summaries |
| `bothy_logs` | read | read | `{target: enum, since?: "15m".."24h", lines?: 1..200}` | lines wrapped as untrusted text (3.5) |
| `bothy_events` | read | read | `{since?: cursor, type?: enum}` | events |
| `bothy_settings_get` | read | read | `{key: string}` | value for a non-secret; `{set, updated, fingerprint}` for a secret; never a secret value |
| `bothy_backup_list` | read | read | `{}` | backups with age, size, verified flag |
| `bothy_update_hold` | write | tighten | `{component: enum, until?: date, reason: string<=200}` | runs now; audited; reversible |
| `bothy_update_request_apply` | write | loosen | `{component: enum, plan_id: string}` | a job in `awaiting_approval` and the `bothy job approve <id>` hint |
| `bothy_job_get` | read | read | `{id: string}` | state, steps, verdict; how the model learns an approval happened |

Sketch of one definition (annotations are derived from the catalog, and the spec treats them as **hints a client must
not trust**: [tools](https://modelcontextprotocol.io/specification/latest/server/tools)):

```json
{"name":"bothy_update_request_apply",
 "description":"Ask a human to approve applying an already-computed update plan. Does not apply anything by itself.",
 "inputSchema":{"type":"object","additionalProperties":false,
   "required":["component","plan_id"],
   "properties":{"component":{"enum":["grafana","loki","traefik","bothy"]},
                 "plan_id":{"type":"string","pattern":"^p_[a-f0-9]{16,}$"}}},
 "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}
```

(The enum in a real definition is the full closed catalog from `discover`.) Deliberately **not offered**: apply
that skips approval, `restore`, `uninstall`, `module remove`, `secrets set` (a value must not pass through a model),
`token create`, anything `host-only`, and `update apply-group` without approval (a group is a bigger blast radius).

### 3.4 Resources and prompts

* **Resources** (read-only, addressable context): `bothy://status`, `bothy://updates`, `bothy://module/<id>`,
  `bothy://job/<id>`, `bothy://docs/<topic>` (the repo's guide pages, so the model need not guess). Everything a
  tool can return is also a resource, under the same filters.
* **Prompts** (templates a person picks, not the model): `bothy-triage` ("read status, events and failing logs,
  propose, do not change anything"), `bothy-update-review` ("explain tonight's plan and what could go wrong"),
  `bothy-backup-check`. Prompts carry no authority; they are text.

### 3.5 Threat model

The assumption is that **the model is a confused deputy reading attacker-influenced text**, and that no delimiter
or system-prompt wording stops that (OWASP LLM01: the controls are privilege limits and human approval, not
filters: [LLM01 prompt injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)).

| Threat | Path | Control |
|---|---|---|
| Injected instruction in container logs, a release note, a commit title, a settings value, a file | `bothy_logs`, update notes, `settings_get` | Output typed `trust: untrusted` and fenced as data; **no tool takes free text that becomes a command**; the worst an injection can do is call a registered tool, so the tool list is the blast radius |
| Model asks for apply / restore / remove | write tools | Never executes: `awaiting_approval`; approval credential kinds the model cannot hold (1.6 rule 3) |
| **Same-uid bypass:** the stdio server runs as the install user, who can also open the host socket | a compromised MCP process calling the socket | `bothy mcp` is built with an **API-only backend** and no socket code; a CI check runs `go list -deps` on the `mcp` package and fails if the socket client is reachable; the MCP token is a separate credential kind. **Honest limit:** a model with a shell tool in the same client runs as the same user and could run `bothy` itself. So: do not give an agent both a shell and Bothy's write scope on one account. The guide says so |
| Secret exfiltration | `settings_get`, logs, errors | Secrets are **never returned by any non-host surface** (settings-store rule); errors and logs pass the existing redaction; `args_digest` in audit |
| Approval fatigue / auto-accept | client elicitation | Authority never rests on elicitation (1.6 rule 5); approval is out of band |
| Rate abuse, loops | any tool | Token bucket per token (ASSUMPTION: 60 reads/min, 6 writes/hour, tune in the lab); one outstanding approval per component; `busy.job-running` |
| Token theft | stdio env or file | Minted on the box, mode `0600`, TTL default 30 days, revocable, bound to a role and an op allow-list; checked per request (the spec is stateless) |
| Tool poisoning via another MCP server in the same client | other servers | Out of Bothy's control; the guide says which tools are write-capable so a user can scope them |
| Audit confusion | caller identity | `caller.kind = mcp` from the credential, `human = false`; client name recorded as an untrusted label |

### 3.6 Audit by caller kind

Every MCP call writes one row (`surface = mcp`, section 1.7), reads included, with `args_digest`, outcome and
latency. Settings > Audit log filters by caller kind, so "show me everything an agent did last week" is one click.
Approvals record **both** identities: who asked (the mcp token) and who approved (the session).

## 4. Update controls as a product surface

A user must be able to **see** what is true, **decide** within limits, and **do** it, identically from UI, CLI and
MCP, and no convenience may loosen the reviewed policy.

### 4.1 See: one status row, one vocabulary

| Field | Meaning | Source |
|---|---|---|
| `running` | version actually running | probe |
| `pinned` | what `main` pins (what the box may deploy) | repo |
| `available` | newest upstream version and its class (`patch`, `minor`, `major`) | discovery |
| `state` | `current`, `apply-ready`, `held`, `blocked(reason-code)`, `scheduled(tonight)`, `needs-pull` | plan |
| `policy` | effective channel, window, hold, from the catalog plus overlay | `updates.toml` + overlay |

### 4.2 Lesson (a): the own-code row that says "up to date" while `main` is ahead

Today the `bothy` row compares the running tag with the **newest green release tag** and says up to date. That is
correct under "deploy only a reviewed, green, tagged release", and misleading when `main` is many commits ahead
with no tag cut (this worktree: 138 commits past `v2026.9.0`). The fix is **to show a fact, not to change the rule**:

* The own-code row gains `unreleased: {commits_ahead: 138, since_tag: "v2026.9.0", latest_main: "<sha7>",
  release_blocked_by: "none|ci-red|install-red|upgrade-red|version-not-bumped", last_tag_attempt: "..."}`, computed by
  the existing discovery job from `git rev-list --count` and the check runs `owncode.py` already reads.
* The label becomes **"Up to date with the latest release (v2026.9.0). main is 138 commits ahead, not released:
  [why]"**. `release_blocked_by` turns a mystery into a cause; usually `version-not-bumped`, because `release.yml`
  tags only when `VERSION` changed on a green commit.
* **No new deploy path.** A user who wants the tip has two honest options, both existing: cut the release (a PR
  bumping `VERSION`), or use the VM lab. A "deploy main anyway" button is **refused by design**: it would delete the
  decided rule "deploy only what main pins or a green release tag".
* Over MCP the field is `ahead_of_release`, so an agent can say "138 commits behind; release blocked by X" instead of
  "up to date".
* An optional notice posts the gap to the event feed past N commits or M days (ASSUMPTION N=50, M=30), off by default.

### 4.3 Decide: controls, and the rule that they only tighten

User-set controls live in `settings` (module `updates`) as an **overlay** the executor intersects with
`updates.toml`. The merge is monotone: an overlay may move a component toward `manual`, shorten the window, add a
hold or a skip; it **cannot** raise an `auto` ceiling, widen a window, or enable a class the catalog forbids. An
unreadable or invalid overlay fails closed (everything `manual`) and emits an event. That is why `channel`, `hold`
and `window` are `effect = tighten` and may run from MCP without approval.

| Control | Scope | Rule |
|---|---|---|
| Channel `auto` / `notify` / `manual` | per component | down-only relative to `updates.toml`; `auto` legal only for `AUTO_CLASSES`; **any major is manual**, unchangeable |
| Window (days, from, to) | global, per-component narrowing | inside the catalog's window |
| Hold `--until` | per component | stops auto and scheduled runs; an explicit apply still works with a warning |
| Skip a version | per component, per version | **display only**: never blocks a security-flagged version from the plan |
| Pause (auto-pause on failure) | per component | set by the system; cleared only by `unpause` |
| Max per night | global | `max_auto_per_night`, tighten only |

### 4.4 Do: apply, with the two guarantees

`update plan` is always shown first. `update apply` takes `--plan <id>`; the executor **re-derives the plan** and
refuses a stale id. `confirm` is chosen by the plan: `click` for stateless classes, `type-name` where the plan says
(`database`, `app-db`, `timeseries`, `own-code`). Backup-before-act, verify bytes and automatic rollback belong to the
executor, not the surface; the verdict is the job state with the exit codes of 2.7.

### 4.5 Lesson (b): apply refused because the recipe would recreate other services

Today this is prose ("applying X would recreate Y and Z; use the group flow"). The product makes it a **structured,
actionable refusal**:

```json
{"ok":false,"error":{"code":"scope.group-available",
 "message":"Applying alloy would also recreate loki and victoriametrics (same compose recipe).",
 "details":{"component":"alloy","recipe":"monitoring","would_recreate":["loki","victoriametrics"],
            "group":"monitoring","group_class":"timeseries","group_confirm":"type-name",
            "group_plan_id":"p_...","rollback":"all-or-nothing"},
 "hint":"bothy update plan --group monitoring"}}
```

* **Group-apply, explained once for a human:** a group is **every component that shares one compose recipe**, because
  the recipe recreates them together. Its class is the **union** of its members' (the riskiest wins), the
  confirmation is **typing the recipe name**, the pre-update backups cover every member, and rollback is
  **all-or-nothing**: if any member fails verification, every member is restored. A group whose members differ only
  by **config drift** (not by a version) is refused `scope.config-drift`, because applying it would change files
  nobody reviewed as an update.
* **UI:** a card with the list, one button "Plan the group", and the typed-name field. **CLI:** prints the exact next
  command and exits `5`; with `--offer-group` on a TTY it asks, shows the group plan, then asks for the recipe name.
  **MCP:** the code and `details` come back; the agent proposes the group plan and may call
  `bothy_update_request_apply` with `{group, plan_id}`, still `awaiting_approval`.
* A component whose recipe has a single member never sees this; its plan says "recreates only itself".

### 4.6 Reconciling with `updates.toml` and the cluster Job updater

| Concern | Compose (Docker modules, hostd) | k3s core (in-cluster `bothy-update` Job) |
|---|---|---|
| Classes and channels | `updates.toml` | the **same file**, read by the same planner |
| Plan | `plans.py` computes, hashes, writes `plans/*.json` | the same planner emits an image or values diff; same plan id and schema |
| Execute | host updater: pull, backup, recreate, verify bytes, rollback | Job: atomic Helm upgrade after a PVC snapshot; verify; Helm rollback |
| Rollback verb | **gap:** `update-rollback` is documented and absent; **slice 3** adds `update rollback <component> [--to]` over the pre-update snapshot and previous digest, plan-first and typed | the same verb |
| Record | `history.jsonl` | the same row, written through the Job's ConfigMap |

The three surfaces never see the difference: `job` and `plan` are one shape. Where runtimes differ in capability,
`discover` says so and the verb is refused `precondition.runtime`.

## 5. "Almost an OS": what is in and out of v1

**IN** = the first release that deserves the name; **LATER** = designed, not built; **OUT** = deliberately not.

| Item | v1 | Reason |
|---|---|---|
| **Status** (one health view, `--watch`, `--json`) | **IN** | The front door of all three surfaces and the cheapest slice; everything else is judged against what it shows |
| **Events and logs** | **IN (read)**; aggregation stays Loki | Events are the audit and job feed already written; logs are Loki's job (rule 3). The CLI reads, it does not store |
| **Backup / restore** | **IN: list, run, verify**; **restore LATER** (slice 3) | Restore is the most destructive verb and needs the VM-proven plan, backup, act, verify path first; the `restore-*` recipes stay under `just` meanwhile |
| **Settings / secrets** | **IN**: list, get, set, schema; secrets set/generate/rotate; **decrypt only on the host CLI** | The library is merged (#360); the CLI is its first real caller; the age export/import is LATER |
| **Module add / remove** | **LATER** (slice 4); list/show/enable/disable of built-in modules IN | Needs the module declaration (#320) and the untrusted-module lint; remove must honour keep-data-by-default |
| **`doctor --fix` boundaries** | **IN: read-only `doctor` and `--fix --dry-run`**; `--fix` limited to an allow-list of **reversible, local** repairs (recreate a missing network, restart a crashed non-database container, regenerate a derived file) | A fixer that touches data, credentials, firewall, tailnet or anything not undone by re-running is **OUT**; `--fix` never runs from MCP |
| **Module API / manifest** | **LATER**; schema reserved | Publishing it freezes it; wait until two built-in modules use it |
| **Jobs and scheduling** | **IN: jobs** (list, show, wait, approve); scheduling stays the night timer | A general scheduler is a product of its own; the one schedule (the update window) is catalog policy |
| **Notifications** | **LATER**: the event feed is IN; delivery (email, push, webhook) one adapter at a time | Delivery needs credentials and a decision on where they live; Alertmanager already exists for alerts (rule 3) |
| Fleet and multi-box, RBAC beyond three roles, a plugin marketplace, a general cron, a shell into containers | **OUT** | Each is a different product; `kubectl exec` and `docker exec` exist for the owner |

## 6. The thin first slice

**Goal:** prove the shape (catalog, API, CLI and MCP) with the least that is still real, on the VM lab first and the
live box last.

### 6.1 Scope

1. `operations.toml` with **eight ops**: `status`, `module.list`, `update.status`, `update.plan`, `update.history`,
   `job.get`, `events.query`, `settings.get`; plus the generator and its drift check.
2. `GET /-/api/v1/discover` and the envelope; the eight ops served by the existing `bothy-ops` (thin adapters over
   `updates.py`, status and the settings library).
3. The Go binary: `status`, `update status|plan|history`, `job show|wait`, `events`, `settings get|list`, `version`,
   `context`, `completion`, `mcp` (read-only, stdio), `self update --check`. Human and `--json`; exit codes 0 to 5 and 10.
4. Release pipeline: two linux targets, `checksums.txt`, attestation, reproducibility check, the `bothy.sh` pin.
5. The own-code `unreleased` fact (4.2) in `update.status`.

### 6.2 Acceptance tests

| # | Test | Passes when |
|---|---|---|
| T1 | Catalog drift | regenerating routers and the tool list from `operations.toml` yields no diff |
| T2 | Surface parity | for each of the eight ops, the web response, `--json` and the MCP tool return the same `data` (golden files) |
| T3 | No writes | with a `viewer` token every `POST` is `auth.forbidden`; `bothy mcp` default lists zero write tools |
| T4 | Skew | a CLI against a fake higher `min-client` runs reads and refuses writes with the exact `self update` hint |
| T5 | Untrusted text | a log line with an ANSI clear-screen and "ignore previous instructions" is stripped in the CLI and `trust: untrusted` in MCP |
| T6 | No socket from MCP | `go list -deps` of the `mcp` package contains no socket client; a failing check on violation |
| T7 | Plan fidelity | `update plan` equals the planner's golden file for a stateless, a database and a grouped component, including `scope.group-available` |
| T8 | Unreleased fact | a fixture repo 5 commits past a tag reports `commits_ahead: 5` and the right `release_blocked_by` |
| T9 | Release | the two archives reproduce byte for byte; `gh attestation verify` passes; the pinned sha in `bothy.sh` matches; `bothy version` under 50 ms and size under budget |
| T10 | Lab | on the VM lab, `bothy update plan grafana --json` from a remote context returns the same plan id as the UI, with the exit codes of the table |

### 6.3 What the slice does not do

No `apply`, no approval flow, no tokens beyond one read token, no `restore`, no module add/remove, no `bothy dev`, no
streamable-HTTP MCP, no Windows or macOS target beyond building, no Keycloak flow, no k3s executor change. The `just`
recipes are untouched.

### 6.4 The next three slices

| Slice | Content | Gate |
|---|---|---|
| **2 Writes with approval** | `tighten` ops (hold, channel, window) on all surfaces; `update apply` and `apply-group` through the spool; the `awaiting_approval` state, `job approve`, token kinds, the unified audit row | an `mcp` token cannot approve; a replayed `plan_id` is refused |
| **3 Rollback and backup** | `update rollback`, `backup run/verify/restore`, `doctor --fix --dry-run`; closes the documented-but-absent recipe | VM-proven restore, then the live box |
| **4 Modules and dev** | module declaration (#320) coupling, `module add/remove`, `bothy dev` for compose modules, MCP streamable HTTP behind `sso` | VM lab; the lint refuses the hostile-module fixtures |

### 6.5 Estimate and biggest risk

**About 17 focused days** (ASSUMPTION; slice 1 only, one person, including the review and rework the repo's gates
impose): catalog and generator 3, API adapters and envelope 3, Go CLI and rendering 5, MCP read-only 1.5, release
pipeline and pins 2.5, `unreleased` fact 1, lab acceptance 1. Slices 2 to 4 are each larger.

**Biggest risk: contract drift between the Python that writes JSON and the Go that reads it**, which shows up as a CLI
that works on today's box and breaks after the next update. Mitigations: the Go side decodes loosely and ignores
unknown fields; the golden files in T2 and T7 are generated **from the Python** and consumed by Go tests; `discover`
carries the API version. Fallback: generate the Go types from the OpenAPI document the catalog emits.

## 7. Decisions for the owner

Numbered to continue `README.md` (D1 to D14). **Accepted by the owner on 2026-11-16 ("yes, go on" to this table as written): D15 to D28 are decided with the recommendation in each row. D15 was re-examined and kept on 2026-11-17 (`cli-language-reassessment.md`). D40 to D43 are in s1.8.** The "if the owner disagrees" column stays as the record of what the alternative would have cost. Anything the owner wants changed later is a new decision, not an edit to this one.

| # | Question | Recommendation | Evidence | If the owner disagrees |
|---|---|---|---|---|
| D15 | CLI language | Go, thin client | 2.1: the official SDK serves the current MCP spec; peers are Go; no runtime needed | Rust: smaller binary, wait for SDK support (ASSUMPTION it lags), 1 to 2 weeks more in slice 1; Python: needs an interpreter; bash: no MCP |
| D16 | One API for all surfaces, generated from a catalog | Yes: `operations.toml`, exact-`Path()` `/-/api/v1` | 1.1; `catalog.toml` already works this way | Per-surface APIs: three implementations that drift; checks and audit become three jobs |
| D17 | Python updater stays as `bothy-hostd`, not ported | Keep | 1.5: 8,800 reviewed lines, the only battle-tested part | Port to Go: months, forks the refusals in `updates.md`; worthwhile only if Python on the host is dropped |
| D18 | MCP transport | stdio first (local or over SSH); HTTP only with `sso` and TLS | 3.1 | HTTP now: OAuth resource-server work and plain-HTTP risk, about 10 more days |
| D19 | Agent writes need out-of-band human approval, whatever the plan says | Yes, `loosen` and `destructive` always | 1.6, 3.5 | A click in the client: authority then rests on elicitation, which the server cannot verify |
| D20 | Tighten-only user overlay on `updates.toml` | Yes | 4.3 | Letting users widen weakens "deploy only what is reviewed" and the class gates |
| D21 | Fleet or multi-box management | Out of scope (contexts, one box at a time) | 2.10 | A coordination layer and a larger blast radius; a separate plan |
| D22 | Signing and provenance | `checksums.txt`, pinned sha in `bothy.sh`, GitHub attestation; no cosign or SLSA push | 2.2 | Cosign duplicates the attestation and adds a tool users must install |
| D23 | Show "main is N commits ahead" and the blocker; never offer "deploy main" | Yes | 4.2 | A deploy-main button breaks a decided rule; lower the cost of cutting a release instead |
| D24 | Rename `upgrade` to `update apply bothy` and `self-update` to `self update`, alias for two releases | Yes | 2.4 | Keeping both names keeps the confusion and documents it |
| D25 | Add the missing `update rollback` verb (slice 3) | Yes | 0.1: documented, absent | Automatic-only rollback leaves a deliberate undo to manual compose and snapshots |
| D26 | Hash-chained audit rows | Yes; cut first if time is short | 1.7 | Plain append-only loses tamper-evidence against the API process only |
| D27 | Platform packages (`.deb`, tap) | Not in v1; assets named for `mise` and `ubi` | 2.3 | Packaging means signing, hosting and root maintainer scripts |
| D28 | Slice 1 is read-only (no apply) | Yes | 6.3 | Including apply pulls the approval design into slice 1: about 8 more days and a larger review |

## 8. Risks, and what the research undermines

| Id | Risk | Mitigation |
|---|---|---|
| R-C1 | Python and Go contract drift (6.5) | golden files from Python; loose decoding; OpenAPI fallback |
| R-C2 | A same-uid agent runs the CLI itself, bypassing MCP scoping | say so in the guide; a separate account is advised; approval still needs a TTY or a session |
| R-C3 | A third language raises contributor cost | no logic in Go; dependency and size budgets; `just` stays for contributors |
| R-C4 | Plain-HTTP bearer tokens on a LAN | the CLI refuses by default; the tailnet encrypts; HTTPS with `sso` |
| R-C5 | The operation catalog becomes a bottleneck | one table plus one handler per op, the cost kube actions already pay |
| R-C6 | The MCP spec moves again | statelessness is the spec's direction; the SDK pins; `discover` hides the version from the model |

**Does the research undermine anything decided?** Nothing is reversed. Two tensions to surface. (1) "A request is a
component id from a closed catalog" assumed the browser is the only caller; the CLI and MCP make the closed enum a
first-class API rule, which this plan adopts rather than relaxes. (2) "Settings store option A" plus "host-only
decrypt" means a remote CLI can never reveal a secret; that is intended but the user guide must say it, because
`bothy settings get` looks symmetrical across contexts.

## 9. Sources

* MCP specification 2026-07-28: [transports](https://modelcontextprotocol.io/specification/latest/basic/transports), [streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md), [tools](https://modelcontextprotocol.io/specification/latest/server/tools), [authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization), [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning.md), [security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices.md)
* OWASP: [LLM01 prompt injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
* SDKs: [Go SDK](https://github.com/modelcontextprotocol/go-sdk), [Rust SDK](https://github.com/modelcontextprotocol/rust-sdk)
* Provenance and signing: [GitHub artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds), [GoReleaser signing](https://goreleaser.com/customization/sign/), [cosign verify](https://docs.sigstore.dev/cosign/verifying/verify/)
* Peers: [Tilt install](https://docs.tilt.dev/install.html), [flyctl install](https://fly.io/docs/flyctl/install), [Compose watch](https://docs.docker.com/compose/how-tos/file-watch/), [Kubernetes version skew](https://kubernetes.io/releases/version-skew-policy/)
* **Not verified:** talosctl install mechanics (the docs host did not resolve from this box); whether attestations are free for every public repo and which SLSA level they meet (confirm at implementation); CLI binary size (not measured, Go is not installed here); the `mise` GitHub backend naming convention.

## Changed 2026-11-16

First version. Nothing built. Proposes D15 to D28 and risks R20 onward in `risks-and-open-questions.md`.
