# Updates: keeping every part of Bothy current from the web UI

Status: **steps 0-7 built** (step 4, the updater for the stateless and time-series classes; step 5, the one-way
app-db class for Grafana and Keycloak; step 6, Bothy updating itself; step 7, the automatic channel - all 2026-09-19, see
[Decisions](#decisions)); step 8 is design. Written 2026-09-18 from two read-only surveys:
- the repo and live box: every pin, volume, backup and restart;
- the tooling and patterns available, with sources at the end.

Nothing here has been run against the box.

## 1. Why, and what is broken today

The user's ask: update anything in Bothy from the UI, optionally automatically. That covers our own code (new versions on GitHub), the third-party images (Grafana, VictoriaMetrics, Keycloak, …) and the cluster add-ons, without losing data or configuration on the way.

What exists today:

- **Discovery exists.** Dependabot opens weekly PRs for every compose directory, and `upgrade.yml` proves nightly that `HEAD^1 → HEAD` keeps postgres data and volumes.
- **Applying is the gap.** A merged pin change sits in the compose file until someone runs `just up-<group>` on the box. On 2026-09-18 Grafana 13.2.1, Loki 3.7.7, Keycloak 26.7.3 and oauth2-proxy v7.15.4 were all merged but not running.
- **Bug: `bothy upgrade` does not update our own code.** It runs `git pull --ff-only && just up` (`scripts/bothy` `cmd_upgrade`). bothy-web, bothy-files and bothy-ops are `build:`-only images tagged `:latest`, and no path passes `--build`. So `up` reuses the old image, and **new app code is never applied**. `upgrade.yml` can't see this, because it compares data, not code. Fix this first (§7, step 0).
- **Backups miss half the state.** `backup.sh` saves `pg_dumpall`, a live `docker cp` of grafana.db (which can be torn) and `.env`. It does not save:
  - VictoriaMetrics, Loki, the Alloy positions;
  - the audit logs, the trash directories, the generated secrets, the notes repo;
  - minikube.
  The only restore procedure is prose in `docs/guide/backups.md`.
- **Some pins float:** `traefik:v3.7` and `postgres:17` (twice). `postgres-exporter` is pinned by digest only, so its version is unreadable. bothy-web builds on unpinned `node:26-alpine` and `nginx:alpine` with `npm install`.
- **Some things Dependabot never sees:** `apps/headlamp`, the base digests of bothy-files and bothy-ops, pip `requirements.txt`, `k8s/monitoring/alloy.yaml`, and the kube-state-metrics chart version (it's a shell variable).
- **The box is also a development clone.** Saves from the bothy-files editor and config forms dirty the tree, and `git pull --ff-only` then refuses.

## 2. The constraint that decides the architecture

An updater needs to pull images, build them and create containers. `SECURITY.md` forbids exactly that grant anywhere reachable from the browser: "No proxy may hold `POST=1` with `CONTAINERS=1`". `grants.py` sweeps every compose file for it. socket-write allows only restart, start and stop, and bothy-ops' `guard.VERBS` matches.

Updating Traefik, bothy-ops or the socket proxies also cuts off the very request that asked for it; that is what `guard.SEVERING` exists for.

So the updater cannot be a container, and cannot run inside the request. It is **SECURITY.md "shape 3": a host executor**, reached through **shape 1: an allowlisted request, never a string**. `control-and-settings.md` §6c already names this as a host-executor decision.

The honest security statement: devssh is in the `docker` group, so any host process running as devssh is already root-equivalent over Docker. The updater's safety comes from **what it will accept as input**, not from which account runs it:
- a component id from a closed catalog;
- a version the host itself discovered, compared exactly;
- a plan id the host itself wrote.

A total compromise of bothy-ops then buys "move a listed component to a listed version". That is bounded, and comparable to the `set-image` it already has on the cluster. As built (step 4, [Decisions](#decisions)) it is narrower still: "deploy, for a listed component, the version `main` already pins".

### Rejected alternatives

| Option | Why not |
|---|---|
| Watchtower (archived 2025-12) or its forks | A container holding a read-write socket (shape 2); bypasses `just`/`.env`; no backup before a migration |
| Komodo, Portainer, Dockge, Coolify | A second control plane with its own auth, terminal and compose editor; Portainer was already retired in favour of bothy-ops |
| A privileged "updater" container behind a proxy | Moves the forbidden `POST+CONTAINERS` grant, it doesn't remove it |
| Diun | Fine, but only for discovery. `regctl`/`skopeo` from the host job does the same with no socket at all |

## 3. Architecture

```
browser ── /-/api/updates/* (exact Path, sso-viewer | sso-operator) ──▶ bothy-ops
   │                                                                    │ validates against
   │                                                                    │ updates.toml + available.json
   │                                                                    ▼
   │                                        ~/.local/state/bothy/updates/spool/<id>.json  (atomic rename)
   │                                                                    │
   │                                                     bothy-updater.path (systemd, host, devssh)
   │                                                                    ▼
   │                          bothy-updater.service (oneshot, flock): re-validate → plan → run fixed steps
   │                                                                    │
   └──── polls /-/api/updates/status ◀── bothy-ops reads status.json (read-only mount)
```

- **`apps/bothy-ops/updates.toml`** is the only hand-written catalog, like `catalog.toml`. For each component it gives:
  - its class (§4) and the compose file and service it lives in;
  - the `just` recipe that applies it, and the dependants that restart;
  - its changelog URL;
  - the snapshot recipe;
  - the verify canaries;
  - its channel (`auto`, `notify` or `manual`);
  - whether its migration is `one_way`.
- **`bothy-updates-discover.timer`** (host, like `bothy-inventory.timer`) reads every pin from the compose files and asks:
  - the registries, with `regctl`: tags, digests, dates;
  - GitHub releases, for our tags;
  - the helm index, for charts.

  It writes `available.json`, labels each entry patch, minor or major, and writes Prometheus textfile metrics `bothy_update_available{component,level}`, which node-exporter already exports.
- **bothy-ops gains exact `Path()` routes** (five as built: status, plan, job and request, and - step 7 - unpause) in a hand-written `edge/dynamic/bothy-updates.yml` (allow-listed in `edge/dynamic/.gitignore`):
  - `GET /-/api/updates/status` (viewer): current and available versions, running job, history;
  - `GET /-/api/updates/plan?component=` (viewer): the host-written plan (diff, changelog, one-way flag, dependants, downtime);
  - `POST /-/api/updates/request` (operator; type-the-name for `one_way` and major): `{component, plan_id, confirm}`. It writes one spool file and an audit line, then answers 202. It never runs anything.

  The only new mount is the spool directory, read-write, plus `status.json` and `history.jsonl`, read-only.
- **`bothy-updater`** is a Python program on the host. Each class maps to a function whose steps are hard-coded argv lists; there is no shell string anywhere. It:
  - re-validates everything and doesn't trust bothy-ops;
  - holds one global `flock`, so only one update runs at a time;
  - writes `status.json` after every step, so the UI keeps showing progress while bothy-ops, Traefik or bothy-web restart underneath it;
  - appends to an audit log and `history.jsonl`. It does **not** commit, and there is no `deploy/box` branch: it deploys only what `main` already pins, so git's history of `main` already is the history (see [Decisions](#decisions)).

## 4. Component classes

| Class | Components | Snapshot before apply | One-way? | Rollback | Default channel |
|---|---|---|---|---|---|
| Stateless infra | cadvisor, node-exporter, alloy, headlamp, postgres-exporter | image digest | no | previous digest | `auto` (patch and minor, in the window) |
| Auth boundary | oauth2-proxy (both), socket-read/write | digest | no | previous digest | **`manual`**, and the boundary probes must pass. Mirrors dependabot.yml's "review by hand" |
| Edge | traefik | digest plus `edge/dynamic/` copy | no | previous digest | patch `auto` once pinned by digest; minor `manual` |
| Time-series | victoriametrics, loki | stop, then tar the volume | Loki: only a *schema* change (config, not image) | digest; tar if needed | patch `auto`, minor `notify` |
| App plus database | grafana, keycloak | Grafana: **stop**, then tar `grafana_data`. Keycloak: `pg_dump -Fc keycloak` | **yes** | restore the snapshot, then the previous digest | `notify`; always manual |
| Database | postgres | `pg_dumpall` plus a volume tar | major: **yes** | restore | minor: `manual`. Major: its own procedure (§5) |
| Own code | bothy-web, bothy-files, bothy-ops (plus the repo) | git SHA; images kept as `bothy-*:<sha>` | no (no database; audit and state live outside the images) | re-tag the previous SHA's images | `notify`; manual, one click |
| Cluster add-ons | kube-state-metrics (helm), alloy DaemonSet, `k8s/` | `helm get values` plus revision; `kubectl get -o yaml` | usually no | `helm rollback`; re-apply the previous SHA | `manual`, host kubeconfig only, **never** bothy-ops' namespaced token (rule 6) |
| Host tooling | minikube, kubectl, helm (mise, all `latest`) | — | minikube's k8s version: yes | — | out of scope for v1; pin in mise first |

## 5. The pipeline: one path for every component

1. **Discover.** The timer finds a newer version and resolves its digest. A badge appears in Settings.
2. **Plan.** The host writes a plan with an id. The UI approves **the plan id**, never raw parameters. A plan contains:
   - the pin diff (`tag@sha256:…`);
   - the changelog URL;
   - the one-way flag and the reason;
   - which containers restart;
   - who gets signed out: nobody for Keycloak 26.x minors, because sessions are persisted, but gated routes fail closed while it is down;
   - estimated downtime.
3. **Pre-flight.** Any failure aborts before anything is touched:
   - free disk is at least 2 × (image plus snapshot);
   - `just doctor` is green for the component and its dependencies;
   - the newest backup is under 24 h old;
   - for own code, the tree is clean and on `main` or `deploy/box`;
   - automatic updates only run inside the window;
   - no other job holds the lock.
4. **Snapshot** to `~/backups/pre-update/<ts>-<component>/` (mode 700), keeping the last 3 per component. It holds:
   - the old digest, the compose file and the relevant config;
   - a logical dump for databases;
   - for SQLite and TSDB volumes, a tar taken **with the service stopped**.
5. **Apply.**
   - Images: rewrite the pin with a structured edit (the `yamlpatch.py` approach; one line changes and comments survive). Then `docker compose pull <svc>`, then `just up-<group>` (dependency order, `.env` handling, `--wait`).
   - Own code: see §6.
6. **Verify.** Health, then `just doctor` / `verify`, then the component's suite, then **canaries that check response bodies, not status codes** (rule 7):

   | Component | Canary |
   |---|---|
   | Grafana | `/api/health` reports the database as `ok` |
   | VictoriaMetrics | `up` returns series |
   | Loki | fresh lines in `query_range` |
   | Keycloak | the discovery document's `issuer` is unchanged, and `keycloak-init` re-ran |
   | oauth2-proxy | `allowed_groups=shell` still answers 403 |
   | Traefik | router count, rule 3 probe, `bothy-web-fallback` present |

7. **Roll back** automatically if verify fails:
   - two-way components: the previous digest, then `up`;
   - one-way components: stop, restore the snapshot, the previous digest, then `up`.

   The result is recorded as `rolled_back`, and a Grafana alert fires.
8. **Record:** an audit line per step, a `history.jsonl` entry (from, to, digests, plan, operator, duration, snapshot path, outcome) and the textfile metric `bothy_update_last_result`. No commit: what was deployed is a commit on `main` already.

### Per-component specifics

- **Grafana:** the schema migrates on start and can't be undone. Stop it before the tar, because a live `docker cp` of SQLite can be torn. Fix `backup.sh` the same way.
- **Keycloak:** the database migrates on first start; the only way back is the pre-upgrade dump. Expect 1–2 minutes of downtime, during which gated routes fail closed. Blue/green isn't practical on one box. `just up-auth` re-runs `keycloak-init`, because the realm import only runs on first boot.
- **Postgres major** (17 → 18): never automatic.
  1. `pg_dumpall`.
  2. Create a new volume `postgres18_data`.
  3. Restore into it.
  4. Switch the volume name in compose.

  The old volume stays as the rollback. Prefer this over `pg_upgrade --link`, which shares data files with the old cluster and so weakens the rollback. `keycloak-db-init` moves to the same major in the same plan.
- **Loki:** image updates are ordinary. A schema change means *adding* a `period_config` entry with a future `from` date. The updater refuses any plan that edits an existing period.
- **VictoriaMetrics:** its upgrades can skip versions, and it can be downgraded unless the changelog says otherwise, so rollback by digest normally works.
- **Traefik:** updating it severs the page that asked for it. The UI polls `status.json` and tolerates the gap.

## 6. Our own code, and updating Bothy itself without breaking it

- **Source of trust:** release tags on `YehudaBriskman/Bothy` that CI marked green (optionally `git verify-tag`), never an arbitrary SHA.
  - This needs a release habit: `VERSION` plus `just release`. Today there is one tag (`v2026.8.1`) and `main` is 98 commits past it.
  - Also needed: publishing the tag, and a CHANGELOG entry the plan can link to.
- **The flow:**
  1. Fetch.
  2. Refuse if the tree is dirty or not on `main` or `deploy/box`.
  3. Build `bothy-*:<new-sha>` **before** touching anything that runs.
  4. Record the previous SHA.
  5. Check out the tag (fast-forward only).
  6. Run `just up-apps`, which recreates the containers onto the new tags. Order: bothy-files and bothy-ops first, **bothy-web last**, so the page showing progress stays up the longest.
  7. Arm a `systemd-run` **rollback timer** (10 minutes). It restores the previous SHA and images unless verify disarms it, which covers a hung verify, a dead updater or a WSL restart in the middle.
- **Open tabs across an update:**
  - bothy-web serves `/version` (the build SHA). A tab that sees it change shows "Bothy updated — reload".
  - Chunk-load errors reload once, because the catch-all turns a missing hashed chunk into `index.html` with status 200.
- **The updater never replaces itself in the same run.** It runs from `~/.local/lib/bothy-updater/<sha>/` with a `current` symlink, installed by `just install-updater`. A Bothy release that changes the updater only *stages* the new copy; switching to it is a separate manual step.
- **Recovery never needs the browser.** `just update-status` and `just update-rollback <component>` work over Tailscale SSH.
- **Dirty trees:** edits made through the bothy-files editor and config forms are user work, not drift.
  - The updater refuses and says why, rather than stashing.
  - A future option is to have those edits commit automatically to a `local/edits` branch that the deploy branch merges.

## 7. Build order (each step is useful on its own)

0. **Fix the bug.** `bothy upgrade` and `just up-apps` rebuild our images when the source changed (`up --build`, or build with `:<sha>` tags). Extend `upgrade.yml` to assert that the running bothy-web bundle's hash changes across an upgrade that touches it.
1. **Pins and coverage:**
   - digest-pin `traefik`, `postgres` (both) and the bothy-web bases, and give postgres-exporter a readable tag;
   - add Dependabot entries for `apps/headlamp`, the two Python Dockerfiles, pip, `k8s/monitoring`, and a version file for the kube-state-metrics chart;
   - add `--wait` to every `up-*`.
2. **Backups that match reality:**
   - stop-then-copy for grafana.db;
   - add VictoriaMetrics and Loki (a snapshot API or a stopped tar);
   - add the audit logs, the trash directories and the notes repo;
   - write restore recipes: `just restore-postgres`, `restore-grafana`, `restore-env`;
   - add an `upgrade.yml` case that restores.
3. **Discovery:** the timer, `available.json`, the textfile metrics, and a read-only Settings → Updates page (current, available, channel, badges, changelog links). Useful even if nothing below is ever built.
4. **The updater for stateless and time-series classes:** spool, path unit, plans, snapshot, apply, verify, roll back, history. Then the `POST` route (operator) and the plan view. **Built 2026-09-19** - see [Decisions](#decisions) for how it differs from the sketch above.
5. **One-way classes** (Grafana, Keycloak), with the snapshot and restore paths exercised in CI. **Built 2026-09-19** -
   see [Decisions](#step-5-2026-09-19-the-one-way-app-db-class).
6. **Own code:** tags, build-before-switch, the rollback timer, the `/version` banner. **Built 2026-09-19** - see
   [Decisions](#step-6-2026-09-19-bothy-updates-itself-to-a-green-release-tag).
7. **Channels and the window:** automatic patches for the classes marked `auto`, one component per night after a successful 03:00 backup, stopping at the first failure. Plus a Grafana alert on `rolled_back` or failure. **Built 2026-09-19** - see [Decisions](#decisions).
8. **Cluster add-ons** (helm and manifests) and the Postgres major procedure: documented, manual, and still driven through the same plan, snapshot and verify path.

## 8. Settings → Updates (UI)

- **A table per component:** current version, available version, a patch/minor/major badge, a one-way badge, the channel (editable by editor, and written to `updates.toml` through the config tier), and when it was last updated.
- **Row → plan view:** the diff, the changelog, what restarts, who is signed out, the downtime, and the snapshot that will be taken. **Update** asks for type-the-name confirmation when the plan is one-way or major.
- **A running job** shows its steps live from `status.json`, and survives the UI restarting under it.
- **History:** reads `history.jsonl`, with the snapshot path of each run and a **Roll back** action. Roll back is itself a plan, with its own confirmation.
- **Settings badge:** a count on the Settings nav item for anything a minor version or more behind.

## Decisions

### Step 4 (2026-09-19): the updater deploys only what `main` already pins

**The question.** §3 and §5 sketched an updater that rewrites a pin to a discovered newer version and commits that to a local
`deploy/box` branch. The box runs `main`, and `bothy upgrade` is `git pull --ff-only`: a local commit that diverges from
`origin/main` blocks it, and a dirty pin line makes it refuse or conflict the week Dependabot bumps the same line. So the pin
change has to be recorded somewhere, and every place is worse than the last - a local branch (diverges), a dirty tree
("applied, not merged", blocks upgrades), or a PR the box opens itself (a GitHub credential on the host, and a round trip).

**The decision: the updater never writes a newer pin at all.** A plan is *"this container runs W; the checked-out `main`
pins X"*. The one-click flow is: Dependabot (or anyone) opens the PR, CI and `upgrade.yml` test it, it merges, the box's
checkout is pulled, and Settings > Updates offers **exactly X**. A version `main` does not pin is not offered; the page says to
merge its PR.

| | Rewrite pins (the sketch) | Deploy what `main` pins (built) |
|---|---|---|
| Source of truth | the box and `main` disagree until someone reconciles | git, only |
| Review and CI | none for the box's choice | the PR, `ci.yml`, and `upgrade.yml`'s HEAD^1 -> HEAD on the exact change |
| `bothy upgrade` / `git pull --ff-only` | blocked by the local commit or the dirty line | never blocked by a success |
| Dependabot | its PR conflicts with the box's edit | its PR *is* the input |
| What a request can choose | a component and a version (from a list) | a component and a plan id; the version is a line on `main` |
| Code that writes into compose files | on every update | on a rollback only |
| Cost | none | a newer version waits for its PR to merge and the checkout to be pulled |

The cost is real and accepted: it is the review step, and it is how the box was actually updated on 2026-09-18 (merged,
then applied by hand). "Merged but not running" is precisely §1's gap, and this closes it.

**What makes a checkout deployable** (`updater/plans.py`): HEAD is on the branch `main`; the pin file has no local
changes; HEAD is an ancestor of `refs/remotes/origin/main` (nothing unreviewed); discovery saw the same tag and resolved its
digest; the pin is an exact version, not floating; the running version is older, and not by a major. The plan's id is a hash of
all of that plus the running image id and HEAD's sha, so any change - a new commit, a restarted container, a re-published tag -
makes the old plan stale, and the executor recomputes it and refuses a mismatch.

**The one exception: a rollback writes the old pin back.** If verify fails, the previous image goes back on the pin line - a
strict one-line edit that aborts unless the line still reads exactly what the plan recorded - and the recipe runs again. The tree
is then dirty *on purpose*: it says "main pins X, this box deliberately runs W", so the next `just up` does not re-apply the
broken version. The plan for that component refuses until a person looks (`git diff`, then `git checkout -- <file>`).

### Step 4: the other choices

- **Plans are pre-computed on the host** by `discover_updates.py` (`plans/<component>.json`, 600), not requested through a
  second path unit. bothy-ops stays read-only on everything but the spool, and a plan exists before anyone asks, so the page
  can show "ready to deploy" or the reason in the table itself. Keyed by component so a stale plan cannot linger.
- **Pre-flight's health check is narrower than `just doctor`**, on purpose: the component's container running and healthy, its
  own canaries green *before* the update (a component that was already broken cannot be verified), and - the one that matters
  most - `docker compose config --hash` proving the recipe recreates this service and nothing else in its project. `just
  up-monitoring` recreates every changed service in `monitoring/`, so without it updating Loki would silently apply a merged
  Grafana pin (one-way) with no snapshot. `just doctor` is a whole-box sweep that is often amber for reasons unrelated to the
  component (a stopped project), and would block every update.
- **Backups:** the newest file in `~/backups/postgres` (the nightly marker) and, for a time-series component, its own kind, must
  be under 24 h old.
- **Snapshots** go to `~/backups/pre-update/<ts>-<component>/` (700, last 3 kept): the pin line, the compose file, the plan, the
  old image's id and digests; for VictoriaMetrics and Loki also the data, through the same `bk_snapshot_vm` /
  `bk_snapshot_loki` the nightly backup uses (`scripts/snapshot.sh`), so `just restore-<kind>` restores it.
- **The pull is checked**: the pulled image must carry the digest discovery recorded for the tag; a moved tag aborts before
  anything running changes.
- **Canaries read bodies** (rule 7), from inside the component's network namespace with the backup helper image: cAdvisor,
  node-exporter and postgres-exporter `/metrics` must carry a named metric; Alloy's `/-/ready` must say ready; Headlamp's
  `/config` must carry `"clusters"`; VictoriaMetrics' `up` must return series; Loki's `/ready` must say `ready` and a count over
  the last 2 minutes must be non-zero.
- **The time-series restore rule.** A time-series component also has a history probe - a query evaluated at a fixed moment T0
  before the update (`count(up)` for VictoriaMetrics, a line count for Loki). On any failure the image is rolled back first;
  the data snapshot is restored **only if the history probe still fails under the old image**, i.e. the data itself is
  damaged. A restore discards everything written since the snapshot, so it is never the first move.
- **Results**: `succeeded`, `rolled_back`, `aborted` (snapshot or pull failed; nothing running changed), `failed` (the rollback
  did not restore health - a person is needed), `refused` (validation or pre-flight; nothing touched).
- **Records**: `status.json` after every step, `history.jsonl`, and the executor's own `audit.log` - all in the state directory
  bothy-ops mounts read-only, not in `apps/bothy-ops/audit`, which bothy-ops can write. The request itself is a line in
  bothy-ops' `admin.log`. `bothy_update_last_result{component,result}` goes to node-exporter's textfile directory.
- **No updater timer.** Nothing is applied unless someone asked; the night window and `auto` are step 7.

### Step 5 (2026-09-19): the one-way app-db class

Grafana and Keycloak migrate their database on the first start of a new version, and the old version cannot read the
result. So the class differs from the two before it in one rule: **the rollback always restores the snapshot, first**.

- **Snapshot.** Grafana is **stopped**, its whole `grafana_data` volume (grafana.db and plugins) is tarred and grafana.db
  integrity-checked, then Grafana is started again (seconds of downtime; the recreate follows). Keycloak is a
  `pg_dump -Fc` of the database its `KC_DB_URL` names, from that postgres container, with Keycloak running (a dump is
  one consistent snapshot), and it is proven readable with `pg_restore -l` before anything changes. The postgres
  superuser's credentials come from the checkout's `.env` and reach `docker exec` as `-e PGUSER -e PGPASSWORD`
  (environment), never as argv.
- **Rollback, in this order:** stop the new container; restore (empty the volume and unpack it / drop, recreate and
  `pg_restore` the database, then check integrity / the table count against the dump); only then write the previous
  image back on *every* pin line and run the recipe, and the old image must pass the same canaries. The container is
  left stopped by the restore, because starting it on the new image would migrate the restored data again. If the
  restore fails, the old image is **not** put back (it may not read what is there) and the result is `failed`.
- **scripts/restore.sh's grafana path was not reused**: it replaces grafana.db from a nightly `.db` file and restarts
  Grafana on the image it has - after an update, the new one. The pre-update tar is the whole volume instead.
- **Two pins.** Keycloak's image is pinned twice (`keycloak`, `keycloak-init`). A component may now list several pin
  lines; every one must name exactly the same repository, tag and digest, or there is no plan (a Dependabot PR that
  bumped one line is refused in words, not half-deployed). The plan lists them all, the scope check allows every pinned
  service to change, and a rollback writes all of them back. A single-pin plan keeps the id it had.
- **Canaries.** Grafana: `/api/health` says `database: ok` and the expected version; the dashboard count (API search,
  admin login from `.env` on stdin) is at least pre-flight's; datasource `uid=prometheus` `/health` is `OK`. Keycloak:
  the discovery document's `issuer` equals pre-flight's; realm `devbox` exists; `keycloak-init` ran after Keycloak
  started and exited 0; `bothy-admin` (scripts/keycloak-admin-client.sh) gets a client-credentials token, its secret
  read from `apps/bothy-ops/secrets/` and sent on stdin; and a **real sign-in** through oauth2-proxy (the seeded
  `DEV_LOGIN_USER`) gets 202 for `allowed_groups=viewer` and 403 for `allowed_groups=shell` - without a session both
  would be 401, which proves nothing.
- **What the plan says.** Keycloak: logins unavailable for about 1-2 minutes, every gated route fails closed meanwhile,
  and nobody is signed out - Keycloak 26 persists user sessions in its database by default (verified in the 26.0.0
  release notes: "In Keycloak 26, this feature is enabled by default. This means that all user sessions are persisted
  in the database by default"; nothing here disables it), and oauth2-proxy's cookies are untouched. A rollback ends
  sessions started after the dump.
- **Confirmation.** One-way plans are `confirm: type-name`; bothy-ops refuses anything but the component's id, and the
  executor refuses the same again for a request written straight into the spool.
- **Channels unchanged:** Grafana `notify`, Keycloak `manual`. Neither is ever automatic; both are one typed name, and
  the plan is still only "deploy what main pins".

### What steps 5-8 plug in

- **Step 5, one-way (Grafana, Keycloak)** - built, above. The sketch was: a class in `updater/classes.py` with its snapshot (Grafana stopped then the
  volume tarred; `pg_dump -Fc keycloak`), its canaries in `canaries.py` (`/api/health` database ok; the issuer unchanged and
  `keycloak-init` exited 0), and a `restore` that the rollback always runs (one-way means the image alone cannot go back).
  Plans for them already say `confirm: type-name`, and bothy-ops and the executor already enforce it. Keycloak has two pins,
  so `plans.py`'s single-pin rule widens to "every pin moves to the same image".
- **Step 6, own code:** built - see below.
- **Step 7, channels and the window:** built - see below.
- **Step 8, cluster add-ons and the Postgres major:** classes whose apply is `just k8s-monitoring` or the dump/new-volume
  procedure, still behind a plan id, a snapshot and verify.

### Step 7 (2026-09-19): the automatic channel is a host timer that writes a request

**The shape.** `bothy-updater-auto.timer` (03:30, `Persistent=false`) runs `python3 -m updater auto`
(`apps/bothy-ops/updater/auto.py`) on the host. It decides a night and, at most once, writes ONE spool request in exactly the
schema bothy-ops writes, with `requestedBy: "auto"`. The executor runs it like any other request - re-validation, the whole
pre-flight, snapshot, verify, rollback - so the automatic path adds no way of changing the box that a click did not already
have. The service waits for the job's result (up to 80 minutes) so `systemctl status bothy-updater-auto` says how the night went.

**The gates, in order; the first "no" ends the night:**

| Gate | What it reads | Why this and not more |
|---|---|---|
| Window | local time inside `[policy]` 03:30-05:00 | the timer is `Persistent=false` too: a night the box slept through is skipped, never run at noon |
| One a night | `auto.json` `nights[<date>]` + `history.jsonl` | tonight's job unfinished -> wait; ended in anything but `succeeded` (refused included) -> nothing more tonight |
| Idle | the spool, `status.json` | a night job never queues behind a person's |
| Backup | `systemctl show stacks-backup.service` (`Result=success`, `ExecMainStatus=0`, not running, exited after 03:00 today) **and** the newest `~/backups/postgres` file newer than 03:00 | a unit can succeed having written nothing, and a file can be yesterday's; the service is `After=stacks-backup.service`, so a backup still running at 03:30 is waited for |
| Candidates | plans refreshed now (`plans.write_all`); channel `auto`, plan deployable, `effective_channel() == "auto"` (a patch), confirm `click`, not paused | oldest first: by the night a target was first seen waiting, then by id |
| Doctor | the candidate's container running and healthy, its body canaries green now (history probes excluded) | see below; a red candidate is passed over with its reason and the next is tried |

**Doctor is the narrow health, not `scripts/doctor.sh --strict`.** `doctor.sh` is a whole-box sweep that is routinely red for
reasons unrelated to the component on offer (a stopped project, no cluster, a scrape target nobody runs); as a gate it would
shut every night, and a gate that is always shut is ignored. Step 4 made the same call for the executor's pre-flight. What an
unattended update needs is sharper: the thing about to be replaced is healthy now, by its bodies (rule 7) - and the executor
checks it again, with disk, scope and backup age, before touching anything. A whole-box outage is the alerting's job.

**Pause on failure.** Any `rolled_back` or `failed` result in `history.jsonl` for an `auto`-channel component - whoever asked
- pauses auto for it. The executor syncs the pauses after every job it runs (a guarded hook in its drain loop), and the night
job syncs them first. The pause lives in `~/.local/state/bothy/updates/auto.json`: host-written, 600, in the directory
bothy-ops mounts read-only - bothy-ops shows it and cannot clear it. A failure is handled once (its job id is remembered), so
clearing a pause is not undone by the same old history line. A `refused` job does not pause: nothing was touched.

**Unpause is an operator's, and the host's to apply.** `POST /-/api/updates/unpause` (operator, exact `Path()`, CSRF,
audited in `admin.log`) writes `unpause-<id>.json` into the spool; the update loop leaves that name alone, and the executor's
loop claims it (exact keys, `O_NOFOLLOW`, never the actor `auto`) and clears the pause, auditing who. From a shell:
`just update-unpause <component>`. The page shows paused rows with the reason and an Unpause button.

**The actor.** Every record of a night job says `auto` - `status.json`, `history.jsonl`, the executor's `audit.log` - and
the page draws it as "the night job". bothy-ops refuses a request or an unpause from a signed-in name `auto` (403), so the
name means the system only when the system wrote it.

**Alerts** (`monitoring/provisioning/alerting/rules.yml`, group `update-alerts`): `update_failed` on
`bothy_update_last_result{result=~"rolled_back|failed"}` (critical, sticky until the next success), `update_auto_paused` on
`bothy_update_paused` (a new textfile metric, 1/0 per auto component), and `update_stale`, a severity=info notice routed once a
day for a patch or minor on offer now and 13-14 days ago. `checks/e2e_update_alerts.py` loads the file into a throwaway
Grafana and evaluates the rules against a throwaway VictoriaMetrics.
### Step 6 (2026-09-19): Bothy updates itself to a green release tag

Class `own-code`, component `bothy`, in `apps/bothy-ops/updater/owncode.py`. It keeps step 4's rule - deploy only what is
reviewed - and its shape: a plan the host computes, one spool request, the executor under its lock, re-derived before it
acts. What differs is what "reviewed" means for our own code, and that the checkout MOVES.

**Tag, not `main`'s tip.** The target is the newest `v*` tag on `origin/main` that is strictly ahead of HEAD, whose commit's
`VERSION` matches its name, and whose commit's GitHub check runs all completed with none failing - asked through `gh` when
it is installed and logged in, else the public API unauthenticated (the plan names which; a green answer is cached 6 h).
`release.yml` already tags only commits whose CI passed on `main`; the check-runs question makes the updater verify that
rather than assume it. `origin/main`'s tip was the alternative: reviewed too, but at any moment possibly red or mid-CI, with
no version, no release page to link, and no stable name to refuse after a rollback. The cost is that a merged fix waits for a
`VERSION` bump - `just release`'s habit, which this makes load-bearing.

**What the plan refuses:** the updater running from the checkout it would move; a checkout not on `main`, detached, with
modified OR untracked files (the rollback resets it, and a fast-forward can clash with an untracked file), or ahead of
`origin/main`; no newer tag; a tag off `main`, behind HEAD or mislabelled; CI red, pending or absent; a release that changes
`apps/bothy/compose.socket-proxy.yml` (`just up-apps` would recreate the auth boundary with Bothy - that is a manual
update); a justfile at HEAD or at the tag without `BOTHY_UP_NO_BUILD` (predates this); a Bothy container not running HEAD's
image; a release that was rolled back before (`own/blocked.json`). **What it escalates to type-the-name, and lists:** Bothy's
compose files (applied), `edge/dynamic/` (Traefik reloads it the moment the checkout moves), other stacks' files (in the
checkout afterwards, **not** applied - their own rows offer them), and a calendar "major". It also lists the changed apps,
the commit count and diffstat, the release notes URL and CI's verdict.

**Build before switch; images named by commit.** Compose now names Bothy's images `bothy-web:${BOTHY_IMAGE_TAG:-latest}`
(and files, ops) with `pull_policy: never`, and `just up-apps` sets `BOTHY_IMAGE_TAG` to HEAD's sha. The executor builds the
target's three images from a temporary `git worktree` of the tag before the live checkout or any container is touched, so a
failed build is `aborted` with nothing running changed. An env-selected tag rather than `:latest` plus a sha alias, because
the rollback then needs neither a build nor a retag: `git reset` to the old sha and `BOTHY_UP_NO_BUILD=1 just up-apps`
selects exactly the old images by name - moving `:latest` back would be one more step that can be interrupted, leaving the
name compose uses on the wrong build. The executor also tags the running images `:<previous sha>` by id first, and `up-apps`
keeps each image's three newest commits.

**The order, and the timer.** validate (after `git fetch`) -> preflight (the three containers healthy on the planned images,
a systemd user manager, no rollback already armed) -> build -> snapshot (previous sha and image ids) -> **arm** -> switch
(`git merge --ff-only <tag>`, under umask 022 - the unit's 077 would leave the checkout's files unreadable to the containers
that bind-mount them) -> apply (`just up-apps bothy-files`, then `bothy-ops`, then `bothy-web` last, each with
`BOTHY_UP_NO_BUILD=1`) -> verify -> stage. The rollback is a `systemd-run --user --on-active` timer, armed **before** the
checkout moves (with the apply budget added) and re-armed for 10 minutes once the containers are up, so a dead updater, a
hung verify or a WSL restart anywhere after `arm` is covered - arming only after apply would leave the move itself uncovered.
The armed file is claimed by one atomic rename, so exactly one of "verify disarms it", "a failed verify fires it now" and
"the timer fires" happens. When the timer fires with the executor gone, it also finishes the job's record.

**Verify** reads bodies (rule 7): each container runs the image built above and its revision label is the target; bothy-web's
`/version.json` names the target; bothy-files' and bothy-ops' `/healthz` say `"ok": true`; an unrouted path serves the same
`index.html` as `/`, inside bothy-web and through the edge. `just ops-check offline` is NOT run here: it is what CI already
ran on the tagged commit, and a harness problem on the box should not roll back a good release.

**The reset.** The rollback runs `git reset --hard <previous sha>`. That is acceptable ONLY because pre-flight proved the
tree clean and the move was a fast-forward: every file the reset touches is one the fast-forward wrote. An edit made inside
the window anyway (the bothy-files editor) is saved to `own/<job>.dirty.json` before the reset.

**The updater never replaces itself.** It runs from `~/.local/lib/bothy-updater/<sha>/` (the Python it imports, exported
from git by `just install-updater`, with an `INSTALL.json` naming the checkout and each file's git object id) through a
`current` symlink that `bothy-updater.service`, `bothy-updates-discover.service` and step 7's `bothy-updater-auto.service` all use - discovery writes the plans,
and a plan id must be computed by the code that re-checks it. A release whose updater files differ from the installed copy
only **stages** the new copy (`staged` symlink, `state/updater.json`); Settings > Updates and `just update-status` say a
switch is pending, and `just install-updater` makes it, between jobs. The own-code plan refuses while the updater runs from
the checkout itself.

**`bothy upgrade`** now drives the same path when the updater is installed (`python3 -m updater upgrade`: plan, confirm,
spool request, executor) instead of a blanket `git pull && just up`, which bypassed every check here and would move the
checkout the rollback depends on. Without the updater (fresh installs, CI) it keeps the old pull-and-apply path and says so.
`upgrade.yml` runs `just up`, not `bothy upgrade`, and still asserts HEAD's code runs.

**Open tabs.** Every tab polls `/version.json` (a minute, and on focus) and shows "Bothy updated - reload" when the served
revision is not the one it loaded; a chunk that fails to load reloads the tab once per ten minutes.

**Tests.** `checks/test_owncode.py` (every refusal, against a throwaway origin with annotated tags) and
`checks/e2e_owncode.py` (a throwaway clone and compose project with no host ports: v1 -> v2; a forced verify failure and a
killed executor both restored to v1 by the rollback, the timer compressed to 8 s; a release that changes the updater staged,
not switched). Four `mutants.sh` rows.

## Sources

- Watchtower archived: https://github.com/containrrr/watchtower/discussions/2135
- Diun: https://github.com/crazy-max/diun
- Komodo auto-update / periphery socket: https://komo.do/docs/deploy/auto-update
- Renovate docker digests: https://docs.renovatebot.com/docker/
- Keycloak upgrading (no downgrade except restore): https://www.keycloak.org/docs/latest/upgrading/index.html
- Grafana upgrade (back up the DB; stop first for SQLite): https://grafana.com/docs/grafana/latest/upgrade-guide/
- Loki schema (future `from`, no rollback): https://grafana.com/docs/loki/latest/operations/storage/schema/
- VictoriaMetrics upgrade/downgrade: https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/
- Postgres major upgrade images: https://github.com/pgautoupgrade/docker-pgautoupgrade
