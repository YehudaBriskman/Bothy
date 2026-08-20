# Backups

Three things are backed up nightly, and they were each chosen because losing
them is unrecoverable rather than inconvenient.

| Artifact | What it carries |
|---|---|
| the Postgres dump | Keycloak's realm, users, clients and roles, **and** the dev database |
| the Grafana database | dashboards, users, settings |
| `.env` | every credential on the box - gitignored, and existing in exactly one place on earth |

That third one is the one people forget. `.env` is not in git by design, so if
the disk goes, the file goes with it and every generated secret goes with that.

## When it runs, and where it lands

`stacks-backup.timer` runs `scripts/backup.sh` at **03:00 daily**, keeping the
newest **14** of each. On demand:

```sh
just backup            # or: bothy backup
```

The destination is `$BACKUP_ROOT`, which defaults to `~/backups`, with one
directory per artifact. Everything is written `umask 077` and the directories
are `chmod 700` on every run - the Postgres dump is `pg_dumpall`, so it contains
Keycloak's user table and therefore the password hashes for every account on the
box. That was being written world-readable until it was noticed.

## Why it is `pg_dumpall` and must stay that way

Keycloak's data lives in its own `keycloak` database inside the same Postgres
server, created against the running instance. A named-database list would never
have grown a `keycloak` entry on its own, and the identity provider for the
whole box would have been silently un-backed-up.

**Do not narrow this to a list of databases.** `pg_dumpall` picks up any new
database with no edit to the script.

## The script is deliberately not `set -e`

One failed service must not skip the others. It used to abort on the first
failure, which is how a single bad Postgres dump left everything else
un-backed-up for six days without anything looking wrong.

Three other pieces of scar tissue, all in the same script:

- **It waits for Postgres to accept connections** before dumping. The timer is
  `Persistent=true`, so a schedule missed while the box was off fires at the
  next boot - which is exactly when Postgres is still initialising.
- **It verifies every artifact is non-empty** before keeping it. An empty
  artifact is worse than none: rotation counts it, and it would eventually evict
  a good backup with a worthless one.
- **It exits non-zero if any step failed**, so the timer's own success signal
  means something.

The reason all three exist together: for six days it produced 20-byte empty
dumps while reporting success. A failed `pg_dumpall` still leaves behind a
perfectly valid gzip of nothing.

## `just doctor` checks age and size, not existence

Directly because of the above. A file named like a backup is not a backup, and
existence is the one property a broken backup still has. `doctor` also knows how
long the box has been up, which is what separates *the timer is broken* from
*the timer has not come round yet*.

## Restoring

Postgres, from a dump:

```sh
gunzip -c ~/backups/postgres/pg-<timestamp>.sql.gz \
  | docker exec -i postgres psql -U "$POSTGRES_USER"
```

`pg_dumpall` output includes the `CREATE DATABASE` statements, so this restores
Keycloak's database as well as the dev one. Expect Keycloak to need a restart
afterwards.

Grafana is a file copy while the container is **stopped**:

```sh
docker compose -f monitoring/compose.yml stop grafana
docker cp ~/backups/grafana/grafana-<timestamp>.db grafana:/var/lib/grafana/grafana.db
docker compose -f monitoring/compose.yml start grafana
```

`.env` is a copy back into the repository root, followed by bringing the stack
up again - nothing in it is live until then:

```sh
cp ~/backups/env/env-<timestamp> ~/stacks/.env
just up
```

## What is not covered, and is not pretended to be

- **Backups sit on the same disk they protect.** Copying them off the box is not
  solved. If the disk dies, so do the backups - this is a real limitation, not
  an oversight waiting to be found.
- **Docker volumes other than those three are not backed up.** Prometheus and
  Loki data are deliberately excluded: they are large, they are observations
  rather than state, and a box that loses them has lost history rather than
  configuration.
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
