# Decision record: the settings and secrets store

_Written 2026-11-16. Status: **decided (owner, D11): option A**, shape specified
here; nothing built. Part of #315; this is the deliverable of #316 and unblocks
#317 (the store), #318 (the renderer), #319 (first run). Context:
[thin-bothy/README.md](thin-bothy/README.md) (decision D11),
[thin-bothy/security-model.md](thin-bothy/security-model.md) s2.4,
[thin-bothy/hybrid-runtime.md](thin-bothy/hybrid-runtime.md)._

**Claim discipline.** Every technical claim carries a source in the References
section, or is marked **(unverified)**. Where this record differs from the text of
#316 / #317 / #318 / #319 it says so in section 15, so the issues can be amended
rather than silently contradicted.

## 1. The decision, in one paragraph

System settings and secrets live in **one SQLite database** owned by **one small
service, `bothy-settings`**. Non-secret settings are plain rows. Each secret is
encrypted with **its own random data key (DEK)** under **AES-256-GCM**, the DEK is
wrapped by a **master key (KEK)** that lives in **a file outside the database and
outside the default backup set**, and the module and key names are bound in as
associated data. Secrets are **write-only** at every public surface: replace,
generate or delete, never reveal. Consumers do not call a decrypt API: the service
**projects** secrets as files (a Kubernetes Secret volume, or a mode-0600 file that
Compose mounts). The portable, key-independent backup is an **age-encrypted export
bundle**. Vault, OpenBao and Infisical remain possible later behind the same
four-verb interface; SOPS/age is used only as the export format.

## 2. What is being stored (sizing, so the choice is not argued in the abstract)

| Fact | Value | Source |
|---|---|---|
| Secrets the installer generates today | 5 (`POSTGRES_PASSWORD`, `DEV_LOGIN_PASSWORD`, `OAUTH2_COOKIE_SECRET`, `KEYCLOAK_DB_PASSWORD`, `KEYCLOAK_OAUTH2_CLIENT_SECRET`) | `scripts/lib/bootstrap-keys.sh` |
| Secrets in a fully configured `.env` | about 19 | `docs/plans/control-and-settings.md` s6c |
| Expected rows at full modules | tens of secrets, low hundreds of settings | estimate (unverified) |
| Expected DB size | well under 1 MiB | estimate (unverified) |
| Writers | humans through Settings and the CLI, a few per day at most | assumption |
| Readers | the renderer at `up`/apply time, plus the Settings page for metadata | design |

At this scale **nothing in the choice is a performance question**. The criteria are
(1) circularity, (2) what must be running for it to work, (3) fit with this
codebase, (4) key custody, (5) failure and recovery, (6) honest threat model.

## 3. The options, weighed against this codebase

Facts about the repo used below: Bothy's services are stdlib Python plus, at most,
one isolated dependency per container; the shared Postgres is the **projects'
development database** and, per D3, stays a Docker module that mini does not run;
Keycloak and Postgres bake their passwords into their volumes at first start (#315
inventory); and `just backup` already backs up SQLite files with the online-backup
API (`scripts/backup.sh`, Grafana).

| | **A. SQLite + envelope encryption, `bothy-settings`** | **B. Shared Postgres, schema `bothy`** | **C. SOPS/age files** | **D. Vault / OpenBao / Infisical** |
|---|---|---|---|---|
| Needs to exist before first run | a key file and a directory | **a running Postgres.** D3/D5 put Postgres outside mini, so mini would have to run it just to hold its own settings | an age key, a file layout and the `sops` binary | another stateful server, plus initialisation |
| Circularity | none: the KEK is a file | **Postgres's own password and Keycloak's DB password are secrets that would live in it** | none | its unseal/root key is a secret that must live outside it |
| Works with Postgres down, or mid-major-upgrade (`stack/updates.md`) | yes | **no**, and that is when settings are needed | yes | yes |
| New moving parts | 1 container, 1 pinned dependency (`cryptography`) | a driver in every reader, plus roles, migrations in someone else's DB | `sops` + `age` binaries | OpenBao/Vault: unseal procedure on every restart. Infisical: its compose template runs Infisical, PostgreSQL **and** Redis |
| One UI edit of one field | row update | row update | decrypt file, edit, re-encrypt, write | API call |
| Write-only secrets | by construction (no read verb) | by construction | **not natural**: whoever holds the age identity decrypts everything; "write-only" is a convention of the editor | native policies |
| Audit | an audit table, same transaction as the change | same | git history, but live state is gitignored by design (SECURITY.md rule 5) | built in |
| Rotation | rewrap DEKs under a new KEK in one transaction | same, but across a network DB | `sops updatekeys` / rotate (unverified) | built in |
| Concurrency | one writer process, SQLite locking | MVCC | file-level, last writer wins | server |
| Footprint | tens of MiB (unverified), no extra service in the cluster | zero marginal if Postgres is already there, **large marginal if not** | zero resident | resident service; size **unverified** |
| Backup | one consistent file via the backup API, plus the key kept elsewhere | `pg_dump`, plus the key to a separate store anyway | copy files, plus the age identity | snapshot + unseal keys |
| Fits rule 3 ("the stack does not provide what a project ships") | yes: Bothy's own state in Bothy's state dir | **no**: mixes Bothy state into the projects' dev DB | n/a | n/a |
| Single point of failure | KEK file | Postgres **and** the KEK for any column encryption | age identity | unseal keys / KMS |

### 3.1 Why not B

B fails on **circularity and availability**, not taste. A stack that stores
Postgres's password inside Postgres cannot start Postgres from its own store after a
volume loss, and the settings page would be unreachable during the one operation
(a major upgrade) that most needs a trustworthy record of what is configured.
B also needs a key anyway if values are to be encrypted at rest, so it removes none
of the key-management problem and adds a dependency. B would be the right answer on
a host that already runs a managed Postgres and does not care about mini; that is
not this product.

### 3.2 Why not C as the store

C is excellent for **static, reviewable, git-held** configuration, and that is
exactly why it is kept as the **export format** (section 11). As a live store it
loses on three points: edits are whole-file decrypt/re-encrypt cycles (no per-field
audit, last-writer-wins), write-only is not enforceable (any process able to run
`sops` with the identity can read everything), and the repo's own rule is that live
secrets are not tracked, which removes C's main benefit (git history as audit).

