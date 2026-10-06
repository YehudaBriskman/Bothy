# Status vocabulary

_Status as of 2026-09-23._

The words an interface is allowed to use about the health of a thing it is
watching, what each one means, and — the half that is usually missing — what each
one must never be allowed to mean.

This document exists because a status vocabulary rots in one direction only:
towards fewer words. Nobody ever adds a status they cannot justify. What happens
is that a word already on the page turns out to *nearly* fit a new case, the new
case is filed under it, and the word quietly becomes a bag. Nothing errors. The
page still renders. The only symptom is that a number on a dashboard stops being
worth reading, and by then nobody remembers which three things it is counting.

## The rules

**One status is one fact.** If two things land on the same word for different
reasons, that is two statuses wearing one name, and the count beside them is the
sum of two populations nobody asked for.

**A status must be decidable from evidence the interface actually has.** Not from
what the underlying system *could* tell you if it were asked differently, and
never from a plausible-sounding guess. Where the evidence is missing, the honest
status is "we do not know" — which is its own word, and is neither a pass nor a
fault.

**Write down which evidence, and which evidence you rejected.** The next person
will find a signal that looks better than the one you chose, and unless the
rejection is recorded they will adopt it and re-introduce the bug you avoided.

**Separate "is this a problem" from "is this running".** Most bad dashboards
conflate them. A thing can be not-running and completely fine; a thing can be
running and badly wrong. A status set that cannot say both is a status set that
will cry wolf.

**Anything that is not a claim about health stays out of the health maths.**
Out of the denominator, out of the percentage, out of the attention list. If it
is in the count, the count means something else.

**Absence of evidence is never evidence.** A fact the code did not resolve must
arrive as "unknown", not as "false". This is one character in most languages and
it is the difference between a quiet page and a page that has invented a claim.

**A new status needs a colour, a form and a word — and the colour may be a
reused one.** The palette is a set of volumes, not a set of labels
([colour](../foundations/colour.md)); adding a sixth status colour is usually
worse than giving two statuses the same hue and distinguishing them by shape.
See [iconography](../foundations/iconography.md) and
[component states](component-states.md).

**Every status gets a row in the truth table, including its boundaries.** Both
sides of every threshold, and the case that must *not* match. A new status
without new rows is a new status nobody is checking.

## What Bothy decided, and why

Bothy watches containers. Seven statuses, from
`apps/bothy-web/web/src/lib/discover.ts`, held by
`apps/bothy-web/checks/status-classifier.mjs`.

| Status | Word on screen | Colour | Form | Means |
|---|---|---|---|---|
| `up` | Up | `--st-up` | filled dot **with glow** · `CircleCheck` | Running, and healthy if it has a healthcheck |
| `starting` | Starting | `--st-warn` | filled dot with glow · `LoaderCircle` | Running, healthcheck has not passed yet |
| `down` | Down | `--st-down` | filled dot with glow · `CircleX` | **Meant to be up and is not.** The only alarm |
| `stopped` | Off / Stopped | `--st-off` | filled dot, no glow · `CirclePause` | Somebody switched it off, and it is meant to stay off |
| `done` | Done | `--st-up` | filled dot, **no glow** · `CheckCheck` | A one-shot that ran to completion. A success |
| `dormant` | Dormant | `--st-off` | **hollow** ring · `CircleDashed` | Put away: no run in a fortnight, nothing of its project running |
| `unknown` | Unknown | `--st-unknown` | filled dot, no glow · `CircleHelp` | We could not check. Neither a pass nor a fault |

`stopped` is the one word with two spellings, and that predates these two: the
health strip counts it as "off" because a strip is a row of one-word counts, and
rows, filters and detail pages say "Stopped". Recorded rather than papered over -
if it ever becomes a defect, the strip is the one that changes, because "off" is
the word the sentence beneath it uses.

Only `up` and `starting` and `down` are claims about whether something should be
running right now. `stopped`, `done` and `dormant` are not, and are excluded from
the denominator, the healthy percentage and the needs-attention list.

### done

**Means:** this container's job was to finish, and it finished cleanly.

**Decided from:** exit code 0, **and** a declaration that finishing is its job —
a sibling in the same compose project naming it with
`depends_on: <this>: service_completed_successfully`.

**Never means:** "it exited 0 and I think it looks like an init container."

