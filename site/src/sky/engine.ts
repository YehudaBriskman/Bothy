// The live sky: raw WebGL2, no dependencies, no request to another origin. Ported from public/sky-spike/sky.js
// (owner-approved look: clouds, sun, moon, horizon glow, lit words, hour table, wake physics). What changed is the
// frame around it, not the look: it draws into the hero instead of the page, it is a lazy island, and it is
// guarded (capability probe, Save-Data, off-screen and hidden stop, governor down to the still).
//
// Without WebGL, without script, on touch or a narrow screen, or with Save-Data, the CSS still (styles/sky-still.css)
// is the sky; this module then only picks that still's hour class and tints it.
import { bodies, fmt, localHour, sample, type Bodies, type Grade } from './keys.ts';
import { DEPTH, FS, VS } from './shader.ts';
import { cameraAt, effectiveHour, stageAt } from '../story/camera.ts';
import { progress } from '../story/progress.ts';

const PHOTOS = ['day', 'dusk', 'night'] as const;
const GOV = [1, 0.85, 0.72, 0.6];
const sm01 = (t: number) => {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const rgb = (a: number[]) => `rgb(${a.map((x) => Math.round(Math.min(255, Math.max(0, x)))).join(',')})`;

export interface SkyOptions {
  /** The `.sky-still` layer (the page-wide, fixed backdrop); the canvas is appended inside it. */
  layer: HTMLElement;
  /** The story root: receives the hour's ground colour (`--ground-rgb`) and the scrim variables for the whole page. */
  story: HTMLElement;
  /** The hero section: receives `is-lit`, `has-gl` and the scrim variables. */
  section: HTMLElement;
  /** The words the sun and moon light (headline, line, lede). */
  lit: HTMLElement[];
  /** Where the photographs are served, ending in a slash (`/sky/`, or under the site base). */
  photoBase: string;
  /** Called whenever the hour (or the follow-the-clock flag) changes. */
  onHour: (s: { hour: number; live: boolean; name: string; sunUp: boolean }) => void;
  /** Called when the live sky stops and the CSS still takes over. */
  onStill: () => void;
  debugEl: HTMLElement | null;
}

export interface Sky {
  mode: () => 'webgl' | 'still';
  setHour: (h: number) => void;
  now: () => void;
  togglePause: () => boolean;
  nudge: (dx: number, dy: number) => void;
  /** True when the page animates at all (false for prefers-reduced-motion and for the still). */
  animated: () => boolean;
  /** The descent: scroll progress 0..1 (the engine eases toward it inside its own frame loop). */
  setScroll: (p: number) => void;
}

export function startSky(o: SkyOptions): Sky {
  const q = new URLSearchParams(location.search);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const noHover = matchMedia('(hover: none)').matches || matchMedia('(max-width: 720px)').matches;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  const saveData = conn?.saveData === true;
  const debug = q.get('debug');
  const manual = q.get('manual') === '1'; // test harness: no rAF loop; window.__sky.frame(dt) steps and draws
  const forceMix = ['day', 'dusk', 'night'].indexOf(q.get('mix') ?? '');
  const raysOn = q.get('rays') === '1'; // opt-in light shafts (off: the clouds stay as photographed)
  const textLight = q.get('light') !== '0'; // ?light=0: the words are not lit by the sun or moon

  const state = {
    live: true,
    hour: 12,
    eff: 12, // the hour the sky shows: `hour` advanced toward night by the descent
    p: 0, // eased descent progress, drawn
    pT: 0, // descent progress, wanted
    paused: false,
    time: 0,
    lean: [0, 0] as number[],
    target: [0, 0] as number[],
    samples: [] as { x: number; y: number; t: number; dx: number; dy: number; sp: number }[],
    last: null as number | null,
    arrive0: null as number | null,
    scale: 1,
    gov: 1,
    bytes: 0,
    fmt: ['avif', 'webp'],
    dirty: true,
    onscreen: true,
    imgAspect: 0,
    stillName: '',
  };

  const forced = q.get('hour');
  if (forced !== null && forced.trim() !== '' && Number.isFinite(+forced)) {
    state.live = false;
    state.hour = ((+forced % 24) + 24) % 24;
  } else state.hour = localHour();
  let cur: Grade = sample(state.hour);
  let bod: Bodies = bodies(state.hour);

  const { layer, section } = o;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  let gl: WebGL2RenderingContext | null = null;
  let stillMode = false;

  // ------------------------------------------------------------ light (sun, moon) and the lit words
  const lit = { x: 0.5, y: 0.2, k: 0, col: [1, 1, 1], moon: 0, sunY: 0.8, moonY: 0.8, sunK: 0, moonK: 0, illum: 0.5 };
  function computeLight() {
    const horizon = 0.8;
    const sunY = horizon - Math.max(bod.sun.elev, -0.15) * 0.64;
    const sunK = clamp01((bod.sun.elev + 0.04) / 0.1);
    const moonY = horizon - Math.max(bod.moon.elev, -0.15) * 0.62;
    const illum = (1 - Math.cos(bod.phase * 2 * Math.PI)) / 2;
    const moonK = clamp01((bod.moon.elev + 0.02) / 0.12) * cur.moonK;
    Object.assign(lit, { sunY, moonY, sunK, moonK, illum });
    const moonS = moonK * (0.35 + 0.65 * illum);
    if (sunK >= moonS) Object.assign(lit, { x: bod.sun.x, y: sunY, k: sunK, moon: 0, col: cur.sunCol });
    else Object.assign(lit, { x: bod.moon.x, y: moonY, k: moonS, moon: 1, col: [0.72, 0.82, 1] });
  }

  // The words are lit by the same light: a gradient fill warmer and brighter on the side facing it, a thin rim on that
  // edge and a soft shadow on the far side. The glyphs stay solid ink, never gradient-on-transparent at the floor.
  const canClip = typeof CSS !== 'undefined' && !!CSS.supports && CSS.supports('background-clip', 'text');
  let litSig = '';
  let inkDark = false;
  function lightText() {
    if (!canClip || !textLight) return;
    if (inkDark) {
      // dark ink on a bright sky: the lit-gradient model is for light letters, so the words are plain solid ink here
      if (section.classList.contains('is-lit')) {
        section.classList.remove('is-lit');
        for (const el of o.lit) {
          el.style.backgroundImage = '';
          el.style.filter = '';
        }
      }
      litSig = '';
      return;
    }
    const cr = layer.getBoundingClientRect();
    if (!cr.width) return;
    const ax = state.lean[0]! * 0.05; // the pointer leans the light a little, so it sweeps across the words
    const ay = state.lean[1]! * 0.03;
    const lx = cr.x + (lit.x + ax) * cr.width;
    const ly = cr.y + (lit.y + ay) * cr.height;
    const first = o.lit[0]?.getBoundingClientRect();
    const sig = `${Math.round((lx - (first?.x ?? 0)) / 3)},${Math.round((ly - (first?.y ?? 0)) / 3)},${Math.round(lit.k * 40)},${lit.moon}`;
    if (sig === litSig) return;
    litSig = sig;
    section.classList.add('is-lit'); // the words turn transparent only once a fill is in place
    const k = lit.k;
    const ink = [247, 245, 239];
    const warm = lit.col.map((c) => 255 * Math.min(1, c));
    const near = ink.map((v, i) => Math.round(v + (Math.min(255, warm[i]! * 1.02) - v) * 0.4 * k));
    const far = [ink[0]! * (1 - 0.14 * k), ink[1]! * (1 - 0.12 * k), ink[2]! * (1 - 0.09 * k)].map(Math.round);
    for (const el of o.lit) {
      const r = el.getBoundingClientRect();
      const px = lx - r.x;
      const py = ly - r.y;
      const dx = px - r.width / 2;
      const dy = py - r.height / 2;
      const dist = Math.hypot(dx, dy) || 1;
      const R = dist + 0.6 * r.width;
      const n0 = Math.max(0, Math.min(100, ((dist - 0.5 * r.width) / R) * 100));
      const n1 = Math.max(n0 + 1, Math.min(100, ((dist + 0.5 * r.width) / R) * 100));
      el.style.backgroundImage = `radial-gradient(circle ${R.toFixed(0)}px at ${px.toFixed(0)}px ${py.toFixed(0)}px, rgb(${near}) ${n0.toFixed(1)}%, rgb(${far}) ${n1.toFixed(1)}%)`;
      const big = el.tagName === 'H1' ? 1 : 0.5;
      const ox = (dx / dist) * 1.7 * big;
      const oy = (dy / dist) * 1.7 * big;
      el.style.filter = `drop-shadow(${ox.toFixed(2)}px ${oy.toFixed(2)}px 0.7px rgba(${warm.map(Math.round)},${(0.8 * k).toFixed(2)})) drop-shadow(${(-ox * 1.5).toFixed(2)}px ${(3 - oy).toFixed(2)}px ${14 * big + 4}px rgba(0,0,0,0.34))`;
    }
  }

  /** The hour the page is graded by right now: the visitor's hour, run on toward night by the descent. */
  const effOf = () => (reduced ? state.hour : effectiveHour(state.hour, state.p));
  let lastEff = -1;
  function applyHour(notify = true) {
    state.eff = effOf();
    lastEff = state.eff;
    cur = sample(state.eff);
    if (forceMix >= 0) cur.w = [0, 1, 2].map((i) => (i === forceMix ? 1 : 0));
    bod = bodies(state.eff);
    layer.style.setProperty('--sky-top', rgb(cur.top));
    layer.style.setProperty('--sky-bot', rgb(cur.bot));
    // Ink and scrim for the hero words. A bright sky (day, and the warm hours either side) gets dark ink on a pale,
    // sky-coloured scrim; the rest keep the approved light ink on a dark one. Both scrims are feathered on all four
    // edges (sky.css), and the strength rises with the hour's own scrim value, so the floor holds at every hour.
    const luma = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    inkDark = ((luma(cur.top) + luma(cur.bot)) / 2) * Math.min(1.1, cur.exp) > 999; // light ink at every hour: the sky grade (uFx) darkens the sky under the words instead
    section.dataset.ink = inkDark ? 'dark' : 'light';
    section.style.setProperty('--scrim-a', (inkDark ? 0.9 : Math.min(0.9, 0.62 + cur.scrim * 0.6)).toFixed(3));
    section.style.setProperty(
      '--scrim-rgb',
      (inkDark ? cur.bot.map((x) => Math.round(x * 0.25 + 190)) : cur.top.map((x) => Math.round(x * 0.4))).join(' '),
    );
    // the page's own ground (veil, glass, scrims) is this hour's sky, darkened: hue-matched at every scroll position
    o.story.style.setProperty('--ground-rgb', cur.top.map((x) => Math.round(x * 0.2 + 6)).join(' '));
    o.story.style.setProperty('--glass-rgb', cur.top.map((x) => Math.round(x * 0.16 + 5)).join(' '));
    // the capsule bar lives outside the story element: it reads the same tint from the root
    document.documentElement.style.setProperty('--glass-rgb', cur.top.map((x) => Math.round(x * 0.16 + 5)).join(' '));
    // the scene backdrops (chapters 3 to 5) are graded by the same row: its tint, saturation and exposure
    const mx = Math.max(...cur.gain);
    const tk = Math.min(1, Math.sqrt(cur.exp) * 1.1);
    o.story.style.setProperty('--scene-tint', rgb(cur.gain.map((g) => (g / mx) * tk * 255)));
    o.story.style.setProperty('--scene-sat', cur.sat.toFixed(3));
    o.story.style.setProperty('--scene-exp', Math.min(1.15, Math.max(0.35, cur.exp)).toFixed(3));
    computeLight();
    litSig = '';
    lightText();
    state.dirty = true;
    if (stillMode) updateStill();
    if (notify) {
      const base = state.eff === state.hour ? cur : sample(state.hour);
      o.onHour({ hour: state.hour, live: state.live, name: base.name, sunUp: bodies(state.hour).sun.elev > 0.02 });
    }
  }
  /** The descent moved: regrade only when the clock it implies has moved enough to show. */
  function regrade() {
    if (Math.abs(effOf() - lastEff) > 0.02) applyHour(false);
  }

  // ------------------------------------------------------------ the CSS still (no WebGL, touch, narrow, Save-Data)
  function updateStill() {
    // sky-still.css picks the photograph from this hour class; the multiply tint is the same grade as the shader's
    layer.dataset.hour = cur.name;
    const mx = Math.max(...cur.gain);
    const k = Math.min(1, Math.sqrt(cur.exp) * 1.1);
    layer.style.setProperty('--sky-tint', rgb(cur.gain.map((g) => (g / mx) * k * 255)));
    layer.classList.add('is-tinted');
  }
  function enterStill() {
    if (stillMode) return;
    stillMode = true;
    canvas.classList.remove('on');
    section.classList.remove('has-gl');
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    updateStill();
    o.onStill();
  }

  // ------------------------------------------------------------ GL
  const U: Record<string, WebGLUniformLocation | null> = {};
  const tex: (WebGLTexture | null)[] = [null, null, null];
  const loaded = [false, false, false];
  const loading = [false, false, false];

  function initGL(): boolean {
    gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: manual,
    });
    if (!gl) return false;
    const g = gl;
    const sh = (type: number, src: string) => {
      const s = g.createShader(type)!;
      g.shaderSource(s, src);
      g.compileShader(s);
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) || 'shader');
      return s;
    };
    try {
      const program = g.createProgram()!;
      g.attachShader(program, sh(g.VERTEX_SHADER, VS));
      g.attachShader(program, sh(g.FRAGMENT_SHADER, FS));
      g.linkProgram(program);
      if (!g.getProgramParameter(program, g.LINK_STATUS)) throw new Error('link');
      g.useProgram(program);
      for (const n of [
        ...['uT0', 'uT1', 'uT2', 'uW', 'uD0', 'uD1', 'uD2', 'uRes', 'uCover', 'uZoom', 'uTime', 'uArrive'],
        ...['uDebug', 'uAspect', 'uLean', 'uWake', 'uGain', 'uLift', 'uSunCol', 'uSat', 'uExp', 'uStars'],
        ...['uGlow', 'uHaze', 'uSun', 'uMoon', 'uText', 'uLight', 'uLightCol', 'uFx', 'uCam', 'uSea', 'uSeaCol'],
      ])
        U[n] = g.getUniformLocation(program, n);
    } catch (e) {
      console.warn('sky: shader failed, using the still', e);
      return false;
    }
    g.bindVertexArray(g.createVertexArray());
    for (let i = 0; i < 3; i++) {
      tex[i] = g.createTexture();
      g.activeTexture(g.TEXTURE0 + i);
      g.bindTexture(g.TEXTURE_2D, tex[i] ?? null);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, 1, 1, 0, g.RGBA, g.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      for (const [p, v] of [
        [g.TEXTURE_MIN_FILTER, g.LINEAR],
        [g.TEXTURE_MAG_FILTER, g.LINEAR],
        [g.TEXTURE_WRAP_S, g.MIRRORED_REPEAT],
        [g.TEXTURE_WRAP_T, g.MIRRORED_REPEAT],
      ] as const)
        g.texParameteri(g.TEXTURE_2D, p, v);
      g.uniform1i(U['uT' + i]!, i);
    }
    g.uniform3fv(U.uD0!, DEPTH[0]);
    g.uniform3fv(U.uD1!, DEPTH[1]);
    g.uniform3fv(U.uD2!, DEPTH[2]);
    g.uniform1f(U.uZoom!, 1.07);
    g.uniform4f(U.uCam!, 0, 1, 0, 0);
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      enterStill();
    });
    return true;
  }

  async function loadPhoto(i: number) {
    if (!gl || loaded[i] || loading[i]) return;
    loading[i] = true;
    for (const ext of [...state.fmt]) {
      try {
        // an <img>, not fetch(): it shares the cache entry of the CSS still, so the first photograph is one download
        const url = `${o.photoBase}${PHOTOS[i]}-desk.${ext}`;
        const img = new Image();
        img.src = url;
        await img.decode();
        const bm = await createImageBitmap(img);
        state.bytes +=
          (performance.getEntriesByName(new URL(url, location.href).href)[0] as PerformanceResourceTiming | undefined)
            ?.encodedBodySize ?? 0;
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, tex[i]!);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bm);
        state.imgAspect = bm.width / bm.height;
        bm.close?.();
        loaded[i] = true;
        state.dirty = true;
        break;
      } catch {
        if (ext === 'avif') state.fmt = ['webp']; // this browser cannot decode AVIF; do not try again
      }
    }
    loading[i] = false;
    if (!loaded[i] && !state.fmt.length) enterStill();
  }

  /** Ask for every photograph this hour's mix needs (and, when scrubbing, the neighbours). */
  function want(all: boolean) {
    for (let i = 0; i < 3; i++) if ((all || cur.w[i]! > 0.004) && !loaded[i]) void loadPhoto(i);
  }

  // ------------------------------------------------------------ loop
  const dpr = () => Math.min(window.devicePixelRatio || 1, 1.5) * (innerWidth < 900 ? 0.85 : 1);
  // Capability probe, first half: a low-core or low-memory device starts one governor step down.
  const nav = navigator as Navigator & { deviceMemory?: number };
  if ((nav.hardwareConcurrency ?? 8) <= 2 || (nav.deviceMemory ?? 8) <= 2) state.gov = GOV[1]!;

  function resize() {
    if (!gl) return;
    state.scale = dpr() * state.gov;
    const w = Math.max(2, Math.round(canvas.clientWidth * state.scale));
    const h = Math.max(2, Math.round(canvas.clientHeight * state.scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      state.dirty = true;
    }
  }

  function draw() {
    if (!gl || gl.isContextLost()) return;
    resize();
    want(false);
    const w = [0, 0, 0];
    for (let i = 0; i < 3; i++) if (loaded[i]) w[i] = cur.w[i]!;
    let sum = w[0]! + w[1]! + w[2]!;
    if (sum < 1e-4) {
      // nothing this hour needs is loaded yet: show whatever is, until it arrives
      for (let i = 0; i < 3; i++)
        if (loaded[i]) {
          w[i] = 1;
          break;
        }
      sum = w[0]! + w[1]! + w[2]!;
    }
    if (sum < 1e-4) return;
    for (let i = 0; i < 3; i++) w[i] = w[i]! / sum;
    if (state.arrive0 === null) state.arrive0 = state.time;
    const ar = reduced ? 1 : Math.min(1, (state.time - state.arrive0) / 3.4);
    const arrive = 1 - Math.pow(1 - ar, 3);
    const aspect = canvas.width / canvas.height;
    const ia = state.imgAspect || 1.6;
    gl.uniform3fv(U.uW!, w);
    gl.uniform2f(U.uRes!, canvas.width, canvas.height);
    gl.uniform2f(U.uCover!, aspect > ia ? 1 : aspect / ia, aspect > ia ? ia / aspect : 1);
    gl.uniform1f(U.uAspect!, aspect);
    gl.uniform1f(U.uTime!, reduced ? 0 : state.time);
    gl.uniform1f(U.uArrive!, arrive);
    gl.uniform1f(U.uDebug!, debug === 'depth' ? 1 : 0);
    gl.uniform2f(U.uLean!, state.lean[0]!, state.lean[1]!);
    const wk = new Float32Array(40);
    const ss = state.samples;
    for (let i = 0; i < 10; i++) {
      const s = ss[ss.length - 1 - i];
      if (!s) continue;
      const age = state.time - s.t;
      // a quick rise, then a monotone settle over 1.4 s: it never swings past rest
      const att = Math.min(1, age / 0.12);
      const k = att * att * (3 - 2 * att) * (1 - sm01((age - 0.12) / 1.28));
      wk[i * 4] = s.x;
      wk[i * 4 + 1] = s.y;
      wk[i * 4 + 2] = s.dx * s.sp * k;
      wk[i * 4 + 3] = s.dy * s.sp * k;
    }
    gl.uniform4fv(U.uWake!, wk);
    gl.uniform3fv(U.uGain!, cur.gain);
    gl.uniform3fv(U.uLift!, cur.lift);
    gl.uniform3fv(U.uSunCol!, cur.sunCol);
    gl.uniform1f(U.uSat!, cur.sat);
    gl.uniform1f(U.uExp!, cur.exp);
    gl.uniform1f(U.uStars!, cur.stars);
    const cam = reduced ? cameraAt(0) : cameraAt(state.p);
    gl.uniform4f(U.uCam!, cam.pan, cam.zoom, cam.cross, cam.rise);
    gl.uniform1f(U.uSea!, cam.sea);
    gl.uniform3f(
      U.uSeaCol!,
      (cur.bot[0]! / 255) * 1.08 + cur.glow[0]! * cur.glow[3]! * 0.2,
      (cur.bot[1]! / 255) * 1.08 + cur.glow[1]! * cur.glow[3]! * 0.2,
      (cur.bot[2]! / 255) * 1.08 + cur.glow[2]! * cur.glow[3]! * 0.2,
    );
    gl.uniform4f(U.uGlow!, cur.glow[0]!, cur.glow[1]!, cur.glow[2]!, cur.glow[3]! * cam.glow);
    gl.uniform4fv(U.uHaze!, cur.haze);
    gl.uniform3f(U.uSun!, bod.sun.x, lit.sunY - cam.pan * 0.8, lit.sunK);
    gl.uniform4f(U.uMoon!, bod.moon.x, lit.moonY - cam.pan * 0.8, lit.moonK, bod.phase);
    gl.uniform4f(U.uLight!, lit.x, lit.y, lit.k, lit.moon);
    gl.uniform3fv(U.uLightCol!, lit.col);
    // the words' brightness ceiling (display luma) and how hard it bites, from this hour's scrim value
    gl.uniform3f(U.uFx!, raysOn ? 1 : 0, 0.26, inkDark ? 0 : Math.min(0.99, 0.3 + cur.scrim * 1.6));
    lightText();
    // the words' box in canvas uv: the sun and moon dim behind it
    const cr = layer.getBoundingClientRect();
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const el of o.lit) {
      const r = el.getBoundingClientRect();
      x0 = Math.min(x0, r.left);
      y0 = Math.min(y0, r.top);
      x1 = Math.max(x1, r.right);
      y1 = Math.max(y1, r.bottom);
    }
    if (cr.width && x1 > x0)
      gl.uniform4f(
        U.uText!,
        ((x0 + x1) / 2 - cr.x) / cr.width,
        ((y0 + y1) / 2 - cr.y) / cr.height,
        (x1 - x0) / 2 / cr.width,
        (y1 - y0) / 2 / cr.height,
      );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!canvas.classList.contains('on')) canvas.classList.add('on');
    state.dirty = false;
  }

  const animating = () => !reduced && !state.paused && !stillMode;
  let raf = 0;
  const ft: number[] = []; // frame times for the governor
  let govAt = 0;

  function step(dt: number) {
    state.time += dt;
    if (!reduced && state.p !== state.pT) {
      // the camera follows the scroll with a short ease, so a flick of the wheel is a glide, not a jump
      state.p += (state.pT - state.p) * (1 - Math.exp(-dt / 0.16));
      if (Math.abs(state.pT - state.p) < 0.0004) state.p = state.pT;
      regrade();
    }
    const a = 1 - Math.exp(-dt / 0.4); // lean follows the pointer with a ~0.4 s smoothing
    state.lean[0]! += (state.target[0]! - state.lean[0]!) * a;
    state.lean[1]! += (state.target[1]! - state.lean[1]!) * a;
    while (state.samples.length && state.time - state.samples[0]!.t > 1.45) state.samples.shift();
  }

  // Capability probe, second half: the governor. Below ~38 fps over 45 frames, step the resolution down; at the lowest
  // step and still slow (under ~22 fps), the effect switches off and the CSS still takes over.
  function govern(now: number) {
    if (ft.length < 45 || now - govAt < 2500 || state.arrive0 === null || state.time - state.arrive0 < 4) return;
    const avg = ft.reduce((a, b) => a + b, 0) / ft.length;
    const i = GOV.indexOf(state.gov);
    if (avg > 0.026 && i < GOV.length - 1) {
      state.gov = GOV[i + 1]!;
      govAt = now;
      ft.length = 0;
      state.dirty = true;
    } else if (avg > 0.045 && i >= GOV.length - 1) enterStill();
  }

  function frame(now: number) {
    raf = 0;
    if (!animating()) return;
    if (state.last !== null) {
      const raw = (now - state.last) / 1000;
      step(Math.min(0.05, raw));
      ft.push(raw);
      if (ft.length > 45) ft.shift();
      govern(now);
      if (stillMode) return;
    }
    state.last = now;
    draw();
    dbgUpdate(now);
    schedule();
  }

  function schedule() {
    if (raf || manual) return;
    if (animating() && state.onscreen && !document.hidden) raf = requestAnimationFrame(frame);
  }
  function kick() {
    // draw once if something changed while not animating (dial, pause, resize), and restart the loop if due
    if (!gl || stillMode) return;
    if (!animating() || manual) draw();
    state.last = null;
    schedule();
  }

  // ------------------------------------------------------------ pointer
  let prev: { x: number; y: number; t: number } | null = null;
  function onMove(e: PointerEvent) {
    if (state.paused || (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen')) return;
    const cr = layer.getBoundingClientRect();
    if (!cr.width) return;
    const x = (e.clientX - cr.x) / cr.width;
    const y = (e.clientY - cr.y) / cr.height;
    state.target[0] = clamp01(x) * 2 - 1;
    state.target[1] = clamp01(y) * 2 - 1;
    if (prev) {
      const dtp = Math.max(1 / 120, state.time - prev.t);
      const px = (x - prev.x) * cr.width;
      const py = (y - prev.y) * cr.height;
      const dist = Math.hypot(px, py);
      if (dist > 3 && state.time - prev.t >= 0.03) {
        const speed = dist / cr.height / dtp; // canvas heights per second
        state.samples.push({
          x,
          y,
          t: state.time,
          dx: px / dist,
          dy: py / dist,
          sp: Math.pow(Math.min(1, speed / 1.2), 0.8),
        });
        if (state.samples.length > 10) state.samples.shift();
        prev = { x, y, t: state.time };
      }
    } else prev = { x, y, t: state.time };
  }
  function onLeave() {
    state.target[0] = state.target[1] = 0;
    prev = null;
  }

  // The keyboard's way to the same lean and wake: a push in a direction that settles by itself.
  let nudgeTimer = 0;
  function nudge(dx: number, dy: number) {
    if (stillMode || reduced || state.paused) return;
    state.target[0] = Math.max(-1, Math.min(1, dx * 0.9));
    state.target[1] = Math.max(-1, Math.min(1, dy * 0.9));
    const len = Math.hypot(dx, dy) || 1;
    state.samples.push({ x: 0.5 - dx * 0.2, y: 0.5 - dy * 0.2, t: state.time, dx: dx / len, dy: dy / len, sp: 0.8 });
    if (state.samples.length > 10) state.samples.shift();
    window.clearTimeout(nudgeTimer);
    nudgeTimer = window.setTimeout(() => (state.target[0] = state.target[1] = 0), 1800);
    kick();
  }

  // ------------------------------------------------------------ debug (?debug=1)
  let dbgAt = 0;
  function dbgUpdate(now: number) {
    const dbg = o.debugEl;
    if (!debug || !dbg || now - dbgAt < 250) return;
    dbgAt = now;
    const avg = ft.length ? ft.reduce((a, b) => a + b, 0) / ft.length : 0;
    dbg.textContent = [
      `fps ${avg ? (1 / avg).toFixed(1) : '-'}   frame ${(avg * 1000).toFixed(1)} ms`,
      `canvas ${canvas.width}x${canvas.height}  scale ${state.scale.toFixed(2)} (gov ${state.gov})`,
      `hour ${fmt(state.hour)} ${cur.name}${state.live ? '' : ' (forced)'}  w ${cur.w.map((x) => x.toFixed(2)).join('/')}`,
      `photos ${loaded.map((l, i) => (l ? PHOTOS[i] : '-')).join(' ')}  ${(state.bytes / 1024).toFixed(1)} KB`,
      `descent p ${state.p.toFixed(3)} ${stageAt(state.p)}  hour shown ${fmt(state.eff)}`,
      `motion ${reduced ? 'reduced' : state.paused ? 'paused' : 'on'}  mode ${stillMode ? 'still' : 'webgl'}`,
    ].join('\n');
  }

  // ------------------------------------------------------------ the public handle
  const api: Sky = {
    mode: () => (stillMode ? 'still' : 'webgl'),
    animated: () => !reduced && !stillMode,
    setHour(h) {
      state.live = false;
      state.hour = ((h % 24) + 24) % 24;
      if (gl && !stillMode) want(true);
      applyHour();
      kick();
    },
    now() {
      state.live = true;
      state.hour = localHour();
      applyHour();
      kick();
    },
    togglePause() {
      state.paused = !state.paused;
      if (state.paused) {
        state.target[0] = state.target[1] = 0;
        state.samples.length = 0;
      }
      kick();
      return state.paused;
    },
    nudge,
    setScroll(p) {
      if (reduced || stillMode) return; // no scroll-driven camera; the still has its own CSS (story.css)
      state.pT = Math.min(1, Math.max(0, p));
      if (!animating() || manual) {
        state.p = state.pT; // not looping (paused, or the test harness): jump there and draw once
        regrade();
        kick();
      } else schedule();
    },
  };

  // ------------------------------------------------------------ boot
  const wantGL = (q.get('gl') === '1' || !noHover) && !saveData;
  if (wantGL) {
    layer.append(canvas);
    if (!initGL()) {
      canvas.remove();
      gl = null;
    }
  }
  stillMode = !gl;
  if (gl) section.classList.add('has-gl');
  applyHour();
  // the lit fill is sized to the words: refit it when they reflow (a resize, or the font arriving)
  const refit = () => {
    litSig = '';
    lightText();
  };
  addEventListener('resize', refit);
  void document.fonts?.ready.then(refit);

  progress.subscribe((p) => api.setScroll(p));
  api.setScroll(progress.get());

  // The page's clock: while the sky follows the visitor's hour, it moves with it.
  window.setInterval(() => {
    if (!state.live) return;
    const h = localHour();
    if (Math.abs(h - state.hour) > 0.004 || h < state.hour) {
      state.hour = h;
      applyHour();
      if (gl && !animating() && !stillMode) draw();
    }
  }, 30000);

  if (gl) {
    resize();
    addEventListener('resize', () => {
      resize();
      kick();
    });
    if (!reduced) {
      addEventListener('pointermove', onMove, { passive: true });
      document.documentElement.addEventListener('pointerleave', onLeave);
      addEventListener('blur', onLeave);
      document.addEventListener('visibilitychange', () => {
        state.last = null;
        schedule();
      });
      new IntersectionObserver((es) => {
        state.onscreen = es[es.length - 1]!.isIntersecting;
        state.last = null;
        schedule();
      }).observe(layer);
    }
    // first paint needs only this hour's photograph(s); the rest wait for the dial or the clock
    const need = cur.w.map((w, i) => [w, i] as const).filter(([w]) => w > 0.004);
    void Promise.all(need.map(([, i]) => loadPhoto(i))).then(() => {
      draw();
      dbgUpdate(1e9);
      schedule();
    });
  } else o.onStill();

  // Test and capture harness (scripts/check-sky.mjs steps time itself: this box has no frame clock).
  (window as unknown as { __sky: unknown }).__sky = {
    state,
    frame(dt: number) {
      step(dt);
      draw();
      dbgUpdate(1e9);
    },
    ready: () => loaded.some(Boolean) || stillMode,
    loadAll: () => Promise.all([0, 1, 2].map(loadPhoto)),
    setHour(h: number) {
      api.setHour(h);
      draw();
    },
    mode: api.mode,
    /** Descent progress 0..1, applied at once and drawn (for the filmstrip and S4's checker). */
    setScroll(p: number) {
      state.pT = state.p = Math.min(1, Math.max(0, p));
      regrade();
      draw();
    },
    /** What the checker needs to read the pixels behind text: the page's ground, glass and stage. */
    stage: () => ({
      p: state.p,
      stage: stageAt(state.p),
      hour: state.hour,
      eff: state.eff,
      ground: o.story.style.getPropertyValue('--ground-rgb'),
      glass: o.story.style.getPropertyValue('--glass-rgb'),
      scrim: cur.scrim,
    }),
  };
  return api;
}
