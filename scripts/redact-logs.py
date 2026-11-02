#!/usr/bin/env python3
"""redact-logs.py <log dir> [<.env>] [<bootstrap-keys.sh>]

Remove every generated secret's VALUE from every file under <log dir>, then
prove none is left. Used by the install and upgrade workflows before a failure
artifact is uploaded: this repository is public, and an artifact is
downloadable by anyone.

Exit 0: redacted and verified. Anything else: the log dir has been EMPTIED and
holds only REFUSED.txt saying why (key names, never values).

WHY IT EMPTIES THE DIRECTORY. This logic used to live inline in install.yml,
and when it could not prove the redaction it printed "REFUSING to upload" and
exited 1 - inside a step running under `set +e` whose last command was an
echo. The step passed, the `if: failure()` upload ran, and the "refusal" was
decorative. The upload step cannot be relied on to read this script's exit
code, so the only refusal that holds is one that leaves nothing to upload.

Redacted by KEY NAME, from scripts/lib/bootstrap-keys.sh - the five values
bootstrap generates. A fourth hand-kept copy of that list is a fourth chance for
it to fall behind, and the way it would fail is a secret in a public artifact.
"""
import pathlib
import re
import shutil
import sys

MIN_KEYS = 5


def refuse(logdir: pathlib.Path, why: str) -> None:
    # Empty it first, explain second: if writing the note fails, the directory
    # is still empty.
    for p in list(logdir.iterdir()) if logdir.is_dir() else []:
        if p.is_dir() and not p.is_symlink():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)
    logdir.mkdir(parents=True, exist_ok=True)
    (logdir / "REFUSED.txt").write_text(
        f"Logs were collected and then deleted unread: {why}\n"
        "Reproduce locally with `just ci-install` to see them.\n",
        encoding="utf-8")
    sys.exit(f"REFUSING to upload, log directory emptied: {why}")


def read_keys(keyfile: pathlib.Path) -> list:
    text = keyfile.read_text(encoding="utf-8")
    # ANCHORED TO LINE START, multiline. Unanchored, this matched a COMMENT in
    # that file quoting the old one-line form, and returned 37 "keys" of prose.
    block = re.search(r'^SECRET_KEYS="([^"]*)"', text, re.M)
    keys = block.group(1).split() if block else []
    if len(keys) < MIN_KEYS or not all(re.fullmatch(r"[A-Z][A-Z0-9_]*", k) for k in keys):
        raise ValueError(f"could not read the secret key list (got {keys})")
    return keys


def read_env(envfile: pathlib.Path) -> dict:
    env = {}
    for line in envfile.read_text(encoding="utf-8", errors="replace").splitlines():
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def files(logdir: pathlib.Path):
    return [p for p in logdir.rglob("*") if p.is_file() and not p.is_symlink()]


def main(argv: list) -> int:
    if len(argv) < 2:
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        return 2
    logdir = pathlib.Path(argv[1])
    envfile = pathlib.Path(argv[2] if len(argv) > 2 else ".env")
    keyfile = pathlib.Path(argv[3] if len(argv) > 3 else "scripts/lib/bootstrap-keys.sh")

    try:
        keys = read_keys(keyfile)
        env = read_env(envfile)
    except (OSError, ValueError) as e:
        refuse(logdir, str(e))

    # Longest first: one secret can contain another, and replacing the short
    # one first leaves a fragment of the long one behind.
    secrets = sorted(((k, env[k]) for k in keys if env.get(k)), key=lambda kv: -len(kv[1]))
    if not secrets:
        # Nothing generated yet is legitimate (bootstrap failed early), but say
        # so - "redacted 0 files" reads like success either way.
        print("no generated secrets in", envfile, "- nothing to redact")

    n = 0
    for path in files(logdir):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            refuse(logdir, f"could not read {path.name}: {e}")
        out = text
        for k, v in secrets:
            out = out.replace(v, f"<{k} redacted>")
        if out != text:
            path.write_text(out, encoding="utf-8")
            n += 1
    print(f"redacted {n} file(s)")

    # PROVE IT. "The redaction ran" and "the secret is gone" are different
    # claims. Bytes, not text: a value split by an invalid UTF-8 sequence would
    # survive a decode-and-search.
    leaked = sorted({k for k, v in secrets for p in files(logdir)
                     if v.encode() in p.read_bytes()})
    if leaked:
        refuse(logdir, f"still present after redaction: {leaked}")
    print(f"verified: none of {len(secrets)} secret value(s) remain in {len(files(logdir))} file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
