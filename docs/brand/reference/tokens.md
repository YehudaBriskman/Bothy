# Token reference

_Generated from `apps/bothy-web/web/src/index.css` by
`apps/bothy-web/web/scripts/gen-tokens-doc.mjs`. Do not edit by hand:
change the token (and the comment beside it, which is the "Role" column),
then re-run the script. `checks/design-tokens.mjs` fails when this page and
the code disagree._

Contrast rules, the theme contract and the reasoning behind each choice are in
[foundations/colour.md](../foundations/colour.md),
[typography](../foundations/typography.md), [motion](../foundations/motion.md) and
[shape-and-elevation](../foundations/shape-and-elevation.md).

## Surfaces

Opaque, an elevation ladder. See [shape-and-elevation](../foundations/shape-and-elevation.md).

| Token | Dark | Light | Role |
|---|---|---|---|
| `--bg` | `#09090b` | `#ffffff` | zinc-950 - the page |
| `--bg-2` | `#0b0b0d` | `#f4f4f5` | insets darker than a card |
| `--surface-1` | `#101013` | `#ffffff` | cards, panels |
| `--surface-2` | `#17171a` | `#fafafa` | headers, insets |
| `--surface-3` | `#202024` | `#f4f4f5` | hover, active row |
| `--surface-4` | `#26262b` | `#ffffff` | popovers, tooltips, dialogs |
| `--bg-glow` | `#131316` | `#dfe5f5` |  |

## Foreground

Held at 4.5:1 on every ground they are painted on (`checks/theme-contract.mjs`).

| Token | Dark | Light | Role |
|---|---|---|---|
| `--fg` | `#fafafa` | `#09090b` | 18.35 on surface-1 · 16.45 on surface-2 |
| `--fg-muted` | `#a1a1aa` | `#52525b` | 7.61 ·  6.82 - zinc-400 |
| `--fg-subtle` | `#8f8f99` | `#6b6b76` | 5.62 ·  5.04 |
| `--on-accent` | `#09090b` | `#ffffff` | text on a filled --accent |

## Lines

| Token | Dark | Light | Role |
|---|---|---|---|
| `--line` | `rgb(255 255 255 / 10%)` | `rgb(9 9 11 / 10%)` |  |
| `--line-strong` | `rgb(255 255 255 / 17%)` | `rgb(9 9 11 / 17%)` |  |

## Accent - chrome only, never state

Settings > Appearance > Accent swaps `--accent`, `--accent-2` and `--accent-fg` on the two built-in palettes.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--accent` | `#60a5fa` | `#2563eb` |  |
| `--accent-2` | `#3b82f6` | `#1d4ed8` |  |
| `--accent-fg` | `#93c5fd` | `#1d4ed8` | 9.94 on surface-1 - accent used as TEXT |
| `--accent-bg` | `color-mix(in oklab, var(--accent) 14%, transparent)` | same |  |
| `--accent-line` | `color-mix(in oklab, var(--accent) 32%, transparent)` | same |  |
| `--ring` | `var(--accent)` | same |  |

## Brand - identity, never chrome and never state

| Token | Dark | Light | Role |
|---|---|---|---|
| `--brand` | `#3fb950` | `#238636` |  |

## Status - reserved, never chrome

Each status has a fill, a `-fg` text half (the only one text may use), a `-bg` tint and a `-line` border.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--st-up` | `#34d399` | `#10b981` |  |
| `--st-up-fg` | `#34d399` | `#047153` | fg 6.01 on white, 4.84 on its tint over --bg-2 · fill 2.50 |
| `--st-warn` | `#fbbf24` | `#d97706` |  |
| `--st-warn-fg` | `#fbbf24` | `#92400e` | fg 6.97 · fill 3.13 |
| `--st-down` | `#fb7185` | `#e11d48` |  |
| `--st-down-fg` | `#fb7185` | `#be123c` | fg 6.18 · fill 4.62 |
| `--st-unknown` | `#64748b` | `#adbac7` |  |
| `--st-unknown-fg` | `#94a3b8` | `#5f6a7d` | fg 4.97 on --bg-2 · fill 1.94 |
| `--st-off` | `#4a5568` | `#cbd5e1` |  |
| `--st-off-fg` | `#858fa2` | `#666f7d` | fg 4.62 on --bg-2 · fill 1.46 |
| `--st-up-bg` | `color-mix(in oklab, var(--st-up) 14%, transparent)` | same |  |
| `--st-up-line` | `color-mix(in oklab, var(--st-up) 32%, transparent)` | same |  |
| `--st-warn-bg` | `color-mix(in oklab, var(--st-warn) 14%, transparent)` | same |  |
| `--st-warn-line` | `color-mix(in oklab, var(--st-warn) 32%, transparent)` | same |  |
| `--st-down-bg` | `color-mix(in oklab, var(--st-down) 14%, transparent)` | same |  |
| `--st-down-line` | `color-mix(in oklab, var(--st-down) 32%, transparent)` | same |  |
| `--st-unknown-bg` | `color-mix(in oklab, var(--st-unknown) 14%, transparent)` | same |  |
| `--st-unknown-line` | `color-mix(in oklab, var(--st-unknown) 32%, transparent)` | same |  |
| `--st-off-bg` | `color-mix(in oklab, var(--st-off) 12%, transparent)` | same |  |
| `--st-off-line` | `color-mix(in oklab, var(--st-off) 26%, transparent)` | same |  |

