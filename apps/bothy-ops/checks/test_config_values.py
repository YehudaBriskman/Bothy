#!/usr/bin/env python3
"""One allowlisted compose value: the decisions, as units.

Run: python3 checks/test_config_values.py

No docker and no network: the same throwaway git repository and catalog shape
test_groups.py uses, with `docker inspect` and `docker compose config --hash`
replaced by tables. What it pins down:

  THE CATALOG   every refusal in updates.load_catalog's config half - a name that
                reads as a credential, a locked file, a class outside
                CONFIG_CLASSES, a key that ALSO matches a [config_reasons]
                category (a row cannot both offer an Edit button and explain why
                it has none), a reasons table with no catch-all or with it not
                last, a keys table with no reasons beside it, and a pattern that
                would accept an empty, blank, multi-line, over-long or
                twelve-digit value
  THE REAL ONE  the SHIPPED updates.toml: the measurement in its header is true,
                every allowlisted pattern ACCEPTS THE VALUE THAT IS LIVE in this
                repository, and the one pattern's whitelist is exactly the set
                scripts/checks/dashboards.sh enforces for the same line
  THE LOCATOR   composeenv over a real file: one line changes, every comment
                survives byte-identical, a no-op is byte-identical, and each
                refusal - a quoted scalar, a folded scalar, an empty value, a
                `${...}` pointer into .env, a list-shaped environment block, a
                key that is not there, two environment blocks
  THE SPLICE    the four assertions, each shown refusing: a value that would
                change the line's shape, a newline, a value that moved another
                key, and a write onto a line that no longer reads what was read
  THE PLAN      the id is a hash of what the HOST read - file, service, key, the
                live value, the line, the container, the running image, HEAD - and
                NOT of the requested value; the git gate; a dirty file; a stopped
                container; and the live-value rule, which refuses the PLAN rather
                than drawing an Edit button no value could satisfy
  THE ROWS      every environment key of the component appears, a locked one with
                its category sentence and NO VALUE, an editable one with its
                pattern and its plan id
  THE SPOOL     `kind: "config"` with exact keys; a value that fails the pattern
                refused on the HOST out of the HOST's catalog; the night job's
                actor; a note; a typed confirmation; a stale plan id
  NO RESTORE    there is no code path from a config job to a data restore, and
                that is asserted on the source rather than hoped for
"""
import os
import re
import subprocess
import sys
import tempfile
import tomllib

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
REPO_ROOT = os.path.dirname(os.path.dirname(SVC))
sys.path.insert(0, SVC)
os.environ.setdefault("ADMIN_AUDIT_LOG", os.devnull)

import updates  # noqa: E402
import updater  # noqa: E402,F401
from updater import composeenv, configvalue, executor, hostio, plans, record, spool  # noqa: E402
from updater.config import Config  # noqa: E402

fails: list[str] = []


