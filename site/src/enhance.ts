import './styles/tokens.css';
import './styles/site.css';
import './styles/chapters.css';
import './styles/sky-still.css';
import './styles/sky.css';
import './styles/story.css';
import './styles/dither.css';
import './styles/console.css';
// the frame and the pages outside the story load last: one header, menu and footer for every page
import './styles/chrome.css';
import './styles/sections.css';
import './styles/home-sections.css';
import './styles/reading.css';
import './styles/pages.css';
import './styles/inner.css';
import './styles/intro.css';
import './styles/new-sections.css';
import './styles/chosen.css';

/**
 * The only script on the site. Every page is complete HTML without it; this adds
 * a few conveniences and nothing else: copy icons on commands, documentation
 * search, the install menu and collapsing the docs menu on a phone. There is no
 * colour-scheme switch and nothing is stored but one sessionStorage flag (the
 * first-visit splash has played): the sky follows the visitor's hour, and without
 * script the page follows prefers-color-scheme.
 */

// Controls that only work with JavaScript are rendered `hidden`; reveal them now.
for (const el of document.querySelectorAll<HTMLElement>('[data-needs-js]')) el.hidden = false;

// ── Copy controls: rendered in the markup (components/CopyButton.tsx), revealed above, wired by one lazy script ───
if (document.querySelector('[data-cp]')) void import('./copy.ts');

// ── The install menu and the phone sheet: APG disclosure keys on a native <details> ─────────────────
// Escape closes and returns focus to the button; Down/Up move through the items (Down on the closed button opens it
// and moves in); Home/End jump; a click or focus outside closes; opening one closes the others.
const menus = [...document.querySelectorAll<HTMLDetailsElement>('details[data-dd]')];
const itemsOf = (d: HTMLDetailsElement) =>
  [...d.querySelectorAll<HTMLElement>('summary ~ * a[href], summary ~ * button')].filter((e) => e.offsetParent);
for (const d of menus) {
  const sum = d.querySelector('summary')!;
  d.addEventListener('toggle', () => {
    if (d.open) for (const o of menus) if (o !== d) o.open = false;
  });
  d.addEventListener('keydown', (e) => {
    const items = itemsOf(d);
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape' && d.open) {
      e.preventDefault();
      d.open = false;
      sum.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!d.open) d.open = true;
      const list = itemsOf(d);
      if (!list.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length;
      list[next]!.focus();
    } else if ((e.key === 'Home' || e.key === 'End') && at >= 0) {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1]!.focus();
    }
  });
  d.addEventListener('focusout', (e) => {
    if (d.open && e.relatedTarget instanceof Node && !d.contains(e.relatedTarget)) d.open = false;
  });
}
document.addEventListener('click', (e) => {
  for (const d of menus) if (d.open && !d.contains(e.target as Node)) d.open = false;
});

// ── The header's states: moved (a soft blur) and over the ink (a quiet dark bar with a hairline) ───────────
// On a page with the story, the bar turns dark once the story's end (#story-end, solid black at its bottom edge) has
// passed under it; on every other page, as soon as the page moves. Plain scroll events: no frame clock, one rect.
{
  const root = document.documentElement;
  const end = document.querySelector<HTMLElement>('#story-end') ?? document.querySelector<HTMLElement>('.after-story');
  const hasStory = !!document.querySelector('[data-story]');
  const navH = () => document.querySelector<HTMLElement>('[data-nav]')?.offsetHeight ?? 64;
  // the condensing capsule: --nav-p is the scroll through the first 120 px (1 at once with reduced motion);
  // data-nav-cap marks the capsule as present enough that the bar's ink must suit its dark glass (chrome.css)
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const update = () => {
    const moved = scrollY > 8;
    const p = still ? 1 : Math.min(1, Math.max(0, scrollY / 120));
    root.style.setProperty('--nav-p', p.toFixed(3));
    root.toggleAttribute('data-nav-cap', p >= 0.5);
    root.toggleAttribute('data-scrolled', moved);
    const dark = hasStory ? !!end && end.getBoundingClientRect().bottom < navH() + 40 : moved;
    root.toggleAttribute('data-nav-dark', dark);
  };
  update();
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update, { passive: true });
}

