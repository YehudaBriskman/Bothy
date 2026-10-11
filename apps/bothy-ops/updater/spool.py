"""The spool: the ONE thing bothy-ops can write that the host reads.

bothy-ops writes `<jobId>.json` atomically (a dot-prefixed temp name, then a
rename). Everything in this directory is treated as hostile, because a total
compromise of bothy-ops owns it:

  * only a regular file named exactly <32 hex>.json is a request; it is opened
    O_NOFOLLOW|O_NONBLOCK and fstat-ed, so a symlink, a FIFO or a directory named
    like one is never read through;
  * a request is at most 4 KiB, and its keys, types and formats are an exact set;
  * anything else - a stale temp file, a directory, junk - is removed, so the
    path unit (PathExistsGlob) cannot be made to fire forever;
  * a claimed request is unlinked BEFORE the job runs: a crash mid-job never
    re-runs it (at most once).

What a valid request can name is a component id and a plan id. Neither is used
as anything but a lookup key: validate_against() below and plans.plan() decide
everything else from files on the host.
"""

from __future__ import annotations

import errno
import json
import os
import re
import shutil
import stat
import time

import updates

from . import classes

JOB_ID = re.compile(r"[a-f0-9]{32}")
FILE = re.compile(r"([a-f0-9]{32})\.json")
# The other kinds of file a spool may hold. Each has an owner that claims it, and
# the update loop below leaves it alone rather than removing it as junk - which is
# why a new kind is TWO edits, here and in the loop: a name this does not know is
# removed, with an audit line, and the ask it carried silently never happens.
#   unpause-  (step 7)      an operator's request to clear an automatic-update pause
#                           -> auto.drain_unpause()
#   discover- (2026-10-06)  "check for updates now" -> asks.drain_discover()
#   autorun-  (2026-10-06)  "run the night job now" -> asks.drain_autorun()
UNPAUSE_FILE = re.compile(r"unpause-([a-f0-9]{32})\.json")
DISCOVER_FILE = re.compile(r"discover-([a-f0-9]{32})\.json")
AUTORUN_FILE = re.compile(r"autorun-([a-f0-9]{32})\.json")
# Every regex above, for entries() and for the checks that assert the set.
OTHER_KINDS = (UNPAUSE_FILE, DISCOVER_FILE, AUTORUN_FILE)
PLAN_ID = re.compile(r"[a-f0-9]{24}")
ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
COMPONENT = re.compile(r"[a-z][a-z0-9-]{0,39}")
KEYS = {"v", "jobId", "component", "planId", "confirm", "requestedBy", "requestedAt"}
# A GROUP request (updater/groups.py): "apply everything `just up-monitoring` pins,
# in one compose up". It names a RECIPE instead of a component, carries `kind` so
# the two shapes can never be confused for one another, and never a note. It goes
# in the same <jobId>.json, so the path unit, the lock, the claim-before-run rule
# and every record are the single-component ones, unchanged.
GROUP_KEYS = {"v", "jobId", "kind", "group", "planId", "confirm", "requestedBy", "requestedAt"}
GROUP_KIND = "group"
# A CONFIG request (updater/configvalue.py): "set this allowlisted compose value
# to this". Same <jobId>.json, same path unit, same lock, same claim-before-run
# rule, same records - and the same `kind` discriminator a group uses, so the
# three shapes can never be confused for one another.
#
# `value` IS THE ONE FIELD OF ANY REQUEST IN THIS SPOOL THAT IS NOT A LOOKUP KEY,
# and the reason it is allowed to exist at all is the bound on it: it is
# fullmatched against the pattern in the catalog the HOST reads
# (configvalue.value_ok), by bothy-ops before it writes the file and again here
# when it is claimed, and it reaches a FILE WRITE - never an argv, never a shell,
# never a template. `key` beside it is a lookup key into [config_keys], like a
# component id is into [components].
CONFIG_KEYS = {"v", "jobId", "kind", "component", "key", "value", "planId", "confirm",
               "requestedBy", "requestedAt"}
