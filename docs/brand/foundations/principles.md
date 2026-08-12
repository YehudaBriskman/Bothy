# Principles

_Status as of 2026-08-10._

The rules that outrank every other document in this tree. When a specific
guideline and one of these disagree, these win.

## The three standing rules

### 1. Status colours are reserved

There is a small set of colours that means *state* - up, warning, down,
unknown, switched off. Those colours are never used as decoration, never as a
brand accent, never as a chart series, and never because they looked right.

The reason is that a status palette only works if it is scarce. The moment a
green is used because a panel needed a green, "green" stops meaning "healthy"
and starts meaning "green". You cannot get that back by being careful
afterwards.

### 2. Chrome accents never encode state

The mirror of rule 1. There is a second set of colours used to tell panels
apart - to give a card a spine, a group a hue. Those are decoration. They never
mean anything. A reader must never be able to learn that "the purple one is
the broken one", because the purple one is purple for a reason that has nothing
to do with health.

### 3. Footprint is proportional to information dimensions

An element's size on screen should be proportional to how many independent
facts it carries.

A service's status is one bit. One bit gets one cell, not a full-width row. A
system is a name plus its services' states, so it gets a name plus a row of
cells. This is the rule that turns "shows everything, communicates the priority
of nothing" back into a page you can scan.

The practical test: if a full-width row carries fewer than about three
information dimensions, it is the wrong shape.

## The derived rule that is broken most often

**Colour is never the only encoder.**

Colour is always the *second* encoder, behind a glyph, a position, a label or
an ordering. Not because of a rule in a standard, but because colour fails in
more ways than designers expect: colour-vision deficiency, forced-colours mode,
a bad monitor, sunlight, a greyscale print, and a screenshot pasted into a chat
where the reader is not looking carefully.

If removing all colour from a screen destroys its meaning, the screen is wrong.

## Precedence

When guidance conflicts, resolve in this order:

1. **Accessibility.** A thing that cannot be perceived or operated is not a
   design decision, it is a defect.
2. **Honesty.** The interface must not claim to know something it does not.
   An unverified state is `unknown`, not `up`.
3. **The two reserved-colour rules.**
4. **The footprint rule.**
5. **Consistency** with the rest of the system.
6. **Aesthetics.**

Aesthetics being last does not mean it does not matter. It means that when it
competes with the five above, it loses, and that the loss should be recorded so
nobody re-opens it every six months.

## Two habits that belong here

**Write down why, not what.** A comment that says what the code does is
redundant with the code. A comment that says why it is that way is the only
copy of information that would otherwise be lost. Every non-obvious rule in
this system has a why attached to it, and most of them cost something to learn.

**Record dead ends.** A ruled-out approach is worth as much as the chosen one,
because without it the next person re-tries it. Every document here has a "dead
ends" section, and an empty one is a signal that the decision was easy - which
is itself useful information.

## What Bothy decided, and why

All three standing rules originated in the portal and are enforced in
`apps/portal-next/web/src/index.css`, where they are stated at the top of the
token block.

Rules 1 and 2 came first and have held unchanged. Rule 3 was added later, after
a redesign found the Overview showing fourteen cards, eight of which said "1 / 1
running, 100 percent healthy" - a full card, roughly 35,000 square pixels, for
one bit of information that was not even interesting. Replacing them with one
cell per service fit thirteen systems and twenty-seven services into roughly the
height the old projects group alone had used.

The precedence order was written down after a specific conflict: on dark
backgrounds a saturated red is intrinsically darker than a saturated green, so
`down` cannot be made visually heavier than `up` by brightness. The aesthetic
fix - brightening the red - would have destroyed the warning-versus-down
distinction, which is more valuable. Honesty and the reserved palette won;
urgency is carried by hue, glyph and sort order instead, and the compromise is
documented rather than silently absorbed.

## Dead ends

- **Trying to fix dark-mode status weight with brightness.** See above. The
  conclusion is that on a dark theme, luminance cannot carry the urgency ladder,
  and pretending otherwise costs a more important distinction.
- **Letting one component "just this once" use a status colour as decoration.**
  This has been proposed and rejected repeatedly. It is always locally
  reasonable and globally corrosive.