def ok(cond: bool, label: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        fails.append(label)


def refused(fn, needle: str, label: str, exc=plans.PlanRefused) -> None:
    try:
        fn()
    except exc as e:
        ok(needle.lower() in str(e).lower(), f"{label}  ({str(e)[:150]})")
        return
    ok(False, f"{label}  (it was ALLOWED)")


# ══ 1. the catalog's config half ══════════════════════════════════════════════

BASE = """
[policy]
window_start = "03:30"
window_end = "05:00"
require_backup = "stacks-backup.service"
require_doctor = true
max_auto_per_night = 1
pause_on_failure = true
discover_every_hours = 6

[components.web]
title = "Web"
class = "stateless"
source = "image"
pins = ["compose.yml:web", "compose.yml:side"]
apply = "just up-web"
dependants = []
changelog = "https://example.invalid/web/v{version}"
channel = "auto"
one_way = false
verify = ["body says web"]

[components.o2p]
title = "oauth2-proxy"
class = "boundary"
source = "image"
pins = ["compose.yml:o2p"]
apply = "just up-web"
dependants = []
changelog = "https://example.invalid/o2p/v{version}"
channel = "manual"
one_way = false
verify = ["viewer 202"]

[components.acl]
title = "socket proxies"
class = "stateless"
source = "image"
pins = ["apps/bothy/compose.socket-proxy.yml:socket-write"]
apply = "just up-apps"
dependants = []
changelog = "https://example.invalid/acl/v{version}"
channel = "manual"
one_way = false
verify = ["grants"]
"""

REASONS = """
[config_reasons.address]
label = "An address"
keys = ["PORT"]
meaning = "Where something else is, inside the image."

[config_reasons.rest]
label = "Not measured"
keys = []
files = []
meaning = "Nobody has measured what a wrong value here would do, so it is not offered."
"""

GOOD_KEY = """
[config_keys.web.MODE]
service = "web"
pattern = "fast|slow"
meaning = "How hard the web service tries, which nothing else depends on."

[config_keys.web.LEVEL]
service = "web"
pattern = "[1-9]"
meaning = "How much the web service logs, from 1 to 9, and nothing more."
"""


def load(extra_keys: str = GOOD_KEY, reasons: str = REASONS, base: str = BASE) -> updates.Catalog:
    return updates.load_catalog(tomllib.loads(base + reasons + extra_keys))


print("── THE CATALOG: what [config_keys] may never say ─────────────────")
cat = load()
ok(sorted(cat.config_keys) == ["web.LEVEL", "web.MODE"], f"two keys load: {sorted(cat.config_keys)}")
ck = cat.config_keys["web.MODE"]
ok(ck.file == "compose.yml" and ck.service == "web",
   "the FILE is derived from the pin that declares the service, never written in the catalog")
ok([r.name for r in cat.config_reasons] == ["address", "rest"], "the categories keep their declared order")
ok(cat.config_reason("PORT", "compose.yml").name == "address"
   and cat.config_reason("WHATEVER", "compose.yml").name == "rest",
   "the first category that matches wins, and the catch-all answers for everything else")

for bad, needle, label in [
    ('[config_keys.web.API_TOKEN]\nservice = "web"\npattern = "a|b"\nmeaning = "twenty characters of it"\n',
     "reads as a credential", "a key whose NAME reads as a credential"),
    ('[config_keys.web.MY_KEY]\nservice = "web"\npattern = "a|b"\nmeaning = "twenty characters of it"\n',
     "reads as a credential", "…including one that merely ends in _KEY"),
    ('[config_keys.o2p.MODE]\nservice = "o2p"\npattern = "a|b"\nmeaning = "twenty characters of it"\n',
     "may not have an editable config value", "a key on the AUTH BOUNDARY's class"),
    ('[config_keys.acl.POST]\nservice = "socket-write"\npattern = "0|1"\nmeaning = "twenty characters of it"\n',
     "permanently locked", "a key in the socket-proxy file, whatever its component or pattern"),
    ('[config_keys.web.PORT]\nservice = "web"\npattern = "80|8080"\nmeaning = "twenty characters of it"\n',
     "states why it cannot be edited", "a key that ALSO matches a [config_reasons] category"),
    ('[config_keys.web.MODE]\nservice = "nope"\npattern = "a|b"\nmeaning = "twenty characters of it"\n',
     "is not one of web's pinned services", "a service the component does not pin"),
    ('[config_keys.nobody.MODE]\nservice = "web"\npattern = "a|b"\nmeaning = "twenty characters of it"\n',
     "is not a component", "a component that is not in the catalog"),
    ('[config_keys.web.MODE]\nservice = "web"\npattern = "a|b"\n',
     "needs exactly", "a key missing `meaning` - there are no defaults here"),
    ('[config_keys.web.MODE]\nservice = "web"\npattern = "a|b"\nmeaning = "short"\n',
     "must say, in a sentence", "a `meaning` too short to be a sentence"),
    ('[config_keys.web.MODE]\nservice = "web"\npattern = "[0-9]+"\nmeaning = "twenty characters of it"\n',
     "twelve-digit number", "an UNBOUNDED numeric pattern - the order-of-magnitude rule, generically"),
    ('[config_keys.web.MODE]\nservice = "web"\npattern = ".*"\nmeaning = "twenty characters of it"\n',
     "empty value", "a pattern that accepts anything at all"),
    # Long but NOT blank or empty, so it is the length bound that catches it and
    # not one of the other three: written as `.{1,70}` first, which the blank
    # trap caught, and a label that says "over-long" over a blank refusal is the
    # decorative-check failure mutants.sh exists for.
    ('[config_keys.web.MODE]\nservice = "web"\npattern = "x{1,70}"\nmeaning = "twenty characters of it"\n',
     "over 64 characters", "a pattern that accepts an over-long value"),
    ('[config_keys.web.MODE]\nservice = "web"\npattern = "(?s)a\\nb|fast"\nmeaning = "twenty characters of it"\n',
     "multi-line", "a pattern that accepts a newline"),
    ('[config_keys.web.MODE]\nservice = "web"\npattern = "fast|[\\\\s]"\nmeaning = "twenty characters of it"\n',
     "blank value", "a pattern that accepts a blank value"),
    ('[config_keys.web.MODE]\nservice = "web"\npattern = "fast|("\nmeaning = "twenty characters of it"\n',
     "does not compile", "a pattern that is not a regex"),
]:
    refused(lambda b=bad: load(b), needle, label, exc=updates.CatalogError)

ADDR = '[config_reasons.addr]\nlabel = "Addr"\nkeys = ["PORT"]\nmeaning = "where something else is, at length"\n'
CATCH = ('[config_reasons.rest]\nlabel = "Rest"\nkeys = []\nfiles = []\n'
         'meaning = "nobody measured this one, at length"\n')
refused(lambda: load(reasons=ADDR),
        "exactly one catch-all", "a reasons table with NO catch-all - a key could resolve to no sentence",
        exc=updates.CatalogError)
refused(lambda: load(reasons=CATCH + "\n" + ADDR),
        "must be declared", "the catch-all declared FIRST - it would answer for every named category",
        exc=updates.CatalogError)
refused(lambda: load(reasons=ADDR.replace('label = "Addr"', 'label = "A"') + CATCH),
        "3 to 40 characters", "a label too short to be a column heading", exc=updates.CatalogError)
refused(lambda: load(reasons=ADDR.replace('meaning = "where something else is, at length"',
                                          'meaning = "short"') + CATCH),
        "must say, in a sentence", "a reason with no sentence - the complaint this table answers",
        exc=updates.CatalogError)
refused(lambda: load(reasons=""), "come together",
        "[config_keys] with no [config_reasons] beside it - every locked row would have no sentence",
        exc=updates.CatalogError)
refused(lambda: load(extra_keys=""), "come together",
        "…and [config_reasons] with no [config_keys] is a table nothing consults",
        exc=updates.CatalogError)
ok(load(extra_keys="", reasons="").config_keys == {},
   "a catalog declaring NEITHER table is legal, and has no editable value")

print()
print("── THE SHIPPED CATALOG: the measurement, and the live value ──────")
real = updates.load(os.path.join(SVC, "updates.toml"))
ok(len(real.config_keys) >= 1, f"the shipped catalog allowlists {len(real.config_keys)} key(s)")
# The two hard-won rules of catalog.toml's [configmap_keys], over what SHIPS.
live_cfg = Config(repo=REPO_ROOT, catalog=os.path.join(SVC, "updates.toml"))
for cid, k in sorted(real.config_keys.items()):
    text = open(os.path.join(REPO_ROOT, k.file), encoding="utf-8").read()
    site = composeenv.locate(text, k.service, k.key, k.file)
    ok(not configvalue.value_ok(k, site.value),
       f"{cid}: the pattern ACCEPTS the value that is live ({site.value}) - a pattern that refuses it "
       "draws an Edit button on a row no value can satisfy")
    accepted = [v for v in ("", " ", "\n", "x" * 65, "1" * 12) if re.fullmatch(k.pattern, v)]
    ok(not accepted, f"{cid}: the pattern is bounded - it accepts none of {accepted or 'the generic traps'}")
# The measurement in updates.toml's own header, re-counted here, so the number in
# the comment cannot quietly stop being true.
total = 0
for root, _dirs, files in os.walk(REPO_ROOT):
    # RELATIVE to the repo root. This check also runs inside a git WORKTREE,
    # whose own path contains `.claude`, so an absolute-path skip matched every
    # directory and counted zero environment names - a measurement that agreed
    # with nothing and failed loudly, which is the direction to be wrong in.
    rel = os.path.relpath(root, REPO_ROOT)
    if rel.startswith((".git", ".claude")) or "node_modules" in rel:
        continue
    for fn in files:
        if re.fullmatch(r"compose(\.[a-z-]+)?\.yml", fn):
            total += len(composeenv._env_map(open(os.path.join(root, fn), encoding="utf-8").read()))
head = open(os.path.join(SVC, "updates.toml"), encoding="utf-8").read()
ok(f"declare {total} environment names" in head,
   f"[config_keys]'s header states the real count of environment names ({total})")

# The coupling that would otherwise drift silently: this pattern's whitelist and
# the set scripts/checks/dashboards.sh enforces for the SAME line. A pattern that
# allowed an upstream import would offer a value the build then rejects; one that
# allowed a missing file would put Grafana back on its stock Home page, which
# looks identical to the fault that line was added to fix.
gf = real.config_keys.get("grafana.GF_USERS_DEFAULT_HOME_DASHBOARD_PATH")
if gf is None:
    ok(True, "(the Grafana landing page is no longer allowlisted - this coupling does not apply)")
else:
    dash = open(os.path.join(REPO_ROOT, "scripts/checks/dashboards.sh"), encoding="utf-8").read()
    block = dash.split("HAND_WRITTEN = {", 1)[1].split("}", 1)[0]
    hand = set(re.findall(r'"([^"]+\.json)"', block))
    present = {f for f in os.listdir(os.path.join(REPO_ROOT, "monitoring/dashboards")) if f.endswith(".json")}
    allowed = {f for f in present | hand
               if re.fullmatch(gf.pattern, f"/var/lib/grafana/dashboards/{f}")}
    ok(allowed == hand & present,
       f"the landing-page pattern offers exactly dashboards.sh's HAND_WRITTEN files that exist: "
       f"{sorted(allowed)} vs {sorted(hand & present)}")
    ok(len(allowed) >= 2,
       f"…and more than one, so the row is a CHOICE rather than an Edit button with one option "
       f"({sorted(allowed)})")

# ══ 2. the locator and the splice, over a real file ══════════════════════════

print()
print("── THE LOCATOR: one line, and every comment byte-identical ───────")
FIXTURE = """name: t
services:

  # A comment that must survive every write below.
  web:
    image: example.invalid/web:1.0.0
    container_name: t-web
    environment:
      # Why MODE is what it is, which is the most valuable line in this block.
      MODE: fast
      LEVEL: 3            # a trailing comment, in a hand-aligned column
      QUOTED: "yes"
      FROM_ENV: ${WEB_HOST:-fallback}
      EMPTY:
      PORT: 8080
    labels:
      - dev.portal.project=T

  side:
    image: example.invalid/side:2.0.0
    container_name: t-side
    environment:
      MODE: fast
"""

site = composeenv.locate(FIXTURE, "web", "MODE", "compose.yml")
ok(site.value == "fast" and site.line == 10, f"MODE located at line {site.line} reading {site.value!r}")
out = composeenv.splice(FIXTURE, site, "slow")
before, after = FIXTURE.splitlines(), out.splitlines()
ok(sum(1 for a, b in zip(before, after) if a != b) == 1 and len(before) == len(after),
   "exactly one line differs, and the line count is unchanged")
ok(all(a == b for a, b in zip(before, after) if a.lstrip().startswith("#")),
   "every comment line is byte-identical - the guarantee stated directly")
ok(composeenv.locate(out, "side", "MODE", "compose.yml").value == "fast",
   "the OTHER service's MODE did not move - two keys with one name, and the right one changed")
ok(composeenv.splice(FIXTURE, site, "fast") == FIXTURE,
   "a no-op changes NO BYTES, which is what byte-identity means here")
lvl = composeenv.locate(FIXTURE, "web", "LEVEL", "compose.yml")
ok(lvl.value == "3", "a value with a trailing comment is located as the value alone")
ok("# a trailing comment, in a hand-aligned column" in composeenv.splice(FIXTURE, lvl, "7"),
   "…and the trailing comment and its hand-alignment survive the write")

for svc, key, needle, label in [
    ("web", "QUOTED", "quotes the value", "a quoted scalar - its source is longer than its value"),
    ("web", "FROM_ENV", "points at `.env`", "a `${...}` pointer into .env - where every secret in these files is"),
    ("web", "EMPTY", "sets it to nothing", "an empty value - 'unset' is a different state"),
    ("web", "ABSENT", "found 0 lines", "a key that is not written down - this writes values, it does not add them"),
    ("ghost", "MODE", "0 `environment:` blocks", "a service that is not there"),
]:
    refused(lambda s=svc, k=key: composeenv.locate(FIXTURE, s, k, "compose.yml"), needle, label,
            exc=composeenv.Refused)

FOLDED = FIXTURE.replace("      MODE: fast\n", "      MODE: >-\n        fast\n", 1)
refused(lambda: composeenv.locate(FOLDED, "web", "MODE", "compose.yml"),
        "folded, block, anchor or tag", "a folded scalar, whose value is not on this line at all",
        exc=composeenv.Refused)
LIST = FIXTURE.replace("    environment:\n      # Why MODE", "    environment:\n      - MODE=fast\n      # Why MODE", 1)
refused(lambda: composeenv.locate(LIST, "web", "MODE", "compose.yml"),
        "list of `key=value`", "a list-shaped environment block - a shape nothing here writes",
        exc=composeenv.Refused)
TWICE = FIXTURE.replace("    labels:\n      - dev.portal.project=T\n",
                        "    environment:\n      MODE: fast\n", 1)
refused(lambda: composeenv.locate(TWICE, "web", "MODE", "compose.yml"),
        "2 `environment:` blocks", "two environment blocks - 'which one did you mean' has no answer",
        exc=composeenv.Refused)

print()
print("── THE SPLICE: each of the four assertions, refusing ─────────────")
for value, needle, label in [
    ("sl ow", "space", "a value with a space in it"),
    ("sl\now", "newline", "a value carrying a newline, which would split the line in two"),
    ('"slow"', "quote", "a value that quotes itself"),
    ("slow # and", "`#`", "a value that opens a comment"),
    ("", "empty", "an empty value"),
    (" slow", "leading or trailing space", "a value padded with space"),
]:
    refused(lambda v=value: composeenv.splice(FIXTURE, site, v), needle, label, exc=composeenv.Refused)

# ══ 3. the plan, the rows, the spool ═════════════════════════════════════════

print()
print("── THE PLAN: a hash of what the HOST read ────────────────────────")
TMP = tempfile.mkdtemp(prefix="bothy-config-unit-")
ORIGIN, RP = os.path.join(TMP, "origin.git"), os.path.join(TMP, "repo")
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]


