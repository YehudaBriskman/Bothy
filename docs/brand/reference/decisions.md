# Decision log

_Status as of 2026-10-08._

Dated decisions, with the alternatives considered and what each cost. Newest
first. Dead ends are recorded rather than deleted - see
[governance](../quality/governance.md).

---

## 2026-10-08 - "No toasts" is amended: a persistent handle, not a transient notice

**The decision being amended** is in [feedback](../patterns/feedback.md): *"No
toasts. The product's actions all have visible local results… Nothing needed a
transient overlay, and one would have been a second, competing error channel."*
That reasoning was right about the thing it was about, and it is kept. What it
did not cover arrived with the update job.

**What changed.** An update job runs **on the host**, for one to twenty minutes,
and it survives the tab. The owner's words: *"compleate sepurations that we can
actualy see the live actions happening in all of the app pages… in all the other
places itll be flowting in the side as circle or something in some corner or
something and in hover itll get opened to see more of that."* There is no local
result to show, because the thing is not local and not finished. Settings >
Updates is the only page that could show it, and watching a deploy is precisely
when somebody is on another page looking at what it is doing to the box.

**So the amendment is narrow, and it is about the two properties that make a
toast a toast:**

| | A toast | The activity dock |
|---|---|---|
| What it reports | something that **already happened** | something **still happening** |
| How it goes away | a timer | the host finishing, then **Dismiss** |
| How many | a stack, capped | **one**, because one job is followed |
| What it is | its own channel | the **same component** as the page's rail, same store |

Nothing here auto-dismisses, and that is the load-bearing difference: the
original decision's stated cost was *"an error that exists only in a toast that
has already faded did not get reported"*, and a surface that never fades cannot
incur it. The outcome stays on screen until somebody dismisses it, and the full
record is in the history table and in the host's `history.jsonl` either way - so
it is not the only record of anything.

**It is not a second error channel either**, which was the other stated cost.
It is `components/UpdateActivity.tsx` in its second presentation: the same store,
the same state words, the same glyphs and the same tone as the rail down the side
of Settings > Updates. A reader who opens it from the corner and then opens the
page sees one thing twice, not two things that might disagree - and on
Settings > Updates the dock is not drawn at all, because the rail **is** it.

**What is still refused, for the original reasons.** No transient overlay for
anything that has a visible local result: a save, a refresh, a restart, a theme
change, a copied command. No stack. No timed dismissal anywhere. And nothing
mounts when nothing is happening - *"an idle orb is a perpetual loop for an idle
thing"* holds, so there is no dock, no dot and no grey circle on an idle box.

**Rejected on the way:**

- **A toast, properly.** It would have had to re-announce itself per page, or
  live in a store anyway - at which point it is this, with a timer bolted on and
  the step list thrown away mid-deploy.
- **The rail on every page.** It is 21rem of every page for something that is
  usually not happening, and Control and Files have no spare column.
- **A tooltip or a detail hint on the orb.** Disqualified by its own contents:
  the card carries Dismiss and a link, and *"the moment the detail contains
  something to press, it stops being a hint"*. It is a disclosure with a named
  toggle, and Escape returns focus to it.
- **Hover as the only way in.** The owner asked for hover and hover is honoured
  for a mouse - but it opens on focus and on a tap too, each gated so a touch tap
  reaches the toggle rather than being eaten by a hover that opens and shuts in
  one gesture. That is the defect that disqualified `components/Tooltip.tsx` for
  the detail hint, and it would have been the same defect here.

---

## 2026-10-08 - The Settings nav folds, and the default is not a constant

**Decision.** The six groups of the Settings nav fold. On arrival exactly one is
open: the one holding the page you are on. What you fold or unfold after that is
remembered per browser, under a key of its own,
`bothy-settings-groups-v1`.

**Why not a list.** The obvious shapes both say the wrong thing, because unlike
every other fold in this app the default here is not a constant:

- a list of the groups you **closed** makes absence mean open, so a fresh browser
  draws all six - the state the owner asked to be rid of - and the first fold
  implicitly opens the other five forever;
- a list of the groups you **opened** cannot record a fold of the group you are
  standing in (its toggle would be a control that visibly does nothing), and it
  accumulates: arriving at a section would have to write its group in, so a
  reader who browsed the area would end up with everything open again.

