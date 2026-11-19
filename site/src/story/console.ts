/**
 * The console demo, driven by the scroll. The frame follows the hero: its top peeks above the fold, and as the page
 * scrolls it rises and grows a little (transform only), pins (CSS `position: sticky`, so nothing is trapped and the
 * page scrolls on under it) and plays the beats of src/console/flow.ts: sign in, discover, services, open one,
 * health, files, modules. One number (the distance scrolled through the tall track) steers everything; each beat gets
 * a share of it and a local 0..1 of its own. Every state is a pure function of that number, so scrolling back undoes it.
 *
 * Without script, with reduced motion, on a small window, or if the frame is taller than the window, none of this
 * runs: the frame is the static first view with its real radio tabs and the steps as a list, which is what the HTML
 * holds. The frame is fixtures only and says so (its "Example data" badge is untouched).
 */
import { BEATS } from '../console/flow.ts';
import { setupDither, type Dither } from './dither.ts';
import { setupLens, type Lens } from './lens.ts';

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => 1 - (1 - clamp(x)) ** 3;
const MIN_FIT = 0.5; // below this the frame would be unreadable: static view instead
const STICK = 88; // px, under the bar (the header is 4rem and the stage sticks 1.5rem below it)
const FROM = 0.9; // the window's scale when it first peeks above the fold: already large, and only gently larger when docked
const VIEWS = ['services', 'files', 'health', 'modules'] as const;

export interface ConsoleDriver {
  measure(): void;
  drive(): void;
}

const q = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const qa = <T extends HTMLElement>(root: ParentNode, sel: string) => [...root.querySelectorAll<T>(sel)];

