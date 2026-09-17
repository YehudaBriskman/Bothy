# Plan: Settings v2 - a GitLab-sized settings area

_Written 2026-09-17. Status: in progress on a worktree branch._

The owner asked for settings "in the size and layout close to that of whole
GitLab": passwords for the resources, themes, data, look, users, and more. This
file is the investigation first (what exists, what every data source can and
cannot give), then the design. Nothing on a settings page may be fake: each
block shows real data or a real control, or it is not built.

---

## 1. What exists today

### The page

`apps/bothy-web/web/src/pages/Settings.tsx` (+ `.css`) is one long page with
three `<h2>` groups: **You** (account, roles, where the session comes from),
**Appearance** (theme picker, "make your own", reading size) and **Where these
are kept** (a table of stores, and a panel explaining that no server-side
preference store exists). It is deliberately read-only apart from the theme and
the reading size.

`pages/ThemeEditor.tsx` is its own route, `/settings/theme/new` and
`/settings/theme/:id`, because it repaints the whole document while you type.
Both routes must keep working.

### What is persisted where

| Thing | Store | Key / path |
|---|---|---|
| Theme selection | localStorage | `portal-theme`, plus `portal-theme-appearance` and `portal-theme-is-user` for the pre-paint script in `index.html` (CSP-hashed) |
| Custom themes | a file on the box | `apps/bothy-web/data/themes/*.css`, written through bothy-files (`editor`) |
| Reading size | localStorage | `bothy-reading-v1` (`{doc, ui}`, clamped) |
| Collapsed service groups | localStorage | `bothy-collapsed-groups-v1` |
| Control sidebar collapsed | localStorage | `bothy-control-nav-v1` |
| Files pane widths, recents | localStorage | `bothy-files-panes-v1`, `bothy-read-recent-v1` |
| Dev-only overrides | localStorage | `bothy-dev-roles`, `bothy-dev-kube-outcome`, `bothy-dev-config-outcome` |
| Config fields | files in the stack repo | `/-/api/config/fields` + `/-/api/config/patch` (bothy-files), allow-listed by `policy.toml [config]`: root `stacks`, `.yml/.yaml`, `edge/dynamic/` denied, ONE field `dev.portal.project` (kind `compose-label`) |
| Identity and roles | Keycloak | realm `devbox`; read via `/oauth2/userinfo` |

**Every existing key string is kept unchanged.** New keys are versioned
`bothy-*-v1`, the convention the app already uses.

### Roles in the UI

`lib/me.ts` fetches `/oauth2/userinfo` (oauth2-proxy, from the session cookie)
and narrows `groups` to `viewer | editor | operator | shell`. `lib/session.ts`
shares one promise per tab. Roles in the UI are a courtesy; the edge gates
(`edge/dynamic/bothy-gates.yml`) are the boundary. In `vite dev`,
`localStorage['bothy-dev-roles']` overrides what is drawn.

---

## 2. Every data source a settings page could use

| Source | How the browser reaches it | Auth | What it gives Settings |
|---|---|---|---|
| Collector `projects.json` (incl. `placement`) | `/data/projects.json`, static | none | declared projects, and the parsed `placement.yml` rules the Overview applies |
| `apps/bothy-collector/placement.yml` | `/-/api/files/read` (bothy-files) | viewer | the raw file |
| Traefik routers | `/-/api/traefik/http/routers` (+ services, overview, version) | none | router count, rules, providers, Traefik version |
| Docker | `/-/api/docker/containers/json`, `/system/df` | none | image tags of the Bothy containers, health, sizes |
| VictoriaMetrics | `/-/api/prom/query`, `query_range` (generated route, basic auth injected at the edge) | none | `up` per scrape target; retention is NOT exposed by the API |
| Loki | `/-/api/loki/query_range`, `labels` | none | label names; retention is NOT exposed |
| bothy-files | `/-/api/files/*` | viewer / editor | read `monitoring/compose.yml` (`-retentionPeriod=15d`), `monitoring/loki-config.yml` (`retention_period: 168h`), `monitoring/provisioning/alerting/rules.yml` |
| bothy-files config tier | `/-/api/config/fields`, `/patch` | viewer / editor | typed patches of declared fields |
| bothy-ops | `/-/api/control/*`, `/-/api/kube/*` | operator / viewer | actions; no read endpoint lists what it can do |
| Audit logs | `apps/bothy-ops/audit/actions.log`, `apps/bothy-files/audit/{writes,patches}.log` | **not served anywhere** | append-only TSV; readable only from a shell |
| Keycloak users/roles | admin REST API | **not reachable from Bothy** | `scripts/keycloak-headlamp-client.sh` authenticates by `docker exec keycloak kcadm.sh` as the master-realm admin (password = `DEV_LOGIN_PASSWORD`). Nothing in a container holds an admin credential |
| `.env` key names | a file on the host | bothy-files serves `.env` to `viewer` (marked sensitive, not hidden) | names AND values - too much for an inventory |
| Credential files | `apps/bothy-ops/secrets/`, `apps/headlamp/secrets/` (denied to Files since 2026-09), `edge/dynamic/bothy-prom.yml`, `monitoring/kube-auth/token`, `monitoring/prom-*.txt`, `monitoring/prometheus-web.yml` | none served | nothing today |
| Backups | `~/backups/{postgres,grafana,env}` by `scripts/backup.sh` (timer 03:00, keep 14) | `home` root denies `backups` | nothing today |
| Grafana alert state | Grafana API | needs a Grafana credential | nothing today; the rule DEFINITIONS are a provisioning file |
| `just urls` | a shell | - | the port table; static text, not an API |