So the stored value is an **opinion per group**, with a third state for "no
opinion", and `groupOpen()` in `lib/prefs.ts` is the one place the default lives.
A reader who never presses a toggle never writes anything and always sees exactly
one group open. An opinion that has become the default is deleted rather than
written back, which is SettingBlock's "remember the change, not the default"
applied to a default that moves.

**Arriving in a group clears a fold on it** - a pasted link, a Back button or a
hit from "Search settings" always lands somewhere the nav can show, rather than
changing the page and the breadcrumb while the nav shows no "you are here" at
all. A reload is an arrival. That makes a fold of the current group good until
you leave and come back, which is the whole rule in one sentence: *the group you
arrive in is open.*

**The key is new on purpose.** `bothy-settings-nav-v1` is taken, and despite its
name it holds **block** state. A nav value written there would parse cleanly as a
list of collapsed blocks called `you`, `look`, `data`... and quietly fold things
on four pages. Same trap `lib/collapse.ts` records about `portal-open-groups`.

**Cost.** The "N behind" count beside Updates is now behind a fold unless you are
in **This box** (the same count is in the user menu, on every page). The group
heading became a `<button>`, so it is registered as a row control in
`checks/design-tokens.mjs` and takes the shared row press state. The fold itself
is `ui/Disclosure` - the one place a `grid-template-rows` transition is allowed -
so collapsed links are `inert` and genuinely off the Tab order rather than merely
invisible.

**It is a toggle and not also a link.** A group has no page (the registry gives it
an id and a title), and a target that both navigates and folds is the one nav
mistake trying again does not recover from: whichever you wanted, you get the
other half the time.

---

## 2026-10-08 - The mark is drawn twice, and the second one is declared

The Bothy mark existed in two geometries and nothing in the repo compared them.
`public/favicon.svg` and its sibling `public/icon-maskable.svg` are a **solid
silhouette** - door arch radius 3, three hard colours. `components/Brand.tsx` is
a **2px `currentColor` outline** - arch radius 1.85, a different roof pitch, and
walls 0.6 of a unit further in. Four statements said otherwise: the favicon's own
comment, the comment in `index.html`, the comment in `Brand.tsx`, and
[logo-and-app-icons](../foundations/logo-and-app-icons.md), which claimed the
geometry lived in "exactly three places, all generated from the same numbers".

**The silhouette is the source, and it was not a close call.** Every icon that
ships is the silhouette - established by decoding all four committed PNGs and
measuring the mark inside them, not by reading the comments. The outline, by
then, had exactly one live surface left: the 72px watermark at 13% opacity in the
Files empty state. The topbar lockup has carried no mark at all since
2026-08-18; it is the wordmark alone. So the question "which rendering is the
brand" had already been answered by what the files do, and the only thing
missing was anybody saying so.

**Both are kept, because the two jobs really do conflict.** At 16 device pixels
in a tab strip a 2px stroke fills in and the hut becomes a blob; a thin outline
at that size disappears. At 13% opacity over seven themes a filled mark is a grey
slab rather than a drawing, and it cannot inherit `currentColor` at all. Forcing
either onto the other was considered and rejected: it would have traded a
declared difference for a worse mark in one of the two places.

**So the deliverable is the declaration, not the reconciliation.** What both must
share - the 24-unit box, the apex at exactly `(12, 4.2)`, left-right symmetry, a
door centred on the mark and standing on that rendering's own ground line, a
semicircular arch of half the opening, exactly one accent element - is asserted
as equality. Every way in which they differ is written into a table in
[logo-and-app-icons](../foundations/logo-and-app-icons.md) **and pinned to that
value in the check**, so moving a coordinate in either file fails the suite until
the table is updated too. An undeclared difference is the thing that is banned;
a difference is not.

**A fourth copy was deleted, and it was the actual hazard.**
`apps/bothy-web/web/scripts/gen-icons.py` was a superseded standalone rasteriser
holding the **outline** coordinates and writing three of the four shipped
filenames. Running it, as its own docstring invited, would have overwritten three
live icons with a different logo in a different colour type. The generator that
reads the SVGs already existed one directory up, at `scripts/gen-icons.py`, so
the fix was deletion rather than teaching the duplicate to parse SVG. **The
general form is worth keeping: a generator that re-declares the geometry is a
second source of truth wearing a build step's clothes.**

