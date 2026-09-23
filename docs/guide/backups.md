# Backups

Everything on the box that cannot be rebuilt from git is backed up nightly, and
each kind that a service reads has a restore recipe that has been run.

| Set (`~/backups/<set>/`) | What it carries | How it is taken | Kept | Size on this box (2026-09-19) |
|---|---|---|---|---|
| `postgres` | Keycloak's realm, users, clients and roles, **and** the dev database | `pg_dumpall`, gzipped | 14 | 72 KB |
| `grafana` | `grafana.db` - users, alert state, dashboards made in the UI | SQLite online-backup API, integrity-checked, Grafana keeps running | 14 | 2.8 MB |
| `env` | `.env` - every credential on the box, gitignored, in exactly one place on earth | a copy | 14 | 4 KB |
| `victoriametrics` | every metric, 15 days | `/snapshot/create`, a tar of the snapshot, snapshot deleted | **3** | 408 MB |
| `loki` | every log line, 7 days | `/flush`, stop Loki, tar `/loki`, start | **3** | 19 MB |
| `alloy` | Alloy's positions - how far into each log it has shipped | a tar of its volume | 14 | 48 KB |
| `state` | the audit logs (`apps/bothy-ops/audit`, `apps/bothy-files/audit`) and the two trash directories (`~/.local/state/bothy/{trash,config-trash}`) | a tar | 14 | 16 KB |
| `notes` | `~/claude-notes` (`$NOTES_ROOT`) | `git bundle --all`, plus a tar of uncommitted files when there are any | 14 | 112 KB |

One night is about 430 MB, nearly all of it VictoriaMetrics; with the keep counts
above the whole of `~/backups` settles around 1.3-1.5 GB. The run itself takes
~30 seconds.

`.env` is the one people forget. It is not in git by design, so if the disk
goes, the file goes with it and every generated secret goes with that.

## When it runs, and where it lands

`stacks-backup.timer` runs `scripts/backup.sh` at **03:00 daily**, at idle I/O
priority. On demand:

```sh
just backup            # or: bothy backup
```