def git(*args: str) -> str:
    return subprocess.run([*GIT, *args], cwd=RP, check=True, capture_output=True, text=True).stdout.strip()


subprocess.run(["git", "init", "-q", "--bare", "-b", "main", ORIGIN], check=True)
subprocess.run(["git", "clone", "-q", ORIGIN, RP], check=True, capture_output=True)
git("checkout", "-q", "-b", "main")
with open(os.path.join(RP, "other.yml"), "w") as fh:
    fh.write("name: o\nservices:\n  acl:\n    image: example.invalid/acl:1.0.0\n"
             "    container_name: t-acl\n")
with open(os.path.join(RP, "compose.yml"), "w") as fh:
    fh.write(FIXTURE + "  o2p:\n    image: example.invalid/o2p:7.0.0\n    container_name: t-o2p\n")
with open(os.path.join(RP, "updates.toml"), "w") as fh:
    fh.write(BASE.replace('pins = ["apps/bothy/compose.socket-proxy.yml:socket-write"]',
                          'pins = ["other.yml:acl"]') + REASONS + GOOD_KEY)
git("add", ".")
git("commit", "-q", "-m", "pins")
git("push", "-q", "origin", "main")

cfg = Config(repo=RP, catalog=os.path.join(RP, "updates.toml"), state=os.path.join(TMP, "state"),
             backups=os.path.join(TMP, "backups"), textfile=os.path.join(TMP, "textfile"))