**The verification claim was replaced because it had never been run.** The
document offered "re-run the generator and confirm the output is byte-identical".
That needs headless Chromium and a minute, so nobody ran it, and in fact the
committed PNGs did not match the generator that claimed them - different mark,
different colour type, different byte count. `checks/mark-geometry.mjs` decodes
each PNG with `zlib` instead and measures the ink and accent bounding boxes
against what the source SVG predicts, to two device pixels. It needs no build and
no browser, it runs in the offline suite, and it makes a stronger claim than a
byte diff: a byte diff only tells you the generator is deterministic.

**It also refuses a fifth copy.** No file outside the three may carry four or
more of the mark's coordinates. A rule phrased as "these three must agree" has
nothing to say about a fourth file nobody has heard of, which is exactly how the
deleted generator survived; this one is phrased the other way round. Restoring
that file fails the line with its own numbers printed back at it.

**The colour literals in `public/*.svg` stay literals.** Those files are static
assets the app never imports, and a favicon sits on the browser's tab strip where
there is no page theme to read - the tile is dark in both themes precisely
because a mark that inverts is a mark nobody recognises. `checks/stray-colour.mjs`
scans `web/src` only, so it never saw them; rather than widen its scope and have
to carve out an exemption, `mark-geometry.mjs` asserts the three values are equal
to the dark palette's `--bg`, `--fg` and `--accent`. That keeps them honest
without pretending the file can read a token.

**Not changed, deliberately.** `apple-touch-icon.png` is rasterised from the
maskable art, so the mark sits at 0.72 inside an opaque tile. That is right for
Android's circular crop and generous for iOS, which masks with a squircle and
needs far less inset - so the iOS icon is smaller than it has to be. It is a
legitimate design question, it is not a drift, and changing it would have altered
a shipped icon under cover of a consistency fix. Left alone and recorded here.

**Nothing visible changed.** Every path and every PNG is byte-identical before
and after; the before/after captures of the lockup, the watermark and the tab
icon at 16, 32 and 64px in both themes are indistinguishable, which is the
intended result.

### Dead ends

- **Making `Brand.tsx` derive from `favicon.svg`.** There is no derivation: an
  inward offset of the filled mark does not produce the stroked one, and the roof
  pitches differ by six degrees because a filled roof is a shape and a stroked
  one is a line with a 1-unit halo.
- **Teaching the duplicate generator to read the SVG.** Correct in isolation,
  wrong here - it would have left two generators writing the same four files.
- **Banning the literals in `public/*.svg`.** They have no theme to read. The
  honest version is an equality assertion against the tokens they are a snapshot
  of.

---

## 2026-10-07 - One tile is primary, the reader says which, and it never moves

Two dashboards here are uniform **by construction**. The Overview's quick-view
strip has fixed row tracks and emits its trend row even when it is empty, so all
five tiles are the same object; the Control landing's three glance cards are one
frame with one header. That uniformity is what makes them comparable, and it is
also why neither page has a most-important thing. A reader who opens the page
every morning for the disk reads five identical tiles every morning.

**Decision.** The reader marks one tile and one card as primary. The choice
persists per browser, on the existing `bothy-layout-v1` key and through the
existing `useLayout()` hook - the mechanism that already remembers hidden panels,
not a new store. `null` is the default and stays a first-class state.

**This is a new axis in this app, and it was worth checking that.** `is-primary`
on the Overview's quick links is *navigation* emphasis - which link is the way
in. `Tone` is *severity* - what the box is doing. Neither is importance to the
reader, and nothing else here was either. Saying so is the point: an axis nobody
names gets absorbed into the nearest one that nearly fits, which is exactly what
[patterns/status-vocabulary](../patterns/status-vocabulary.md) records happening
to status words.

**It is chosen, never derived.** A dashboard that promotes whatever is currently
worst re-draws itself under the reader, and the tile they came for is wherever
the box's mood put it. It also breaks
[space-and-layout](../foundations/space-and-layout.md)'s standing rule that
layout must not depend on measured state. A degraded metric is badged where it
stands, in the status vocabulary, and does not move.

**Emphasis is contrast, not geometry - and this was the argued one.** The
tempting version gives the primary tile two columns. It was rejected: the strip's
worth is that five tiles share one shape and can be read against each other, and
a tile of a different size has left that set. It also costs a six-column variant
at three breakpoints, which is the breakpoint tree
[space-and-layout](../foundations/space-and-layout.md) already records as a dead
end. So the primary tile keeps its cell and takes a spine, a step of surface and
the next type step; the primary card takes a spine and a raised header.

