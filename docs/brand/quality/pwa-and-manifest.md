# PWA and manifest

_Status as of 2026-08-10._

## The rule

**A manifest is cheap and worth it even without a service worker.** It controls
the installed name, the icon, the splash colours and the launch behaviour. A web
app without one installs as a browser bookmark with a screenshot for an icon.

**Required fields:** name, short name (12 characters or fewer, or the launcher
truncates it), description, id, start URL, scope, display, background colour,
theme colour.

**`id` matters.** Without it the identity of the installed app is derived from
the start URL, so changing the start URL later creates a *second* installed app
rather than updating the first.

**Colours must equal the token values exactly**, not approximate them. The
manifest background is what is painted before the app renders; a near-miss
produces a visible flash of the wrong colour on launch.

**Icons: 192, 512, and a maskable variant.** Android crops to a platform shape.
Without a maskable icon with real padding, yours gets clipped - usually right
through the mark.

**The start URL must actually load** under the app's routing strategy. This is
easy to get wrong with fragment-based routing.

**A service worker is a decision, not a default.** If you add one you have taken
on cache invalidation, an update prompt, and a rule for how long an API response
may be served stale. A dashboard that shows cached data with no freshness rule is
worse than one that shows an error.

## Checklist

See [CHECKLIST.md § 23](../CHECKLIST.md#23-pwa-and-manifest).

## What Bothy decided, and why

- **A manifest ships**, with name, short name, description, start URL, scope,
  display, background and theme colours - the colours equal the token values.
- **Icons at 192 and 512**, plus the SVG and the 180px touch icon.
- **No service worker.** The product is a live view of a machine on a local
  network. Serving it from a cache is the opposite of what it is for, and an
  offline shell showing yesterday's container states would be actively
  misleading. The one thing a service worker would buy - an offline page - is
  less useful than the existing floor page, which still renders known service
  links when the APIs are unreachable.

**Known gaps**, tracked in
[reference/open-questions.md](../reference/open-questions.md): no `id` field, and
no maskable icon. Both are real defects against the rules above.

## Dead ends

None recorded.

## How this is verified

- Validate the manifest as JSON and check every required field is present.
- Check the icon files exist at the declared dimensions.
- Confirm the manifest colours equal the token values.
- Launch the installed app and confirm the start URL resolves.
