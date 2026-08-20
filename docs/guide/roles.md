# Roles

Bothy has four roles: `viewer`, `editor`, `operator` and `shell`. They are flat
and deliberately **non-composite** - holding one never implies another - because
`shell` grants an arbitrary terminal and must never be reachable by holding one
of the other three. Composites are how that happens by accident.

They gate exactly three tiers. Everything else on the box is protected by the
tailnet plus, where a service has one, its own login on the shared
`DEV_LOGIN_*` credential. **"SSO is running" does not mean "this is behind
SSO".**

## What each role actually gets you

| Role | What holding it lets you do, today |
|---|---|
| `viewer` | read through Bothy Files - browse, search, follow links, see history and diffs, download raw bytes and archives. Also read which compose fields are patchable in Settings |
| `editor` | write and delete a file through Bothy Files, and patch a declared field through a Settings form |
| `operator` | restart, stop and start a container |
| `shell` | nothing. It is defined, granted to nobody, and referenced by no router |

The Settings page renders `shell` as **"Granted to nobody"** rather than as an
ordinary "Not held", because it is not an absence you can fix by asking. It is
written as a condition rather than a constant, so if it is ever granted the page
will say so rather than keep insisting.

## Where each role is enforced

Nine routers carry a role requirement, across three files in `edge/dynamic/`.
The requirement lives in the **middleware**, not in the service, and the three
middlewares are identical but for one word in a query string - which is the
property that makes the design worth having: adding a tier is four lines of
YAML, not another container.

| Router | Role | Path |
|---|---|---|
| `portal-files-read` | `viewer` | roots, tree, read, search, links, history, repos, status, git diff |
| `portal-files-download` | `viewer` | raw and archive, on the `:8100` sandbox entrypoint only |
| `portal-files-write` | `editor` | write |
| `portal-files-delete` | `editor` | delete |
| `bothy-config-read` | `viewer` | config fields |
| `bothy-config-write` | `editor` | config patch |
| `bothy-control-restart` | `operator` | restart |
| `bothy-control-stop` | `operator` | stop |
| `bothy-control-start` | `operator` | start |

Two structural choices in that table are worth reading rather than skimming.

**Delete is `editor`, not a role of its own**, because removing a file *is* a
write, and a separate role would be a second thing to grant, a second thing to
revoke and a second thing to get wrong - for an action whose blast radius is
smaller than an overwrite's, since the service refuses to delete unless the
snapshot took a copy first. It still gets its **own router**: two rules that
share a role today must not share it by accident tomorrow.

**The three control verbs are three routers**, not one rule with three
alternatives, for the same reason. The day `stop` needs a tier above `restart`,
that is an edit to one router instead of a rule that has to be split first,
under pressure.

The middlewares themselves are defined next to what they gate, and that
placement is itself an argument:

- `sso-viewer` and `sso-editor` live in `edge/dynamic/portal-files.yml`;
- `sso-operator` lives in `edge/dynamic/bothy-control.yml`;
- `sso-errors` - which turns a bare 401 into a sign-in page - lives in
  `edge/dynamic/auth.yml` and is borrowed by everything.

The config tier borrows `sso-viewer` and `sso-editor` rather than defining its
own copies. Traefik's file provider merges every file in the directory into one
namespace, so two definitions of a middleware named `sso-editor` is a collision
whose winner no single file can decide - and the two would then drift
invisibly, with both routers still answering and one of them against the wrong
role. The cost is real and is stated in the file: deleting `portal-files.yml`
would silently unauthenticate the config tier's routers.

`sso-operator` was deleted once, on 2026-08-15, along with the routes it gated,
for a reason worth keeping: *a middleware nothing references is a loaded gun
with no trigger - it looks like protection while protecting nothing, and the
next router to want a gate might pick it up believing it is already proven in
use.* It came back with the control tier, in the file that uses it.

One more, for completeness: the plain `sso` middleware in `auth.yml` - the one
that checks for *any* session rather than a role - is attached to **no router at
all**. Only the three role-scoped variants are in use.

## It fails closed, and that was verified before it was trusted

Against a role the user does **not** hold:

```
allowed_groups=editor  -> 202   (they have it)
allowed_groups=shell   -> 403   (nobody has it)
allowed_groups=<junk>  -> 403   (fails closed)
```

`just files-check` re-runs that probe, so the property is tested rather than
assumed. The third line is the one that matters most: because oauth2-proxy fails
closed on a group nobody holds, a tier can ship **before** its role exists in
the realm and refuse everybody rather than admit everybody. That is the safe
direction to be wrong in, and it is how the control tier was released.

## Where the roles come from

Keycloak, in a container on `:8090`, in a realm called `devbox`. The four roles
are declared in [`auth/realm-devbox.json`](../../auth/realm-devbox.json).
Keycloak puts realm roles at a nested claim while oauth2-proxy reads a flat one,
so a protocol mapper flattens them into `groups` - without it,
`allowed_groups=operator` would silently match nothing.

There is deliberately **no default-role block**, so a new user lands with zero
capability and is granted roles explicitly.

