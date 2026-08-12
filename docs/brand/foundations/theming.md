# Theming and modes

_Status as of 2026-08-10._

How light and dark coexist without a flash on load and without drifting apart
over time.

## The rule

**The choice and the resolved theme are different things, and only the resolved
one reaches the DOM.** A user's preference has three values - light, dark,
system - but a stylesheet can only respond to two. Resolve `system` against the
OS in code and stamp a concrete value on the root element. Then the CSS carries
exactly one light palette and one dark palette.

**Stamp it before first paint.** A tiny inline script in the document head,
before any stylesheet is applied. Without it, a light-preferring user sees a
dark frame until the app mounts. This script is duplicated logic by design -
importing it would defeat the purpose - so keep it small and note the
duplication where both copies live.

**Keep exactly one copy of each palette.** The tempting alternative is a
`prefers-color-scheme` block *and* an explicit override block. Those two copies
will drift, and they drift silently: nobody notices a token that exists in one
and not the other until a colour is visibly wrong in exactly one configuration.

**Declare `color-scheme`.** It is what makes native controls, form widgets and
default scrollbars follow the theme. Without it they stay light on a dark page.

**Emit one `theme-color` per scheme.** It paints the browser and OS chrome
around the page. A single dark value puts white-on-white in a light-mode
address bar.

**Track a live OS change.** If a user picks "system", sampling the OS once at
mount is not enough - switching the desktop to light must switch the page. That
is the entire reason the option exists.

## Checklist

See [CHECKLIST.md § 5](../CHECKLIST.md#5-theming-and-modes).

## What Bothy decided, and why

- **Three choices, two palettes.** `dark` is the default; `light` and `system`
  are available; `system` is resolved through `matchMedia` and re-resolved on
  change.
- **Persistence key:** `portal-theme` in local storage. Listed in the storage
  inventory in [security-and-privacy](../quality/security-and-privacy.md).
- **Pre-paint stamp** lives inline in `index.html` and is deliberately a
  duplicate of the logic in the theme provider.
- **One light palette.** The duplicate `prefers-color-scheme` block was deleted
  after it had already drifted - one token existed in both copies and another in
  neither, which is exactly the failure mode a single source of truth prevents.
- **Both `theme-color` tags** are emitted, one per scheme.
- **No high-contrast mode.** Instead, a `forced-colors` block was added on
  2026-08-10 so Windows High Contrast works properly. That mode replaces
  declared colours with the user's own, which would otherwise make all five
  status marks identical - they are backgrounds, and forced backgrounds collapse
  together. The block gives every status mark a border, which is drawn in the
  system's colours and survives.

## Dead ends

- **Two copies of the light palette** (one for the pinned choice, one inside a
  media query). They drifted within weeks.
- **Resolving `system` in CSS only.** It cannot be done without the second
  palette copy above, and it makes the pre-paint stamp impossible.
- **`forced-color-adjust: none`.** Overriding the user's forced palette defeats
  the point of the mode. The fix is to add a shape or a border that survives, not
  to opt out.

## How this is verified

- Assert the resolved attribute is on the root element before the first paint,
  and that the first painted background matches the stored preference.
- Screenshot every route in both themes.
- Flip the OS preference mid-session with `system` selected and confirm the page
  follows.