The destination is `$BACKUP_ROOT`, which defaults to `~/backups`, with one
directory per set. Everything is written `umask 077`, files are forced to `600`
and directories to `700` on every run - the Postgres dump is `pg_dumpall`, so it
contains Keycloak's user table and therefore the password hashes for every
account on the box. That was being written world-readable until it was noticed,
and the Grafana copies were group-readable until 2026-09 (`docker cp` kept the
file's own mode).

The run ends with a size report:

```
[backup]   postgres          14 kept    964K   newest     72K  pg-20260919-000655.sql.gz
[backup]   victoriametrics    1 kept    408M   newest    408M  vm-20260919-000655.tar
...
[backup]   total                    495M   (872G free on that disk)
```

## How each one is taken, and why that way

**Grafana, without stopping it.** Until 2026-09 this was `docker cp` of the live
`grafana.db` - a byte copy of an SQLite file that Grafana writes on every alert
evaluation, so a copy could be torn. The Grafana image has no `sqlite3` and
Grafana has no backup API, so a borrowed `python:3.13-alpine` container mounts
the volume read-only and uses SQLite's online-backup API. That takes the same
file locks Grafana's own SQLite takes, so it copies one consistent state; the copy
is then checked with `PRAGMA integrity_check` and discarded if it fails.

**VictoriaMetrics, without stopping it.** Its snapshot API hard-links the current
data parts into `snapshots/<name>` instantly while it keeps scraping. The
snapshot is a set of relative symlinks, so it is tarred with `-h` - the archive
holds `data/` and `metadata/` exactly as `-storageDataPath` lays them out. The
snapshot is deleted afterwards whatever happened; one left behind pins its parts
and grows the volume. The credentials come from the same `prom-*.txt` files the
container enforces and never appear in a command line.
*vmbackup* - the official tool - was evaluated and not used: what it adds is
incremental uploads to object storage, and a local target keeping three full
copies is what a tar already is, without a second image and `vmrestore`. Revisit
it if backups ever leave the box. The tar is not gzipped (VM data is already
compressed).

**Loki, stopped for a few seconds.** Loki has no snapshot API, and a tar of its
directory while it runs is not a point-in-time copy: the WAL, the active TSDB
index (shipped into the store every few minutes) and the chunks change
independently, so the index could name chunks the tar never got. The Loki docs
offer `POST /flush` and nothing stronger for filesystem storage. So the backup
flushes, **stops Loki**, tars `/loki`, and starts it again - measured at 1-2
seconds stopped, then ~15 s until `/ready` (Loki's own ring delay). Nothing is
lost across the gap: Alloy retries a refused batch, and nothing alerts on Loki.
If the script dies half-way it still starts Loki again on the way out.

**Short-lived helper containers.** Grafana, Loki and Alloy are read by
`docker run --rm python:3.13-alpine ...` containers. Alloy discovers every
container, so each nightly run leaves a few harmless `could not inspect container
info` lines in Alloy's log for helpers that were already gone.

## Restoring

Every restore recipe:

- **needs an explicit file** - there is no "latest" default; a restore is the one
  command where guessing wrong destroys the thing you still had;
- **shows what it will overwrite** - what is live now and what the file holds -
  and asks you to type `yes`, unless you pass `--yes` (with no terminal and no
  `--yes` it refuses);
- **stops only the service it replaces**, starts it again even on failure, and
- **verifies** on the data, not on a status code, exiting non-zero if that fails.

```sh
just restore-postgres        ~/backups/postgres/pg-<ts>.sql.gz
just restore-grafana         ~/backups/grafana/grafana-<ts>.db
just restore-env             ~/backups/env/env-<ts>
just restore-victoriametrics ~/backups/victoriametrics/vm-<ts>.tar     # or an unpacked snapshot dir
just restore-loki            ~/backups/loki/loki-<ts>.tar.gz
```

What each one does:

| Recipe | Stops | Replaces | Verifies |
|---|---|---|---|
| `restore-postgres` | `keycloak` (it caches realm data) | every database **in the dump**: `DROP DATABASE ... WITH (FORCE)`, then replays it. Databases not in the dump are left alone. | every database is back with as many tables as the dump creates; keycloak healthy again |
| `restore-grafana` | `grafana` | `grafana.db` (and removes any stale `-journal`/`-wal`/`-shm`) | the file passes `integrity_check` first; afterwards `/api/health` says `"database": "ok"`, and users and UI-made dashboards match the backup |
| `restore-env` | nothing | `.env` - the current one is saved first as `env-<ts>-pre-restore` | byte-identical to the backup, mode 600. Prints key **names** that differ, never values. Takes effect at the next `just up`. |
| `restore-victoriametrics` | `victoriametrics` | **all** of its volume | `/health`, then `/api/v1/series/count` > 0 |
| `restore-loki` | `loki` | **all** of its volume | `/ready`, then label names over the last 7 days are non-empty |

Two notes on what "verified" can and cannot mean:

- **Grafana's file-provisioned dashboards** (every dashboard in
  `monitoring/dashboards/`) are reconciled with those files when Grafana starts -
  re-added if the file exists, removed if it does not. Their count after a restore
  says more about `monitoring/dashboards/` than about the backup, so it is
  reported, not compared.
- **Data older than retention** comes back and is then deleted again by
  VictoriaMetrics (15 d) and Loki's compactor (168 h). Restoring a three-day-old
  Loki backup gives you the four days before it.

### The sets without a recipe

These are plain archives; putting them back is one command, and none of them
has a running service to stop.

```sh
# audit logs and trash - members are relative, apps/... and bothy/...
tar -xzf ~/backups/state/state-<ts>.tar.gz -C ~/stacks apps/
tar -xzf ~/backups/state/state-<ts>.tar.gz -C ~/.local/state bothy/

# notes: a full clone from the bundle, then any uncommitted files on top
git clone ~/backups/notes/notes-<ts>.bundle ~/claude-notes
tar -xzf ~/backups/notes/notes-<ts>-worktree.tar.gz -C ~/claude-notes   # only if it exists

# Alloy positions - OPTIONAL, and only together with a Loki restore of the
# same night. Without it Alloy re-reads what json-file still holds and Loki
# drops the duplicates, which is harmless.
docker compose -f monitoring/compose.yml stop alloy
docker run --rm --volumes-from alloy -v ~/backups/alloy/alloy-<ts>.tar.gz:/a.tgz:ro \
  python:3.13-alpine sh -c 'rm -rf /var/lib/alloy/data/* && tar -xzf /a.tgz -C /var/lib/alloy/data'
docker compose -f monitoring/compose.yml start alloy
```

### The generated secrets are re-issued, not restored

`apps/bothy-ops/secrets`, `apps/headlamp/secrets`,
`apps/bothy-collector/secrets` and `monitoring/kube-auth` are
deliberately **not** backed up. Four of the five are ServiceAccount tokens bound
to one minikube cluster - after a rebuild, a saved copy is a credential for
something that no longer exists - and `monitoring/kube-auth/token` is owned by uid
65534 mode 600, so the backup (running as you) could not read it anyway. Every one
is re-issued by a recipe:

| File | Re-issue with |
|---|---|
| `monitoring/kube-auth/token` | `just k8s-monitoring` (or `just kube-prom-token`) |
| `apps/bothy-ops/secrets/{token,ca.crt}` | `just kube-token` |
| `apps/bothy-ops/secrets/keycloak-admin-client-secret` | `just admin-client --rotate` (the client itself lives in Keycloak, i.e. in the Postgres dump) |
| `apps/headlamp/secrets/kubeconfig` | `just headlamp-token` |
| `apps/bothy-collector/secrets/kubeconfig` | `just collector-token` - and until it has run, the portal's collector reads the cluster with the ambient kubeconfig (the minikube **admin** certificate) and says so on stderr |

Then `just up-apps` / `just up-headlamp` to pick them up.

## Why it is `pg_dumpall` and must stay that way

Keycloak's data lives in its own `keycloak` database inside the same Postgres
server, created against the running instance. A named-database list would never
have grown a `keycloak` entry on its own, and the identity provider for the
whole box would have been silently un-backed-up.

**Do not narrow this to a list of databases.** `pg_dumpall` picks up any new
database with no edit to the script.

## The script is deliberately not `set -e`

One failed step must not skip the others. It used to abort on the first
failure, which is how a single bad Postgres dump left everything else
un-backed-up for six days without anything looking wrong.

Three other pieces of scar tissue, all in the same script:

- **It waits for Postgres to accept connections** before dumping. The timer is
  `Persistent=true`, so a schedule missed while the box was off fires at the
  next boot - which is exactly when Postgres is still initialising.
- **It verifies every artifact is non-empty** (and the Grafana copy is
  integrity-checked, the VictoriaMetrics tar is listed) before keeping it. An
  empty artifact is worse than none: rotation counts it, and it would eventually
  evict a good backup with a worthless one.
- **It exits non-zero if any step failed**, so the timer's own success signal
  means something.

The reason all three exist together: for six days it produced 20-byte empty
dumps while reporting success. A failed `pg_dumpall` still leaves behind a
perfectly valid gzip of nothing.

## `just doctor` checks age and size, not existence

Directly because of the above. A file named like a backup is not a backup, and
existence is the one property a broken backup still has. `doctor` checks every
set - the newest file of each must be under 48 h old and above a minimum size -
plus the Postgres dump's database coverage, and prints how much `~/backups` uses.
It also knows how long the box has been up, which is what separates *the timer is
broken* from *the timer has not come round yet*.

## Tested

- CI (`.github/workflows/upgrade.yml`, nightly) backs up a freshly upgraded box,
  **damages it** - drops a table, deletes `grafana.db`, wipes VictoriaMetrics'
  and Loki's volumes - restores each with its recipe, and asserts the row, a
  dashboard made through the API, the metrics and the log lines are back.
- Every recipe was also run against throwaway containers restored from this
  box's own backups (2026-09-19): Keycloak's 100 tables and its users, Grafana's
  users, 23,769 VictoriaMetrics series and 7 days of Loki streams came back.

## What is not covered, and is not pretended to be

- **Backups sit on the same disk they protect.** Copying them off the box is not
  solved. If the disk dies, so do the backups - this is a real limitation, not
  an oversight waiting to be found.
- **`monitoring_prometheus_data`** (the retired Prometheus, kept only for the
  rollback) and minikube are not backed up.
- **The repository is not backed up**, because it is in git. What is *not* in
  git - `.env`, and anything you edited and did not commit - is the gap, and
  only the first of those is covered here.

## Before an upgrade

An upgrade preserves volumes and that claim is tested in CI ([Upgrading](upgrading.md)
explains how). Take a backup anyway before one you are unsure about: it costs
one command, and the failure mode it protects against is the one nobody plans
for.

## Related

- [Upgrading](upgrading.md) - what an upgrade does and does not touch
- [Troubleshooting](troubleshooting.md) - `just doctor`, and reading its backup section
- [`README.md`](../../README.md) - the shorter version, beside the rest of the repository map
