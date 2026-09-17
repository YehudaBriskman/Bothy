#!/usr/bin/env python3
"""The credential inventory never carries a value.

Run: python3 checks/test_inventory.py

Builds a throwaway repo and a throwaway backup root, with a .env whose every
value is a SENTINEL - a string that cannot occur by accident - and asserts that
no sentinel, and no recognisable piece of one, reaches:

  1. inventory.build()'s document,
  2. the file inventory.write() puts on disk,
  3. the JSON bothy-ops' admin.credentials() / admin.backups() would serve from
     that file, including after a hostile generator adds a `value` field.

It also asserts what the inventory is FOR: keys are listed, `set` and
`placeholder` are right, file modes and presence are read, backup sets are sized.
"""
import json
import os
import stat
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
sys.path.insert(0, SVC)
sys.path.insert(0, os.path.join(os.path.dirname(SVC), "bothy-common"))

import inventory  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


SENT = "ZqX9SENTINELvalue"  # never a real value; searched for in every output
SENTINELS = {
    "POSTGRES_PASSWORD": f"{SENT}-pg-7c1f",
    "DEV_LOGIN_PASSWORD": f"'{SENT}-quoted-9a2b'",
    "OAUTH2_COOKIE_SECRET": f"{SENT}-cookie-44d0   # a trailing comment",
    "KEYCLOAK_OAUTH2_CLIENT_SECRET": f"\"{SENT}-kc-1234\"",
    "GF_SMTP_PASSWORD": "",
    "KEYCLOAK_DB_PASSWORD": "changeme",
    "BOX_IP": f"{SENT}-not-a-credential",
}
ENV = "# a comment line\n\n" + "\n".join(f"{k}={v}" for k, v in SENTINELS.items()) + \
    f"\nexport HEADLAMP_OAUTH2_CLIENT_SECRET={SENT}-exported\nnot a line at all {SENT}\n"


def pieces(s: str) -> list[str]:
    """The sentinel and every 8-character window of it: a leak of a PART of a
    value (a prefix, a suffix) is a leak."""
    return [s] + [s[i:i + 8] for i in range(len(s) - 7)]


def leaks(text: str) -> list[str]:
    return sorted({p for p in pieces(SENT) if p in text})


tmp = tempfile.mkdtemp(prefix="bothy-inventory-")
repo = os.path.join(tmp, "repo")
os.makedirs(os.path.join(repo, "apps/bothy-ops/secrets"))
os.makedirs(os.path.join(repo, "auth"))
with open(os.path.join(repo, ".env"), "w") as fh:
    fh.write(ENV)
os.chmod(os.path.join(repo, ".env"), 0o600)
with open(os.path.join(repo, "auth/compose.yml"), "w") as fh:
    fh.write("x: ${OAUTH2_COOKIE_SECRET}\ny: ${POSTGRES_PASSWORD:?}\n")
# A credential file whose CONTENT is a sentinel - the inventory must stat it, never read it.
tok = os.path.join(repo, "apps/bothy-ops/secrets/token")
with open(tok, "w") as fh:
    fh.write(f"{SENT}-token-bytes")
os.chmod(tok, 0o640)  # wrong on purpose: expected 600

bk = os.path.join(tmp, "backups")
os.makedirs(os.path.join(bk, "env"))
os.makedirs(os.path.join(bk, "postgres"))
for i, name in enumerate(("env-20260101-030000", "env-20260102-030000")):
    p = os.path.join(bk, "env", name)
    with open(p, "w") as fh:
        fh.write(ENV)  # a backup of .env - full of sentinels, must only be sized
    os.utime(p, (1_767_000_000 + i * 86400, 1_767_000_000 + i * 86400))

print("── parse_env: two booleans per key, nothing else ────────────────")
parsed = inventory.parse_env(ENV)
by = {k["key"]: k for k in parsed}
ok(set(by) == set(SENTINELS) | {"HEADLAMP_OAUTH2_CLIENT_SECRET"}, f"every key found, junk line ignored: {sorted(by)}")
ok(all(set(k) == {"key", "set", "credential", "placeholder"} for k in parsed), "each entry has exactly four fields")
ok(by["GF_SMTP_PASSWORD"]["set"] is False and by["POSTGRES_PASSWORD"]["set"] is True, "`set` is right")
ok(by["KEYCLOAK_DB_PASSWORD"]["placeholder"] is True and by["POSTGRES_PASSWORD"]["placeholder"] is False,
   "a public placeholder is flagged, a real value is not")
