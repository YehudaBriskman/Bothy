# Data and state: what Bothy holds, how it is versioned, backed up and kept safe

_Written 2026-11-17. Status: **proposal for the owner's decision** (design only; nothing in
this document is built by it). Part of the thin-Bothy plan set ([README.md](README.md)); it
reconciles [updates-and-rollback.md](updates-and-rollback.md),
[bothy-install.md](bothy-install.md), [distribution-and-packaging.md](distribution-and-packaging.md)
s8 (D29 to D39), [cli-and-control-plane.md](cli-and-control-plane.md) (D40 to D43) and the
settings decision record [../settings-store.md](../settings-store.md) (D11, option A)._

**The owner's brief:** a stable environment; make decisions, back them up, keep future change
small. This document is therefore mostly decisions (section 3), each with the reason, and a
build order (section 9) whose first slice is deliberately tiny.

**Claim discipline.** Every claim is tagged.

| Tag | Meaning |
|---|---|
| **[V]** | verified in this repo's code or scripts in this worktree (file cited), or on the live box by a read-only look |
| **[P]** | stated by an accepted plan or decision record but not built (source cited) |
| **[A]** | assumed or estimated; settled by the test named next to it |

Facts about the live box come from `scripts/backup.sh`, `scripts/restore.sh`,
`docs/guide/backups.md`, `~/claude-notes/stack/overview.md` and read-only `ls`/`du`/`df` of
`~/backups` and `~/.local/state/bothy`. No docker command was run and nothing under `~/stacks`
was touched.

## 1. Inventory: every piece of state

Two install kinds exist ([update-paths.md](update-paths.md)): the **checkout box** (this box:
a git checkout at `~/stacks`, `just`, compose, the web updater, `.env`) and the **installed
box** (`bothy install`: a static `bothy` binary, a receipt, a generated stack under
`$XDG_DATA_HOME/bothy`, secrets under `$XDG_CONFIG_HOME/bothy`; today only the `mini` mode
exists, `cli/internal/install/stack/mini` [V]). "Mode" matters only for which rows exist: mini
(Bivvy) has rows 1 to 9 and 13; Bothy and Basecamp add the Docker modules (rows 10 to 12);
custom is any subset. Recoverable means "can be rebuilt without the user's help from the repo,
the release or the other state".

Columns are many, so the table is split in two halves over the same row numbers.

### 1a. What, who, where, what shape

| # | State | Owner (sole writer) | Location, checkout box | Location, installed box | Format |
|---|---|---|---|---|---|
| 1 | **Settings store** (plain settings, encrypted secrets, audit chain) | `bothy-settings` library; no service yet **[V]** (`apps/bothy-settings/README.md`: "There is no service, image, compose file or wiring yet"; the API answers 503 "the settings store is not connected to this service", `apps/bothy-ops/v1api.py:253`) | would be `$STATE_ROOT/bothy/settings/settings.db` **[P]** (`settings-store.md` s4); **does not exist on this box** **[V]** (no `/etc/bothy`, no `~/.config/bothy`, no `settings` dir under `~/.local/state/bothy`) | `$DATA/settings/settings.db` **[P]**; not created by `bothy install` today **[V]** (`install.go` creates only dirs, key, files, receipt) | SQLite, WAL, `synchronous=FULL`, STRICT, `PRAGMA user_version` = schema **[V]** (`schema.py`, `store.py`) |
| 2 | **Master key (KEK)** | `bothy install` writes it; `bothy-settings.bootstrap` also can | `$BOTHY_MASTER_KEY_FILE`, default `/etc/bothy/master.key` or `$XDG_CONFIG_HOME/bothy/master.key` **[P]** (`settings-store.md` s6.1) | `$CONF/secrets/master.key` **[V]** (`install.go:355`) | **two incompatible formats today, see risk R2**: installer writes 64 hex chars + newline **[V]**; the library reads `bothy-master-key v1` + `key_id base64` lines **[V]** (`keyfile.py`) |
| 3 | **Generated `.env` secrets** (Postgres, dev login, oauth2 cookie, Keycloak DB and client) | `scripts/bootstrap.sh` / the operator | `~/stacks/.env`, git-ignored, "exactly one place on earth" **[V]** (`docs/guide/backups.md`) | not used: installed mode has no `.env`; secrets move to row 1 later **[P]** | dotenv |
| 4 | **Bearer tokens** (digests, scopes, expiry, revocation) | host `bothy token` verbs (Go) and `bothy-ops` (reader, updates `last_used`); one format, two writers **[V]** (`tokens/types.go`, `tokenstore.py`) | `$STATE_ROOT/bothy/tokens/tokens.json` + `tokens.lock` + `audit.log`; **the directory does not exist on this box** (no token was ever minted) **[V]** | the same path via `BOTHY_TOKEN_STATE`; default `~/.local/state/bothy/tokens` **[V]** (`token_cmd.go:52`) | JSON `{"version":1,"tokens":[...]}` **[V]** |
| 5 | **Install receipt** | `bothy install` / `update` / `uninstall` | none (no receipt on a checkout box; the pin file in git plays the role) | `$DATA/receipt.json` **[V]** (`install.go:98`) | JSON with `schema: 1`, `status`, `previous` **[V]** |
| 6 | **Previous-generation files** (the rollback point) | `bothy update` | not applicable; the updater keeps `~/backups/pre-update` (1.7 GB now) and git pins **[V]** | `$DATA/previous/` = generated files + a receipt copy; old images kept by digest **[V]** (`update.go:131,228`) | files + JSON |
| 7 | **Generated stack files** (compose, edge routes, policy) | `bothy install`/`update` from the embedded release | the repo itself (tracked) | `$DATA/stack/` **[V]** | YAML/TOML, regenerated |
| 8 | **Bothy Files user notes** (the thing a user actually writes) | the Files editor (`bothy-files`) | `$NOTES_ROOT` (`~/claude-notes`), a git repo; edits arrive from the editor as uncommitted files **[V]** (`backup.sh` notes step) | `$DATA/stack/bothy-files/notes` mounted **read-only** in the container **[V]** (`compose.yml.tmpl:49`): so mini today can show notes but not edit them **[V]** | markdown in a git repo (checkout) or plain files (installed) |
| 9 | **Undo snapshots** (file trash, config trash) | `bothy-files` | `$STATE_ROOT/bothy/trash`, `.../config-trash` **[V]** | not present in mini (notes are read-only) **[V]** | files |
| 10 | **Audit logs** (who changed what via the console and Files) | `bothy-ops`, `bothy-files` | `apps/bothy-ops/audit`, `apps/bothy-files/audit` in the checkout **[V]** | n/a in mini; `$STATE/tokens/audit.log` for tokens **[V]** | JSON lines |
| 11 | **SSO / identity** (Keycloak realm, users, password hashes, clients) | Keycloak, in a `keycloak` database inside the shared Postgres | Postgres volume **[V]** (`backup.sh` pg comment) | **not in mini** (D5: outside mini and standard) **[V]** (README D5); a later module **[P]** | PostgreSQL |
| 12 | **Shared Postgres** (the projects' dev database + Keycloak's DB) | Postgres; projects | Docker named volume | module, not in mini **[P]** | PostgreSQL; major upgrade = new volume (`pgmajor.py`) **[V]** per `updates-and-rollback.md` s7 |
| 13 | **Metrics, logs, dashboards, alert state** (VictoriaMetrics 15 d, Loki 7 d, Grafana `grafana.db`, Alloy positions) | their containers | Docker volumes | modules (Grafana full only, D5) **[P]** | TSDB parts; SQLite (Grafana); positions file |
| 14 | **Logs** (host-process logs, container logs) | the processes; Alloy ships to Loki | `$STATE_ROOT/bothy/*` and Loki | docker's json logs; `$STATE/tokens/audit.log` | text |
| 15 | **Other generated secrets** (`apps/bothy-ops/secrets`, `headlamp/secrets`, `bothy-collector/secrets`, `monitoring/kube-auth`) | `gen-*.sh` scripts | in the checkout, git-ignored **[V]** | n/a | tokens bound to one cluster |

