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

  // ── The install chapter: scrubbed. The scroll position IS the progress of the whole sequence ────────────────
  // Four stages, one per command, laid end to end along the steps: a stage runs from its step reaching the middle of
  // the view to the next one doing so. Inside a stage the scroll maps to: a beat, the command typing, a pause, a running
  // spinner, the output lines one by one, the Done tick. The state is a pure function of the progress (scrolling back
  // rewinds it, nothing is skipped). The progress shown follows the one the scroll asks for through a critically damped
  // filter with a speed limit, so a fling is a quick sweep through every state, never a jump.
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
    const c01 = (v: number) => Math.max(0, Math.min(1, v));
    // inside one stage, 0..1: beat, type, pause, run, output lines, a beat, the tick
    const TYPE = [0.05, 0.42];
    const RUNS = [0.52, 0.74];
    const OUTS = [0.76, 0.92];
    const DONE = 0.95;
    const paint = (P: number) => {
      let tail: HTMLElement | null = null;
      stages.forEach((s, k) => {
        const u = c01(P - k);
        const typed = c01((u - TYPE[0]!) / (TYPE[1]! - TYPE[0]!));
        const c = Math.floor(typed * s.text.length + 1e-6);
        s.head.data = s.text.slice(0, c);
        s.rest.textContent = s.text.slice(c);
        const running = u >= RUNS[0]! && u < RUNS[1]!;
        const live = u > 0 && u < 1;
        s.ln.classList.toggle('hs-wait', k > 0 && u === 0);
        s.ln.classList.toggle('is-active', live || (k === 0 && u === 0));
        s.ln.classList.toggle('is-typing', typed > 0 && typed < 1);
        s.ln.classList.toggle('is-running', running);
        if (s.ind) s.ind.textContent = running ? ` ${spin[Math.floor(u * 90) % spin.length]}` : '';
        s.outs.forEach((o, j) => {
          const at = OUTS[0]! + ((OUTS[1]! - OUTS[0]!) * j) / s.outs.length;
          const on = u >= at && u >= RUNS[1]!;
          o.classList.toggle('hs-wait', !on);
          if (on) tail = o;
        });
        steps[k]?.classList.toggle('is-done', u >= DONE);
        if (u > 0 || k === 0) tail = tail && s.outs.includes(tail) ? tail : s.ln.querySelector('.hs-cmd');
      });
      demo.classList.toggle('is-ended', P >= n - 1 + DONE);
      demo.dataset.progress = P.toFixed(3);
      // keep the newest visible line in view in the terminal
      if (pre && tail) {
        const t = tail as HTMLElement;
        pre.scrollTop = Math.max(0, t.offsetTop + t.offsetHeight - pre.clientHeight + 12);
      }
    };
    // where the scroll asks the sequence to be: stage k begins when step k reaches the middle of the view
    const ask = () => {
      const mid = innerHeight * 0.55;
      const tops = steps.map((s) => s.getBoundingClientRect().top - mid);
      const last = steps[n - 1]!.getBoundingClientRect();
      const end = last.top - mid + Math.max(innerHeight * 0.5, last.height);
      for (let k = n - 1; k >= 0; k--) {
        const a = tops[k]!;
        if (a > 0) continue;
        const b = k + 1 < n ? tops[k + 1]! : end;
        return k + c01(-a / Math.max(1, b - a));
      }
      return 0;
    };
    const SPEED = 2.8; // stages per second at most: a fling from the top to the bottom takes about 1.5 s
    const TAU = 0.16; // seconds: the time constant of the filter
    let shown = 0;
    let target = 0;
    let last = 0;
    let armed = false;
    const frame = () => {
      armed = false;
      const now = performance.now();
      const dt = Math.min(0.25, Math.max(0.001, (now - last) / 1000));
      last = now;
      const want = (target - shown) * (1 - Math.exp(-dt / TAU));
      const cap = SPEED * dt;
      shown = Math.abs(target - shown) < 0.0005 ? target : shown + Math.max(-cap, Math.min(cap, want));
      paint(shown);
      if (shown !== target) arm();
    };
    // a frame clock where there is one, a timer where there is not (a background tab, a headless browser)
    const arm = () => {
      if (armed) return;
      armed = true;
      let ran = false;
      const go = () => {
        if (!ran) {
          ran = true;
          frame();
        }
      };
      requestAnimationFrame(go);
      setTimeout(go, 50);
    };
    const onScroll = () => {
      const t = ask();
      if (t === target) return;
      target = t;
      if (!armed) last = performance.now();
      arm();
    };
    rail.classList.add('hs-live');
    demo.classList.add('hs-scrubbing');
    target = shown = ask();
    last = performance.now();
    paint(shown);
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll, { passive: true });
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
