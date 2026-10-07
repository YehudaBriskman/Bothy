#!/usr/bin/env python3
"""Hold monitoring/dashboards/*.json to the parts of the data-visualisation
standard that a machine can state.

WHY A SCRIPT AND NOT A HAND EDIT. Three of the five dashboards are upstream
imports - Cadvisor exporter (schemaVersion 27), PostgreSQL Database (19) and
Node Exporter Full (41, 140 panels). Between them they use three panel
vocabularies and three ways of naming a datasource. Rewriting their 185 panels by
hand would throw away what they know about their exporters and would make the
next upstream re-import a merge instead of a replace. So the deal is:

  · re-import the upstream file whenever the exporter changes,
  · run this, which is idempotent,
  · commit.

What that buys is that "what we changed about the imports" is a list of rules in
one file rather than prose nobody can diff, and `--check` makes the rules
load-bearing instead of aspirational. docs/guide/monitoring.md states the same
list in English for a reader; scripts/checks/dashboards.sh runs this with
--check, plus the extra rules that only the hand-written dashboards can meet.

THE STANDARD IS docs/brand/patterns/dataviz.md and
docs/brand/foundations/principles.md. Only some of it is mechanical. The rules
below are the mechanical part; the judgement part (is this the right form for
this data, does the footprint match the number of facts) cannot be checked and is
why the hand-written dashboards are hand-written.

RULES, and why each one is here.

 1. refresh = 1m, everywhere. The four dashboards had four different answers
    (none, 10s, 30s, 1m) and none of them was chosen. 1m is: VictoriaMetrics runs
    `-search.latencyOffset=30s`, so the newest 30 seconds are not returned at all
    and anything faster than ~1m redraws the same picture; and Grafana on this box
    sits at a 512 MiB limit with a measured p95 of 437 MiB, so 140 panels
    re-querying every 10s is a real cost against a real ceiling. A dashboard that
    needs a live view has the time picker and the refresh button.

 2. timezone = browser. Two of them said "" (which resolves to the Grafana
    default, not to the reader's clock) and one said browser. A timestamp that
    means a different instant on two dashboards is the time-axis version of two
    graphics disagreeing about their denominator.

 3. graphTooltip = 1 (shared crosshair). The standard's reason for it is the
    denominator rule: panels side by side are meant to be read against each
    other, and a crosshair is what makes "at this instant" the same instant in
    both.

 4. One datasource syntax: the object form with a literal uid, the way the
    hand-written dashboards do it. The imports had `"prometheus"` (a bare string,
    which Grafana resolves by NAME and only works here because the name and the
    uid happen to match), `"$DS_PROMETHEUS"` and `"${ds_prometheus}"`. Three
    spellings of one datasource is three ways for a copied panel to silently
    point at nothing.

 5. No datasource picker, and no `__inputs`. A `type: datasource` template
    variable on a provisioned dashboard lets a reader repoint panels at a
    datasource that cannot answer them, and persists nothing - so the only thing
    it can do here is break the view for the person who touched it. There is one
    metrics datasource and one log datasource on this box. `__inputs` is the other
    half of the same thing: it is grafana.com's export envelope declaring an input
    the IMPORT WIZARD would prompt for, and once rule 4 has replaced the
    `${DS_...}` placeholders there is nothing left for it to fill, so keeping it
    is the file advertising a knob it does not have. `__requires` is kept - it
    records the Grafana and panel versions the dashboard was built against, which
    is provenance worth having and claims nothing about this box.

 6. palette-classic -> palette-classic-by-name. THE ONE RULE THAT CHANGES WHAT A
    READER SEES. `palette-classic` assigns a colour by the series' INDEX, so
    filtering out one container repaints every container after it in the list -
    which is exactly "colour follows the entity, never its rank", broken, on 110
    panels of Node Exporter Full. `-by-name` hashes the series name instead, so a
    series keeps its colour when its neighbours come and go.

    Only applied to panels whose type is in the modern vocabulary. A `graph` or
    `singlestat` panel's colour does not come from `fieldConfig` at all - it
    comes from Grafana's load-time migration of the old model - so writing the
    field there would either be a no-op that looks like a fix, or a collision
    with the migrator. Those panels are listed as deliberately left; see
    docs/guide/monitoring.md.

 7. Gaps are gaps: `nullPointMode` back to `null`, `spanNulls` back to false. The
    Cadvisor import shipped `"null as zero"` on its CPU and both memory panels,
    which means a container that stopped reporting draws a cliff to the floor -
    a shape the data never had, on the three panels somebody opens when a
    container is behaving oddly. There is exactly one correct value, so this is a
    rewrite and not a complaint.

 8. A second y-axis that nothing is drawn on is switched off. The old `graph`
    panels declare two axes and give the right-hand one a different unit, then
    put no series on it - so the file claims two scales and the panel shows one.
    Switching it off costs a reader nothing and makes rule 9 able to mean what it
    says.

 9. A colour ladder that no value can move is removed, and only where the colour
    is actually drawn. Two cases, both provable from the file:

      · the ladder has no numeric step at all, so the colour is unconditional -
        Node Exporter Full's `Speed` and `MTU` bargauges are permanently green,
        and the Postgres import's `Version` singlestat prints the server version
        in status green. A colour that cannot change is decoration, and the one
        palette that may never be decoration is the status palette.

      · every numeric step lies outside the field's own declared min/max, so no
        reading can reach it. `Pressure` is `percentunit` with `max: 1` and steps
        at 70 and 90 - 7000% and 9000% - so a PSI bargauge has been permanently
        green since it was imported. That is the dataviz note's own dead end
        ("a measurement that cannot fail is not a measurement") wearing a gauge.

    The replacement is one neutral base step, so the bar draws in the text colour
    and claims nothing. Panels whose `options.colorMode` is already `none` are
    left alone: their ladder is inert, so clearing it would be churn with no
    visible effect, and Node Exporter Full's five `stat` panels are all in that
    state. What this does NOT catch is a ladder somebody typed numbers into that
    are nonsense anyway - `RootFS Total` is red above 70 BYTES - because a typed
    number cannot be proven unintended, and a hand edit to an upstream import is
    lost on the next re-import. Those are listed in docs/guide/monitoring.md.

RULE THAT IS CHECKED AND NEVER AUTO-FIXED, because fixing it needs a person.

10. No series is actually drawn against a second scale: no `axisPlacement:
    right`, no `seriesOverrides` entry with `yaxis: 2`, no override putting a
    field on a right axis. Two measures on two scales lets whoever drew it choose
    where the lines cross, so the reader is looking at a decision rather than at
    the data - and the fix is to SPLIT the panel in two, which is a judgement
    about what the two halves are for. This was already true of all five
    dashboards when the rule was written; the job is to keep it that way.

Usage:
    scripts/normalise-dashboards.py            # rewrite in place
    scripts/normalise-dashboards.py --check    # exit 1 and say what is wrong
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DASHBOARDS = os.path.join(ROOT, "monitoring", "dashboards")

REFRESH = "1m"
TIMEZONE = "browser"
GRAPH_TOOLTIP = 1

# uid -> type, for the datasources monitoring/provisioning/datasources/datasources.yml
# provisions. Keep this in step with that file; scripts/checks/dashboards.sh
# asserts the two agree rather than trusting this copy.
DATASOURCES = {"prometheus": "prometheus", "loki": "loki"}

# Grafana's own pseudo-datasources. Not ours to rewrite, and rewriting the
# annotation one would delete the built-in annotations layer.
BUILTIN_UIDS = {"grafana", "-- Grafana --", "-- Mixed --", "-- Dashboard --", "__expr__"}

# Panel types whose colour lives in fieldConfig. Rule 6 applies to these only.
MODERN_PANELS = {
    "timeseries", "barchart", "stat", "gauge", "bargauge", "table", "piechart",
    "heatmap", "histogram", "state-timeline", "status-history", "xychart",
    "trend", "candlestick", "alertlist", "logs",
}


def walk_panels(dash):
    """Every panel, including the ones nested inside collapsed rows."""
    stack = list(dash.get("panels") or [])
    for row in (dash.get("rows") or []):          # schemaVersion < 16 shape
        stack.extend(row.get("panels") or [])
    while stack:
        p = stack.pop()
        yield p
        stack.extend(p.get("panels") or [])


def ds_target(ref, var_types):
    """The object form this reference should take, or None to leave it alone.

    `var_types` maps a removed datasource VARIABLE's name to its type, so a panel
    that said `${ds_prometheus}` can be pointed at the real uid.
    """
    if ref is None:
        return None
    if isinstance(ref, str):
        name = ref
    elif isinstance(ref, dict):
        if ref.get("uid") in BUILTIN_UIDS or ref.get("type") == "datasource":
            return None
        name = ref.get("uid") or ""
    else:
        return None
    if name in BUILTIN_UIDS:
        return None
    bare = name.strip()
    if bare.startswith("$"):
        bare = bare.lstrip("$").strip("{}")
        t = var_types.get(bare) or var_types.get(bare.lower())
        if t is None:
            return None
        return {"type": t, "uid": t}
    low = bare.lower()
    if low in DATASOURCES:
        return {"type": DATASOURCES[low], "uid": low}
    return None


def normalise(dash):
    """Apply rules 1-6. Returns a list of the changes made, as strings."""
    changed = []

    if dash.get("refresh") != REFRESH:
        changed.append("refresh %r -> %r" % (dash.get("refresh"), REFRESH))
        dash["refresh"] = REFRESH
    if dash.get("timezone") != TIMEZONE:
        changed.append("timezone %r -> %r" % (dash.get("timezone"), TIMEZONE))
        dash["timezone"] = TIMEZONE
    if dash.get("graphTooltip") != GRAPH_TOOLTIP:
        changed.append("graphTooltip %r -> %d" % (dash.get("graphTooltip"), GRAPH_TOOLTIP))
        dash["graphTooltip"] = GRAPH_TOOLTIP

    if "__inputs" in dash:
        changed.append("dropped the __inputs import-wizard envelope")
        del dash["__inputs"]

    # Rule 5 first, so rule 4 knows what `${ds_prometheus}` used to mean.
    tmpl = (dash.get("templating") or {}).get("list")
    var_types = {}
    if tmpl:
        keep = []
        for v in tmpl:
            if v.get("type") == "datasource":
                q = v.get("query")
                t = q if isinstance(q, str) else (q or {}).get("type") or "prometheus"
                var_types[v.get("name", "")] = t
                changed.append("dropped the %r datasource picker" % v.get("name"))
                continue
            keep.append(v)
        dash["templating"]["list"] = keep

    def fix_ref(holder, key):
        want = ds_target(holder.get(key), var_types)
        if want is not None and holder.get(key) != want:
            changed.append("datasource %s -> %s" % (json.dumps(holder[key]), want["uid"]))
            holder[key] = want

    for v in (dash.get("templating") or {}).get("list") or []:
        fix_ref(v, "datasource")
    for a in (dash.get("annotations") or {}).get("list") or []:
        fix_ref(a, "datasource")

    for p in walk_panels(dash):
        fix_ref(p, "datasource")
        for t in (p.get("targets") or []):
            fix_ref(t, "datasource")
        where = repr(p.get("title") or p.get("id"))

        if p.get("type") in MODERN_PANELS:
            col = ((p.get("fieldConfig") or {}).get("defaults") or {}).get("color")
            if isinstance(col, dict) and col.get("mode") == "palette-classic":
                col["mode"] = "palette-classic-by-name"
                changed.append("panel %s colours by rank -> by name" % where)

        # Rule 7, both vocabularies.
        if p.get("nullPointMode") in ("connected", "null as zero"):
            changed.append("panel %s drew gaps as %r -> null" % (where, p["nullPointMode"]))
            p["nullPointMode"] = "null"
        custom = ((p.get("fieldConfig") or {}).get("defaults") or {}).get("custom")
        if isinstance(custom, dict) and custom.get("spanNulls") is True:
            changed.append("panel %s spanned nulls -> false" % where)
            custom["spanNulls"] = False

        # Rule 8. `yaxis: 2` in seriesOverrides is the only way a graph panel
        # puts something on the right-hand axis, so if none does, nothing is
        # drawn there and the axis is decoration claiming to be a scale.
        ys = p.get("yaxes")
        if isinstance(ys, list) and len(ys) == 2 and ys[1].get("show"):
            used = any(so.get("yaxis") == 2 for so in (p.get("seriesOverrides") or []))
            if not used:
                changed.append("panel %s had an empty second y-axis -> hidden" % where)
                ys[1]["show"] = False

        # Rule 9.
        if p.get("type") == "singlestat" and not (p.get("thresholds") or "").strip():
            for key in ("colorValue", "colorBackground"):
                if p.get(key):
                    changed.append("panel %s coloured its value with no threshold -> off" % where)
                    p[key] = False
        if p.get("type") in ("gauge", "bargauge") or (
                p.get("type") == "stat" and (p.get("options") or {}).get("colorMode") not in (None, "none")):
            fd = (p.get("fieldConfig") or {}).get("defaults") or {}
            thr = fd.get("thresholds") or {}
            steps = thr.get("steps") or []
            nums = [s["value"] for s in steps if isinstance(s.get("value"), (int, float))]
            lo, hi = fd.get("min"), fd.get("max")
            dead = not nums or all(
                (hi is not None and v > hi) or (lo is not None and v < lo) for v in nums)
            neutral = [{"color": "text", "value": None}]
            # `steps != neutral` so a panel that was DELIBERATELY given one
            # neutral base step - the way `Host headroom` says "this is a reading,
            # not a verdict" - is not reported as a violation of a rule it is
            # already the answer to. Without it the fix is a no-op that prints.
            if steps and dead and steps != neutral:
                changed.append("panel %s had a colour ladder nothing can move -> neutral" % where)
                thr["steps"] = list(neutral)
    return changed


def audit(dash):
    """Rule 9. Returns a list of violations, as strings. Never fixes."""
    bad = []
    for p in walk_panels(dash):
        where = repr(p.get("title") or p.get("id"))
        custom = ((p.get("fieldConfig") or {}).get("defaults") or {}).get("custom") or {}
        if custom.get("axisPlacement") == "right":
            bad.append("panel %s puts its axis on the right - one y-axis, always" % where)
        for ov in ((p.get("fieldConfig") or {}).get("overrides") or []):
            for prop in (ov.get("properties") or []):
                if prop.get("id") == "custom.axisPlacement" and prop.get("value") == "right":
                    bad.append("panel %s draws a series against a second scale - split the panel" % where)
        for so in (p.get("seriesOverrides") or []):
            if so.get("yaxis") == 2:
                bad.append("panel %s draws a series against a second scale - split the panel" % where)
    return bad


def main(argv):
    check = "--check" in argv
    files = sorted(f for f in os.listdir(DASHBOARDS) if f.endswith(".json"))
    if not files:
        print("FAIL  no dashboards found in %s" % DASHBOARDS)
        return 1

    problems = 0
    for name in files:
        path = os.path.join(DASHBOARDS, name)
        with open(path, encoding="utf-8") as fh:
            original = fh.read()
        dash = json.loads(original)

        changed = normalise(dash)
        violations = audit(dash)

        # indent=2 + ensure_ascii=False is byte-identical to what all four files
        # already are, so an untouched dashboard produces an empty diff and a
        # touched one produces a diff you can actually read.
        out = json.dumps(dash, indent=2, ensure_ascii=False) + "\n"

        if check:
            if out != original or violations:
                problems += 1
                print("FAIL  %s" % name)
                for c in changed:
                    print("        not normalised: %s" % c)
                if out != original and not changed:
                    print("        formatting differs from json indent=2")
                for v in violations:
                    print("        %s" % v)
            else:
                print("PASS  %s" % name)
            continue

        for v in violations:
            problems += 1
            print("FAIL  %s: %s" % (name, v))
        if out != original:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(out)
            print("WROTE %s" % name)
            for c in changed:
                print("        %s" % c)
        else:
            print("OK    %s (already normalised)" % name)

    if problems:
        print()
        print("%d dashboard(s) need attention." % problems)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