Who holds what is seeded by the `keycloak-init` one-shot in
`auth/compose.yml`, which grants your `DEV_LOGIN_USER` **`viewer`, `editor` and
`operator`, and never `shell`**. Without that step a fresh install refuses
everyone: the realm file declares four roles and zero users, so every gated
route would answer 403 to the only person who has just installed it, and the
product would look broken rather than unconfigured.

Two properties of that step you will meet eventually:

- **The realm import is first-boot only.** Adding a user or a role to the JSON
  on an existing install does nothing, silently. Anything that must be true on
  both a new box and an old one belongs in the one-shot, which re-runs on every
  `just up-auth`.
- **Roles are re-asserted on every `just up-auth`; the password is not.**
  Granting a role somebody already holds is a no-op, so re-running restores a
  role revoked by accident in the console - the roles are declared in this
  repository, not in a console. A password is the opposite: somebody who changed
  theirs must not have it reset from under them.

To grant or revoke by hand, use the admin console at
`http://<node-ip>:8090/admin`, as `KEYCLOAK_ADMIN_USER` (`admin` by default)
with `DEV_LOGIN_PASSWORD`. Remember that the next `just up-auth` re-grants the
three seeded roles.

## Three things that are not true, however they read

**The interface is not the boundary.** `lib/me.ts` reads
`/oauth2/userinfo` and the Settings page lists your roles, but that is a
description of a token. Hiding a button is a courtesy that saves a round trip
and turns a bare 403 into a sentence arriving before the click. Every decision
is taken at the edge by a middleware reading a signed cookie that never trusts
anything the browser says. If that file were ever the only thing standing
between a user and an action, the action would be unprotected.

**Identity headers are attribution, not permission.** The services name the
commit author or the audit actor from `X-Auth-Request-Email`. Each of the three
tiers strips every client-supplied `X-Auth-Request-*` header *before*
`forwardAuth` runs, so the only one that can reach a service is the one
oauth2-proxy produced. If that were missing, the worst case would be a forged
*name* in a log, not an unauthorised action - which is exactly why it is defence
in depth rather than the defence. It matters most on the control tier: a forged
file write leaves a diff a human can read and revert, and a forged
`stop postgres` is over before anybody reads anything.

**`viewer` is not weaker than `operator` on this deployment.** Bothy Files
serves `.env`, and `.env` contains the cookie secret. Anyone who can read it can
mint a session for any role. That is a deliberate trade for a single-owner box
and it is documented at the point it is made, in
[`apps/portal-files/policy.toml`](../../apps/portal-files/policy.toml). It stops
being acceptable the moment a second person holds only `viewer`.

## The three sources do not agree, and here is how

The roles are described in three places, and each is authoritative for a
different question. They have drifted.

**The realm** (`auth/realm-devbox.json`) is the definition. Its descriptions
name capabilities that do not exist here:

- `viewer` is described as *"Read-only: dashboards, logs, metrics, docs."*
  Grafana and Prometheus are not behind SSO at all; they carry their own login,
  so `viewer` grants nothing there. What it actually gates is the file tier and
  the config tier's read.
- `editor` is described as *"Can change content - wiki/docs pages,
  dashboards."* The wiki was deleted on 2026-08-18, and no role gates a
  dashboard. What it actually gates is a file write, a file delete, and a
  config patch.
- `operator` is described as *"Can act on the stack - restart containers,
  silence alerts."* Restarting containers is right. Nothing anywhere silences an
  alert.

**The interface** (`ROLE_MEANING` in
`apps/portal-next/web/src/lib/me.ts`) is the user-facing wording and is much
closer, but it is scoped to the file tier and predates the config tier:
`viewer` reads "browse files, search their contents, download bytes" and also
gates reading config fields; `editor` reads "change a file on disk" and also
gates deleting one and patching a compose label through a form.

**The README** is the third, and it undercounts. Its single-sign-on table lists
**three** routers, all in `portal-files.yml` - read, download and write -
omitting `portal-files-delete`, omitting `/links` from the read router's paths,
and omitting the config and control tiers entirely. The prose beside it says
"three routers require a role today". Nine do.

`SECURITY.md` disagreed with itself in the same way and in one section: the
status blockquote at the top of § 1 said *nine role-gated routers in three
files*, and four paragraphs later the same section still said *"Three routers
do now, all in `edge/dynamic/portal-files.yml`"*. Corrected 2026-08-19 - the
blockquote was the half that matched the router table.

The router table is the one that is true, because it is the one that runs. It
is live at `http://<node-ip>/-/api/traefik/http/routers`, and there is no
Traefik dashboard to check instead - it was deleted because it leaked a
credential.

## Related

- [Operating it from the console](the-console.md) - what `operator` unlocks
- [Bothy Files](files.md) - what `viewer` and `editor` unlock
- [Settings](settings.md) - where your roles are shown, and why that panel changes nothing
- [`SECURITY.md`](../../SECURITY.md) - the threat model, and the case for and against a `shell` role that does something