**The mark is `--accent`, by rule rather than in spite of it.** "The one I watch"
is a choice the reader made, not something the box is doing, so it belongs to the
chrome palette ([principles](../foundations/principles.md) rule 2). Painting it
`--st-warn` would make the card you chose and the card that is broken the same
colour - precisely the confusion rules 1 and 2 exist to prevent.

**The control is a toggle, not a radio group.** Pressing the tile that is already
primary clears it, so "none" stays reachable without a sixth control to reach it
with. The pin is drawn at rest on every tile rather than revealed on hover:
`.svc-act-btn` already paid for that lesson - an `opacity: 0` affordance was
unfindable by the person who had asked for the feature, and on a phone hover does
not exist at all.

**Cost.** Five tiles and three cards gained a control they did not have, which is
eight more things in the tab order on the Overview and the Control landing. A
stored id that a later build stops drawing is read back as `null` rather than as
itself, so a renamed tile loses the preference instead of leaving a strip with a
primary nothing matches - `checks/settings.mjs` holds both halves, including that
every id in the list is actually rendered.

---

## 2026-09-23 - Two more statuses, and a vocabulary rule to stop the next collapse

`up | down | starting | stopped | unknown`, collapsed by the health strip to
"up / off". That "off" was holding three unrelated facts at once, all of them
live on this box: two services parked on purpose, one init container reporting
success, and ten containers from projects nobody had run in four to six weeks.
`down` had the same problem from the other end - a crash five minutes old and a
six-week-old corpse were both alarms.

- **`done`** - a one-shot that ran to completion. **Decided from a
  DECLARATION**, compose's `service_completed_successfully` read off a sibling's
  `depends_on`, and from nothing else. **Rejected:** `restart: "no"` (not on the
  wire - `/containers/json`'s whole `HostConfig` is `{NetworkMode}`, and the
  inspect that carries `RestartPolicy` is unroutable to the browser because its
  body has `Env`); a short lifetime (`Created` is creation, not start);
  `com.docker.compose.oneoff` (`False` on real init containers); and every
  heuristic over health/ports/mounts/project-liveness, because a finished
  one-shot and a hand-stopped service in a live project are identical in every
  field the API returns. **Cost:** coverage is partial by design. A terminal
  one-shot nothing waits on reads as `Off`, and the fix for that is a
  declaration, not a cleverer guess.
- **`dormant`** - exited **a fortnight or more** ago **and** nothing of its
  compose project running. Both halves required. **The exit code is not
  consulted and must never be**: a crash today is `down` whatever owns it.
  **Rejected:** age alone (reaches `prometheus`, parked six days ago on
  purpose); abandonment alone (reaches the container that crashed on the way
  out of a `just down`). **Cost:** one magic number, argued in its own comment
  and pinned from both sides in the truth table.
- **No new colour.** `done` takes `--st-up` with **no glow**; `dormant` takes
  `--st-off` drawn **hollow**. **Rejected:** a sixth status token - the palette
  is a set of volumes, and the accent rule already forbids the only hue windows
  left. Form carries the distinction, which is the grammar the status dots
  already used.
- **Words: "Done" and "Dormant".** **Rejected:** "Completed"/"Finished" (longer,
  no clearer, and it has to fit a chip in a row of seven); "Idle" (implies
  running and unused - the opposite); "Stale" (already this app's word for an
  old backup and an old poll); "Abandoned" (a judgement about the reader rather
  than a fact about the container).
- **The rule itself is now written down**, in
  [patterns/status-vocabulary.md](../patterns/status-vocabulary.md), because a
  status vocabulary only ever rots towards fewer words: nobody adds a status
  they cannot justify, but a word already on the page will happily absorb a
  case it nearly fits.

---

## 2026-09-22 - Design tokens and the shared primitives (audit batch 2)

Decisions 1, 3, 6 and 8 from the entry below, implemented, plus the token work
they rest on. Held by `apps/bothy-web/checks/design-tokens.mjs`.

