import './styles/site.css';
import './styles/chapters.css';
import './styles/sky-still.css';
import './styles/sky.css';
import './styles/story.css';
import './styles/console.css';
import './styles/pages.css';

/**
 * The only script on the site. Every page is complete HTML without it; this adds
 * four conveniences and nothing else: a colour-scheme choice, copy buttons on
 * commands, documentation search, and collapsing the docs menu on a phone.
 *
 * Browser storage can be missing or throw (private windows, blocked site data),
 * so every access is guarded and the page works the same without it.
 */

const root = document.documentElement;

function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice lasts until the page is left */
  }
  return null;
}

// Controls that only work with JavaScript are rendered `hidden`; reveal them now.
for (const el of document.querySelectorAll<HTMLElement>('[data-needs-js]')) el.hidden = false;

// ── Colour scheme ───────────────────────────────────────────────────────────
const select = document.querySelector<HTMLSelectElement>('#theme-select');
if (select) {
  const saved = store('bothy-theme');
  select.value = saved === 'light' || saved === 'dark' ? saved : 'auto';
  select.addEventListener('change', () => {
    if (select.value === 'auto') {
      root.removeAttribute('data-theme');
      store('bothy-theme', '');
    } else {
      root.setAttribute('data-theme', select.value);
      store('bothy-theme', select.value);
    }
  });
}

// ── Copy buttons ────────────────────────────────────────────────────────────
function copyButton(label: string, idle: string, done: string, text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'copy';
  b.textContent = idle;
  b.setAttribute('aria-label', label);
  let timer: number | undefined;
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = done;
    } catch {
      // No clipboard permission (insecure origin, old browser): select the text instead.
      const pre = b.parentElement?.querySelector('pre');
      if (pre) getSelection()?.selectAllChildren(pre);
      return;
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(() => (b.textContent = idle), 1800);
  });
  return b;
}

const ui = document.querySelector<HTMLElement>('main')?.dataset ?? {};
const idle = ui.copyIdle ?? 'Copy';
const done = ui.copied ?? 'Copied';
for (const fig of document.querySelectorAll<HTMLElement>('figure.term[data-copy-text]')) {
  const caption = fig.querySelector('figcaption')?.textContent ?? '';
  fig.append(copyButton(`${idle}: ${caption}`, idle, done, fig.dataset.copyText ?? ''));
}
for (const code of document.querySelectorAll<HTMLElement>('.prose .code')) {
  const text = code.querySelector('pre')?.textContent ?? '';
  code.append(copyButton(idle, idle, done, text.replace(/\n$/, '')));
}

// ── Docs menu: closed by default on a phone ─────────────────────────────────
const narrow = window.matchMedia('(max-width: 60rem)');
for (const d of document.querySelectorAll<HTMLDetailsElement>('details[data-collapse-narrow]'))
  d.open = !narrow.matches;

// ── The live sky: a lazy island, only on a page that has one, after the page has loaded ─
const storyRoot = document.querySelector<HTMLElement>('[data-story]');
if (storyRoot) void import('./story/mount.ts').then((m) => m.mountStory(storyRoot));
const skySection = document.querySelector<HTMLElement>('[data-sky]');
if (skySection) {
  const start = () => void import('./enhance-sky.ts').then((m) => m.mountSky(skySection));
  if (document.readyState === 'complete') start();
  else addEventListener('load', start, { once: true });
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
    list!.hidden = false;
    if (!q || !pages) return;
    const terms = words(q);
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
    list!.hidden = true;
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
