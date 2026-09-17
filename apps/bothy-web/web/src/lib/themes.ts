// The theme registry.
//
// A theme is a NAME, an APPEARANCE, and a block of CSS custom properties. This
// file holds the first two; src/themes/*.css holds the third. Adding a theme is
// adding a row here and a file there - deliberately not a switch statement
// somewhere, because the set of themes is data and the moment it stops being
// data is the moment adding one means touching four files.
//
// TWO ATTRIBUTES, NOT ONE, and the distinction is what keeps this change small:
//
//   data-theme="dark|light"        the APPEARANCE
//   data-bothy-theme="tokyo-night" the THEME
//
// Everything that already keys on data-theme keeps working untouched - the
// editor's syntax palette (pages/files/shell.css), the 3D scene's palette
// observer (components/three/StackScene.tsx), and `color-scheme`, which is what
// tells the browser to paint form controls and scrollbars dark. A named theme
// layers over that base rather than replacing the mechanism.
//
// WHY THEMES WIN BY SPECIFICITY AND NOT BY SOURCE ORDER. `:root[data-theme=
// 'light']` and `:root[data-bothy-theme='x']` both score 0,2,0, so which one
// applies would come down to which is emitted last - and Vite hoists and
// rewrites @import, so that is a build detail, not a decision. Theme blocks
// therefore double the attribute:
//
//   :root[data-bothy-theme='tokyo-night'][data-bothy-theme]   -> 0,3,0
//
// which wins from anywhere in the bundle. shell.css already uses exactly this
// trick (`.bothy-files.bothy-files`) for the same reason.

export type Appearance = 'dark' | 'light';

export interface ThemeDef {
  /** Stamped as data-bothy-theme, and stored. Stable forever once shipped. */
  id: string;
  name: string;
  appearance: Appearance;
  /** One line for the picker. Where the palette came from, or what it is for. */
  note: string;
  /** The two palettes that live in index.css itself and need no theme file.
   *  They are the base every other theme is layered over. */
  builtin?: boolean;
  /** Added by a person, loaded at runtime from /data/themes rather than compiled
   *  into the bundle. The pre-paint script needs to know this and cannot work it
   *  out - see the note on it in index.html - so it is persisted beside the
   *  selection, which makes it a property of the theme rather than a lookup. */
  user?: boolean;
}

export const THEMES: readonly ThemeDef[] = [
  {
    id: 'bothy-dark',
    name: 'Bothy Dark',
    appearance: 'dark',
    note: 'The default. Neutral zinc, control-room contrast.',
    builtin: true,
  },
  {
    id: 'bothy-light',
    name: 'Bothy Light',
    appearance: 'light',
    note: 'The same palette re-measured for a white page.',
    builtin: true,
  },
  // FIVE THEMES, NOT SEVEN (2026-08-18). Catppuccin Mocha and Nord were dropped
  // because they were not telling anyone apart from Tokyo Night: measured in
  // OKLCH across --surface-1, --fg and --accent, mocha-vs-tokyo scored 0.0747
  // and nord landed between them, while every surviving pair is 0.34 or more.
  // Three dark blue-violet themes at the same lightness is one theme and two
  // near-misses - it makes the picker longer without making it wider.
  //
  // What is left spans the axes that actually differ: two lightnesses (dark and
  // light), and within dark a cool blue (Tokyo Night) against a warm low-chroma
  // brown (Gruvbox, chroma 0.073 at 237 degrees). Adding a theme is adding a
  // file; the bar is that it is legibly different from all of these, not that it
  // is a palette somebody likes.
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    appearance: 'dark',
    note: 'After the editor theme by enkia. Cooler and bluer than Bothy Dark.',
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    appearance: 'light',
    note: 'The light flavour of the same palette. Warmer than Bothy Light.',
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    appearance: 'dark',
    note: 'Warm retro browns and cream, after the palette by morhetz.',
  },
];

/** `'system'` is a SELECTION, never a theme: it means "follow the OS", and it
 *  resolves to one of the two built-ins. Keeping it out of THEMES is what stops
 *  it being offered as something a stylesheet could target. */
export type Selection = 'system' | (string & {});

export const DEFAULT_SELECTION: Selection = 'bothy-dark';

/** `all` defaults to the built-ins and is widened at runtime to include the user
 *  themes loaded from /data/themes. It is a PARAMETER rather than mutable module
 *  state so this file keeps importing nothing and stays compilable on its own -
 *  the same property discover.ts and config.ts depend on for their checks. */
export const byId = (id: string, all: readonly ThemeDef[] = THEMES): ThemeDef | undefined =>
  all.find((t) => t.id === id);

/** Older builds stored 'dark' | 'light' | 'system' under the same key. Mapping
 *  rather than discarding matters: a stored 'light' is a user who chose light,
 *  and dropping it on upgrade would silently flip them back to dark. */
export function migrate(stored: string | null): Selection {
  if (!stored) return DEFAULT_SELECTION;
  if (stored === 'system') return 'system';
  if (stored === 'dark') return 'bothy-dark';
  if (stored === 'light') return 'bothy-light';
  // NOT validated against THEMES, and that is the fix for a real bug rather than
  // laxness: a USER theme's id is not in this file - it is a filename in
  // /data/themes discovered after mount - so checking membership here threw the
  // selection away on every reload and silently put the reader back on Bothy
  // Dark. Shape is checked instead, and resolveSelection() already falls back
  // safely when an id turns out to name nothing.
  return /^[a-z0-9][a-z0-9-]*$/i.test(stored) ? stored : DEFAULT_SELECTION;
}

/** What a selection actually paints, with `system` collapsed against the OS.
 *  `prefersDark` is passed in rather than read here so this module stays free of
 *  browser globals and can be compiled and tested on its own. */
export function resolveSelection(
  sel: Selection,
  prefersDark: boolean,
  all: readonly ThemeDef[] = THEMES,
): ThemeDef {
  if (sel === 'system') return byId(prefersDark ? 'bothy-dark' : 'bothy-light', all)!;
  // Falling back to the default covers the case that actually happens: a user
  // theme was selected and then its file was deleted from the box. The selection
  // survives in localStorage and now names nothing, and the honest answer is the
  // default palette rather than a page with no colours at all.
  return byId(sel, all) ?? byId(DEFAULT_SELECTION, all) ?? THEMES[0];
}