// ── Reveal on scroll: once, staggered by --i, only what starts below the fold, never with reduced motion ─────
if (!matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
  const els = [...document.querySelectorAll<HTMLElement>('.reveal')];
  const io = new IntersectionObserver(
    (es) => {
      for (const e of es)
        if (e.isIntersecting) {
          const el = e.target as HTMLElement;
          el.classList.add('is-shown');
          el.classList.remove('is-waiting');
          io.unobserve(el);
        }
    },
    { rootMargin: '0px 0px -6% 0px', threshold: 0.06 },
  );
  for (const el of els) {
    if (el.getBoundingClientRect().top < innerHeight) continue; // on screen at load: never hidden
    el.classList.add('is-waiting');
    io.observe(el);
  }
  document.documentElement.classList.add('js-reveal');
}

// The inner pages' behaviours (lit lines, docs marker, install paths): a lazy island, only where the markup is
if (document.querySelector('.manifesto, #docs-q, .toc, [data-paths]')) void import('./inner.ts');

// ── Docs menu: closed by default on a phone ─────────────────────────────────
const narrow = window.matchMedia('(max-width: 60rem)');
for (const d of document.querySelectorAll<HTMLDetailsElement>('details[data-collapse-narrow]'))
  d.open = !narrow.matches;

// ── The footer wordmark's light: a lazy island, loaded only when the footer comes near ─
const footMark = document.querySelector<HTMLElement>('[data-footmark]');
if (footMark && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void import('./footmark.ts').then((m) => m.mountFootmark(footMark));
    },
    { rootMargin: '400px 0px' },
  );
  io.observe(footMark);
}

// ── The clip player below the story: a lazy island, loaded when the section comes near ─
const newSections = document.querySelector<HTMLElement>('[data-player]');
if (newSections && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void import('./new-sections.ts').then((m) => m.mountNewSections(newSections));
    },
    { rootMargin: '600px 0px' },
  );
  io.observe(newSections);
}
// ── The Home sections' motion and size tabs: a lazy chunk, only where the page has them (the markup is complete without it) ─
if (document.querySelector('[data-hs]')) void import('./home-sections.ts');
// ── The app mocks' own controls (rows, filters, switches, buttons): a lazy chunk, only where the page has a mock ─
if (document.querySelector('[data-mock]')) void import('./mocks.ts');
// ── The reading wheels: a lazy chunk, only where the page has them ─
if (document.querySelector('[data-wheel]')) void import('./wheel.ts');

// ── The live sky: a lazy island, only on a page that has one, after the page has loaded ─
const storyRoot = document.querySelector<HTMLElement>('[data-story]');
if (storyRoot) void import('./story/mount.ts').then((m) => m.mountStory(storyRoot));
const skySection = document.querySelector<HTMLElement>('[data-sky]');
if (skySection) {
  const start = () => void import('./enhance-sky.ts').then((m) => m.mountSky(skySection));
  if (document.readyState === 'complete') start();
  else addEventListener('load', start, { once: true });
}

// ── The first-visit intro: the Cube opens into the lockup and the page assembles round it (brand/splash.ts) ─
// The home page's inline head script decided already (brand/splash-gate.ts) and set `bb-intro` on <html>; its own
// 3.5 s failsafe removes the class if this import never arrives, and a late arrival finds no class and does nothing.
if (document.documentElement.classList.contains('bb-intro')) {
  // ?splash=hold: built paused at 0 for a screenshot harness to seek (headless Chromium here has no frame clock)
  const hold = new URLSearchParams(location.search).get('splash') === 'hold';
  void import('./brand/splash.ts').then(
    (m) => {
      if (document.documentElement.classList.contains('bb-intro')) m.playSplash({ hold });
    },
    () => document.documentElement.classList.remove('bb-intro'),
  );
}

