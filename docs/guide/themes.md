# Themes

Bothy ships five themes and will load any number you add. A theme you add is
**one `.css` file in one directory** - no rebuild, no npm, no restart, and it
survives `docker compose up --build`, which replaces the image and everything in
it.

## Picking one

The moon button in the topbar is the quick dark / light / system toggle.
The full list is in **Settings → Appearance**, tagged so you can tell a theme
Bothy ships from one that came off the disk.

The five:

| Theme | Appearance |
|---|---|
| Bothy Dark | dark - the default, neutral zinc, control-room contrast |
| Bothy Light | light - the same palette re-measured for a white page |
| Tokyo Night | dark |
| Gruvbox | dark |
| Catppuccin Latte | light |

It was seven until 2026-08-18, and the two that went are a useful statement of
the bar. Catppuccin Mocha and Nord were dropped because, measured in OKLCH
across the three tokens that carry a theme's identity, they were not telling
anyone apart from Tokyo Night - mocha against tokyo scored 0.0747 while every
surviving pair is 0.34 or more. Three dark blue-violet themes at the same
lightness is one theme and two near-misses. **The bar for adding one is that it
is legibly different from all of these, not that somebody likes it.**

Which theme you picked is remembered **in this browser only**. A theme you write
is a file on the box, so every browser that reaches it sees the same one.

## Two ways to make one, and they produce the same file

Settings → Appearance offers both side by side, deliberately: the editor is not
a lighter-weight alternative to writing the file, it is a preview attached to
the same output.

**In the theme editor** (`/settings/theme/new`). It starts from the theme you
are looking at now - "begin with what you are looking at" needs no explanation,
whereas seeding from a hard-coded palette would silently start you on Bothy Dark
while the screen showed something else. Every change applies to the whole page
as you type, so you are judging the real thing rather than a swatch in a corner.
It is its own route rather than a dialog for exactly that reason, and a URL
means an unfinished theme survives a reload.

The editor has a form of grouped colour fields and a live CSS pane, and editing
either updates the other, so the form and the file cannot disagree. Saving
writes the file through Bothy Files and therefore needs the **`editor`** role;
without it everything else on the page still works and the preview is still
live, you just cannot write.

**Or write the file.** Drop a `.css` into `apps/portal-next/data/themes/` on the
box and reload. The filename is the theme's id, so renaming the file renames the
theme - **the file is the registration**, because nginx lists the directory as
JSON and there is no index to update and therefore none to forget.

The format is documented where somebody standing in that directory will find it:
[`apps/portal-next/data/themes/README.md`](../../apps/portal-next/data/themes/README.md).
The short version is a header comment and a doubled attribute selector:

```css
/* bothy-theme
   name: Deep Ocean
   appearance: dark
   note: One line, shown under the name in the picker.
*/

:root[data-bothy-theme='deep-ocean'][data-bothy-theme],
[data-bothy-theme='deep-ocean'][data-bothy-theme] {
  color-scheme: dark;

  --bg: #0b1a24;
  --fg: #dbe7ef;
  --accent: #4bb3d4;
}
```

The header is optional; a file with none still loads and takes its name from the
filename. The attribute is doubled because `:root[data-theme='light']` and
`:root[data-bothy-theme='x']` score the same specificity, so which one applied
would come down to emission order - and Vite hoists and rewrites imports, which
makes that a build detail rather than a decision. Doubling it wins from
anywhere in the bundle. The second, bare selector is what lets the picker paint
your theme's swatches while you are looking at a different one.

`color-scheme` is the one line not to omit. It is what makes the browser paint
scrollbars and form controls correctly, and Bothy reads it to decide whether to
start you on the dark or light base before your stylesheet has finished loading.
Without it you may see one frame of the wrong palette.

## What the contract enforces

The rules a palette must satisfy live in one module,
[`apps/portal-next/web/src/lib/contract.ts`](../../apps/portal-next/web/src/lib/contract.ts),
imported by **two** consumers: the build-time check that holds Bothy's own
themes to them, and the editor, which runs them live as you type. One set of
rules, because a rule that lives in the check and a rule that lives in the
editor drift apart invisibly - the editor says a colour is fine, the check says
it is not, and whichever you happened to run is the answer you believe.

