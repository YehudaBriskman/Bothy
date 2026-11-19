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
  // The walker is a ring that travels along the drawn line to the chosen size; the line behind it fills to there.
  const hill = box.querySelector<SVGPathElement>('[data-hill]');
  const walker = box.querySelector<HTMLElement>('.hs-walker');
  const hillBox = box.querySelector<HTMLElement>('.hs-hill');
  const total = hill?.getTotalLength() ?? 0;
  // where each marker sits on the line, as a length along it (the markers were placed by eye; this finds the nearest)
  const along = new Map<string, number>();
  if (hill && total) {
    for (const t of tabs) {
      const m = t.style;
      const tx = parseFloat(m.getPropertyValue('--x')) * 8;
      const ty = parseFloat(m.getPropertyValue('--y')) * 2;
      let best = 0;
      let bd = Infinity;
      for (let l = 0; l <= total; l += total / 400) {
        const p = hill.getPointAtLength(l);
        const d = (p.x - tx) ** 2 + (p.y - ty) ** 2;
        if (d < bd) {
          bd = d;
          best = l;
        }
      }
      along.set(t.dataset.tab ?? '', best);
    }
  }
  const spot = (len: number) => {
    const p = hill!.getPointAtLength(len);
    // the ring is 2rem wide; the pin it circles is centred a hair off the marker's own corner (see .hs-mark)
    return {
      x: `calc(${(p.x / 8).toFixed(2)}% - 0.8125rem)`,
      y: `calc((100% - var(--label)) * ${(p.y / 200).toFixed(4)} - 0.9625rem)`,
      clip: `${(p.x / 8).toFixed(2)}%`,
    };
  };
  let cur = -1;
  const select = (id: string, focus = false) => {
    const to = tabs.findIndex((t) => t.dataset.tab === id);
    const from = cur;
    if (from === to && !focus) return;
    cur = to;
    const panelsBox = panels[0]?.parentElement;
    if (panelsBox) panelsBox.style.setProperty('--dx', from < to ? '14px' : '-14px');
    for (const t of tabs) {
      const on = t.dataset.tab === id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      t.classList.toggle('is-on', on);
      if (on && focus) t.focus();
    }
    for (const p of panels) p.hidden = p.dataset.panel !== id;
    const target = along.get(id);
    if (hillBox && walker && hill && target !== undefined) {
      const end = spot(target);
      hillBox.style.setProperty('--wx', end.x);
      hillBox.style.setProperty('--wy', end.y);
      hillBox.style.setProperty('--wclip', end.clip);
      walker.classList.toggle('is-planned', tabs[to]?.classList.contains('is-planned') ?? false);
      const start = from >= 0 ? along.get(tabs[from]?.dataset.tab ?? '') : undefined;
      if (!reduced && start !== undefined && start !== target && walker.animate) {
        const frames = Array.from({ length: 16 }, (_, k) => {
          const q = spot(start + ((target - start) * k) / 15);
          return { insetInlineStart: q.x, insetBlockStart: q.y };
        });
        walker.animate(frames, { duration: 520, easing: 'cubic-bezier(.45,0,.2,1)' });
      }
    }
  };
  // The hill answers the pointer: moving a mouse along it walks to the nearest size, a click or tap picks one.
  const hillEl = box.querySelector<HTMLElement>('.hs-hill');
  hillEl?.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    let best = 0;
    let bd = Infinity;
    tabs.forEach((t, k) => {
      const r = t.getBoundingClientRect();
      const d = Math.abs(e.clientX - (r.left + 16));
      if (d < bd) {
        bd = d;
        best = k;
      }
    });
    select(tabs[best]?.dataset.tab ?? '');
  });
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

  // ── The install chapter: scroll STARTS a stage, the stage then plays to its end on its own clock ──────────────
  // Four stages, one per command. Scrolling a step to the middle of the view starts its stage; from then on it does not
  // depend on the scroll: the command types (smoothly, at its own pace), a pause, a running spinner as if executing,
  // then the output lines one by one, a beat, and the step's Done tick. The next stage waits for this one and for its
  // own step to be reached. Scrolling back does not undo anything; "Replay" runs it again from the top.
  for (const rail of qa('[data-scrub]')) {
    const demo = rail.closest('.hs-install')?.querySelector<HTMLElement>('[data-scrub-demo]');
    const steps = qa('[data-step]', rail);
    if (!demo) continue;
    const pre = demo.querySelector<HTMLElement>('pre');
    const spin = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const stages = qa('.hs-ln', demo).map((ln) => {
      const target = ln.querySelector<HTMLElement>('[data-type]')!;
      const text = target.textContent ?? '';
      const head = document.createTextNode('');
      const rest = document.createElement('span');
      rest.className = 'hs-rest';
      rest.textContent = text;
      const caret = document.createElement('span');
      caret.className = 'hs-caret';
      target.textContent = '';
      target.append(head, caret, rest);
      return { ln, text, head, rest, ind: ln.querySelector<HTMLElement>('[data-spin]'), outs: qa('[data-out]', ln) };
    });
    const n = stages.length;
    const RUN = [1100, 900, 1200, 1500]; // how long each command "runs" before it answers (ms)
    let next = 0;
    let busy = false;
    let gen = 0;
    const follow = () => {
      if (pre) pre.scrollTop = pre.scrollHeight;
    };
    const reset = () => {
      gen++;
      busy = false;
      next = 0;
      stages.forEach((s, k) => {
        s.head.data = '';
        s.rest.textContent = s.text;
        s.ln.classList.remove('is-active', 'is-typing', 'is-running');
        s.ln.classList.toggle('hs-wait', k > 0);
        if (s.ind) s.ind.textContent = '';
        for (const o of s.outs) o.classList.add('hs-wait');
        steps[k]?.classList.remove('is-done');
      });
      demo.classList.remove('is-ended');
      stages[0]?.ln.classList.add('is-active'); // an idle prompt, waiting for the first scroll
      if (pre) pre.scrollTop = 0;
    };
    const play = async (k: number) => {
      const s = stages[k]!;
      const g = gen;
      const ok = () => g === gen;
      busy = true;
      s.ln.classList.remove('hs-wait');
      s.ln.classList.add('is-active');
      follow();
      await wait(450); // a beat: the prompt is there, then it starts to type
      if (!ok()) return;
      s.ln.classList.add('is-typing');
      const per = Math.max(14, Math.min(40, 2200 / Math.max(1, s.text.length)));
      const t0 = Date.now();
      for (let c = 1; c <= s.text.length; c++) {
        s.head.data = s.text.slice(0, c);
        s.rest.textContent = s.text.slice(c);
        await wait(Math.max(0, t0 + c * per - Date.now()));
        if (!ok()) return;
        follow();
      }
      s.ln.classList.remove('is-typing');
      await wait(700); // typed; the cursor waits, as it would before Enter
      if (!ok()) return;
      s.ln.classList.add('is-running');
      let f = 0;
      const tick = setInterval(() => {
        if (s.ind) s.ind.textContent = ` ${spin[f++ % spin.length]}`;
      }, 90);
      await wait(RUN[k] ?? 1200);
      clearInterval(tick);
      if (!ok()) return;
      s.ln.classList.remove('is-running');
      if (s.ind) s.ind.textContent = '';
      for (const o of s.outs) {
        await wait(o === s.outs[0] ? 160 : 300);
        if (!ok()) return;
        o.classList.remove('hs-wait');
        follow();
      }
      await wait(650); // a beat after the last line, then the tick
      if (!ok()) return;
      steps[k]?.classList.add('is-done');
      await wait(550);
      if (!ok()) return;
      s.ln.classList.remove('is-active');
      busy = false;
      next = k + 1;
      if (next >= n) demo.classList.add('is-ended');
      pump();
    };
    const pump = () => {
      if (busy || next >= n) return;
      if (steps[next]?.classList.contains('is-lit')) void play(next);
    };
    rail.classList.add('hs-live');
    demo.classList.add('hs-scrubbing');
    reset();
    pump();
    addEventListener('scroll', pump, { passive: true });
    addEventListener('resize', pump, { passive: true });
    const again = demo.querySelector<HTMLButtonElement>('[data-replay]');
    if (again) {
      again.hidden = false;
      again.addEventListener('click', () => {
        reset();
        pump();
      });
    }
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
    let gen = 0;
    const play = async () => {
      const g = ++gen;
      let first = true;
      for (const ln of lines) {
        const ty = typed.get(ln);
        if (ty) {
          await wait(first ? 350 : 400);
          first = false;
          const step = Math.min(45, 1400 / Math.max(1, ty.text.length));
          for (let n = 1; n <= ty.text.length; n++) {
            if (g !== gen) return;
            ty.head.data = ty.text.slice(0, n);
            ty.rest.textContent = ty.text.slice(n);
            await wait(step);
          }
        } else {
          await wait(rows.length ? 350 : 300);
          if (g !== gen) return;
          ln.classList.remove('hs-wait');
          rows[Number(ln.dataset.out)]?.classList.add('is-on');
        }
      }
      await wait(300);
      if (g !== gen) return;
      run.classList.remove('hs-pre');
      foot?.classList.add('is-on');
    };
    // "Run again" (src/mocks.ts asks with an event): put everything back to its start and play the run once more
    run.addEventListener('mk:rerun', () => {
      gen++;
      for (const ln of lines) {
        const ty = typed.get(ln);
        if (ty) {
          ty.head.data = '';
          ty.rest.textContent = ty.text;
        } else ln.classList.add('hs-wait');
      }
      for (const r of rows) r.classList.remove('is-on');
      foot?.classList.remove('is-on');
      run.classList.add('hs-pre');
      void play();
    });
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
