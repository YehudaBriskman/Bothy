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
//
// The media cases below are the same story a second time. `![clip](x.mp4)` had
// been emitting `<img src="…mp4">` since images landed - a broken-image icon
// that no test, type or build could see, because an <img> with any src at all is
// perfectly valid markup.
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

// ── media that is not an image ──────────────────────────────────────────────
console.log('\n── a clip becomes a <video>, not a broken <img> ────────────');
{
  // Before this, mdEmbed had ONE branch: every repo-relative target became an
  // <img>, so `![clip](x.mp4)` emitted `<img src="…mp4">` and every browser drew
  // the broken-image icon. The types come from safepath's MEDIA_TYPES, mirrored
  // in tree.ts, so this is the same list the sandbox origin will actually serve.
  const out = html('![a screen recording](docs/assets/tour.mp4)', links(''));
  check('renders a <video>', out.includes('<video') && !out.includes('<img'), out.slice(0, 160));
  check('src points at the raw-bytes endpoint',
    out.includes('path=docs%2Fassets%2Ftour.mp4'), out.slice(0, 200));
  check('it has controls and does not autoplay',
    out.includes('controls') && !out.includes('autoplay'), out.slice(0, 200));
  check('only the header is fetched up front',
    out.includes('preload="metadata"'), out.slice(0, 200));
  // <video> has no alt attribute, so the author's description has to land
  // somewhere a screen reader reads.
  check('the alt text becomes the accessible name',
    out.includes('aria-label="a screen recording"'), out.slice(0, 200));
}
{
  const out = html('![](docs/assets/tour.webm)', links(''));
  check('an empty alt falls back to the target rather than naming nothing',
    out.includes('aria-label="docs/assets/tour.webm"'), out.slice(0, 200));
}

console.log('\n── a sound becomes an <audio> ─────────────────────────────');
{
  // Audio and video are one list in safepath and two elements here: an <audio>
  // is a strip of transport controls, not a picture, so it must not inherit the
  // image box.
  const out = html('![the alert tone](docs/assets/ping.mp3)', links(''));
  check('renders an <audio>', out.includes('<audio') && !out.includes('<video'), out.slice(0, 160));
  check('it is not given the image class',
    !out.includes('md-img'), out.slice(0, 200));
}

console.log('\n── an SVG is an image here, a frame elsewhere ──────────────');
{
  // The generated architecture diagrams are SVG, and this is the ONLY route that
  // shows them: an SVG in an <img> is an image context - no script, no external
  // references - whereas the same bytes opened as a document are a script host,
  // which is why /raw serves them from the sandbox origin and never from :80.
  const out = html('![the request path](assets/diagrams/request-path.svg)', links('docs'));
  check('renders an <img>', out.includes('<img') && out.includes('md-img'), out.slice(0, 160));
  check('resolved against the document directory',
    out.includes('path=docs%2Fassets%2Fdiagrams%2Frequest-path.svg'), out.slice(0, 200));
}
{
  // .svgz is gzip. /raw labels it image/svg+xml with no Content-Encoding, so an
  // <img> would be handed compressed bytes and draw the broken-image icon -
  // strictly worse than saying the file is there and letting the reader open it.
  const out = html('![z](docs/assets/x.svgz)', links(''));
  check('.svgz stays inert rather than becoming a broken <img>',
    !out.includes('<img'), out.slice(0, 200));
}

console.log('\n── a document type is NOT embedded ────────────────────────');
{
  // THE BOUNDARY, asserted. <img>/<video>/<audio> are media contexts: bytes go
  // to a decoder and nothing becomes a document. A frame is a document context -
  // safe on the sandbox origin, but safe because of a header sent by another
  // service rather than because of the element, and md.tsx's guarantee is
  // supposed to hold by reading md.tsx. So these stay inert and the reader opens
  // them in the viewer that frames them properly.
  for (const src of ['![doc](docs/spec.pdf)', '![page](docs/report.html)',
                     '![feed](docs/data.xml)', '![what](docs/notes)']) {
    const out = html(src, links(''));
    check(`no frame or img for: ${src.slice(0, 30)}`,
      !out.includes('<iframe') && !out.includes('<img') && !out.includes('<object'),
      out.slice(0, 200));
    check(`the target is still shown: ${src.slice(0, 26)}`,
      out.includes('md-reflink'), out.slice(0, 200));
  }
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
    // The video and audio branches are new SRC SINKS, so they get the same
    // assertion the <img> has always had. A scheme is refused by RE_SCHEME
    // before the type is even looked at, which is why an extension that would
    // otherwise be embedded changes nothing here.
    '![x](javascript:alert(1).mp4)',
    '![x](javascript:alert(1).mp3)',
    '![x](javascript:alert(1).svg)',
  ]) {
    const out = html(src, links(''));
    check(`no href for: ${src.slice(0, 34)}`, !out.includes('href="javascript:'), out.slice(0, 160));
    check(`no src for: ${src.slice(0, 32)}`, !out.includes('src="javascript:'), out.slice(0, 160));
    check(`no element at all for: ${src.slice(0, 26)}`,
      !out.includes('<img') && !out.includes('<video') && !out.includes('<audio'),
      out.slice(0, 160));
  }
}

console.log();
console.log(fails ? `${fails} check(s) FAILED` : 'all pass');
process.exit(fails ? 1 : 0);
