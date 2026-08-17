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
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    appearance: 'dark',
    note: 'After the editor theme by enkia. Cooler and bluer than Bothy Dark.',
  },
];

/** `'system'` is a SELECTION, never a theme: it means "follow the OS", and it
 *  resolves to one of the two built-ins. Keeping it out of THEMES is what stops
 *  it being offered as something a stylesheet could target. */
export type Selection = 'system' | (string & {});

export const DEFAULT_SELECTION: Selection = 'bothy-dark';

export const byId = (id: string): ThemeDef | undefined => THEMES.find((t) => t.id === id);

/** Older builds stored 'dark' | 'light' | 'system' under the same key. Mapping
 *  rather than discarding matters: a stored 'light' is a user who chose light,
 *  and dropping it on upgrade would silently flip them back to dark. */
export function migrate(stored: string | null): Selection {
  if (!stored) return DEFAULT_SELECTION;
  if (stored === 'system') return 'system';
  if (stored === 'dark') return 'bothy-dark';
  if (stored === 'light') return 'bothy-light';
  return byId(stored) ? stored : DEFAULT_SELECTION;
}

/** What a selection actually paints, with `system` collapsed against the OS.
 *  `prefersDark` is passed in rather than read here so this module stays free of
 *  browser globals and can be compiled and tested on its own. */
export function resolveSelection(sel: Selection, prefersDark: boolean): ThemeDef {
  if (sel === 'system') return byId(prefersDark ? 'bothy-dark' : 'bothy-light')!;
  return byId(sel) ?? byId(DEFAULT_SELECTION)!;
}
