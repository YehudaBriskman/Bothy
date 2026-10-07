#!/usr/bin/env bash
# The Grafana dashboards keep to the parts of the data-visualisation standard a
# machine can state.
#
# WHY THIS EXISTS. docs/brand/patterns/dataviz.md has been the standard since
# 2026-08-10 and three of the five dashboards obeyed none of it, because nothing
# ever read it on their behalf: they are upstream imports, they rendered, and a
# rendered panel looks finished. The specific things that survived a year of
# nobody noticing are the shape of the problem:
#
#   . 110 panels coloured series by their position in the list, so filtering one
#     mount repainted the rest.
#   . Three panels drew a missing sample as zero, which is a cliff that never
#     happened on the three panels you open when a container misbehaves.
#   . A PSI bargauge had thresholds at 70 and 90 on a field declared `max: 1`, so
#     it had been permanently green since the day it was imported.
#
# None of those produce an error, a warning, or a visibly broken page. They are
# only findable by a thing that reads the files, which is what this is.
#
# TWO SETS OF RULES, because the two kinds of dashboard can meet different
# amounts of the standard.
#
#   scripts/normalise-dashboards.py --check  runs the mechanical rules that apply
#   to EVERY dashboard, including the imports: one datasource syntax, one refresh
#   interval, colour by entity rather than by rank, gaps left as gaps, no second
#   y-axis. That file's header carries the reason for each.
#
#   The block below adds what only a dashboard WE wrote can be held to: every
#   panel explains itself, and every colour literal is a token out of
#   docs/brand/reference/tokens.md rather than something that looked right. An
#   upstream import is exempt from both, and the exemption is explicit - a new
#   file has to be filed as one or the other, or this fails and says so, because
#   the quiet way for a standard to rot is a sixth dashboard nobody classified.
#
# It also holds the two couplings that would otherwise drift silently: the
# datasource uids the normaliser knows about against the ones actually
# provisioned, and the landing page named in monitoring/compose.yml against the
# file that has to exist for it to resolve.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

fails=0

echo "== the mechanical rules, every dashboard =="
if python3 scripts/normalise-dashboards.py --check; then
  :
else
  fails=$((fails + 1))
fi

echo
echo "== the rules only a dashboard we wrote can meet =="
if python3 - <<'PY'
import json
import os
import re
import sys

DASH = "monitoring/dashboards"

# WRITTEN HERE: held to the whole standard, because we can be.
HAND_WRITTEN = {
    "traefik.json",     # the edge, in two explicitly separated populations
    "box-health.json",  # the landing page
}
# UPSTREAM IMPORTS: exempt from the two rules below, and the reason is per file.
# Re-importing one and running scripts/normalise-dashboards.py is the supported
# way to update it, which a hand-written description or a repainted hex would
# turn into a merge.
UPSTREAM = {
    "cadvisor.json",            # grafana.com 193, schemaVersion 27
    "postgres.json",            # grafana.com 455, schemaVersion 19
    "node-exporter-full.json",  # grafana.com 1860, schemaVersion 41, 140 panels
}

# The dark-mode values of the status and chart-series tokens, read out of the
# brand reference rather than copied, so a repaint there is not silently
# disagreed with here. Plus the greys a panel legitimately needs and Grafana's
# own `text`, which means "whatever the current theme's foreground is" and is how
# a number says it is a reading rather than a verdict.
TOKENS = "docs/brand/reference/tokens.md"
NAMED_OK = {"text", "transparent"}

fails = 0


def fail(msg):
    global fails
    fails += 1
    print("FAIL  %s" % msg)


def allowed_hexes():
    if not os.path.exists(TOKENS):
        fail("%s is missing - the palette cannot be checked against anything" % TOKENS)
        return set()
    rows = re.findall(
        r"^\|\s*`--((?:st|chart|fg|a)[a-z0-9-]*)`\s*\|\s*`(#[0-9a-fA-F]{6})`",
        open(TOKENS, encoding="utf-8").read(), re.M)
    if len(rows) < 10:
        fail("%s: found only %d token rows - has the table changed shape?"
             % (TOKENS, len(rows)))
    return {h.lower() for _, h in rows}


def panels(dash):
    stack = list(dash.get("panels") or [])
    while stack:
        p = stack.pop()
        yield p
        stack.extend(p.get("panels") or [])


files = sorted(f for f in os.listdir(DASH) if f.endswith(".json"))
unclassified = [f for f in files if f not in HAND_WRITTEN and f not in UPSTREAM]
for f in unclassified:
    fail("%s is in neither HAND_WRITTEN nor UPSTREAM in this check. Decide which "
         "it is and say why in the comment beside it - a dashboard nobody filed "
         "is a dashboard nobody holds to anything." % f)
for f in sorted(HAND_WRITTEN | UPSTREAM):
    if f not in files:
        fail("%s is listed in this check but does not exist in %s" % (f, DASH))

