# Open questions and known gaps

_Status as of 2026-08-10._

Everything the checklist asks for that Bothy does not currently do. This file
exists so the rest of the tree can describe what is true rather than what is
intended.

Nothing here is a bug report against a feature. These are places where a
decision has not been made, or has been made and not implemented.

## Foundations

| Gap | Why it matters | Suggested default |
|---|---|---|
| **No spacing scale.** Padding and gap literals span roughly two dozen distinct values | Every spacing choice is made from scratch, and none of them can be changed globally | Adopt a closed ladder and migrate |
| **No type scale.** Seventeen distinct font sizes, 10.5px to 68px | Same, plus there is no way to check a size is legitimate | Close the list to about nine steps |
| **Two content widths disagree** - a 1180px token and a 1320px maximum | They answer "how wide is this product" differently | Pick one, or give each a named role |
| **z-index is literals only** - seven values, none named | A layering bug is a guess to debug | Name them as tokens |
| **Literal durations bypass the motion tokens** in several places | The tokens stop being the source of truth | Route through the tokens or name the exceptions |

## Accessibility

| Gap | Why it matters |
|---|---|
| **Route changes are not announced and do not move focus** | A screen-reader user is left on a page that silently changed. The most significant outstanding item |
| **The 3D topology has no non-drag alternative** for orbiting | WCAG 2.2 criterion 2.5.7. The focus buttons are a partial path |
| **No automated audit runs anywhere** | Everything claimed was checked by hand or by targeted assertions |
| **No screen-reader pass has been recorded** | Nobody has heard this interface |

## Robustness

| Gap | Why it matters |
|---|---|
| **No error boundary** | A single component throwing unmounts the whole application - the blank-page failure mode again |
| **No dynamic viewport units, no safe-area insets** | Fixed chrome can be clipped on a notched phone, and mobile URL-bar resize is unhandled |
| **No `overscroll-behavior: contain`** on overlays and inner scrollers | Scrolling to the end of a panel scrolls the page behind it |

## Metadata and platform

| Gap | Why it matters |
|---|---|
| **Titles are not per-route** - every page shares one | Browser history and bookmarks are unusable |
| **No `robots.txt`, no Open Graph tags, no social image** | No policy stated; link previews are blank |
| **Manifest has no `id`** | Changing the start URL later creates a second installed app |
| **No maskable icon** | Android crops the icon, probably through the mark |

## Security

| Gap | Why it matters |
|---|---|
| **No content security policy**, and no other security headers | The pre-paint theme script would need hashing before a strict policy could be adopted |

## Quality gates

| Gap | Why it matters |
|---|---|
| **No performance budget**, and nothing enforces one. The main chunk is over the default warning threshold | A budget nobody checks is a preference |
| **No token, contrast or palette linting** | The recorded contrast numbers can drift from the token values silently |
| **No screenshot matrix** | Both-theme, all-width regressions are invisible |
| **No browser support matrix**, though the CSS already implies a hard floor | See [browser-support](../quality/browser-support.md) for the floor that exists |

## Deliberately not doing

These are decided, not pending. Recorded here so nobody re-opens them without
new information.

| Decision | Reason |
|---|---|
| **No service worker** | A live view of machine state should not be served from a cache |
| **Print styles out of scope** | Nothing in the product is a document |
| **Single locale** | One reader, one machine |
| **No toasts** | Every action has a visible local result |
| **No analytics** | Nothing to learn that is worth the surface |
| **No charting library** | Hand-written SVG is smaller and exact |
| **Hash routing, and its metadata consequence** | Static hosting with no rewrite; private surface |
