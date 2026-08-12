# Content and microcopy

_Status as of 2026-08-10._

## The rule

**Sentence case** for headings, buttons and labels.

**Buttons are verbs, and the verb names the outcome.** "Open system page", not
"Details".

**One error formula:** what happened, why if you know, what to do next. Never
just "invalid". Never blame the user. Never surface a raw exception, stack trace
or bare status code - those are for the console, not the interface.

**Never say "unknown" when the truth is "we have not checked".** Name whose
knowledge is missing. This distinction sounds pedantic and is not: a user
reading "unknown" assumes the system looked and could not tell, which is a much
stronger claim than "nobody asked".

**One word per concept, with a written boundary.** Keep a vocabulary table and a
banned-synonym list. The state words are the ones that always drift.

**Empty-state copy names the reason and the next action.**

**Numbers.** Never show more precision than the source has. Choose binary or
decimal byte units, say which, and unit-test the formatter. One duration format.
State the rounding rule for percentages, and never round up to 100 percent -
"100%" when one thing is broken destroys trust in every other number on the page.

**Relative times for recency, absolute available.** "3 minutes ago" is what you
want to read; the timestamp is what you need when you are correlating.

**Any claim that could go stale carries a date.**

## Checklist

See [CHECKLIST.md § 21](../CHECKLIST.md#21-content-and-microcopy).

## What Bothy decided, and why

**The vocabulary table is in
[brand-core](../foundations/brand-core.md#what-bothy-decided-and-why)**, because
the state words *are* the brand's vocabulary. The boundaries between `up`,
`down`, `stopped`, `unknown` and `starting` are load-bearing and were written
down after they were got wrong.

**"Unknown" is honest here.** Several routes point at host processes with no
container to inspect. They are reported as `unknown`, with the reason stated in
the interface - not as `up`. An earlier version guessed `up`, which was wrong for
every dead one.

**Denominators are explained in place.** "15 / 22 services up · 5 stopped" -
the stopped count sits beside the fraction it is excluded from, because a number
whose denominator is surprising needs its denominator stated.

**Empty states name the reason.** "No services match these filters" gets a Clear
button; "No services discovered" does not, because there is nothing to clear.

**Guard degenerate values.** A size field can arrive as -1 when the source did
not compute it, and formatting that naively rendered literally as "NaN
undefined" on the page.

**Sentence case throughout, no emoji, no exclamation marks.**

## Dead ends

- **Reporting an unverified service as `up`.** See above and
  [dataviz](../patterns/dataviz.md) - the probe could not express failure.
- **Collapsing "exited cleanly" into "down".** Five containers and six routes
  became alerts, none of which was a problem.

## How this is verified

- Lint for title case in headings and buttons.
- Grep for placeholder copy.
- Unit-test the byte, duration and percentage formatters, including the
  degenerate inputs.