Findings that shape the design:

1. **There is no "auth network".** Keycloak and oauth2-proxy are on `devnet`
   only, and bothy-ops must not join `devnet` (SECURITY.md rule 2). But
   Keycloak publishes `:8090`, and a container on any bridge network reaches the
   host's tailnet IP (verified from a throwaway bridge on 2026-09-17:
   `http://<BOX_IP>:8090/realms/devbox/.well-known/openid-configuration` → 200,
   issuer matches). That is the same single spelling oauth2-proxy uses, the
   devbox realm is `sslRequired=NONE`, and it needs no network change at all.
2. **Keycloak's secret creation time needs `view-clients`**, and a
   `view-clients` token can read client representations. That would put every
   client secret one bug away from the admin endpoint. So the credential
   inventory reports the age of the FILE or `.env` that holds each client
   secret, and says it is per-file.
3. **A metadata endpoint that reads `.env` puts every secret into the process
   that serves it.** bothy-ops already holds the power to stop databases; adding
   every password would widen what one bug in it costs. The inventory is
   therefore computed ON THE HOST (like the collector) and written as
   metadata-only JSON; bothy-ops only serves that file, behind `operator`. The
   same generator reads backup metadata, so `~/backups` (plaintext `.env` copies
   and `pg_dumpall` output) is never mounted into a container either.
4. **Alert state is Grafana-only.** Reaching it would need a credential-injecting
   edge route like `bothy-prom.yml`. Not added; Settings shows the rule
   definitions from the provisioning file plus a link to Grafana.

---

## 3. Reference: GitLab's information architecture

- A left sidebar of grouped sections (General, Integrations, Webhooks, Access
  tokens, Repository, CI/CD, Monitor...), scoped to the settings area.
- A "Search settings" box that filters and highlights blocks on the page.
- Every page is a stack of **setting blocks**: a title, a one-line description,
  and an Expand/Collapse button; each block saves independently.
- Breadcrumbs above the page title.

---

## 4. Design

### Layout (`pages/settings/`, `components/settings/`)

- `/settings` redirects to `/settings/profile`. Every section is a child route
  of a `SettingsShell` (scoped left nav, the ControlShell precedent).
- The nav groups sections (**You** · **Look and feel** · **Data** ·
  **Access** · **Operations** · **Box**) with icons.
- **Search settings** is a client-side index of every block's title,
  description and keywords (`lib/settings-index.ts`, import-free, checked). A
  hit navigates to `/settings/<section>?block=<id>`, which expands and scrolls
  to the block.
- **Blocks** (`SettingBlock`) have a title, description, Expand/Collapse
  (`aria-expanded`), and save independently. Read-only blocks say so.
- **Breadcrumbs**: Settings › group › section.
- **Below 900px** the nav becomes a drawer (Radix Dialog). This deliberately
  departs from the brand system's recorded dead end ("a mobile drawer"), which
  was about the TOP-LEVEL nav; twelve grouped destinations plus a search do not
  fit a horizontal strip. Recorded in `docs/brand/reference/decisions.md`.

