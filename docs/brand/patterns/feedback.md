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

**Cost.** The package is about 26 KB minified (11 KB gzip) after tree-shaking and
is loaded lazily - never in the first paint's critical path. The chunk is warmed
when the browser is idle; until it arrives the orb's box is reserved, empty, with
the label beside it.

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
- **No toasts.** The product's actions all have visible local results: a refresh
  shows the Loader in its own button and updates the freshness pill; a failed poll is reported
  by the pill and the degraded line. Nothing needed a transient overlay, and one
  would have been a second, competing error channel.
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
