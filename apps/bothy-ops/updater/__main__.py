"""python3 -m updater {run | plan | status | auto | unpause | pauses | install | upgrade | own-rollback}

See updater/__init__.py, updater/auto.py (step 7) and updater/owncode.py (step 6)."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import secrets
import sys
import time

import updates

from . import auto, executor, hostio, install, plans, record, spool
from .config import Config


def main(argv: list[str] | None = None, cfg: Config | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python3 -m updater", description="Bothy's host update executor.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run", help="drain the spool: validate, pre-flight, snapshot, apply, verify, roll back")
    p = sub.add_parser("plan", help="print (and with --write, store) the plan for components")
    p.add_argument("--component", help="one component id (default: all)")
    p.add_argument("--target", help="refuse unless this is what main pins")
    p.add_argument("--write", action="store_true", help="write plans/<component>.json for every component")
    sub.add_parser("status", help="the current job, the last ten, and the queue")
    auto.add_parsers(sub)
    sub.add_parser("install", help="copy HEAD's updater to ~/.local/lib/bothy-updater/<sha> and switch to it")
    u = sub.add_parser("upgrade", help="update Bothy itself to the newest green release (`bothy upgrade`)")
    u.add_argument("--yes", action="store_true", help="do not ask")
    r = sub.add_parser("own-rollback", help="the own-code rollback timer's command (not for people)")
    r.add_argument("armed")
    a = ap.parse_args(argv)
    cfg = cfg or Config()

    rc = auto.dispatch(a, cfg)
    if rc is not None:
        return rc

    if a.cmd == "run":
        return executor.run_spool(cfg)
    if a.cmd == "status":
        return executor.main_status(cfg)
    if a.cmd == "install":
        return install.main_install(cfg)
    if a.cmd == "upgrade":
        return upgrade(cfg, a.yes)
    if a.cmd == "own-rollback":
        from . import owncode
        return owncode.main_timer(a.armed)
    if a.write:
        for cid, v in plans.write_all(cfg).items():
            print(f"{cid:22} {v}")
        return 0
    if not a.component:
        ap.error("plan needs --component (or --write for all)")
    try:
        print(json.dumps(plans.plan(a.component, a.target, cfg=cfg), indent=1, sort_keys=True))
    except plans.PlanRefused as e:
        print(f"no plan for {a.component}: {e}", file=sys.stderr)
        return 3
    return 0


def upgrade(cfg: Config, yes: bool) -> int:
    """`bothy upgrade` with the updater installed: the SAME plan and executor path
    Settings > Updates drives - a plan the host computes, a spool request, the
    executor under its lock - never a blanket `git pull && just up`."""
    try:
        catalog = updates.load(cfg.catalog)
    except (updates.CatalogError, OSError, ValueError) as e:
        print(f"updates.toml is invalid: {e}", file=sys.stderr)
        return 2
    own = [c for c in catalog.components.values() if c.cls == "own-code"]
    if len(own) != 1:
        print("updates.toml has no single own-code component", file=sys.stderr)
        return 2
    cid = own[0].id
    try:
        available = plans.load_available(cfg)
    except plans.PlanRefused:
        available = {"version": 1, "generatedAt": None, "components": {}}
    print("== planning (git fetch, then the newest green release) ==")
    try:
        p = plans.plan(cid, cfg=cfg, catalog=catalog, available=available)
    except plans.PlanRefused as e:
        print(f"  {e}")
        return 0 if str(e).startswith("nothing to deploy") else 3
    o = p["own"]
    print(f"  {p['from']['tag']} ({o['fromSha'][:12]}) -> {o['tag']} ({o['toSha'][:12]}), {p['level']}, "
          f"{o['commits']} commits: {o['diffstat'] or ''}")
    print(f"  release notes  {p['changelog']}")
    print(f"  CI             {o['ci']['detail']} (via {o['ci']['via']})")
    print(f"  rebuilds       {', '.join(o['apps']) or 'no app source changed'} (all three are recreated)")
    for k, what in (("compose", "compose changes applied"), ("edge", "edge routes that change on checkout"),
                    ("elsewhere", "other stacks' files NOT applied")):
        if o[k]:
            print(f"  {what}: {', '.join(o[k][:6])}{' …' if len(o[k]) > 6 else ''}")
    if o["updater"]:
        print("  the updater itself changes: its new copy is STAGED; `just install-updater` switches afterwards")
    want = cid if p["confirm"] == "type-name" else True
    if not yes:
        prompt = "Update? [y/N] " if want is True else f"Type {cid} to update: "
        try:
            ans = input(prompt).strip()
        except EOFError:
            ans = ""
        if (want is True and ans.lower() not in ("y", "yes")) or (want is not True and ans != cid):
            print("left alone")
            return 1
    hostio.ensure_dir(cfg.plans, 0o700)
    hostio.write_json(os.path.join(cfg.plans, f"{cid}.json"), {"version": 1, "component": cid, "ok": True, "plan": p})
    job = write_request(cfg, cid, p["id"], want, f"{getpass.getuser()} (bothy upgrade)")
    print(f"== queued job {job} - the executor runs it now ==")
    executor.run_spool(cfg, log=lambda m: print(f"  {m}"))
    end = time.monotonic() + 3600
    while time.monotonic() < end:
        h = next((x for x in record.history(cfg, 50) if x.get("id") == job), None)
        if h:
            print(f"== {h['state']} ==")
            for x in (h.get("error"), h.get("note")):
                if x:
                    print(f"  {x}")
            return 0 if h["state"] == "succeeded" else 1
        time.sleep(2)
    print("the job did not finish within an hour - `just update-status`")
    return 1


def write_request(cfg: Config, cid: str, plan_id: str, confirm, who: str) -> str:
    """One spool file, exactly as bothy-ops writes it (the executor re-validates it the same way)."""
    hostio.ensure_dir(cfg.spool, 0o700)
    job = secrets.token_hex(16)
    doc = {"v": 1, "jobId": job, "component": cid, "planId": plan_id, "confirm": confirm, "requestedBy": who[:200],
           "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    spool.validate_shape(doc, f"{job}.json")
    tmp = os.path.join(cfg.spool, f".{job}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, json.dumps(doc, sort_keys=True).encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(tmp, os.path.join(cfg.spool, f"{job}.json"))
    return job


if __name__ == "__main__":
    sys.exit(main())
