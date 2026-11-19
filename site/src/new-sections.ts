/**
 * "See it move": a faux screen recording, played by a small timeline. The console window in the page is inert (like
 * the pixels of a video); this script is the "video". It holds one clock (performance.now, read in one
 * requestAnimationFrame loop) and a data-driven script of {t, ...} entries. render(T) paints the whole window for any
 * time T from that script, so scrubbing, looping and pausing are the same call. Only transform, opacity and a few
 * attribute switches change; the cursor and the load bar move by transform. Nothing starts by itself: the first press
 * on play starts it, it pauses when it leaves the screen, and reduced motion changes nothing but the CSS transitions.
 *
 * A real recording can replace it: when the figure carries data-mp4 (Motion.tsx, CLIP_FILE) the first press creates a
 * muted <video> and the same controls drive that instead.
 */

import './styles/clip.css';
import { ACTS, EXTRA, INIT, LEN, LOADS as LOADS_X, type State } from './clip/script.ts';
import { page } from './clip/views.ts';

type Step = { t: number; s: State };
type Move = { t0: number; t1: number; c: number; to: string; at: [number, number]; press: boolean };

// The script (clip/script.ts) turned into the lists the painter walks: every step in time order, every pointer move,
// every load. A press lands 0.12 s after the pointer arrives, so the target shows its hover state first.
const MOVES: Move[] = ACTS.map((a) => ({
  t0: a.t - 0.12 - (a.d ?? 0.9),
  t1: a.t - 0.12,
  c: a.t,
  to: a.to,
  at: a.at ?? [0.5, 0.5],
  press: a.k !== false,
}));
const STEPS: Step[] = [{ t: -1, s: INIT }, ...ACTS.flatMap((a) => (a.s ? [{ t: a.t, s: a.s }] : [])), ...EXTRA].sort(
  (x, y) => x.t - y.t,
);
const LOADS: [number, number][] = [
  ...ACTS.flatMap((a): [number, number][] => (a.l ? [[a.t, a.t + a.l]] : [])),
  ...LOADS_X,
];
const START: [number, number] = [0.9, 0.62]; // where the pointer rests on the poster, as a fraction of the window
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const SPEEDS = [1, 1.5, 2];

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const clamp = (x: number) => Math.min(1, Math.max(0, x));
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, '0')}`;
const pair = (v: string | undefined): [number, number] => {
  const [a = '', b = ''] = (v ?? '').split(/[-,]/);
  return [Number(a), b === '' ? Infinity : Number(b)];
};

type Conn = { saveData?: boolean };

function mountClip(fig: HTMLElement): void {
  const win = fig.querySelector<HTMLElement>('.cv');
  const stage = fig.querySelector<HTMLElement>('.cvp-stage');
  const ctl = fig.querySelector<HTMLElement>('.cvc');
  const bar = fig.querySelector<HTMLElement>('.cvc-bar');
  const fill = fig.querySelector<HTMLElement>('.cvc-fill');
  const now = fig.querySelector<HTMLElement>('[data-now]');
  const cur = fig.querySelector<HTMLElement>('.cv-cur');
  const load = fig.querySelector<HTMLElement>('.cv-load i');
  const pg = fig.querySelector<HTMLElement>('.cv-page');
  if (!win || !stage || !ctl || !bar || !fill || !now || !cur || !load || !pg) return;
  const len = Number(fig.dataset.len) || LEN;
  const saveData = (navigator as Navigator & { connection?: Conn }).connection?.saveData === true;

  // every page the clip visits, drawn once; the first frame (poster) was in the HTML
  pg.innerHTML = page(true);

  // reveal the controls
  ctl.hidden = false;
  for (const b of fig.querySelectorAll<HTMLButtonElement>('.cvp-play')) b.hidden = false;
  const playBtns = [...fig.querySelectorAll<HTMLButtonElement>('[data-play]')];
  const chapters = [...fig.querySelectorAll<HTMLButtonElement>('.cvc-ch button')];
  const spdBtn = fig.querySelector<HTMLButtonElement>('[data-speed]');

  const all = <T extends HTMLElement>(sel: string) => [...win.querySelectorAll<T>(sel)];
  const typed = all('[data-type]').map((el) => ({
    el,
    text: el.dataset.type ?? '',
    start: Number(el.dataset.start),
    dur: Number(el.dataset.dur),
    until: Number(el.dataset.until) || Infinity,
    f: el.dataset.f ?? '',
  }));
  const timed = all('[data-at]').map((el) => ({ el, w: pair(el.dataset.at) }));
  const draws = all('[data-draw]').map((el) => ({ el, w: pair(el.dataset.draw), p: -1 }));
  const spins = all('[data-spin]').map((el) => ({ el, w: pair(el.dataset.spin) }));
  const whens = all('[data-when]').map((el) => {
    const [k = '', v = ''] = (el.dataset.when ?? ':').split(':');
    return { el, k, vs: v.split(',') };
  });
  const hovers = new Map<string, HTMLElement[]>();
  for (const el of all('[data-h]')) hovers.set(el.dataset.h ?? '', [...(hovers.get(el.dataset.h ?? '') ?? []), el]);
  const navs = all('[data-n]');
  const views = all('[data-v]');
  const pages = all('[data-pg]');
  const tabs = all('.cv-tab');

  // where the pointer goes, in px inside the window. The target of the move in flight (and the one before it) is read
  // again every frame, because drawers open and lists grow while it travels; a target that is not laid out keeps its
  // last place.
  let home = { x: 0, y: 0 };
  const spots: ({ x: number; y: number } | undefined)[] = [];
  const spot = (i: number) => {
    const m = MOVES[i];
    const w = win.getBoundingClientRect();
    const e = m && hovers.get(m.to)?.[0];
    if (m && e && w.width) {
      const r = e.getBoundingClientRect();
      if (r.width) spots[i] = { x: r.left - w.left + r.width * m.at[0], y: r.top - w.top + r.height * m.at[1] };
    }
    return spots[i] ?? home;
  };
  const measure = () => {
    const w = win.getBoundingClientRect();
    if (w.width) home = { x: w.width * START[0], y: w.height * START[1] };
  };
  new ResizeObserver(() => {
    measure();
    paint(T, true);
  }).observe(win);

  let T = 0;
  let playing = false;
  let speed = 1;
  let last = 0;
  let raf = 0;
  let video: HTMLVideoElement | null = null;
  const state: State = {};
  let shownSec = -1;
  const sig = { cur: '', load: '' };

  function paint(t: number, force = false): void {
    // the state at t: every step up to t, in order
    const next: State = {};
    for (const s of STEPS) if (s.t <= t) Object.assign(next, s.s);
    for (const [k, v] of Object.entries(next)) {
      if (force || state[k] !== v) {
        state[k] = v;
        win!.dataset[k] = v;
      }
    }
    for (const w of whens) w.el.classList.toggle('on', w.vs.includes(state[w.k] ?? ''));
    for (const n of navs) n.classList.toggle('on', n.dataset.n === state.tab);
    for (const n of views) n.classList.toggle('on', n.dataset.v === state.tab);
    for (const n of pages) n.classList.toggle('on', n.dataset.pg === state.app);
    for (const n of tabs) n.classList.toggle('on', (n.dataset.h === 'tab-grafana') === (state.app === 'grafana'));
    for (const a of timed) a.el.classList.toggle('on', t >= a.w[0] && t < a.w[1]);
    for (const f of typed) {
      const n = t >= f.until ? 0 : Math.round(f.text.length * clamp((t - f.start) / f.dur));
      const s = f.text.slice(0, n);
      if (f.el.textContent !== s) f.el.textContent = s;
      f.el.classList.toggle('fc', state.foc === f.f);
    }
    for (const d of draws) {
      const p = Math.round(clamp((t - d.w[0]) / (d.w[1] - d.w[0])) * 200) / 200;
      if (p !== d.p) {
        d.p = p;
        d.el.style.setProperty('--d', String(p));
      }
    }
    for (const s of spins) {
      const f = t >= s.w[0] && t < s.w[1] ? (SPIN[Math.floor(t * 12) % SPIN.length] ?? '') : '';
      if (s.el.textContent !== f) s.el.textContent = f;
    }
    // the pointer: the last move that has begun, along a curve from where the one before it ended
    let i = -1;
    for (const [j, m] of MOVES.entries()) {
      if (t < m.t0) break;
      i = j;
    }
    let p = home;
    let rest = '';
    const m = MOVES[i];
    if (m) {
      const to = spot(i);
      const from = i > 0 ? spot(i - 1) : home;
      if (t < m.t1) {
        const k = ease((t - m.t0) / (m.t1 - m.t0));
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const bend = Math.min(0.22, 40 / Math.max(1, Math.hypot(dx, dy)) + 0.08) * (i % 2 ? 1 : -1);
        const cx = from.x + dx / 2 - dy * bend;
        const cy = from.y + dy / 2 + dx * bend;
        p = {
          x: (1 - k) ** 2 * from.x + 2 * (1 - k) * k * cx + k * k * to.x,
          y: (1 - k) ** 2 * from.y + 2 * (1 - k) * k * cy + k * k * to.y,
        };
      } else {
        p = to;
        if (t < m.c + 0.5) rest = m.to;
        else if (!MOVES[i + 1] || t < MOVES[i + 1]!.t0) rest = '';
      }
    }
    for (const [id, els] of hovers) for (const e of els) e.classList.toggle('hv', id === rest);
    let press = 0;
    for (const x of MOVES) if (x.press && t >= x.c && t - x.c < 0.5) press = (t - x.c) / 0.5;
    const cs = `${p.x.toFixed(1)}|${p.y.toFixed(1)}|${press.toFixed(2)}`;
    if (sig.cur !== cs) {
      sig.cur = cs;
      cur!.style.transform = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0)`;
      cur!.style.setProperty('--cp', press.toFixed(2));
      cur!.dataset.press = press > 0 && press < 0.18 ? '1' : '0';
    }
    let lp = -1;
    for (const [a, b] of LOADS) if (t >= a && t < b) lp = (t - a) / (b - a);
    const ls = lp.toFixed(2);
    if (sig.load !== ls) {
      sig.load = ls;
      win!.dataset.loading = lp >= 0 ? '1' : '0';
      load!.style.transform = `scaleX(${lp < 0 ? 0 : clamp(lp).toFixed(3)})`;
    }
    // the controls
    fill!.style.transform = `scaleX(${clamp(t / len).toFixed(4)})`;
    const sec = Math.floor(t);
    if (sec !== shownSec) {
      shownSec = sec;
      now!.textContent = mmss(t);
      bar!.setAttribute('aria-valuenow', String(sec));
      bar!.setAttribute('aria-valuetext', `${mmss(t)} / ${mmss(len)}`);
      let c = 0;
      chapters.forEach((b, i) => {
        if (Number(b.dataset.t) <= t) c = i;
      });
      chapters.forEach((b, i) =>
        i === c ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current'),
      );
    }
  }

  const tick = (ts: number) => {
    raf = 0;
    if (!playing) return;
    if (video) T = video.currentTime;
    else {
      T += ((ts - last) / 1000) * speed;
      last = ts;
      if (T >= len) T -= len; // a video on loop: back to the first frame, still playing
    }
    paint(T);
    raf = requestAnimationFrame(tick);
  };
  const setPlaying = (on: boolean) => {
    playing = on;
    fig.dataset.playing = String(on);
    for (const b of playBtns) b.setAttribute('aria-label', (on ? fig.dataset.labelPause : fig.dataset.labelPlay) ?? '');
    if (on) {
      fig.dataset.started = 'true';
      last = performance.now();
      raf ||= requestAnimationFrame(tick);
      if (video) void video.play().catch(() => setPlaying(false));
    } else video?.pause();
  };
  const start = () => {
    const mp4 = fig.dataset.mp4;
    if (!video && mp4 && !saveData) {
      video = document.createElement('video');
      video.className = 'cvp-video';
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.setAttribute('aria-hidden', 'true');
      if (fig.dataset.webm)
        video.insertAdjacentHTML('beforeend', `<source src="${fig.dataset.webm}" type="video/webm">`);
      video.insertAdjacentHTML('beforeend', `<source src="${mp4}" type="video/mp4">`);
      stage!.prepend(video);
      fig.dataset.video = 'true';
    }
  };
  const seek = (t: number) => {
    T = Math.min(len - 0.001, Math.max(0, t));
    if (video) video.currentTime = T;
    last = performance.now();
    paint(T);
    // a drawer or a list that was mid-transition when the pointer was placed: place it again once they have settled
    if (!playing) setTimeout(() => paint(T), 450);
  };
  const toggle = () => {
    start();
    setPlaying(!playing);
  };

  for (const b of playBtns)
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });
  stage.addEventListener('click', toggle); // like a video: a press on the picture plays and pauses

  // the progress bar: press or drag to scrub, arrow keys step
  const at = (e: PointerEvent) => {
    const r = bar.getBoundingClientRect();
    seek(clamp((e.clientX - r.left) / r.width) * len);
  };
  bar.addEventListener('pointerdown', (e) => {
    bar.setPointerCapture(e.pointerId);
    at(e);
    bar.dataset.drag = 'true';
  });
  bar.addEventListener('pointermove', (e) => {
    if (bar.dataset.drag) at(e);
  });
  const end = () => delete bar.dataset.drag;
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('keydown', (e) => {
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowUp: 1,
      ArrowLeft: -1,
      ArrowDown: -1,
      PageUp: 5,
      PageDown: -5,
    };
    if (e.key in step) seek(T + (step[e.key] ?? 0));
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(len - 0.1);
    else return;
    e.preventDefault();
  });
  spdBtn?.addEventListener('click', () => {
    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1;
    spdBtn.textContent = `${speed}×`;
    if (video) video.playbackRate = speed;
  });
  for (const b of chapters) b.addEventListener('click', () => seek(Number(b.dataset.t)));

  new IntersectionObserver((es) => {
    if (es.some((e) => !e.isIntersecting) && playing) setPlaying(false);
  }).observe(fig);

  measure();
  paint(0, true);
  setTimeout(() => paint(T, true), 450);
  win.dataset.ready = 'true';
}

export function mountNewSections(fig: HTMLElement): void {
  mountClip(fig);
}