In the editor they are **advice, not a gate**. You can save a theme that breaks
them. What they check:

- **completeness** - every required token is declared. The required set is
  *derived* from the base palette rather than listed, because the failure mode
  of a hand-maintained list is silence: a missing token inherits the base
  palette, which is how you get a Gruvbox page with one blue button on it;
- **contrast** - foregrounds at 4.5:1 against **every** ground they are actually
  painted on, not against one canonical background. That distinction found a
  real bug immediately: two status foregrounds had been measured on a card while
  being used mostly in the file explorer, which sits on a darker ground, so the
  real ratios were about 0.35 lower than the ones written down and below the
  floor;
- **accent legality** - the five panel accents must stay at least 45 degrees of
  hue from any chromatic status colour, or a coloured panel edge starts reading
  as an alert;
- **chart slots** inside a lightness band for the appearance, and clear of the
  card behind them;
- **the syntax palette, all or nothing.** A theme that restyles code must
  declare every highlight token. Four of five is the bad case, because the fifth
  silently comes from a palette chosen for a different background. It is not
  hypothetical - a mutation renaming one of them passed every check that existed
  at the time, which is how the rule got written.

Three exemptions are recorded **with their reasons** rather than suppressed,
because an exemption nobody can see is one nobody can argue with. Three
light-mode status fills sit below the contrast floor on purpose: they are large
solid areas beside a track, never small glyphs, and status is never encoded by
colour alone.

The three rules that matter most when you are actually picking colours - the
five statuses are reserved, the five panel accents never encode state, and
`--brand` is the deliberate exception to the second - are stated in full in the
themes directory README linked above.

## `--brand`, and why your old theme now looks incomplete

`--brand` was added on 2026-08-19. Before that, the dot in the wordmark was
painted with `--accent` - the token whose job is "this is interactive" and which
every theme is entitled to repaint. So the mark that exists to say *which
product this is* restated whatever hue the current theme had picked for its
buttons: blue on Bothy Dark, blue-grey on Gruvbox, lavender on Catppuccin.

It is a fifth colour job beside surface, status, chrome and chart. It is
theme-tunable rather than one blessed hex, because no single value stays visible
on both a near-black card and a white one - the light palettes take a darker
rung of the same green ramp. The contract measures whatever it resolves to on
each palette, at 3:1 rather than 4.5:1, because the dot is a filled circle a few
pixels across: a mark on chrome, never text.

It is **deliberately exempt from the accent hue rule**. Bothy's green sits 17
degrees from the "up" status hue, so the mark would fail that rule outright. The
rule exists so a coloured control cannot be misread as a state; the dot encodes
nothing - it is the same dot on a page reporting five containers down, it never
changes with state, and it is never beside a status glyph. Applying the rule
there would not prevent a confusion, it would only forbid the brand from being
green.

> [!note] What this means for a theme you already wrote
> A theme file written before 2026-08-19 does not declare `--brand`, so opening
> it in the editor reports it as incomplete - one failing line, `missing 1`. The
> theme still **renders** correctly: the mark simply inherits Bothy's green.
> Set the token and save once and the warning clears.

That gap is also why a companion rule exists, and it is worth knowing if you
ever add a token to the palette: **every required token must appear in exactly
one group in the editor's layout.** The editor renders a field only for tokens a
group names, while the required set is derived from the live stylesheet - so a
required token in no group is one the editor demands with nowhere to type it,
and the completeness rule fails and hides every other finding behind it. The
reading-scale tokens spent a release in exactly that state before being
reclassified as structural, where they belonged.

## Related

- [`apps/portal-next/data/themes/README.md`](../../apps/portal-next/data/themes/README.md) - the file format, the token count, and the three colour rules in full
- [`docs/brand/foundations/theming.md`](../brand/foundations/theming.md) - how light and dark coexist without a flash on load
- [`docs/brand/reference/tokens.md`](../brand/reference/tokens.md) - the token reference
- [`docs/brand/foundations/colour.md`](../brand/foundations/colour.md) - the palette, and what each colour job is for
- [Bothy Files](files.md) - the tier the theme editor saves through