os.makedirs(cfg.spool, mode=0o700)
tcat = updates.load(cfg.catalog)
A = {"version": 1, "generatedAt": "2026-10-11T10:00:00Z", "components": {}}

RUNNING = {
    "t-web": ("example.invalid/web:1.0.0", "sha256:" + "1" * 64),
    "t-side": ("example.invalid/side:2.0.0", "sha256:" + "2" * 64),
    "t-o2p": ("example.invalid/o2p:7.0.0", "sha256:" + "6" * 64),
}
DIFFERS: set[str] = set()


def fake_container(name):
    if name not in RUNNING:
        return None
    img, iid = RUNNING[name]
    return {"name": name, "image": img, "imageId": iid, "state": "running", "health": "healthy",
            "labels": {"com.docker.compose.project": "t",
                       "com.docker.compose.service": name[len("t-"):]}}


def fake_project(repo, name, pin_file, pin_service):
    if name not in RUNNING:
        raise hostio.HostError(f"{name} is not running")
    want = {s: f"want-{s}" for s in ("web", "side", "o2p")}
    have = {s: (f"old-{s}" if s in DIFFERS else f"want-{s}") for s in want}
    return {"project": "t", "files": [os.path.join(repo, "compose.yml")], "wd": repo,
            "want": want, "have": have}


