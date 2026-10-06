#!/usr/bin/env bash
# The cluster e2e's version constants are copies of the tree's pins. Hold them.
#
# ── the defect, which has now happened three times in one file ───────────────
#
# apps/bothy-ops/checks/e2e_cluster.py drives the REAL cluster updater through a
# forced rollback and a success. To do that it has to name versions, so it opens
# with four constants that duplicate pins living elsewhere in the tree:
#
#   VM_IMG             monitoring/compose.yml        victoriametrics
#   LOKI_IMG           monitoring/compose.yml        loki
#   KSM_OLD, KSM_NEW   k8s/monitoring/Chart.yaml     the kube-state-metrics dep
#   ALLOY_OLD/_NEW     monitoring/compose.yml + k8s/monitoring/alloy.yaml
#
# A copy with no link to its source goes stale the first time somebody moves the
# source, and every one of these did, in one Dependabot batch on 2026-10-05:
#
#   · ALLOY  v1.19.2 -> v1.20.1   (#232 + #235)
#   · KSM    8.5.0   -> 8.6.0     (#223)
#   · VM     v1.152.0 -> v1.153.0 (#231)  <- nothing was even looking at this one
#
# ── why it is silent, which is the whole reason this file exists ─────────────
#
# The test does not merely READ these. It rewrites the real manifests by
# substituting the literal `image: <NEW>`, and it reads <NEW>'s digest off the
# local docker daemon. When a pin moves and the constant does not:
#
#   · the substitution matches nothing. It is a NO-OP, and `.replace()` does not
#     raise - the test goes on, now testing a manifest it did not edit;
#   · the digest lookup dies, 25 minutes into the live install job, as
#     `docker image inspect grafana/alloy:v1.19.2: No such image` - which names
#     neither pin, neither file, nor the word drift.
#
# So the failure is both expensive and misleading: the one signal points at
# docker, and the cause is two lines in a Python file nobody opened.
#
# ── what this holds, and what alloy-pins.sh holds ───────────────────────────
#
# This file: every constant here equals the tree's pin. One relation, one
# direction - the test follows the tree, never the other way.
#
# alloy-pins.sh: the two Alloy DEPLOYMENTS (compose and DaemonSet) agree with
# EACH OTHER, which is a different relation and belongs to that shipper alone -
# and it already covers ALLOY_NEW. Alloy is deliberately absent here so one
# cause produces one red check rather than two.
#
# Both are offline, both run in CI tier 0, both finish in under a second.
# Move a pin, move the constant; the check tells you which one you forgot.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

python3 - <<'PY'
import pathlib
import re
import sys

E2E = pathlib.Path("apps/bothy-ops/checks/e2e_cluster.py")
COMPOSE = pathlib.Path("monitoring/compose.yml")
CHART = pathlib.Path("k8s/monitoring/Chart.yaml")

fails = 0


def say(ok, label, detail=""):
    global fails
    print(("PASS  " if ok else "FAIL  ") + label + ("  " + detail if detail else ""))
    if not ok:
        fails += 1


missing = [p for p in (E2E, COMPOSE, CHART) if not p.is_file()]
if missing:
    print("FAIL  a file this check reads is gone: %s" % ", ".join(map(str, missing)))
    print("\nThe check cannot do its job. Point it at the new path rather than")
    print("deleting it - a pin with nothing holding it is how this started.")
    sys.exit(1)

# Comments first. Every one of these files discusses versions in prose - this
# check's own anchors appear in e2e_cluster.py's header - and a check that
# matches a sentence is a check that can never go red.
e2e = re.sub(r"#.*", "", E2E.read_text(encoding="utf-8"))
compose = re.sub(r"#.*", "", COMPOSE.read_text(encoding="utf-8"))
chart = re.sub(r"#.*", "", CHART.read_text(encoding="utf-8"))


def const(name):
    """A single `NAME = "value"` constant."""
    m = re.search(r'^%s\s*=\s*"([^"]+)"' % name, e2e, flags=re.M)
    return m.group(1) if m else None


def pair(a, b):
    """A `A, B = "x", "y"` pair."""
    m = re.search(r'^%s\s*,\s*%s\s*=\s*"([^"]+)"\s*,\s*"([^"]+)"' % (a, b), e2e, flags=re.M)
    return (m.group(1), m.group(2)) if m else (None, None)


def image(repo):
    """The pinned `image: repo:tag` in the compose file, tag only - the test's
    constants carry no digest, so comparing digests would compare nothing."""
    m = re.search(r"image:\s*(%s:[^\s@]+)" % re.escape(repo), compose)
    return m.group(1) if m else None


# ── the three the test copies from elsewhere ────────────────────────────────
for name, repo in (("VM_IMG", "victoriametrics/victoria-metrics"),
                   ("LOKI_IMG", "grafana/loki")):
    got, want = const(name), image(repo)
    if want is None:
        say(False, "%s is pinned in monitoring/compose.yml" % repo)
    elif got is None:
        say(False, "e2e_cluster.py declares %s" % name)
    else:
        say(got == want, "%s is the pinned version (%s)" % (name, want),
            "" if got == want else "e2e_cluster.py uses %s; the tree pins %s" % (got, want))

# kube-state-metrics: a version-only wrapper chart whose shape scripts/k8s-
# monitoring.sh parses with awk, so read it the same way - the dependency's own
# `version:`, not the wrapper's.
m = re.search(r"-\s*name:\s*kube-state-metrics\s*\n(?:.*\n)*?\s*version:\s*([0-9][^\s]*)", chart)
ksm_want = m.group(1) if m else None
ksm_old, ksm_new = pair("KSM_OLD", "KSM_NEW")
if ksm_want is None:
    say(False, "Chart.yaml declares a kube-state-metrics version")
elif ksm_new is None:
    say(False, "e2e_cluster.py declares KSM_OLD, KSM_NEW")
else:
    say(ksm_new == ksm_want, "KSM_NEW is the pinned chart version (%s)" % ksm_want,
        "" if ksm_new == ksm_want
        else "e2e_cluster.py upgrades to %s; Chart.yaml pins %s" % (ksm_new, ksm_want))
    # A rollback test whose two versions are equal passes by doing nothing.
    say(ksm_old != ksm_new, "KSM_OLD is a different version from KSM_NEW",
        "" if ksm_old != ksm_new else "both are %s - every rollback assertion would pass vacuously" % ksm_old)

# ── the fixture that mirrors the pin, derived rather than written out ───────
# It was the literal "v1.19.2" while ALLOY_NEW moved, so the plan the test
# builds disagreed with the pin it is meant to mirror, and nothing compared them.
say('"tag": ALLOY_NEW.split(":")[1]' in e2e or "ALLOY_NEW.split" in e2e,
    "the available.json fixture derives its tag from ALLOY_NEW rather than repeating it")

print()
if fails:
    print("%d of e2e_cluster.py's constants no longer match the tree." % fails)
    print("The test rewrites real manifests by substituting the literal it holds,")
    print("so a stale one is a SILENT no-op and then a `docker image inspect ...:")
    print("No such image` 25 minutes into the live install job. Move the constant")
    print("in the same commit as the pin.")
    sys.exit(1)
print("ok - e2e_cluster.py's VictoriaMetrics, Loki and kube-state-metrics")
print("     constants are the versions the tree pins (Alloy: alloy-pins.sh)")
PY
