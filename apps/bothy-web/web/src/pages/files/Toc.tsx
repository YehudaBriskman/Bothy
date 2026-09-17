// ── the table of contents ────────────────────────────────────────────────────
//
// The thing a docs viewer has and a file explorer does not (docs/plans/
// reading-first.md §3), and it costs NO new data and NO second parse - which is
// the reason it is built the way it is.
//
// IT READS THE RENDERED DOM, not the markdown source. md.tsx already parses
// every heading in order to render it, and since the cross-document link work it
// stamps each one with `data-md-anchor="<slug>"`. So the headings are already on
// the page, already slugged, already in document order. Re-parsing the source
// here would be a second markdown parser to keep in step with the first, and it
// would list headings that the renderer did not actually produce.
//
// The consequence worth stating: this is SELF-REGULATING. A JSON file, an image,
// a PDF or the Source view emit no `data-md-anchor` at all, so the outline finds
// nothing and renders nothing, and no caller has to know which kinds have
// headings.
//
// A MutationObserver rather than a prop or an effect on the content: the
// document arrives asynchronously (FileView owns the fetch), the reader does not
// hold its bytes, and re-collecting on every DOM change inside the article is
// both correct and cheap - the article changes once per document.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Heading {
  slug: string;
  text: string;
  /** 1-6, as the FILE wrote it. md.tsx renders `#` as `<h2 class="md-h md-h1">`
   *  because the shell owns the page title, so the tag name is one deeper than
   *  the author's level. The class is the author's level, and the author's level
   *  is what an outline should indent by. */
  level: number;
}

/** The scrolling ancestor of the rendered article. `.fx-read` is the element
 *  with `overflow: auto` (editor.css), but finding it by CLASS would tie this to
 *  one of FileContent's branches - so it is found by its computed overflow, the
 *  property that actually decides which element emits the scroll events. */
function scrollerOf(el: Element | null): HTMLElement | null {
  let at: HTMLElement | null = el as HTMLElement | null;
  while (at && at !== document.body) {
    const o = getComputedStyle(at).overflowY;
    if ((o === 'auto' || o === 'scroll') && at.scrollHeight > at.clientHeight) return at;
    at = at.parentElement;
  }
  return null;
}

function levelOf(el: Element): number {
  const m = /(?:^|\s)md-h([1-6])(?:\s|$)/.exec(el.className);
  if (m) return Number(m[1]);
  // A heading with no md-h class is not something this renderer makes today.
  // Falling back to the tag keeps the outline honest if one ever appears.
  const tag = /^H([1-6])$/.exec(el.tagName);
  return tag ? Math.max(1, Number(tag[1]) - 1) : 1;
}

/**
 * @param box the element the document is rendered into. Everything is scoped to
 *            it - `data-md-anchor` is a data attribute rather than an `id`
 *            precisely because the editor mounts several documents at once, and
 *            a document-wide lookup would answer with the wrong one.
 */
export function useHeadings(box: React.RefObject<HTMLElement | null>, key: string): Heading[] {
  const [heads, setHeads] = useState<Heading[]>([]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => {
      const found = Array.from(el.querySelectorAll('[data-md-anchor]'));
      const next: Heading[] = found.map((h) => ({
        slug: h.getAttribute('data-md-anchor') || '',
        text: h.textContent?.trim() || '',
        level: levelOf(h),
      })).filter((h) => h.slug && h.text);
      // Compared by value, not replaced blindly: the observer fires for every
      // mutation inside the article, and a fresh array each time would re-render
      // the outline (and restart its scroll listener) on changes that did not
      // touch a heading.
      setHeads((prev) => (
        prev.length === next.length && prev.every((p, i) => p.slug === next[i].slug && p.text === next[i].text)
          ? prev
          : next
      ));
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [box, key]);

  return heads;
}

export function Toc({ headings, box }: {
  headings: Heading[];
  box: React.RefObject<HTMLElement | null>;
}) {
  const [active, setActive] = useState('');
  const nav = useRef<HTMLElement | null>(null);

  // ── which heading you are reading ──────────────────────────────────────────
  //
  // NOT an IntersectionObserver, which is the usual answer and the wrong one
  // here. IO reports headings entering and leaving a band, so on a document
  // whose sections are taller than the viewport there are stretches with NO
  // heading intersecting anything and the highlight either sticks to the last
  // one that left or clears. Reading the positions on scroll answers the actual
  // question - "which heading is the last one above the top of the viewport" -
  // and it has an answer at every scroll position, including the gaps.
  //
  // rAF-coalesced, so a fast scroll does one measurement per frame rather than
  // one per event.
  useEffect(() => {
    const el = box.current;
    if (!el || !headings.length) { setActive(''); return; }
    const scroller = scrollerOf(el.querySelector('[data-md-anchor]')) ?? el;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const top = scroller.getBoundingClientRect().top;
      let at = headings[0].slug;
      for (const h of headings) {
        const node = el.querySelector(`[data-md-anchor="${CSS.escape(h.slug)}"]`);
        if (!node) continue;
        // 8px of grace: a heading scrolled exactly to the top has a rounding
        // error's chance of measuring at 0.4px and being counted as "below".
        if (node.getBoundingClientRect().top - top <= 8) at = h.slug;
        else break;
      }
      // The bottom of the document can never be reached by the rule above when
      // the last section is short - the page stops scrolling before its heading
      // clears the top. At the end, the last heading is the answer.
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
        at = headings[headings.length - 1].slug;
      }
      setActive(at);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [headings, box]);

  // Keep the marked entry visible in a long outline. `nearest` so a short list
  // never scrolls at all, and no smooth behaviour - this happens while the user
  // is already scrolling something else.
  useEffect(() => {
    if (!active) return;
    nav.current?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const go = useCallback((slug: string) => {
    const el = box.current;
    const node = el?.querySelector(`[data-md-anchor="${CSS.escape(slug)}"]`);
    node?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [box]);

  // Fewer than two headings is not an outline, it is a repeat of the title.
  if (headings.length < 2) return null;

  // The shallowest level in THIS document is the baseline, so a file whose
  // headings all start at `##` is not indented one step for its whole length.
  const base = Math.min(...headings.map((h) => h.level));

  return (
    <nav className="rd-toc" aria-label="On this page" ref={nav}>
      <p className="rd-toc-h">On this page</p>
      <ul className="rd-toc-list">
        {headings.map((h, i) => (
          <li key={`${h.slug}-${i}`} style={{ paddingLeft: `${Math.min(h.level - base, 3) * 11}px` }}>
            <button
              type="button"
              className={`rd-toc-a${h.slug === active ? ' on' : ''}`}
              aria-current={h.slug === active ? 'true' : undefined}
              onClick={() => go(h.slug)}
              title={h.text}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