### 3.3 Why not D (now)

D solves problems this deployment does not have (multi-tenant policy, dynamic
credentials, many clients) and adds the problem it does have worse: a second
stateful service with an unseal ceremony. With Shamir sealing an operator must
resubmit shares after **every restart**; with auto-unseal the unseal key is
delegated to a cloud KMS or HSM, and if that key is lost the data may be
unrecoverable (OpenBao docs, References). On a WSL2 box that reboots with a Windows
update and on a mini install with no cloud account, that is strictly more fragile
than a key file. D stays reachable through the interface in section 5.

### 3.4 Variants of A that were weighed and rejected

| Variant | Why not |
|---|---|
| **SQLCipher** (whole-file encryption) | Real and mature: per-page AES-256-CBC with a per-page random IV, HMAC-SHA512 per page, PBKDF2 for passphrases, raw binary keys allowed. But it needs a SQLCipher build and a binding in the container (**availability of a maintained pip wheel on arm64 and amd64 unverified**), gives **one** key for everything with no per-record domain separation, and rotation is a whole-file rekey. It also hides non-secret setting names, which we do not need hidden. Application-level envelope encryption encrypts exactly the rows that need it and is testable with ordinary SQLite tooling. Revisit if "key names are sensitive" ever becomes a requirement. |
| **XChaCha20-Poly1305 instead of AES-GCM** | Its virtue is a 192-bit nonce that makes random nonces unconditionally safe. The `cryptography` library's AEAD page documents ChaCha20Poly1305 (12-byte nonce) and AESGCM, and does **not** document XChaCha20 (References), so choosing it means a second dependency. It is unnecessary here: see 6.3. |
| **AES-GCM-SIV** (nonce-misuse resistant, RFC 8452) | Available in `cryptography` since 42.0.0 but raises `UnsupportedAlgorithm` if the OpenSSL build lacks it. Misuse resistance is a hedge we do not need when each DEK encrypts exactly one message. Keep as the documented fallback if a nonce-handling bug is ever found. |
| **age for the per-secret layer** | Needs a Go binary or an unverified Python binding in the hot path. age is used where it is strong: files. |
| **`openssl enc` / shelling out** | No AEAD with associated data on the command line (unverified); a process spawn per secret. |

## 4. Where it runs, and what applies below the 4 GiB floor

Hosts under **4 GiB of RAM take the Compose install** (k3s is not offered there; the
4 GiB boundary is the owner's, and I found no document in the repo that states it,
so treat the number as **unverified against the footprint measurements**). The store
is **runtime-independent**: the same service, schema and crypto run in both.

| Aspect | Compose install (all hosts, incl. under 4 GiB) | k3s install |
|---|---|---|
| Service | one container `bothy-settings`, cap `mem_limit` (size **unverified**, expected tens of MiB) | one Deployment, 1 replica, `Recreate` strategy |
| DB location | `$STATE_ROOT/bothy/settings/settings.db`, on a **native Linux filesystem** | a `local-path` PVC on the node's ext4 |
| KEK source | host file (section 6.1), bind-mounted read-only into the container | the same host file is canonical; the installer projects it into a Secret in its own namespace (section 9.2) |
| Secrets reach consumers | mode-0600 files under `.../settings/run/`, mounted per service | Kubernetes Secrets written by the service into module namespaces, mounted as volumes |
| At-rest cover for projected copies | **none beyond file permissions and the host's disk**: this is today's `.env` threat model | `--secrets-encryption` on k3s (same-node key: copies of the datastore only) |
| Internal read path | unix socket in `.../settings/run/`, host CLI only | no decrypt API for pods; the service pushes (section 9) |
| Docker modules while on k3s (`hybrid-runtime.md`) | n/a | the Docker half uses the Compose column on the same host |

So the **store, API, audit, rotation, backup and export (sections 5-8, 10-13)
apply everywhere**; sections 9.1 (files) applies to Compose and to Docker modules on
k3s; 9.2 applies only to k3s. A host under 4 GiB gets the whole record minus 9.2.

SQLite's WAL mode **does not work over a network filesystem** and requires all
processes to be on the same host (SQLite WAL doc). The DB must therefore live on the
node's own filesystem, **not** on a network mount; on WSL2 that means the ext4
distro disk and not a `/mnt/<drive>` path (behaviour of the Windows drive mount here
is **unverified**; review finding S13 raises the same concern for k3s).

## 5. The store's interface (what a backend must implement)

