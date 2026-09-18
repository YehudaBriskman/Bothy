#!/usr/bin/env python3
"""The credential and backup inventory - METADATA ONLY, computed on the host.

    python3 apps/bothy-ops/inventory.py            write the inventory
    python3 apps/bothy-ops/inventory.py --print    also print it (still no values)
    just admin-inventory                           the same, from the repo root

Settings shows every credential on the box - its name, what uses it, where it
lives, its file mode, when it last changed, how to rotate it - and every backup
set. bothy-ops serves that behind `operator` (GET /-/api/admin/credentials and
/-/api/admin/backups). It does NOT compute it, and that split is the design:

── why this runs on the host and not in bothy-ops ───────────────────────────

To list the keys in `.env`, a process has to read `.env` - every password on the
box. To size `~/backups`, it has to be able to open plaintext `.env` copies and
pg_dumpall output. bothy-ops is the process that can already stop databases and
scale cluster workloads; mounting those files into it would make one bug in it
cost every credential as well. So the host - where the owner's own shell already
holds all of it - reads them, keeps only names, modes, times and sizes, and
writes a JSON file bothy-ops mounts read-only. No secret byte ever enters a
container that did not already hold it.

── the one rule this file exists to keep ────────────────────────────────────

A VALUE NEVER LEAVES parse_env(). It is read to answer two questions - is it
set, and is it one of the public placeholders from .env.example - and is dropped
on the same line. Nothing in the output is derived from a value except those two
booleans; not a length, not a hash, not a prefix. checks/test_inventory.py feeds
a .env full of sentinel values and asserts no sentinel byte reaches the output.
bothy-ops' admin.py then re-filters every entry to an allow-list of keys, so a
future edit here that adds a field is dropped at the second lock rather than
served.

Standard library only; runs under the system python3, from a timer
(host/systemd/bothy-inventory.timer) or by hand.
"""

from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

VERSION = 1

# ── what counts as a credential ─────────────────────────────────────────────
#
# By NAME. Everything else in .env (BOX_IP, PUID, POSTGRES_USER...) is listed too,
# as configuration, because "which keys exist" is itself worth seeing - but it is
# not given a rotation row.
CREDENTIAL_NAME = re.compile(r"PASSWORD|SECRET|TOKEN|PASSPHRASE|PRIVATE_KEY|API_KEY")

# The placeholders .env.example ships. A credential still holding one is the
# single most useful warning this page can give, and saying so reveals nothing:
# these strings are in a public repository.
PLACEHOLDERS = frozenset({"changeme", "change-me", "changeme-generate-one", "admin",
                          "devpass", "password"})

_ENV_LINE = re.compile(r"(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)")


def parse_env(text: str) -> list[dict]:
    """Keys in a .env, with two booleans each. VALUES ARE DROPPED HERE.

    Mirrors how the box's own scripts read a value (scripts/keycloak-headlamp-
    client.sh env_value): strip a trailing ` # comment`, then whitespace, then one
    layer of matching quotes. A later duplicate of a key wins, as it does for
    compose.
    """
    seen: dict[str, dict] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _ENV_LINE.fullmatch(line)
        if not m:
            continue
        key = m.group(1)
        v = re.sub(r"\s+#.*$", "", m.group(2)).strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        is_set = v != ""
        placeholder = v.lower() in PLACEHOLDERS
        del v  # the value goes no further than this line
        seen[key] = {"key": key, "set": is_set,
                     "credential": bool(CREDENTIAL_NAME.search(key)),
                     "placeholder": placeholder if CREDENTIAL_NAME.search(key) else False}
    return list(seen.values())