ok(by["BOX_IP"]["credential"] is False and by["BOX_IP"]["placeholder"] is False, "BOX_IP is configuration")
ok(not leaks(json.dumps(parsed)), "no sentinel piece in the parse result")

print()
print("── build(): the whole document ──────────────────────────────────")
doc = inventory.build(repo=repo, env_path=os.path.join(repo, ".env"), backup_root=bk)
text = json.dumps(doc)
ok(not leaks(text), f"no sentinel piece anywhere in the document (found: {leaks(text)[:3]})")
env = doc["credentials"]["env"]
ok(env["present"] is True and env["mode"] == "600", "the .env file's mode is read")
ok("auth/compose.yml" in {k["key"]: k for k in env["keys"]}["OAUTH2_COOKIE_SECRET"]["usedBy"],
   "usedBy finds the compose file that references a key")
files = {f["id"]: f for f in doc["credentials"]["files"]}
ok(files["kube-token"]["present"] is True and files["kube-token"]["actualMode"] == "640"
   and files["kube-token"]["expectMode"] == "600", "a credential file's actual and expected mode are both reported")
ok(files["headlamp-kubeconfig"]["present"] is False, "an absent file is reported absent, not skipped")
envset = {s["name"]: s for s in doc["backups"]["sets"]}["env"]
ok(envset["count"] == 2 and envset["bytes"] == 2 * len(ENV) and envset["newest"]["name"] == "env-20260102-030000",
   "backup sets are counted, sized and dated")

print()
print("── write(): the file on disk ────────────────────────────────────")
out = os.path.join(tmp, "state", "bothy", "inventory", "inventory.json")
inventory.write(doc, out)
ok(stat.S_IMODE(os.stat(out).st_mode) == 0o600, "written mode 600")
ok(stat.S_IMODE(os.stat(os.path.dirname(out)).st_mode) == 0o700, "in a 700 directory")
ok(not leaks(open(out).read()), "no sentinel piece in the file")

print()
print("── admin.py serves it, and drops what it was not told about ─────")
os.environ["INVENTORY_FILE"] = out
os.environ["ADMIN_AUDIT_LOG"] = os.path.join(tmp, "admin.log")
import admin  # noqa: E402

served = json.dumps({**admin.credentials(), **{"b": admin.backups()}})
ok(not leaks(served), "no sentinel piece in what bothy-ops serves")
# A hostile or careless generator: a value added to a key, a file, a backup set,
# and a nested object smuggled into an allowed field.
evil = json.loads(open(out).read())
evil["credentials"]["env"]["keys"][0]["value"] = f"{SENT}-evil-1"
evil["credentials"]["env"]["keys"][0]["purpose"] = {"value": f"{SENT}-evil-2"}
evil["credentials"]["files"][0]["content"] = f"{SENT}-evil-3"
evil["credentials"]["clients"][0]["secret"] = f"{SENT}-evil-4"
evil["backups"]["sets"][0]["newest"]["preview"] = f"{SENT}-evil-5"
evil["backups"]["sets"][0]["files"] = [f"{SENT}-evil-6"]
evil["backups"]["timer"]["env"] = f"{SENT}-evil-7"
with open(out, "w") as fh:
    json.dump(evil, fh)
served = json.dumps({"c": admin.credentials(), "b": admin.backups()})
ok(not leaks(served), f"fields outside the allow-list are dropped at the second lock (found: {leaks(served)[:2]})")
c = admin.credentials()
k0 = c["env"]["keys"][0]
ok("purpose" not in k0 or k0["purpose"] is None or isinstance(k0["purpose"], str),
   "a nested object in an allowed field is not passed through")
ok(c["env"].get("mode") == "600", "the .env mode survives the allow-list")

print()
if fails:
    print(f"FAILED: {len(fails)}")
    sys.exit(1)
print("inventory: all passed")
