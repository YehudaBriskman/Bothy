// What the markdown reader actually renders.
//
// ── why this one is compiled differently ────────────────────────────────────
//
// Every other check here compiles a module with a bare `tsc <file>`, which works
// only because those modules IMPORT NOTHING. md.tsx cannot join them: it imports
// React, lucide-react, the highlighter and the path resolver, and it returns
// elements rather than data.
//
// So this renders it for real - React, `renderToStaticMarkup`, the actual
// component - and asserts on the HTML. That is a stronger test than inspecting a
// parse tree would be, because it is the string the browser gets.
//
// AND IT ADDS NO DEPENDENCY. react-dom is already here; run.sh compiles this
// file into the project (not /tmp, or node cannot resolve `react`) and runs it.
// The repo's rule was "one 13-case truth table did not justify pulling vitest
// into a static SPA's toolchain" - that still holds, and this is why.
//
// ── what it is for ──────────────────────────────────────────────────────────
//
// Image support went in the same week as a README that grew a <picture> block,
// and both broke things that were invisible until somebody looked at a screen:
// remote badges rendered as ninety-character URLs, a linked image left `](LICENSE)`
// sitting in the prose, and raw HTML printed as its own source. None of those
// were caught by a type error or a failing build. They were caught by a
// screenshot, once, by luck.
// No @types/node here, and adding it for one call would be a dependency for a
// type. The two things this file needs from the runtime, declared.
declare const process: { exit(code: number): never };

import { renderToStaticMarkup } from 'react-dom/server';
import { renderMd, type MdLinks } from '../web/src/pages/files/md';

let fails = 0;

