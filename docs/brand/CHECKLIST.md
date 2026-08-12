# The checklist

_Status as of 2026-08-10._

Everything that must be handled in a design or a website. 184 items in 25
groups. Run it top to bottom and record a verdict for every line: pass, fail,
or not applicable with a written reason.

Each line starts with two tags - `[M]` must or `[O]` optional, then `[A]`
automatic, `[S]` semi-automatic or `[H]` human judgement. The legend is in
[README.md](README.md#verification-legend).

Order is roughly dependency order: colour before components, components before
accessibility, everything before QA. If you are starting a project today, use
[reference/new-project.md](reference/new-project.md) instead - same items,
ordered by when they block you.

---

## 1. Principles

See [foundations/principles.md](foundations/principles.md).

- `[M][H]` State the standing rules where they can be found, and cite them from the code that obeys them.
- `[M][A]` Never write a raw hex or `rgb()` for text, surface, line or state outside the token declaration blocks.
- `[M][A]` Never write a literal duration, radius or border width where a token exists.
- `[M][H]` Never encode information by colour alone. Colour is always the second encoder, behind a glyph, position, label or order.
- `[M][S]` Every non-obvious rule in code carries a comment saying **why**, not what.
- `[M][H]` Record dead ends beside the decision. A ruled-out approach is worth as much as the chosen one.
- `[M][A]` No emoji anywhere in the interface.
- `[M][H]` When two rules conflict, accessibility wins; after that, the reserved-colour rules win over aesthetics.

## 2. Brand core

See [foundations/brand-core.md](foundations/brand-core.md).

- `[M][S]` Check the name is not already taken by a project in the same space, and record where you checked.
- `[M][A]` Fix one spelling and casing of the name; grep the repo for every variant and reconcile.
- `[M][A]` Write one canonical description string and use the same bytes in the page description, the manifest and the repo README.
- `[M][H]` Write a tagline under 140 characters that says what it does, not how it feels.
- `[M][H]` Name the audience and the single job-to-be-done, one sentence each.
- `[M][H]` Choose three voice adjectives and three explicit anti-adjectives.
- `[M][H]` Write the naming rule for sub-surfaces before creating the second one.
- `[M][A]` Record the address of record and the fallback address, date-stamped. A name that no longer resolves must be marked dormant, not left in the wordmark.
- `[M][A]` Ship a licence, and state the mark's attribution requirement separately from the code licence.
- `[M][H]` Keep a never-say list of words the product misuses.
- `[O][H]` Record where the name came from, so nobody renames it by accident.

## 3. Logo and app icons

See [foundations/logo-and-app-icons.md](foundations/logo-and-app-icons.md).

- `[M][A]` Keep one source of truth for the mark geometry; every raster is generated from it by a checked-in script.
- `[M][A]` Re-running the generator produces byte-identical output - no timestamps, no randomness.
- `[M][A]` Ship an SVG favicon, referenced with `type="image/svg+xml"`.
- `[M][A]` Ship `apple-touch-icon.png` at exactly 180x180 with an opaque background.
- `[M][A]` Ship 192x192 and 512x512 PNGs and list them in the manifest.
- `[M][A]` Ship a maskable icon with at least 20 percent safe padding on every side.
- `[M][H]` Check the mark is legible at 16px by rendering it at 16px, not by zooming out.
- `[M][S]` Check the mark reads on every background it can land on, with no baked-in background rectangle.
- `[M][H]` Produce a one-colour variant for print, stamps and forced-colours mode.
- `[M][H]` State clear space as a multiple of a mark dimension, plus a minimum pixel size.
- `[M][H]` State when the wordmark is used and when the mark stands alone.
- `[M][A]` The SVG has a `viewBox`, no fixed width or height, no embedded raster, no internal `<style>` block.
- `[M][A]` The SVG uses `currentColor` except for deliberate accent elements.
- `[M][A]` Manifest `theme_color` and `background_color` equal the token values exactly, not approximations.
- `[O][A]` Ship a 1200x630 social image under 300KB.
- `[O][H]` Check the social image is readable at thumbnail size.
- `[O][A]` Ship `favicon.ico` only if the support matrix contains a browser that needs it.

## 4. Colour

See [foundations/colour.md](foundations/colour.md).

- `[M][A]` Declare the elevation ladder as a fixed number of named steps. No component invents an intermediate mix.
- `[M][A]` Both themes declare exactly the same set of token names. A token present in one only is a defect - diff the key sets.
- `[M][A]` Record a measured contrast ratio beside every foreground token, per surface it is used on.
- `[M][A]` Body text meets 4.5:1. Large text meets 3:1. Component boundaries and meaningful graphics meet 3:1.
- `[M][S]` Re-measure every muted or subtle token at the smallest size it is actually used at, not at 16px.
- `[M][H]` Treat the light palette as a second selection, not an inversion or a tint of the dark one.
- `[M][A]` Validate the categorical chart palette per theme: lightness band for that mode, chroma floor, adjacent-pair CVD separation, normal-vision separation, and 3:1 against the surface it sits on.
- `[M][A]` Assign series to palette slots in a fixed order. Never reorder, never cycle by array index.
- `[M][S]` Any adjacent chart pair inside the CVD floor band requires a legend and direct labels. Assert both exist wherever that pair can co-occur.
- `[M][A]` Every status defines the full contract: base fill, text variant, tint, border.
- `[M][H]` Order status weight by urgency in each theme, or record why that is impossible in that theme and what carries urgency instead.
- `[M][H]` Document every status fill that deliberately fails 3:1, with the reason it is safe.
- `[M][A]` Derive all tints from a fixed, declared set of percentages. Grep for ad-hoc mixes outside that set.
- `[M][A]` Interpolate colour mixes in a perceptual space, not sRGB.
- `[M][A]` Use the text variant, never the base fill, when a status or accent colour is used as text.
- `[M][A]` Define a foreground token for text on a filled accent.
- `[M][A]` The focus ring meets 3:1 against every surface it can land on.
- `[M][H]` Gradients are chrome only. A gradient never encodes a value.
- `[M][H]` Decide and record the link colour, the visited treatment and the selection colour.
- `[M][H]` Record the dead ends, especially any palette that was rejected and why.

## 5. Theming and modes

See [foundations/theming.md](foundations/theming.md).

- `[M][A]` Stamp the resolved theme before first paint. Assert no flash of the wrong theme.
- `[M][A]` Keep exactly one copy of each palette. A second copy behind a media query will drift, and drift silently.
- `[M][A]` Declare `color-scheme` per theme so native controls and scrollbars follow.
- `[M][A]` Emit one `theme-color` per scheme.
- `[M][A]` Name and document the persistence key, and list it in the storage inventory.
- `[M][A]` Resolve a "system" preference through `matchMedia`, and re-resolve when the OS changes mid-session.
- `[M][A]` Screenshot every route in both themes.
- `[M][H]` Decide whether a high-contrast mode exists. If not, say so and point at forced-colours support instead.

## 6. Typography

See [foundations/typography.md](foundations/typography.md).

- `[M][A]` Declare one sans token and one mono token. No component names a family directly.
- `[M][A]` Default to a system stack. A webfont must be self-hosted, subset, preloaded, `font-display: swap`, and inside the byte budget.
- `[M][H]` Enumerate the type scale as a closed list of sizes with the role of each. A size not on the list is a defect.
- `[M][A]` No text below the stated minimum size, and text at the minimum is re-checked for contrast at that size.
- `[M][A]` Base line-height at least 1.5 for prose; heading line-heights declared per size.
- `[M][A]` Use tabular numerals for every number that updates, is compared, or sits in a column.
- `[M][H]` Use the mono stack for identifiers only - hostnames, ports, paths, keys, hashes.
- `[M][A]` Cap prose blocks at a stated measure in `ch`.
- `[M][S]` Every truncation has an escape: a title, a tooltip, or a detail view with the full value.
- `[M][H]` Break-anywhere wrapping is for opaque identifiers, never for prose.
- `[M][A]` Exactly one `h1` per page, and no skipped heading levels.
- `[M][S]` Cap the weight ladder at three weights.
- `[M][S]` The layout survives 200 percent zoom and a user font-size override.

## 7. Space and layout

See [foundations/space-and-layout.md](foundations/space-and-layout.md).

- `[M][H]` Declare a closed spacing scale. Every gap, padding and margin comes from it.
- `[M][A]` Grep for spacing literals that are not on the scale.
- `[M][H]` Declare one content width per layout family, and reconcile any conflicting maxima.
- `[M][A]` Declare page padding per breakpoint as tokens, not as per-component literals.
- `[M][A]` Card grids are content-driven, with the minimum column width recorded per density.
- `[M][A]` Declare a z-index ladder as named tokens. Grep for numeric literals.
- `[M][A]` Enumerate every sticky element with its offset and its layer.
- `[M][A]` No horizontal page scroll at any width in the support range.
- `[M][S]` Every flex or grid child containing truncatable text sets `min-width: 0`.
- `[M][H]` Apply the footprint rule: a full-width row must carry at least three information dimensions.
- `[M][A]` Apply safe-area insets to fixed chrome.
- `[M][H]` Layout must not depend on a JavaScript-measured height.

## 8. Shape and elevation

See [foundations/shape-and-elevation.md](foundations/shape-and-elevation.md).

- `[M][A]` Declare a radius ladder; grep for numeric `border-radius` literals.
- `[M][S]` Map each radius step to a size class: chips, controls, inputs, panels, pills.
- `[M][A]` Declare one border-width token.
- `[M][A]` Declare shadow recipes per theme. Grep the light theme for a hardcoded black shadow.
- `[M][S]` Map each shadow step to an elevation meaning: at rest, lifted, floating.
- `[M][H]` Shadows never indicate state.
- `[M][A]` Surfaces are opaque, except for an enumerated list of overlay chrome.
- `[M][H]` Elevation must not vary with page position. No tinted, position-dependent backdrop beneath the ladder.

## 9. Motion

See [foundations/motion.md](foundations/motion.md).

- `[M][A]` Declare duration and easing tokens; grep for literal time values.
- `[M][A]` Animate only `transform`, `opacity` and `filter`. Grep for animated `height`, `width`, `top`, `left`, `margin`.
- `[M][H]` Every entrance animation starts from a **visible** resting state, so a skipped animation cannot leave content hidden.
- `[M][A]` No visibility gated on an intersection observer.
- `[M][A]` Cap stagger delays so the last item does not wait seconds.
- `[M][A]` A global reduced-motion block exists, and it collapses durations rather than setting `display` or `opacity`.
- `[M][A]` Under emulated reduced motion, every route still renders all of its content.
- `[M][S]` Where motion carried an affordance, reduced motion gives the instant version, not the removal.
- `[M][A]` Nothing flashes more than three times per second.
- `[M][A]` Heavy scenes are lazy-loaded, capability-gated, and fall back to a static render.
- `[M][H]` Motion never carries information that exists nowhere else.

## 10. Iconography

See [foundations/iconography.md](foundations/iconography.md).

- `[M][A]` Name one icon library and pin its version.
- `[M][A]` No emoji as interface iconography.
- `[M][S]` Cap icon sizes at a small number of container and glyph sizes.
- `[M][A]` One stroke width across the set.
- `[M][A]` Decorative icons are hidden from assistive technology; meaningful icons carry an accessible name.
- `[M][A]` Every icon-only control has both a label and a tooltip.
- `[M][A]` The icon mapping is a data table, not a conditional chain, and specific names are matched before vendor names.
- `[M][A]` Every status has a distinct glyph as well as a distinct colour. Unit-test the mapping for uniqueness.
- `[M][A]` A fallback glyph exists for anything unmapped.
- `[M][A]` Icons inherit the current colour; grep for hardcoded fills.

## 11. Component inventory

See [patterns/components.md](patterns/components.md).

- `[M][S]` Maintain an inventory table: name, file, tokens consumed, states supported, accessibility contract, used-by.
- `[M][S]` A component not in the inventory does not exist. Adding one requires the row.
- `[M][A]` The global utility layer is owned by one file. Page CSS is co-located and never edits it.
- `[M][A]` No component introduces a colour. Every colour it uses is a token reference.
- `[M][A]` Every interactive element is a real button or link. Grep for click handlers on non-interactive elements.
- `[M][H]` A component has at most one visual-variant axis and one size axis. A third axis means it is two components.
- `[M][S]` Every primitive has a rendered example somewhere a human can look at it.

## 12. Component states

See [patterns/component-states.md](patterns/component-states.md). The matrix
every interactive component must answer: default, hover, focus-visible, active,
current, disabled, read-only, loading, empty, partial, error, offline or stale,
skeleton, invalid, required.

- `[M][A]` Every interactive class declares hover, focus-visible, active and a disabled treatment.
- `[M][A]` `outline: none` never appears without a replacement indicator in the same rule. Grep and fail on unpaired occurrences.
- `[M][A]` The focus indicator is the global ring, at the declared width and offset, on every focusable element including scroll containers.
- `[M][S]` Disabled uses the opacity token, sets the right ARIA or native attribute, and does not silently remove an element from the tab order.
- `[M][S]` Loading states are shape-matched skeletons that reserve the incoming layout.
- `[M][H]` An empty state is a note, not an announcement. It is smaller than the content it replaces.
- `[M][H]` An empty state offers the action that fixes it only when such an action exists. No dead controls.
- `[M][S]` An error state is louder than an empty state and carries a retry.
- `[M][H]` A partial state exists. One failing data source degrades the page; it never blanks it.
- `[M][S]` A stale state shows the age of the data, not just the data.
- `[M][H]` Every hover-revealed affordance has a focus and a touch equivalent.
- `[M][H]` "You are here" is marked differently from "press me".
- `[M][A]` The state ARIA attributes are used per role and validated automatically.
- `[M][S]` State changes a sighted user can see are announced when they matter.

## 13. Navigation and information architecture

See [patterns/navigation.md](patterns/navigation.md).

- `[M][A]` Maintain a route table and assert it matches the router config.
- `[M][H]` State the destination count at which a topbar becomes a sidebar.
- `[M][A]` The current nav item carries `aria-current` and a visual mark.
- `[M][A]` No dead ends: every detail page has a back link or breadcrumb.
- `[M][A]` Deep links work on the deployment target. If the host cannot rewrite, hash routing is used and that consequence is recorded.
- `[M][A]` An unknown route renders a not-found page, never a blank shell, and the bad URL stays in the address bar.
- `[M][A]` Nav overflow behaviour is driven by actual overflow, not by a width breakpoint.
- `[M][A]` A command palette, if present, opens by keyboard, keeps focus in its input, drives selection without moving focus, closes on Escape, and restores focus to its trigger.
- `[M][H]` A search affordance that opens a surface is a button, not an input that pushes history on every keystroke.
- `[M][H]` Decide whether filter and tab state lives in the URL. It determines whether a view is shareable.
- `[M][A]` The skip link is the first tab stop and becomes visible on focus.
- `[M][A]` External links carry `rel="noopener"` and a visible new-tab affordance.
- `[M][H]` Nav order is fixed. It never reorders itself based on data.

## 14. Forms and validation

See [patterns/forms.md](patterns/forms.md).

- `[M][A]` Every input has a programmatically associated visible label. A placeholder is not a label.
- `[M][H]` Placeholder text is an example, never an instruction.
- `[M][A]` Required fields are marked in text as well as in ARIA, never by colour alone.
- `[M][A]` Set type, input mode and autocomplete on every field where they apply.
- `[M][H]` Decide the validation timing: on blur, then on change once a field has errored. Never on the first keystroke.
- `[M][A]` Error text sits beside its field, is linked by `aria-describedby`, and a submit-time failure raises a live region.
- `[M][H]` Error text says what happened and what to do. It never says only "invalid", and never blames the user.
- `[M][S]` Forms longer than three fields show an error summary linking to each failing field.
- `[M][H]` Decide one submit policy - disabled-until-valid, or always-enabled with explanation - and never mix them.
- `[M][A]` Submit prevents double submission and shows a loading state.
- `[M][H]` Destructive actions require typed confirmation or an undo window, never a bare "are you sure".
- `[M][A]` Secret fields use a password input, offer a reveal toggle, and never appear in logs or URLs.
- `[M][A]` Enter submits, Escape cancels, and tab order matches visual order.
- `[M][A]` Every control meets the 24x24 minimum; primary actions aim for 44x44.
- `[M][H]` Authentication imposes no unaided cognitive-function test.

## 15. Data display and tables

See [patterns/data-display.md](patterns/data-display.md).

- `[M][H]` State the row height and the reason. Extra vertical padding must carry information.
- `[M][A]` A sticky header requires a bounded max-height on its scroll container.
- `[M][A]` Sortable headers are keyboard-activatable, carry `aria-sort`, and show a direction indicator.
- `[M][H]` The default sort on anything about health is exception-first, not alphabetical.
- `[M][A]` Numbers are right-aligned with tabular numerals; text is left-aligned; nothing is centred.
- `[M][H]` Decide the narrow-viewport strategy: stack, hide by priority, or scroll with a sticky first column.
- `[M][A]` "No rows at all" and "no rows match the filter" are two states with two different messages.
- `[M][S]` Row hover and row selected are visually distinct.
- `[M][H]` A clickable row still contains a real link, so it can be middle-clicked and copied.
- `[M][A]` The scroll container is focusable and keyboard-scrollable, with a focus ring.
- `[M][A]` Every table has a caption or an accessible name.
- `[M][S]` Every data surface states when it was last updated.
- `[O][H]` State the row count above which the list is virtualised.

## 16. Data visualisation

See [patterns/dataviz.md](patterns/dataviz.md).

- `[M][A]` Use only validated palette slots. An improvised extra colour is a defect.
- `[M][A]` Series-to-slot binding is stable across renders, filters and sorts.
- `[M][A]` Every multi-series chart ships both a legend and direct labels.
- `[M][A]` Status colours never appear as series colours, and series colours never encode status.
- `[M][H]` One y-axis. Two measures of different scale get two charts.
- `[M][H]` Part-to-whole uses a stacked bar, not a donut.
- `[M][H]` Two graphics within sight of each other agree on their denominator.
- `[M][H]` Values excluded from a measurement are drawn detached and labelled as not counted.
- `[M][A]` Every chart has an accessible name that states the actual numbers.
- `[M][S]` Bar baselines start at zero. A non-zero baseline is labelled.
- `[M][S]` Units appear on the axis or in the label, never implied.
- `[M][S]` Time series state their window, and have an honest "collecting" state for a cold buffer.
- `[M][S]` Gaps in data are drawn as gaps, never as zeros.
- `[M][A]` Chart tooltips open on keyboard focus as well as hover.
- `[M][H]` No 3D charts.
- `[M][H]` Record the threshold at which a charting library becomes worth its bytes.

## 17. Feedback and overlays

See [patterns/feedback.md](patterns/feedback.md).

- `[M][A]` One dialog implementation. It sets `aria-modal`, has an accessible name, traps focus, restores focus on close, and closes on Escape.
- `[M][S]` Only one dialog open at a time. No nested modals.
- `[M][A]` Dialogs cap their height and scroll internally.
- `[M][A]` Tooltips open on hover **and** on keyboard focus.
- `[M][H]` A tooltip is never the only carrier of information.
- `[M][S]` The `title` attribute is a third fallback, for touch, where hover and focus both fail.
- `[M][H]` Decide whether toasts exist. If yes: capped stack, minimum five seconds, dismissible, polite live region, and never the only record of an error.
- `[M][H]` Destructive confirmations name the object and the consequence.
- `[M][S]` Any action over 300ms shows feedback within 100ms.
- `[M][A]` Nothing moves focus without user intent.
- `[M][A]` Content shown on hover or focus is dismissible, hoverable and persistent.

## 18. Scrolling

See [patterns/scrolling.md](patterns/scrolling.md).

- `[M][A]` A new navigation starts at the top; a back navigation restores the previous offset. Assert both.
- `[M][A]` Take manual control of the browser's own scroll restoration while the app owns it, and hand it back on unmount.
- `[M][A]` Edge shades are inset shadows on the border box, never absolutely positioned children inside the scroller.
- `[M][A]` The neutral shade value is a fully transparent shadow, never `none` and never `0 0`.
- `[M][A]` A shade appears only on a side the element can still travel toward, and only on an axis whose overflow actually permits scrolling.
- `[M][A]` Style scrollbars for both engines.
- `[M][S]` A hidden scrollbar is allowed only where another affordance replaces it.
- `[M][A]` A page progress indicator is hidden when the page does not scroll.
- `[M][A]` Progress animates with a transform, never a height.
- `[M][S]` Inner-scroll panels declare a max height. Never nest a scroller inside a scroller.
- `[M][A]` Anchored targets set a scroll margin equal to the sticky chrome height.
- `[M][A]` Overlays and inner scrollers contain their overscroll.
- `[M][H]` No scroll-jacking, and no infinite scroll without a reachable footer.

## 19. Responsive and touch

See [quality/responsive.md](quality/responsive.md).

- `[M][A]` Declare a closed breakpoint set; grep for media queries at any other width.
- `[M][A]` Test at 320, 360, 390, 768, 1024, 1280, 1440 and 1920.
- `[M][H]` Prefer content-driven layout. Add a breakpoint only where content cannot decide.
- `[M][A]` No horizontal scroll at the narrowest supported width, on any route.
- `[M][A]` Every target meets 24x24; frequent targets meet 44x44; adjacent targets are separated.
- `[M][A]` Every hover-only rule has a focus or touch counterpart.
- `[M][A]` The viewport meta permits zoom. No `user-scalable=no`, no `maximum-scale`.
- `[M][S]` The app works in landscape on a phone. No orientation lock.
- `[M][A]` Use dynamic viewport units where the mobile URL bar changes the viewport.
- `[M][S]` Heavy canvas or 3D content is downgraded or disabled on small and low-power devices.
- `[M][A]` Content reflows at 320px and at 400 percent zoom without loss of function.

## 20. Accessibility

See [quality/accessibility.md](quality/accessibility.md).

- `[M][A]` Run an automated audit on every route in both themes. Zero serious or critical findings.
- `[M][A]` Exactly one `h1` per page; no skipped levels.
- `[M][A]` Landmarks present, and the main landmark is the skip-link target.
- `[M][A]` A visible focus indicator on every focusable element.
- `[M][A]` The focused element is never obscured by sticky chrome.
- `[M][S]` Focus order matches visual order.
- `[M][S]` A keyboard-only pass of every flow finds no trap and no unreachable control.
- `[M][H]` Every drag interaction has a non-drag alternative.
- `[M][H]` Colour is never the only visual means of conveying information.
- `[M][A]` Text contrast 4.5:1; large text and non-text contrast 3:1.
- `[M][A]` The page survives the standard text-spacing override.
- `[M][S]` Content on hover or focus is dismissible, hoverable and persistent.
- `[M][A]` Reduced motion is honoured, and hides nothing.
- `[M][A]` A forced-colours block exists, and status distinctions survive in it.
- `[M][H]` Run a screen-reader pass over the core flows and record what was heard.
- `[M][S]` Updates that change meaning are announced through a live region.
- `[M][A]` Images have alt text; decorative images and SVGs are hidden.
- `[M][A]` The document language is set and correct.
- `[M][A]` Every route has a unique, descriptive document title.
- `[M][A]` Route changes in a single-page app are announced, and focus moves to the new heading.
- `[O][H]` Publish an accessibility statement with the known gaps.

## 21. Content and microcopy

See [quality/content-and-microcopy.md](quality/content-and-microcopy.md).

- `[M][A]` Sentence case for headings, buttons and labels. Lint for title case.
- `[M][H]` Buttons are verbs, and the verb names the outcome.
- `[M][H]` Error messages follow one formula: what happened, why if known, what to do next.
- `[M][S]` Never surface a raw exception, stack trace or bare status code.
- `[M][H]` Never say "unknown" when the truth is "we have not checked". Name whose knowledge is missing.
- `[M][A]` Maintain a vocabulary table with one word per concept and a banned-synonym list.
- `[M][H]` Define every state word once, in one place, with the boundary between them.
- `[M][S]` Show relative times for recency, with the absolute timestamp available.
- `[M][S]` Never show more precision than the source has.
- `[M][A]` Choose binary or decimal byte units, state which, and unit-test the formatter.
- `[M][A]` One duration format, unit-tested.
- `[M][H]` State the rounding rule for percentages. Never round up to 100 percent.
- `[M][H]` Empty-state copy names the reason and the next action.
- `[M][A]` No placeholder copy ships. Grep for it.
- `[M][H]` Any claim that could go stale carries a date.

## 22. Metadata and SEO

See [quality/metadata-and-seo.md](quality/metadata-and-seo.md).

- `[M][A]` A unique title per route, following one pattern, under 60 characters.
- `[M][A]` A description per route, 110 to 160 characters.
- `[M][A]` A canonical link, or a recorded reason why one is impossible.
- `[M][A]` Open Graph title, description, image, url, type and site name.
- `[M][A]` A social card type and image alt text.
- `[M][A]` `robots.txt` states the intended policy explicitly, including the private case.
- `[M][A]` Character set, viewport and language are present.
- `[M][S]` Verify the social preview with a real fetch, not by reading the markup.
- `[M][H]` Record the routing consequence: hash routing means per-route metadata is not crawlable. Accept it in writing, or switch to history routing and add the server rewrite.
- `[O][A]` A sitemap for a public site.
- `[O][A]` Structured data for a public site.

## 23. PWA and manifest

See [quality/pwa-and-manifest.md](quality/pwa-and-manifest.md).

- `[M][A]` The manifest is linked and is valid JSON.
- `[M][A]` Name, short name, description, id, start URL, scope, display, background colour and theme colour are all present.
- `[M][A]` Background and theme colours equal the token values exactly.
- `[M][A]` Icons include 192, 512 and a maskable variant.
- `[M][A]` The start URL actually loads under the app's routing strategy.
- `[M][A]` Apple touch icon present, plus standalone meta tags if standalone is intended.
- `[M][H]` Decide whether a service worker exists. If yes: an offline shell, an update prompt, a cache-versioning rule, and no cached API response without a freshness rule.

## 24. Security and privacy

See [quality/security-and-privacy.md](quality/security-and-privacy.md).

- `[M][A]` Secret scanning runs on every push and periodically over full history, and findings fail the job.
- `[M][A]` No credential is ever committed. Where a config file must carry one, generate it and gitignore it, and commit a redacted example instead.
- `[M][S]` A committed example config must not declare the same names as the real one if a loader merges the whole directory - it will silently overwrite the real values.
- `[M][A]` A content security policy is served, and inline scripts are hashed rather than blanket-allowed.
- `[M][A]` Serve referrer policy, content-type options, frame-ancestors and permissions policy. Verify with a header probe.
- `[M][A]` No CDN-hosted assets. If one is unavoidable it carries integrity metadata.
- `[M][A]` Every new-tab link carries `rel="noopener"`.
- `[M][H]` Decide the analytics position - none, or self-hosted and consent-gated - and record it.
- `[M][S]` No personal data in URLs, logs or local storage.
- `[M][A]` Enumerate every storage key with its purpose and lifetime.
- `[M][A]` Prove an auth boundary with a probe that **can fail**. A check that returns the same result whether or not the boundary holds is not a check.
- `[M][S]` Error output never leaks paths, versions, tokens or stack traces.
- `[M][A]` Dependencies are pinned and audited on a stated cadence.
- `[M][S]` For a public repo, scrub screenshots and docs of addresses, hostnames and usernames.

## 25. Error and edge pages

See [quality/error-and-edge-pages.md](quality/error-and-edge-pages.md).

- `[M][A]` A not-found route exists, is in-brand, and offers a way back.
- `[M][A]` A top-level error boundary catches render crashes and offers a reload plus a copyable diagnostic.
- `[M][S]` Offline is detected and shown, rather than silently rendering stale data.
- `[M][A]` Stale data shows its age.
- `[M][H]` One failing data source degrades the page; it never blanks it.
- `[M][H]` Empty, zero and unknown are three different screens with three different messages.
- `[M][S]` A skeleton appears after a stated delay, and a "still working" message after a longer one.
- `[M][A]` A no-JavaScript block says what is required.
- `[M][A]` A missing hardware capability falls back to a static render, never an empty box.
- `[M][H]` **Blank is not a state.** Every failure path renders something.

## 26. Internationalisation

See [quality/internationalisation.md](quality/internationalisation.md).

- `[M][H]` Decide and record whether the product is single-locale, and state the cost of reversing that.
- `[M][A]` Language and direction attributes are present and correct.
- `[M][S]` No sentences built by string concatenation.
- `[M][A]` Use logical CSS properties rather than physical ones. Free now, expensive later.
- `[M][S]` Direction-implying icons mirror in right-to-left.
- `[M][A]` Format numbers, dates and lists with the platform internationalisation API, never by hand.
- `[M][S]` The layout survives a 40 percent string-length increase.
- `[M][A]` No translatable text baked into images.
- `[O][A]` Run a right-to-left screenshot pass if it is in scope.

## 27. Print

See [quality/print.md](quality/print.md).

- `[M][H]` Decide whether print is in scope and record it. "Out of scope" is a valid written answer.
- `[O][A]` If in scope: remove fixed chrome, nav, scroll rails and scrollbars.
- `[O][A]` Force the light palette on white.
- `[O][S]` Truncated text and inner scrollers expand fully.
- `[O][A]` Avoid page breaks inside cards and rows; repeat table headers.

## 28. Browser support

See [quality/browser-support.md](quality/browser-support.md).

- `[M][H]` Publish a support matrix: browser, minimum version, and why that floor.
- `[M][A]` List the CSS and JS features that set the floor, and check them against the matrix.
- `[M][H]` State the degradation for each gating feature - what a browser below the floor actually sees.
- `[M][A]` Feature detection only. Grep for user-agent sniffing.
- `[M][H]` Name the manual device matrix, and re-run it at least once per release with a date stamp.

## 29. Performance

See [quality/performance.md](quality/performance.md).

- `[M][A]` Publish a budget table with numbers: initial JS, CSS, image weight, and the core web vitals.
- `[M][A]` Enforce the budget in CI so it can fail the build.
- `[M][A]` Heavy dependencies are lazy-loaded behind a route, and absent from the initial chunk.
- `[M][H]` Adding a dependency requires its transferred size and a note on why it is not hand-written.
- `[M][A]` Images declare intrinsic dimensions and lazy-load below the fold.
- `[M][A]` Layout shift stays within budget; skeletons are shape-matched so nothing jumps.
- `[M][A]` Zero font requests, or a preloaded subset within budget.
- `[M][A]` One shared data poll. Grep for per-component fetch loops.
- `[M][A]` Polling stops while the document is hidden.
- `[M][A]` Animations use compositable properties only.
- `[M][A]` Static assets are far-future cached; the HTML entry point is not.
- `[M][H]` Measure once on the slowest device in the support matrix.
- `[M][A]` Third-party script count is zero, or each is listed with a reason and a size.

## 30. QA and verification

See [quality/qa-and-verification.md](quality/qa-and-verification.md).

- `[M][A]` Every checklist item carries its verification tag. An untagged item is incomplete.
- `[M][A]` CI runs typecheck and build on every change.
- `[M][A]` CI runs the secret scan.
- `[M][A]` CI runs the token lint, the contrast check and the palette validator.
- `[M][A]` CI runs the accessibility audit over every route in both themes.
- `[M][A]` The screenshot matrix - routes by themes by widths - is captured.
- `[M][A]` Every route loads with zero console errors and no failing network responses.
- `[M][H]` **Every verification command must be able to fail.** Prove the probe distinguishes the failure it claims to detect.
- `[M][S]` A front-end change is not done until a real screenshot of it exists. A DOM-only test cannot see layout: blank and perfect are identical to it.
- `[M][S]` Verify against a genuinely fresh load. A cached bundle will happily reproduce a bug you already fixed.
- `[M][A]` Classification logic has a truth table checked in beside the code.
- `[M][H]` Publish the definition of done for an interface change.

## 31. Governance

See [quality/governance.md](quality/governance.md).

- `[M][A]` One file owns the tokens.
- `[M][S]` Adding a token requires a name, a value per theme, a measured ratio where applicable, and a why-comment.
- `[M][S]` Renaming a token keeps both names live for one release.
- `[M][A]` Changing the chart palette or its slot order re-runs the validator and updates the recorded ratios in the same commit.
- `[M][H]` Changing a standing rule requires an entry in the decision log with the alternatives considered.
- `[M][H]` Version by date stamp, not by semver. This is a document, not a package.
- `[M][A]` Every document carries a status date line.
- `[M][H]` Dead ends are recorded, never deleted.
- `[M][A]` Every token name cited in the docs exists in the token file.
- `[M][S]` A superseded document is marked retired with a pointer, not deleted.
- `[M][H]` Name one owner and the route for proposing a change.
