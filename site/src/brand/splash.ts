/**
 * The first-visit splash: the Cube opens, two Bs climb out, the second pulls "othy" and "ox" out between them until
 * "BothyBox" stands in its lockup, and the lockup flies into the header, where the same lockup already is. Ported from
 * the owner-chosen "Cube" loader in public/brand-mock/loader.js (brand-options.md); pure inline SVG on the Web
 * Animations API, no library, no WebGL.
 *
 * Loaded lazily by enhance.ts only when brand/splash-gate.ts says yes. It never blocks anything: the page is complete
 * and usable underneath; the overlay is fixed (no layout shift), aria-hidden and pointer-events: none, so every click,
 * key, wheel or touch goes to the page and also ends the splash. About 2 s in all; a timer removes it regardless, so
 * a browser that stalls its animations (a background tab, a headless box) is never left with it on screen.
 */
import { AMBER, GLYPHS, INK, LOCKUP, PAPER, cubeBody, layoutWord } from './cube.ts';

export const DURATION = 2000; // ms, the whole splash
const SEQ = 1600; // the box-to-word sequence; the rest is the flight into the header
const W = 1000;
const H = 400;
const word = layoutWord();
const LW = LOCKUP.icon + LOCKUP.gap + word.width; // 718
const X0 = Math.round((W - LW) / 2);
const WX = X0 + LOCKUP.icon + LOCKUP.gap; // the wordmark's origin x
const CAP = 160; // cap-top y of the wordmark
const ICON_Y = CAP + LOCKUP.top;
const S0 = 3.4; // the box at the start: centred, big
const BOX0 = { x: W / 2 - 32 * S0, y: 215 - 32 * S0, s: S0 };
const BOX1 = { x: X0, y: ICON_Y, s: LOCKUP.icon / 64 };
const RIM = 26; // the top of the cube's front, 64 grid
const LID_OPEN = 'translate(-6px, -22px) rotate(-24deg)';

const BACK = 'cubic-bezier(0.34, 1.32, 0.52, 1)'; // out, with a small overshoot
const OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const PULL = 'cubic-bezier(0.55, 0, 0.25, 1)';

type Box = { x: number; y: number; s: number };
const boxT = (b: Box) => `translate(${b.x}px, ${b.y}px) scale(${b.s})`;
const f = (n: number) => +n.toFixed(2);
const B1 = word.letters[0]!;
const B2 = word.letters[5]!;

/** The splash's SVG, written in its final state: the lockup, exactly as the header draws it (larger). */
export function splashSVG(): string {
  const bAt = (l: typeof B1, cls: string) =>
    `<g class="b ${cls}" data-b="${l === B1 ? 1 : 2}" style="transform: translate(${WX + l.x + 36}px, ${CAP + 50}px) translate(-36px, -50px)"><path d="${GLYPHS.B.d}"/></g>`;
  const rest = word.letters
    .filter((l) => l.ch !== 'B')
    .map(
      (l) =>
        `<g class="ltr" data-i="${l.i}" style="transform: translate(${WX + l.x}px, ${CAP}px)"><path d="${l.d}"/></g>`,
    )
    .join('');
  const lid = `<path class="lid" fill="${AMBER}" d="M32 6L56 18L32 30L8 18Z" style="transform-box: fill-box; transform-origin: 0% 50%"/>`;
  return (
    `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">` +
    `<g fill="${PAPER}" fill-rule="evenodd">` +
    // the lid sits behind the Bs, so a lifted lid never hides them as they climb out
    `<g class="box" style="transform: ${boxT(BOX1)}; opacity: 0"><path fill="${INK}" d="M32 6L56 18L32 30L8 18Z"/>` +
    `<path opacity=".3" d="M32 6L56 18L32 30L8 18Z"/>${lid}</g>` +
    `<g class="inside">${bAt(B1, 'b-in')}${bAt(B2, 'b-in')}</g>` +
    `<g class="box" style="transform: ${boxT(BOX1)}; opacity: 0"><path d="M8 18L32 30V58L8 46Z"/>` +
    `<path fill="#b1b0ad" d="M32 30L56 18V46L32 58Z"/></g>` +
    `<g class="final-icon" style="transform: ${boxT(BOX1)}">${cubeBody({ fg: PAPER, lid: AMBER, id: 'bb-splash-m' })}</g>` +
    `<g class="word">${rest}${bAt(B1, 'b-out')}${bAt(B2, 'b-out')}</g>` +
    `</g></svg>`
  );
}

