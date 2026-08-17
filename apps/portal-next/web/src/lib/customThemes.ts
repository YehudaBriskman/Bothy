// Themes a PERSON added, loaded at runtime from a directory on the box.
//
// WHO THIS IS FOR. Somebody who downloaded Bothy and ran it. No source tree, no
// npm, no rebuild - and whatever they add has to survive `docker compose up
// --build`, which replaces the image and everything in it. So a user theme
// cannot be a file in src/themes/ (that is compiled into the bundle) and it
// cannot live in the image. It is a .css file in a BIND-MOUNTED directory:
//
//     apps/portal-next/data/themes/<id>.css      on the host
//     /data/themes/<id>.css                      as the browser sees it
//
// The same directory nginx already serves projects.json from, for the same
// reason: it is the one place that is both writable from outside the image and
// readable by the page.
//
// THE FILE IS THE REGISTRATION. nginx lists the directory as JSON
// (autoindex_format json), so dropping a .css in is the whole act of adding a
// theme - there is no index to update and therefore no index to forget. The id
// is the filename without .css, which also means renaming the file renames the
// theme, and that is the behaviour someone would guess.
//
// METADATA LIVES IN THE FILE, in a header block:
//
//     /* bothy-theme
//        name: Solarized Dark
//        appearance: dark
//        note: Precision colours for machines and people.
//     */
//
// Parsed from the CSS text rather than from a sidecar, because a theme should be
// ONE file you can send someone. Everything is optional except that the file
// must declare `color-scheme` (or `appearance:` here) - without knowing whether
// it is dark or light the pre-paint stamp cannot pick a base palette and the
// first frame is wrong.

export interface CustomTheme {
  id: string;
  name: string;
  appearance: 'dark' | 'light';
  note: string;
  /** Where the browser fetches it. Also what the <link> points at. */
  href: string;
  /** Always true. Present so a CustomTheme is usable anywhere a ThemeDef is,
   *  and so the flag travels with the value instead of being re-derived. */
  user: true;
}

/** Where user themes live, as the browser addresses them. Exported because the
 *  editor writes into the same place through the file service, and two spellings
 *  of one path is how they drift apart. */
export const THEME_DIR = '/data/themes/';

/** The host path, for telling somebody where to put a file. Relative to the repo
 *  root; the container sees it mounted at /usr/share/nginx/html/data/themes. */
export const THEME_DIR_HOST = 'apps/portal-next/data/themes/';

const HEADER = /\/\*\s*bothy-theme([\s\S]*?)\*\//i;

/** Prettify a filename the way the reader's title code does, so a theme with no
 *  `name:` still reads as words rather than as a slug. */
function titleFrom(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Pull the header block out of a theme's CSS. Never throws: a file that does
 *  not parse is a theme with defaults, not an error - the CSS still applies, and
 *  refusing to list it would hide a working theme over a missing comment. */
export function parseThemeHeader(id: string, css: string): CustomTheme {
  const fields: Record<string, string> = {};
  const m = css.match(HEADER);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^\s*([a-z-]+)\s*:\s*(.+?)\s*$/i);
      if (kv) fields[kv[1].toLowerCase()] = kv[2];
    }
  }
  // `appearance:` in the header wins, then the stylesheet's own color-scheme,
  // then dark. The second is the one that matters: color-scheme is REQUIRED of a
  // theme anyway (it is what makes the browser paint form controls and
  // scrollbars correctly), so reading it means a correct file needs no header at
  // all to be classified.
  const declared = fields.appearance?.toLowerCase();
  const scheme = css.match(/color-scheme\s*:\s*(dark|light)/i)?.[1].toLowerCase();
  const appearance = (declared === 'light' || declared === 'dark' ? declared
    : scheme === 'light' ? 'light' : 'dark') as 'dark' | 'light';

  return {
    id,
    name: fields.name || titleFrom(id),
    appearance,
    note: fields.note || 'Added on this box.',
    href: THEME_DIR + encodeURIComponent(id) + '.css',
    user: true,
  };
}

/** Names of the .css files in the theme directory, or [] if there are none.
 *
 *  ABSENT IS A SUPPORTED CONFIGURATION, exactly as it is for projects.json: a
 *  fresh install has no user themes and no directory, and that must be silence
 *  rather than an error in the console on every load. Every failure here - 404,
 *  a JSON body that is not a list, a network error - collapses to "no user
 *  themes", because none of them is something the reader can act on.
 */
async function list(): Promise<string[]> {
  try {
    const r = await fetch(THEME_DIR, { headers: { Accept: 'application/json' } });
    if (!r.ok) return [];
    const body: unknown = await r.json();
    if (!Array.isArray(body)) return [];
    return body
      .map((e) => (e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : ''))
      .filter((n) => n.toLowerCase().endsWith('.css'))
      .map((n) => n.slice(0, -4))
      // A filename that would need escaping in a selector or a URL is refused
      // rather than sanitised. The id ends up inside an attribute selector in
      // the theme's own CSS, so "clean or absent" is a much smaller promise to
      // keep than "escaped correctly everywhere".
      .filter((id) => /^[a-z0-9][a-z0-9-]*$/i.test(id))
      .sort();
  } catch {
    return [];
  }
}

/** Every user theme, with its metadata read from its own file.
 *
 *  Fetched in parallel and failures dropped: one unreadable file must not cost
 *  the others. The CSS text is parsed but NOT injected here - see applyLink. */
export async function loadCustomThemes(): Promise<CustomTheme[]> {
  const ids = await list();
  if (!ids.length) return [];
  const out = await Promise.all(ids.map(async (id) => {
    try {
      const r = await fetch(THEME_DIR + encodeURIComponent(id) + '.css');
      if (!r.ok) return null;
      return parseThemeHeader(id, await r.text());
    } catch {
      return null;
    }
  }));
  return out.filter((t): t is CustomTheme => t !== null);
}

/** Make a user theme's stylesheet present in the document, once.
 *
 *  A <link> rather than an inline <style>: the browser caches it, it keeps
 *  working when the CSP tightens (this one already allows only 'self' for
 *  styles plus inline for CodeMirror), and DevTools shows a real stylesheet with
 *  a real URL instead of an anonymous blob - which is what you want when the
 *  file you are editing lives on disk.
 *
 *  Idempotent by id, because both the pre-paint script and the loader may reach
 *  the same theme and two copies of one stylesheet is a cascade puzzle nobody
 *  should have to debug. */
export function applyLink(id: string): void {
  const attr = 'data-bothy-user-theme';
  if (document.querySelector(`link[${attr}="${id}"]`)) return;
  const el = document.createElement('link');
  el.rel = 'stylesheet';
  el.setAttribute(attr, id);
  el.href = THEME_DIR + encodeURIComponent(id) + '.css';
  document.head.appendChild(el);
}
