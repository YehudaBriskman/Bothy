# Feedback and overlays

_Status as of 2026-08-10._

How the system talks back: dialogs, tooltips, toasts, confirmation.

## The rule

**One dialog implementation.** It must set `aria-modal`, carry an accessible
name, trap focus, restore focus on close, close on Escape, lock background
scroll, and portal out of any clipping ancestor. These are the parts that are
always subtly wrong when hand-rolled - see
[components](components.md#two-deliberate-exceptions-to-use-the-library).

**One dialog at a time.** Nested modals are almost always a flow that should
have been a page.

**Dialogs cap their height and scroll internally**, so the header and its close
button never scroll away.

**Tooltips open on hover *and* on keyboard focus.** A tooltip that only appears
on hover is invisible to a keyboard user and to touch.

**A tooltip is never the only carrier of information.** It is an enhancement.

**The `title` attribute is a third fallback.** It is invisible to keyboard
users, slow, and unstyleable - useful only for touch, where neither hover nor
focus fires.

**Decide whether toasts exist.** If they do: capped stack, at least five
seconds, dismissible, announced politely, and never the only record of an error.
An error that exists only in a toast that has already faded did not get
reported.

**A persistent status surface is not a toast**, and the test is two properties
rather than its position on the screen: a toast reports something that **already
happened** and removes itself on a **timer**. A fixed surface that reports
something **still happening** and stays until the person dismisses it is a handle
on a running job, and it is subject to the opposite rules - it must not fade, it
must not stack, and it must not exist at all while nothing is happening. See
[decisions, 2026-10-08](../reference/decisions.md).

**Prefer inline confirmation** where the action has a visible local result. A
toast to say a thing you can see happened is noise.

**Destructive confirmations name the object and the consequence**, not "are you
sure".

**One dialog at a time.** A confirm raised from inside a dialog is an inline panel
in that dialog, not a second modal on top of it (2026-09-21: the Cluster pod-delete
confirm was the last nested modal). **Closing any dialog returns focus to what
opened it** - the shared `ui/Dialog` primitive does this, which is why every modal
must be built on it.

**Confirmation weight follows reversibility** (2026-09-21, design audit decision
7): type the name only for an irreversible action; a reversible one takes one
click, with an undo where the UI can offer one. See [forms](forms.md).

**Feedback within 100ms for anything over 300ms.**

**Nothing moves focus without user intent.**

## Loading

_2026-09-22._ **One loading indicator: `components/ui/Loader.tsx`**, an orb from
[`thinking-orbs`](https://orbs.jakubantalik.com) (MIT, zero dependencies, a 2D
canvas). Nothing else may spin, pulse or say "Loading…" on its own;
`checks/design-tokens.mjs` § 10 fails on a spinner keyframe, a `.spin` class, a
lucide loader glyph, bare "Loading…" text, or `thinking-orbs` imported anywhere
but the Loader.

**The state says what kind of waiting it is.**

| `state` | Use it for | Orb |
|---|---|---|
| `work` | an update job running (Settings > Updates job panel and its running step, the Control activity card) | working |
| `search` | discovery (the first poll: Overview, Control, Services, a service or system page), Files search while it queries, finding a repository | searching |
| `act` | an action in flight: restart / stop / start, scale, rollback, run-template, saving a file | solving |
| `stream` | following logs live (the kube dialog's Follow) | listening |
| `connect` | waiting on a backend that has not answered: the freshness pill while the poll retries, the cluster tier's 503 retry, a job panel reconnecting, an unpause waiting for the host | connecting |
| `load` | a page, card, table or dialog reading its first data | breathing |
| `refresh` | the Control home's Refresh, from the click until every card has answered | weaving |

**Sizes are the orb's own designs, not a scale** (`--loader-sm/-md/-lg`, mirrored
as `LOADER`): `sm` 20px inline with text and in buttons, `md` 32px for a card,
panel or pane, `lg` 64px for a page or an empty state. `sm` is inline by default;
`md` and `lg` centre in their container.

**Words, always.** Every Loader carries a label saying what is being waited on
("Reading the plan…", "Discovering what is running…"). It is visible by default,
`labelHidden` makes it screen-reader only (a button that already says it), and
`announce={false}` drops `role="status"` where an enclosing live region already
speaks. The region being loaded carries `aria-busy="true"` - `Skeleton`, the
Settings `Loading` block and the Control card note do it for you.

**Only while something is in progress.** Mount it when the wait starts and unmount
it when it ends; there is no `active` prop. An idle orb is a perpetual loop for an
idle thing, which the brand forbids. A load under `--loader-hold` (150ms) never
shows an orb at all: the Loader fades in after the hold instead of flashing.

**Reduced motion renders the orb paused** - a still frame, no animation - under
the OS setting *or* Settings > Appearance > Motion (`useMotionReduced()`, decision
3). The words stay.

**Theme.** The dots are `--loader-ink` (= `--fg-muted` unless a theme sets it),
read off the live theme and re-read on a theme switch; the orb's depth shading
follows `html[data-theme]`. Under forced colours the ink is `CanvasText`.

**Skeletons stay where they hold a shape** and the Loader sits inside them:
`Skeleton` (states.tsx), the Settings `Loading` rows and the Control card note put
one orb over a still skeleton (the shimmer stops - two moving things read as two
waits). The Files panes' row skeletons (tree, git status, history, the document
index) and the Vitals chart skeleton stay as they were: dense side panes and
charts, where the reserved rows say more than an orb would.

