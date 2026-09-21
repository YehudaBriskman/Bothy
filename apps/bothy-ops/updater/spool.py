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
# The one other kind of file a spool may hold (step 7): an operator's request to
# clear an automatic-update pause. auto.drain_unpause() claims these; the update
# loop below leaves them alone rather than removing them as junk.
UNPAUSE_FILE = re.compile(r"unpause-([a-f0-9]{32})\.json")
PLAN_ID = re.compile(r"[a-f0-9]{24}")
ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
COMPONENT = re.compile(r"[a-z][a-z0-9-]{0,39}")
KEYS = {"v", "jobId", "component", "planId", "confirm", "requestedBy", "requestedAt"}
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
        elif UNPAUSE_FILE.fullmatch(n) and stat.S_ISREG(st.st_mode):
            continue  # auto.drain_unpause() owns it
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


def validate_shape(doc: dict, name: str) -> dict:
    """Exact keys, exact types, exact formats. Returns the request."""
    if set(doc) != KEYS:
        raise Invalid(f"the request's keys are {sorted(doc)}, not {sorted(KEYS)}")
    if doc["v"] != 1:
        raise Invalid("unknown request version")
    job = doc["jobId"]
    if not isinstance(job, str) or not JOB_ID.fullmatch(job) or f"{job}.json" != name:
        raise Invalid("the job id is malformed or does not match the file name")
    if not isinstance(doc["component"], str) or not COMPONENT.fullmatch(doc["component"]):
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
    return p


def queued(spool: str) -> list[str]:
    try:
        return sorted(n for n in os.listdir(spool) if FILE.fullmatch(n))
    except FileNotFoundError:
        return []