hostio.container = fake_container
hostio.compose_project = fake_project

p = configvalue.plan("web", "MODE", cfg=cfg, catalog=tcat, available=A)
ok(p["kind"] == "config" and re.fullmatch(r"[a-f0-9]{24}", p["id"]),
   f"a plan of kind config with a 24-hex id: {p['id']}")
ok(p["from"] == {"value": "fast", "line": 10, "text": "      MODE: fast"},
   f"it records the value that is LIVE, its line and the whole line: {p['from']}")
ok(p["confirm"] == "click" and p["oneWay"] is False,
   "ONE CLICK: the level follows reversibility, and the host puts the value back by itself")
ok(p["pattern"] == "fast|slow" and p["image"] == "example.invalid/web:1.0.0",
   "the pattern and the RUNNING IMAGE are in the plan - an image that moves makes it stale")
ok("AUTOMATIC, and it is the host's" in p["revert"] and "No data is restored" in p["revert"],
   "the revert words say whose it is and that no data is restored")
ok(p["pinnedIn"] == ["o2p", "web"],
   f"it names every component pinned in the file - the cost a successful change leaves "
   f"behind, stated BEFORE the button: {p['pinnedIn']}")

base = configvalue.plan("web", "MODE", cfg=cfg, catalog=tcat, available=A)["id"]
ok(base == p["id"], "two reads of an unchanged box compute the SAME id")
RUNNING["t-web"] = ("example.invalid/web:1.0.1", "sha256:" + "3" * 64)
ok(configvalue.plan("web", "MODE", cfg=cfg, catalog=tcat, available=A)["id"] != base,
   "a container that moved to another image makes the plan STALE - the id covers what runs")
