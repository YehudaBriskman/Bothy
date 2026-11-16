# bothy-settings

The settings and secrets store, as a **library** - the first slice of #317. The
design is the decision record, [docs/plans/settings-store.md](../../docs/plans/settings-store.md);
this file only says what is here and how to run it.

There is no service, image, compose file or wiring yet. Nothing imports this.

## What it is

SQLite (WAL, `synchronous=FULL`, STRICT tables, forward-only migrations) holding
settings in the clear and secrets as AES-256-GCM envelopes: a random data key per
secret, wrapped by a master key read from a file **outside** the state directory.
Associated data binds each ciphertext to its store, module and key. Secrets are
write-only; the one internal decrypt path is `Store.reveal_for_projection`, which
the #318 renderer will call. Every change is an HMAC-chained audit row and one
JSON log line, written after the commit.

Public API: `bothy_settings.Store` (`open`, `put_secret`, `put_value`,
`generate_secret`, `get_meta`, `list_meta`, `delete`, `rotate_kek`,
`rotate_deks`, `backup`, `verify_audit`, `verify_encrypted_at_rest`, ...),
`bootstrap`, `restore`, and `export.age_encrypt`.

## Refuses, by name

No key, wrong key, key file not 0600 or not ours, tampered ciphertext, tampered
wrapped key, a truncated or corrupt database, a database from a newer version,
a state directory on a network or Windows-drive mount, SQLite older than 3.37.

## Run the checks

    just settings-check          # builds .venv with uv on first run

Each test makes its own temp directory and **generated** key. Nothing reads
`~/stacks/.env` or any real credential.

## Deferred (documented in the code as `TODO(#317 follow-up)`)

The decrypt half of the age bundle, `age -p` passphrase mode, installing `age`
checksum-pinned on the host, and `--with-audit`.

## Not yet implemented vs docs/plans/settings-store.md

This slice is the library only. Nothing below is hidden by a green run; each item is
either out of this slice's scope or a recorded deviation, and none is implemented here.

- **No service, HTTP, CLI or wiring** (record s5 route table, s9, s14). There is no
  `bothy config` command and no `if_version` over HTTP (record s16.9: "409, two
  simultaneous PUTs lose exactly one" is tested only at the library level, as a
  `VersionConflict`).
- **Record s16.7, no route returns a secret**: there are no routes. The library-level
  half (no value in logs, errors, audit rows or files) is `checks/test_leaks.py`;
  the `helm get values` / `docker inspect` half waits for #318.
- **Record s16.11 and s16.12** (compose config equals main's; the service image is
  non-root, read-only root FS): no image and no compose change exist yet.
- **Record s16.2**: the "100k nonces, no repeat" test was replaced by a test of the
  guard itself (a repeated nonce from a patched source is refused). Chance collisions
  are argued in s6.3, not measured.
- **Record s11, the age bundle**: encrypt only, through an external `age` binary. The
  real-age round trip is SKIPPED when no `age` is on PATH, and the harness says so. The
  decrypt side, `age -p`, checksum-pinned installation and `--with-audit` are deferred
  (`TODO(#317 follow-up)` in `bothy_settings/export.py`).
- **Record s13.3, the audit log line**: the library emits JSON lines on logger
  `bothy.settings.audit` and installs a stdout handler when nothing is configured
  (`configure_audit_logging()` is for the entrypoint). That the container's stdout
  reaches Loki is not tested here, because there is no container.
- **Record s13.3, tamper evidence has limits the record states**: the audit chain and its
  authenticated head catch edits, middle deletions, tail deletions and an emptied table by
  anyone WITHOUT the KEK. Whoever holds the KEK can recompute both. Anchoring the head
  outside the database (a log line is the only copy) is not implemented.
- **Mutation coverage is partial.** `scripts/checks/mutants.sh` plants a regression for
  each hardening below, but not for every individual test; a row says a class of
  mistake is caught, not that every line is.
- **Not verified on this box**: behaviour on a network or Windows-drive mount beyond the
  refusal itself, and SQLite older than 3.37 (refused, never run).

## Dependency

`cryptography`, pinned with hashes in `requirements.txt`. Recompile with
`uv pip compile requirements.in --generate-hashes -o requirements.txt`.