**A loader OVER content is plated. A loader IN something is bare.**
_2026-09-23._ Pass `plate` when the Loader floats over anything - a skeleton, a
table still showing its last answer, a chart, the 3D map. Do not pass it when the
Loader is inline: in a button, in a table row, beside a pill, or alone in an
otherwise empty box. It is a prop rather than something the component guesses,
because those two cases look identical from inside it.

The plate is the **floating-surface material** `ui/Popover` and `ui/Menu` already
use - `--surface-4`, `--line-strong`, `--r-lg`, `--shadow-3`, padding off the
spacing scale - because a loader over a placeholder *is* that: a higher plane. It
sizes to its own words and is never full width.

**It is opaque, and that is the design, not a fallback.** No `backdrop-filter`,
no `--mat-*`: [decision 4](../../plans/design-audit-apple.md) reserves translucent
material for the top bar and the command palette, and a translucent plate over
skeleton bars is the very defect the plate was added to fix - the orb printed onto
a grey bar with its label crossing the next one down. So there is nothing for
`prefers-reduced-transparency` or reduced motion to take away, and forced colours
only restates it in `Canvas` / `CanvasText`. Everything else the Loader guarantees
is unchanged: `role="status"`, the polite label, the `aria-hidden` canvas, paused
under reduced motion, and the 150ms hold before it fades in.

**The placeholder underneath is quieted** to `--quiet-opacity` while a plate is
over it - one rule, on `.skel-host:has(> .ui-loader-plate)`, so no skeleton
variant has to know a plate may be there. That is also why the plate went on the
*Loader* rather than as a hole carved out of each variant: a hole moves with each
page's layout and breaks the skeleton's one job.

**Cost.** The package is about 26 KB minified (11 KB gzip) after tree-shaking and
is loaded lazily - never in the first paint's critical path. The chunk is warmed
when the browser is idle; until it arrives the orb's box is reserved, empty, with
the label beside it.

## Detail on demand: when to reach for a hint, and when to write less

_2026-10-07. Written before the app-wide rollout, because the rollout will follow
it and the failure mode is cheap to describe and expensive to undo._

A **detail hint** is an unobtrusive glyph that reveals a sentence or two on
demand. Bothy's is `components/ui/InfoHint.tsx`, on `ui/Popover`.

### The one rule