CONFIG_KIND = "config"
ENV_KEY = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
MAX_VALUE = 64
# The one optional key (step 8): the maintenance note a postgres-major plan
# requires. Any other plan refuses a request that carries one (pgmajor.validate_note).
OPTIONAL = {"note"}
MAX_NOTE = 500
MAX_BYTES = 4096
STALE_TMP = 120


class Invalid(Exception):
    """A spool request this will not run. The message goes to the record."""


def entries(spool: str) -> tuple[list[tuple[float, str]], list[str]]:
    """(requests oldest first as (mtime, name), junk names). Never follows a link."""
    reqs: list[tuple[float, str]] = []
    junk: list[str] = []
    try:
        names = os.listdir(spool)
    except FileNotFoundError:
        return [], []
    now = time.time()
    for n in names:
        try:
            st = os.lstat(os.path.join(spool, n))
        except FileNotFoundError:
            continue
        if FILE.fullmatch(n) and stat.S_ISREG(st.st_mode):
            reqs.append((st.st_mtime, n))
        elif stat.S_ISREG(st.st_mode) and any(p.fullmatch(n) for p in OTHER_KINDS):
            continue  # another drain owns it - see OTHER_KINDS
        elif n.startswith(".") and n.endswith(".tmp") and stat.S_ISREG(st.st_mode) and now - st.st_mtime < STALE_TMP:
            continue  # a write in progress
        else:
            junk.append(n)
    reqs.sort()
    return reqs, junk


def remove(spool: str, name: str) -> None:
    p = os.path.join(spool, name)
    try:
        st = os.lstat(p)
        if stat.S_ISDIR(st.st_mode):
            shutil.rmtree(p)  # fd-based and symlink-safe on Linux
        else:
            os.unlink(p)
    except FileNotFoundError:
        pass