### 1b. Who may touch it, how big, how bad to lose, how well covered

"Backup today" is what `scripts/backup.sh` and the installed `bothy` actually do, read from the
code; the nightly set is `postgres grafana env victoriametrics loki alloy state notes` **[V]**
(`backup.sh` `KINDS`). The restore column names the recipe that exists.

| # | Read / write | Size class | Secret? | Loss is recoverable? | Backup today | Restore story today |
|---|---|---|---|---|---|---|
| 1 | owner uid, mode 0600 in 0700 dir; secrets write-only at every public surface **[V]** (`fscheck`, `keyfile`) | tiny (< 1 MiB, **[A]** estimate in the record) | **yes** (ciphertext + wrapped DEKs; settings plain) | **no**, unless the export or a DB backup **and** the key survive | none: nothing writes it yet. Library can `backup()` (online API, hashed, verified) **[V]** but no recipe calls it | library `restore()` with dry-decrypt and a `restore` audit row **[V]**, no CLI verb **[V]** (no `backup`/`restore` verb in `cli.go`) |
| 2 | 0600, our uid, 0700 dir, one hard link, never a symlink, refused (not chmod-ed) otherwise **[V]** (`keyfile.py`); the installer's write is just `O_EXCL` 0600 **[V]** | 32 bytes | **yes, the most secret thing on the box** | **no**: without it every secret in row 1 is permanently unreadable, by design | **none by design** (`settings-store.md` s10 says "not in the backup set; off-box copy required"); nothing in install prompts or verifies the off-box copy **[V]** (not in `install.go`) | none. A restored DB with the wrong or missing key is refused by name (`RestoreKeyMissing`, lists missing `key_id`s) **[V]** |
| 3 | user, 0600 | 4 KB | **yes** | partly: the repo rebuilds the file but **not the values**; Keycloak and Postgres bake passwords into their volumes at first start **[V]** (`settings-store.md` s3), so re-generating them breaks existing volumes | **yes**, `env/` copy, keep 14, 0600, **plain text, same disk** **[V]** | `just restore-env <file>` (saves current as `-pre-restore`, byte-identical check) **[V]** |
| 4 | `tokens.json` 0600 in a 0700 dir owned by the caller, never a symlink; flock; both languages checked by a golden fixture **[V]** | tiny (cap 2000 records, 1 MiB) **[V]** | digests only (the secret is shown once) **[V]**, still a credential list | yes, by re-minting (tokens expire in 30 d by default anyway) **[V]**; the cost is every client's config | **no**: the `state` set tars only the two audit dirs and the two trash dirs **[V]** (`backup.sh` state step). Tokens are not in it | none, and re-mint is the plan |
| 5 | 0600; read by install/update/uninstall; **no lock** **[V]** (no flock in `cli/internal/install`) | KB | no | yes in principle (can be re-derived by `bothy install`), but a lost or unreadable receipt blocks update and uninstall: the error is "move it aside to start over" **[V]** (`readReceipt`) | none | none: re-run `bothy install` |
| 6 | 0600 in 0700 **[V]** | MB (files only; images are in Docker) | no | yes: regenerated by the next install; its value is only during an update | none (it *is* the rollback point) | `rollback()` in `update.go:257` **[V]** |
| 7 | 0644 | KB | no | **yes**, fully | none needed | `bothy install` re-applies **[V]** |
| 8 | the Files editor (checkout); read-only in mini **[V]** | KB to MB | **no, but irreplaceable** | **no**: the user's own writing | **yes** on the checkout box: git bundle `--all` verified, plus a tar of uncommitted files, keep 14 **[V]**. **Installed box: none** | `git clone` the bundle (documented), no recipe **[V]** (`restore.sh` has no `notes` kind, only `postgres grafana env victoriametrics loki`) |
| 9 | user | KB | may contain config | no (it is the undo) | yes (`state` set, keep 14) **[V]** | tar by hand; no recipe |
| 10 | user, append | KB | no | **no** (the only record of who changed what) | yes (`state`) **[V]**; the token audit log: no | tar by hand |
| 11 | Postgres roles; Keycloak admin | KB to MB | **yes** (password hashes of every account) **[V]** (`backup.sh` umask note) | **no** | yes, inside `pg_dumpall`, gzipped, 0600, **unencrypted, same disk**, keep 14 **[V]** | `just restore-postgres` (stops keycloak, drops and replays, verifies table counts, keycloak healthy) **[V]** |
| 12 | Postgres | 1 MB now, unbounded in principle | **yes** (project data) | no | yes, as row 11 (72 KB per dump **[V]** `docs/guide/backups.md`) | as row 11 |
| 13 | containers | VM 400 MB, Loki 60 MB, Grafana 3.5 MB per copy **[V]** (`du ~/backups`) | Grafana db: yes (users) | metrics and logs: **no, by decision** (history is a deliberate non-migration, `migration.md` s4); Grafana UI-made dashboards: no | yes: VM snapshot API tar, Loki flush+stop+tar, Grafana SQLite online backup with integrity check; keep 3 for VM and Loki, 14 for the rest **[V]** | `just restore-victoriametrics|loki|grafana`, each verified on data **[V]** |
| 14 | root/user | MB to GB | may contain secrets by accident (`scripts/redact-logs.py` exists **[V]**) | yes (loss tolerated) | Loki holds logs; no host-log backup | n/a |
| 15 | uid 65534 for one of them | KB | yes | yes: "re-issued by a recipe"; **deliberately not backed up** **[V]** (`backup.sh` comment) | none, by decision | re-run the `gen-*` recipe |

