import { progressAt } from './camera.ts';
import { progress } from './progress.ts';
import { setupConsole } from './console.ts';
import { SCENES, sceneOpacity } from './scenes.ts';

/**
 * The story script (build plan S7): a chapter state machine on IntersectionObserver, the scroll-to-descent mapping,
 * the scene backdrops, staggered reveals and the progress dots. No scroll library, no frame loop of its own: scroll
 * events write one number (`progress`) and a few CSS variables; the sky engine reads the number inside its own single
 * requestAnimationFrame loop. Native scroll throughout: nothing here moves the page or traps focus.
 *
 * Without script the page is a plain stack of sections on a still sky. With `prefers-reduced-motion` this still runs
 * the chapter state and the dots, but writes no progress, loads no scene and hides nothing for a reveal.
 */
export function mountStory(root: HTMLElement): void {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
  const base = document.querySelector<HTMLMetaElement>('meta[name=bothy-base]')?.content ?? '/';
  const sections = [...root.querySelectorAll<HTMLElement>(':scope > section[id]:not([data-flow])')];
  root.classList.add('story-js');
  // the test harness (?manual=1) steps frames by hand and waits for every animation to finish: scroll-linked drift never does
  if (new URLSearchParams(location.search).get('manual') === '1') root.classList.add('story-static');

  // ── The dots, and the chapter the visitor is in ───────────────────────────
  const dots = root.querySelector<HTMLElement>('[data-story-dots]');
  if (dots) dots.hidden = false;
  const links = new Map<string, HTMLAnchorElement>();
  for (const a of root.querySelectorAll<HTMLAnchorElement>('[data-ch-link]')) links.set(a.dataset.chLink ?? '', a);
  let current = '';
  function setChapter(id: string) {
    if (id === current) return;
    current = id;
    root.dataset.ch = id;
    for (const s of sections) s.classList.toggle('is-active', s.id === id);
    for (const [k, a] of links) {
      if (k === id) a.setAttribute('aria-current', 'step');
      else a.removeAttribute('aria-current');
    }
  }
  // the chapter is the one that holds the middle of the window
  const chIO = new IntersectionObserver(
    (es) => {
      for (const e of es) if (e.isIntersecting) setChapter((e.target as HTMLElement).id);
    },
    { rootMargin: '-45% 0px -45% 0px' },
  );
  for (const s of sections) chIO.observe(s);
  setChapter(sections[0]?.id ?? '');

  // the capsule bar condenses once the page has moved (a size change, transitioned only when motion is allowed)
  const condense = () => document.documentElement.toggleAttribute('data-scrolled', scrollY > 24);
  condense();
  addEventListener('scroll', condense, { passive: true });

  if (reduced) return;

  // ── Staggered reveals: hidden only when script runs, and only what starts below the fold ──────
  const floats = [...root.querySelectorAll<HTMLElement>('.float')];
  const seen = new Set<HTMLElement>();
  const rvIO = new IntersectionObserver(
    (es) => {
      for (const e of es)
        if (e.isIntersecting) {
          (e.target as HTMLElement).classList.add('is-in');
          rvIO.unobserve(e.target);
        }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  );
  const parents = new Map<Element, number>();
  for (const el of floats) {
    const n = parents.get(el.parentElement!) ?? 0;
    parents.set(el.parentElement!, n + 1);
    el.style.setProperty('--i', String(n));
    if (el.getBoundingClientRect().top < innerHeight) {
      el.classList.add('is-in'); // already on screen at load: no flash of hidden
      continue;
    }
    el.classList.add('rv');
    seen.add(el);
    rvIO.observe(el);
  }

  // ── Scene backdrops: fetched only when their chapter is within ~1.5 windows ─────────────────
  const sceneEls = new Map<string, HTMLElement>();
  for (const s of SCENES) {
    const el = root.querySelector<HTMLElement>(`[data-scene="${s.id}"]`);
    if (el) sceneEls.set(s.id, el);
  }
  const loaded = new Set<string>();
  if (!saveData) {
    const scIO = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (!e.isIntersecting) continue;
          const s = SCENES.find((x) => x.chapter === (e.target as HTMLElement).id);
          const el = s && sceneEls.get(s.id);
          if (!s || !el || loaded.has(s.id)) continue;
          loaded.add(s.id);
          const img = new Image();
          img.src = `${base}${s.file}`;
          void img
            .decode()
            .then(() => {
              el.style.setProperty('--scene-img', `url("${img.src}")`);
              el.classList.add('is-loaded');
            })
            .catch(() => loaded.delete(s.id)); // not decodable here: the gradients carry the page
          scIO.unobserve(e.target);
        }
      },
      { rootMargin: `${Math.round(innerHeight * 1.5)}px 0px` },
    );
    for (const s of SCENES) {
      const sec = document.getElementById(s.chapter);
      if (sec) scIO.observe(sec);
    }
  }

  // ── Scroll to the descent ─────────────────────────────────────────────────
  let tops: number[] = [];
  const cons = setupConsole(root);
  const measure = () => {
    cons?.measure();
    tops = sections.map((s) => s.getBoundingClientRect().top + scrollY);
  };
  let ticking = 0;
  function apply() {
    ticking = 0;
    const maxY = document.documentElement.scrollHeight - innerHeight;
    const p = progressAt(scrollY, tops, maxY);
    root.style.setProperty('--p', p.toFixed(4));
    for (const s of SCENES) sceneEls.get(s.id)?.style.setProperty('--o', sceneOpacity(s, p).toFixed(3));
    progress.set(p);
    cons?.drive();
  }
  // A scroll event fires once per frame at most; coalescing through one microtask keeps this off the frame loop.
  const onScroll = () => {
    if (ticking) return;
    ticking = 1;
    queueMicrotask(apply);
  };
  measure();
  apply();
  addEventListener('scroll', onScroll, { passive: true });
  new ResizeObserver(() => {
    measure();
    onScroll();
  }).observe(root);
  void document.fonts?.ready.then(() => {
    measure();
    onScroll();
  });
  addEventListener('load', () => {
    measure();
    onScroll();
  });
  // for the filmstrip and S4's checker: read, never required
  (window as unknown as { __story: unknown }).__story = { measure, apply, tops: () => tops, loaded: () => [...loaded] };
}