- **One Button.** `components/ui/Button.tsx`: primary, secondary, ghost, danger
  and caution, one small size, a real disabled state. A hand-written `btn` class
  anywhere else fails the check; every other raw `<button>` must belong to a
  registered family (tab, row, icon trigger, inline action). **Rejected:** keeping
  `.btn` as a global utility with modifiers - it had grown five `.sm`s, six
  disabled copies and a danger class nobody defined, because a utility cannot
  refuse a local override and a component can. **Cost:** 101 call sites touched.
  **Caution** is a fifth variant nobody asked for: the service and cluster
  confirms had a deliberate amber edge (`.sa-go`), and folding it into danger
  would have painted "Restart" red.
- **Danger's hover tint is opaque** (`--st-down` 14% over `--bg`), not the
  translucent `--st-down-bg`: over Gruvbox's light dialog surface the translucent
  one took the label to 2.78:1.
- **Press = dim + shrink** for compact controls, darken for rows; reduced motion
  keeps the dim. **Rejected:** a press colour per component - the inset `--fg`
  tint reads on every fill in both themes, including a filled primary.
- **Springs are tokens, not yet motion.** `--spring` is a sampled critically
  damped `linear()` and `lib/motion.ts` has the exact physics for framer; batch 3
  puts them on dialogs, menus and the drawer.
- **The type scale is closed at nine rem steps** with per-step leading and
  tracking. Only the shared primitives moved in this batch; the page-by-page px
  sweep is batch 4, so for now a 125% browser text size grows the controls and
  not yet every paragraph.