**A hint must REMOVE words from the surface.** It is a place to put prose that was
already there, not a place to put prose you were about to add. A surface that
gains a hint and keeps its paragraph has been made busier, and that is the exact
opposite of what a hint is for. The measure of a hint pass is *how many words left
each surface*, and if the answer is zero the pass did nothing.

The corollary is uncomfortable and load-bearing: **a hint is not permission to
write more.** The first question about any explanation is still "does this need to
exist at all", and only the second is "does it need to be visible".

### Reach for a hint when

- The text **defines a word the surface already uses** - a column header, a status
  word, a label. Definitions are read once per reader, not once per visit.
- The text is **the reason behind a refusal or a limit** - why this cannot be
  applied, why this field is locked, what the gate was. Somebody who hits the
  limit wants the paragraph; everybody else does not.
- The text **repeats per row**. The same forty words under eight rows is three
  hundred words of surface for forty words of content.
- The text is **the mechanism** behind something whose outcome is already stated:
  what the snapshot contains, what the pre-flight checks, which files move.

### Write it shorter instead when

- **It is one clause.** A hint costs a glyph, a target, a name and an interaction;
  four words do not earn that. Cut the four words or keep them.
- **It is the answer to the question the page exists to answer.** Never hide the
  headline. On Settings › Updates the sentence "Apply makes this box run what
  `main` already pins" stays on the surface precisely because the confusion it
  resolves is the page's whole subject.
- **It is a warning about something irreversible.** Consequence is not detail.
  A hint is opened by people who are already curious; a warning has to reach
  the ones who are not.
- **The prose is long because the design is unclear.** Three paragraphs
  apologising for a layout is a layout problem. Hiding them hides the symptom.
- **It would be the only copy of something a reader must have.** A hint is an
  enhancement, like a tooltip: never the sole carrier (see the rule above).

### What a hint owes

Everything a control owes, because it is one.

- **A real accessible name**, phrased as what it reveals ("What Pinned means"),
  never "info" or "more". The trigger is a 12px glyph with no text beside it, so
  the name is the entire accessible story. `checks/a11y-contract.mjs` § 7 fails an
  empty, generic or duplicated name.
- **Opens on focus, on a tap and on hover - in that order of importance.** Hover
  alone is not an affordance: it does not exist for a keyboard and it does not
  exist on a phone. A touch tap must reach the toggle rather than being eaten by a
  hover that opened and closed in the same gesture, which is the defect that
  disqualified `components/Tooltip.tsx` for this job.
- **Escape closes it**, with focus where the reader left it.
- **Text, never a control.** Focus does not move into the panel - the panel is the
  trigger's `aria-describedby`, which is what lets a screen reader read it without
  going anywhere - so a link or a button inside one is unreachable. If the detail
  needs an action, it is not a hint; it is a disclosure or a dialog.
- **Nothing a search must find.** A hint's text is in the DOM only while it is
  open, so it is invisible to in-page find and to the Settings search. Anything
  somebody would search for stays on the surface or goes in a block description.

### Hint, tooltip, disclosure, dialog

| | Use it for | Focus |
|---|---|---|
| Tooltip | A label for a control that has no room for one | never moves |
| **Detail hint** | One or two sentences of *why*, taken off the surface | never moves |
| Disclosure | A region of content, including controls, that belongs to a row | moves on Tab, in place |
| **Status dock** | Something still happening, on every page, with its own actions | moves on Tab, Escape returns it |
| Dialog | A decision, with its own actions | trapped, returned |

The boundary that matters in practice: **the moment the detail contains something
to press, it stops being a hint.**

## Checklist

