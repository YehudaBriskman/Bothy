# Token reference

_Status as of 2026-08-10. Transcribed from `apps/portal-next/web/src/index.css`,
which is the source of truth — where this table and that file disagree, the file
is right and this page is stale._

Contrast ratios are measured against the composited surface named in each row.
The reasoning behind these choices is in
[foundations/colour.md](../foundations/colour.md).

## Surfaces

| Token | Dark | Light | Role |
|---|---|---|---|
| `--bg` | `#09090b` | `#ffffff` | The page |
| `--bg-2` | `#0b0b0d` | `#f4f4f5` | Insets darker than a card |
| `--surface-1` | `#101013` | `#ffffff` | Cards, panels |
| `--surface-2` | `#17171a` | `#fafafa` | Headers, insets |
| `--surface-3` | `#202024` | `#f4f4f5` | Hover, active row |
| `--surface-4` | `#26262b` | `#ffffff` | Popovers, tooltips, dialogs |
| `--bg-glow` | `#131316` | `#ffffff`-adjacent | The wash behind the page |

Surfaces are opaque. See
[shape-and-elevation](../foundations/shape-and-elevation.md).

## Foreground

| Token | Dark | Ratio on surface-1 / -2 | Light | Ratio | Role |
|---|---|---|---|---|---|
| `--fg` | `#fafafa` | 18.35 / 16.45 | `#09090b` | 19.94 | Primary text |
| `--fg-muted` | `#a1a1aa` | 7.61 / 6.82 | `#52525b` | 7.70 | Secondary text |
| `--fg-subtle` | `#8f8f99` | 5.62 / 5.04 | `#6b6b76` | 5.44 | Small text: hostnames, counts |
| `--on-accent` | `#09090b` | — | `#ffffff` | — | Text on a filled accent |

`--fg-subtle` is deliberately lighter than the obvious choice: the next step
down measures 3.85 on the card surface, below AA at the 11px sizes it is used
at.

## Lines

| Token | Dark | Light |
|---|---|---|
| `--line` | `rgb(255 255 255 / 10%)` | `rgb(9 9 11 / 10%)` |
| `--line-strong` | `rgb(255 255 255 / 17%)` | `rgb(9 9 11 / 17%)` |

## Accent — chrome only, never state

| Token | Dark | Light | Role |
|---|---|---|---|
| `--accent` | `#60a5fa` | `#2563eb` | Interactive hue |
| `--accent-2` | `#3b82f6` | `#1d4ed8` | Gradient partner |
| `--accent-fg` | `#93c5fd` | `#1d4ed8` | The accent used as **text** |
| `--accent-bg` | 14% mix | 14% mix | Tint |
| `--accent-line` | 32% mix | 32% mix | Border |
| `--ring` | `--accent` | `--accent` | Focus ring |

## Status — reserved, never chrome

| Token | Dark | Light | Means |
|---|---|---|---|
| `--st-up` | `#34d399` | `#10b981` | Running, confirmed |
| `--st-warn` | `#fbbf24` | `#d97706` | Starting, or a warning |
| `--st-down` | `#fb7185` | `#e11d48` | Meant to be up and is not |
| `--st-unknown` | `#64748b` | `#adbac7` | We have not checked |
| `--st-off` | `#4a5568` | `#cbd5e1` | Switched off on purpose |

Each has a `-fg` text variant, a `-bg` tint and a `-line` border. Light-mode
warn uses amber-600 rather than amber-500 because amber-500 is lighter than the
green and inverts the warn-versus-up weight; light-mode unknown is a custom grey
because slate-400 sat at nearly the same weight as up.

## Chart series — validated, order is load-bearing

| Token | Dark | Light |
|---|---|---|
| `--chart-1` | `#6366f1` | `#4f5fd9` |
| `--chart-2` | `#0d9488` | `#0d9488` |
| `--chart-3` | `#ea580c` | `#d97706` |
| `--chart-4` | `#a855f7` | `#9333ea` |
| `--chart-5` | `#f43f5e` | `#e11d48` |

Both sets pass the five categorical checks for their mode. Slots 2 and 3 sit at
ΔE 6.3 under tritanopia — inside the floor band — so every multi-series chart
ships a legend and direct labels. See
[foundations/colour.md](../foundations/colour.md).

## Chrome accents — decoration, never state

`--a1` through `--a6`: `#8b5cf6`, `#22d3ee`, `#f472b6`, `#34d399`, `#60a5fa`,
`#f59e0b`. Assigned to panels by a stable hash of the panel key, never by index.

## Derived tints

Two percentages, declared once, mixed in a perceptual space:

| Purpose | Strength |
|---|---|
| Background tint | 14% (12% for `off`) |
| Border | 32% (26% for `off`) |
| Track | 8% of `--fg` |

## Shape

| Token | Value |
|---|---|
| `--r-xs` … `--r-full` | 5px, 7px, 10px, 14px, 999px |
| `--border-w` | 1px |
| `--hover-opacity` | .9 |
| `--disabled-opacity` | .5 |

## Motion

| Token | Value | Used for |
|---|---|---|
| `--dur-fast` | 120ms | Hover, colour |
| `--dur` | 180ms | Transform, elevation |
| `--dur-slow` | 260ms | Page transition |
| `--ease` | `cubic-bezier(.2,.7,.2,1)` | Everything |

## Elevation

Three steps per theme. Dark recipes include an inset white hairline, because a
shadow alone cannot separate a surface from a near-black background. Light
recipes use a dark blue-grey rather than black.

## Scroll

| Token | Dark | Light |
|---|---|---|
| `--scroll-shade` | `rgb(0 0 0 / .55)` | `rgb(9 9 11 / .16)` |
| `--scrollbar-w` | 10px | 10px |
| `--scrollbar-thumb` | 16% of `--fg` | 20% of `--fg` |
| `--scrollbar-thumb-hover` | 55% of `--accent` | 55% of `--accent` |

## Type and layout

| Token | Value |
|---|---|
| `--font` | System sans stack |
| `--mono` | System mono stack |
| `--wrap` | 1180px |

There is no spacing scale and no type scale. Both are tracked in
[open-questions.md](open-questions.md).
