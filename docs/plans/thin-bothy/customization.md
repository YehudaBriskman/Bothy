# Customisation

"Way more customisable" must not mean "more places to hand-edit". It means **more
things a person can change, from one surface, with the platform checking the result.**

## 1. The layers (most common first)

| Layer | Who | Where | Example |
|---|---|---|---|
| 1. Mode | everyone | wizard / Settings | mini -> standard |
| 2. Module on/off | operators | Settings -> Modules | enable `logs` |
| 3. Module fields | operators | the generated form | retention days, SMTP, file roots |
| 4. Resource profile | operators | per-module "size" control | Loki: small / default / large |
| 5. Values override | admins | advanced YAML editor, validated | a Helm value the form does not expose |
| 6. Your own module | developers | a module file + chart in a directory | an in-house service with its own cost |

Layers 1-4 are generated from the module schema, with **no per-module UI code**
(#321 acceptance). Layer 5 is the escape hatch. Layer 6 is the extension point.

## 2. One store, four surfaces

Per #322: the web, the `bothy` CLI, scoped API tokens and an MCP server are four
views of one API. A change made anywhere:

1. is validated by **one** validator (server-side; the UI never reimplements it),
2. shows a **diff** (old -> new; secrets as "changed"),
3. is applied by the operator, verified, and rolled back on failure,
4. is audit-logged (who, what, when, through which surface).

## 3. Settings to cluster state

```
 settings store (SQLite)  ──render──▶  Helm values (per module)  ──▶  helm upgrade --atomic
   fields, secrets                      + Secrets (from write-only)      verify, rollback
        ▲                                        ▲
        └── schema (module TOML) ────────────────┘   precedence: override > store > default
```

- **Precedence**: explicit override (layer 5) > settings store > module default.
  A missing required field for an enabled module is a hard failure with the field
  named (#316 criterion), never a silent default.
- **Secrets** are write-only in every surface (#317): `set / updated / fingerprint`
  only. They reach pods as Kubernetes `Secret`s mounted as files (`*_FILE`
  convention), created by the operator from the store; the plaintext is never in
  the Helm release's values (so `helm get values` leaks nothing).
- **No box-specific defaults** (#323): defaults are generic; this box's facts
  (tailnet IP, cluster names) live as *values for this install*, not in code.

## 2a. Resource profiles (layer 4)

Every module declares named profiles, e.g.:

```toml
[profiles.small]   memory_request="128Mi" memory_limit="256Mi" retention_days=3
[profiles.default] memory_request="250Mi" memory_limit="600Mi" retention_days=7
[profiles.large]   memory_request="600Mi" memory_limit="1200Mi" retention_days=30
```

Choosing one runs through the **budget gate** (`resource-management.md`), so a
profile that does not fit is refused with the arithmetic. Custom numbers are allowed
in layer 5 and are clearly marked "outside a declared profile".

## 4. The escape hatch, safely (layer 5)

A raw Helm values editor for admins:
- Validated against the chart's `values.schema.json` before apply.
- Forbidden keys: anything that adds `hostPath`, `privileged`, `hostNetwork`, new
  ClusterRoles, or removes `resources` (the same list the CI refuses, see
  `security-model.md`). The editor says which rule rejected a change.
- Stored as a separate, versioned **override** so the form values and the hand
  values are distinguishable, and "reset to form" is one click.
- Shown as a diff against the last applied release, always.

## 5. Your own modules (layer 6)

A directory in `$STATE_ROOT/bothy/modules.d/<id>/` with `module.toml` and either a
Helm chart or plain manifests. The platform **treats it like a built-in**: the same
schema, cost, health contract, quota and namespace, with these differences:

- It is marked **untrusted**: it cannot request privileged settings; the same lint
  that guards the built-ins runs on it, and it is applied with its own namespace-
  scoped Role (`updates-and-rollback.md` s3).
- It must declare a cost, or the budget gate refuses it.
- Its images are pinned by digest (Dependabot-style discovery still applies if it
  declares a source).

This is the answer to #91 ("start any service from any compose file") and #93
(grouping): a project becomes a user module with a `group` field, rather than the
platform guessing from compose labels.

## 6. Theming and presentation

The portal's design-system tokens remain the source of truth; **settings exposes
only what is safe and meaningful**: theme (light/dark/auto), language and
direction (Hebrew RTL is first-class here), density, and which Overview cards show.
Per-user preferences are the subject of #145/#157; this plan only requires that the
store has room for a per-user scope (`user:<id>`), so that decision does not force a
second store.

## 7. Import and export

- `bothy config export` -> an age-encrypted bundle of settings and secrets (#316's
  "C becomes the export format"), the way to move or back up a configuration.
- `bothy config import` is **idempotent** and shows the diff first.
- `.env` import (#324) is a one-shot into the store with verification, then retired.

## 8. What is deliberately not customisable

The three roles and their gates, the exact-`Path()` routing rule, the pinned-digest
rule, resource declarations on every pod, and the budget gate. Each of these is a
safety property; making it a setting would make it a thing people turn off.
