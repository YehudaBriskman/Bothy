// A theme somebody dropped into a directory must be classified correctly, and
// the classification has to survive a file written by hand.
//
// WHY THIS IS WORTH A TABLE. The header is optional, the id comes from a
// filename, and the appearance decides which base palette the pre-paint script
// stamps - so getting `appearance` wrong is not a cosmetic bug, it is a light
// theme rendering its first frame on the dark base. Every row below is a shape
// a real hand-written file takes: no header at all, a header with only some
// fields, `color-scheme` on its own, and the awkward ones - CRLF, odd spacing,
// a `note:` containing a colon.
//
// lib/customThemes.ts imports nothing, which is what lets this compile it in
// isolation. Same property discover.ts and contract.ts rely on.

import { parseThemeHeader } from './user-themes-mod.mjs';

let bad = 0;
function eq(label, got, want) {
  const ok = got === want;
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(54)} `
    + `${ok ? String(got) : `want=${want} got=${got}`}`);
}

console.log('── the header is optional ──────────────────────────────────────────');
{
  // The minimum a theme can be: a palette block and nothing else. It still has
  // to appear in the picker with a readable name, or a working file looks broken
  // over a missing comment.
  const t = parseThemeHeader('solarized-dark', ":root[data-bothy-theme='x']{color-scheme:dark;--bg:#002b36}");
  eq('name falls back to the prettified filename', t.name, 'Solarized Dark');
  eq('appearance is read from color-scheme', t.appearance, 'dark');
  eq('note has a default', t.note, 'Added on this box.');
  eq('href is built from the id', t.href, '/data/themes/solarized-dark.css');
  eq('marked as a user theme', t.user, true);
}

console.log('\n── a light theme must be detected as light ─────────────────────────');
// The row that matters most: getting this wrong stamps the dark base palette on
// the first frame and the page flashes.
eq('color-scheme: light',
   parseThemeHeader('paper', 'x{color-scheme: light}').appearance, 'light');
eq('appearance: light in the header beats a missing color-scheme',
   parseThemeHeader('paper', '/* bothy-theme\n   appearance: light\n*/\nx{}').appearance, 'light');
// The header wins on purpose: it is the field a person edited deliberately,
// where color-scheme may have been copied along with the rest of the block.
eq('the header wins over a contradicting color-scheme',
   parseThemeHeader('paper', '/* bothy-theme\n appearance: light\n*/\nx{color-scheme:dark}').appearance,
   'light');
eq('anything else is dark, never undefined',
   parseThemeHeader('x', '/* bothy-theme\n appearance: banana\n*/').appearance, 'dark');

console.log('\n── a header written by a human ─────────────────────────────────────');
{
  const css = '/* bothy-theme\r\n'
    + '     name:   Solarized  Light \r\n'
    + '   appearance:LIGHT\r\n'
    + '   note: Precision colours: for machines and people.\r\n'
    + '*/\nx{}';
  const t = parseThemeHeader('sol', css);
  // CRLF, because a file edited on Windows or pasted from a gist has them and
  // failing on that would be a mystery to whoever wrote it.
  eq('CRLF line endings parse', t.name, 'Solarized  Light');
  eq('a value is trimmed but its inner spacing is left alone', t.name, 'Solarized  Light');
  eq('the key is case-insensitive and so is the value', t.appearance, 'light');
  // Split on the FIRST colon only: a note is prose and prose contains colons.
  eq('a note may contain a colon', t.note, 'Precision colours: for machines and people.');
}

console.log('\n── the id is the filename, and it reaches a selector ───────────────');
// The id ends up inside an attribute selector in the theme's own CSS and inside
// a URL, so the loader only accepts clean ones. parseThemeHeader itself does not
// filter - list() does - but the href it builds must still be escaped, because
// this function is also called by the editor on a name a person just typed.
eq('a space in an id is escaped in the href',
   parseThemeHeader('my theme', 'x{}').href, '/data/themes/my%20theme.css');
eq('...and the name still reads',
   parseThemeHeader('my-first-theme', 'x{}').name, 'My First Theme');
eq('underscores are separators too',
   parseThemeHeader('deep_ocean', 'x{}').name, 'Deep Ocean');

console.log(`\n${bad ? `${bad} FAILED` : 'all pass'}`);
process.exit(bad ? 1 : 0);
