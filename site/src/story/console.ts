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

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => 1 - (1 - clamp(x)) ** 3;
const MIN_FIT = 0.5; // below this the frame would be unreadable: static view instead
const STICK = 88; // px, matches `inset-block-start: 5.5rem` in story.css
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
  const inds = qa(cf, '.cf-ind-i');

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
  let fit = 1;
  let trackTop = 0;
  let on = false;
  let manual = -1; // the t at which the visitor chose a view by hand; scrolling on gives the scroll the wheel back
  let lastT = 0;
  let seen = '';
  let beatShown = -1;
  cf.addEventListener('change', (e) => {
    if (!e.isTrusted) return;
    manual = lastT;
    cf.classList.remove('cs-login');
  });

  function measure() {
    cf!.classList.add('cs-live');
    scanbar?.classList.add('is-on');
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
    scanbar?.classList.remove('is-on');
    // A frame taller than the window is scaled down to fit (transform only), never switched off: a laptop window
    // (about 700px of page) used to fall back to the static view and the demo never played.
    fit = Math.min(1, (innerHeight - STICK - 24) / Math.max(1, stage!.offsetHeight));
    on = fit >= MIN_FIT && matchMedia('(min-width: 48rem)').matches;
    root.classList.toggle('cs-on', on);
    cf!.classList.toggle('cs-live', on);
    stage!.style.transform = '';
    seen = '';
    beatShown = -1;
    if (on) {
      trackTop = track!.getBoundingClientRect().top + scrollY;
      range = Math.max(1, track!.offsetHeight - stage!.offsetHeight);
    }
  }

  function setItems(list: HTMLElement[], n: number, cur: number) {
    list.forEach((el, i) => {
      el.classList.toggle('cs-wait', i >= n);
      el.classList.toggle('cs-cur', i === cur && i < n);
    });
  }
  function typeInto(out: HTMLElement, full: string, k: number) {
    const s = full.slice(0, Math.round(full.length * clamp(k)));
    if (out.textContent !== s) out.textContent = s;
  }

  function drive() {
    if (!on) return;
    // the rise: from the peek under the hero to the pinned place, a little larger on the way
    const top = trackTop - scrollY;
    const k = clamp((innerHeight * 0.95 - top) / (innerHeight * 0.95 - STICK));
    const rise = ease(k);
    const sc = fit * (0.94 + 0.06 * rise);
    const tf =
      k >= 1
        ? fit < 1
          ? `scale(${fit.toFixed(4)})`
          : ''
        : `translateY(${((1 - rise) * 2.5).toFixed(2)}rem) scale(${sc.toFixed(4)})`;
    if (stage!.style.transform !== tf) stage!.style.transform = tf;

    const t = clamp((scrollY + STICK - trackTop) / range);
    lastT = t;
    root.style.setProperty('--cs-t', t.toFixed(3));
    if (manual >= 0) {
      if (Math.abs(t - manual) < 0.04) return;
      manual = -1;
    }
    let beat = BEATS.length - 1;
    for (let i = 0; i < BEATS.length; i++)
      if (t < edges[i + 1]! || i === BEATS.length - 1) {
        beat = i;
        break;
      }
    const u = clamp((t - edges[beat]!) / (edges[beat + 1]! - edges[beat]!));
    const b = BEATS[beat]!;
    if (root.dataset.csBeat !== String(beat)) root.dataset.csBeat = String(beat); // read by ?debug=story and the regression test

    // derived state, quantised so a scroll event that changes nothing does no work
    const nRows = beat === 0 ? 0 : beat === 1 ? Math.ceil(rows.length * clamp(u / 0.9)) : rows.length;
    const curRow = beat === 2 ? Math.min(rows.length - 1, Math.floor(u * rows.length)) : beat === 3 ? 0 : -1;
    const hu = beat === 4 ? clamp(u / 0.6) : beat > 4 ? 1 : 0;
    const nTiles = Math.ceil(tiles.length * hu);
    const nDocs = beat < 5 ? 0 : beat === 5 ? Math.ceil(docs.length * clamp(u / 0.8)) : docs.length;
    const spark = beat === 4 ? clamp((u - 0.25) / 0.6) : beat > 4 ? 1 : 0;
    const detailK = beat === 3 ? ease(u / 0.35) : 0;
    const cmdK = beat < 6 ? 0 : clamp(u / 0.5);
    const userK = beat === 0 ? clamp(u / 0.35) : 1;
    const passK = beat === 0 ? clamp((u - 0.35) / 0.3) : 1;
    const key = [
      beat,
      nRows,
      curRow,
      nTiles,
      Math.round(hu * 24),
      nDocs,
      Math.round(spark * 40),
      Math.round(detailK * 40),
      Math.round(cmdK * 60),
      Math.round(userK * 20),
      Math.round(passK * 20),
      beat === 1 ? Math.round(u * 60) : '',
      beat === 6 && u > 0.6,
      beat === 0 && u > 0.8,
    ].join('|');
    if (key === seen) return;
    seen = key;

    if (beatShown !== beat) {
      beatShown = beat;
      steps.forEach((el, i) => el.classList.toggle('is-on', i === beat));
      inds.forEach((el, i) => {
        el.classList.toggle('is-on', i === beat);
        el.classList.toggle('is-done', i < beat);
      });
      const isLogin = b.scene === 'login';
      cf!.classList.toggle('cs-login', isLogin);
      if (isLogin) for (const r of radios) r.checked = false;
      else radios[VIEWS.indexOf(b.scene as (typeof VIEWS)[number])]!.checked = true;
    }

    // sign in
    fields.forEach((f, i) => {
      typeInto(f.out, f.full, i === 0 ? userK : passK);
      f.el.classList.toggle('is-typing', beat === 0 && (i === 0 ? u > 0 && u < 0.35 : u >= 0.35 && u < 0.7));
    });
    signin?.classList.toggle('cs-go', beat > 0 || u > 0.8);

    // discover
    scanbar?.classList.toggle('is-on', beat === 1);
    cf!.classList.toggle('cs-scan-done', beat !== 1 || u >= 0.9);
    if (scanN) scanN.textContent = String(nRows);
    cf!.style.setProperty('--cs-u', (beat === 1 ? clamp(u / 0.9) : 1).toFixed(3));
    setItems(rows, nRows, curRow);
    setUp(beat > 1 || (beat === 1 && u > 0.95));

    // open one
    cf!.style.setProperty('--cs-d', detailK.toFixed(3));
    cf!.classList.toggle('cs-detail', detailK > 0);

    // health
    setItems(tiles, nTiles, -1);
    for (const x of nums) x.el.textContent = Number.isFinite(x.n) ? String(Math.round(x.n * ease(hu))) : x.full;
    cf!.style.setProperty('--cs-s', spark.toFixed(3));

    // files
    setItems(docs, nDocs, -1);

    // modules
    if (cmdText) typeInto(cmdText, cmdText.dataset.type ?? '', cmdK);
    cmd?.classList.toggle('is-typing', beat === 6 && u < 0.55);
    newMod?.classList.toggle('cs-wait', !(beat === 6 && u > 0.6));
  }

  return { measure, drive };
}
