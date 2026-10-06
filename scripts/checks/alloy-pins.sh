#!/usr/bin/env bash
# One log shipper, one version. The THREE copies of the Alloy pin must agree.
#
# ── what the drift is ────────────────────────────────────────────────────────
#
# Alloy ships every container's logs AND every node's logs into one Loki, from
# two deployments:
#
#   monitoring/compose.yml:alloy      the compose stack, class stateless, channel
#                                     auto - component `alloy`
#   k8s/monitoring/alloy.yaml:alloy   the cluster DaemonSet, class cluster,
#                                     channel notify - component `alloy-cluster`
#
# They are two components in apps/bothy-ops/updates.toml on purpose: two
# deployments, two apply recipes, two sets of canaries. Nothing in that file
# compares their versions, because `pins` only ever asserts agreement WITHIN a
# component - discovery says "the rest must agree with the first" about one
# component's own pin list, never across two.
#
# And Dependabot cannot help either. The compose pin is in the `docker-compose`
# ecosystem and the manifest pin is in `docker`; a group cannot span ecosystems,
# so the same version arrives as TWO PRs every time - #232 and #235 on
# 2026-10-05, v1.19.2 -> v1.20.1. .github/dependabot.yml has asked since that
# block was written that they be "merged together". Asking is not a mechanism:
# merge one, go to lunch, and the box ships logs from two versions of Alloy into
# one Loki, indefinitely, with both halves healthy and nothing red.
#
# ── and a third copy, which is what actually broke ───────────────────────────
#
# apps/bothy-ops/checks/e2e_cluster.py drives the real cluster updater through a
# rollback and a success, and it names the versions as CONSTANTS:
#
#   ALLOY_OLD, ALLOY_NEW = "grafana/alloy:v1.19.1", "grafana/alloy:v1.19.2"
#
# ALLOY_NEW has to be what the tree pins, twice over: the test rewrites
# alloy.yaml by replacing `image: <ALLOY_NEW>` (a no-op, silently, if the pin has
# moved), and it reads ALLOY_NEW's digest off the local docker daemon, where the
# image is present only because the compose stack pulled it. So a half-merged
# bump fails as
#
#   RuntimeError: docker image inspect grafana/alloy:v1.19.2: Error response
#   from daemon: No such image: grafana/alloy:v1.19.2
#
# twenty-five minutes into the live install job - which is how #232 failed, and
# which names neither pin, neither file, nor the word drift. There is also a
# FOURTH copy, a bare "v1.19.2" string in that file's fake available.json, which
# the constant was supposed to be the single source of; it is checked here too,
# because a copy nobody knows about is the only kind that goes stale.
#
# ── why this is a scripts/checks and not part of the ops suite ───────────────
#
# It needs nothing running and nothing installed - four regexes over four files,
# offline, in under a second, on CI tier 0 - whereas the failure it replaces
# needed a minikube profile. A drift between two pin lines should be caught by
# reading the two pin lines.
#
# WHAT IT DELIBERATELY DOES NOT DO: it does not require the DIGEST halves to
# match, because only the compose pin carries one and only sometimes. It compares
# the TAG, which is the version a human and `updates.toml` both mean.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

python3 - "$@" <<'PY'
import pathlib
import re
import sys

COMPOSE = pathlib.Path('monitoring/compose.yml')
MANIFEST = pathlib.Path('k8s/monitoring/alloy.yaml')
E2E = pathlib.Path('apps/bothy-ops/checks/e2e_cluster.py')

fails = 0


def check(label, ok, detail=''):
    global fails
    if ok:
        print('PASS  %s' % label)
    else:
        print('FAIL  %s  %s' % (label, detail))
        fails += 1


def read(path):
    if not path.exists():
        print('FAIL  %s is missing - this check is guarding nothing' % path)
        sys.exit(1)
    return path.read_text(encoding='utf-8')


# ── the two pins ────────────────────────────────────────────────────────────
# `image: grafana/alloy:<tag>` with an optional `@sha256:…`, at the start of a
# YAML value, in either file. Comments are stripped first: both files discuss
# Alloy versions in prose, and matching a sentence instead of a pin is how a
# check becomes un-failable (scripts/checks/mutants.sh, "a regex matched the file
# it was written in").
PIN = re.compile(r'^\s*(?:-\s+)?image:\s*grafana/alloy:(?P<tag>[\w.-]+)', re.M)


def pins_in(path):
    bare = re.sub(r'#.*', '', read(path))
    return PIN.findall(bare)


compose = pins_in(COMPOSE)
manifest = pins_in(MANIFEST)

check('%s pins grafana/alloy exactly once' % COMPOSE, len(compose) == 1,
      'found %d' % len(compose))
check('%s pins grafana/alloy exactly once' % MANIFEST, len(manifest) == 1,
      'found %d' % len(manifest))
if fails:
    print('\ncannot compare what is not there. %d problem(s).' % fails)
    sys.exit(1)

want = compose[0]
check('the compose pin and the DaemonSet pin are the same version (%s)' % want,
      manifest[0] == want,
      '%s says %s, %s says %s' % (COMPOSE, want, MANIFEST, manifest[0]))

# ── the e2e constants ───────────────────────────────────────────────────────
e2e = read(E2E)
m = re.search(r'^ALLOY_OLD,\s*ALLOY_NEW\s*=\s*"grafana/alloy:(?P<old>[\w.-]+)",'
              r'\s*"grafana/alloy:(?P<new>[\w.-]+)"', e2e, re.M)
if not m:
    check('%s declares ALLOY_OLD and ALLOY_NEW on one line' % E2E, False,
          'the line this check parses has changed shape - keep it one assignment')
else:
    old, new = m.group('old'), m.group('new')
    check('ALLOY_NEW is the pinned version (%s)' % want, new == want,
          'e2e_cluster.py tests up to %s; the tree pins %s. The live install job '
          'fails on `docker image inspect grafana/alloy:%s`' % (new, want, new))
    # The test's whole shape is "roll back from NEW to OLD". Equal constants would
    # make every rollback assertion in it pass by doing nothing.
    check('ALLOY_OLD is a different version from ALLOY_NEW', old != new,
          'both are %s, so the rollback half of the test asserts nothing' % new)

    # The fourth copy: the fake available.json the test writes for alloy-cluster
    # carries the tag as a bare string instead of the constant.
    t = re.search(r'"alloy-cluster".*?"tag":\s*"(?P<tag>[\w.-]+)"', e2e, re.S)
    if not t:
        check('%s states alloy-cluster\'s offered tag' % E2E, False,
              'the available.json fixture no longer carries a "tag" - if the '
              'constant is now used directly, delete this assertion')
    else:
        check('the available.json fixture\'s tag is ALLOY_NEW (%s)' % new,
              t.group('tag') == new,
              'the fixture offers %s while ALLOY_NEW is %s - a fourth copy of '
              'one version, and the plan would be built for the wrong one'
              % (t.group('tag'), new))

print()
if fails:
    print('%d mismatch(es). One of the Alloy pins moved without the others.' % fails)
    print('There is no Dependabot group that can span these ecosystems, so the')
    print('two PRs (#232 and #235 were the pair) must be merged TOGETHER, and')
    print('apps/bothy-ops/checks/e2e_cluster.py\'s constants moved with them.')
    print('Left half-done, the box ships logs from two versions of Alloy into')
    print('one Loki and every container looks healthy.')
    sys.exit(1)
print('ok - grafana/alloy is %s in monitoring/compose.yml, k8s/monitoring/alloy.yaml'
      % want)
print('     and e2e_cluster.py (rolling back to %s)' % m.group('old'))
PY
