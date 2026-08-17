# Your themes go here

Drop a `.css` file in this directory and reload Bothy. It appears in the theme
picker — topbar moon icon, or Settings → Appearance — tagged **yours**.

That is the whole procedure. No rebuild, no npm, no restart. The directory is
bind-mounted into the container, so what you put here survives
`docker compose up --build`, and Bothy finds themes by **listing this
directory** — there is no index to update and therefore none to forget.

- **The filename is the theme's id.** `deep-ocean.css` → `deep-ocean`. Rename the
  file to rename the theme. Use lowercase letters, digits and hyphens; anything
  else is skipped rather than guessed at, because the id ends up inside a CSS
  selector.
- **One file is one theme.** Send it to someone and they drop it in their own
  directory. Nothing else travels with it.
- These files are **git-ignored**. They are yours, not the repository's.

## The shape of a theme

```css
/* bothy-theme
   name: Deep Ocean
   appearance: dark
   note: One line, shown under the name in the picker.
*/

/* Two selectors, and both are needed. The :root one wins on the page. The bare
   one lets the picker paint this theme's swatches while you are looking at a
   different theme. */
:root[data-bothy-theme='deep-ocean'][data-bothy-theme],
[data-bothy-theme='deep-ocean'][data-bothy-theme] {
  color-scheme: dark;          /* REQUIRED - see below */

  --bg: #0b1a24;
  --fg: #dbe7ef;
  --accent: #4bb3d4;
  /* ...and the rest */
}
```

The header block is optional — a theme with no header still loads, taking its
name from the filename. `color-scheme` is the one line you should not omit: it
tells the browser to paint scrollbars and form controls correctly, and Bothy
reads it to know whether to start you on the dark or light base before your
stylesheet has finished loading. Without it you may see one frame of the wrong
palette.

## What to copy

Start from a theme that already works. The ones Bothy ships are in
`apps/portal-next/web/src/themes/` — `tokyo-night.css` is the most heavily
commented and explains what every group of tokens does. Copy it here, rename the
file, change the id in both selectors, and start editing colours.

## What a complete theme declares

**41 tokens.** Of the 73 custom properties Bothy defines, 16 are *derived*
(computed from the ones you set, so they follow along for free) and 16 are
*structural* (radii, motion, fonts — the product's shape, not its palette). You
own the remaining 41: surfaces, foregrounds, lines, accent, five chart slots,
five statuses with their text variants, five panel accents, shadows.

A partial theme works — anything you leave out falls back to the base palette —
but the result is usually a page that is *nearly* your theme with a few
stubbornly blue buttons, so it is better to start from a complete file.

## Two rules worth knowing before you pick colours

They are not enforced on your files, and both exist because breaking them
produced a real bug:

1. **The five status colours are reserved.** `--st-up`, `--st-warn`,
   `--st-down`, `--st-unknown`, `--st-off` mean *a service is in this state* and
   are never used for decoration. If a decorative accent shares a hue with
   "down", a coloured panel edge reads as an alert.
2. **The five panel accents never encode state.** `--a1`–`--a5` are chrome. They
   must stay clearly distinct from the status hues — Bothy's own themes keep at
   least 45° of hue between them — or the first rule stops being true in
   practice.

Text also needs to stay readable: Bothy holds its own foregrounds at 4.5:1
against every surface they are painted on. If you want the same assurance for
your theme, the rules are implemented in
`apps/portal-next/web/src/lib/contract.ts`.
