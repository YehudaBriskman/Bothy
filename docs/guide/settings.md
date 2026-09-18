# Settings

Settings is a section with its own grouped menu, a search box and pages made of
**setting blocks** - a title, one line saying what it is, and Expand/Collapse.
It is laid out like GitLab's settings on purpose: there is a lot of it, and a
flat page of a lot is a page nobody finds anything on.

Open it from the person menu in the topbar. `/settings` lands on Profile &
session; every section has its own address (`/settings/credentials`, ...), and
a search hit adds `?block=<id>`, which opens and scrolls to that block. Below
900px wide the menu is a drawer behind the **Sections** button.

## Where each thing lives

The word "settings" collapses three different things, and the page keeps them
apart:

| Thing | Belongs to | Where it lives |
|---|---|---|
| theme, density, motion, accent, fonts, sizes, landing page, Overview layout, refresh interval | the **browser** | this browser's local storage |
| identity, roles, where the session came from | the **user** | the session token, changed in the realm |
| placement rules, alert rules, retention, credentials, backups | the **box** | files in this repository and on the host |

A per-browser setting says **this browser** beside it. Nothing about the browser
follows you to another device, and that is right: a density or a refresh
interval is a fact about the screen and the link you are on.

## The sections

| Section | What it shows or changes | Source | Needs |
|---|---|---|---|
| Profile & session | account, the four roles your token carries, sign out | `/oauth2/userinfo` | a session |
| Appearance | theme, making a theme, reading size, document font, table density, motion, accent | this browser | - |
| Layout & navigation | landing page, Overview section order and optional panels, reset remembered layout | this browser | - |
| Data & refresh | poll interval, default chart range, retention (read from the config files), clear this browser's Bothy data | this browser; Files for retention | viewer for retention |
| Services & placement | `apps/bothy-collector/placement.yml` as a table; change a value a rule already sets | config forms | viewer to read, **editor** to change |
| Users & roles | every account in realm `devbox`, its roles, password age, sessions | `/-/api/admin/users` | **operator** |
| Credentials | every `.env` key, credential file and Keycloak client: set or not, mode, age, what reads it, the rotation command - **never a value** | `/-/api/admin/credentials` | **operator** |
| Cluster | the namespaces and actions bothy-ops allows, its token, Headlamp | the served kube catalog | viewer; operator for the token age |
| Monitoring & alerts | every scrape target and whether it answered; the Grafana alert rule definitions | metrics route; Files | viewer for rules |
| Audit log | container and cluster actions, file writes, config patches and admin reads, filtered and paged | `/-/api/admin/audit` | **operator** |
| Backups | each backup set's newest copy, count and size; the schedule and `just backup` | `/-/api/admin/backups` | **operator** |
| About & health | the five Bothy containers, the Traefik version and router table, documentation | Docker and Traefik reads | - |

The role column is a courtesy. The edge decides; a block you may not read says
which role it wanted, in words.

## What is never on this page

- **A secret value.** Credentials are an inventory written on the host
  (`just admin-inventory`, refreshed every five minutes by
  `host/systemd/bothy-inventory.timer`): key names, "set", "still the public
  placeholder", file modes and times. See [SECURITY.md](../../SECURITY.md) rule 7.
- **A button that rotates, restores or grants.** Each of those restarts,
  overwrites or re-authorises something. The page shows the command, with a copy
  button; the shell runs it.
- **A way to hide "is anything broken".** The Overview's status line and
  attention strip are not optional panels.

## First-time setup on a box

Two pages need a one-off step, and say so until it is done:

    just admin-client      # the view-users-only Keycloak client for Users & roles
    just admin-inventory   # the metadata file for Credentials and Backups
    just up-apps           # picks up the admin overlay once the client exists

## Related

- [Roles](roles.md) - what each role permits, and where that is actually enforced
- [Backups](backups.md) - the restore commands
- [`docs/plans/settings-v2.md`](../plans/settings-v2.md) - every data source, and the ones deliberately not used
