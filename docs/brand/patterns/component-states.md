# Component states

_Status as of 2026-08-10._

The states every component owes, and what each one means. This is the document
that catches the most defects, because most components are built for their happy
path and then shipped.

## The matrix

Every interactive component must answer all of these, or explicitly record that
one does not apply.

| State | The question it answers |
|---|---|
| Default | At rest |
| Hover | The pointer is over it |
| Focus-visible | The keyboard is on it |
| Active | It is being pressed |
| Current / selected | You are here, or this one is chosen |
| Disabled | It exists but cannot be used, and why |
| Read-only | It can be read and copied but not changed |
| Loading | The data is coming |
| Empty | There is genuinely nothing |
| Filtered-empty | There is something, but not matching your filter |
| Partial | Some of the data arrived |
| Error | It failed, and what to do |
| Offline / stale | What is shown is old, and how old |
| Skeleton | The shape that is coming |

## The rules that get broken

**`outline: none` without a replacement is a defect.** Every time. If a control
removes the focus ring it must draw its own in the same rule. A border-colour
change is *not* a replacement: it is invisible to someone looking for a ring,
and it is colour-alone.

Where an input has no border of its own - a search field inside a bordered
wrapper - the ring belongs on the wrapper, keyed to `:focus-visible` on the
input so it does not fire on every mouse click.

**Skeletons must be shape-matched.** A skeleton's only job is to reserve the
shape that is coming, so the page does not jump when data lands. Two identical
grey boxes standing in for a headline block and a wrapping row of chips move the layout
twice - once when the skeleton appears and again when it is replaced by
something a different height. That is worse than no skeleton.

**An empty state is a note, not an announcement.** It should be *smaller* than
the content it replaces. Large padding makes "no results" as prominent as the
results would have been.

**An empty state offers the fixing action only if one exists.** Offering to
clear a filter that is not set is a dead control. "No services discovered" and
"no services match these filters" are two different states and only the second
gets a Clear button.

**An error state is louder than an empty state**, and carries a retry.

**A partial state must exist.** One failing data source degrades the page; it
never blanks it. Decide in advance which source is the skeleton and which is
enrichment, and let the enrichment fail alone.

**A stale state shows the age of the data**, not just the data.

**Every hover-revealed affordance needs a focus and a touch equivalent.** Touch
has no hover; keyboards have no pointer.

**"You are here" is marked differently from "press me".** A filled pill reads as
a button asking to be pressed, when what you meant was a statement of location.
An underline or a marker states location without inviting a click.

## Checklist

See [CHECKLIST.md § 12](../CHECKLIST.md#12-component-states).

## What Bothy decided, and why

- **A global focus ring** on `:focus-visible`, at a declared width and offset,
  including on scroll containers.
- **Four unpaired `outline: none` rules were found and fixed** on 2026-08-10 -
  two search inputs that replaced the ring with a border tint, and two inputs
  inside bordered wrappers that had no replacement at all. The wrappers now carry
  the ring. Three other occurrences were left: they already had `:focus-visible`
  replacements.
- **Skeletons are shape-matched by variant** - the overview, table and panel
  skeletons have different geometry, because a single generic one moved the
  layout on every load.
- **Empty states take an optional clear handler**, so the dead-control case is
  structurally impossible rather than merely avoided.
- **Partial is a first-class state.** The data layer uses settled promises
  rather than all-or-nothing: the route table is the skeleton, container data is
  enrichment, and disk sizes are a pure overlay. Any of them can fail alone, and
  the page says which is missing rather than hiding the rest.
- **Stale shows its age** in the freshness pill, and the page keeps the last good
  data rather than clearing - a stale page with working links beats a blank one.
- **Current nav items are underlined**, not filled, for the reason above.

## Dead ends

- **A generic 132px grey box as the only skeleton.** Moved the layout twice.
- **Clearing the data on a failed poll.** Produced a blank page during a
  transient failure, when the whole point of the page is to be useful when things
  are broken.

## How this is verified

- Grep for `outline: none` and fail on any occurrence without a replacement
  indicator in the same rule.
- Assert hover, focus-visible, active and a disabled treatment exist per
  interactive class.
- Include every state of every primitive in the screenshot matrix.