# ── what each known key is for, and how it is rotated ───────────────────────
#
# Written out, because a rotation procedure is not derivable from a file. Where
# the box has no one-command rotation, the row SAYS so rather than inventing one.
KEY_META: dict[str, dict] = {
    "POSTGRES_PASSWORD": {
        "purpose": "The shared Postgres superuser (postgres, postgres-exporter, keycloak-db-init).",
        "rotate": "No recipe. ALTER ROLE in postgres and edit .env together, then `just up` to recreate what reads it.",
    },
    "DEV_LOGIN_PASSWORD": {
        "purpose": "The unified dev login: Grafana, VictoriaMetrics basic auth, the Keycloak master admin, the seeded realm user.",
        "rotate": "No recipe - each service keeps its own copy. Change it in Keycloak and Grafana, edit .env, then `just bootstrap --force` and `just bothy-prom-route`.",
    },
    "OAUTH2_COOKIE_SECRET": {
        "purpose": "Signs every Bothy session cookie. Anyone holding it can mint a session for any role.",
        "rotate": "Set a new value (`openssl rand -base64 32 | tr -- '+/' '-_'`) in .env, then `just up-auth`. Signs everybody out.",
    },
    "KEYCLOAK_DB_PASSWORD": {
        "purpose": "Keycloak's own database role.",
        "rotate": "Edit .env, then `just up-auth` - keycloak-db-init re-asserts it on every run.",
    },
    "KEYCLOAK_OAUTH2_CLIENT_SECRET": {
        "purpose": "The `oauth2-proxy` client in realm devbox - the forwardAuth behind every role gate.",
        "rotate": "No recipe: the realm import is first-boot only. Regenerate the secret on client oauth2-proxy in the Keycloak console, copy it to .env, then `just up-auth`.",
    },
    "HEADLAMP_OAUTH2_CLIENT_SECRET": {
        "purpose": "The `headlamp` client in realm devbox (oauth2-proxy-headlamp on :8110).",
        "rotate": "Blank it in .env, then `just up-headlamp` - it generates a new one and sets it in Keycloak.",
    },
    "HEADLAMP_OAUTH2_COOKIE_SECRET": {
        "purpose": "Signs the Headlamp proxy's session cookie.",
        "rotate": "Blank it in .env, then `just up-headlamp`.",
    },
    "GRAFANA_PASSWORD": {
        "purpose": "Grafana's admin password on FIRST boot. Grafana keeps its own copy afterwards.",
        "rotate": "`docker exec grafana grafana cli admin reset-admin-password <new>`, then edit .env to match.",
    },
    "GF_SMTP_PASSWORD": {
        "purpose": "Grafana's SMTP login, for alert email.",
        "rotate": "Edit .env, then `just up-monitoring`.",
    },
}

# Credential FILES, by repo-relative path. `mode` is what the file should be;
# the page flags a difference rather than assuming 600 is always right -
# prom-password.txt is 644 on purpose (VictoriaMetrics reads it as another uid).
FILES: list[dict] = [
    {"id": "env", "path": ".env", "mode": "600",
     "purpose": "Every credential key below. Read by compose at start and by the scripts.",
     "usedBy": ["compose (every stack)", "scripts/"],
     "rotate": "Holds the keys listed under .env keys; rotate those."},
    {"id": "kube-token", "path": "apps/bothy-ops/secrets/token", "mode": "600",
     "purpose": "bothy-ops' ServiceAccount token (bothy/bothy-kube): restart, scale, logs in two namespaces.",
     "usedBy": ["bothy-ops"], "rotate": "`just kube-token --rotate`"},
    {"id": "kube-ca", "path": "apps/bothy-ops/secrets/ca.crt", "mode": "600",
     "purpose": "The cluster CA bothy-ops pins. Not a secret, kept beside the token it verifies.",
     "usedBy": ["bothy-ops"], "rotate": "`just kube-token` rewrites it."},
    {"id": "keycloak-admin", "path": "apps/bothy-ops/secrets/keycloak-admin-client-secret", "mode": "600",
     "purpose": "Client `bothy-admin` (realm-management view-users only) - the Users & roles page.",
     "usedBy": ["bothy-ops"], "rotate": "`just admin-client --rotate`"},
    {"id": "headlamp-kubeconfig", "path": "apps/headlamp/secrets/kubeconfig", "mode": "600",
     "purpose": "Headlamp's read-only cluster identity (bothy/bothy-browse).",
     "usedBy": ["headlamp"], "rotate": "`just headlamp-token --rotate`"},
    {"id": "prom-route", "path": "edge/dynamic/bothy-prom.yml", "mode": "600",
     "purpose": "The basic-auth header Traefik injects on the portal's metrics queries.",
     "usedBy": ["traefik"], "rotate": "`just bothy-prom-route` (after changing DEV_LOGIN_*)."},
    {"id": "kube-prom-token", "path": "monitoring/kube-auth/token", "mode": "600",
     "purpose": "The bearer token VictoriaMetrics scrapes the cluster's kubelet with.",
     "usedBy": ["victoriametrics"], "rotate": "`just kube-prom-token`"},
    {"id": "prom-password", "path": "monitoring/prom-password.txt", "mode": "644",
     "purpose": "VictoriaMetrics' basic-auth password (644 on purpose: read by another uid).",
     "usedBy": ["victoriametrics"], "rotate": "`just bootstrap --force` regenerates it from the dev login."},
    {"id": "prom-web", "path": "monitoring/prometheus-web.yml", "mode": "644",
     "purpose": "A bcrypt hash of the dev login, for the legacy Prometheus web config.",
     "usedBy": ["prometheus (legacy)"], "rotate": "`just bootstrap --force`"},
]