### Sections and their sources

| Section | Blocks | Source | Writes |
|---|---|---|---|
| Profile & session | account, roles, session, sign out | `/oauth2/userinfo` | none |
| Appearance | theme, make a theme, reading size, document font, table density, motion, accent | localStorage (existing keys + `bothy-appearance-v1`) | this browser |
| Layout & navigation | landing page, Overview section order, Overview panels, reset remembered layout | localStorage (`bothy-layout-v1`, existing collapse/nav keys) | this browser |
| Data & refresh | poll interval, default chart range, retention (read-only), clear local data | localStorage (`bothy-data-v1`); `/-/api/files/read` for retention | this browser |
| Services & placement | the rules as a table, per-field edit | `projects.json` placement; `/-/api/config/*` | `editor`, if the config tier admits it (§5) |
| Users & roles | users, their realm roles, password age, OTP, sessions | NEW `GET /-/api/admin/users` | none (v1) |
| Credentials | every credential's name, users, location, mode, age, rotation command | NEW `GET /-/api/admin/credentials` | none (v1) |
| Cluster | namespace scope, Headlamp, token status | `KUBE_NAMESPACES`; credentials inventory row | none |
| Monitoring & alerts | scrape targets up, alert rule definitions, Grafana link | `/-/api/prom/query?query=up`; `/-/api/files/read` rules.yml | none |
| Audit log | ops actions, file writes, config patches, filters, pages | NEW `GET /-/api/admin/audit` | none |
| Backups | per-kind newest, count, total size, `just backup` | NEW `GET /-/api/admin/backups` | none |
| About & health | Bothy container images and health, Traefik version and router count, docs links | docker + traefik APIs | none |

### New endpoints (bothy-ops, `admin.py`)

All `GET`, all **operator** (each discloses more than a viewer needs: who the
users are, where every credential lives, who did what). Exact `Path()` routers
in a new hand-written `edge/dynamic/bothy-admin.yml`, self-contained (its own
strip/deidentify middlewares and service name), gates from
`bothy-gates.yml`. Every request writes an audit line.

- `/-/api/admin/users` - Keycloak admin REST, client-credentials grant, client
  `bothy-admin` whose service account holds ONLY realm-management `view-users`.
  Secret at `apps/bothy-ops/secrets/keycloak-admin-client-secret`, created by
  `scripts/keycloak-admin-client.sh` (idempotent, `--rotate`). Fields are
  allow-listed; credential entries are reduced to `type` + `createdDate`.
- `/-/api/admin/credentials`, `/-/api/admin/backups` - serve the host-generated
  `inventory.json` (`apps/bothy-ops/inventory.py`, `just admin-inventory`,
  `host/systemd/bothy-inventory.{service,timer}` every 5 minutes) mounted
  read-only. An absent or stale file is said, not hidden.
- `/-/api/admin/audit` - reads the three TSV logs mounted read-only;
  `log`, `who`, `outcome`, `action`, `offset`, `limit` (≤ 200).

Write actions on users (role grant/revoke, password reset) are **out of v1**.

---

## 5. Placement editing through the config tier

`apps/bothy-collector/placement.yml` is in root `stacks`, is `.yml`, and is not
under a denied prefix, so `resolve_config` admits it. What is missing is a field
kind: `compose-label` locates `services.*.labels`. A new kind
`placement-rule` locates `rules[*].{section,subgroup,title,group}` scalars, keyed
by the rule's match list as the "service", reusing yamlpatch's splice-and-verify.
It edits EXISTING values only; adding or deleting a rule stays a Files edit.
Done only with the kind's own tests (locate, one-line patch, naive-dump damage,
HTTP).

---

## 6. Dead ends and decisions

- **Joining devnet to reach Keycloak** - rejected; see §2.1.
- **bothy-ops mounting `.env` and `~/backups`** - rejected; see §2.3.
- **`view-clients` for secret ages** - rejected; see §2.2.
- **A Grafana API route** - not built; would need a credential in an edge file
  and a SECURITY.md entry first.
- **A server-side preference store** - still not built. Every new preference is
  per-browser and the page says so.
- **Hiding the Overview's status line or attention strip** - not offered. "Is
  anything broken" is the page's reason to exist; the optional panels are the
  ones below it.