ok_hex = allowed_hexes()

for name in sorted(HAND_WRITTEN & set(files)):
    path = os.path.join(DASH, name)
    raw = open(path, encoding="utf-8").read()
    dash = json.loads(raw)

    # Every panel explains itself. This is the closest Grafana gets to the
    # standard's "every chart needs an accessible name that states the actual
    # numbers": the description is what the `i` tooltip shows and what a reader
    # has to reach for to find out which population a number is drawn from.
    for p in panels(dash):
        if p.get("type") == "row":
            continue
        d = (p.get("description") or "").strip()
        if len(d) < 40:
            fail("%s: panel %r has no description worth reading (%d chars). Say "
                 "what is measured and over what population."
                 % (name, p.get("title"), len(d)))

    # Every colour literal is a token. A hex that is nearly a token is the worst
    # case: it reads as deliberate and is invisible in one theme. traefik.json
    # shipped #4d9bff and #9fabbe for a year, neither of them in the table.
    for hx in sorted({h.lower() for h in re.findall(r"#[0-9a-fA-F]{6}", raw)}):
        if hx not in ok_hex:
            fail("%s: %s is not a token in %s. Use the token's value, or add the "
                 "token there first." % (name, hx, TOKENS))

    # A named colour has to be one of the two that mean "no colour". Grafana's
    # own "green"/"red"/"dark-yellow" are a second status palette with no
    # measured contrast and no theme behind them.
    for named in sorted(set(re.findall(r'"(?:color|fixedColor)":\s*"([a-z][a-z-]*)"', raw))):
        if named not in NAMED_OK:
            fail("%s: %r is one of Grafana's own colour names, which is a second "
                 "status palette nobody measured. Use a token hex, or %s."
                 % (name, named, " / ".join(sorted(NAMED_OK))))

    print("PASS  %s: %d panels, every one described, every colour a token"
          % (name, sum(1 for p in panels(dash) if p.get("type") != "row")))

# The normaliser's datasource table against the one actually provisioned. If a
# third datasource is added and the table is not, the normaliser quietly leaves
# its panels on whatever spelling they arrived with.
DS_YML = "monitoring/provisioning/datasources/datasources.yml"
provisioned = set(re.findall(r"^\s*uid:\s*(\S+)", open(DS_YML, encoding="utf-8").read(), re.M))
known = set(re.findall(r'^DATASOURCES = \{(.*)\}', open("scripts/normalise-dashboards.py",
                                                       encoding="utf-8").read(), re.M)[0].split(","))
known = {re.findall(r'"([^"]+)"', k)[0] for k in known if '"' in k}
if provisioned != known:
    fail("%s provisions %s but scripts/normalise-dashboards.py knows %s. A "
         "datasource the normaliser has never heard of keeps whatever spelling "
         "its panels arrived with." % (DS_YML, sorted(provisioned), sorted(known)))
else:
    print("PASS  the normaliser knows every provisioned datasource: %s" % sorted(known))

# The landing page. GF_USERS_DEFAULT_HOME_DASHBOARD_PATH is resolved inside the
# container against the read-only bind mount, so a typo here is not an error at
# start - Grafana logs it and falls back to the stock Home page, which is exactly
# the state this was added to fix and looks identical to it.
COMPOSE = "monitoring/compose.yml"
m = re.search(r"^\s*GF_USERS_DEFAULT_HOME_DASHBOARD_PATH:\s*(\S+)\s*$",
              open(COMPOSE, encoding="utf-8").read(), re.M)
if not m:
    fail("%s sets no GF_USERS_DEFAULT_HOME_DASHBOARD_PATH, so Grafana lands on "
         "its stock Home page." % COMPOSE)
else:
    inside = m.group(1)
    prefix = "/var/lib/grafana/dashboards/"
    if not inside.startswith(prefix):
        fail("%s: the landing page %s is not under %s, which is the only path "
             "the dashboards bind mount is visible at." % (COMPOSE, inside, prefix))
    else:
        base = inside[len(prefix):]
        if base not in files:
            fail("%s: the landing page names %s, which does not exist in %s. "
                 "Grafana falls back to the stock Home page without failing to "
                 "start, so nothing else would tell you." % (COMPOSE, base, DASH))
        elif base not in HAND_WRITTEN:
            fail("%s: the landing page is %s, an upstream import. The page "
                 "everyone sees first has to be one we are holding to the whole "
                 "standard." % (COMPOSE, base))
        else:
            print("PASS  the landing page is %s, and it exists" % base)

sys.exit(1 if fails else 0)
PY
then
  :
else
  fails=$((fails + 1))
fi

echo
if [ "$fails" -ne 0 ]; then
  echo "FAIL  $fails group(s) of dashboard rules are broken."
  exit 1
fi
echo "PASS  the dashboards keep to the standard."