## Chart series - order is load-bearing

| Token | Dark | Light | Role |
|---|---|---|---|
| `--chart-1` | `#6366f1` | `#4f5fd9` |  |
| `--chart-2` | `#0d9488` | `#0d9488` |  |
| `--chart-3` | `#ea580c` | `#d97706` |  |
| `--chart-4` | `#a855f7` | `#9333ea` |  |
| `--chart-5` | `#f43f5e` | `#e11d48` |  |

## Panel accents - decoration, never state

Five, spaced across the one hue window that clears every status by 45°.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--a1` | `#1eb5e0` | `#077a99` | L .72 C .130 H 224 |
| `--a2` | `#4cabfd` | `#1575be` | L .72 C .149 H 248 |
| `--a3` | `#869efc` | `#4e5ffb` | L .72 C .140 H 272 |
| `--a4` | `#ae8dfc` | `#8e3ffe` | L .72 C .159 H 296 |
| `--a5` | `#e169fc` | `#b921d6` | L .72 C .230 H 320 |

## Shape

| Token | Value | Role |
|---|---|---|
| `--r-xs` | `5px` |  |
| `--r-sm` | `7px` |  |
| `--r-md` | `10px` |  |
| `--r-lg` | `14px` |  |
| `--r-full` | `999px` |  |
| `--border-w` | `1px` |  |
| `--disabled-opacity` | `.5` |  |
| `--rest-opacity` | `.55` |  |

## Type scale

Closed: nine steps in rem, each with its own leading and tracking. Use the three together.

| Token | Value | Role |
|---|---|---|
| `--fs-2xs` | `.6875rem` |  |
| `--lh-2xs` | `1.35` |  |
| `--tr-2xs` | `.01em` | 11 - micro labels, counts |
| `--fs-xs` | `.75rem` |  |
| `--lh-xs` | `1.4` |  |
| `--tr-xs` | `.005em` | 12 - meta, hostnames, tooltips |
| `--fs-sm` | `.8125rem` |  |
| `--lh-sm` | `1.45` |  |
| `--tr-sm` | `0em` | 13 - controls, chips, menu rows |
| `--fs-md` | `.875rem` |  |
| `--lh-md` | `1.5` |  |
| `--tr-md` | `0em` | 14 - table cells, nav |
| `--fs-body` | `1rem` |  |
| `--lh-body` | `1.6` |  |
| `--tr-body` | `0em` | 16 - prose |
| `--fs-lg` | `1.0625rem` |  |
| `--lh-lg` | `1.35` |  |
| `--tr-lg` | `-.01em` | 17 - panel and group titles |
| `--fs-xl` | `1.3125rem` |  |
| `--lh-xl` | `1.25` |  |
| `--tr-xl` | `-.015em` | 21 - section and dialog headings |
| `--fs-2xl` | `1.75rem` |  |
| `--lh-2xl` | `1.15` |  |
| `--tr-2xl` | `-.02em` | 28 - page h1 |
| `--fs-display` | `clamp(2.375rem, 6vw, 4.25rem)` |  |
| `--lh-display` | `1.02` |  |
| `--tr-display` | `-.03em` | 38-68 - the hero, only |
| `--label-tracking` | `.06em` |  |
| `--fw-regular` | `400` |  |
| `--fw-medium` | `500` |  |
| `--fw-semibold` | `600` |  |
| `--fw-bold` | `700` |  |
| `--fw-heavy` | `800` |  |

## Spacing

A 4px grid with 2px and 6px half-steps, in rem. `--sp-2_5` is 2.5 steps.

| Token | Value | Role |
|---|---|---|
| `--sp-0_5` | `.125rem` |  |
| `--sp-1` | `.25rem` |  |
| `--sp-1_5` | `.375rem` |  |
| `--sp-2` | `.5rem` |  |
| `--sp-2_5` | `.625rem` |  |
| `--sp-3` | `.75rem` |  |
| `--sp-4` | `1rem` |  |
| `--sp-5` | `1.25rem` |  |
| `--sp-6` | `1.5rem` |  |
| `--sp-8` | `2rem` |  |
| `--sp-10` | `2.5rem` |  |
| `--sp-12` | `3rem` |  |
| `--sp-16` | `4rem` |  |

## Icons

Mirrored as `ICON` in `components/ui/Icon.tsx`.

| Token | Value | Role |
|---|---|---|
| `--icon-xs` | `12px` |  |
| `--icon-sm` | `14px` |  |
| `--icon-md` | `16px` |  |
| `--icon-lg` | `20px` |  |

## Interaction