export function setupConsole(root: HTMLElement): ConsoleDriver | null {
  const track = q(root, '[data-console-track]');
  const stage = track && q(track, '.ch-stage');
  const cf = stage && q(stage, '.cf');
  if (!track || !stage || !cf) return null;
  const radios = qa<HTMLInputElement>(cf, '.cf-r');
  const panels = VIEWS.map((v) => q(cf, `.cf-panel-${v}`));
  const body = q(cf, '.console-frame');
  const login = q(cf, '.cf-panel-login');
  if (radios.length !== 4 || panels.some((p) => !p) || !body || !login) return null;
  const P = panels as HTMLElement[];

  const rows = qa(P[0]!, '.svc-tr');
  const docs = qa(P[1]!, '.rd-li, .fx-doc .md-h, .fx-doc .md-p, .fx-doc .md-list');
  const tiles = qa(P[2]!, '.ch-tile');
  for (const el of [...rows, ...docs, ...tiles]) el.classList.add('cs-item');
  const nums = qa(P[2]!, '.ch-num').map((el) => ({
    el,
    full: el.textContent ?? '',
    n: Number.parseInt(el.textContent ?? '', 10),
  }));

  const scanbar = q(cf, '.cf-scanbar');
  const scanN = q(cf, '.cf-scan-n');
  const cmd = q(cf, '.cf-cmd');
  const cmdText = cmd && q(cmd, '.cf-typed');
  const newMod = q(cf, '.cf-mod-new');
  const fields = qa(login, '.cf-field-v').map((el) => ({ el, out: q(el, '.cf-typed')!, full: el.dataset.type ?? '' }));
  const signin = q(login, '[data-signin]');
  const steps = qa(cf, '.cf-step');

  // one chip changes state while the scan finishes: the "starting" row comes up
  const starting = q(P[0]!, '.si-starting');
  const upTpl = q(P[0]!, '.si-up');
  const startOrig = starting
    ? { cls: starting.className, style: starting.getAttribute('style'), html: starting.innerHTML }
    : null;
  let up = false;
  function setUp(v: boolean) {
    if (!starting || !upTpl || !startOrig || v === up) return;
    up = v;
    starting.className = v ? upTpl.className : startOrig.cls;
    const st = v ? upTpl.getAttribute('style') : startOrig.style;
    if (st === null) starting.removeAttribute('style');
    else starting.setAttribute('style', st);
    starting.innerHTML = v ? upTpl.innerHTML : startOrig.html;
  }

  // each beat's share of the scroll
  const total = BEATS.reduce((a, b) => a + b.weight, 0);
  const edges: number[] = [];
  BEATS.reduce((a, b) => (edges.push(a / total), a + b.weight), 0);
  edges.push(1);

  let range = 1;
  let fit = 1; // the frame's own scale when the window is shorter than the frame is tall
  let pinTop = STICK; // where the stage sticks: under the bar, and centred in what is left when the frame is short
  let frameH = 0; // the frame's height before any scale
  let trackTop = 0;
  let on = false;
  let beatShown = -1;
  const glass = q(cf, '.cf-glass');
  const sr = q(cf, '.cf-sr');
  // the live region speaks the step the reader stops on, not every step a fast scroll passes through
  let srTimer: number | undefined;

  /** The frame's layout width, then the heights of its views, equalised: the tallest view sets the window. */
  function equalise(w: number) {
    stage!.style.setProperty('--cf-w', `${Math.round(w)}px`);
    body!.style.minBlockSize = '';
    const keep = radios.findIndex((r) => r.checked);
    let tall = 0;
    for (const r of radios) {
      r.checked = true;
      tall = Math.max(tall, body!.offsetHeight);
    }
    radios[Math.max(0, keep)]!.checked = true;
    body!.style.minBlockSize = `${tall}px`;
    cf!.style.setProperty('--cf-h', `${tall}px`);
    return glass!.offsetHeight;
  }

  let dither: Dither | null = null;
  let lens: Lens | null = null;
  function measure() {
    cf!.classList.add('cs-live');
    root.classList.add('cs-on'); // the stage's width and the pin are sized by these rules: measure with them on
    scanbar?.classList.add('is-on');
    if (glass) glass.style.transform = '';
    // The frame is a comfortable centred window: about 72% of the page wide, at most 1100px. When the window is not tall enough
    // for that, the frame is laid out wider and scaled down (transform only) so it still fills the width; it is
    // never switched off for a short window (that was the bug: the demo did not start on a laptop).
    const target = Math.min(innerWidth * 0.72, 1100);
    const avail = innerHeight - STICK - 40; // room under the nav above and a margin below (the caption is inside the frame)
    let w = target;
    let h = equalise(w);
    fit = Math.min(1, avail / Math.max(1, h));
    if (fit < 1) {
      w = Math.min(target / fit, 2400);
      h = equalise(w);
      fit = Math.min(1, avail / Math.max(1, h), (target * 1.05) / w);
    }
    frameH = h;
    scanbar?.classList.remove('is-on');
    on = fit >= MIN_FIT && matchMedia('(min-width: 48rem)').matches;
    root.classList.toggle('cs-on', on);
    cf!.classList.toggle('cs-live', on);
    if (glass) {
      if (on) glass.setAttribute('inert', '');
      else glass.removeAttribute('inert');
    }
    beatShown = -1;
    if (on && !lens && !matchMedia('(prefers-reduced-motion: reduce)').matches) lens = setupLens(cf!, body!);
    lens?.reset();
    if (on && !dither && !matchMedia('(prefers-reduced-motion: reduce)').matches) dither = setupDither(root);
    dither?.measure();
    if (on) {
      pinTop = STICK + Math.max(0, (avail - h * fit) / 2);
      stage!.style.setProperty('--cf-top', `${Math.round(pinTop)}px`);
      trackTop = track!.getBoundingClientRect().top + scrollY;
      range = Math.max(1, track!.offsetHeight - stage!.offsetHeight);
    } else {
      for (const el of [...rows, ...docs, ...tiles, ...(newMod ? [newMod] : []), ...steps]) {
        el.style.removeProperty('opacity');
        el.style.removeProperty('translate');
        painted.delete(el);
      }
      stage!.style.removeProperty('--cf-w');
      stage!.style.removeProperty('--cf-top');
    }
  }

  // a thing's arrival, 0..1, written as opacity and translate only, and only when the number moved (the writes are cheap
  // enough to run on every scroll event; a scroll that changes nothing here writes nothing)
  const painted = new WeakMap<HTMLElement, number>();
  function paint(el: HTMLElement | null | undefined, p: number, rise = 0) {
    if (!el) return;
    const k = Math.round(clamp(p) * 100);
    if (painted.get(el) === k) return;
    painted.set(el, k);
    if (k >= 100) {
      el.style.removeProperty('opacity');
      el.style.removeProperty('translate');
    } else {
      el.style.opacity = (k / 100).toFixed(2);
      el.style.translate = `0 ${(((100 - k) / 100) * rise).toFixed(1)}px`;
    }
  }
  function typeInto(out: HTMLElement, full: string, k: number) {
    const s = full.slice(0, Math.round(full.length * clamp(k)));
    if (out.textContent !== s) out.textContent = s;
  }

  function drive() {
    if (!on) return;
    // the growth: from a small, narrow peek under the hero to the big centred window, one continuous scrubbed motion
    // (scale only, plus the bezel easing); the beats start at the moment it is docked, so there is no jump
    const k = clamp(scrollY / Math.max(1, trackTop - pinTop)); // 0 at the top of the page, 1 when docked
    const rise = k * k * (3 - 2 * k);
    // after the beats the window eases away: it rolls up with the page, lightening to nothing as the dark comes in
    const out = clamp((scrollY + pinTop - trackTop - range) / (frameH * fit * 0.9));
    const sc = fit * (FROM + (1 - FROM) * rise) * (1 - 0.06 * out);
    if (glass) {
      const tf = `scale(${sc.toFixed(4)})`;
      if (glass.style.transform !== tf) glass.style.transform = tf;
      glass.style.opacity = (1 - out ** 1.5).toFixed(3);
    }
    cf!.style.setProperty('--cf-rise', rise.toFixed(3));
    if (dither) {
      // the dissolve is its own three stages, and it starts only when the story is done (the last beat, then the frame
      // rolling away): 1 thin dots appear over the whole screen; 2 a denser front of dots rises from the foot to the
      // top, continuously with the scroll; 3 solid ink, which the next section already sits on
      const L0 = innerHeight * 0.3;
      const tr = clamp((scrollY + pinTop - trackTop - range + L0) / (L0 + frameH * fit * 0.95));
      const ease = (x: number) => x * x * (3 - 2 * x);
      const g = ease(clamp(tr / 0.2));
      const gone = -(dither.band / innerHeight) - 0.02;
      const r = ease(clamp((tr - 0.18) / 0.78));
      const f = tr <= 0.18 ? 1.05 : 1.0 + (gone - 1.0) * r;
      root.style.setProperty('--sd-g', g.toFixed(3));
      dither.set(f);
    }
    const t = clamp((scrollY + pinTop - trackTop) / range);
    root.style.setProperty('--cs-t', t.toFixed(3));
    let beat = BEATS.length - 1;
    for (let i = 0; i < BEATS.length; i++)
      if (t < edges[i + 1]! || i === BEATS.length - 1) {
        beat = i;
        break;
      }
    const u = clamp((t - edges[beat]!) / (edges[beat + 1]! - edges[beat]!));
    const b = BEATS[beat]!;
    if (root.dataset.csBeat !== String(beat)) root.dataset.csBeat = String(beat); // read by ?debug=story and the regression test

    // Everything below is a pure function of (beat, u): nothing runs on a timer, nothing is a CSS transition, so when the
    // scroll stops every line, popup and tick stops where it is, and scrolling back rewinds it. Each thing has a window
    // [a, b] of the beat; the gaps between windows are the dwell (the camera holds on what was just done).
    const span = (a: number, c: number) => clamp((u - a) / (c - a));
    const at = (n: number) => beat === n;

    if (beatShown !== beat) {
      beatShown = beat;
      steps.forEach((el, i) => {
        el.classList.toggle('is-on', i === beat);
        if (i !== beat) paint(el, 1, 0);
      });
      window.clearTimeout(srTimer);
      const said = `Step ${beat + 1} of ${BEATS.length}: ${b.label}. ${b.caption}`;
      if (sr) srTimer = window.setTimeout(() => (sr.textContent = said), 700);
      const isLogin = b.scene === 'login';
      cf!.classList.toggle('cs-login', isLogin);
      if (isLogin) for (const r of radios) r.checked = false;
      else radios[VIEWS.indexOf(b.scene as (typeof VIEWS)[number])]!.checked = true;
    }
    // the caption fades in over the first stretch of its beat and out over the last, scrubbed like the rest
    const cap = ease(u / 0.08) * (1 - ease((u - 0.92) / 0.08));
    paint(steps[beat], cap, 6);

    // 1 sign in: focus the username and wait, type it; move to the password and wait, type it (masked); press the
    // button, a loading state, then a pause before the next view
    const typeU = span(0.26, 0.42);
    const typeP = span(0.62, 0.78);
    fields.forEach((f, i) => {
      typeInto(f.out, f.full, !at(0) ? 1 : i === 0 ? typeU : typeP);
      const focus = at(0) && (i === 0 ? u >= 0.12 && u < 0.5 : u >= 0.5 && u < 0.84);
      f.el.classList.toggle('is-typing', focus);
      f.el.classList.toggle('is-focus', focus);
    });
    const load = !at(0) ? 1 : span(0.89, 0.97);
    signin?.classList.toggle('cs-go', !at(0) || u >= 0.84);
    signin?.classList.toggle('cs-press', at(0) && u >= 0.86 && u < 0.89);
    signin?.classList.toggle('cs-load', at(0) ? u >= 0.89 && u < 0.97 : false);
    signin?.classList.toggle('cs-done', !at(0) || u >= 0.97);
    if (signin) {
      const lv = (at(0) ? load : 0).toFixed(3);
      if (signin.style.getPropertyValue('--cs-l') !== lv) signin.style.setProperty('--cs-l', lv);
    }

    // 2 discover: the bar fills as Docker answers and the rows arrive one by one, then the last one comes up
    const scanU = at(1) ? span(0.1, 0.62) : 1;
    const nRows = beat === 0 ? 0 : Math.ceil(rows.length * scanU);
    scanbar?.classList.toggle('is-on', at(1));
    cf!.classList.toggle('cs-scan-done', !at(1) || u >= 0.62);
    if (scanN) scanN.textContent = String(nRows);
    cf!.style.setProperty('--cs-u', scanU.toFixed(3));
    rows.forEach((el, i) => {
      const p = beat === 0 ? 0 : at(1) ? clamp(scanU * rows.length - i) : 1;
      paint(el, p, 12);
      el.classList.toggle('cs-cur', cur(i));
    });
    function cur(i: number) {
      const n = Math.min(rows.length, 5);
      if (at(2)) return i === Math.min(n - 1, Math.floor(span(0.1, 0.9) * n));
      return at(3) && u >= 0.12 && i === 0;
    }
    setUp(beat > 1 || (at(1) && u > 0.78));

    // 3 services: the camera takes the rows one at a time (lens.ts); 4 open one: the panel slides in, then a verb lights
    const detailK = at(3) ? ease(span(0.28, 0.52)) : 0;
    cf!.style.setProperty('--cs-d', detailK.toFixed(3));
    cf!.classList.toggle('cs-detail', detailK > 0);
    cf!.classList.toggle('cs-verb', at(3) && u >= 0.76 && u < 0.92);

    // 5 health: tiles arrive one by one and count up, then the CPU line is drawn
    const hu = at(4) ? span(0.08, 0.46) : beat > 4 ? 1 : 0;
    tiles.forEach((el, i) => paint(el, clamp(hu * tiles.length - i), 12));
    for (const x of nums) {
      const t = ease(hu);
      const v = Number.isFinite(x.n) ? String(Math.round(x.n * t)) : x.full;
      if (x.el.textContent !== v) x.el.textContent = v;
    }
    cf!.style.setProperty('--cs-s', (at(4) ? span(0.56, 0.86) : beat > 4 ? 1 : 0).toFixed(3));

    // 6 files: the note is laid out block by block
    const du = at(5) ? span(0.1, 0.8) : beat > 5 ? 1 : 0;
    docs.forEach((el, i) => paint(el, clamp(du * docs.length - i), 12));

    // 7 modules: the command is typed, run, and the new row arrives
    if (cmdText) typeInto(cmdText, cmdText.dataset.type ?? '', at(6) ? span(0.1, 0.5) : 0);
    cmd?.classList.toggle('is-typing', at(6) && u < 0.58);
    if (newMod) paint(newMod, at(6) ? span(0.64, 0.76) : 0, 10);
    lens?.show(beat, u);
  }

  return { measure, drive };
}
