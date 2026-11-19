// Section design gallery: draws window.SECTIONS (mocks-home.js, mocks-pages.js) and wires replay, scrub and the
// small pointer and keyboard behaviours the mocks use. No dependencies, no network.
(() => {
  const S = window.SECTIONS || [];
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const esc = (t) =>
    String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const COST = ['Effort', 'Risk', 'Perf', 'A11y'];

  // ── Table of contents ──────────────────────────────────────────────────
  let grp = '';
  let toc = '';
  S.forEach((s, i) => {
    if (s.group !== grp) {
      toc += `${grp ? '</ol>' : ''}<p class="grp">${esc(s.group)}</p><ol>`;
      grp = s.group;
    }
    toc += `<li><a href="#${s.id}"><span class="n">${String(i + 1).padStart(2, '0')}</span>${esc(s.title)}</a></li>`;
  });
  $('#toc').innerHTML = toc + '</ol>';

  // ── Sections ───────────────────────────────────────────────────────────
  const L = 'ABC';
  $('#sections').innerHTML = S.map((s, i) => {
    const opts = s.opts
      .map((o, k) => {
        const cost = (o.cost || 'M M M M')
          .split(' ')
          .map((c, j) => `<span class="${c}" title="${COST[j]}: ${c}">${COST[j]} <b>${c}</b></span>`)
          .join('');
        return `<article class="opt${o.rec ? ' rec' : ''}" data-k="${L[k]}" aria-labelledby="${s.id}-${L[k]}">
  <div class="opt-head"><span class="let" aria-hidden="true">${L[k]}</span><h3 id="${s.id}-${L[k]}"><span class="sr">${L[k]}. </span>${esc(o.name)}</h3>${o.rec ? '<span class="star">★ Recommended</span>' : ''}<span class="costs">${cost}</span><button type="button" class="tbtn" data-replay>Replay</button></div>
  <div class="stg ${o.cls || ''}" style="${o.style || ''}">${o.html}</div>
  <div class="meta"><p><b>Why.</b> ${o.why}</p><p><b>Says.</b> ${o.says}</p><p><b>Motion.</b> ${o.motion}</p></div>
</article>`;
      })
      .join('');
    return `<section class="sec" id="${s.id}" aria-labelledby="${s.id}-h">
  <div class="sec-head"><div><p class="lab">${String(i + 1).padStart(2, '0')} · ${esc(s.group)}</p><h2 id="${s.id}-h">${esc(s.title)}</h2>
  <p><b>Now.</b> ${s.now}</p><p><b>Weak.</b> ${s.weak}</p>${s.ref ? `<p><b>Reference.</b> ${s.ref}</p>` : ''}</div>
  <div class="ctl"><div class="seg" role="group" aria-label="Show">${['All', 'Side by side', 'A', 'B', 'C'].map((v, j) => `<button type="button" data-view="${v}" aria-pressed="${j === 0}">${v}</button>`).join('')}</div>
  <button type="button" class="tbtn" data-replay-all>Replay all</button>
  <label class="scrub">Scrub <input type="range" min="0" max="1000" value="1000" data-scrub aria-label="Scrub the motion of ${esc(s.title)}" /></label></div></div>
  <div class="opts" data-view="all">${opts}</div>
</section>`;
  }).join('');

  const style = document.createElement('style');
  style.textContent = '.sr{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}';
  document.head.append(style);

  // ── Motion control ─────────────────────────────────────────────────────
  const anims = (el) => (el.getAnimations ? el.getAnimations({ subtree: true }) : []);
  const end = (a) => {
    const t = a.effect.getComputedTiming();
    const it = Number.isFinite(t.activeDuration) ? t.activeDuration : t.duration;
    return (t.delay || 0) + (Number.isFinite(it) ? it : 0);
  };
  function replay(stg) {
    stg.classList.remove('on');
    void stg.offsetWidth;
    stg.classList.add('on');
    stg.dataset.seen = '1';
    stg.dispatchEvent(new CustomEvent('replay'));
  }
  function seek(stg, p) {
    const list = anims(stg);
    const total = Math.max(1, ...list.map(end));
    for (const a of list) {
      a.pause();
      a.currentTime = p * total;
    }
  }
  function hold(stg) {
    stg.classList.add('on');
    for (const a of anims(stg)) {
      a.pause();
      a.currentTime = 0;
    }
  }
  const stages = $$('.stg');
  stages.forEach(hold);
  const io = new IntersectionObserver(
    (es) => {
      for (const e of es)
        if (e.isIntersecting && !e.target.dataset.seen) {
          e.target.dataset.seen = '1';
          for (const a of anims(e.target)) a.play();
        }
    },
    { threshold: 0.3 },
  );
  stages.forEach((s) => io.observe(s));

  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-replay')) replay($('.stg', b.closest('.opt')));
    if (b.hasAttribute('data-replay-all')) $$('.stg', b.closest('.sec')).forEach(replay);
    if (b.dataset.view) {
      const sec = b.closest('.sec');
      const v = b.dataset.view;
      $$('.seg button', sec).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      const opts = $('.opts', sec);
      opts.dataset.view = v === 'Side by side' ? 'side' : 'all';
      $$('.opt', sec).forEach((o) => (o.hidden = v.length === 1 && o.dataset.k !== v));
    }
  });
  document.addEventListener('input', (ev) => {
    const r = ev.target;
    if (r.hasAttribute('data-scrub'))
      $$('.opt:not([hidden]) .stg', r.closest('.sec')).forEach((s) => seek(s, r.value / 1000));
  });
  $('#motion-toggle').addEventListener('click', (ev) => {
    const on = document.body.classList.toggle('paused');
    ev.currentTarget.setAttribute('aria-pressed', String(on));
    ev.currentTarget.textContent = on ? 'Resume motion' : 'Pause all motion';
  });

  // Test hooks for the screenshot script: seek every stage to t ms, or to the end.
  window.seekAll = (ms) =>
    stages.forEach((s) => {
      s.classList.add('on');
      for (const a of anims(s)) {
        a.pause();
        a.currentTime = ms === 'end' ? end(a) : ms;
      }
    });

  // ── Behaviours the mocks use ───────────────────────────────────────────
  const rel = (el, ev) => {
    const r = el.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top, r];
  };
  for (const box of $$('[data-spot]')) {
    box.addEventListener('pointermove', (ev) => {
      for (const c of $$('.spot', box)) {
        const [x, y] = rel(c, ev);
        c.style.setProperty('--mx', x + 'px');
        c.style.setProperty('--my', y + 'px');
      }
    });
  }
  for (const box of $$('[data-lit]')) {
    box.addEventListener('pointermove', (ev) => {
      const t = $('.litwm', box) || box;
      const [x, y] = rel(t, ev);
      t.style.setProperty('--mx', x + 'px');
      t.style.setProperty('--my', y + 'px');
    });
  }
  for (const el of $$('[data-tilt]')) {
    el.addEventListener('pointermove', (ev) => {
      if (reduce.matches) return;
      const [x, y, r] = rel(el, ev);
      el.style.setProperty('--ry', ((x / r.width - 0.5) * 8).toFixed(2) + 'deg');
      el.style.setProperty('--rx', ((0.5 - y / r.height) * 6).toFixed(2) + 'deg');
    });
    el.addEventListener('pointerleave', () => {
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
    });
  }
  for (const box of $$('[data-mag]')) {
    const m = $('.mag', box);
    box.addEventListener('pointermove', (ev) => {
      if (reduce.matches) return;
      const [x, y, r] = rel(m, ev);
      const dx = x - r.width / 2;
      const dy = y - r.height / 2;
      const near = Math.hypot(dx, dy) < 140;
      m.style.setProperty('--tx', near ? (dx * 0.12).toFixed(1) + 'px' : '0px');
      m.style.setProperty('--ty', near ? (dy * 0.18).toFixed(1) + 'px' : '0px');
    });
    box.addEventListener('pointerleave', () => {
      m.style.setProperty('--tx', '0px');
      m.style.setProperty('--ty', '0px');
    });
  }
  // Tabs: role=tab buttons, arrow keys, an indicator, optional autoplay with a progress bar.
  for (const box of $$('[data-tabs]')) {
    const tabs = $$('[role=tab]', box);
    const ind = $('.ind', box);
    const bar = $('.prog i', box);
    const auto = +box.dataset.auto || 0;
    let cur = 0;
    let timer = 0;
    let stop = false;
    const show = (i, focus) => {
      cur = (i + tabs.length) % tabs.length;
      tabs.forEach((t, j) => {
        t.setAttribute('aria-selected', String(j === cur));
        t.tabIndex = j === cur ? 0 : -1;
      });
      $$('[data-panel]', box).forEach((p) => (p.hidden = +p.dataset.panel !== cur));
      $$('[data-cam]', box).forEach((c) => (c.dataset.cam = cur));
      if (ind) {
        const t = tabs[cur];
        ind.style.setProperty('--ix', t.offsetLeft - 3 + 'px');
        ind.style.setProperty('--iw', t.offsetWidth + 'px');
      }
      if (focus) tabs[cur].focus();
      if (bar && auto && !stop && !reduce.matches) {
        bar.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: auto, easing: 'linear' });
      }
      clearTimeout(timer);
      if (auto && !stop && !reduce.matches) timer = setTimeout(() => show(cur + 1), auto);
    };
    tabs.forEach((t, j) => {
      t.addEventListener('click', () => {
        stop = true;
        show(j);
      });
      t.addEventListener('keydown', (ev) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
        if (d) {
          ev.preventDefault();
          stop = true;
          show(cur + d, true);
        }
      });
    });
    box.addEventListener('focusin', () => (stop = true));
    requestAnimationFrame(() => show(0));
    setTimeout(() => show(cur), 60);
  }
  // Filter chips: buttons[data-f], items[data-k] (space-separated keys).
  for (const box of $$('[data-filter]')) {
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-f]');
      if (!b) return;
      $$('[data-f]', box).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      const f = b.dataset.f;
      $$('[data-k]', box).forEach((it) =>
        it.classList.toggle('off', f !== 'all' && !it.dataset.k.split(' ').includes(f)),
      );
    });
  }
  // Live search: input filters items[data-t].
  for (const box of $$('[data-search]')) {
    const inp = $('input', box);
    inp.addEventListener('input', () => {
      const q = inp.value.trim().toLowerCase();
      let n = 0;
      $$('[data-t]', box).forEach((it) => {
        const hit = !q || it.dataset.t.toLowerCase().includes(q) || it.textContent.toLowerCase().includes(q);
        it.classList.toggle('off', !hit);
        n += hit;
      });
      const c = $('[data-count]', box);
      if (c) c.textContent = n + (n === 1 ? ' page' : ' pages');
    });
  }
  // Copy buttons.
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-copy]');
    if (!b) return;
    navigator.clipboard?.writeText(b.dataset.copy).catch(() => {});
    const t = b.textContent;
    b.textContent = 'Copied';
    b.closest('[data-copybox]')?.classList.add('copied');
    setTimeout(() => {
      b.textContent = t;
      b.closest('[data-copybox]')?.classList.remove('copied');
    }, 1500);
  });
  // Disclosure (a dropdown in a mock): button[aria-expanded] + its panel.
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-dd]');
    if (!b) return;
    const p = document.getElementById(b.getAttribute('aria-controls'));
    const open = b.getAttribute('aria-expanded') !== 'true';
    b.setAttribute('aria-expanded', String(open));
    p.hidden = !open;
    if (open) for (const a of anims(p)) (a.cancel(), a.play());
  });
  // A hover pill that follows the pointed or focused link.
  for (const box of $$('[data-hl]')) {
    const ind = $('.ind', box);
    const go = (a) => {
      ind.style.setProperty('--ix', a.offsetLeft - 3 + 'px');
      ind.style.setProperty('--iw', a.offsetWidth + 'px');
      ind.style.opacity = 1;
    };
    $$('a', box).forEach((a) => {
      a.addEventListener('pointerenter', () => go(a));
      a.addEventListener('focus', () => go(a));
    });
    box.addEventListener('pointerleave', () => (ind.style.opacity = 0));
    const first = $('a[aria-current]', box);
    if (first) setTimeout(() => go(first), 50);
  }
  // Scroll-linked mocks: an inner scroller drives its children (stand-in for animation-timeline: view()).
  for (const sc of $$('[data-scroll]')) {
    const kind = sc.dataset.scroll;
    const upd = () => {
      const r = sc.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      if (kind === 'spy') {
        let act = 0;
        $$('[data-sec]', sc).forEach((h, i) => {
          if (h.getBoundingClientRect().top - r.top < 60) act = i;
        });
        const box = sc.closest('.stg');
        $$('[data-to]', box).forEach((l, i) => l.toggleAttribute('data-act', i === act));
        const l = $$('[data-to]', box)[act];
        const ind = $('.spy-ind', box);
        if (l && ind) ind.style.transform = `translateY(${l.offsetTop}px)`;
        const bar = $('.prog i', box);
        if (bar) bar.style.setProperty('--p', (sc.scrollTop / (sc.scrollHeight - sc.clientHeight || 1)).toFixed(3));
      } else if (kind === 'lines') {
        $$('[data-line]', sc).forEach((ln) => {
          const b = ln.getBoundingClientRect();
          const d = Math.abs(b.top + b.height / 2 - mid) / (r.height / 2);
          ln.style.opacity = (1 - Math.min(1, d) * 0.78).toFixed(2);
        });
      } else if (kind === 'stack') {
        const cards = $$('[data-card]', sc);
        cards.forEach((c, i) => {
          const next = cards[i + 1];
          let p = 0;
          if (next)
            p = Math.max(0, Math.min(1, 1 - (next.getBoundingClientRect().top - r.top - 30) / (r.height * 0.7)));
          c.style.transform = `scale(${(1 - p * 0.06).toFixed(3)})`;
          c.style.filter = `brightness(${(1 - p * 0.35).toFixed(2)})`;
        });
      } else if (kind === 'rail') {
        const p = sc.scrollTop / (sc.scrollHeight - sc.clientHeight || 1);
        sc.style.setProperty('--p', p.toFixed(3));
        $$('[data-step]', sc).forEach((s) => {
          const b = s.getBoundingClientRect();
          s.toggleAttribute('data-act', b.top < mid && b.bottom > r.top + 20);
        });
      }
    };
    sc.addEventListener('scroll', upd, { passive: true });
    upd();
  }
  // Self-ticked checklist (install page stepper): a progress count, kept only on the page.
  for (const box of $$('[data-steps]')) {
    const boxes = $$('input[type=checkbox]', box);
    const upd = () => {
      const n = boxes.filter((b) => b.checked).length;
      box.style.setProperty('--p', (n / boxes.length).toFixed(3));
      $('[data-count]', box).textContent = `${n} of ${boxes.length} done`;
    };
    boxes.forEach((b) => b.addEventListener('change', upd));
    upd();
  }

  // ── Current section in the index ───────────────────────────────────────
  const links = $$('#toc a');
  const so = new IntersectionObserver(
    (es) => {
      for (const e of es)
        if (e.isIntersecting)
          links.forEach((a) => a.setAttribute('aria-current', String(a.hash === '#' + e.target.id)));
    },
    { rootMargin: '-30% 0px -60% 0px' },
  );
  $$('.sec').forEach((s) => so.observe(s));
})();
