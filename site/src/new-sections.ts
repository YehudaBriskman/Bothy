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

type State = Record<string, string>;
type Step = { t: number; s: State };
type Move = { t0: number; t1: number; to: string; at?: [number, number] };

/** The clip, in seconds. Chapters (Services 0, Notes 7, Health 14, Install 20) are in i18n/new-sections-en.ts. */
const STEPS: Step[] = [
  {
    t: 0,
    s: {
      tab: 'services',
      hover: '',
      focus: '',
      filt: '0',
      hl: '',
      svc: 'starting',
      file: '0',
      pill: '0',
      stop: '0',
      mod: '0',
    },
  },
  { t: 2.0, s: { focus: 'filter' } },
  { t: 3.3, s: { filt: '1', focus: '' } },
  { t: 4.3, s: { hl: 'wiki' } },
  { t: 5.7, s: { svc: 'up' } },
  { t: 6.6, s: { hl: '', filt: '0' } },
  { t: 7.9, s: { hover: 'files' } },
  { t: 8.1, s: { tab: 'files', hover: '' } },
  { t: 9.9, s: { file: '1' } },
  { t: 11.8, s: { pill: '1' } },
  { t: 13.5, s: { pill: '0' } },
  { t: 14.9, s: { hover: 'health' } },
  { t: 15.1, s: { tab: 'health', hover: '' } },
  { t: 16.8, s: { hl: 'tile' } },
  { t: 18.0, s: { stop: '1' } },
  { t: 19.4, s: { hl: '' } },
  { t: 20.9, s: { hover: 'modules' } },
  { t: 21.1, s: { tab: 'modules', hover: '' } },
  { t: 22.7, s: { focus: 'cmd' } },
  { t: 25.0, s: { focus: '' } },
  { t: 26.7, s: { mod: '1' } },
];
const MOVES: Move[] = [
  { t0: 0.8, t1: 1.9, to: '.f-filter', at: [0.4, 0.5] },
  { t0: 3.4, t1: 4.3, to: '[data-row=wiki] td', at: [0.3, 0.5] },
  { t0: 7.0, t1: 7.9, to: '[data-n=files]' },
  { t0: 8.9, t1: 9.8, to: '[data-f=first]', at: [0.4, 0.5] },
  { t0: 10.6, t1: 11.7, to: '.nv-pill', at: [0.5, 0.6] },
  { t0: 14.0, t1: 14.9, to: '[data-n=health]' },
  { t0: 15.8, t1: 16.7, to: '[data-tile=services]', at: [0.5, 0.35] },
  { t0: 18.3, t1: 19.3, to: '[data-tile=backup]', at: [0.6, 0.7] },
  { t0: 20.0, t1: 20.9, to: '[data-n=modules]' },
  { t0: 21.8, t1: 22.6, to: '.cmd', at: [0.2, 0.5] },
  { t0: 26.9, t1: 27.9, to: '.cv-body', at: [0.92, 0.9] },
];
const CLICKS = [2.0, 4.4, 8.0, 9.9, 15.0, 21.0, 22.7];
const LOADS: [number, number][] = [
  [4.5, 5.7],
  [8.1, 8.7],
  [15.1, 15.6],
  [17.4, 18.0],
  [21.1, 21.6],
  [25.1, 26.6],
];
const START: [number, number] = [0.88, 0.5]; // where the cursor rests on the poster, as a fraction of the window

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const clamp = (x: number) => Math.min(1, Math.max(0, x));
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, '0')}`;

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
  if (!win || !stage || !ctl || !bar || !fill || !now || !cur || !load) return;
  const len = Number(fig.dataset.len) || 28;
  const saveData = (navigator as Navigator & { connection?: Conn }).connection?.saveData === true;

  // reveal the controls
  ctl.hidden = false;
  for (const b of fig.querySelectorAll<HTMLButtonElement>('.cvp-play')) b.hidden = false;
  const playBtns = [...fig.querySelectorAll<HTMLButtonElement>('[data-play]')];
  const chapters = [...fig.querySelectorAll<HTMLButtonElement>('.cvc-ch button')];

  const typed = [...win.querySelectorAll<HTMLElement>('[data-type]')].map((el) => ({
    el,
    text: el.dataset.type ?? '',
    start: Number(el.dataset.start),
    dur: Number(el.dataset.dur),
  }));
  const timed = [...win.querySelectorAll<HTMLElement>('[data-at]')].map((el) => ({ el, at: Number(el.dataset.at) }));
  const whens = [...win.querySelectorAll<HTMLElement>('[data-when]')].map((el) => {
    const [k = '', v = ''] = (el.dataset.when ?? ':').split(':');
    return { el, k, v };
  });

  // where the cursor goes, in px inside the window; measured again when the window changes size
  let spots: { x: number; y: number }[] = [];
  let home = { x: 0, y: 0 };
  const measure = () => {
    const w = win.getBoundingClientRect();
    if (!w.width) return;
    home = { x: w.width * START[0], y: w.height * START[1] };
    spots = MOVES.map((m) => {
      const e = win.querySelector(m.to);
      if (!e) return home;
      const r = e.getBoundingClientRect();
      const [fx, fy] = m.at ?? [0.5, 0.5];
      return { x: r.left - w.left + r.width * fx, y: r.top - w.top + r.height * fy };
    });
  };
  new ResizeObserver(() => {
    measure();
    paint(T, true);
  }).observe(win);

  let T = 0;
  let playing = false;
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
    for (const w of whens) w.el.classList.toggle('on', state[w.k] === w.v);
    for (const a of timed) a.el.classList.toggle('on', t >= a.at);
    for (const f of typed) {
      const n = Math.round(f.text.length * clamp((t - f.start) / f.dur));
      const s = f.text.slice(0, n);
      if (f.el.textContent !== s) f.el.textContent = s;
    }
    // the cursor: the last move that has begun, eased from where the one before it ended
    let p = home;
    for (const [i, m] of MOVES.entries()) {
      if (t < m.t0) break;
      const from = p;
      p = spots[i] ?? home;
      if (t < m.t1) {
        const k = ease((t - m.t0) / (m.t1 - m.t0));
        p = { x: from.x + (p.x - from.x) * k, y: from.y + (p.y - from.y) * k };
        break;
      }
    }
    let press = 0;
    for (const c of CLICKS) if (t >= c && t - c < 0.5) press = (t - c) / 0.5;
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
      T += (ts - last) / 1000;
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
  for (const b of chapters) b.addEventListener('click', () => seek(Number(b.dataset.t)));

  new IntersectionObserver((es) => {
    if (es.some((e) => !e.isIntersecting) && playing) setPlaying(false);
  }).observe(fig);

  measure();
  paint(0, true);
  win.dataset.ready = 'true';
}

export function mountNewSections(fig: HTMLElement): void {
  mountClip(fig);
}