/** The sequence's animations on a rendered splash SVG, created paused at 0 so seek(t) is deterministic. */
function sequence(svg: SVGSVGElement, add: (el: Element, k: Keyframe[], d: number) => void) {
  for (const g of svg.querySelectorAll('.box'))
    add(
      g,
      [
        {
          offset: 0,
          transform: `translate(${BOX0.x + 32 * S0 * 0.06}px, ${BOX0.y + 32 * S0 * 0.06 + 14}px) scale(${S0 * 0.94})`,
          opacity: 0,
          easing: OUT,
        },
        { offset: 0.15, transform: boxT(BOX0), opacity: 1 },
        // leaves as soon as the Bs are clear of the rim, fast at first, so it is small and out of their way
        { offset: 0.4, transform: boxT(BOX0), opacity: 1, easing: 'cubic-bezier(0.2, 0.85, 0.3, 1.06)' },
        { offset: 0.72, transform: boxT(BOX1), opacity: 1 },
        { offset: 0.86, transform: boxT(BOX1), opacity: 1, easing: OUT },
        { offset: 0.96, transform: boxT(BOX1), opacity: 0 },
        { offset: 1, transform: boxT(BOX1), opacity: 0 },
      ],
      SEQ,
    );
  // the lid pops open with a tiny overshoot, and drops shut as the box lands
  add(
    svg.querySelector('.lid')!,
    [
      { offset: 0, transform: 'none' },
      { offset: 0.125, transform: 'none', easing: BACK },
      { offset: 0.33, transform: LID_OPEN },
      { offset: 0.52, transform: LID_OPEN, easing: BACK },
      { offset: 0.72, transform: 'none' },
      { offset: 1, transform: 'none' },
    ],
    SEQ,
  );
  // the icon proper fades in where the box lands, its Bs cut through the faces
  add(
    svg.querySelector('.final-icon')!,
    [{ opacity: 0 }, { opacity: 0, offset: 0.84, easing: OUT }, { opacity: 1 }],
    SEQ,
  );

  // The two Bs: an inside copy (behind the front) for the rise, an outside copy (on top) for the flight.
  const cx0 = W / 2;
  const front0 = BOX0.y + RIM * S0;
  const fy = CAP + 50;
  const fx1 = WX + B1.x + 36;
  const fx2 = WX + B2.x + 36;
  const adj = fx1 + 78; // B2 parked beside B1, the pair as it came out of the box
  const P = [0.62, 0.74, 0.82]; // the pull: B2's progress is 0, 0.8, 1 at these
  const T = (x: number, y: number, s: number, kx = 1, ky = 1) =>
    `translate(${f(x)}px, ${f(y)}px) scale(${f(s * kx)}, ${f(s * ky)}) translate(-36px, -50px)`;
  const pathB = (n: number): Keyframe[] => {
    const sx = n === 1 ? -1 : 1;
    const k: Keyframe[] = [
      { offset: 0, transform: T(cx0 + sx * 26, front0 + 36, 0.6) },
      { offset: 0.24, transform: T(cx0 + sx * 26, front0 + 36, 0.6), easing: BACK }, // waits for the lid
      { offset: 0.5, transform: T(cx0 + sx * 33, front0 - 60, 0.82, 0.96, 1.06), easing: OUT },
      { offset: 0.62, transform: T(n === 1 ? fx1 : adj, fy, 1), easing: n === 1 ? OUT : PULL },
    ];
    if (n === 1) {
      // B1 holds its ground and recoils a little as B2 pulls away
      k.push({ offset: 0.7, transform: T(fx1, fy, 1, 0.95, 1.03), easing: BACK });
      k.push({ offset: 0.82, transform: T(fx1, fy, 1) });
    } else {
      // B2 pulls the word out: stretched wide mid-pull, a hair of overshoot, settles
      k.push({ offset: P[1], transform: T(adj + (fx2 - adj) * 0.8, fy, 1, 1.16, 0.95), easing: BACK });
      k.push({ offset: P[2], transform: T(fx2, fy, 1) });
    }
    k.push({ offset: 1, transform: T(n === 1 ? fx1 : fx2, fy, 1) });
    return k;
  };
  for (const g of svg.querySelectorAll<SVGGElement>('.b')) {
    add(g, pathB(Number(g.dataset.b)), SEQ);
    add(
      g,
      g.classList.contains('b-in')
        ? [
            { opacity: 0 },
            { opacity: 0, offset: 0.15 },
            { opacity: 1, offset: 0.15 },
            { opacity: 1, offset: 0.5 },
            { opacity: 0, offset: 0.5 },
            { opacity: 0 },
          ]
        : [{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1, offset: 0.5 }, { opacity: 1 }],
      SEQ,
    );
  }
  // "othy" spreads between B1 and the moving B2 like a bellows; "ox" unfolds out of B2's back.
  const b1Right = WX + B1.x + 64;
  for (const g of svg.querySelectorAll<SVGGElement>('.ltr')) {
    const l = word.letters[Number(g.dataset.i)]!;
    const from = l.i > 5 ? adj - 8 : b1Right - 10;
    const to = WX + l.x;
    add(
      g,
      [
        { offset: 0, transform: `translate(${f(from)}px, ${CAP}px) scale(0.12, 1)` },
        { offset: P[0], transform: `translate(${f(from)}px, ${CAP}px) scale(0.12, 1)`, easing: PULL },
        {
          offset: P[1],
          transform: `translate(${f(from + (to - from) * 0.8)}px, ${CAP}px) scale(0.86, 1)`,
          easing: BACK,
        },
        { offset: P[2], transform: `translate(${to}px, ${CAP}px) scale(1, 1)` },
        { offset: 1, transform: `translate(${to}px, ${CAP}px) scale(1, 1)` },
      ],
      SEQ,
    );
    // solid almost at once: overlapping letters of one colour merge, half-transparent ones would show the seams
    add(
      g,
      [{ opacity: 0 }, { opacity: 0, offset: P[0]! + 0.03 }, { opacity: 1, offset: P[0]! + 0.031 }, { opacity: 1 }],
      SEQ,
    );
  }
}