// ── Documentation search ────────────────────────────────────────────────────
interface IndexPage {
  slug: string;
  title: string;
  href: string;
  s: { id: string; h: string; t: string }[];
}

const form = document.querySelector<HTMLFormElement>('form[data-docs-search]');
if (form) void initSearch(form);

async function initSearch(f: HTMLFormElement) {
  const input = f.querySelector<HTMLInputElement>('input[type=search]');
  const out = f.querySelector<HTMLElement>('#docs-results');
  const list = document.querySelector<HTMLElement>('#docs-list');
  if (!input || !out || !list) return;
  const base = document.querySelector<HTMLMetaElement>('meta[name=bothy-base]')?.content ?? '/';
  let pages: IndexPage[] | null = null;
  let loading: Promise<void> | null = null;
  const load = () =>
    (loading ??= fetch(`${base}search-index.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { pages: IndexPage[] }) => {
        pages = j.pages;
      })
      .catch(() => {
        loading = null;
      }));

  const words = (q: string) => q.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

  function snippet(text: string, terms: string[]): string {
    const lower = text.toLocaleLowerCase();
    const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), text.length);
    const start = Math.max(0, at - 50);
    return `${start > 0 ? '…' : ''}${text.slice(start, start + 150)}${start + 150 < text.length ? '…' : ''}`;
  }

  function run() {
    const q = input!.value.trim();
    out!.replaceChildren();
    const terms = words(q);
    // Typing filters the list in place: rows that do not match fade and shrink (CSS, on [data-off]); with no
    // query every row is back. The full-text hits below the field are the second, deeper answer.
    for (const row of list!.querySelectorAll<HTMLElement>('[data-row]'))
      row.toggleAttribute(
        'data-off',
        terms.length > 0 && !terms.every((w) => row.textContent!.toLocaleLowerCase().includes(w)),
      );
    if (!q || !pages) return;
    if (!terms.length) return;
    const hits: { score: number; page: IndexPage; sec: IndexPage['s'][number] }[] = [];
    for (const page of pages) {
      const title = page.title.toLocaleLowerCase();
      for (const sec of page.s) {
        const h = sec.h.toLocaleLowerCase();
        const t = sec.t.toLocaleLowerCase();
        let score = 0;
        let all = true;
        for (const term of terms) {
          const s = (title.includes(term) ? 4 : 0) + (h.includes(term) ? 6 : 0) + (t.includes(term) ? 1 : 0);
          if (!s) {
            all = false;
            break;
          }
          score += s;
        }
        if (all) hits.push({ score, page, sec });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, 20);
    const status = document.createElement('p');
    status.className = 'muted small';
    status.textContent = top.length
      ? ((top.length === 1 ? input!.dataset.countOne : input!.dataset.countMany)?.replace(/\d+/, String(top.length)) ??
        '')
      : (input!.dataset.none ?? '').replace('{q}', q);
    out!.append(status);
    if (!top.length) return;
    const ul = document.createElement('ul');
    ul.className = 'results';
    for (const h of top) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `${h.page.href}${h.sec.id ? `#${h.sec.id}` : ''}`;
      const t = document.createElement('span');
      t.className = 'card-title';
      t.textContent = h.sec.h && h.sec.h !== h.page.title ? `${h.page.title}: ${h.sec.h}` : h.page.title;
      const s = document.createElement('span');
      s.className = 'card-sum';
      s.textContent = snippet(h.sec.t, terms);
      a.append(t, s);
      li.append(a);
      ul.append(li);
    }
    out!.append(ul);
  }

  input.addEventListener('focus', () => void load());
  input.addEventListener('input', () => void load().then(run));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    void load().then(run);
  });
}
