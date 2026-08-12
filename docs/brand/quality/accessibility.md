# Accessibility

_Status as of 2026-08-10. Target: WCAG 2.2 level AA._

## The rule

Accessibility is first in the precedence order in
[principles](../foundations/principles.md). It is not a pass at the end.

Most of it is already covered by other documents in this tree, because most
accessibility failures are design failures with an accessibility symptom:

| Concern | Where it lives |
|---|---|
| Contrast, colour-alone | [colour](../foundations/colour.md) |
| Focus indicators, disabled, states | [component-states](../patterns/component-states.md) |
| Reduced motion, the never-hide invariant | [motion](../foundations/motion.md) |
| Skip link, current item, route announcements | [navigation](../patterns/navigation.md) |
| Labels, errors, target size | [forms](../patterns/forms.md) |
| Chart names, legends | [dataviz](../patterns/dataviz.md) |
| Dialog focus management | [feedback](../patterns/feedback.md) |
| Forced colours | [theming](../foundations/theming.md) |

What this document adds is the criteria that do not belong anywhere else, and
the 2.2 additions that are easy to miss.

### The 2.2 additions people miss

- **Focus not obscured (2.4.11).** A focused element must not be hidden behind
  sticky chrome. Sticky headers plus keyboard navigation is exactly the
  combination that breaks this.
- **Target size 24x24 (2.5.8).**
- **Dragging movements (2.5.7).** Every drag has a non-drag alternative.
- **Consistent help (3.2.6).**
- **Redundant entry (3.3.7).** Do not ask twice for what was already given.
- **Accessible authentication (3.3.8).** No unaided cognitive-function test.

### The ones that are always weakest

- **Focus order matching visual order.** Easy to break with CSS ordering.
- **Route changes in a single-page app.** A navigation that does not move focus
  or announce itself leaves a screen-reader user on a page that silently changed.
- **Text spacing (1.4.12).** Injecting the standard spacing override breaks
  layouts that assumed a line-height.

## Checklist

See [CHECKLIST.md § 20](../CHECKLIST.md#20-accessibility).

## What Bothy decided, and why

**Done:**

- A skip link as the first tab stop, visible on focus.
- Landmarks, one `h1` per page, no skipped levels.
- A global focus ring, including on scroll containers, which are focusable and
  labelled as regions so they can be scrolled by keyboard.
- Status is never colour-alone: every status has a distinct glyph, an accessible
  name, and a written label wherever it matters. A bare colour dot always ships a
  visually-hidden label beside it.
- Charts are images with names that state the actual numbers.
- Tooltips on hover and focus; the command palette drives selection with
  `aria-activedescendant` so arrow keys never move focus.
- A real ARIA tablist with roving tabindex, arrow keys, Home and End.
- Reduced motion honoured, and structurally unable to hide content.
- A `forced-colors` block, added 2026-08-10.
- Four unpaired `outline: none` rules found and fixed, 2026-08-10.

**Known gaps**, tracked in
[reference/open-questions.md](../reference/open-questions.md):

- **Route changes are not announced** and do not move focus. This is the most
  significant outstanding item.
- **The 3D topology has no non-drag alternative** for orbiting (2.5.7). The focus
  buttons are a partial path; the static fallback may be the honest answer.
- **No automated audit runs in CI.** Everything above was verified by hand or by
  targeted assertions, which is weaker than it sounds.
- **No screen-reader pass has been recorded.**

## Dead ends

- **Colour dots with no accessible name.** They were used in several lists; a
  colour is not a status. Each now carries a hidden label.

## How this is verified

- Automated audit per route per theme — not yet wired up.
- Keyboard-only pass of the core flows.
- Emulated reduced motion, asserting content still renders.
- Text-spacing override injected, then screenshot.