RUNNING["t-web"] = ("example.invalid/web:1.0.0", "sha256:" + "1" * 64)
ok(configvalue.plan("web", "LEVEL", cfg=cfg, catalog=tcat, available=A)["id"] != base,
   "another key on the same service is another plan")

refused(lambda: configvalue.plan("web", "PORT", cfg=cfg, catalog=tcat, available=A),
        "not an editable config value", "a key that is in the file and NOT on the list")
refused(lambda: configvalue.plan("o2p", "MODE", cfg=cfg, catalog=tcat, available=A),
        "not an editable config value", "a key on a component with no entry at all")
# THE SCOPE RULE, UNCHANGED. ConfigExecution._scope() is one call into
# executor.compose_scope with `mine` narrowed to the one service, so that is what
# is exercised here - with the same arguments, rather than through a Recorder and
# a job this check would otherwise have to stand up.
DIFFERS.add("side")
refused(lambda: executor.compose_scope(cfg, p["container"], p["file"], p["service"],
                                       {p["service"]}, tcat.components["web"].apply),
        "would also recreate",
        "the SCOPE rule, unchanged: another service of the project with a pending change refuses it, so "
        "a one-value change can never drag one along",
        exc=executor.Refuse)
DIFFERS.clear()
ok(executor.compose_scope(cfg, p["container"], p["file"], p["service"], {p["service"]},
                          tcat.components["web"].apply).startswith("scope: only web"),
   "…and with nothing else pending it passes, naming the one service that changes")

with open(os.path.join(RP, "compose.yml"), "a") as fh:
    fh.write("# an uncommitted line\n")
refused(lambda: configvalue.plan("web", "MODE", cfg=cfg, catalog=tcat, available=A),
        "has local changes",
        "a DIRTY pin file: the value this would put back is not the one main declares")
git("checkout", "-q", "--", "compose.yml")

RUNNING.pop("t-web")
refused(lambda: configvalue.plan("web", "MODE", cfg=cfg, catalog=tcat, available=A),
        "is not running", "a stopped container - a change is never verified against a dead service")
RUNNING["t-web"] = ("example.invalid/web:1.0.0", "sha256:" + "1" * 64)