**What was rejected, and why.** Checked field by field against the live socket
proxy on 2026-09-23:

- **The restart policy is not on the wire.** `restart: "no"` is the author
  saying "this finishes", and `/containers/json` does not carry it — the whole of
  `HostConfig` in that response is `{"NetworkMode": "…"}`. Only the per-container
  inspect has `RestartPolicy`, and that endpoint is deliberately unreachable from
  the browser because its body contains `Env`.
- **There is no lifetime to measure.** `Created` is creation, not start. A
  one-shot compose has restarted a dozen times looks months old.
- **`com.docker.compose.oneoff` is `False` on real init containers.** It means
  "started by `compose run`".
- **Nothing else separates the two cases.** A finished one-shot and a service
  somebody stopped by hand inside a live project are identical on state, exit
  code, health, ports, mounts and project liveness. Every heuristic that lands
  `keycloak-init` on `done` also lands a hand-stopped `oauth2-proxy` there, and
  calling a service somebody just switched off "Done" is the worse lie.

**The cost of that honesty, stated plainly.** Coverage is partial. A terminal
one-shot that nothing waits on — `keycloak-init` on this box — reads as `Off`,
because nobody has declared what it is. The fix is a declaration, not a cleverer
guess.

**Exit 143 is not done.** A one-shot killed by `SIGTERM` did not complete; it was
interrupted. It is `stopped`. The hand-drawn "completed" chip this status
replaced got that wrong for as long as it existed.

**Age does not make `done` less true**, so it is decided before `dormant`.
Dormancy is a claim about something that was supposed to keep running; applying
it to a task that was never supposed to keep running is a category error.

### dormant

**Means:** put away. Visible, quiet, not counted, not in the attention list.

**Decided from two facts, and it needs both:**

1. it exited **at least a fortnight ago**, and
2. **nothing** in its compose project is running or restarting.

**Never means:** "it exited non-zero a while ago so it probably does not
matter." Dormancy is about **age and abandonment**. The exit code is not
consulted, and must never be: a container that exits 255 today is `down` and
shouts, in any project, however dead the rest of it is. The truth table pins that
from both sides one row apart, and a mutant proves the check would catch its
removal.

**Why a fortnight.** The only risk that matters is a threshold too short, which
silences a real outage. Two weeks is longer than any plausible gap between
sessions on a personal box — longer than a holiday weekend, longer than a week
off. Fourteen days in which not one container of a whole project has run even
once is not downtime anybody is waiting out.

**And watch which half does the work over time.** `prometheus` and `promtail`
are rollback profiles, stopped on purpose. On 2026-09-23 they had been stopped
six days, so the age test alone kept them out of `dormant`. Thirteen days later
they had crossed the fortnight — and they are still `Off`, because nothing of
`monitoring` has been put away. Age goes stale by definition: everything crosses
a threshold if you wait. Abandonment is the half that actually tells a parked
service from a put-away one, and the age test is only there to stop a project
switched off this morning counting as history. Neither half may be dropped for
looking redundant.

**Where the age comes from.** Docker's human `Status` string
(`"Exited (0) 6 weeks ago"`), for the same reason the exit code does: there is no
machine-readable finish time on `/containers/json`. Its resolution is coarse and
that is fine against a fortnight-scale threshold. An unparseable string yields
`null`, never `0` — a `0` would read as "it stopped just now" and keep a six-week
corpse out of `dormant` for good.

**A bare `docker run` container is its own project of one.** Containers with no
compose project label are not a crowd; `thales-scc` (up) and `mpeg-redis` (dead
six weeks) share nothing but the absence of a label, and keyed together the live
one would vouch for the dead one forever.

**A crash loop keeps its project alive.** `restarting` counts as running, so the
siblings of something flapping are never hushed.

### What the health strip says

The strip states the measured population as a fraction, then names — separately,
in words — everything the fraction leaves out, and says why it is left out. The
sentence "29 up · 19 off" was the defect: one number called "off" holding two
parked services, one successful init container and ten containers from projects
nobody had run in six weeks. A reader has no way to check a fraction that
silently excludes a third of the box.

### Related

[Colour](../foundations/colour.md) · [Iconography](../foundations/iconography.md)
· [Component states](component-states.md) ·
[Data display](data-display.md) · [Decisions](../reference/decisions.md)