Two facts that colour everything below:

- **The backups share the disk with the data.** `~/backups` and `~/stacks` are both on
  `/dev/sdd` (the 1 TB WSL virtual disk) **[V]** (`df`). The nightly set protects against a
  bad update, a deleted file, a corrupt database; it does not protect against the loss of that
  one virtual disk, the Windows host, or a fire. No off-device copy is configured in the
  scripts **[V]** (`backup.sh` writes only to `$BK`; `docs/guide/backups.md` says "Revisit
  [vmbackup] if backups ever leave the box").
- **A byte-for-byte good backup has never been proven to restore the *whole box*.** Each
  recipe's restore has been run individually and verifies on data **[V]**
  (`docs/guide/backups.md`), but there is no end-to-end "empty machine, restore only from
  backups" rehearsal in the repo **[V]** (no such script or check; `modes-and-modules.md` s157
  and `migration.md` row 4 plan a scratch-VM restore test, **[P]**).

## 2. What is already true in code, in one place

| Capability | Where | State |
|---|---|---|
| SQLite store: WAL, `synchronous=FULL`, `secure_delete`, STRICT, state-dir flock, `integrity_check` on open, refuses empty/truncated/foreign file *without recreating it*, refuses a newer schema (`DowngradeError`) before touching it, refuses network/Windows-drive mounts, refuses SQLite < 3.37 | `apps/bothy-settings/bothy_settings/store.py`, `fscheck.py`, `schema.py` | **[V]** library, no consumer |
| Forward-only migrations, one transaction per step, the `migrate` audit row inside the last step, and a `before(from, to)` hook that runs once before any step | `store.py:_apply_migrations` | **[V]**; whether the hook is *wired* to take a snapshot is not shown by the library alone **[A]** (settled by test T1 in section 8) |
| Online-backup-API copy, new 0600 file, verified (`integrity_check`), hashed, never overwrites | `store.py:_backup_to`, `Store.backup` | **[V]** |
| Restore: hash + integrity, newer schema refused, dry-decrypt names every missing `key_id`, audit chain and head verified, current DB kept aside, `restore` audit row, lists secrets that differ | `store.py:restore`, `_verify_backup_file` | **[V]** |
| KEK file: O_EXCL via `link(2)` of a fully written temp (no torn key), never overwritten, mode/owner/dir/hard-link/symlink checks, `key_id` verified on load, rotation with several keys | `keyfile.py` | **[V]** |
| Age export, encrypt half, through an external `age`; decrypt half, `--with-audit`, pinned `age` install deferred | `export.py` | **[V]** partial |
| Token file: flock, `O_EXCL` temp, fsync, rename, directory fsync, 0600/0700 owner check on the open fd, Go and Python writers held to one golden fixture | `tokens/store_unix.go`, `apps/bothy-ops/tokenstore.py` | **[V]** |
| Receipt: JSON with `schema: 1`; temp-file + rename but **no fsync, a fixed `.tmp` name, no lock, and a `schema` value that is written but never checked on read** | `install.go:readReceipt/writeReceipt/atomicWrite` | **[V]** the gaps |
| Install key write: `O_EXCL`, 0600, **no fsync, not atomic** (a crash after create and before the write completes leaves a short file, and the next run sees it exist and treats the step as done: `Done` is `os.Stat == nil`) | `install.go:355` | **[V]** gap |
| Uninstall: keeps secrets and data unless `--purge` **and** the typed phrase `delete bothy data`; directories removed only if empty (`os.Remove`, never recursive); `guardedRemoveAll`; install roots must be named `bothy` | `uninstall.go:13,86,128`, `install_cmd.go:195` | **[V]** |
| Update: `saveRollbackPoint` (receipt + generated files) before any change, rollback on failure to the recorded digests, old images kept until the next update; **never touches user data** (and so never migrates any) | `update.go:131,228,257` | **[V]**; it has no data step at all, which is the gap section 3.2 fills |
| Host nightly backup of the Docker data and the checkout's state, 0600/0700, never keeps an empty artifact, stops Loki and restarts it on any exit, non-fatal per step so one failure does not skip the rest, exit 1 on any failure; restore recipes need an explicit file, show what they overwrite, confirm, verify on data | `scripts/backup.sh`, `restore.sh`, `lib/backup-lib.sh` | **[V]** |
| The 03:30 updater window only runs after that night's backup succeeded | `~/claude-notes/stack/overview.md` | **[V]** (notes) |
| The pre-update snapshot of VictoriaMetrics and Loki | `snapshot.sh`, `backup-lib.sh` | **[V]** |

Not true yet, and the rest of this document is about them: any `bothy backup` or `bothy
restore` verb; any backup of tokens, the receipt, installed notes or the settings DB; any
off-device copy; a shared format-version rule; a data step inside `bothy update`; a lock on
install/update; any restore rehearsal.

## 3. Decisions

Ten decisions, each with the rule, the reason, and the cost. Numbered **DS1 to DS10** so they
do not collide with D1 to D43 in the README.

### DS1. One format rule for every on-disk format (answers question 1)

**Decision.** Every persistent format carries one integer, `schema`, in-band, and every reader
applies the same three-way test against a compiled-in range `[MIN, MAX]`:

| File says | Verdict | Reader does |
|---|---|---|
| `schema` missing, not an integer, or the file does not parse | **corrupt** | refuse; never treat as "version 0" or "empty"; never recreate or overwrite; say which file, and the recovery (restore the last verified backup) |
| `schema > MAX` | **too new** | refuse **before any write and before any migration**, name both numbers, say "run the newer release or restore the pre-migration copy" |
| `schema < MIN` | **too old** | refuse and name the release that can migrate it (a migration is dropped only after a stated number of releases) |
| `MIN <= schema <= MAX` | **ok / migratable** | migrate forward under DS2, never backward |

The in-band locations are fixed so that a tool can read the number without understanding the
file: SQLite `PRAGMA user_version` (already so **[V]**), JSON a top-level `schema` integer, a key
file its first line (`bothy-master-key v1` already so **[V]**), an archive its `manifest.json`
(DS3). The token file calls it `version` today and the receipt `schema` **[V]**; the rule
accepts the existing names and the table in section 3.1 pins which key each uses, so no
existing file changes shape. A new format must pick `schema`.

