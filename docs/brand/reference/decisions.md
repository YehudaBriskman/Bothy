# Decision log

_Status as of 2026-08-10._

Dated decisions, with the alternatives considered and what each cost. Newest
first. Dead ends are recorded rather than deleted — see
[governance](../quality/governance.md).

---

## 2026-08-10 — Rebuild the global quick view instead of deleting it

**Decision.** Reinstate the at-a-glance stat row as five tiles backed by real
metrics — CPU, memory, disk, network, uptime — and put it *below* the services
status line.

**Why the deletion was wrong.** Collapsing the hero removed five stat cells that
were each redundant or dead, and that was correct about the *answers*. It was
wrong about the *questions*: "is the disk filling up" and "is the box busy" are
exactly what a glance is for, and after the deletion neither had an answer above
the fold. Removing a bad answer is not the same as deciding the question does
not matter.

**What makes the new one different.** Every tile is backed by a metric with real
history rather than restating a number already on screen; disk means the **host
filesystem** ("is the box about to run out"), which is a question that 2.9 GB of
docker volumes cannot answer; and the tiles own "now" while the charts below own
history, so the chart headers no longer print the current value.

**Two rules that came out of it.**

- **Capacity metrics get a meter, rate metrics get a sparkline.** Memory and disk
  are capacities — "how close to full" — which a meter answers and a line does
  not. CPU, network and load are rates: nothing is filling up, and the question is
  the trajectory. "Bounded" is the wrong test, because CPU is bounded 0–100 and
  still wants a line — a bar under a tile that already prints "25%" re-encodes the
  number it sits beneath and adds nothing.
- **A quick view of the machine and a status line about the services are two
  different scopes.** A "services" tile lived in the strip briefly and restated,
  one row above it, exactly what the status line says in words.

---

## 2026-08-10 — Turn the system matrix's headings into row labels

**Decision.** Dissolve the three stacked group headings into a single grid with a
`max-content` label column, so each group is one line instead of two.

**Why, measured.** The block was 209px × 1260px — the largest on the page — and
its three chip rows were only **41%, 53% and 28% full**. Six lines of layout for
thirteen items, with more than half the area empty beside the chips. Meanwhile
the cell breakdown it encodes (15 up, 7 unknown, 5 stopped) is stated in words by
the status line directly above it, so the block's only unique contribution is
*which* system each state belongs to.

**Result.** 209px → **117px**, rows 51/67/36% full, and each chip gained a
service count — a second dimension, since eight cells and nine cells are the same
shape at a glance.

**Two failures on the way, both about guessing at a width.** A fixed 92px label
column clipped "INFRASTRUCTURE" and pushed its badge onto a second line, making
that row taller than the other two — the exact raggedness the change existed to
remove. Fixed by making the whole matrix one grid (`display: contents` on the
groups) so the column is `max-content` and identical on every row. Then at 390px
that same column ate 36% of the viewport and the matrix grew to 522px; below
760px the label goes back above its row, which brings it to 362px.

**The general rule:** a label column is a wide-screen optimisation. It must hand
the width back when there is not any.

---

## 2026-08-10 — A tile unit for dashboard cards, and a footer on every one

**Decision.** Declare one tile height for the Overview's card grid; every card is
exactly one unit or a multiple. Give every card a summary footer.

**Why.** The row read as ragged because each card sized to its own content —
panels were `align-items: start` with a `max-height` on their bodies, so a
short list and a long one ended at different heights. Separately, the network
chart was ~22px taller than the CPU and memory charts *purely because it had a
legend row*.

**The insight worth keeping.** A card footer is structural, not decoration.
Either every card in a row has one or none does, because a footer changes the
height. Adding one to all of them fixed the alignment and answered a second
question at the same time: what is actually in this card. Each chart now carries
`now · peak · avg`, and the container list carries `top 6 of 15 running · cpu
0.38 cores · mem 3.6 GB`.

**A bug found on the way.** `topk` in a **range** query is evaluated at every
timestamp, so a container briefly in the top N appears in the result — topk(6)
returned 7 distinct series and made a "top 6" label false. The queries now fetch
every container and rank in the client, which also fixed a second symptom: with
topk on both metrics, a container in the memory top 6 but not the CPU top 6 had
no CPU value to pair with, and rendered a blank cell.

---

## 2026-08-10 — Collapse the Overview hero to one line

**Decision.** Replace the 160px hero card and its five stat cells with a single
status line, and delete the session sparkline and the ring buffer behind it.

**Why — it contradicted itself.** With 7 services `unknown`, the page showed
"Healthy 68%" beside "Needs a look: none" and "Everything meant to be running is
up", all within six pixels. `unknown` means *we have not checked* — those are the
host routes with no container to inspect — so it is neither a pass nor a fault,
and the old copy silently treated it as both: excluded from the attention count,
included in the healthy denominator. The biggest number on the page said a third
of the box was not OK while the sentence under it said everything was fine.

**Why — it also failed the footprint rule.** The hero stated one ratio four
times: a 46px number, a part-to-whole bar, a written legend, and a "Healthy %"
cell. Two of the remaining cells duplicated things visible on the same screen
(`Systems` is countable in the matrix directly below; `Data` repeated the Data &
disk panel header). `Trend` had been dead since real metrics arrived.

