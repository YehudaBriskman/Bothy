# Data visualisation

_Status as of 2026-08-10._

How a number is drawn so that it cannot lie.

## The rule

**Pick the form from the data's job**, not from the chart menu: magnitude
comparison, identity, part-to-whole, change over time, or a single headline
number. Sometimes the right answer is not a chart - a large number with a label
beats a chart of one value.

**One y-axis. Always.** Two measures on two scales lets whoever drew it choose
where the lines cross, which means the reader is looking at a decision rather
than at the data. Two measures of different units get two charts.

**Colour follows the entity, never its rank.** A filter that changes the series
count must not repaint the survivors. Never assign by array index.

**Legend for two or more series, plus direct labels.** A single series needs no
legend - the title names it. Beyond that, identity must not be colour-alone.

**Status colours are not series colours**, and series colours never encode
status. See [principles](../foundations/principles.md).

**Two graphics within sight of each other must agree on their denominator.**
This is the most common way a dashboard lies without anyone intending it.

**Values excluded from a measurement are drawn detached and labelled as not
counted** - not silently dropped, and not folded in.

**Gaps are gaps.** A missing sample is not zero. Plotting it as zero draws a
cliff that never happened.

**Every chart needs an accessible name that states the actual numbers**, and
tooltips that open on keyboard focus as well as hover.

## Checklist

See [CHECKLIST.md § 16](../CHECKLIST.md#16-data-visualisation).

## What Bothy decided, and why

**No chart library.** The charts are SVG - a polyline, a polygon and some text.
A library was rejected at roughly 40KB for what a few dozen lines of geometry
do. The threshold at which that trade flips is roughly: more than two chart
types, or any need for axes with real tick algorithms, or interaction beyond a
crosshair.

**The palette and its slot order are validated**, and the slot order is
load-bearing. See [colour](../foundations/colour.md) for the full reasoning and
the caveat about slots 2 and 3.

**Slots are assigned explicitly** - CPU is slot 1, memory slot 4, network in and
out are slots 1 and 3. The network pair deliberately skips the adjacent pair,
which measures ΔE 6.3 under tritanopia, in favour of a pair measuring 31.5.

**Three separate single-measure charts, not one chart with three lines.** CPU is
a percentage, memory is a percentage and network is bytes per second. Putting
them on one plot would require two scales.

**Part-to-whole is a stacked bar, not a donut.** It reads at any width, stacks
honestly, and puts segments in a fixed order so two bars can be compared by eye.

**The denominator rule was learned twice, the hard way.** The status line prints
counts whose whole excludes deliberately stopped services. The bar beside it was
originally fed all five statuses including stopped - so two graphics six pixels
apart claimed different totals, and a box with two idle projects showed a bar
that looked two-thirds full beside a number that said 100 percent. The bar now
takes an explicit "outside the whole" list, drawn detached and hollow.

The second time was worse and is recorded in
[decisions.md](../reference/decisions.md): the same block showed "Healthy 68%"
next to "Everything meant to be running is up", because `unknown` services were
excluded from the fault count but included in the healthy denominator. **A
percentage and a sentence about the same population must be derived from the same
population.** If one of them treats a state as "not a problem" and the other
treats it as "not healthy", they will disagree in public.

**The rate window is 2 minutes, not the step.** A 15-second step with a
15-second window has at most one sample per window and produces a sawtooth that
looks like real volatility.

**Honest cold start - and then retire the stopgap.** A session-only sparkline
used to say "collecting" below two samples rather than draw a flat line, which
was the honest thing for a ring buffer held in the tab. It was deleted on
2026-08-10, hours after real time series arrived: a stopgap that is honest is
still a stopgap, and keeping it alongside the real instrument gives a reader two
sources for one kind of answer, one of which is always empty on load. **When a
better instrument lands, re-ask whether the old one still earns its space.**

## Dead ends

- **A donut for part-to-whole.** Harder to compare, worse at small widths.
- **Feeding the bar every status while the number beside it excluded one.** See
  above - the two graphics disagreed in public.
- **A no-CORS reachability probe** as a data source. An opaque response resolves
  for *any* status, so 502 and 401 both reported as "up". It could not physically
  return "down" while the proxy was answering. Unrelated to charting, but the same
  lesson: a measurement that cannot fail is not a measurement.

## How this is verified

- Re-run the palette validator whenever the palette or its order changes.
- Assert a legend and direct labels exist on every multi-series chart.
- Check every chart's accessible name contains numbers.
- Look at the charts through a colour-vision-deficiency simulator.