- **Elevation is four steps from two theme colours.** Themes lost the ability to
  set shadow geometry, on purpose. Two named themes changed colour because the
  Button rule measured their dialogs for the first time (Gruvbox's
  `--surface-4` and `--st-down-fg`, Tokyo Night's `--st-down-fg`).
- **`tokens.md` is generated**, so it cannot drift again.

---

## 2026-09-21 - The design audit's conflicts, decided

The Apple-design audit (`docs/plans/design-audit-apple.md`) recorded ten places
where its yardstick and this brand disagreed. The owner decided all ten; the table
is in the audit under "Decisions (approved 2026-09-21)". The ones that change a
rule written elsewhere in these docs:

- **Motion.** Springs only for dialogs, menus and drag; the brand curve stays for
  colour and fade. Page changes cross-fade and never show a blank frame. Reduced
  motion keeps fades and removes movement. ([motion](../foundations/motion.md))
- **Materials.** Translucency only on the top bar and the command palette, each
  with a solid fallback under `prefers-reduced-transparency`.
  ([shape-and-elevation](../foundations/shape-and-elevation.md))
- **Theme.** Follows the OS by default; the manual override stays.
  ([theming](../foundations/theming.md))
- **Targets.** 44px under a coarse pointer, 24px under a fine one.
  ([responsive](../quality/responsive.md))
- **Confirmations.** Type-the-name only for irreversible actions; one click for
  reversible ones. The cluster catalog's current inversion is fixed in a later
  batch. ([forms](../patterns/forms.md), [feedback](../patterns/feedback.md))

**What cost what.** The cross-fade gives up "pages never overlap" to get rid of a
~130ms blank frame on every navigation. Following the OS gives up a uniform first
impression (dark) for a page that matches the device. 44px touch targets make
dense tables taller on phones; fine pointers keep today's density. Rejected:
springs everywhere (the skill's default) - a colour change that overshoots or
settles is motion with nothing to say.

**Implemented the same day, batch 1:** the accessibility blockers - one modal
primitive that returns focus, the palette and the Settings drawer moved onto it,
a portalled menu primitive, sort headers as buttons, status text on the `-fg`
tokens, readable zero-count chips, and a focus ring that no longer reshapes
controls. `apps/bothy-web/checks/a11y-contract.mjs` holds them.

---

## 2026-09-17 - A drawer for the Settings nav below 900px

The drawer is a recorded dead end ([responsive](../quality/responsive.md)), and
this is a deliberate, scoped exception. The dead end was a drawer for FIVE
top-level destinations, which a topbar holds; its cost was a hand-written scrim,
focus trap and focus-order workaround. Settings v2 has twelve grouped sections and
a search box inside one topbar entry. The horizontal strip Control uses below
900px would hide ten of them off-screen with no group labels, and the search has
nowhere to go. So below 900px a sticky "Sections" button opens a Radix Dialog
sheet holding the search and the grouped nav - the behaviour that sank the old
drawer is the library's, not ours. Above 900px it is a scoped sidebar like
Control's: subordinate to the topbar, never a replacement for it.

**Also decided with it:** every Settings preference is per browser (versioned
localStorage keys, re-checked on read), the accent choice is limited to hues that
keep 45 degrees from every chromatic status, and the Overview's status line and
attention strip cannot be hidden - "is anything broken" is not a preference.

---

## 2026-08-10 - Rebuild the global quick view instead of deleting it

**Decision.** Reinstate the at-a-glance stat row as five tiles backed by real
metrics - CPU, memory, disk, network, uptime - and put it *below* the services
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
  are capacities - "how close to full" - which a meter answers and a line does
  not. CPU, network and load are rates: nothing is filling up, and the question is
  the trajectory. "Bounded" is the wrong test, because CPU is bounded 0–100 and
  still wants a line - a bar under a tile that already prints "25%" re-encodes the
  number it sits beneath and adds nothing.
- **A quick view of the machine and a status line about the services are two
  different scopes.** A "services" tile lived in the strip briefly and restated,
  one row above it, exactly what the status line says in words.

---

## 2026-08-10 - Turn the system matrix's headings into row labels

**Decision.** Dissolve the three stacked group headings into a single grid with a
`max-content` label column, so each group is one line instead of two.

**Why, measured.** The block was 209px × 1260px - the largest on the page - and
its three chip rows were only **41%, 53% and 28% full**. Six lines of layout for
thirteen items, with more than half the area empty beside the chips. Meanwhile
the cell breakdown it encodes (15 up, 7 unknown, 5 stopped) is stated in words by
the status line directly above it, so the block's only unique contribution is
*which* system each state belongs to.

**Result.** 209px → **117px**, rows 51/67/36% full, and each chip gained a
service count - a second dimension, since eight cells and nine cells are the same
shape at a glance.

**Two failures on the way, both about guessing at a width.** A fixed 92px label
column clipped "INFRASTRUCTURE" and pushed its badge onto a second line, making
that row taller than the other two - the exact raggedness the change existed to
remove. Fixed by making the whole matrix one grid (`display: contents` on the
groups) so the column is `max-content` and identical on every row. Then at 390px
that same column ate 36% of the viewport and the matrix grew to 522px; below
760px the label goes back above its row, which brings it to 362px.

**The general rule:** a label column is a wide-screen optimisation. It must hand
the width back when there is not any.

---

## 2026-08-10 - A tile unit for dashboard cards, and a footer on every one

**Decision.** Declare one tile height for the Overview's card grid; every card is
exactly one unit or a multiple. Give every card a summary footer.

**Why.** The row read as ragged because each card sized to its own content -
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
timestamp, so a container briefly in the top N appears in the result - topk(6)
returned 7 distinct series and made a "top 6" label false. The queries now fetch
every container and rank in the client, which also fixed a second symptom: with
topk on both metrics, a container in the memory top 6 but not the CPU top 6 had
no CPU value to pair with, and rendered a blank cell.

---

## 2026-08-10 - Collapse the Overview hero to one line

**Decision.** Replace the 160px hero card and its five stat cells with a single
status line, and delete the session sparkline and the ring buffer behind it.

**Why - it contradicted itself.** With 7 services `unknown`, the page showed
"Healthy 68%" beside "Needs a look: none" and "Everything meant to be running is
up", all within six pixels. `unknown` means *we have not checked* - those are the
host routes with no container to inspect - so it is neither a pass nor a fault,
and the old copy silently treated it as both: excluded from the attention count,
included in the healthy denominator. The biggest number on the page said a third
of the box was not OK while the sentence under it said everything was fine.

**Why - it also failed the footprint rule.** The hero stated one ratio four
times: a 46px number, a part-to-whole bar, a written legend, and a "Healthy %"
cell. Two of the remaining cells duplicated things visible on the same screen
(`Systems` is countable in the matrix directly below; `Data` repeated the Data &
disk panel header). `Trend` had been dead since real metrics arrived.

**What replaced it.** `15 up · 7 unverified · 5 off`, the bar, and one sentence
scoped to what actually reported in: "All 15 services that report in are up.
7 can't be verified - host routes with no container to ask."

**Cost and result.** 160px to 55px. The vitals charts moved above the fold. The
section's three responsive breakpoints collapsed to one. `Sparkline` and
`PortalData.history` were deleted as dead code rather than left orphaned.

**The general lesson.** Adding a genuinely better instrument does not
automatically retire the worse one that was standing in for it. The sparkline
survived the arrival of real time series by three hours purely because nobody
re-asked whether it still earned its space.

---

## 2026-08-10 - Repaint to a neutral dark scheme

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

## 2026-08-10 - Adopt Radix for behaviour, not for appearance

**Decision.** Take a dependency for the dialog. Keep hand-written CSS and the
existing token system. Do not adopt a utility-CSS framework.

**Alternatives.** Full framework plus component kit; or hand-roll the dialog.

**Why.** The parts of a dialog that are hard are focus trapping, focus return,
Escape, scroll lock and portalling - exactly the parts hand-rolling gets subtly
wrong. The parts that are easy are layout and appearance, which is what a
framework would have taken over. Adopting the framework would have meant two
styling systems coexisting through a long migration for no behaviour gain.

**Cost.** One dependency. Three other packages were installed during exploration
and removed once unused.

---

## 2026-08-10 - Validate the chart palette rather than choosing it

**Decision.** Run every categorical palette through five checks per theme, and
treat slot order as part of the validated result.

**Why.** The intuitive blue→teal→amber→purple→rose ramp fails on dark: every hue
sits above the dark lightness band and glares. The first reordering attempted to
fix a colour-vision-deficiency adjacency and made it worse, putting orange beside
rose at ΔE 9 for *normal* vision.

**Cost.** The palette cannot be casually reordered. Recorded in the CSS beside
the values.

---

## 2026-08-10 - Rename the product to Bothy

**Decision.** Replace `<base-domain> / dev box` in the topbar with a product name and
a run-time hostname.

**Why.** The old wordmark named the product after a DNS name dormant since
2026-08-08. Nine candidate names were checked against existing software first;
six were taken.

**Cost.** None to the machine's own naming - "dev box" is still correct
everywhere it refers to the machine, and was deliberately not renamed.

**Vindicated 2026-08-12.** The name layer was deleted two days later - its
Traefik `Host()` rules removed, its split-DNS route already gone. The name layer now
resolves nowhere, so the old wordmark would have been a dead address in the most
prominent position on the page. The run-time `location.hostname` subtitle needed
no change at all; it simply prints the bare IP now, because that is what
visitors actually type. A decision that survives the thing it was hedging
against, without an edit, was the right decision.

---

## 2026-08-10 - Add a generated Prometheus route rather than a committed one

**Decision.** Generate the edge config that carries the metrics credential from
the environment, gitignore it, and commit a comments-only example.

**Why.** The browser cannot hold a credential and the repository is public.

**Dead end, paid for immediately.** The first version of the example was live
YAML declaring the same router and middleware names as the real file. The file
provider merges every file in the directory, so the example overwrote the real
credential with its placeholder - every query returned 401 while the router still
reported "enabled". Examples in a watched directory must be comments-only.

---

## 2026-08-10 - Own scroll restoration

**Decision.** Reset to top on a new navigation, restore on Back, in application
code.

**Alternatives.** The router's built-in restoration - unavailable for this
router configuration.

**Two dead ends, both of which produced a feature that looked implemented.**
First, restoring into a page that has not finished growing gets clamped, so the
restore silently half-works. Second, and worse: the programmatic scroll-to-top
dispatches its event *after* the framework re-binds the save listener, so it
overwrote the offset it was about to need. Both are documented in
[patterns/scrolling.md](../patterns/scrolling.md).

---

## 2026-07-29 - Delete the reveal-on-scroll animation

**Decision.** Remove it, and adopt the rule that entrance animations must start
from a visible resting state.

**Why.** It defaulted content to invisible and relied on an observer to switch
it on. It shipped a near-blank page twice.

**Cost.** None. The replacement animates from visible.

---

## 2026-07-29 - Delete the browser reachability probe

**Decision.** Report host-process routes as `unknown` rather than probing them.

**Why.** A no-cors fetch resolves for any status, so 502 and 401 both reported
"up". The probe could not physically return "down".

**Cost.** Five services now honestly say "unknown" instead of dishonestly saying
"up".

---

## 2026-07-29 - One cell per service, not one card per system

**Decision.** Replace the card grid with a matrix.

**Why.** Fourteen cards, eight of which said "1 / 1 running, 100 percent
healthy". This produced the footprint rule in
[principles](../foundations/principles.md).

**Cost.** Per-system pinning was dropped with the cards.
