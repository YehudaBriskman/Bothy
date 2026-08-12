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

**Feedback within 100ms for anything over 300ms.**

**Nothing moves focus without user intent.**

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
  spins its own button and updates the freshness pill; a failed poll is reported
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

## How this is verified

- Assert focus is trapped, Escape closes, and focus returns to the trigger.
- Assert tooltips appear on focus, not only on hover.
- Assert only one dialog can be open.
