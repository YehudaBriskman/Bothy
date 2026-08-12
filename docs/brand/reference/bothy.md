# Bothy - the filled-in instance

_Status as of 2026-08-10._

Every parameter of the system, answered for the reference implementation, on one
page. Each row links to the document that explains the reasoning.

This is the page to copy when branding a new project: replace the right-hand
column, and the left-hand column is your checklist of what needs an answer.

## Identity

| Parameter | Bothy's answer | Detail |
|---|---|---|
| Name | Bothy - a hut in the hills left unlocked for whoever needs it | [brand-core](../foundations/brand-core.md) |
| Name checked | 2026-08-10, against software projects. Six of nine candidates were taken | [brand-core](../foundations/brand-core.md) |
| Description | "The dev box, and everything running on it." | [brand-core](../foundations/brand-core.md) |
| Voice | Precise, plain, unhurried. Not chatty, not reassuring, not clever | [brand-core](../foundations/brand-core.md) |
| Subtitle | `location.hostname`, read at run time, never written down | [brand-core](../foundations/brand-core.md) |
| Mark | A gabled shelter, door open, light on. The lit doorway is the only colour | [logo-and-app-icons](../foundations/logo-and-app-icons.md) |
| Icon source | One coordinate set, three generated outputs, one script | [logo-and-app-icons](../foundations/logo-and-app-icons.md) |

## Look

| Parameter | Bothy's answer | Detail |
|---|---|---|
| Scheme | Neutral zinc, dark-first | [colour](../foundations/colour.md) |
| Surfaces | Four opaque steps | [tokens](tokens.md) |
| Accent | Blue-400 dark, blue-600 light. Chrome only | [tokens](tokens.md) |
| Status | Five reserved states, full contract each | [tokens](tokens.md) |
| Chart palette | Five validated slots per theme, order load-bearing | [colour](../foundations/colour.md) |
| Themes | Dark, light, system. One palette copy each | [theming](../foundations/theming.md) |
| High contrast | Not a separate mode; a `forced-colors` block instead | [theming](../foundations/theming.md) |
| Type | System sans and mono. No webfont, zero font requests | [typography](../foundations/typography.md) |
| Type scale | **None declared** - a known gap | [open-questions](open-questions.md) |
| Spacing scale | **None declared** - a known gap | [open-questions](open-questions.md) |
| Radii | Five steps | [tokens](tokens.md) |
| Shadows | Three steps per theme; dark adds an inset hairline | [shape-and-elevation](../foundations/shape-and-elevation.md) |
| Motion | Three durations, one easing | [motion](../foundations/motion.md) |
| Icons | lucide, pinned. No emoji | [iconography](../foundations/iconography.md) |

## Behaviour

| Parameter | Bothy's answer | Detail |
|---|---|---|
| Navigation | Four destinations, topbar, underline for current | [navigation](../patterns/navigation.md) |
| Responsive nav | Labels collapse below 1080px and expand on hover or focus; the row x-scrolls whenever it actually overflows | [responsive](../quality/responsive.md) |
| Routing | Hash-based, static hosting, no rewrite | [metadata-and-seo](../quality/metadata-and-seo.md) |
| Scroll restoration | Owned by the app; top on push, restore on pop | [scrolling](../patterns/scrolling.md) |
| Scroll affordances | Inset edge shades, styled scrollbars, a left progress rail | [scrolling](../patterns/scrolling.md) |
| Dialog | Radix, styled with our tokens | [feedback](../patterns/feedback.md) |
| Command palette | Hand-written, roughly 180 lines | [components](../patterns/components.md) |
| Toasts | None | [feedback](../patterns/feedback.md) |
| Forms | Essentially none - the product is read-only | [forms](../patterns/forms.md) |
| Tables | 32px rows, sticky headers, exception-first sort | [data-display](../patterns/data-display.md) |
| Charts | Hand-written SVG, no library | [dataviz](../patterns/dataviz.md) |
| Data layer | One shared poll, settled promises, never clears on failure | [error-and-edge-pages](../quality/error-and-edge-pages.md) |
| Heavy content | The 3D scene is lazy-loaded and capability-gated | [performance](../quality/performance.md) |

## Platform

| Parameter | Bothy's answer | Detail |
|---|---|---|
| Manifest | Present, colours match tokens. **No `id`, no maskable icon** | [pwa-and-manifest](../quality/pwa-and-manifest.md) |
| Service worker | None, deliberately | [pwa-and-manifest](../quality/pwa-and-manifest.md) |
| Locale | Single, English, deliberately | [internationalisation](../quality/internationalisation.md) |
| Print | Out of scope, deliberately | [print](../quality/print.md) |
| Analytics | None | [security-and-privacy](../quality/security-and-privacy.md) |
| Third-party scripts | None | [security-and-privacy](../quality/security-and-privacy.md) |
| Storage keys | One: `portal-theme` | [security-and-privacy](../quality/security-and-privacy.md) |
| Security headers | **None served** - a known gap | [open-questions](open-questions.md) |
| Browser floor | Implied by `color-mix`, `oklab`, `:has()`, `mask-image`. **Not published** | [browser-support](../quality/browser-support.md) |

## Verification

| Parameter | Bothy's answer | Detail |
|---|---|---|
| Runs in CI | Typecheck, build, secret scan | [qa-and-verification](../quality/qa-and-verification.md) |
| Status truth table | Checked in beside the classifier | [qa-and-verification](../quality/qa-and-verification.md) |
| Visual checks | Real browser via Playwright, manual | [qa-and-verification](../quality/qa-and-verification.md) |
| Not automated | Accessibility audit, performance budget, screenshot matrix, token and contrast lint | [open-questions](open-questions.md) |

## Honest summary

The colour system, the motion invariants, the scroll behaviour, the data-failure
model and the visualisation rules are all decided, implemented and verified.

The scales - spacing, type, z-index - were never declared and are the biggest
structural gap. The quality gates are mostly manual. And there is no error
boundary, which means the blank-page failure mode this system has fought twice is
still reachable by one component throwing.

All of that is in [open-questions.md](open-questions.md) rather than being
written up here as though it were done.