Exit codes (existing table: 64 usage, 66 not found, 69 data source unavailable, 77 not allowed,
78 version mismatch **[V]** `cli.go:269`): **too new and too old are 78**; **corrupt is a new
74** (EX_IOERR). One code per verdict means a script and the web updater can branch without
parsing prose.

**Why one rule, not N.** The libraries already implement the *behaviour* three ways: settings
refuses a newer SQLite **[V]**; the token reader accepts only `version == 1` and reports any
other value as "damaged" (so a future v2 reads as corruption, not as too-new) **[V]**
(`tokenstore.py:152`, `store_unix.go:85`); the receipt writes `schema` and never reads it
**[V]**. A binary that cannot tell "newer than me" from "broken" will, sooner or later, be
told to "repair" a newer file. The one rule removes that.

**Cost.** Three small changes (receipt reads `schema`; token readers distinguish too-new from
damaged; the settings error maps to exit 78), plus the registry check in 3.1.

#### 3.1 The registry, so it cannot drift

One table, in this document, mirrored by a check (`checks/formats`, section 9 slice 1), that
fails CI if a persisted format is added without a row:

| Format | Key | Now | Writers | Readers | Golden fixture |
|---|---|---|---|---|---|
| settings DB | `PRAGMA user_version` | 1 | `bothy-settings` | same | partly **[V]** (`test_store`/`test_hardening` plant `user_version = 99`) |
| token file | `version` | 1 | Go CLI, Python `bothy-ops` | same two | **[V]** `testdata/gotokens.golden.json` |
| receipt | `schema` | 1 | Go CLI | Go CLI | none **[V]** |
| release manifest | `schema` | 1 | CI | Go CLI (refuses other than 1 **[V]** `manifest.go:68`) | **[V]** |
| master key file | line 1 `bothy-master-key v1` | v1 | installer, library | library | none (and see R2) |
| backup archive manifest (new) | `schema` | 1 | `bothy backup` | `bothy restore` | to add |
| age export bundle | `format: "bothy-config-export/1"` | 1 | library | **[P]** | none |

Each row needs two fixtures: "the current format is read" and "the same file with `schema`
raised by one is refused with exit 78 and the file is byte-identical afterwards".

### DS2. Migration policy: forward-only, snapshot first, and rollback is explicit (answers question 2)

**Decision.**

1. **Forward-only, always.** No down-migrations are written. A downgrade of data is a
   *restore*, not a transform (down-migrations are code that is never run until the worst day).
2. **The migrator, not the caller, takes the snapshot.** The library already has the hook:
   `_apply_migrations(..., before)` runs once before any step **[V]**. The rule: no migration
   runs unless `before` has produced a **verified** copy (online backup API, `integrity_check`,
   hash) at `<state>/pre-migrate/<format>-v<from>-<UTC timestamp>`, mode 0600, never
   overwritten, and the migration refuses to start if the copy fails or there is not room for
   it (`statvfs` free >= 2x the file). The `migrate` audit row records the copy's hash.
   For the JSON files (tokens, receipt) the same rule with a plain copy, which is safe because
   they are written atomically under one lock.
3. **Migrations run when `bothy update` / the web updater applies a release, not at an
   arbitrary service start**, so a migration always happens inside a plan with a backup and a
   verify step (principle 3 of `updates-and-rollback.md` s1: plan, backup, act, verify,
   rollback). The service *also* migrates on its own start as the safety net (a store opened by
   a newer binary after a manual image bump must still be consistent), but then it is the same
   code path, with the same snapshot.
4. **Expand, then contract.** A migration in release N may only *add* (tables, nullable
   columns, new keys) unless the release is flagged `breaking: data` in the manifest. Anything
   destructive (drop, rename, re-encode) ships in release N+1 or later, after N has been the
   running release for one full update cycle. This is the standard rule for making a rollback
   to N-1 safe, applied to a single-node store.
5. **A `breaking: data` release is a different kind of update**: the plan shows it, the
   snapshot is mandatory and verified *before* the confirm prompt appears, and the confirm is
   typed (`update --to vX` plus the phrase), as for the Postgres major (`updates-and-rollback.md`
   s7).

#### 3.2 Rollback of a migrated store: the dangerous case, spelled out

The sequence that destroys data if nobody designed it:

1. Release N-1 is running; the settings DB is schema 1.
2. `bothy update` installs N. N migrates the DB to schema 2. Verify passes. The user changes
   three settings and rotates a secret on N (all written at schema 2).
3. Something is wrong with N unrelated to data (a UI bug). The user runs `bothy rollback`
   (D-numbers in `cli-and-control-plane.md`) or the updater rolls back.
4. The release files and images go back to N-1 (this works today **[V]**, `update.go:257`).
   N-1 opens the DB: schema 2 > its MAX 1, so **it refuses, by design** **[V]**
   (`DowngradeError`, "Not touched"). Result: the box is back on the old images **and has no
   settings, no secrets, no way to log in**, with a healthy-looking `docker ps`.

The two bad "fixes" are a down-migration run by an old binary (it cannot know what the new
schema means) and an old binary that opens a newer file "read-only and hopes" (silent data
loss on the first write).

**The rule.** Rollback and data are decided **together, in the plan, before anything moves**:

| Situation at rollback time | What the rollback does | What the user is told |
|---|---|---|
| No format changed between N-1 and N (the common case) | files and images only, as today | nothing about data |
| A format changed **and nothing has been written since the update** (verify only, the first minutes) | restore the pre-migration snapshot over the migrated file (library `restore()` **[V]**), then files and images | "settings returned to the state before the update; no changes were lost" |
| A format changed **and the user has written since** | **refuse by default**: the plan prints the count of changes made since the update (`updated_at` newer than the snapshot; `restore()` already computes the list of secrets that differ **[V]**) and offers exactly two ways: (a) `--restore-data`: restore the snapshot, **losing** those changes, after a typed confirmation, with a fresh export of the current store written first so nothing is unrecoverable; (b) stay on N and roll *forward* with a fix | the exact count and names of what would be lost |
| The migration was additive (rule 4) and N-1 declares it can read schema 2 | a future refinement: N-1's `MAX` is raised to 2 *in a point release of N-1 that precedes N*, so N-1 opens N's file and ignores the new columns. **Not adopted now**: it needs a "compatible reader" release train this project does not have | n/a |

The receipt gets the fields that make this decidable without opening any data file:
`previous.formats` (`{"settings": 1, "tokens": 1, ...}`), and `pre_migrate` (path and hash of
each snapshot taken by this update). `bothy rollback` reads them; it never has to guess.
Automatic rollback after a *failed* update (the case `update.go` handles today **[V]**) is the
easy row: the migration ran inside the same update, no user write intervened, restore the
snapshot unconditionally.

