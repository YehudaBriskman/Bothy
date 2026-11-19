/**
 * The inner pages' small behaviours, one import from enhance.ts: About's lines that light (a fallback where scroll
 * timelines do not exist), the docs "/" shortcut and moving marker, the install page's path switch and ticks.
 * Each part looks for its own markup and does nothing on a page without it.
 */

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── About: light a line once it reaches the middle of the screen, only where CSS cannot do it ───────────────
{
  const lines = [...document.querySelectorAll<HTMLElement>('.manifesto .mf')];
  if (lines.length && !reduced && 'IntersectionObserver' in window && !CSS.supports('animation-timeline: view()')) {
    document.documentElement.classList.add('js-mf');
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) e.target.classList.toggle('lit', e.isIntersecting || e.boundingClientRect.top < 0);
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    for (const l of lines) io.observe(l);
  }
}

// ── Docs: "/" focuses the search; the contents marker follows the section being read ────────────────────────
{
  const q = document.querySelector<HTMLInputElement>('#docs-q');
  if (q)
    addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      q.focus();
    });
}
{
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.toc li a[href^="#"]')];
  const list = links[0]?.closest('ul');
  if (list && links.length) {
    const marker = document.createElement('span');
    marker.className = 'toc-marker';
    marker.setAttribute('aria-hidden', 'true');
    list.prepend(marker);
    const heads = links.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1))));
    let active = -1;
    const place = (i: number) => {
      const a = links[i]!;
      const li = a.closest('li')!;
      marker.style.setProperty('--y', `${li.offsetTop}px`);
      marker.style.blockSize = `${li.offsetHeight}px`;
    };
    const update = () => {
      const line = (document.querySelector<HTMLElement>('[data-nav]')?.offsetHeight ?? 64) + 24;
      let at = 0;
      heads.forEach((h, i) => {
        if (h && h.getBoundingClientRect().top <= line) at = i;
      });
      if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) at = links.length - 1;
      if (at === active) return;
      active = at;
      links.forEach((a, i) => (i === at ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
      place(at);
    };
    update();
    addEventListener('scroll', update, { passive: true });
    addEventListener('resize', () => place(Math.max(active, 0)), { passive: true });
  }
}

// ── Install: pick a path, see only that path; copying a command ticks its step done ─────────────────────────
{
  const grid = document.querySelector<HTMLElement>('[data-paths]');
  const cards = grid ? [...grid.querySelectorAll<HTMLElement>('[data-path]')] : [];
  const panels = new Map(
    [...document.querySelectorAll<HTMLElement>('[data-panel]')].map((p) => [p.dataset.panel!, p] as const),
  );
  if (grid && cards.length === 2 && panels.size === 2) {
    document.documentElement.classList.add('js-paths');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', grid.dataset.label ?? '');
    const tabs = cards.map((card) => {
      const key = card.dataset.path!;
      const h = card.querySelector('h3')!;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'path-pick';
      b.id = `tab-${key}`;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-controls', key);
      b.append(...h.childNodes);
      h.append(b);
      card.addEventListener('click', (e) => {
        if (!(e.target as HTMLElement).closest('a')) select(key, false);
      });
      return b;
    });
    const select = (key: string, focus: boolean, animate = true) => {
      cards.forEach((c, i) => {
        const on = c.dataset.path === key;
        c.dataset.on = String(on);
        tabs[i]!.setAttribute('aria-checked', String(on));
        tabs[i]!.tabIndex = on ? 0 : -1;
        if (on && focus) tabs[i]!.focus();
      });
      for (const [k, p] of panels) {
        const was = p.hidden;
        p.hidden = k !== key;
        if (!p.hidden && was && animate && !reduced) {
          p.classList.remove('swap-in');
          void p.offsetWidth;
          p.classList.add('swap-in');
        }
      }
    };
    grid.addEventListener('keydown', (e) => {
      const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
      if (at < 0) return;
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (step === undefined && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const to = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : (at + step! + 2) % 2;
      select(cards[to]!.dataset.path!, true);
    });
    const fromHash = () => {
      const key = location.hash.slice(1);
      if (panels.has(key)) select(key, false, false);
    };
    select('binary', false, false);
    fromHash();
    addEventListener('hashchange', fromHash);
  }

  // Steps: a "Done" box per step, a progress line, and a copy click ticks the step.
  const steps = document.querySelector<HTMLElement>('[data-steps]');
  if (steps) {
    const items = [...steps.querySelectorAll<HTMLElement>(':scope > li')];
    const label = grid?.dataset.doneLabel ?? 'Done';
    const text = steps.dataset.progressText ?? '';
    const prog = document.createElement('p');
    prog.className = 'steps-progress';
    prog.setAttribute('role', 'status');
    const bar = document.createElement('span');
    bar.className = 'steps-bar';
    bar.innerHTML = '<i></i>';
    const msg = document.createElement('span');
    prog.append(msg, bar);
    steps.before(prog);
    const sync = () => {
      const n = items.filter((li) => li.hasAttribute('data-done')).length;
      let k = 0;
      msg.textContent = text.replace(/\d+/g, () => String(k++ === 0 ? n : items.length));
      bar.style.setProperty('--p', String(n / items.length));
    };
    items.forEach((li) => {
      const box = document.createElement('input');
      box.type = 'checkbox';
      const l = document.createElement('label');
      l.className = 'step-done';
      l.append(box, label);
      li.append(l);
      box.addEventListener('change', () => {
        li.toggleAttribute('data-done', box.checked);
        sync();
      });
      li.addEventListener('click', (e) => {
        if (!(e.target as HTMLElement).closest('[data-cp]') || box.checked) return;
        box.checked = true;
        li.setAttribute('data-done', '');
        sync();
      });
    });
    sync();
  }
}