export interface Splash {
  el: HTMLElement;
  anims: Animation[];
  seek: (t: number) => void;
  /** End it now: a short fade, then the overlay is removed. */
  skip: () => void;
}

/**
 * Build the overlay and its animations, paused at 0. `target` is the header lockup the flight ends on (its box is
 * exactly the lockup's box); without one the lockup simply fades where it is.
 */
export function createSplash(doc: Document, target: Element | null): Splash {
  const el = doc.createElement('div');
  el.className = 'bb-splash';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;inset:0;z-index:60;pointer-events:none;contain:strict;';
  const veil = doc.createElement('div');
  veil.style.cssText =
    'position:absolute;inset:0;opacity:0;background:radial-gradient(ellipse 75% 60% at 50% 42%, rgb(9 9 12 / 0.95), rgb(9 9 12 / 0.86) 65%, rgb(9 9 12 / 0.74));';
  const stage = doc.createElement('div');
  // the stage's width: the lockup ends at 72 % of it, so about 570 px wide on a desktop and 260 px on a phone
  stage.style.cssText =
    'position:absolute;inset-inline-start:50%;inset-block-start:42%;inline-size:min(800px, 92vw);aspect-ratio:5 / 2;translate:-50% -50%;';
  stage.innerHTML = splashSVG();
  const svg = stage.firstElementChild as SVGSVGElement;
  svg.style.cssText = 'display:block;inline-size:100%;block-size:100%;overflow:visible;transform-origin:0 0;';
  el.append(veil, stage);
  doc.body.append(el);

  const anims: Animation[] = [];
  const add = (node: Element, k: Keyframe[], duration: number) => {
    const a = node.animate(k, { duration, fill: 'both', easing: 'linear' });
    a.pause();
    anims.push(a);
  };
  sequence(svg, add);

  // The flight: map the stage's lockup box onto the header lockup's box, then hand over to it with a short fade.
  const R = svg.getBoundingClientRect();
  const k = R.width / W;
  const to = target?.getBoundingClientRect();
  const end = SEQ / DURATION;
  if (to && to.width > 0) {
    const s = to.width / (LW * k);
    const tx = to.left - R.left - X0 * k * s;
    const ty = to.top - R.top - ICON_Y * k * s;
    add(
      svg,
      [
        { offset: 0, transform: 'none', opacity: 1 },
        { offset: end, transform: 'none', opacity: 1, easing: 'cubic-bezier(0.5, 0, 0.2, 1)' },
        { offset: 0.94, transform: `translate(${f(tx)}px, ${f(ty)}px) scale(${f(s)})`, opacity: 1 },
        { offset: 1, transform: `translate(${f(tx)}px, ${f(ty)}px) scale(${f(s)})`, opacity: 0 },
      ],
      DURATION,
    );
  } else {
    add(svg, [{ opacity: 1 }, { opacity: 1, offset: end }, { opacity: 0 }], DURATION);
  }
  add(
    veil,
    [
      { opacity: 0 },
      { opacity: 1, offset: 0.08 },
      { opacity: 1, offset: end - 0.06 },
      { opacity: 0, offset: 0.92 },
      { opacity: 0 },
    ],
    DURATION,
  );

  const seek = (t: number) => {
    for (const a of anims) {
      a.pause();
      a.currentTime = Math.max(0, Math.min(t, DURATION));
    }
  };
  seek(0);
  let gone = false;
  const skip = () => {
    if (gone) return;
    gone = true;
    for (const a of anims) a.pause();
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    window.setTimeout(() => el.remove(), 180);
  };
  return { el, anims, seek, skip };
}

const SKIP_ON = ['keydown', 'pointerdown', 'wheel', 'touchstart', 'scroll'] as const;

/**
 * Play it once. Any key, click, tap, wheel or scroll ends it early (nothing is prevented: the event still does what it
 * does on the page). `hold` (?splash=hold) builds it paused at 0 and leaves it for a screenshot harness to seek.
 */
export function playSplash(opts: { hold?: boolean } = {}): Splash {
  const target = document.querySelector('.site-nav .brand .lockup');
  const sp = createSplash(document, target);
  if (opts.hold) {
    (window as unknown as { __bbSplash?: Splash }).__bbSplash = sp;
    return sp;
  }
  const done = () => {
    for (const t of SKIP_ON) window.removeEventListener(t, done, true);
    window.clearTimeout(timer);
    sp.skip();
  };
  for (const t of SKIP_ON) window.addEventListener(t, done, { capture: true, passive: true });
  // a stalled animation clock (background tab, headless) must not leave it on screen
  const timer = window.setTimeout(done, DURATION + 300);
  for (const a of sp.anims) a.play();
  void Promise.all(sp.anims.map((a) => a.finished)).then(done, () => {});
  return sp;
}