# Keycloak clients with a secret, and where that secret lives on this box.
CLIENTS: list[dict] = [
    {"id": "oauth2-proxy", "secret": {"env": "KEYCLOAK_OAUTH2_CLIENT_SECRET"},
     "purpose": "forwardAuth for every role gate at the edge."},
    {"id": "headlamp", "secret": {"env": "HEADLAMP_OAUTH2_CLIENT_SECRET"},
     "purpose": "oauth2-proxy-headlamp, the login in front of Headlamp."},
    {"id": "bothy-admin", "secret": {"file": "apps/bothy-ops/secrets/keycloak-admin-client-secret"},
     "purpose": "bothy-ops reading users and their roles (view-users only)."},
]

# Where a key is referenced. Code and config, never docs or tests - "who reads
# this" is the question, and a README mentioning a key does not read it.
SCAN_SUFFIXES = (".yml", ".yaml", ".sh", ".py", ".toml")
SCAN_SKIP_DIRS = {".git", ".github", "node_modules", ".claude", "checks", "__pycache__", "dist",
                  "docs", ".venv", "venv", ".cleanup-trash", "backups"}


def _iso(ts: float | None) -> str | None:
    return None if ts is None else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def file_meta(path: str) -> dict:
    """present, mode, mtime and size of one path. Never opens it."""
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return {"present": False}
    except OSError as e:  # a directory we may not traverse
        return {"present": None, "error": type(e).__name__}
    return {"present": True, "mode": format(stat.S_IMODE(st.st_mode), "o"),
            "changed": _iso(st.st_mtime), "bytes": st.st_size}


def used_by(repo: str, keys: list[str]) -> dict[str, list[str]]:
    """Repo-relative files that reference each key, by word match."""
    if not keys:
        return {}
    pat = re.compile(r"\b(" + "|".join(re.escape(k) for k in sorted(keys, key=len, reverse=True)) + r")\b")
    hits: dict[str, set[str]] = {k: set() for k in keys}
    for dirpath, dirnames, filenames in os.walk(repo):
        dirnames[:] = [d for d in dirnames if d not in SCAN_SKIP_DIRS]
        for fn in filenames:
            if not (fn.endswith(SCAN_SUFFIXES) or fn == "justfile"):
                continue
            if fn.startswith(".env"):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, repo)
            if rel == "apps/bothy-ops/inventory.py":
                continue  # this file names every key it describes
            try:
                with open(full, encoding="utf-8", errors="replace") as fh:
                    text = fh.read(512_000)
            except OSError:
                continue
            for m in set(pat.findall(text)):
                hits[m].add(rel)
    return {k: sorted(v) for k, v in hits.items()}


def credentials(repo: str, env_path: str) -> dict:
    env_meta = file_meta(env_path)
    keys: list[dict] = []
    if env_meta.get("present"):
        try:
            with open(env_path, encoding="utf-8", errors="replace") as fh:
                keys = parse_env(fh.read())
        except OSError as e:
            env_meta = {**env_meta, "error": type(e).__name__}
    users = used_by(repo, [k["key"] for k in keys])
    env_rows = []
    for k in keys:
        meta = KEY_META.get(k["key"], {})
        env_rows.append({
            **k,
            "usedBy": users.get(k["key"], []),
            "purpose": meta.get("purpose"),
            "rotate": meta.get("rotate") if k["credential"] else None,
        })
    files = []
    for f in FILES:
        m = file_meta(os.path.join(repo, f["path"]))
        files.append({**f, "expectMode": f["mode"], **{k: v for k, v in m.items() if k != "mode"},
                      "actualMode": m.get("mode")})
    for f in files:
        f.pop("mode", None)
    by_key = {r["key"]: r for r in env_rows}
    clients = []
    for c in CLIENTS:
        row = {"id": c["id"], "purpose": c["purpose"], "realm": "devbox"}
        if "env" in c["secret"]:
            k = by_key.get(c["secret"]["env"])
            row.update({"where": f".env {c['secret']['env']}", "set": bool(k and k["set"]),
                        "changed": env_meta.get("changed"), "changedScope": "file"})
        else:
            m = file_meta(os.path.join(repo, c["secret"]["file"]))
            row.update({"where": c["secret"]["file"], "set": bool(m.get("present")),
                        "changed": m.get("changed"), "changedScope": "file"})
        clients.append(row)
    return {
        "env": {"path": ".env", **env_meta, "expectMode": "600", "keys": env_rows},
        "files": files,
        "clients": clients,
    }


