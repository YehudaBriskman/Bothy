# Updates: keeping every part of Bothy current from the web UI

Status: **steps 0-8 built** (step 4, the updater for the stateless and time-series classes; step 5, the one-way
app-db class for Grafana and Keycloak; step 6, Bothy updating itself; step 7, the automatic channel - all 2026-09-19;
step 8, the cluster add-ons and the Postgres major - 2026-09-22; applying a whole `apply` recipe at once, and the
Update/Apply distinction - 2026-10-07; see [Decisions](#decisions)). What remains is listed
under [What is left](#what-is-left). Written 2026-09-18 from two read-only surveys:
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
- **Drift is two questions, and the box answers both** (2026-10-08). `drift` is "the IMAGE that runs is not the image the files pin", read from references and digests. `configDrift` is "the merged compose CONFIGURATION that runs is not the one the files declare", read from `docker compose config --hash` against the container's own `com.docker.compose.config-hash` label - once per compose project, through the same `hostio.compose_project()` the scope check uses, so the two can never disagree about what a project is. A pin line whose image already drifts is not reported twice: the image reference is part of what compose hashes, so `configDrift` means exactly *the image matches and the configuration does not*, which is the state nothing in the pipeline could see. It is a sentence with compose's two hashes in it and never a diff - `docker compose config` resolves `.env`, so the rendered configuration carries secrets and `available.json` is served to a `viewer`. Counted in `summary.configDrift` and exported as `bothy_update_config_drift{component}`.
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
| Database | postgres | `pg_dumpall`; the old volume itself | major: **yes** | back to the OLD volume | minor: by hand. Major: plan kind `postgres-major`, manual, typed AND noted (§5, step 8) |
| Own code | bothy-web, bothy-files, bothy-ops (plus the repo) | git SHA; images kept as `bothy-*:<sha>` | no (no database; audit and state live outside the images) | re-tag the previous SHA's images | `notify`; manual, one click |
| Cluster add-ons | kube-state-metrics (helm), alloy DaemonSet | `helm get values` plus revision; `kubectl get -o yaml` | no | `helm rollback <rev>`; `kubectl replace` of the saved objects | `notify`, host kubeconfig only, **never** bothy-ops' namespaced token (rule 6). Built in step 8 |
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
- **Postgres major** (17 → 18): never automatic, never one click - built in step 8 as the plan kind `postgres-major`
  ([Decisions](#step-8-2026-09-22-cluster-add-ons-and-the-postgres-major)). The PR changes the image AND the volume
  name (`postgres18_data`), both pins; the updater dumps, restores into the new volume, compares every row and
  switches. The old volume stays as the rollback and is deleted only by hand, later. Prefer this over `pg_upgrade --link`, which shares data files with the old cluster and so weakens the rollback. `keycloak-db-init` moves to the same major in the same plan.
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
  - **And the refusal says how far it reaches** (2026-10-08). One uncommitted line in `monitoring/compose.yml` refuses the plan for all **six** components pinned in that file; each of the six used to say only that the file had local changes, so the page showed six rows blaming one file with nothing saying it was one edit. The refusal now names the count and the components, and drops the names rather than the sentence if they would not fit the 300-character cap.
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
8. **Cluster add-ons** (helm and manifests) and the Postgres major procedure: documented, manual, and still driven through the same plan, snapshot and verify path. **Built 2026-09-22** - see [Decisions](#step-8-2026-09-22-cluster-add-ons-and-the-postgres-major).

## 8. Settings → Updates (UI)

- **Update and Apply are different words** (2026-10-07, see
  [Update, and Apply](#update-and-apply-2026-10-07-the-distinction-the-page-was-missing)): Update moves a
  pin in `main` (a PR, elsewhere); Apply makes this box run what `main` already pins, which is all this
  page does. The headline leads with how many pins are **not applied**.
- **A group row per `apply` recipe** (2026-10-07, see
  [Applying a whole recipe](#applying-a-whole-recipe-2026-10-07-the-refusal-had-no-action-behind-it)):
  where one recipe has more than one merged pin waiting, no single component can be applied, so the group
  applies them together - and a member's own button opens the group rather than a refusal.
- **Controls** (built 2026-10-06, see
  [the two asks](#the-two-asks-2026-10-06-check-for-updates-now-and-run-the-night-job-now)): Check for updates,
  What would tonight do?, Run the night job. Each shows the host's own record of the last run, because both can
  finish with nothing visibly different.
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
- **Step 8, cluster add-ons and the Postgres major:** built - see below.

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

### Step 8 (2026-09-22): cluster add-ons, and the Postgres major

**Cluster add-ons: class `cluster`** (`updater/cluster.py`, `updater/k8s.py`). Same rule as every class: deploy only
what `main` pins. The plan is "the cluster runs W; main pins X":

| | kube-state-metrics (source helm) | alloy-cluster (source manifest) |
|---|---|---|
| W | the release's chart version (`helm list`) | the DaemonSet template's image (`kubectl get`) |
| X | the dependency in `k8s/monitoring/Chart.yaml` | container `alloy`'s `image:` in `k8s/monitoring/alloy.yaml`, with discovery's digest |
| Snapshot | `helm get values` + `get manifest` at the recorded **revision** | `kubectl get -o yaml` of the DaemonSet and every ConfigMap it mounts, plus a cleaned JSON copy |
| Apply | `just k8s-monitoring ksm` | `just k8s-monitoring alloy` |
| Verify (bodies) | helm deployed at a newer revision; `/metrics` through the NodePort carries `kube_node_info`; VictoriaMetrics' `up{job="kube-state-metrics",cluster="thales-scc"}` is 1 **from a scrape after the upgrade** (`timestamp()`) | rolled out and ready on every node, every pod's `imageID` ending in the planned digest; Loki holds `{cluster="thales-scc"}` lines **written after the rollout** |
| Rollback | `helm rollback <release> <revision> --wait` | `kubectl replace` of the saved ConfigMap(s) and DaemonSet, then the rollout |

- **Narrow apply.** `scripts/k8s-monitoring.sh` takes a part (`ksm`, `alloy`; none = everything, as before). The full
  script applies both add-ons, so updating Alloy through it would also apply a merged-but-pending chart bump with no
  snapshot - the cluster's version of the compose scope check.
- **Identity (SECURITY.md rule 6).** The operator's kubeconfig (kubectl's default, or `Config.kubeconfig`), and the
  context named on **every** kubectl/helm argv - never the current one. The plan asks `kubectl auth whoami` and
  refuses any `system:serviceaccount:*` identity, which bothy-ops' namespaced token is; pre-flight refuses if the
  identity changed since the plan.
- **The rollback writes the old pin back** on its one line (Chart.yaml's `version:`, alloy.yaml's `image:`), strictly
  and uncommitted - the same honest dirty tree as the compose classes, so the next `just k8s-monitoring` keeps what
  works.
- **Refused at plan time:** a ServiceAccount identity; no context; not installed; a release not `deployed`; nothing to
  deploy; a downgrade; a major; discovery older than the checkout; an unknown digest or a floating pin; another image;
  a workload that is not a DaemonSet; a dirty pin file; not on main or ahead of origin/main.
- **Channel `notify`.** `AUTO_CLASSES` excludes `cluster`: never automatic; a click deploys a patch or a minor.
- **Discovery** already read both pins; its `plans.write_all` now yields deployable cluster plans. Checked read-only
  against thales-scc on 2026-09-22 (a scratch clone with bumped pins): both planned, and the four checks green.

**The Postgres major: plan kind `postgres-major`** (`updater/pgmajor.py`; class `database`, component `postgres`).

*How it fits "deploy what main pins".* `main` must pin the new major **and** the new volume name, so the PR for a
Postgres major changes, in one commit: `data/postgres/compose.yml`'s `image:` (an exact `<major>.<minor>@sha256:…`),
the service's mount `- postgres<N>_data:<dir>` and its top-level declaration, and `auth/compose.yml`'s
keycloak-db-init image (the same ref). The updater performs the data move. Until it has, `just up-data` refuses
(`scripts/pg-volume-guard.sh`): a plain `up` would start Postgres - and Keycloak's realm - on the empty new volume.
So the nightly `upgrade.yml` goes red once, on the night its HEAD^1 -> HEAD crosses the major; that is the guard
working. Postgres 18+ keeps its data under `/var/lib/postgresql/<major>/docker` and refuses a mount at
`/var/lib/postgresql/data`, so the PR mounts the volume at `/var/lib/postgresql`. The plan refuses: the same volume
name, any name but `postgres<N>_data`, an undeclared or optioned volume, 18+ at the old mount, keycloak-db-init on
another ref, a pin without a digest, a minor, a downgrade, and a new volume that already exists (an earlier attempt:
a person looks, then removes it - the updater never deletes a volume).

*Never automatic, never one click.* `confirm: type-name` **and** `requiresNote`: bothy-ops (the operator route)
refuses a request without the typed id and a one-line maintenance note of 10-500 characters, and refuses a note on any
other plan; the note goes into the spool file and `admin.log`; the executor checks both again and refuses the actor
`auto`. `database` is not in `AUTO_CLASSES` and the channel is `manual`, so the night job never sees it.

*The procedure*, one `status.json` step each: **preflight** (the nightly pg_dumpall < 24 h; free disk >= 3x the data
for Docker, 2x for the dump; Keycloak healthy and its step-5 canaries green; the new volume absent; the recipes touch
only the pinned services) -> **pull** (by digest) -> **stop** Keycloak, oauth2-proxy, postgres-exporter -> **dump**
(`pg_dumpall` with the NEW major's client over the old container's loopback; every table's row count read from the
dump's COPY blocks; then the old Postgres stops) -> **create** the new volume (with compose's labels) and a temporary
container on the new image, no network -> **load** (every stderr line read; only `role "<superuser>" already exists`
allowed) -> **compare** (every database and table row count equal to the dump's, Keycloak's `user_entity` named; the
temporary container goes) -> **switch** (`just up-data`: compose recreates Postgres from main on the full volume) ->
**start** (`just up-auth`: keycloak-db-init on the new major, Keycloak, oauth2-proxy, keycloak-init) -> **verify**
(databases and Keycloak's users present, both pins on the new image, Keycloak's canaries: issuer, realm,
keycloak-init, the admin token, a real sign-in viewer 202 / shell 403).

*One deliberate reordering of the brief:* the writers stop **before** the dump. A dump taken while Keycloak runs loses
whatever Keycloak writes until it stops, and "the row counts match the dump" would hold for a dump already stale. The
"fresh pg_dumpall" pre-flight is the nightly one.

*Rollback: to the OLD volume, never deleted.* Before the switch nothing in the tree moved and the old container still
exists: the temporary container goes, the old Postgres and the writers start again. After it, the old image (both
pins), the old mount and the old declaration go back on their lines - strict one-line edits, uncommitted - and
`just up-data` / `just up-auth` put everything back; what was written to the new cluster since the switch is lost. The
new volume is kept for a person. Deleting the old volume is a separate manual command that the plan and the result
name (`docker volume rm postgres_postgres_data`).

**Tests.** `checks/test_step8.py` (both kinds of plan and every refusal, against copies of the real files, with fake
kubectl/helm and docker inspect; the note rules; the dump reader; the guard); `checks/api_updates_apply.py` (the note
through the real handler); `checks/e2e_pgmajor.py` (throwaway Postgres 17 with a seeded dev DB and a fake Keycloak
schema -> 18: a forced failure before the switch and one after it, each back on the 17 volume with every row, then
success); `checks/e2e_cluster.py` (a throwaway `minikube -p bothy-cluster-e2e` in a temporary kubeconfig with a
throwaway VictoriaMetrics and Loki: kube-state-metrics 8.4.2 -> 8.5.0 and Alloy v1.19.1 -> v1.19.2, each forced to
roll back, then deployed). Seven `mutants.sh` rows.

### The two asks (2026-10-06): "check for updates now" and "run the night job now"

The ask was "all the updates commands available from the UI, via buttons". `just --list` held six update
commands; two of them were the only cure for a state the page **showed and could not change**, and that is
the whole argument for adding a route:

- `just updates-discover` - discovery is a six-hourly timer, so the page can say "checked 5 h ago" and
  offer no way to fix it. A shell is not an answer to a stale page.
- `just update-auto` - the night job's decision was readable ("nothing eligible", "backup failed") and
  not re-askable, and there was no way to ask "what would tonight do?" at all.

**What was built.** Two more exact `Path() && Method()` routers, both `operator`:
`POST /-/api/updates/discover` (`{}`) and `POST /-/api/updates/autorun` (`{dry_run}`). Both keep shape 1 →
shape 3: bothy-ops writes ONE file into the spool and answers 202; the host executor's drain
(`updater/asks.py`) claims it, re-checks it and runs it. Three controls in Settings → Updates: **Check for
updates**, **What would tonight do?** (the dry run) and **Run the night job…** (a dialog, a click rather than
the typed name, because what it may deploy is a *patch* of a two-way class).

**Why they are writes, not reads.** Neither deploys anything by itself, and `viewer` was tempting for both.
Discovery rewrites `available.json` and every plan file - the facts the whole page is drawn from - and spends a
registry quota that is per public IP. The night job runs the gate chain that ends in a deploy. A `viewer` gate
on either would let anyone who can read the page change what it says.

**Why the night-job button is not a bypass.** It runs `auto.decide()` unchanged, so by day the honest answer is
"outside the window (03:30-05:00)" - and that reason is the feature. Its update request still carries the actor
`auto`, because `auto` names who *chose* the component, the level and the plan; who asked it to run early is
recorded beside it. bothy-ops still refuses to write that actor itself.

**The rate limit is the host's.** `DISCOVER_MIN_SECONDS` (300) lives in `updates.py`, which both halves import.
bothy-ops refuses early so the button can say how long is left; the host refuses again off `available.json`'s
own mtime, in the directory bothy-ops mounts read-only - the copy that holds if the asking process is the thing
that is wrong.

**What was deliberately left out, and why.**

| Not built | Why |
|---|---|
| **Editing a component's channel** (a §8 extra) | Moving one to `auto` arms unattended deployment: a privilege change, not a preference. And `updates.toml` is `COPY`'d into bothy-ops' image, so writing it needs a read-write mount of the checkout - exactly what SECURITY.md rule 8 says bothy-ops does not have. Routing it through the `editor` config tier is worse: a *lower* tier granting a privilege `operator` holds. `load_catalog()` already refuses `auto` outside `AUTO_CLASSES`, so the catalog cannot widen the classes - but a click arming an eligible one is still a privilege change, and it belongs in a reviewed commit. |
| **A history row's "Roll back"** (a §8 extra) | There is no host plan to ask for. The updater rolls back only inside a job whose verify failed; a deliberate rollback of a *finished* job is a new plan kind (and for a one-way component, a restore that discards everything written since). That is a build step, not a button. `just update-rollback` does not exist either. |
| **`just update-pauses`** | Already displayed, so this would be a second copy of one fact: every paused row carries its pause, its reason and **Unpause**, and Channels shows the list and the night job's last decision. The gap was display and it was already closed. |
| **`just install-updater`** | A host operation, and the point of it is that it is *not* clickable: a release that changes the updater only stages the new copy, so the program that validates the next request changes when a person says so. The page already says this when one is staged. |
| **`just release`** | A repository operation - it cuts and pushes a tag. It changes nothing about this box, and the box deploys a tag only once CI has marked it green. |

### Applying a whole recipe (2026-10-07): the refusal had no action behind it

**What happened.** Every click in Settings > Updates was refused with the same words:

> `` `just up-monitoring` would also recreate or create alloy, grafana (its configuration changed since it was started) - apply that first, by hand if the updater does not handle it ``

Three requests in four minutes - alloy, grafana, victoriametrics - each naming the other two
(`history.jsonl`, 12:17-12:22). The check that refused them is step 4's `_scope`, and it is **right**:
`just up-monitoring` is one `docker compose up` over the whole project, so applying Loki's merged pin
would recreate Grafana on its merged pin too - a one-way migration, with no snapshot of Grafana.

The defect was not the check. It was that **the product stated what had to happen and gave no way to do
it**, and the state it named is not one a single-component updater can ever leave: with two services of
one project behind, *no* component can be applied first. On 2026-10-07 ten components were behind on
apply and three of them were in `monitoring/`. Nine minutes later someone did what the message said and
ran `just up-monitoring` by hand - which recreated all of monitoring at once, Grafana included, with no
snapshot, and left Grafana `created` and never started. That is precisely the outcome `_scope` exists to
prevent, reached by following the product's own advice.

**The decision: a GROUP is the missing action, and the scope rule does not move.** `updater/groups.py`.
A group is one `apply` recipe (`just up-monitoring` -> the group id `up-monitoring`) and, as its members,
every component that shares that recipe, is one of `GROUP_CLASSES` (`stateless`, `timeseries`, `app-db` -
the plain compose image pipeline) and has a deployable single-component plan now. Two or more, or there is
no group: with one member the component's own Apply is the answer. The scope check is then run
**unchanged**, over the UNION of the members' pinned services, and anything still left over refuses - with
the service named, whose it is, and why the group will not carry it.

| | one component (step 4) | a group (this) |
|---|---|---|
| What is approved | a component and its plan id | a recipe and its group plan id |
| Confirmation | the plan's (`click`, or the component typed) | the strictest any member needs, and the **recipe's** name is what is typed |
| Snapshot | that component's class snapshot | **every** member's, one-way first, all before any pull |
| Pre-flight | that component healthy, its canaries green, scope = its services | every member healthy, every member's canaries green, scope = the union; **and the actor is never `auto`** |
| Verify | its canaries | every member's |
| Rollback | its pin line, its data if the probe says so | every pin line, every one-way member's data first - **all or nothing** |
| Channel | `auto` possible for a patch of an auto class | never automatic, by rule and by construction |

**Why the union and not the loosest.** A group must never be a way to get a strict component applied under
a lax rule, and the only safe reading of "several classes in one apply" is the strictest of them. So one
`app-db` member (Grafana) makes the whole group type-the-name, takes its stop-and-tar snapshot first, and
makes the rollback a restore; the required backup ages, the snapshot kinds and the disk estimate are
unions; the level is the largest step. `checks/test_groups.py` asserts each of those, and
`scripts/checks/mutants.sh` plants "the group is the LOOSEST of its members" to prove the check notices.

**What is typed is the GROUP's name**, not a member's: a component's id would misname what is being
approved. bothy-ops and the executor both refuse anything else - a click, or a member's id.

**Rollback is all-or-nothing, and the UI says so before the button.** The apply is one
`docker compose up`, so the rollback is one too: every member's previous image goes back on every pin line
(uncommitted, on purpose) and the recipe runs once. A one-way member's data snapshot is restored FIRST,
with its container stopped, exactly as the single-component path does; if that restore fails, no old image
is put back and the result is `failed`.

A *partial* rollback is mechanically possible - write one member's pin back and run the recipe, and compose
recreates only that service - and it is **deliberately not offered**. Verify failing for one member does not
say the others are healthy together; the result would be a combination of versions no commit on `main`
describes and nobody reviewed; and it would be reached by a second recipe run subject to the same scope trap.
The operator approved one apply, so one apply comes back. The plan's `rollback` words and the confirm dialog
both state this in those terms.

**Never automatic, twice over.** `AUTO_CLASSES` is irrelevant here because the night job cannot reach a
group at all: `auto.decide()` picks from `plans/<component>.json`, groups live in `groups/<recipe>.json`,
and `auto._write_request()` still asserts its spool keys are exactly the single-component ones. On top of
that, `spool.validate_against_group()` refuses the actor `auto` outright, and bothy-ops refuses to write it.

**Config-only changes stay out, named.** A service whose compose config hash differs for a reason that is
*not* an image pin (its environment changed in `main`) is refused rather than carried, because a rollback
could not put that change back: the updater writes pin lines, strictly, and nothing else. The refusal says
which service and that the group moves image pins only. That is the honest limit, and it keeps the rollback
true.

**No new route and no new gate.** The group read is `GET /-/api/updates/plan?group=<recipe>` and the ask is
`POST /-/api/updates/request` with `{group, plan_id, confirm}`. A group is not a new *kind* of power over
this box - it is the one `/updates/request` already holds, over a plan the host wrote about a recipe rather
than about one component - so it gets no new surface at the edge: still seven routers, still `operator`,
CSRF, the de-identify middleware, one audit line, one spool file, and the host deciding. The spool file is
the same `<jobId>.json` with `kind: "group"`, so the path unit, the global lock, claim-before-run and every
record are unchanged. `mutants.sh` plants an eighth router to prove `wiring_updates.py` would catch one.

**A group job's records name the recipe**, because that is what the job is about, with `members` beside it.
That also closes a gap the pause would otherwise have had: `auto.sync_pauses()` reads `members`, so a group
that rolled back pauses every `auto` component it moved - which it could not have done from `component`
(`up-monitoring`) alone.

### Update, and Apply (2026-10-07): the distinction the page was missing

Every button said **Update**, and the page's only headline count was `updates` - "what is newer upstream".
They are two different actions:

- **Update** moves a pin in `main`: a Dependabot PR, reviewed and merged. It happens on GitHub, not on this
  page, and the updater deliberately cannot do it (step 4's decision).
- **Apply** makes this box run what `main` already pins. It is the *only* thing this page does.

On 2026-10-07 the headline read "2 with a newer version" while **ten** components were behind on apply. The
one number nobody could see was the one that mattered, which is how three refusals in a row came to read as
a fault rather than as a state with a cause. So: `summary.toApply` joins the status payload and leads the
headline ("N components have pins this box has not applied"), the row action and its accessible name say
**Apply**, the table note explains both words, and `update-apply` opens with "Update, and Apply". Where a
recipe has more than one pin waiting the row's button opens its **group** instead of a request the host is
certain to refuse, and the row's disclosure says why in a field called "Not on its own".

This was the deeper fix, and it is cheap: the page already used "deploy what main pins" in prose while
labelling the button "Update". Naming the two actions differently is what stops the confusion arising,
rather than explaining it afterwards.

**Tests.** `checks/test_groups.py` (membership, the union, the scope over it with every leftover named, the
id's staleness, the spool shape and its refusals, a job whose snapshots all precede any pull and whose
rollback is all-or-nothing, and the pause of every `auto` member); `checks/api_updates_apply.py`'s group
section (the real handler: the allow-listed group plan, twelve refusals, a member's own apply refused while
its group waits, and one 202 leaving exactly one spool file); `wiring_updates.py`'s GROUPS section; twelve
`mutants.sh` rows.

### Look again when the run ends (2026-10-09): the button that outlived the work

The owner applied an update and the page **still** showed Update for a component already at the target.
Pressing it gave *"Refused - nothing was touched · kube-state-metrics · the plan no longer holds: nothing to
deploy: the cluster runs what main pins (8.6.0)"*. Measured on the box:

```
available.json written    11:43:25
the apply happened        11:52:15   (helm revision 5)
```

The page was drawing a button from data written **nine minutes before the work was done**. The cause was in
`updater/executor.py` `run_spool`: it drained asks, ran each request, and never looked at the box again.
`_hook(cfg, "asks", "drain_discover")` only drains *explicit* discover asks, so after any job the host's own
view stayed stale until the six-hourly timer - up to six hours of a button the host was certain to refuse.

**The host half.** A drain that ran at least one job ends with one discovery (`updater/asks.rediscover`),
once however many jobs it ran, because one discovery covers every component. Three decisions in it:

- **A refused or failed job re-checks too**, and that is the most important case, not an exception to it: a
  refusal of the form "the plan no longer holds" *is* the evidence that the stored data was stale. The
  owner's screenshot was a refusal.
- **A failed re-check is not a failed job.** The deployment already happened; a stale `available.json`
  afterwards is a separate and lesser fault. So it is one audit line and one journal line naming
  `just updates-discover`, never an exception - the same treatment the drain's other hooks get, and for the
  same reason: a fault in the bookkeeping must never stop (or undo) a rollback.
- **Under the same `flock`, proven rather than reasoned about.** Discovery is a *subprocess* that takes no
  lock of any kind (there is no `fcntl` anywhere in `discover_updates.py`), and the drain has run that same
  program from inside that same lock since 2026-10-06. `checks/test_updater.py` now runs a child from exactly
  where the re-check runs, has it try that very `flock`, and asserts it finds it **held** - so a discovery
  that ever started locking is caught by a failing check rather than by a wedged box. Holding it is also what
  we want: a request queued while the re-check runs waits for the fresh plans instead of racing them.
- **No new power, and the ask's rate limit deliberately does not apply.** It is the timer's own argv, built
  from `Config` alone; nothing in the spool can ask for it. `updates.DISCOVER_MIN_SECONDS` bounds the
  *asking* process's share of the anonymous registry quota; this one is the host reacting to work the host
  had just done, at most once per drain. Applying the limit would restore the bug for the commonest sequence
  there is - "check now", then Update, four minutes later.
- **The night job needs nothing of its own.** `python3 -m updater auto` writes one request into the spool and
  waits; `bothy-updater.path` starts the executor; that drain is the one that re-checks.

**The ordering problem, which the host half alone does not fix.** The page reloads when the job turns
terminal, and the re-check runs *after* the job. The reload wins by seconds, re-reads the same
`available.json`, and the button is still there - the bug survives the fix. Of the three ways out
(discovery before the terminal record; the read side reporting the re-check; the page reloading again), the
first is wrong - a job would sit "running" for the length of a registry round, and a hung registry would hold
it open - and the third needs the page. So the **read side** answers it, and it needs no change to the page
at all because the row's button is already drawn from `plan.deployable`:

`updates.py` `_unlooked_since` will not offer a plan for a component a job touched since discovery last
looked. The row shows no button and says why; `summary.toApply` drops with it; the group plan goes the same
way as its members' (one `just up-monitoring` recreates all of them, and suppressing the group alone would
leave its other members offering an individual Update the host's scope check refuses). It is self-healing:
the moment the re-check lands, every plan is newer than the job and the truth is back - including for an
`aborted` job, where the plan still holds and the retry must stay possible.

**Tests.** `checks/test_updater.py`'s RE-CHECK section (once per drain not once per job, a refused job
re-checks, the lock is held, a failure changes no result and is reported twice);
`checks/test_auto.py` (an empty drain looks at nothing; the night job's drain re-checks);
`checks/api_updates.py`'s "outgrown" section (before and after the snapshot, one component only, the
headline count, a group job's `members`, the group cascade with nothing left claiming an action, and the
mtime fallback); five `mutants.sh` rows. The e2e harnesses pass `rediscover=False` and say why: they drive
`run_spool` directly with a throwaway catalog whose registry only their own fake client can read.

## What is left

- **The auth boundary and the edge** (oauth2-proxy, the socket proxies, Traefik) are still updated by hand (§4).
  This is now the one case a group cannot help with either: `just up-auth` holds Keycloak (app-db) **and**
  oauth2-proxy (boundary), so Keycloak's apply is refused and no group can carry it - the refusal says exactly
  that. Bringing `boundary` into the updater (its probes, and dependabot.yml's "review by hand" rule) is what
  would close it.
- **A Postgres minor** is still `just up-data` by hand; the updater moves Postgres only across a major.
- **Host tooling** (minikube, kubectl, helm) stays out of scope until it is pinned in mise (§4).
- **§8 extras:** editing a channel from the page (through the config tier) and a history row's "Roll back" as a plan.
  Both were looked at on 2026-10-06 and deliberately left out - see
  [the two asks](#the-two-asks-2026-10-06-check-for-updates-now-and-run-the-night-job-now) for why.
- **Editor saves committed to a `local/edits` branch** (§6): the updater still refuses a dirty tree instead.

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
