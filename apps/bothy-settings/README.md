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

## Dependency

`cryptography`, pinned with hashes in `requirements.txt`. Recompile with
`uv pip compile requirements.in --generate-hashes -o requirements.txt`.
