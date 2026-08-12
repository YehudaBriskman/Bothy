# Design and brand system

_Status as of 2026-08-10. Extracted from the Bothy portal (`apps/portal-next`),
which is the reference implementation._

Everything that has to be decided before a website or an interface is finished,
written down once so the next project does not rediscover it.

Two things live here, and they are deliberately separate:

- **[CHECKLIST.md](CHECKLIST.md)** — the list. Around 180 items across 25
  groups. Every item says whether it is a **must** or **optional**, and how it
  is **verified**. This is the file to run against a project.
- **The topic documents** — one per group. Each states the rule
  product-agnostically, then ends with **"What Bothy decided, and why"**. That
  last section is the only part a new project rewrites.

> **Starting something new?** Go straight to
> [reference/new-project.md](reference/new-project.md). It is the same content
> ordered by when it blocks you, rather than by category.

## How to use it

**On a new project.** Copy this whole tree into the new repo (or link to it, if
it is a project on this box). Work through
[reference/new-project.md](reference/new-project.md) in order. Replace each
"What Bothy decided" section with your own answer. An unanswered section is a
decision you have not made yet, not a section to delete.

**On an existing project.** Run [CHECKLIST.md](CHECKLIST.md) top to bottom and
record a verdict for every line: pass, fail, or not applicable with a reason.
"Not applicable" is a legitimate and common answer — write down why, because
next year nobody will remember.

**When you change the system itself.** See
[quality/governance.md](quality/governance.md). The short version: the token
file is the source of truth, docs carry a status date, and dead ends are
recorded rather than deleted.

## Verification legend

Every checklist line begins with two tags.

| Tag | Meaning |
|---|---|
| `M` | Must. A violation is a defect. |
| `O` | Optional. Decide per project, and record the decision either way. |
| `A` | Automatic. A script, validator, Playwright assertion or Lighthouse run can pass or fail it unattended. |
| `S` | Semi-automatic. A machine finds the candidates, a human rules on them. |
| `H` | Human judgement only. The value of the item is that it forces the decision to exist in writing. |

Roughly 60 of the items are `H`. That is not a weakness in the list — voice,
hierarchy and "is this distinction meaningful" are not machine questions. What
the list guarantees is that they were asked.

## The three standing rules

These outrank everything else in this tree. They are stated in full in
[foundations/principles.md](foundations/principles.md).

1. **Status colours are reserved.** The status palette encodes state and is
   never used as decoration.
2. **Chrome accents never encode state.** The panel accents are decoration and
   never carry meaning.
3. **An element's footprint is proportional to the number of information
   dimensions it carries.** One bit does not get a full-width row.

And one derived rule that is violated more often than all three combined:
**colour is never the only encoder.** It is always second, behind a glyph, a
position, a label or an order.

## Map

Reading order, not alphabetical order. The navigation on the left is
alphabetical because MkDocs builds it automatically; this table is the one that
knows what depends on what.

### Foundations — decide these first, everything else references them

| File | What it answers |
|---|---|
| [foundations/principles.md](foundations/principles.md) | Which rule wins when two rules disagree |
| [foundations/brand-core.md](foundations/brand-core.md) | What it is called, who it is for, how it speaks |
| [foundations/logo-and-app-icons.md](foundations/logo-and-app-icons.md) | The mark, and every icon file that must ship |
| [foundations/colour.md](foundations/colour.md) | What colours exist, what each is for, how legality is proved |
| [foundations/theming.md](foundations/theming.md) | How light and dark work without a flash or a drift |
| [foundations/typography.md](foundations/typography.md) | What sizes and families exist, and when each is used |
| [foundations/space-and-layout.md](foundations/space-and-layout.md) | How wide anything is, and how far apart |
| [foundations/shape-and-elevation.md](foundations/shape-and-elevation.md) | How round, how raised, and what raised means |
| [foundations/motion.md](foundations/motion.md) | How long, what easing, and what happens when motion is refused |
| [foundations/iconography.md](foundations/iconography.md) | Which icons, at what size, meaning what |

### Patterns — how the pieces behave

| File | What it answers |
|---|---|
| [patterns/components.md](patterns/components.md) | What exists already, so you do not build it twice |
| [patterns/component-states.md](patterns/component-states.md) | Which states every component owes, and what each looks like |
| [patterns/navigation.md](patterns/navigation.md) | How someone gets anywhere, and how they know where they are |
| [patterns/forms.md](patterns/forms.md) | How input works, fails and recovers |
| [patterns/data-display.md](patterns/data-display.md) | How a row of facts is drawn |
| [patterns/dataviz.md](patterns/dataviz.md) | How a number is drawn so it cannot lie |
| [patterns/feedback.md](patterns/feedback.md) | How the system talks back |
| [patterns/scrolling.md](patterns/scrolling.md) | What happens when there is more than fits |

### Quality — how it is proved

| File | What it answers |
|---|---|
| [quality/accessibility.md](quality/accessibility.md) | How WCAG 2.2 AA is actually demonstrated |
| [quality/responsive.md](quality/responsive.md) | What it looks like on a phone, and whether a thumb can hit it |
| [quality/performance.md](quality/performance.md) | What the budget is, and what blows it |
| [quality/content-and-microcopy.md](quality/content-and-microcopy.md) | What words, in what case, with what numbers |
| [quality/metadata-and-seo.md](quality/metadata-and-seo.md) | What a crawler or a link preview sees |
| [quality/pwa-and-manifest.md](quality/pwa-and-manifest.md) | What happens when someone installs it |
| [quality/security-and-privacy.md](quality/security-and-privacy.md) | What can leak, and what stops it |
| [quality/error-and-edge-pages.md](quality/error-and-edge-pages.md) | What the user sees when it is broken |
| [quality/internationalisation.md](quality/internationalisation.md) | Whether it survives another language or direction |
| [quality/print.md](quality/print.md) | Whether a printed page still makes sense |
| [quality/browser-support.md](quality/browser-support.md) | Where it is promised to work |
| [quality/qa-and-verification.md](quality/qa-and-verification.md) | How any of this is checked |
| [quality/governance.md](quality/governance.md) | Who changes the system, and how |

### Reference

| File | What it answers |
|---|---|
| [reference/tokens.md](reference/tokens.md) | The exact value of every token, in both themes |
| [reference/bothy.md](reference/bothy.md) | Every parameter, filled in for Bothy |
| [reference/new-project.md](reference/new-project.md) | The shortest path when starting today |
| [reference/decisions.md](reference/decisions.md) | Why it is like this, and what was already tried |
| [reference/open-questions.md](reference/open-questions.md) | What nobody has decided yet |

## What this is not

- **Not a component library.** There is no package to install. It is a set of
  decisions and the reasoning behind them; the code that implements them lives
  in the project.
- **Not a brand book.** No print collateral, no merchandise, no slide themes.
  Scope is a browser product and the metadata around it.
- **Not aspirational.** Everything in the "What Bothy decided" sections
  describes what the code does today. Where the code is wrong, it is listed in
  [reference/open-questions.md](reference/open-questions.md) instead of being
  quietly written up as though it were done.

## Keeping this useful

Same discipline as [the knowledge base](../kb/README.md): date every claim,
record dead ends beside decisions, and mark a superseded document retired with
a pointer rather than deleting it. A design system that describes a version of
the product that no longer exists is worse than none, because it is trusted.
