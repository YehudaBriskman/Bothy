/**
 * The motion and the few controls of the Home sections from "what is inside" down (styles/home-sections.css).
 * Every piece is an upgrade: the page is complete HTML without this file, and with reduced motion nothing here
 * runs except the size tabs, which are a control and not a movement. Only transform and opacity ever animate; the
 * counters change text. All timing is setTimeout/setInterval and IntersectionObserver, never the frame clock.
 */
const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canObserve = 'IntersectionObserver' in window;
const qa = <T extends HTMLElement>(sel: string, from: ParentNode = document) => [...from.querySelectorAll<T>(sel)];
const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

// ── Size tabs: the markers on the hill are links to the cards; with script they become the tabs of one card ──
for (const box of qa('[data-tabs]')) {
  const tabs = qa<HTMLAnchorElement>('[data-tab]', box);
  const panels = qa('[data-panel]', box);
  const list = box.querySelector<HTMLElement>('[data-tablist]');
  if (!list || tabs.length === 0) continue;
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', box.dataset.label ?? '');
  const select = (id: string, focus = false) => {
    for (const t of tabs) {
      const on = t.dataset.tab === id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      t.classList.toggle('is-on', on);
      if (on && focus) t.focus();
    }
    for (const p of panels) p.hidden = p.dataset.panel !== id;
  };
  for (const t of tabs) {
    const id = t.dataset.tab ?? '';
    t.setAttribute('role', 'tab');
    t.id = `tab-${id}`;
    t.setAttribute('aria-controls', `size-${id}`);
    t.addEventListener('click', (e) => {
      e.preventDefault();
      select(id);
    });
  }
  for (const p of panels) {
    p.setAttribute('role', 'tabpanel');
    p.setAttribute('aria-labelledby', `tab-${p.dataset.panel}`);
  }
  list.addEventListener('keydown', (e) => {
    const at = tabs.findIndex((t) => t === document.activeElement);
    if (at < 0) return;
    const rtl = getComputedStyle(list).direction === 'rtl';
    const next =
      e.key === 'ArrowRight'
        ? rtl
          ? at - 1
          : at + 1
        : e.key === 'ArrowLeft'
          ? rtl
            ? at + 1
            : at - 1
          : e.key === 'ArrowDown'
            ? at + 1
            : e.key === 'ArrowUp'
              ? at - 1
              : e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? tabs.length - 1
                  : e.key === ' '
                    ? at
                    : -1;
    if (next < 0) return;
    e.preventDefault();
    const to = tabs[(next + tabs.length) % tabs.length];
    if (to) select(to.dataset.tab ?? '', true);
  });
  box.classList.add('is-tabs');
  select(tabs[0]?.dataset.tab ?? '');
}

// ── Pointer light on the cards: two CSS variables, no loop. Touch has no pointer light. ──────────────────────
for (const group of qa('[data-spot]')) {
  group.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    for (const card of qa('.hs-card', group)) {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`);
      card.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`);
    }
  });
}

if (!reduced && canObserve) {
  root.classList.add('js-hs');

  // ── Reveal: each [data-hs] block plays once when it comes into view (the CSS holds the start state) ─────────
  const reveal = new IntersectionObserver(
    (es) => {
      for (const e of es)
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          reveal.unobserve(e.target);
        }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  );
  for (const el of qa('[data-hs]')) reveal.observe(el);

  // ── The sky windows drift only while they are on screen ─────────────────────────────────────────────────
  const live = new IntersectionObserver((es) => {
    for (const e of es) e.target.classList.toggle('hs-live', e.isIntersecting);
  });
  for (const el of qa('.photo')) live.observe(el);

  // ── Numbers count up once, with the final figure already in the markup ──────────────────────────────────
  const nf = new Intl.NumberFormat(root.lang || 'en');
  const counters = new IntersectionObserver(
    (es) => {
      for (const e of es) {
        if (!e.isIntersecting) continue;
        counters.unobserve(e.target);
        const el = e.target as HTMLElement;
        const to = Number(el.dataset.count);
        const t0 = Date.now();
        const tick = setInterval(() => {
          const k = Math.min(1, (Date.now() - t0 - 300) / 1200);
          if (k >= 1) {
            clearInterval(tick);
            el.textContent = nf.format(to);
          } else if (k > 0) el.textContent = nf.format(Math.round(to * (1 - (1 - k) ** 3)));
        }, 40);
      }
    },
    { threshold: 0.6 },
  );
  for (const el of qa('[data-count]')) {
    el.textContent = nf.format(0);
    counters.observe(el);
  }

  // ── The rail: it fills from the top as the page scrolls, and the step in the middle of the view is lit ────
  for (const rail of qa('[data-rail]')) {
    const steps = qa('[data-step]', rail);
    const update = () => {
      const r = rail.getBoundingClientRect();
      const mid = innerHeight * 0.55;
      rail.style.setProperty('--p', String(Math.max(0, Math.min(1, (mid - r.top) / Math.max(1, r.height)))));
      let lit = -1;
      steps.forEach((s, k) => {
        const b = s.getBoundingClientRect();
        if (b.top + 24 < mid) lit = k;
      });
      steps.forEach((s, k) => {
        s.classList.toggle('is-lit', k <= lit);
        s.classList.toggle('is-now', k === lit);
      });
    };
    rail.classList.add('hs-live');
    update();
    addEventListener('scroll', update, { passive: true });
    addEventListener('resize', update, { passive: true });
  }

  // ── Terminals that run once: commands type, answers print, and the rows they belong to tick ───────────────
  for (const run of qa('[data-run]')) {
    const demo = run.matches('.hs-demo') ? run : run.querySelector<HTMLElement>('.hs-demo');
    if (!demo) continue;
    const lines = qa('.hs-cmd, [data-out]', demo);
    const rows = qa('[data-row]', run);
    const foot = run.querySelector<HTMLElement>('[data-foot]');
    const typed = new Map<HTMLElement, { text: string; head: Text; rest: HTMLElement }>();
    for (const ln of lines) {
      if (ln.classList.contains('hs-cmd')) {
        const target = ln.querySelector<HTMLElement>('[data-type]');
        if (!target) continue;
        const text = target.textContent ?? '';
        const head = document.createTextNode('');
        const rest = document.createElement('span');
        rest.className = 'hs-rest';
        rest.textContent = text;
        target.textContent = '';
        target.append(head, rest);
        typed.set(ln, { text, head, rest });
      } else ln.classList.add('hs-wait');
    }
    run.classList.add('hs-pre');
    const play = async () => {
      let first = true;
      for (const ln of lines) {
        const ty = typed.get(ln);
        if (ty) {
          await wait(first ? 350 : 400);
          first = false;
          const step = Math.min(45, 1400 / Math.max(1, ty.text.length));
          for (let n = 1; n <= ty.text.length; n++) {
            ty.head.data = ty.text.slice(0, n);
            ty.rest.textContent = ty.text.slice(n);
            await wait(step);
          }
        } else {
          await wait(rows.length ? 350 : 300);
          ln.classList.remove('hs-wait');
          rows[Number(ln.dataset.out)]?.classList.add('is-on');
        }
      }
      await wait(300);
      run.classList.remove('hs-pre');
      foot?.classList.add('is-on');
    };
    const once = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        once.disconnect();
        void play();
      },
      { threshold: 0.4 },
    );
    once.observe(run);
  }
}
