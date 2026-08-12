# Governance

_Status as of 2026-08-10._

Who changes the system, and how it stays true.

## The rule

**One file owns the tokens.** A change to it is a change to the system and gets
reviewed as one. A component that reaches around it is a defect, not a shortcut.

**Adding a token requires** a name, a value per theme, a measured ratio where
applicable, and a comment saying why it exists.

**Renaming a token keeps both names live for one release**, then removes the old
one. A rename that lands in one commit breaks every consumer at once.

**Changing a validated palette or its slot order re-runs the validator and
updates the recorded numbers in the same change.** Otherwise the recorded
evidence describes a palette that no longer exists, which is worse than no
evidence.

**Changing a standing rule requires a decision-log entry** with the alternatives
considered.

**Version by date stamp, not semver.** This is a document, not a package. Every
file carries a status date, and a claim without a date is a claim nobody can
evaluate.

**Dead ends are recorded, never deleted.** A ruled-out approach is worth as much
as the chosen one.

**A superseded document is marked retired with a pointer**, not deleted. Someone
has a link to it.

**Name an owner** and the route for proposing a change.

## Checklist

See [CHECKLIST.md § 31](../CHECKLIST.md#31-governance).

## What Bothy decided, and why

- **The token file is the source of truth**, and these documents are downstream
  of it. Where they disagree, the CSS is right and the document is stale - which
  is why every document carries a date.
- **Page styles are co-located** and never edit the shared layer.
- **Date stamps, not versions**, matching the convention in
  [the knowledge base](../../kb/README.md).
- **Retired-not-deleted** is an established precedent here: a knowledge-base
  document that stopped being true was marked retired and turned into the manual
  for re-enabling what it described, rather than being removed.
- **The predecessor to this tree**, `apps/portal-next/DESIGN_BRIEF.md`, was a
  one-off orchestration contract for a parallel rebuild. Its token list went stale
  - it names tokens and components that were renamed or deleted - which is
  precisely the failure this governance section exists to prevent. It is marked
  superseded with a pointer here.

**Owner:** the repository owner. There is no review board; the discipline is the
date stamp and the decision log.

## Dead ends

- **A design brief that doubled as a design system.** It was written to
  coordinate three agents working in parallel on disjoint files, which is a
  scheduling document with a short useful life. Treating it as durable meant its
  stale token names outlived the tokens by weeks.

## How this is verified

- Assert every document carries a status date line.
- Assert every token name cited in these documents exists in the token file.
- Assert every relative link resolves.
