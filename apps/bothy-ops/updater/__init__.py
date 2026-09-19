"""bothy-updater - the HOST executor for Settings > Updates (docs/plans/updates.md step 4).

    python3 -m updater plan [--component ID] [--target TAG]   compute / write plans
    python3 -m updater run                                     drain the spool (the systemd unit)
    python3 -m updater status                                  print status.json and the last jobs

Run from apps/bothy-ops (host/systemd/bothy-updater.service sets
WorkingDirectory). Standard library only, like discover_updates.py and
inventory.py: it runs under the system python3, as devssh, with no venv.

── what it deploys: ONLY what `main` already pins ─────────────────────────────

The one decision everything else follows (docs/plans/updates.md, "Decisions",
step 4). A plan is "the image this container runs -> the image the checked-out
`main` pins for it". The updater never writes a newer version into a compose
file, never commits, and never moves the checkout:

  * git stays the only source of truth. A pin reaches `main` as a Dependabot PR
    (or any PR), is reviewed, and `upgrade.yml` has already proved HEAD^1 -> HEAD
    on it. The box then applies exactly that - one click instead of a shell.
  * the tree stays clean, so `bothy upgrade` (git pull --ff-only) is never
    blocked by a local pin edit, and never conflicts with the Dependabot PR that
    bumps the same line a week later.
  * the browser cannot choose a version at all. The target is a line in a file
    on `main`; a request names only a component and a plan id the HOST wrote.

The one exception is a ROLLBACK: when verify fails, the old pin line is written
back into the working tree (a strict single-line edit) and the recipe re-run, so
that the next `just up` keeps the version that works. That leaves the tree dirty
on purpose - it is the honest state ("main pins X, this box deliberately runs
W") - and the plan for that component refuses until a person resolves it.

── the shape (SECURITY.md "shape 3", reached through "shape 1") ──────────────

  bothy-ops  writes ONE json file into the spool (its only read-write mount
             besides its audit dir): {component, planId, confirm, jobId, who}.
  systemd    bothy-updater.path sees it and starts bothy-updater.service.
  this       takes a global flock, claims the file (read, record, unlink - at
             most once), RE-VALIDATES everything against updates.toml and a plan
             it recomputes itself, and runs fixed argv lists: no shell string
             anywhere, nothing from the request reaches an argv except as a
             catalog lookup key.

What bothy-ops can therefore make the host do, at worst: deploy, for an
in-scope component, the version `main` already pins - which `just up` would
deploy anyway - at a moment of its choosing, gated by the same pre-flight.
"""

from __future__ import annotations

import os
import sys

PKG = os.path.dirname(os.path.abspath(__file__))
OPS = os.path.dirname(PKG)
# updates.py (the catalog parser) and discover_updates.py (the pin readers) are
# siblings of this package; updates.py finds bothy_common by itself.
if OPS not in sys.path:
    sys.path.insert(0, OPS)
