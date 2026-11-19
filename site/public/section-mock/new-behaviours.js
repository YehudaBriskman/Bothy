// Behaviours for the proposed new sections (mocks-new.js). Runs after gallery.js has drawn the panels.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  // Video slots: play and pause. With reduced motion nothing starts by itself (poster only).
  const slots = $$('[data-clip]');
  const setPlaying = (slot, on) => {
    slot.dataset.playing = String(on);
    if (on) slot.dataset.started = '1';
    const b = $('[data-clip-toggle]', slot);
    if (b) b.setAttribute('aria-label', (on ? 'Pause ' : 'Play ') + b.dataset.name + ' clip');
  };
  slots.forEach((s) => {
    if (reduce.matches || s.dataset.playing === 'false') setPlaying(s, false);
  });
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-clip-toggle]');
    if (!b) return;
    const slot = b.closest('[data-clip]');
    const on = slot.dataset.playing !== 'true';
    if (on) {
      // one card plays at a time inside a card row
      const row = slot.closest('.g3');
      if (row) $$('[data-clip]', row).forEach((o) => o !== slot && setPlaying(o, false));
    }
    setPlaying(slot, on);
  });

  // Fan of windows: choose which is in front.
  for (const fan of $$('.fan')) {
    const wins = $$('.fw', fan);
    const box = fan.closest('.stg');
    const pick = (i) => {
      wins.forEach((w, j) => (j === i ? w.setAttribute('data-front', '') : w.removeAttribute('data-front')));
      $$('[data-pick]', box).forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.pick === i)));
    };
    wins.forEach((w, i) => w.addEventListener('pointerenter', () => pick(i)));
    $$('[data-pick]', box).forEach((b) => b.addEventListener('click', () => pick(+b.dataset.pick)));
  }

  // Comparison table: highlight one size.
  for (const box of $$('[data-colfocus]')) {
    const tbl = $('[data-mt]', box.closest('.stg'));
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-cf]');
      if (!b) return;
      $$('[data-cf]', box).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (b.dataset.cf) tbl.dataset.focus = b.dataset.cf;
      else tbl.removeAttribute('data-focus');
    });
  }
  for (const th of $$('.mtab thead [data-c]')) {
    const tbl = th.closest('table');
    th.addEventListener('pointerenter', () => (tbl.dataset.focus = th.dataset.c));
    th.addEventListener('pointerleave', () => {
      const on = $('[data-colfocus] [aria-pressed=true]', tbl.closest('.stg'));
      if (on && on.dataset.cf) tbl.dataset.focus = on.dataset.cf;
      else tbl.removeAttribute('data-focus');
    });
  }

  // Ladder: a radio group (arrow keys), new lines get an outline.
  for (const box of $$('[data-ladder]')) {
    const radios = $$('[role=radio]', box);
    const items = $$('[data-lv]', box);
    const note = $('[data-ladder-note]', box);
    const notes = [
      'Installs today. About 38 MiB across its three containers in our lab.',
      'Planned, not built. Not yet measured.',
      'Planned, not built. Not yet measured.',
      'Planned. The building block, `bothy module add`, is tested on a simulated machine only.',
    ];
    const lvOf = [0, 1, 2, 2];
    const pick = (i, focus) => {
      i = (i + radios.length) % radios.length;
      radios.forEach((r, j) => {
        r.setAttribute('aria-checked', String(j === i));
        r.tabIndex = j === i ? 0 : -1;
      });
      if (focus) radios[i].focus();
      items.forEach((it) => {
        const lv = +it.dataset.lv;
        const show = i === 3 ? true : lv <= lvOf[i];
        const wasHidden = it.hidden;
        it.hidden = !show;
        it.classList.toggle('new', show && (i === 3 ? false : lv === lvOf[i] && lv > 0));
        if (show && wasHidden && !reduce.matches)
          it.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], {
            duration: 400,
            easing: 'cubic-bezier(.16,1,.3,1)',
          });
      });
      note.textContent = notes[i] + (i === 3 ? ' You pick each piece.' : '');
    };
    radios.forEach((r, i) => {
      r.addEventListener('click', () => pick(i));
      r.addEventListener('keydown', (ev) => {
        const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[ev.key];
        if (d) {
          ev.preventDefault();
          pick(i + d, true);
        }
      });
    });
  }

  // Three questions.
  for (const box of $$('[data-quiz]')) {
    const out = $('.qz-out', box);
    const upd = () => {
      const a = [1, 2, 3].map((n) => +($(`input[name=q${n}]:checked`, box)?.value || 0));
      let h = 'Bivvy';
      let p = 'It installs today. About 38 MiB across its three containers in our lab.';
      if (a[2]) {
        h = 'Cairn, later. Bivvy now.';
        p = 'Picking pieces one at a time is planned; `bothy module add` exists and is tested on a simulated machine only. Start with Bivvy.';
      } else if (a[1]) {
        h = 'Basecamp, later. Bivvy now.';
        p = 'Dashboards, single sign-on, a database and a cluster view are planned, not built, and not yet measured. Start with Bivvy.';
      } else if (a[0]) {
        h = 'Bothy, later. Bivvy now.';
        p = 'Metrics, logs, alerts and backups are planned, not built, and not yet measured. Start with Bivvy.';
      }
      $('[data-q-h]', out).textContent = h;
      $('[data-q-p]', out).textContent = p;
      if (!reduce.matches) out.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 250 });
    };
    box.addEventListener('change', upd);
  }

  // Request path: choose a box, read its fact.
  for (const box of $$('[data-flow]')) {
    const facts = JSON.parse(box.dataset.facts);
    const out = $('[data-fact]', box.closest('.stg'));
    $$('.node', box).forEach((n) =>
      n.addEventListener('click', () => {
        $$('.node', box).forEach((x) => x.setAttribute('aria-pressed', String(x === n)));
        const f = facts[+n.dataset.n];
        out.innerHTML = '';
        const b = document.createElement('b');
        b.textContent = f[0] + '. ';
        out.append(b, document.createTextNode(f[1]));
        if (!reduce.matches) out.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250 });
      }),
    );
  }

  // Scrub stand-in: the frame and the caption follow the scroll position.
  for (const sc of $$('[data-scroll-frames]')) {
    const frames = $('.frames', sc);
    const caps = $$('.steps-t p', sc);
    const upd = () => {
      const p = sc.scrollTop / Math.max(1, sc.scrollHeight - sc.clientHeight);
      const i = Math.min(3, Math.floor(p * 4));
      frames.dataset.at = String(i);
      caps.forEach((c, j) => c.toggleAttribute('data-on', j === i));
    };
    sc.addEventListener('scroll', upd, { passive: true });
    upd();
  }
})();