**Cost and honesty.** This means a rollback after real use can cost recent changes, and the
tool says so before acting. The alternative (silently proceeding) is the failure above. The
expand-then-contract rule keeps the third row rare: with it the *common* migration leaves the
file readable by neither N-1 nor a future tool differently from today, and the real protection
is the snapshot and the export.

### DS3. Backup and restore for the installed mode (answers question 3)

**Decision: add two host-side verbs, `bothy backup` and `bothy restore`, in the Go CLI.**
They run **on the host only**, like `bothy token` (D43: there is no route and no web surface to
make a stronger credential, or to exfiltrate a backup) **[V]** pattern in `token_cmd.go`
(`refuseIfNetwork`). On the checkout box the existing `just backup` / `bothy backup` wrapper
stays the entry point and the nightly timer is unchanged; the Go verb is the installed-mode
implementation and later the shared one.

**What is in the set.** Small, irreplaceable, user-made state; never what a release rebuilds.

| In the archive | Why | How it is read |
|---|---|---|
| `settings.db` | row 1 | the library's online-backup API, verified |
| `tokens.json` (+ `audit.log`) | row 4 | copy while holding `tokens.lock` |
| `receipt.json` | row 5 | copy; it says which release the archive belongs to |
| notes (`bothy-files/notes`, and any edited `policy.toml`) | row 8, 9 | tar; `git bundle` if it is a repo |
| the audit logs | row 10 | tar |
| `manifest.json` | the format rule DS1 | **first member**: `schema`, `bothy_version`, per-member sha256 and `schema`, `store_id`, the `key_id` the settings DB needs, UTC time, install kind |

| **Not** in the archive | Why |
|---|---|
| the generated stack, `previous/` | regenerated by `bothy install`; including them would restore stale compose onto a newer release |
| images, metrics, logs | recoverable or accepted loss |
| **the master key** | see below |
| Docker module data (Postgres, Keycloak, Grafana) | a *module's* backup, taken by the host `backups` module the way `scripts/backup.sh` does it today (`modes-and-modules.md` row `backups`); `bothy backup --all` calls both |

**The master key, and encryption at rest.** The settings DB is *already* envelope-encrypted
**[V]**, tokens are digests **[V]**, so the secret-bearing content of the archive is small.
Even so:

- The archive is **age-encrypted to a recipient** (public key) when one is configured
  (`backup.recipient`), which is the form the record already recommends: "an automated export
  timer holds no decryption power" (`settings-store.md` s11). The `age` binary is the one the
  record already plans to install checksum-pinned **[P]**; the library's encrypt half uses it
  **[V]**.