def read(spool: str, name: str) -> dict:
    """The request's JSON object, read through O_NOFOLLOW. Raises Invalid."""
    m = FILE.fullmatch(name)
    if not m:
        raise Invalid("not a request file name")
    try:
        fd = os.open(os.path.join(spool, name), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as e:
        raise Invalid("the request could not be opened" + (" (a symlink)" if e.errno == errno.ELOOP else "")) from None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise Invalid("the request is not a regular file")
        if st.st_size > MAX_BYTES:
            raise Invalid(f"the request is {st.st_size} bytes; the limit is {MAX_BYTES}")
        raw = os.read(fd, MAX_BYTES + 1)
    finally:
        os.close(fd)
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Invalid("the request is not JSON") from None
    if not isinstance(doc, dict):
        raise Invalid("the request is not a JSON object")
    return doc


def is_group(doc: object) -> bool:
    """A group request, by its own `kind`. One reader, so "which shape is this?"
    is never answered by guessing from which key happens to be present."""
    return isinstance(doc, dict) and doc.get("kind") == GROUP_KIND


def is_config(doc: object) -> bool:
    """A config-value request, by its own `kind`. See is_group."""
    return isinstance(doc, dict) and doc.get("kind") == CONFIG_KIND


def validate_shape(doc: dict, name: str) -> dict:
    """Exact keys, exact types, exact formats. Returns the request."""
    if is_group(doc):
        if set(doc) != GROUP_KEYS:
            raise Invalid(f"the group request's keys are {sorted(doc)}, not {sorted(GROUP_KEYS)}")
        if not isinstance(doc["group"], str) or not COMPONENT.fullmatch(doc["group"]):
            raise Invalid("the group id is malformed")
    elif is_config(doc):
        if set(doc) != CONFIG_KEYS:
            raise Invalid(f"the config request's keys are {sorted(doc)}, not {sorted(CONFIG_KEYS)}")
        if not isinstance(doc["key"], str) or not ENV_KEY.fullmatch(doc["key"]):
            raise Invalid("the config key is malformed")
        # The SHAPE of the value only. What it may BE is the catalog's pattern,
        # checked in validate_against_config() against the catalog this host
        # reads - this module has no catalog and must not grow one.
        v = doc["value"]
        if not isinstance(v, str) or not v or v.strip() != v or len(v) > MAX_VALUE:
            raise Invalid(f"the value is not a trimmed string of 1 to {MAX_VALUE} characters")
        if any(c in v for c in "\n\r\t#'\"") or " " in v:
            raise Invalid("the value carries a newline, tab, quote, `#` or space - none of which can "
                          "be a plain compose scalar on one line")
    elif not KEYS <= set(doc) <= KEYS | OPTIONAL:
        raise Invalid(f"the request's keys are {sorted(doc)}, not {sorted(KEYS)} (+ an optional note)")
    if "note" in doc and (not isinstance(doc["note"], str) or not 0 < len(doc["note"]) <= MAX_NOTE):
        raise Invalid("the note is malformed")
    if doc["v"] != 1:
        raise Invalid("unknown request version")
    job = doc["jobId"]
    if not isinstance(job, str) or not JOB_ID.fullmatch(job) or f"{job}.json" != name:
        raise Invalid("the job id is malformed or does not match the file name")
    if not is_group(doc) and (not isinstance(doc["component"], str)
                              or not COMPONENT.fullmatch(doc["component"])):
        raise Invalid("the component id is malformed")
    if not isinstance(doc["planId"], str) or not PLAN_ID.fullmatch(doc["planId"]):
        raise Invalid("the plan id is malformed")
    c = doc["confirm"]
    if not (c is True or (isinstance(c, str) and COMPONENT.fullmatch(c))):
        raise Invalid("confirm must be true or the component's id")
    if not isinstance(doc["requestedBy"], str) or not 0 < len(doc["requestedBy"]) <= 200:
        raise Invalid("requestedBy is malformed")
    if not isinstance(doc["requestedAt"], str) or not ISO.fullmatch(doc["requestedAt"]):
        raise Invalid("requestedAt is malformed")
    return doc


def validate_against(doc: dict, catalog: updates.Catalog, plan_doc: dict | None) -> dict:
    """The request against the catalog and the host's own plan file. Returns the plan.

    This is the "never trusts bothy-ops" half: bothy-ops ran the same checks
    before it wrote the file, and none of that is assumed here.
    """
    comp = catalog.components.get(doc["component"])
    if comp is None:
        raise Invalid(f"{doc['component']!r} is not in updates.toml")
    if classes.get(comp.cls, comp.id) is None:
        raise Invalid(f"{comp.id} is class {comp.cls}, which the updater does not handle")
    if not plan_doc or plan_doc.get("component") != comp.id:
        raise Invalid(f"there is no plan file for {comp.id}")
    if not plan_doc.get("ok"):
        raise Invalid(f"there is no deployable plan for {comp.id}: {plan_doc.get('reason')}")
    p = plan_doc.get("plan") or {}
    if p.get("id") != doc["planId"]:
        raise Invalid(f"plan {doc['planId']} is not the current plan for {comp.id} (that is {p.get('id')})")
    want = comp.id if p.get("confirm") == "type-name" else True
    if doc["confirm"] != want:
        raise Invalid("the confirmation does not match what the plan requires")
    if p.get("requiresNote") and not (isinstance(doc.get("note"), str) and doc["note"].strip()):
        raise Invalid("this plan requires a maintenance note, and the request carries none")
    return p


def validate_against_group(doc: dict, catalog: updates.Catalog, group_doc: dict | None) -> dict:
    """A group request against the catalog and the host's own groups/<group>.json.

    The same "never trusts bothy-ops" half as validate_against(), and three rules
    a group adds: the actor is never the night job (a group is neither one
    component nor one patch, so no unattended channel may ever choose it), the
    typed confirmation is the GROUP's id, and a group request carries no note.
    """
    from . import groups
    gid = doc["group"]
    if gid not in groups.groups_of(catalog):
        raise Invalid(f"{gid!r} is not a recipe with two or more components the updater deploys")
    if doc.get("requestedBy") == updates.AUTO_ACTOR:
        raise Invalid("a group is never automatic: the night job deploys one component's patch a night")
    if "note" in doc:
        raise Invalid("a maintenance note is only for a plan that asks for one")
    if not group_doc or group_doc.get("group") != gid:
        raise Invalid(f"there is no group plan file for {gid}")
    if not group_doc.get("ok"):
        raise Invalid(f"there is no deployable group plan for {gid}: {group_doc.get('reason')}")
    p = group_doc.get("plan") or {}
    if p.get("id") != doc["planId"]:
        raise Invalid(f"group plan {doc['planId']} is not the current plan for {gid} (that is {p.get('id')})")
    want = gid if p.get("confirm") == "type-name" else True
    if doc["confirm"] != want:
        raise Invalid("the confirmation does not match what the group plan requires")
    return p


def validate_against_config(doc: dict, catalog: updates.Catalog, config_doc: dict | None) -> dict:
    """A config request against the catalog and the host's own configs/<id>.json.

    The same "never trusts bothy-ops" half as validate_against(), and the four
    rules a config change adds:

      * the KEY has to be on [config_keys] in the catalog ON THIS HOST. bothy-ops
        checked the same thing against the same table in its own image, and none
        of that is assumed here - this is the check that holds when the process
        that asked is the thing that is wrong.
      * the VALUE has to fullmatch that table's pattern, read here, from the
        host's catalog. It is the one field of any request in this spool that is
        not a lookup key, and this is the bound that makes that acceptable.
      * the actor is never the night job. A config value is nobody's patch
        release: no channel chooses one, `auto.decide()` has no path to a config
        plan at all, and auto.py can only write the single-component shape - so
        this is the fourth independent refusal, not the only one.
      * one click, never a typed name, and never a maintenance note. The level
        follows reversibility and the host puts the value back by itself.
    """
    from . import configvalue
    cid, key = doc["component"], doc["key"]
    comp = catalog.components.get(cid)
    if comp is None:
        raise Invalid(f"{cid!r} is not in updates.toml")
    ck = catalog.config_keys.get(f"{cid}.{key}")
    if ck is None:
        raise Invalid(f"{cid}.{key} is not an editable config value on this host")
    if comp.cls not in updates.CONFIG_CLASSES:
        raise Invalid(f"{cid} is class {comp.cls}, which has no editable config value")
    if doc.get("requestedBy") == updates.AUTO_ACTOR:
        raise Invalid("a config value is never automatic: the night job deploys one component's patch "
                      "a night, and no channel chooses a value")
    if "note" in doc:
        raise Invalid("a maintenance note is only for a plan that asks for one")
    bad = configvalue.value_ok(ck, doc["value"])
    if bad:
        raise Invalid(f"the value is not one {key} may take: {bad}")
    row = configvalue.find_row(config_doc, key)
    if not config_doc or config_doc.get("component") != cid or row is None:
        raise Invalid(f"there is no config row for {cid}.{key}")
    if not row.get("editable") or not row.get("planId"):
        raise Invalid(f"there is no deployable config plan for {cid}.{key}: "
                      f"{row.get('reason') or 'it is not editable'}")
    if row["planId"] != doc["planId"]:
        raise Invalid(f"config plan {doc['planId']} is not the current plan for {cid}.{key} "
                      f"(that is {row['planId']})")
    if doc["confirm"] is not True:
        raise Invalid("a config value is one click: confirm must be true")
    return row.get("plan") or {}


def queued(spool: str) -> list[str]:
    try:
        return sorted(n for n in os.listdir(spool) if FILE.fullmatch(n))
    except FileNotFoundError:
        return []