**What replaced it.** `15 up · 7 unverified · 5 off`, the bar, and one sentence
scoped to what actually reported in: "All 15 services that report in are up.
7 can't be verified — host routes with no container to ask."

**Cost and result.** 160px to 55px. The vitals charts moved above the fold. The
section's three responsive breakpoints collapsed to one. `Sparkline` and
`PortalData.history` were deleted as dead code rather than left orphaned.

**The general lesson.** Adding a genuinely better instrument does not
automatically retire the worse one that was standing in for it. The sparkline
survived the arrival of real time series by three hours purely because nobody
re-asked whether it still earned its space.

---

## 2026-08-10 — Repaint to a neutral dark scheme

**Decision.** Replace the navy-tinted palette with a neutral one, delete the two
coloured background orbs, and make surfaces opaque.

**Alternatives.** Keep the navy and re-tune contrast only; or adopt a component
library's theme wholesale.

**Why.** The old surfaces were blue-tinted and semi-transparent over a blue
radial glow, which meant the same card rendered a different colour at the top of
the page than at the bottom. An elevation ladder whose steps depend on position
is not a ladder. Removing the transparency also made the backdrop blurs
no-ops, so they went too.

**Cost.** Every surface value changed at once. Mitigated by everything already
being a token.

---

## 2026-08-10 — Adopt Radix for behaviour, not for appearance

**Decision.** Take a dependency for the dialog. Keep hand-written CSS and the
existing token system. Do not adopt a utility-CSS framework.

**Alternatives.** Full framework plus component kit; or hand-roll the dialog.

**Why.** The parts of a dialog that are hard are focus trapping, focus return,
Escape, scroll lock and portalling — exactly the parts hand-rolling gets subtly
wrong. The parts that are easy are layout and appearance, which is what a
framework would have taken over. Adopting the framework would have meant two
styling systems coexisting through a long migration for no behaviour gain.

**Cost.** One dependency. Three other packages were installed during exploration
and removed once unused.

---

## 2026-08-10 — Validate the chart palette rather than choosing it

**Decision.** Run every categorical palette through five checks per theme, and
treat slot order as part of the validated result.

**Why.** The intuitive blue→teal→amber→purple→rose ramp fails on dark: every hue
sits above the dark lightness band and glares. The first reordering attempted to
fix a colour-vision-deficiency adjacency and made it worse, putting orange beside
rose at ΔE 9 for *normal* vision.

**Cost.** The palette cannot be casually reordered. Recorded in the CSS beside
the values.

---

## 2026-08-10 — Rename the product to Bothy

**Decision.** Replace `dev.test / dev box` in the topbar with a product name and
a run-time hostname.

**Why.** The old wordmark named the product after a DNS name dormant since
2026-08-08. Nine candidate names were checked against existing software first;
six were taken.

**Cost.** None to the machine's own naming — "dev box" is still correct
everywhere it refers to the machine, and was deliberately not renamed.

---

## 2026-08-10 — Add a generated Prometheus route rather than a committed one

**Decision.** Generate the edge config that carries the metrics credential from
the environment, gitignore it, and commit a comments-only example.

**Why.** The browser cannot hold a credential and the repository is public.

**Dead end, paid for immediately.** The first version of the example was live
YAML declaring the same router and middleware names as the real file. The file
provider merges every file in the directory, so the example overwrote the real
credential with its placeholder — every query returned 401 while the router still
reported "enabled". Examples in a watched directory must be comments-only.

---

## 2026-08-10 — Own scroll restoration

**Decision.** Reset to top on a new navigation, restore on Back, in application
code.

**Alternatives.** The router's built-in restoration — unavailable for this
router configuration.

**Two dead ends, both of which produced a feature that looked implemented.**
First, restoring into a page that has not finished growing gets clamped, so the
restore silently half-works. Second, and worse: the programmatic scroll-to-top
dispatches its event *after* the framework re-binds the save listener, so it
overwrote the offset it was about to need. Both are documented in
[patterns/scrolling.md](../patterns/scrolling.md).

---

## 2026-07-29 — Delete the reveal-on-scroll animation

**Decision.** Remove it, and adopt the rule that entrance animations must start
from a visible resting state.

**Why.** It defaulted content to invisible and relied on an observer to switch
it on. It shipped a near-blank page twice.

**Cost.** None. The replacement animates from visible.

---

## 2026-07-29 — Delete the browser reachability probe

**Decision.** Report host-process routes as `unknown` rather than probing them.

**Why.** A no-cors fetch resolves for any status, so 502 and 401 both reported
"up". The probe could not physically return "down".

**Cost.** Five services now honestly say "unknown" instead of dishonestly saying
"up".

---

## 2026-07-29 — One cell per service, not one card per system

**Decision.** Replace the card grid with a matrix.

**Why.** Fourteen cards, eight of which said "1 / 1 running, 100 percent
healthy". This produced the footprint rule in
[principles](../foundations/principles.md).

**Cost.** Per-system pinning was dropped with the cards.