# THE LIVE-VALUE RULE, as a refusal rather than as a dead Edit button.
narrow = updates.load_catalog(tomllib.loads(
    BASE.replace('pins = ["apps/bothy/compose.socket-proxy.yml:socket-write"]', 'pins = ["other.yml:acl"]')
    + REASONS + '[config_keys.web.MODE]\nservice = "web"\npattern = "slow|slower"\n'
                'meaning = "twenty characters of it, at least"\n'))
refused(lambda: configvalue.plan("web", "MODE", cfg=cfg, catalog=narrow, available=A),
        "does not accept the value that is live",
        "a pattern that REFUSES the running value refuses the PLAN - never an Edit button no value satisfies")

print()
print("── THE ROWS: every key, and a locked one carries no value ────────")
rows = configvalue.rows("web", cfg=cfg, catalog=tcat, available=A)
# Keyed by (SERVICE, KEY), because that is a row's identity: `web` and `side` both
# set MODE here, exactly as Keycloak's two pinned services share four keys.
by = {(r["service"], r["key"]): r for r in rows}
ok(set(by) == {("web", k) for k in ("MODE", "LEVEL", "QUOTED", "FROM_ENV", "EMPTY", "PORT")}
   | {("side", "MODE")},
   f"every environment key of every pinned service of the component: {sorted(by)}")
ok(by[("web", "MODE")]["editable"] and by[("web", "MODE")]["planId"] == p["id"]
   and by[("web", "MODE")]["value"] == "fast",
   "an editable row carries its value, its pattern and its plan id")
ok(by[("web", "PORT")]["editable"] is False and by[("web", "PORT")]["reason"]["name"] == "address"
   and "value" not in by[("web", "PORT")],
   "a locked row carries its category sentence and NO VALUE - key names, never values (rule 7)")
ok(by[("web", "QUOTED")]["editable"] is False and by[("web", "QUOTED")]["reason"]["name"] == "rest",
   "a key nobody measured resolves to the catch-all, which always answers")
ok(by[("side", "MODE")]["editable"] is False,
   "`side`'s MODE is LOCKED although `web`'s is editable - the allowlist names the service, and a row "
   "whose service it does not name is not that row")
ok(configvalue.find_row({"rows": rows}, "web", "MODE") is by[("web", "MODE")]
   and configvalue.find_row({"rows": rows}, "side", "MODE") is by[("side", "MODE")],
   "find_row needs the service: by key alone the locked row would shadow the editable one, and every "
   "request for it would be refused for a value that is perfectly editable")

print()
print("── THE SPOOL: the host re-checks every field, out of its own catalog ─")
cdoc = {"version": 1, "component": "web", "ok": True, "discoveredAt": A["generatedAt"],
        "rows": [{"key": "MODE", "service": "web", "file": "compose.yml", "editable": True,
                  "value": "fast", "line": 10, "planId": p["id"], "plan": p,
                  "pattern": "fast|slow", "meaning": "x" * 20}]}


def req(**kw) -> dict:
    d = {"v": 1, "jobId": "a" * 32, "kind": "config", "component": "web", "key": "MODE",
         "value": "slow", "planId": p["id"], "confirm": True, "requestedBy": "me@example.com",
         "requestedAt": "2026-10-11T10:00:00Z"}
    d.update(kw)
    return d


ok(spool.is_config(req()) and not spool.is_group(req()),
   "a config request is told apart by its own `kind`, never by guessing from a key")
ok(spool.validate_shape(req(), "a" * 32 + ".json") is not None, "the exact shape is accepted")
ok(spool.validate_against_config(req(), tcat, cdoc).get("id") == p["id"],
   "…and it validates against the host's own rows")

for kw, needle, label in [
    ({"value": "sideways"}, "not one mode may take",
     "A VALUE THAT FAILS THE PATTERN, refused on the HOST out of the HOST's catalog"),
    ({"value": "x" * 70}, "1 to 64", "a value over the ceiling"),
    ({"value": "sl ow"}, "space", "a value with a space"),
    ({"value": 7}, "trimmed string", "a value that is not a string"),
    ({"key": "PORT"}, "not an editable config value", "a key that is not on the list"),
    ({"requestedBy": "auto"}, "never automatic", "THE NIGHT JOB's actor"),
    ({"confirm": "web"}, "one click", "a typed confirmation, which this plan never asks for"),
    ({"planId": "b" * 24}, "is not the current plan", "a plan id that is not the current one"),
]:
    def go(kw=kw):
        d = req(**kw)
        spool.validate_shape(d, "a" * 32 + ".json")
        spool.validate_against_config(d, tcat, cdoc)
    refused(go, needle, label, exc=spool.Invalid)

