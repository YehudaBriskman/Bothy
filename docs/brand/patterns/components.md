# Component inventory

_Status as of 2026-08-10._

## The rule

**Keep an inventory, and treat it as the definition of what exists.** Name,
file, tokens consumed, states supported, accessibility contract, and where it is
used. A component that is not in the inventory does not exist — which in
practice means someone is about to build a second one.

**One file owns the shared utility layer.** Page and component CSS is
co-located with its component and never edits the global file. Without this
rule, every page slowly acquires the right to redefine `.btn`.

**No component introduces a colour.** Every colour it uses is a token
reference. This is the rule that makes a repaint possible at all.

**Every interactive element is a real button or link.** A click handler on a
`div` is not focusable, not keyboard-operable, and not announced as a control.

**At most one visual-variant axis and one size axis.** A third axis means it is
two components wearing one name.

## Checklist

See [CHECKLIST.md § 11](../CHECKLIST.md#11-component-inventory).

## What Bothy decided, and why

The shared utility layer lives in one stylesheet, alongside the tokens. Page
styles are co-located files that build on it and never edit it.

### Primitives

| Primitive | Notes |
|---|---|
| Button | Default, primary, ghost, icon-only |
| Chip | Filter toggles, with counts |
| Segmented toggle | Small either/or switches |
| Tag / badge / pill | Non-interactive labels |
| `kbd` | Keyboard hints |
| Status dot and status glyph | Colour plus a distinct glyph, never colour alone |
| Tooltip | Hover **and** focus; the inverted-surface pair |
| Dialog | One implementation, Radix-backed |
| Command palette | Hand-written; keyboard-driven |
| Tabs | A real ARIA tablist with roving tabindex |
| Table | One implementation, with a density variant |
| Panel / card | The surface primitives |
| Skeleton | Shape-matched, three variants |
| Empty state / error state | With optional clear and retry |
| Filter bar | Search, chips, selects |
| Nav item, breadcrumb, back link, skip link | Navigation |
| Stat cell | A labelled number |
| Status bar, bar gauge, time chart | The visualisation primitives (the sparkline was deleted with the hero, 2026-08-10) |
| Log panel | Monospace, fixed height, inner scroll |
| Scroll rail and scroll shade | See [scrolling](scrolling.md) |

### Two deliberate exceptions to "use the library"

**The command palette is hand-written.** A dependency was rejected at roughly
14KB for a 27-item list. The palette needs an input that keeps focus, a list
driven by `aria-activedescendant`, and arrow-key navigation — about 180 lines.

**The dialog is not hand-written.** This is the opposite call, and the reason is
instructive: the parts a dialog needs — a focus trap, focus return, Escape,
scroll lock, inert background, portalling out of an `overflow: hidden`
ancestor — are exactly the parts that are always subtly wrong when hand-rolled.
Shift-Tab off the first element, focus escaping to the browser chrome and back
into the inert page, focus returning to an element that a re-render has replaced.
Radix owns the behaviour; the styling is ours, against the same tokens.

That pairing is the general rule this system uses: **hand-write layout and
appearance, take a dependency for focus management and accessibility semantics.**

## Dead ends

- **A component library for the whole interface.** Tailwind plus a component kit
  was considered and rejected: the product already had a large hand-written token
  system in the same CSS-variable convention, and adopting the toolchain would
  have meant two styling systems coexisting through a long migration for no
  behaviour gain. The parts genuinely worth taking — the accessible primitives —
  were taken individually.
- **`ServiceCard` and `SystemCard`.** Deleted. One card per system meant fourteen
  cards, eight of which said "1 / 1 running". See the footprint rule in
  [principles](../foundations/principles.md).

## How this is verified

- Grep for click handlers on non-interactive elements.
- Grep for colour literals in component styles.
- Check that no page stylesheet modifies a shared utility class.