- With no recipient configured the archive is written plain, 0600, and `bothy backup` prints
  one line saying so and `doctor` shows amber. It does **not** silently invent a passphrase
  (age's passphrase mode is only as strong as the passphrase, `settings-store.md` s11).
- **The master key is never in the archive and never in `$DATA`.** It has its own verb:
  `bothy backup key --out <path>` writes a copy to a location the user names (a password
  manager export, a USB stick) and prints the `key_id`. `bothy install` ends by saying, in the
  same plain words the record uses, that the key exists in exactly one place and a backup
  without it cannot be restored (`settings-store.md` s10 "printed at bootstrap"), and `doctor`
  checks `key_id` in the key file equals `meta.key_check`'s **[P]** (record s10). Recording
  that an escrow copy was *made* (not where) as a receipt field lets `doctor` stop nagging.
- Rationale: a stolen archive must not be a stolen secret store; a destroyed key must not
  also destroy the only copy of it. Keeping them apart on purpose is the record's own rule
  **[V]** text, and this decision makes the apart-ness something the tool helps with instead
  of something the user must remember.

**Where it goes.** Default `$XDG_DATA_HOME/bothy-backups/` (a *sibling* of the install root, not
inside it, so `bothy uninstall --purge` of the install root cannot take the backups with it,
and so the `guardedRemoveAll(..., "bothy")` name rule cannot be tricked by it). A **second
target is part of the model**: `backup.copy_to` is an absolute path (mounted drive, NAS,
another user's directory) written after the local file, with the local file kept either way.
Doctor reports `only one copy` (amber) when the destination and the data share a device,
which is this box's exact situation today **[V]** (R1). Remote transports (S3, restic, rclone)
are out of scope; a path that happens to be a mount covers them. **Never into the repo:** the
verb refuses a destination inside any git work tree it can detect, inside `$DATA/stack`, or
under `$NOTES_ROOT`, and the repository's `.gitignore` and the existing secrets check
already forbid committing `*.age` and `backups/` (a new line in `scripts/checks` pins it).

**Retention.** Daily, keep 14 for the small set (matches `BK_KEEP` **[V]**); keep the
**last good pre-update and pre-migrate snapshot** regardless of age until the next successful
update (so a rollback always has its point); keep 3 for anything over 100 MB (matches
`BK_KEEP_BIG` **[V]**). `bothy backup prune` applies it; rotation never counts an unverified
file (the same lesson as `keep_if_real` **[V]**: an empty artifact must never evict a good one).

**Verification by restore test, not by hope.**

- Every `bothy backup` ends with `verify` on the file it just wrote: hash of every member,
  `manifest.json` parse (DS1), the settings DB passes the library's `_verify_backup_file`
  (integrity, dry-decrypt of **every** secret with the present key, audit chain and head)
  **[V]** code, used. A backup that fails verify is deleted and the run exits non-zero.
- `bothy restore --verify-only <archive> [--key <path>]` runs the same into a scratch
  directory and deletes it. A **monthly timer** runs it on the newest archive against a
  *copy of the key from escrow if available, else the live key*, and records `last_restore_test`
  in a state file; `doctor` goes amber at 35 days and red at 70 **[P]**.
- `bothy restore <archive>`: needs an explicit file (no "latest", the rule `restore.sh` already
  states **[V]**), stops the service, shows what it will overwrite and what the archive holds,
  asks, keeps the current state aside (`<state>/pre-restore-<ts>/`), swaps, verifies, starts.
  A restore replays old state: it lists secrets that changed since (library does **[V]**) and
  says the module apply steps must be re-run (record s10).
- The real proof is T6 in section 8: install on a throwaway VM, change things, back up, destroy
  the box, install again, restore, compare.

### DS4. Purge, uninstall and backup, reconciled (answers question 4)

D29 to D39 stand: packages never delete data; remove/purge never deletes `/var/lib/bothy`
or the master key (D37); only `bothy uninstall --data`-style removal does, with the typed
phrase **[V]** (`uninstall.go:13` "delete bothy data"). `uninstall` today deletes `secrets/`
(which *contains* `master.key`) under `--purge` **[V]** (`uninstall.go:86-92`), which the
D37 wording ("never the master key") reads against. **Decision, to remove the ambiguity:**

| Command | Removes | Keeps |
|---|---|---|
| package remove / purge, `bothy uninstall` | containers, network, generated stack files, `previous/` **[V]** | all data, the secrets dir with the master key, **the backups directory** |
| `bothy uninstall --purge` + phrase | everything in the row above **plus** `$DATA` (settings, tokens, notes) and `$CONF/secrets` | **the backups directory and any escrowed key** (outside `$DATA`/`$CONF`, DS3) |
| `bothy uninstall --purge --include-key` + phrase **and** a second typed phrase naming the `key_id` | additionally the master key file | n/a |

Three added rules, all small:

1. **`--purge` takes a backup first** unless `--no-backup` is given, so the typed phrase is not
   the only thing between the user and an unrecoverable loss. The backup lands in the
   backups directory, which purge never touches, and the prompt says where.
2. **The master key is deleted only by its own flag with its own phrase.** The key is the one
   item whose loss cannot be undone *even with* a backup that did not include it, and that is
   what justifies the second phrase. (This tightens today's behaviour, where `--purge` removes
   the whole `secrets/` directory **[V]**; it does not loosen any D-decision.)
3. **Uninstall prints the backups path and the key escrow status in its summary**, so the last
   thing the user reads before data goes is where it still is.

### DS5. Integrity and corruption handling (answers question 5)

One rule: **a store that cannot prove itself intact refuses to start and says what to do; it
is never "fixed" automatically and never replaced by an empty one** (an empty store is read
as "use defaults", which is silent data loss; `store.py:_header_version` says this in its
error **[V]**). The mechanics, by format:

| Concern | Rule | Settings DB | Token file | Receipt | Key file | Archive |
|---|---|---|---|---|---|---|
| Atomic write | temp in the same directory + fsync + rename + fsync of the directory | SQLite WAL, `synchronous=FULL` **[V]** | **[V]** | rename only, **no fsync, fixed temp name** **[V]**: fix | `link(2)` of a fully written temp **[V]**; the installer's own write is not **[V]**: fix | write to `.partial`, fsync, rename |
| Concurrency | one writer at a time under `flock` on a lock file next to the data | `_StateLock` **[V]** | `tokens.lock` **[V]** | **none [V]**: add `receipt.lock` | n/a (write once) | one `bothy backup` at a time via lock |
| Torn / partial file | detect by structure (header, parse, count), never by "it opened" | header check + `integrity_check` + required tables + `meta` rows + `user_version == meta.schema_version` **[V]** | parse + record validation, `StoreError` "damaged" **[V]** | parse error says "move it aside" **[V]** | `key_id` re-derived from bytes **[V]** | sha256 per member |
| On corruption | refuse, keep the file, point to the last verified backup | `CorruptDatabaseError`, never recreated **[V]** | `StoreError` **[V]**; no pointer to a backup | as left **[V]** | `KeyFileError` **[V]** | delete the partial, exit non-zero |
| Disk full | check free space before a write that cannot be repeated | planned for the pre-migrate copy (DS2) | n/a (KB) | n/a | n/a | `statvfs` before start |
| Unsupported filesystem | refuse network and Windows-drive mounts for anything with a WAL or a lock | **[V]** `fscheck` | **[A]** not checked (a token dir on `/mnt/c` would lose `flock` and mode bits) | **[A]** | key dir check **[V]** | n/a |

What the CLI tells the user. Not a stack trace, not "error": always **file, verdict
(corrupt / too new / too old), what was left untouched, the one next command.** Examples:

```
settings database /home/u/.local/share/bothy/settings/settings.db is schema 3; this bothy
knows up to 2 (too new). Nothing was changed. Run `bothy update`, or restore the copy
taken before the migration: /home/u/.local/share/bothy/pre-migrate/settings-v2-20261117T...
```
```
receipt /home/u/.local/share/bothy/receipt.json does not parse (corrupt). Nothing was
changed. It is rebuilt by `bothy install` (your data is not in it); the unreadable file
was kept as receipt.json.corrupt-<ts>.
```

`bothy doctor` (and the web page) show one line per format from the registry (section 3.1):
verdict, last write, last verified backup, last restore test.

### DS6. The settings store is the one home for configuration; `.env` is the transition, not a second store

Decided for stability, not elegance: **do not wire anything to the store until it has a
backup path** (DS3) **and the key format is settled** (R2). Wiring first would create the
irreplaceable-and-unbacked state this document exists to avoid. This reverses the usual order
(store first, backup later) on purpose; the library is already good enough to wait.
Precedence stays as `settings-store.md` s14 records: store beats `.env`, a deleted secret
falls back to `.env`, so the transition is reversible.

### DS7. Key format: the installer adopts the library's format

The installer writes 64 hex characters **[V]**; the library reads `bothy-master-key v1`
lines **[V]**. A key the installer generated is **not readable by the store**, and "never
overwritten, not even with `--force`" **[V]** (`keyfile.py`) would make this a hard stop in
the field. **Decision:** `bothy install` stops writing its own format and writes the library's
`bothy-master-key v1` file, with the library's crash-safe creation (`link(2)` of a fully written
temp, fsync, directory fsync); both paths agree on `$CONF/secrets/master.key`
(the library's default is `/etc/bothy/master.key` or `$XDG_CONFIG_HOME/bothy/master.key`
**[P]**; the installer's is `$CONF/secrets/master.key` **[V]**; nothing sets `BOTHY_MASTER_KEY_FILE` in the repo today **[V]**, so the installer must pass the path explicitly). Existing installs: a one-off
`bothy install` re-run converts a *valid* legacy hex key in place (same 32 bytes, so no data
depends on the old text form; there is no data yet **[V]**, as the store is unwired). This is
cheap now and impossible later.

### DS8. A lock on install and update

`bothy install`, `update`, `uninstall` and `backup` take one `$DATA/bothy.lock` (`flock`,
non-blocking, and the error names the holder's pid). Today two concurrent invocations can
interleave `RemoveAll(previous)` with a rollback **[V]** (no lock in `cli/internal/install`).
One lock file, one rule, covered by one test.

### DS9. What the web updater and the checkout box do (the two install kinds)

The two kinds keep their own *updater*; they share the **data rules**:

- **Checkout box** keeps `scripts/backup.sh`, the nightly timer and the "no update unless
  that night's backup succeeded" gate **[V]**. Three additions, each small: (a) put the
  token directory and (once it exists) the settings DB and an escrow *note* into the `state`
  set; (b) the same `verify` and monthly restore test; (c) the off-device second copy (DS3).
  The web updater, when it applies a release that changes a format, follows DS2 exactly (the
  migrator takes the snapshot; the updater refuses if it did not).
- **Installed box** uses `bothy backup/restore` (DS3) and the receipt fields of DS2.
- **Same archive format** on both once the Go verb exists, so a box can change kind
  (the README's "nobody moves from one to the other by accident" still holds) without a new
  format.

### DS10. What stays out of the backup, on purpose, and the rule that keeps it honest

Out of scope by decision (recorded so no one "fixes" it into a bug): metrics and logs history,
generated cluster tokens (re-issued by recipe), images. The rule: **every state row in
section 1 has exactly one of three fates written in the registry** - *backed up*, *rebuilt
(by what)*, or *accepted loss (by whom, when)* - and a check fails CI if a new `state` path
is added to the code without a fate. This is how the `redis` and `portainer` ghosts in
`backup.sh` (which reported failure every night for months **[V]**, comments in the script)
are prevented from coming back in the other direction (state that is never backed up because
nobody listed it).

## 4. Backup coverage: what changes, in one picture

| State | Today | After slice 1 | After slice 3 |
|---|---|---|---|
| settings DB | none | not written yet (DS6) | `bothy backup` set, verified |
| master key | none (by design) | `bothy backup key` prints and asks for a copy; doctor knows | escrow recorded; monthly test uses it |
| `.env` (checkout) | plain copy, same disk | **plus** a second device copy | encrypted to a recipient |
| tokens | none | in `state` | in the archive |
| receipt | none | n/a | in the archive |
| notes (installed) | none | n/a | in the archive |
| notes, Postgres, Grafana, VM, Loki (checkout) | yes, same disk | **plus** a second device copy of the small sets | same |
| restore rehearsal | per recipe | per recipe + `verify` of newest | monthly timer, doctor amber/red |

## 5. Data-loss risk register

Ranked by likelihood x damage (L, D each 1 to 5; score = L x D). "Test" is the check that would
prove the mitigation, and where it lives or would live.

| Rank | Risk | L | D | Score | Mitigation | Test that proves it |
|---|---|---|---|---|---|---|
| **R1** | **One virtual disk holds data and every backup.** Loss of `/dev/sdd` (vhdx corruption, host failure, a bad `wsl --unregister`) loses everything at once, including `.env`, the only copy of every credential **[V]** | 2 | 5 | 10 | off-device second copy of the small set (DS3, DS9), amber until configured | T5: after a backup, a file with the newest timestamp exists on a different `st_dev`, and the doctor check goes amber when `copy_to` is unset |
| **R2** | **The installer's master key is in a format the store cannot read, and the key is never overwritten** **[V]**. The first time the store is wired on an installed box it either refuses, or someone `--force`s a new key and every secret is gone | 4 | 4 | 16 (but **latent**: store unwired) | DS7: one format, crash-safe creation, one path | T2: `bothy install` in a temp HOME, then `bothy_settings.bootstrap` on that key file succeeds and `Store.open` round-trips a secret |
| **R3** | **The master key is lost or never copied off the box.** With it gone, a perfect DB backup is unreadable (by design) | 3 | 5 | 15 | DS3: escrow verb, install prints it, doctor checks `key_id`, key never in the archive nor in purge unless asked twice (DS4) | T3: delete the key from a restored-to-scratch tree; `restore --verify-only` fails naming the missing `key_id` (**[V]** library behaviour) and exits non-zero; and the doctor line is red when no escrow is recorded |
| **R4** | **Rollback after a migration leaves the box on old code with an unreadable store** (3.2). Likelihood rises with the first schema bump | 3 | 5 | 15 | DS2: snapshot-before-migrate, receipt records formats and snapshots, rollback decides data in the plan | T1 (below, the "migrate then roll back" sequence) |
| **R5** | **A torn write of the key or the receipt.** A power loss between `O_EXCL` create and the write leaves a short `master.key`, and the next run treats the step as done **[V]** (`Done: kerr == nil`). WSL under Windows host updates makes unclean stops real | 2 | 5 | 10 | DS5: temp + fsync + rename (or `link`) for both; step is "done" only when the file *parses* | T4: kill the process at each step (a `KILL` hook like the library's `_restore_hook` **[V]**) and assert the next run either completes or leaves nothing; a short key file is reported corrupt and not "done" |
| **R6** | **`bothy token` state is not in any backup, and the token dir may sit on an unsupported filesystem** | 3 | 2 | 6 | DS3 / slice 1 puts it in `state`; `fscheck` on the token dir | T7: restore the archive, `tokens.json` byte-equal; `token create --state /mnt/c/...` refused |
| **R7** | **A backup that does not restore**: corrupt, empty, or encrypted to a lost key and never tried | 3 | 4 | 12 | verify on every run; monthly restore test; doctor ages it | T6: plant a one-byte flip in each archive member; `verify` fails naming the member |
| **R8** | **Two `bothy` commands at once** corrupt the receipt or remove `previous/` mid-rollback | 2 | 3 | 6 | DS8 lock | T8: two concurrent `bothy update --dry-run`s; the second exits 75 (EX_TEMPFAIL) naming the first's pid, and the receipt is byte-identical |
| **R9** | **`--purge` removes the data the user needed** (the typed phrase is "all" or nothing) | 2 | 5 | 10 | DS4: backup first, key needs its own phrase, backups outside the purged tree | T9: `uninstall --purge` in a temp HOME leaves the backups directory and an archive that restores; without the second phrase `master.key` still exists |
| **R10** | **Plain secrets in a backup that leaves the box** (`.env`, Postgres dump with Keycloak password hashes, unencrypted **[V]**) when the second copy is added | 3 | 4 | 12 | encrypt to a recipient before anything crosses a device (DS3); the second-copy step refuses plain archives unless `--allow-plain` | T10: `copy_to` with no recipient and a non-local target refuses; with a recipient, `age -d` with the wrong identity fails and the right one yields the original bytes |
| **R11** | **A format a tool reads as "damaged" when it is merely newer** (tokens) leads someone to delete or recreate it | 2 | 3 | 6 | DS1 verdicts and exit 78 | T11: the golden fixture with `version: 2` -> exit 78 and file untouched, in Go and Python |
| **R12** | **Out of disk during a migration or a backup** | 2 | 3 | 6 | `statvfs` check, DS2 | T12: a size-limited tmpfs state dir; the migration refuses before touching the file |

R2 is ranked by the damage it does when it fires; its likelihood is high only after the store
is wired, which is why DS6 puts the wiring after DS7.

## 6. What the owner must decide (and what is recommended)

| # | Question | Recommendation | If the owner says no |
|---|---|---|---|
| Q1 | Accept DS1 (one `schema` rule, exit 78 for too new/too old, 74 for corrupt) | yes | N rules, N drifts |
| Q2 | Accept DS2 incl. "rollback after real use can cost recent changes, and says so" | yes; the alternative is the silent failure in 3.2 | only additive migrations ever, forever (no `breaking: data` release) |
| Q3 | A recipient (age public key) is configured at install, or the archive is plain | **ask at install, default to "plain with an amber warning"** so a first install never blocks on key generation | require a recipient: safer, adds a step to mini |
| Q4 | A second copy location is required after the first week | yes for the checkout box now (R1); optional on installed boxes with an amber | a documented risk, no code |
| Q5 | `--purge` takes a backup first | yes | the typed phrase is the only guard |
| Q6 | The key needs its own phrase to be purged | yes | one phrase deletes the key too |
| Q7 | Do not wire the store before slice 3 (DS6) | yes | wire early, accept R2 and R3 |

## 7. Honest limits

- Backups protect against the failure modes listed. They do not protect against a *consistent
  but wrong* state (a bad setting that was backed up), against whoever holds the master key,
  or against the host operator. The settings record's threat model (`settings-store.md` s12)
  stands unchanged.
- The Docker-module half (Postgres, Keycloak) is backed up by an existing script that has
  worked in practice; this plan does not re-engineer it. Its weak points are R1 and R10 only.
- Sizes for the installed box are **[A]**: mini has no measured data volume because the store
  is unwired and notes are read-only.
- The monthly restore test and doctor thresholds (35 and 70 days) are **[A]**: chosen to be
  longer than one missed month and shorter than the 14-day retention horizon is long.
  Tune from the first quarter's data.
- A `breaking: data` migration is defined here and **never exercised**; the first one is the
  test of DS2.

## 8. The tests, as a list (so the register is not decoration)

| ID | Proves | Where it lives (existing or to add) |
|---|---|---|
| T1 | migrate then roll back: N-1 data, install N, migrate, write, `rollback` -> refused with counts; `--restore-data` -> equals the pre-migration copy; failed update -> auto-restore, byte-equal | new, `cli/internal/install` + `apps/bothy-settings/checks` (the `before` hook is already a seam **[V]**) |
| T2 | the installer's key is readable by the store | new, one Go test that shells to the Python library check |
| T3 | restoring without the key fails by name, no files changed | **[V]** exists in the library (`test_backup.py`); add the CLI exit code |
| T4 | crash at every write step leaves either the old or the new file, never a short one | new, kill-hook per `_restore_hook` pattern |
| T5 | second copy is on another device | new, a doctor check plus a fixture with two tmpfs |
| T6 | any flipped byte in any archive member is detected | new |
| T7 | token state backed up and restored; unsupported filesystem refused | new |
| T8 | install/update lock | new |
| T9 | purge never takes the backups or (without the second phrase) the key | extends `uninstall` tests **[V]** which already cover the phrase |
| T10 | plain archives do not leave the device | new |
| T11 | too-new token file is exit 78, untouched | extends the golden fixture **[V]** |
| T12 | low disk refuses before writing | new |
| T13 (the integration proof) | on a throwaway VM: install, create state (a setting, a secret, a token, a note), back up, destroy the box, install, restore, diff | `lab/install-proof` is the harness **[V]** (`lab/install-proof/proof.sh`); add the data legs |

## 9. Build order, smallest first

Each slice is independently shippable, small, and reversible. The first is the one that makes
the box **measurably** safer.

### Slice 1, the smallest: protect what exists, with no new components (about a day)

All on the checkout box, shell and a few lines of Go; no new service, no schema change.

1. `scripts/backup.sh`: add the token directory to the `state` tar (R6); a new
   `second copy` step copying the newest **small** artifacts (`env`, `postgres`, `grafana`,
   `state`, `notes`; not VM or Loki) to `BACKUP_COPY_TO` when set, and a `doctor.sh` line that
   is **amber when it is unset or on the same device** (R1). This is the measurable change:
   `just doctor` goes from silent to amber today, and green once a second location exists.
2. `cli/internal/install`: write the key and the receipt durably (temp + fsync + rename +
   directory fsync) and make the `secrets` step "done" only when the file parses (R5);
   write the library's `bothy-master-key v1` format (R2/DS7).
3. The registry check (3.1) with the first fixtures and `schema` read on the receipt (DS1's
   cheapest part).

**Measure of done:** `doctor` shows the second-copy line; T2, T4, T11 pass; the token set
appears in the next nightly `state` tarball. Rollback: revert the commit; the nightly timer
keeps working as it did.

### Slice 2: the lock and the format rule (small)

DS8 lock, DS1 exit codes 78/74 across the three readers, receipt `previous.formats` and
`pre_migrate` fields (empty until a migration exists). T8, T11.

### Slice 3: `bothy backup` / `restore` / `verify` and the key escrow verb

DS3 and DS4. Archive format with `manifest.json` (a new row in the registry). Requires the
pinned `age` install the record already plans. T6, T7, T9, T10, T13.

### Slice 4: wire the settings store (the existing #317 follow-up)

Only now (DS6). The first migration in the field uses DS2; T1 runs before the first release
that has one.

### Slice 5: the monthly restore test and the web surface

The timer, the doctor amber/red thresholds, and a read-only "Data" page in the console showing
the registry rows, last backup, last verified restore. No write controls: backup and restore
stay host-side (D43 reasoning).

## 10. Sources

Code and scripts (all read in this worktree): `apps/bothy-settings/bothy_settings/{store,schema,keyfile,fscheck,export}.py`,
`apps/bothy-settings/README.md`, `apps/bothy-ops/tokenstore.py`, `cli/internal/tokens/{types,store_unix}.go`,
`cli/internal/install/{install,update,uninstall,manifest,kind}.go`,
`cli/internal/cli/{cli,install_cmd,token_cmd}.go`, `scripts/{backup,restore,snapshot}.sh`,
`scripts/lib/backup-lib.sh`, `docs/guide/backups.md`.
Plans: [README.md](README.md), [updates-and-rollback.md](updates-and-rollback.md),
[migration.md](migration.md), [modes-and-modules.md](modes-and-modules.md),
[distribution-and-packaging.md](distribution-and-packaging.md), [cli-and-control-plane.md](cli-and-control-plane.md),
[../settings-store.md](../settings-store.md). Live-box facts (read-only): `~/claude-notes/stack/overview.md`,
`ls`, `du`, `df` of `~/backups` and `~/.local/state/bothy`, 2026-11-17.