refused(lambda: spool.validate_shape({**req(), "note": "a note"}, "a" * 32 + ".json"),
        "not ['component'", "a maintenance note - the key set is exact", exc=spool.Invalid)
refused(lambda: spool.validate_shape({**req(), "extra": 1}, "a" * 32 + ".json"),
        "not ['component'", "any extra key at all", exc=spool.Invalid)
r = dict(req())
del r["value"]
refused(lambda: spool.validate_shape(r, "a" * 32 + ".json"),
        "not ['component'", "a request with no value", exc=spool.Invalid)

print()
print("── THE REVERT, as a unit: the old value goes back ────────────────")
# ConfigExecution.rollback() with no docker. The recipe and the health-and-canary
# check are the only two things it reaches into the box with, so those are
# stubbed; everything else is the real thing, and THE FILE IS REAL. What this
# holds that checks/e2e_config.py also holds end to end is the part a mutation
# can be planted on cheaply: that the value written back is the OLD one, read off
# the line this job itself wrote.
RECIPES: list[str] = []


def fake_recipe(self, timeout=None):
    RECIPES.append("ran")


def fake_check(self, image_id, phase):
    return True, "stubbed: healthy, canaries green", True


executor.Execution._recipe = fake_recipe
executor.Execution.check = fake_check


def path_of() -> str:
    return os.path.join(RP, "compose.yml")


def mode_now() -> str:
    return re.search(r"^      MODE: (\S+)$", open(path_of(), encoding="utf-8").read(), re.M).group(1)


fresh = configvalue.plan("web", "MODE", cfg=cfg, catalog=tcat, available=A)
rec = record.Recorder(cfg, record.new_job(
    {"jobId": "d" * 32, "component": "web", "planId": fresh["id"], "requestedBy": "me@example.com",
     "requestedAt": "2026-10-11T10:00:00Z"}, "d" * 32 + ".json", record.CONFIG_STEPS))
ex = configvalue.ConfigExecution(cfg, rec, tcat.components["web"], fresh, "slow")
ex.step("edit", ex.edit)
ok(mode_now() == "slow" and ex.edited, f"the edit wrote the new value: MODE: {mode_now()}")
state = ex.rollback(RuntimeError("the canary said no"))
ok(state == "rolled_back", f"the job's result is rolled_back ({state})")
ok(mode_now() == "fast", f"THE OLD VALUE IS BACK: MODE: {mode_now()}")
ok(subprocess.run(["git", "status", "--porcelain"], cwd=RP, capture_output=True,
                  text=True).stdout.strip() == "",
   "…and the tree is clean, so nothing is left pending")
ok(len(RECIPES) == 1, f"the recipe ran once, to put the old value into effect ({len(RECIPES)})")
steps = {s["name"]: s["state"] for s in rec.job["steps"]}
ok(steps.get("rollback") == "ok" and "restore" not in steps,
   f"a `rollback` step, and no `restore` step at all: {steps}")
ok("is back to fast" in (rec.job.get("note") or "") and "clean again" in (rec.job.get("note") or ""),
   f"the note says the value is back and the tree is clean: {(rec.job.get('note') or '')[:120]!r}")

print()
print("── NO RESTORE: there is no path from a config job to one ─────────")
src = open(os.path.join(SVC, "updater", "configvalue.py"), encoding="utf-8").read()
code = "\n".join(ln for ln in src.splitlines() if not ln.lstrip().startswith("#"))
ok(".restore(" not in code and "always_restore" not in code,
   "configvalue.py never calls a class's restore, and never reads always_restore - a config job "
   "cannot lose data, because a restore is the only step that can")
ok("NO DATA RESTORE" in src, "…and the branch where an image job WOULD restore says so in words")
ok("restore" not in record.CONFIG_STEPS and "edit" in record.CONFIG_STEPS
   and "pull" not in record.CONFIG_STEPS,
   f"the job's step list has an `edit` where an image job pulls, and no `restore` to reach: "
   f"{record.CONFIG_STEPS}")

print()
print(f"config-value units: {'all passed' if not fails else str(len(fails)) + ' FAILED'}")
sys.exit(1 if fails else 0)