`--hit` is 2.75rem (44px) under `(pointer: coarse)`.

| Token | Value | Role |
|---|---|---|
| `--hit` | `1.5rem` | 2.75rem under a coarse pointer |
| `--ring-w` | `2px` |  |
| `--ring-offset` | `2px` |  |
| `--press-scale` | `.97` |  |
| `--press-scale-wide` | `.985` |  |
| `--surface-press` | `color-mix(in oklab, var(--surface-3), var(--fg) 7%)` |  |

## Motion

Mirrored in `lib/motion.ts` for framer-motion; the check asserts they agree. Springs are for dialogs, menus and drag only.

| Token | Value | Role |
|---|---|---|
| `--dur-fast` | `120ms` | hover, colour |
| `--dur` | `180ms` | transform, elevation |
| `--dur-slow` | `260ms` | a large surface arriving |
| `--dur-exit` | `120ms` | leaving is quicker than arriving |
| `--press-dur` | `100ms` | the press itself - under the 100ms "instant" line |
| `--ease` | `cubic-bezier(.2,.7,.2,1)` |  |
| `--ease-exit` | `cubic-bezier(.4,0,.9,.4)` |  |
| `--ease-standard` | `cubic-bezier(.4,0,.2,1)` |  |
| `--spring` | `linear(0, .079, .236, .403, .551, .671, .764, .833, .883, .919, .94...` |  |
| `--spring-dur-s` | `440ms` | response 0.30 |
| `--spring-dur` | `520ms` | response 0.35 - the default |
| `--spring-dur-l` | `590ms` | response 0.40 |
| `--spring-bounce` | `linear(0, .052, .171, .316, .464, .598, .712, .805, .875, .927, .96...` |  |
| `--spring-bounce-dur` | `480ms` |  |
| `--stagger` | `30ms` | per item; clamp the index at 8 |
| `--loop-spin` | `.9s` |  |
| `--loop-shimmer` | `1.4s` |  |
| `--loop-pulse` | `1.4s` |  |
| `--loop-beat` | `2s` |  |

## Elevation and materials

Four steps with fixed meanings: 1 rest, 2 raised, 3 popover, 4 modal. A theme sets only `--shadow-color`, `--shadow-hairline` and `--scrim`.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--shadow-color` | `#000000` | `rgb(15 23 42 / .25)` |  |
| `--shadow-hairline` | `#ffffff` | `transparent` |  |
| `--shadow-1` | `0 1px 2px color-mix(in srgb, var(--shadow-color) 40%, transparent),...` | same |  |
| `--shadow-2` | `0 6px 16px -8px color-mix(in srgb, var(--shadow-color) 55%, transpa...` | same |  |
| `--shadow-3` | `0 12px 32px -12px color-mix(in srgb, var(--shadow-color) 65%, trans...` | same |  |
| `--shadow-4` | `0 28px 72px -24px color-mix(in srgb, var(--shadow-color) 75%, trans...` | same |  |
| `--scrim` | `rgb(0 0 0 / .6)` | `rgb(9 9 11 / .38)` |  |
| `--mat-chrome-bg` | `color-mix(in oklab, var(--bg) 78%, transparent)` | same |  |
| `--mat-chrome-blur` | `blur(14px) saturate(1.2)` | same |  |
| `--mat-palette-bg` | `color-mix(in oklab, var(--surface-4) 82%, transparent)` | same |  |
| `--mat-palette-blur` | `blur(24px) saturate(1.4)` | same |  |

## Scroll

| Token | Dark | Light | Role |
|---|---|---|---|
| `--scroll-shade` | `rgb(0 0 0 / .55)` | `rgb(9 9 11 / .16)` |  |
| `--scrollbar-w` | `10px` | same |  |
| `--scrollbar-thumb` | `color-mix(in oklab, var(--fg) 16%, transparent)` | `color-mix(in oklab, var(--fg) 20%, transparent)` |  |
| `--scrollbar-thumb-hover` | `color-mix(in oklab, var(--accent) 55%, transparent)` | `color-mix(in oklab, var(--accent) 55%, transparent)` |  |

## Reading

The rendered-document scale in Files.

| Token | Value | Role |
|---|---|---|
| `--read-measure` | `100%` |  |
| `--read-fs` | `16px` |  |
| `--rd-ui-fs` | `12.5px` |  |
| `--read-lh` | `1.65` |  |
| `--read-gap` | `15px` | between blocks, tracks --read-fs |
| `--read-h1` | `27px` |  |
| `--read-h2` | `21px` |  |
| `--read-h3` | `17.5px` |  |
| `--read-h4` | `15px` |  |

## Families and layout

| Token | Value | Role |
|---|---|---|
| `--wrap` | `1180px` |  |
| `--font` | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Inter,...` |  |
| `--mono` | `ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace` |  |
| `--font-serif` | `ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia...` |  |

## Other

| Token | Value |
|---|---|
| `--z-modal` | `90` |
| `--z-popover` | `95` |
| `--z-tooltip` | `96` |
