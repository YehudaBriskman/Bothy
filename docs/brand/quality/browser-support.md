# Browser support

_Status as of 2026-08-10._

## The rule

**Publish a matrix**: browser, minimum version, and *why* that floor. "Modern
browsers" is not a support statement.

**The floor is set by features, not by preference.** List the CSS and JS
features you rely on, find the one with the latest support date, and that is
your floor. Writing it down turns an accident into a decision.

**State the degradation per feature** - what a browser below the floor actually
sees. "It breaks" is a valid answer if it is written down.

**Feature detection, never user-agent sniffing.**

**Name a manual device matrix** - one phone, one tablet, one desktop, one narrow
window - and re-run it per release with a date.

## Checklist

See [CHECKLIST.md § 28](../CHECKLIST.md#28-browser-support).

## What Bothy decided, and why

**No matrix has been published**, and that is the gap. But the code already
implies a hard floor, and the honest thing is to write down the floor that
exists rather than to claim a wider one.

Features already relied on, each of which sets a floor:

| Feature | Used for | Degradation below the floor |
|---|---|---|
| `color-mix()` | Every status tint and derived colour | Colours fail to resolve; large parts of the interface lose their tints |
| `oklab` interpolation | All colour mixing | Same |
| `:has()` | Focus rings on wrapper elements | The wrapper focus ring does not appear |
| `mask-image` | Nav overflow fades | The fade does not render; the nav still scrolls |
| `backdrop-filter` | Sticky topbar, palette scrim | Falls back to a flat translucent surface |
| Dynamic viewport units | Not yet used | - |
| WebGL | The 3D topology | Detected, and falls back to a static diagram |

Only the last one is detected and handled. The others would fail silently, which
is the argument for writing the matrix down.

**What is verified today:** a recent Chromium, via the automated browser checks.
Nothing else has been tested.

Tracked in [reference/open-questions.md](../reference/open-questions.md).

## Dead ends

None recorded.

## How this is verified

- Check the feature list against the claimed matrix.
- Grep for user-agent sniffing.
- Run the manual device matrix and date-stamp the result.
