"""python3 -m updater {run | plan | status | auto | unpause | pauses} - see updater/__init__.py and updater/auto.py."""

from __future__ import annotations

import argparse
import json
import sys

from . import auto, executor, plans
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
    a = ap.parse_args(argv)
    cfg = cfg or Config()

    rc = auto.dispatch(a, cfg)
    if rc is not None:
        return rc

    if a.cmd == "run":
        return executor.run_spool(cfg)
    if a.cmd == "status":
        return executor.main_status(cfg)
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


if __name__ == "__main__":
    sys.exit(main())