See [CHECKLIST.md § 17](../CHECKLIST.md#17-feedback-and-overlays).

## What Bothy decided, and why

- **Radix Dialog**, styled against the tokens. The only dependency taken for
  behaviour rather than convenience.
- **The dialog is a column** so the body scrolls rather than the whole box, and
  the body carries the standard edge shades so a clipped dialog looks clipped.
- **Radix warns when a dialog has no description**, so one is always supplied -
  visually or hidden. A console warning that is always present trains everyone to
  ignore console warnings.
- **Tooltips open on hover and focus**, using the inverted-surface pair - the
  foreground colour as the background - which is what makes a tooltip read as an
  overlay rather than as another card. They replaced bare `title` attributes,
  which were invisible to keyboard users.
- **A detail hint is a second, separate primitive** (`ui/InfoHint`, 2026-10-07),
  and not a longer tooltip. Three things disqualified the tooltip for it, each on
  its own: its anchor closes on `pointerdown`, so on a phone the tip opens and
  shuts in one tap; its surface is `pointer-events: none`, so the text cannot be
  selected; and its anchor is an unnamed `<span>`, so there is nothing to announce
  and nothing to land on. Both are on `ui/Popover`, which is where the portal, the
  collision handling and the motion live.
- **The first hint pass was Settings › Updates**, the wordiest page in the
  product, and it was measured rather than eyeballed: the page body went from
  about 1,580 words to about 1,070 at 1440px - roughly a third of the words gone
  from the surface, with nothing deleted. That number is the deliverable; a pass
  that adds hints and leaves the word count alone has not done the work.
- **No toasts.** The product's actions all have visible local results: a refresh
  shows the Loader in its own button and updates the freshness pill; a failed poll is reported
  by the pill and the degraded line. Nothing needed a transient overlay, and one
  would have been a second, competing error channel.
  _Amended 2026-10-08, explicitly and for one case:_ an update job runs on the
  host for minutes and has no local result to show, so it has a **persistent**
  corner surface on every page - `components/UpdateActivity.tsx`'s dock, the same
  component and the same store as the rail down the side of Settings > Updates.
  It has no timer, there is never more than one, and there is none at all when no
  job is running. Everything the original decision refused is still refused; see
  [decisions](../reference/decisions.md) for the argument and what was rejected.
- **The system quick-lookup is a dialog rather than a page** because it answers a
  *lookup* - you want it, you read it, you carry on scanning. Making it a
  navigation meant losing your place on a page you were scanning. The dialog links
  on to the full page for when you did want to leave.

## Dead ends

- **A hand-written dialog.** Not attempted here, on the strength of how reliably
  the focus-return case is got wrong.
- **`title` attributes as the tooltip mechanism.** Invisible to keyboard users.
- **Four loading indicators** (to 2026-09-22): a CSS ring (`.sa-spin`), a spun
  lucide glyph (`.spin`), a pulsing dot beside followed logs, and bare
  "Loading…"/"reading…" text. None said what was being waited on, and the ring
  and the dot ran forever. Replaced by the one Loader.
- **A spinning `starting` status glyph.** A status labels legends and filters as
  well as rows; a table of starting containers became a table of spinners. The
  glyph is static now.

## How this is verified

- Assert focus is trapped, Escape closes, and focus returns to the trigger.
- Assert tooltips appear on focus, not only on hover.
- Assert only one dialog can be open.
- `checks/design-tokens.mjs` § 10 for the one-loader rules; in a browser, assert
  `document.getAnimations()` and the orb's canvas are still under reduced motion.
- `checks/design-tokens.mjs` § 12 for the hint: built on `ui/Popover`, opens on
  focus, hover for a mouse only, focus never moves, no control inside one, and
  the four paragraphs it took off Settings › Updates are not also still there.
- `checks/a11y-contract.mjs` § 7 for the names: no hint is called "info", "more"
  or nothing, and no two on a page share a name.
- In a browser: focus the glyph with no pointer involved and assert the panel
  opens; press Escape and assert it closes with focus still on the trigger.
- `checks/design-tokens.mjs` § 12 for the activity surfaces: the rail is a column
  of the page whose width the page reserves and whose card is absolutely
  positioned (so no block can move when a job starts), the dock is mounted in the
  shell and nowhere else, it is absent when nothing is being followed, it opens on
  focus and on a tap with hover gated to a mouse, and it expands by transform
  rather than by size. In a browser, at 1440 and 390: bounding boxes compared
  before and after a job starts, not eyeballed.
