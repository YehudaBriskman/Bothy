# QA and verification

_Status as of 2026-08-10._

How anything in this system is actually checked.

## The rule

**Every checklist item names its verification.** An item nobody can check is a
wish. That is why every line in [CHECKLIST.md](../CHECKLIST.md) carries `A`,
`S` or `H`.

**Every verification command must be able to fail.** This is the most important
sentence in this document. Before trusting a check, prove it distinguishes the
failure it claims to detect — break the thing deliberately and watch the check
go red. A probe that returns the same result whether or not the condition holds
is not a check, and it is worse than no check because it produces confidence.

Two real examples from this project:

- A reachability probe used `fetch` with no-cors. An opaque response resolves for
  *any* HTTP status, so 502 and 401 both reported "up". It could not physically
  return "down" while the proxy was answering — and it rendered a green "Up" chip
  on five dead services.
- A proxy's health was "confirmed" by a 200 response. But the app owns a
  catch-all route, so a *missing* proxy also returns 200 — with the HTML shell.
  The check had to test the content type, not the status.

**A front-end change is not done until a real screenshot of it exists.** A
DOM-only test environment has no layout: "blank" and "perfect" are identical to
it. This project has shipped a near-blank page twice, both times past tests that
passed.

**Verify against a genuinely fresh load.** A cached bundle will faithfully
reproduce a bug you have already fixed, and you will debug the fix instead of
the bug. In a hash-routed app this is especially easy to get wrong: navigating to
the same URL with a different fragment is a *same-document* navigation — nothing
is re-requested and the old code keeps running. Change the path or force a
reload.

**Classification logic gets a truth table checked in beside it.** Any code that
maps messy inputs to a small set of states will be got wrong, and "half-fixed"
looks identical to "fixed" on a screenshot.

## Checklist

See [CHECKLIST.md § 30](../CHECKLIST.md#30-qa-and-verification).

## What Bothy decided, and why

**What runs today:**

- Typecheck and production build on every change.
- Secret scanning on push and periodically over full history.
- A container-status truth table in `apps/portal-next/checks/`, which also
  classifies the box's live container list.
- Real-browser verification through Playwright for anything visual.

**The assertions that have caught real bugs:**

| Assertion | What it caught |
|---|---|
| New navigation lands at 0; Back restores the exact offset | Two separate scroll-restoration bugs, one of which had silently destroyed its own saved data |
| Edge shade only on an axis that can scroll | A permanent shadow under the topbar |
| No debug globals on `window` | Instrumentation nearly shipping |
| Content type is JSON, not just status 200 | A missing proxy route reading as success |

**Known gaps**, tracked in
[reference/open-questions.md](../reference/open-questions.md): no automated
accessibility audit, no performance budget enforcement, no screenshot matrix, no
token or contrast linting. Everything in the "how this is verified" sections of
the other documents that is not in the list above is currently a manual step.

## Dead ends

- **Trusting a status code from a route behind a catch-all.** See above.
- **A probe that cannot express failure.** See above.
- **jsdom for anything visual.** No layout, so it cannot see the failure mode
  that matters most.

## The definition of done for an interface change

1. Typecheck and build clean.
2. Deployed, and loaded **fresh**.
3. A screenshot exists, at the widths and in the themes the change touches.
4. Zero console errors.
5. Any behaviour claimed is asserted, by a check that has been shown able to
   fail.
6. If it changed a token, a rule or a decision, the relevant document in this
   tree was updated in the same change.