Four verbs, so a Vault/OpenBao backend can slot in later without changing callers
(#316): `put(module, key, value, actor)`, `delete(module, key, actor)`,
`get_meta(module, key)`, `list_meta(module)`. There is **no `get_value` on the
public interface.** Decryption is a separate, internal capability used only by the
projector (section 9) and by export (section 11). The module schema (#320) is the
authority on which fields are secret; the store keeps a registry of that
classification and **refuses** a plaintext `put` to a key registered as secret and
a secret `put` to a key registered as plain, so a mis-typed form cannot write a
secret in clear.

Public HTTP surface (exact `Path()` routes per SECURITY.md rule 3, which means **no
path parameters**: module and key travel in the body or query; final names are
#317's to fix):

| Route | Tier | Does |
|---|---|---|
| `GET /-/api/settings/modules` | viewer | module schemas and **non-secret** values |
| `GET /-/api/settings/secrets` | viewer | `[{module,key,set,version,updated_at,updated_by,fingerprint}]` |
| `PUT /-/api/settings/value` | operator | validate and write a non-secret, audited with old and new |
| `PUT /-/api/settings/secret` | operator | replace a secret; audited as "changed" |
| `POST /-/api/settings/secret/generate` | operator | server-side random value by a schema-declared policy; value never returned |
| `POST /-/api/settings/secret/delete` | operator | remove; the key falls back to `.env` during transition |
| `GET /-/api/settings/audit` | operator | audit entries (never a secret value) |

Every write takes an `if_version`; a mismatch is `409` (section 13).

## 6. Key hierarchy and cryptography

### 6.1 Levels

```
 master key (KEK)  --  32 random bytes, a FILE outside the datastore
   |-- wraps --> store keys  (fp_key, audit_key)   2 x 32 random bytes, in `meta`
   '-- wraps --> DEK[module,key]                    1 x 32 random bytes per secret, in `secrets`
                  '-- encrypts --> the secret value (AES-256-GCM)
```

- **KEK file.** Generated by `bootstrap` with the OS CSPRNG, 32 bytes, base64 in a
  small versioned text format holding one or more `key_id base64` lines (the first
  is the active key; more than one only during rotation, section 7). Location:
  `$BOTHY_MASTER_KEY_FILE`, default `/etc/bothy/master.key` for a root install, else
  `$XDG_CONFIG_HOME/bothy/master.key` (that is, **not** under `$STATE_ROOT`, so the
  default `just backup` of state does not sweep it up). Mode `0600`, owned by the
  user the service runs as; the directory `0700`. Written with `O_EXCL`, fsynced,
  directory fsynced. **Never overwritten**, `--force` included (the existing
  `bootstrap.sh` rule for generated secrets, applied to the key).
- **`key_id`** is the first 8 bytes of SHA-256 of the key, hex. It is stored with
  every wrapped DEK so a wrong key is named, not guessed.
- **Why a DEK per secret and not one data key for the DB.** A single data key
  encrypting every value makes the nonce count a shared budget and makes every
  rotation a full re-encrypt. With a DEK per secret each DEK encrypts exactly **one**
  message; the KEK only ever wraps a few tens of small keys; rotation of the KEK
  rewraps keys without touching values; and a single secret can be re-encrypted
  independently. Per-record is the right grain here because the record count is tiny.

### 6.2 Algorithms and encodings

| Item | Choice |
|---|---|
| Value encryption | AES-256-GCM, 96-bit random nonce, fresh DEK, 128-bit tag, via `cryptography`'s `AESGCM` |
| DEK wrapping | AES-256-GCM under the KEK, 96-bit random nonce. (RFC 3394/5649 AES key wrap is the alternative; GCM is chosen because it carries associated data, which key wrap does not (unverified detail of the library API).) |
| Associated data (value) | `"bothy/v1/value" 0x00 store_id 0x00 module 0x00 key` |
| Associated data (wrap) | `"bothy/v1/wrap" 0x00 store_id 0x00 module 0x00 key 0x00 key_id` |
| `store_id` | 16 random bytes created at DB creation, in `meta`; stops a row or whole DB from another store being replayed into this one |
| Fingerprint | first 4 bytes, hex, of `HMAC-SHA256(fp_key, module 0x00 key 0x00 value)`; keyed so a stolen DB cannot be used to brute-force a weak value offline; **stable across KEK rotation** because `fp_key` is itself a wrapped store key; changes when the value changes. It is a human "did it change" check, not an identifier |
| Audit chain MAC | `HMAC-SHA256(audit_key, prev_mac || canonical_entry)` |
| Key check | `meta.key_check` = a known constant encrypted under the KEK; decrypting it is the "is this the right key" test |
| Values | UTF-8 text, at most 16 KiB; binary secrets are base64 by the module schema |

### 6.3 Nonce arithmetic (why random 96-bit nonces are safe here)

NIST SP 800-38D bounds the number of invocations of AES-GCM under one key with
random 96-bit IVs at 2^32 (I am quoting this from the standard as remembered; the
document text could not be extracted in this session, so **the 2^32 figure is
unverified here, check section 8.3 of SP 800-38D**). The `cryptography` docs
confirm the 96-bit recommendation and the "never reuse a nonce" rule. Our
exposure: each DEK encrypts **one** message (limit: 1 of 2^32); the KEK wraps
N DEKs plus two store keys over its life, N in the tens to low thousands even with
frequent changes. Birthday collision probability for n random 96-bit nonces is about
n^2 / 2^97; for n = 50 that is about 2.5e3 / 1.6e29, roughly 1e-26. The KEK is
rotated well before anything approaches the limit. Nonce reuse is therefore a
**bug** risk (a code path that reuses a nonce), not a probability risk, and the
tests in section 16 target that bug directly.

### 6.4 Cryptoperiods

Rotate the KEK on a schedule and on any suspected exposure. A default of
**12 months** is proposed; NIST SP 800-57 Part 1 is the reference for cryptoperiods
but I did not verify specific numbers from it, so the interval is a judgement, not
a citation, and is an owner decision (section 17, Q5).

## 7. Schema (SQLite, `user_version` migrations, forward only)

Pragmas on open: `journal_mode=WAL`, **`synchronous=FULL`**, `foreign_keys=ON`,
`busy_timeout=5000`, `secure_delete=ON` (a deleted secret's ciphertext is overwritten
on page reuse; this does not protect plaintext, which is never in the file).
`synchronous=NORMAL` in WAL mode can lose the most recent commits after power loss
(SQLite WAL doc); for a few writes a day the cost of `FULL` is irrelevant and a
silently reverted "I rotated that password" is not. The file mode is `0600`.

```sql
CREATE TABLE meta (               -- k/v: schema_version, store_id, key_check,
  k TEXT PRIMARY KEY,             --      wrapped store keys, created_at
  v BLOB NOT NULL
) STRICT;

CREATE TABLE fields (             -- registry copied from module schemas (#320)
  module     TEXT NOT NULL,
  key        TEXT NOT NULL,
  is_secret  INTEGER NOT NULL CHECK (is_secret IN (0,1)),
  PRIMARY KEY (module, key)
) STRICT;

CREATE TABLE settings (           -- non-secret values
  module     TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  version    INTEGER NOT NULL,    -- optimistic concurrency
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,       -- UTC, ISO 8601
  PRIMARY KEY (module, key)
) STRICT;

CREATE TABLE secrets (
  module      TEXT NOT NULL,
  key         TEXT NOT NULL,
  ciphertext  BLOB NOT NULL,      -- value under the DEK (tag included)
  nonce       BLOB NOT NULL,      -- 12 bytes
  wrapped_dek BLOB NOT NULL,      -- DEK under the KEK (tag included)
  wrap_nonce  BLOB NOT NULL,      -- 12 bytes
  kek_id      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (module, key)
) STRICT;

CREATE TABLE audit (              -- append-only by trigger (below)
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,       -- user, "cli:<os user>", or "system:<component>"
  surface    TEXT NOT NULL,       -- web | cli | api-token | mcp | bootstrap | import
  action     TEXT NOT NULL,       -- set|delete|generate|rotate-kek|rotate-dek|
                                  -- export|import|restore|projection|migrate|read-denied
  module     TEXT,
  key        TEXT,
  old_json   TEXT,                -- non-secrets only
  new_json   TEXT,                -- non-secrets only; NULL for secrets
  detail     TEXT,                -- "changed" for secrets; a count for bulk ops
  request_id TEXT,
  mac        BLOB NOT NULL
) STRICT;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
  BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
  BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
```

The `fields` registry is what the "no secret in `settings`" refusal checks. Secret
and non-secret values never share a table. `STRICT` tables need SQLite 3.37+
(unverified against the version in the image; the build host here reports 3.45.1,
and the pinned image's version must be asserted by a test).

## 8. Rotation

### 8.1 DEK rotation

A DEK is replaced on **every** `put` (a new random DEK and nonce), so rotating a
secret's value also rotates its DEK. `bothy settings rotate-deks` re-encrypts every
secret under fresh DEKs (decrypt, encrypt, one transaction); it is cheap at this
size and is the response to "a DEK may have leaked" without changing the KEK.

### 8.2 KEK rotation (`bothy settings rotate-key`)

1. Take a **pre-rotation backup** (section 10) and verify it.
2. Generate a new KEK; **append** it to the key file as active, keeping the old one
   (file written atomically; old retained).
3. In **one `BEGIN IMMEDIATE` transaction**: unwrap each DEK and the two store keys
   with the old KEK, wrap with the new, update `kek_id`, `wrap_nonce`,
   `wrapped_dek`, update `key_check`, write an audit entry. Values are **not**
   re-encrypted.
4. Verify by decrypting every secret with the new KEK alone (in memory).
5. `rotate-key --finish` moves the old key line to `master.key.retired.<key_id>`
   (not deleted). It is **resumable**: because every row carries its `kek_id`, an
   interrupted run is detected at startup and either finished or rolled back; the
   file holding both keys is what makes that possible.

**The retired key must outlive every backup made before the rotation.** A backup
holds DEKs wrapped under the KEK of its day. Keep a retired key until the oldest
backup that needs it is gone (backup retention is 14 days in `scripts/backup.sh`;
the export bundle, section 11, does not depend on any KEK and avoids this
entirely). The doc for operators says this in one sentence next to the command.

### 8.3 What is **not** rotation

Changing a secret's value in the consuming system (a Postgres role password, a
Keycloak client secret) is a **module action**, because Postgres and Keycloak bake
passwords into their data volumes at first start (#315). Writing a new
`POSTGRES_PASSWORD` into the store does not change the database. The module
schema declares an apply step for such fields (`ALTER ROLE`, a Keycloak API call),
and the store marks a field `pending-apply` until that step succeeds; otherwise the
store and the world disagree silently. (#311 rotates a remote-cluster token the
same way.)

## 9. How secrets reach containers

**Principle: files, never environment; push, never pull.** `docker inspect` shows
a container's environment, `/proc/<pid>/environ` exposes it to same-uid processes,
and Compose's own docs warn that env vars leak into logs. Files with permissions
avoid all three (Compose and Kubernetes docs, References). And consumers do not
call a decrypt endpoint: the service writes the files, so **only two things hold
decrypt capability: the settings service and the host CLI (which talks to it)**.
This is narrower than #317's "Bothy's own services read decrypted values over a
socket" and is flagged in section 15.

### 9.1 Compose (and Docker modules on k3s hosts)

- The projector writes `$STATE_ROOT/bothy/settings/run/<service>/<KEY>` (dir `0700`,
  files `0600`, owner = the service's `PUID`), by writing a temp file and renaming.
- Compose mounts it with a top-level `secrets:` entry (`file:`), which bind-mounts
  one file per service at `/run/secrets/<name>` (Compose docs; whether Compose backs
  it with tmpfs is **not stated** in the docs, and I assume it does not).
- Images that support the `*_FILE` convention (Postgres `POSTGRES_PASSWORD_FILE`,
  and per #318 Grafana and Keycloak's DB password) take the path. For an image that
  has **no** `_FILE` support, a tiny entrypoint shim reads the file and `exec`s the
  program with the variable set in **its** process only: it then does not appear in
  `docker inspect` (Config.Env), though it is still in that process's environment.
  Whether oauth2-proxy accepts `*-file` for each secret it uses is **unverified**;
  the shim is the fallback.
- **Single-file bind mounts and renames.** Replacing a file by rename gives it a new
  inode, and a container with a single-file bind mount keeps seeing the old one
  until it is recreated (this is the "bind-mount inode gotcha" in the monitoring
  note). So a changed secret **always** triggers the module's declared apply step
  (`restart <svc>`), and the `run/` files are not expected to hot-reload.
- **The plaintext projection is on disk.** Compose installs therefore protect the
  DB, its backups and the export, **not** the projected files, which are as
  exposed as today's `.env`. This is a stated limit, not a bug (section 12). A
  tmpfs `run/` under `/run` would remove it but must be re-rendered before any
  container starts after a reboot, which fights `restart: unless-stopped` ordering;
  decided against for now (Q6).
- `run/` is **excluded** from every backup and from `bothy config export`.

### 9.2 k3s

- The service creates/updates **Kubernetes Secrets** in the module's own namespace
  (it already holds that right, `security-model.md` s2.1) and pods mount them as
  **volumes, never `env`/`envFrom`**. Kubernetes' own guidance recommends read-only
  file mounts with restrictive `defaultMode`; volume contents refresh after a Secret
  changes (not for `subPath` mounts), while env values are fixed at container start
  (Kubernetes docs, tmpfs backing and refresh behaviour **unverified here**).
- By default Secrets are stored **unencrypted** in the datastore; start k3s with
  `--secrets-encryption` (`k3s secrets-encrypt` supports `rotate-keys`, with the
  warning that a wrong procedure can corrupt the cluster). That protects copies of
  the datastore, not root on the node.
- `helm get values` for every release contains no secret (CI fixture from
  `security-model.md` s3). Secrets are never templated into values, ConfigMaps or
  Job args.
- **The KEK in k3s.** The canonical copy stays the host file. The installer
  (root, on the host) projects it into a Secret in a dedicated namespace
  (`bothy-settings`), mounted only into the settings pod. A `hostPath` mount would
  avoid a cluster-side copy but violates the restricted Pod Security baseline
  `security-model.md` s2.5 requires. Consequence, stated plainly: **the KEK exists
  twice on the node** (file and Secret) and a copy of the k3s datastore holds it
  (encrypted only by k3s's own same-node key). The settings DB backup does not
  contain it. Any k3s-state backup that copies the datastore must be treated as
  key-bearing (Q4).
- Review finding: RBAC cannot constrain the *contents* of a Job `bothy-api` creates,
  so a Job could mount any Secret including the KEK. The **admission policy** that
  forbids Secret mounts in API-created Jobs (`review-findings.md`) is a hard
  prerequisite for putting the KEK in the cluster at all.

### 9.3 The internal read path

There is one: a **unix socket** at `$STATE_ROOT/bothy/settings/run/settings.sock`
(`0660`, owner `bothy`, group-allowlist), not routed by Traefik, authorised by
filesystem permission plus `SO_PEERCRED` uid check, serving the **host CLI** only
(`config render`, `config export`, `admin reset`, `settings backup/rotate-*`). Every
use writes an audit row. In k3s there is **no** equivalent network endpoint: pods
get projected Secrets and nothing else. A CI check proves no Traefik router can
reach the socket path or any `/internal` route (extends the #317 "no route returns
a secret" check).

## 10. Backup and restore

**A backup of the DB without the key is useless; a key without a DB backup is a
single point of failure that protects nothing.** Both statements are true and the
design keeps them in **different places on purpose**: if they travelled together,
a stolen backup would be a stolen secret store.

| Artifact | Contains | Taken by | Stored |
|---|---|---|---|
| **DB backup** `settings/<ts>.db` + `.sha256` | settings (plain), secrets (ciphertext + wrapped DEKs), audit | `just backup` via the SQLite online-backup API (never a `cp` of a live WAL database) | the normal backup set |
| **Key** | the KEK | operator, once at bootstrap and after each rotation | **not** in the backup set; printed location, off-box copy required |
| **Export bundle** `*.age` | everything, **independent of any KEK** | `bothy config export` | anywhere; protected by the age recipient/passphrase |

- **How the DB backup is taken.** The online-backup API produces a consistent
  snapshot even with writers active (it restarts if a writer interferes, and may
  never finish under constant writes, which is not our write rate); `VACUUM INTO`
  is the other documented technique. A raw file copy is wrong here for two
  reasons from the SQLite docs: a copy during a crash can be corrupt, and in WAL
  mode the `-wal` file is part of the database, so separating them can lose
  committed transactions. After writing, the backup is opened and checked with
  `PRAGMA integrity_check` and the `meta` row, then hashed.
- **Retention.** Same as the other SQLite file in `backup.sh`: 14.
- **The key is not backed up by `just backup`**, and the command prints, every run,
  the key's path, `key_id`, and "a backup without this key cannot be restored".
  `just doctor` fails **strict** if the key file is absent, unreadable, or its
  `key_id` does not match `meta.key_check`.
- **Restore** (`bothy settings restore <db>`): service stopped (a `flock` on the
  state dir); verify hash and `integrity_check`; refuse a `schema_version` newer
  than the binary; **dry-decrypt**: unwrap `key_check` and every DEK with the
  present key set, and report which `key_id` is missing before touching anything;
  copy the current DB aside; swap in; start; write an audit row `restore`. A
  restore is a **replay of old state**: secrets changed since the backup revert, and
  the module apply steps must be re-run (a rotated Postgres password reverts in the
  store but not in Postgres). The command says so and lists secrets whose
  `updated_at` is newer than the backup.
- **Key custody advice** printed at bootstrap: copy the key file to a password
  manager or offline medium, **separately** from the backups; and take an export
  bundle right after install (the install prints the command and does not proceed
  silently without telling the user the bundle does not yet exist).

## 11. The age-encrypted export bundle

`bothy config export --recipient <age1...>` (or `--passphrase`, with a **generated**
passphrase offered by default, because age's passphrase mode is only as strong as
the passphrase). The file is a single age-encrypted document, so **a lost KEK is
recoverable from the last bundle** and a bundle restores onto a **new box with a new
KEK** (values are re-wrapped on import).

- Format: age (X25519 or scrypt-passphrase recipients, and, in current releases,
  hybrid post-quantum recipients; per the age project page). Plaintext inside:
  ```json
  {"format":"bothy-config-export/1","exported_at":"...","bothy_version":"...",
   "modules":[{"module":"...","settings":{"k":"v"},"secrets":{"k":"value"}}]}
  ```
  No audit history by default (`--with-audit` includes it), never `run/` contents.
- The plaintext **never touches disk**: the CLI streams the service's export from the
  socket straight into the `age` process.
- Who may export: host CLI only (socket permission), audited with a count. This is a
  **bulk reveal for the person with host access**, which already has root-equivalent
  reach (section 12); it is not a web action and has no HTTP route. The "no reveal"
  decision (Q6 in `thin-bothy/risks-and-open-questions.md`, D11) concerns the
  browser surfaces and stands.
- Import: `bothy config import <file.age>` into an empty store (default) or
  `--merge`; unknown fields are rejected, schema validation applies, one transaction,
  one audit row. A **format** version bump is forward-only like the DB.
- The `age` binary is installed **checksum-pinned**, like the k3s installer in
  `install-and-bootstrap.md` s3, and runs on the host (the settings container keeps
  `cryptography` as its only dependency). Whether a maintained pure-Python age
  binding is acceptable instead is **unverified** and not needed.
- **Recommended practice:** the **recipient** form, with the private key kept off the
  box; then an automated export timer holds no decryption power.

## 12. Threat model

### 12.1 What it defends

| Threat | How |
|---|---|
| A copy of the DB, a backup tarball, a disk snapshot of the state dir | secrets are ciphertext; the KEK is elsewhere and random 256-bit (no passphrase to brute-force) |
| Secret in a log, a git commit, a `docker inspect`, a `helm get values` | never in env or values; files; CI fixtures grep for known canaries |
| A viewer or operator reading a secret through the web, CLI-over-API, token or MCP | no read verb exists on those surfaces; metadata only |
| A row copied to another key, module, or another store | AAD binds `store_id`, module and key |
| Tampered ciphertext or a swapped wrapped DEK | GCM tag failure; only that row fails |
| Edited or deleted audit history by a DB-only attacker | triggers plus an HMAC chain under a key they do not have |
| A bug that writes a secret into a plain row | the `fields` registry refuses it |
| An old backup replayed unnoticed | restore is explicit, audited and lists reverted secrets |

### 12.2 What it explicitly does **not** defend

| Not defended | Why |
|---|---|
| **Root on the host** (or a user who can read the key file and the DB) | the KEK is a file on the same disk, as is the projected plaintext. Same as `.env` today. Encryption at rest here protects **copies**, not the running box |
| **A compromised `bothy-settings` process** | it holds the KEK and DEKs in memory and can decrypt everything; it is the trust anchor |
| A compromised consumer container | it holds the secrets it was given (that is what projecting means) |
| A compromised host CLI, or an attacker running as the CLI's uid | can call the socket and export |
| A malicious or compromised **operator** account | cannot read secrets but can overwrite them (for example replace a client secret) and trigger apply steps |
| Memory, swap or core dumps of the service | not mitigated (no `mlock`; unverified benefit) |
| The `.env` fallback during transition | plaintext until #324 retires it; the effective protection is the **weakest** source in the precedence list |
| Plaintext projection files on a Compose host | on disk, `0600`; included in a full-disk image |
| A malicious or backdoored `cryptography` wheel or `age` binary | supply chain; mitigated only by exact pins and checksums |
| Loss of availability by deleting the key | a feature of fail-closed, not a defence: see failure modes |
| Rollback by replaying an old DB | detectable by audit and `version`, not prevented |

Stated in one line, as #316 requires: this is **at-rest protection for copies and
disclosure paths, with write-only semantics at the product edge; it is not a
defence against anyone who is root on the box.**

## 13. Concurrency, failure modes and the audit log

### 13.1 Concurrency

One service process is the only writer; the host CLI has an **offline mode** that
takes an exclusive `flock` on the state dir and refuses if the service is up (used
for restore and break-glass `admin reset`). k3s runs one replica with `Recreate`, so
two pods never overlap. Writes use `BEGIN IMMEDIATE`; the audit row is inserted in
the **same transaction** as the change (no change without an audit row, no audit row
for a change that rolled back). `PUT` carries `if_version`; mismatch returns `409`
with the current version, and the UI shows a diff. Projection after a write is
**idempotent and level-triggered** (write the whole current state of a service's
files, then run apply steps), so a crash between commit and projection is healed on
the next start by re-projecting. SQLite's single-writer lock plus WAL means readers
do not block the writer; `busy_timeout` covers the rare overlap.

### 13.2 Failure modes

| Failure | Behaviour | Recovery |
|---|---|---|
| **Key missing, DB present** | **fail closed**: exit non-zero with "master key not found at <path>; restore it from your copy, or from an export bundle with `bothy config import`. Do not generate a new one: that orphans N secrets". `bootstrap` **never** generates a key when a DB exists | restore key file; or restore from bundle onto a new store |
| **Key present, wrong** (`key_check` fails) | fail closed, names expected `key_id` and found `key_id` | find the retired key (section 8.2) |
| **Key lost, no bundle** | **non-secret settings are intact and readable** (plaintext rows); secret values are **unrecoverable by design**. Services whose passwords were baked into volumes (Postgres, Keycloak DB) keep working with the old password unknown to Bothy: reset roles (`ALTER ROLE`) and re-enter | runbook in `docs/guide/` (a #317 deliverable); this is why the bundle is recommended at install |
| **Corrupt DB** | `integrity_check` at start and after each backup; on failure the service refuses to start and does **not** auto-recreate (a silent empty store would be read by the renderer as "use defaults") | restore the last verified backup; the `-wal` file travels with the DB |
| **DB present but empty/new, key present** | creates a fresh store (first install on a reused key is allowed) with a loud audit row | n/a |
| **Downgrade** (older binary, newer `schema_version`) | refuse to start, do not touch the DB | run the newer binary, or restore the pre-migration copy |
| **Migration** | before any migration a backup-API copy `pre-migrate-<from>-<to>.db` is taken; migrations are forward-only, one transaction each | restore that copy |
| **Interrupted KEK rotation** | detected by mixed `kek_id`; both keys are in the file | `rotate-key --finish` or `--abort` |
| **Tampered row** | that row fails decrypt, surfaced as an error and `read-denied` audit entry; others continue | restore the row from backup/bundle |
| **Disk full / I/O error** | the transaction fails atomically; the API returns 5xx; no partial write | free space |
| **Two stores diverge** (DB restored but `run/` older) | re-projection on start | none needed |
| **Clock jumps** | `at` can go backwards; ordering is by `id` | none |
| **Module enabled, required field absent** | the module fails loudly at apply/start (#315 rule); never a silent default | set the field |

### 13.3 Audit log

Recorded: who (user, or `cli:<os user>`, or `system:<component>`), through which
surface, what action, module and key, **old and new for non-secrets**, the word
"changed" for secrets (never a value, a fingerprint included, to avoid giving an
oracle for guessing), a request id, and a chain MAC. It is append-only by trigger
and tamper-evident by MAC against a **DB-only** attacker; **root with the KEK can
recompute the chain**, so it is not evidence against the host owner. It is also
emitted as one JSON line per entry to the container's stdout so Loki holds an
independent copy where Loki exists. `read-denied` and `projection` actions are
logged, as are all socket calls. Retention: kept until an explicit
`audit prune --before` (audited itself); at a few writes per day the table is a few
hundred KiB per year (estimate, unverified).

## 14. Transition: precedence, bootstrap, first run

### 14.1 Precedence (from #316, with the empty-string edge made explicit)

`store > .env > default`. A key **present in the store, even empty**, wins; a key
deleted from the store falls back. When a module is **enabled** and a required field
resolves from none of the three, apply fails, naming the field. `just config-sources`
prints one row per key, **source only, never value**, and warns when the store and
`.env` disagree for a key (drift). The `.env` file and its defaults are not touched
by the merge of #317; the live box is unaffected until #318 and #324.

### 14.2 Bootstrap on a fresh install

In order (extends `install-and-bootstrap.md` s2 step 4):

1. Create the key directory `0700`; **if a DB exists and the key does not: stop**
   (13.2). Otherwise generate the KEK (`O_EXCL`, `0600`, fsync) and print its path
   and `key_id`, **not its value**.
2. Create the DB, `store_id`, store keys, `key_check`, schema, `fields` from the
   module schemas.
3. Generate every secret the stack reads (the five in `bootstrap-keys.sh` and the
   rest, with the existing per-key generators), writing straight into the store:
   they are **never written to `.env`** on a store install. Where `.env` still
   exists the store takes precedence (14.1).
4. Project (`run/` or Secrets) and render the non-secret env.
5. Generate the **one-time admin password** (below).
6. Print: the URL, the admin password **once**, the key path with the sentence
   "back this file up separately from your backups", and the export command.

### 14.3 First-run admin password (#319), as it constrains the store

- Generated by the CSPRNG (`secrets`), at least 24 characters, shown **once**
  (terminal, plus `$STATE_ROOT/bothy/initial-admin-password`, `0600`). That file is
  a plaintext secret **outside the store**, by necessity (a human must read it);
  it is deleted when rotation is seen, and is excluded from backups and export.
- Keycloak-backed installs (`sso` module): seeded as a **temporary** credential so
  `UPDATE_PASSWORD` forces a change; Keycloak holds the only verifier. The store
  keeps the Keycloak **master admin** password (a separate generated secret, per
  #319) and never the user's password.
- Built-in `login` installs (mini, per D5; **#319 is written for Keycloak and needs a
  mini variant**): the verifier is a salted memory-hard hash (scrypt from the
  stdlib; unverified that the parameters fit the 1 GiB budget) with a
  `must_change` flag. It is a **one-way hash in the login module's own table in the
  same DB**, not an encrypted secret, so it is not revealable even by the service.
- `bothy admin reset`: host CLI only. If the service is up it uses the socket; if
  the portal and oauth2-proxy are down it still works (they are not on this path);
  if the **settings service** is down it uses the offline mode (13.1). It issues a
  new temporary password the same way and writes an audit row.

## 15. Where this record differs from the issues

| Issue text | This record | Why |
|---|---|---|
| #317: internal services "read decrypted values over a unix socket or internal-network route" | only the **host CLI** reads, and the service **pushes** files/Secrets | fewer decrypt-capable parties; no pod-to-service auth to design (a TokenReview path would need a cluster-scoped right `security-model.md` s2.1 avoids) |
| #317: `GET` on a secret returns fingerprint | kept, but it is **keyed** and the audit never carries it | an unkeyed hash of a weak secret is an offline oracle |
| #317/#316: "the KEK is read from `BOTHY_MASTER_KEY_FILE`" | kept; format holds more than one key line | rotation and its failure recovery need two keys at once |
| `install-and-bootstrap.md` s2: "the settings master key (a Secret, never printed)" | **the host file is canonical**, a Secret is a projection; the id and path **are** printed | `review-findings.md`: a cluster Secret cannot be "excluded from backups"; the user must be able to find and copy the key |
| #317: "`bothy-config` isolates `ruamel.yaml`" (in #316's table) | the repo's `ruamel` use is in `apps/bothy-files/yamlpatch.py`; there is no `apps/bothy-config` | the precedent is real; the name in the table is not (verified by listing `apps/`) |
| #318/#315: secret list in `scripts/lib/secret-keys.sh` | the file is `scripts/lib/bootstrap-keys.sh` | verified in the repo |
| #316: "SECURITY.md gains a stub rule" | **not done in this PR**; SECURITY.md is the document later changes are held to and `doc-facts.sh` pins it | to be added with #317 together with the new routes and `router-gates.sh` |
| `security-model.md` s2.4 "mounted as files" | unchanged, but Compose files are **on disk**, not tmpfs | stated honestly in 9.1 |

## 16. What #317 and #318 must test (so no further design is needed)

1. Round trip; wrong key, tampered `ciphertext`, tampered `wrapped_dek`, swapped
   AAD (module, key, `store_id`) each fail, **and only that row**.
2. **Nonce uniqueness**: 100k encryptions under one KEK produce no repeated
   nonce, and a monkeypatched constant nonce is caught by a test hook.
3. KEK rotation keeps every value readable; interrupted at each step (crash
   injection) it resumes or aborts; old key alone and new key alone both behave.
4. Start with key absent and DB present: fail closed with the named message; with
   both absent: bootstrap creates both; with key present and DB absent: new store.
5. Downgrade refusal; migration leaves a `pre-migrate` copy.
6. Backup via the backup API during a write loop restores to a consistent DB;
   restoring with the wrong key lists the missing `key_id` and changes nothing.
7. **No route returns a secret**: for every GET (and PUT/POST responses) with a
   fixture holding a canary secret, grep responses, logs, audit, `helm get values`,
   Job specs, and `docker inspect` of every container for the canary.
8. The audit trigger refuses UPDATE and DELETE; the chain verifies; a flipped row
   fails verification.
9. `if_version` conflict returns 409; two simultaneous PUTs lose exactly one.
10. Export then import on an empty store with a different KEK reproduces every
    value; the bundle contains no `run/` content and is unreadable without the age
    identity; the CLI never writes the plaintext to disk.
11. With the store empty, `docker compose config` equals main's (#318 criterion).
12. The service image: runs non-root, read-only root FS, `cryptography` pinned exactly
    and the only dependency; the pinned SQLite supports `STRICT`.

## 17. Risks and open questions for the owner

| # | Question | My recommendation |
|---|---|---|
| Q1 | Default KEK location: root install `/etc/bothy/master.key`; user install `~/.config/bothy/master.key`. Acceptable? | yes |
| Q2 | Is an **export bundle taken at install, with the recipient key held off-box**, a required step or an advisory? | advisory with a persistent `just doctor` warning until one exists |
| Q3 | Should `config export` by the host CLI count as a permitted "reveal"? It is a bulk read for a person with host access | yes, CLI only, audited; D11 stays "no reveal" for browser surfaces |
| Q4 | k3s: accept the KEK existing twice (file and Secret), or require the admission policy first and block the k3s install until it lands? | require the policy first (9.2) |
| Q5 | KEK cryptoperiod default | 12 months, plus on exposure |
| Q6 | Compose `run/` on disk (boot-order simple) vs tmpfs (boot-order fragile)? | on disk now; revisit after the VM lab |
| Q7 | Mini `login` verifier lives in the same DB (14.3). Acceptable, or its own DB? | same DB, own table |
| Q8 | 4 GiB floor: confirm it is the Compose/k3s cut-over, and whether a host under it may also run `bothy-settings` (memory budget unmeasured) | yes; measure in the lab |

**Owner decisions (2026-11-16, delegated to the maintainer's assistant, to decide by the
purpose of #315: many people can install Bothy, with safe defaults and no step that blocks a
first install).** All eight recommendations above are adopted. Reasons that go beyond them:

- **Q2 advisory, not required:** a required off-box key at install blocks the first-minute
  experience the plan protects; the persistent `just doctor` warning keeps the risk visible
  until a bundle exists. Revisit if the first real incident shows nobody made one (risk 2).
- **Q4 policy before the k3s install:** the KEK in a cluster Secret is the one place this design is
  weaker than a host file, so the k3s path must not ship without the admission policy. Compose
  installs are unaffected.
- **Q6 on disk now:** boot-order simplicity beats the tmpfs benefit until the VM lab shows the
  ordering is safe.

**Checked after the draft (2026-11-16):** `cryptography` publishes wheels for manylinux and
musllinux on both x86_64 and aarch64 (PyPI, 50.0.2), so risk 1 is resolved for the wheel question
(import and runtime on the target are still to be exercised in the lab). The 2^32 random-IV limit
is corroborated by several secondary sources but **not read in NIST SP 800-38D itself**, which is
being revised; keep it marked unverified until the primary text is read.

**Riskiest assumptions** (what would change my mind):

1. `cryptography` wheels exist and run on every target (arm64 OCI, musl images). If
   not, the fallback is `AESGCM` through OpenSSL by another route, or a different
   language for this one service. **Wheels exist for all four targets (checked); runtime
   still to be exercised in the lab.**
2. Operators will keep the key somewhere other than next to the backups. If the
   first real incident shows nobody did, the design's defence turns into data loss;
   the mitigation is the export bundle being the default, not advice.
3. SQLite on the node's own filesystem (WSL2 ext4) is safe with WAL and
   `synchronous=FULL`. **Unverified on the Windows drive mounts**, so the state dir
   is required to be on ext4 and asserted at start.
4. The 2^32 random-nonce bound and a 1e-26 collision figure are used as stated;
   neither was extracted from SP 800-38D in this session.
5. That pushing projected files is enough: some image with neither `*_FILE` nor a
   shim-friendly entrypoint may force a secret into env. Then the rule has an
   exception that must be listed per image, with a CI-checked allowlist.

**Would change the decision:** a requirement for multiple users with different
secret scopes, dynamic or short-lived credentials, or an existing OpenBao/Vault in
the target environment (then D, behind the same interface); or a need to hide even
key names (then SQLCipher).

## References

Fetched and read in this session unless marked.

- SQLite, online backup API and `VACUUM INTO`: https://www.sqlite.org/backup.html
- SQLite, write-ahead logging (network filesystems, `-wal` file, `synchronous=NORMAL`, checkpoints): https://www.sqlite.org/wal.html
- `cryptography`, AEAD primitives (AESGCM, ChaCha20Poly1305, AES-GCM-SIV; no XChaCha20 listed): https://cryptography.io/en/latest/hazmat/primitives/aead/
- NIST SP 800-38D, GCM (landing page only; the PDF could not be text-extracted, so the 2^32 limit is **unverified here**): https://csrc.nist.gov/pubs/sp/800/38/d/final
- NIST SP 800-57 Part 1 Rev. 5 (landing page; no cryptoperiod figures verified): https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final
- SQLCipher design (page-level AES-256-CBC, HMAC-SHA512, PBKDF2, raw keys): https://www.zetetic.net/sqlcipher/design/
- age (format, recipients, passphrase, post-quantum recipients): https://github.com/FiloSottile/age ; spec https://age-encryption.org/v1 (spec itself **not read**)
- SOPS (overview only; its per-value encryption and MAC details **not verified**): https://github.com/getsops/sops
- OpenBao, seal/unseal (Shamir, auto-unseal, restart behaviour): https://openbao.org/docs/concepts/seal/
- Infisical self-hosting (compose template with PostgreSQL and Redis; memory sizes not verified): https://infisical.com/docs/self-hosting/overview
- Docker Compose secrets (file source mounted at `/run/secrets`, `_FILE` pattern, env-var caveats): https://docs.docker.com/compose/how-tos/use-secrets/
- Kubernetes Secrets (unencrypted in the datastore by default; mounting as files; tmpfs backing and refresh semantics from general knowledge, **unverified here**): https://kubernetes.io/docs/concepts/configuration/secret/
- k3s secrets encryption (`--secrets-encryption`, `rotate-keys`; default provider and key location not stated on the page): https://docs.k3s.io/cli/secrets-encrypt
- In-repo: `thin-bothy/security-model.md`, `thin-bothy/review-findings.md`, `thin-bothy/hybrid-runtime.md`, `thin-bothy/install-and-bootstrap.md`, `thin-bothy/risks-and-open-questions.md`, `control-and-settings.md` s6c, `scripts/lib/bootstrap-keys.sh`, `scripts/backup.sh`, SECURITY.md rules 3 and 5.

**Not verified at all** (consolidated): resident memory of `bothy-settings` and of
OpenBao/Infisical; arm64/musl availability of `cryptography` wheels and of SQLCipher
bindings; whether oauth2-proxy accepts file variants for all its secrets; Compose
`secrets:` tmpfs behaviour; Kubernetes Secret volume tmpfs and refresh details; the
SOPS rotation commands; WAL behaviour on WSL2 Windows-drive mounts; scrypt parameters
under the mini budget; library behaviour of AES key wrap with associated data;
SP 800-38D's exact invocation limit; any cryptoperiod figure from SP 800-57.