BACKUP_KINDS = {
    "postgres": "pg_dumpall of every database, keycloak included (users and password hashes).",
    "grafana": "grafana.db - dashboards, users, alert state.",
    "env": "Copies of .env - every credential, in plaintext.",
}


def _timer(unit: str) -> dict:
    """Last and next run of a SYSTEM timer, or {} when systemd cannot say."""
    try:
        out = subprocess.run(
            ["systemctl", "show", unit, "-p", "LastTriggerUSec", "-p", "NextElapseUSecRealtime",
             "-p", "ActiveState"], capture_output=True, text=True, timeout=5, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    props = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    return {"unit": unit, "active": props.get("ActiveState"),
            "last": props.get("LastTriggerUSec") or None,
            "next": props.get("NextElapseUSecRealtime") or None}


def backups(root: str) -> dict:
    meta = file_meta(root)
    sets = []
    if meta.get("present") and os.path.isdir(root):
        try:
            names = sorted(os.listdir(root))
        except OSError:
            names = []
        for name in names:
            d = os.path.join(root, name)
            if not os.path.isdir(d) or os.path.islink(d):
                continue
            files = []
            try:
                for fn in os.listdir(d):
                    p = os.path.join(d, fn)
                    try:
                        st = os.lstat(p)
                    except OSError:
                        continue
                    if stat.S_ISREG(st.st_mode):
                        files.append((st.st_mtime, st.st_size, fn))
            except OSError:
                sets.append({"name": name, "readable": False, **file_meta(d)})
                continue
            files.sort(reverse=True)
            sets.append({
                "name": name,
                "managed": name in BACKUP_KINDS,
                "what": BACKUP_KINDS.get(name),
                "readable": True,
                "mode": file_meta(d).get("mode"),
                "count": len(files),
                "bytes": sum(f[1] for f in files),
                "newest": {"name": files[0][2], "at": _iso(files[0][0]), "bytes": files[0][1]} if files else None,
                "oldest": {"name": files[-1][2], "at": _iso(files[-1][0]), "bytes": files[-1][1]} if files else None,
            })
    return {"root": "~/" + os.path.relpath(root, os.path.expanduser("~"))
            if root.startswith(os.path.expanduser("~")) else root,
            **meta, "keep": 14, "command": "just backup",
            "timer": _timer("stacks-backup.timer"), "sets": sets}


def build(repo: str = REPO, env_path: str | None = None, backup_root: str | None = None) -> dict:
    env_path = env_path or os.path.join(repo, ".env")
    backup_root = backup_root or os.environ.get("BACKUP_ROOT") or os.path.expanduser("~/backups")
    return {"version": VERSION, "generatedAt": _iso(time.time()),
            "credentials": credentials(repo, env_path), "backups": backups(backup_root)}


def default_out() -> str:
    state = os.environ.get("STATE_ROOT") or os.path.expanduser("~/.local/state")
    return os.path.join(state, "bothy", "inventory", "inventory.json")


def write(doc: dict, out: str) -> None:
    """Atomically, mode 600 in a 700 directory: the names are not secrets, but
    the map of where every secret lives is not for other local users either."""
    d = os.path.dirname(out)
    os.makedirs(d, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".inventory.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=1, sort_keys=True)
        os.chmod(tmp, 0o600)
        os.replace(tmp, out)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def main(argv: list[str]) -> int:
    out = os.environ.get("INVENTORY_OUT") or default_out()
    doc = build()
    write(doc, out)
    if "--print" in argv:
        print(json.dumps(doc, indent=1, sort_keys=True))
    c = doc["credentials"]
    print(f"inventory: {len(c['env']['keys'])} .env keys, {len(c['files'])} credential files, "
          f"{len(doc['backups']['sets'])} backup sets -> {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