const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} ${ok ? '' : detail}`);
};

/** The links object a real page supplies. `src` is what turns a relative image
 *  path into a sandbox-origin URL; a caller that cannot answer omits it, and
 *  images must degrade rather than break. */
const links = (dir: string): MdLinks => ({
  dir,
  open: () => {},
  src: (p) => `/-/api/files/raw?root=stacks&path=${encodeURIComponent(p)}`,
});

const html = (src: string, l?: MdLinks) =>
  renderToStaticMarkup(<>{renderMd(src, 'k', l)}</>);

// ── images ──────────────────────────────────────────────────────────────────
console.log('── a repo-relative image becomes an <img> ──────────────────');
{
  const out = html('![a shot](docs/assets/overview.png)', links(''));
  check('renders an <img>', out.includes('<img') && out.includes('md-img'), out.slice(0, 120));
  check('src points at the raw-bytes endpoint',
    out.includes('path=docs%2Fassets%2Foverview.png'), out.slice(0, 160));
  check('alt survives', out.includes('alt="a shot"'), out.slice(0, 160));
  check('it is lazy, so a doc of screenshots does not block the prose',
    out.includes('loading="lazy"'));
}

console.log('\n── the path is resolved against the DOCUMENT, not the page ──');
{
  // A link in a document means what it means WHERE THE DOCUMENT LIVES. This is
  // the same rule ordinary links follow, and the reason `dir` exists at all.
  const out = html('![x](../assets/overview.png)', links('docs/kb'));
  check('../ resolves against the document directory',
    out.includes('path=docs%2Fassets%2Foverview.png'), out.slice(0, 160));
}

console.log('\n── a REMOTE image is a chip, never an <img> ────────────────');
{
  // The CSP's img-src does not reach third parties, so a remote <img> is blocked
  // at load; and widening it would let any document make the reader's browser
  // talk to a stranger. On a tailnet-only box that is an IP beacon.
  const out = html('![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)', links(''));
  check('no <img> is emitted', !out.includes('<img'), out.slice(0, 160));
  check('a chip is, naming the alt text', out.includes('md-img-remote') && out.includes('License: MIT'));
  check('the URL is in the title, not in the prose',
    out.includes('title="https://img.shields.io') && !out.includes('>https://img.shields.io'),
    out.slice(0, 200));
}

console.log('\n── a LINKED image is a link labelled by its alt ────────────');
{
  // `[![alt](img)](target)` - a badge. Before this was parsed as one shape, the
  // tokenizer matched the inner image and left `](LICENSE)` in the prose.
  const out = html('[![License: MIT](https://img.shields.io/x.svg)](LICENSE)', links(''));
  check('no stray `](` is left behind', !out.includes(']('), out.slice(0, 200));
  check('the label survives', out.includes('License: MIT'));
  check('the target is not thrown away', out.includes('LICENSE'), out.slice(0, 200));
}
{
  const out = html('[![badge](https://img.shields.io/x.svg)](https://example.com)', links(''));
  check('a web target becomes a real link', out.includes('href="https://example.com"'), out.slice(0, 200));
}

console.log('\n── with no src resolver, an image degrades ─────────────────');
{
  // A caller that does not know which root the document came from cannot build a
  // URL. It must not guess, and must not emit a broken <img>.
  const out = html('![x](a.png)', { dir: '', open: () => {} });
  check('no <img> without a resolver', !out.includes('<img'), out.slice(0, 160));
  check('the target is still shown to the reader', out.includes('a.png'));
}

// ── raw HTML ────────────────────────────────────────────────────────────────
console.log('\n── an HTML block is named, not printed and not run ─────────');
{
  const out = html('<picture>\n  <source srcset="a.svg">\n  <img src="b.svg">\n</picture>\n\nafter', links(''));
  check('a chip names the tag', out.includes('&lt;picture&gt; block'), out.slice(0, 200));
  // The source IS in the title - that is the design. What must never happen is
  // it appearing as VISIBLE TEXT, which is what it did before this was handled.
  // So: strip every attribute, then look at what is left.
  const visible = out.replace(/\s[\w-]+="[^"]*"/g, '');
  check('the source is not printed as visible prose',
    !visible.includes('srcset') && !visible.includes('a.svg'), visible.slice(0, 200));
  check('the block does not swallow what follows it', out.includes('after'));
}
{
  // THE SECURITY PROPERTY, asserted rather than assumed: file content never
  // becomes markup. This is why the renderer needs no sanitiser.
  const out = html('<script>alert(1)</script>\n\ntext', links(''));
  check('a script tag is never emitted as markup', !out.includes('<script'), out.slice(0, 200));
}

// ── things that must keep working ───────────────────────────────────────────
console.log('\n── the rest of the renderer still renders ──────────────────');
{
  const out = html('# Title\n\ntext with `code` and **bold**\n\n- one\n- two\n', links(''));
  check('heading', out.includes('md-h1') && out.includes('Title'));
  check('inline code', out.includes('md-code') && out.includes('code'));
  check('bold', out.includes('<strong>bold</strong>'));
  check('list', out.includes('md-list') && out.includes('one'));
}
{
  const out = html('| a | b |\n|---|---|\n| 1 | 2 |\n', links(''));
  check('table', out.includes('md-tbl') && out.includes('<td'), out.slice(0, 160));
}
{
  const out = html('```js\nconst x = 1;\n```\n', links(''));
  check('fenced code', out.includes('md-pre') && out.includes('const'), out.slice(0, 160));
}

console.log('\n── a hostile target never becomes a live link ──────────────');
{
  // refLink refuses anything carrying a scheme, which is why `javascript:` can
  // never reach an href. The image path must inherit that, not re-open it.
  for (const src of [
    '[click](javascript:alert(1))',
    '![x](javascript:alert(1))',
    '[![x](javascript:alert(1))](javascript:alert(2))',
  ]) {
    const out = html(src, links(''));
    check(`no href for: ${src.slice(0, 34)}`, !out.includes('href="javascript:'), out.slice(0, 160));
    check(`no img src for: ${src.slice(0, 32)}`, !out.includes('src="javascript:'), out.slice(0, 160));
  }
}

console.log();
console.log(fails ? `${fails} check(s) FAILED` : 'all pass');
process.exit(fails ? 1 : 0);
