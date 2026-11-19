/**
 * The first-visit intro. On a first visit the home page opens on the sky alone (the inline head script set `bb-intro`,
 * styles/intro.css). The Cube opens in the middle, two Bs climb out, the second pulls "othy" and "ox" out between them
 * until "BothyBox" stands in its lockup; the lockup then travels into the header, and while it travels the page
 * assembles round it: the header's links and pills, the hero's badge, heading, lines and buttons, the console's peek,
 * each fading in and rising 14 px, 80 ms apart. Ported from the owner-chosen "Cube" loader in
 * public/brand-mock/loader.js (brand-options.md); pure inline SVG and the Web Animations API, no library, no WebGL.
 *
 * Nothing is ever removed from the page or moved in its layout: everything is in the HTML and only its opacity and
 * `translate` animate (CLS 0). The overlay is aria-hidden and pointer-events: none; any key, click, tap, wheel or
 * scroll jumps to the assembled page. About 2.9 s in all; a timer ends it regardless, so a browser that stalls its
 * animations (a background tab, a headless box) is never left with a hidden page, and the head script's own 3.5 s
 * failsafe covers this module never arriving.
 */
import { AMBER, GLYPHS, INK, LOCKUP, PAPER, cubeBody, layoutWord } from './cube.ts';

const SEQ = 1900; // the box-to-word sequence, centred
const LAND = 2400; // the lockup lands in the header (the flight starts at SEQ)
const STAGGER = { start: 1800, step: 70, each: 480, rise: 14 }; // the page assembling round the flight
/**
 * What the intro hides and brings back, in order. styles/intro.css hides exactly these (a test holds the two lists
 * together). The header lockup comes back as the flying one lands on it; the rest are staggered.
 */
export const INTRO_ITEMS = [
  '.site-nav .brand',
  '.site-nav .primary',
  '.site-nav .tools',
  '.ch-sky .ch-badge',
  '.ch-sky h1',
  '.ch-sky .ch-line',
  '.ch-sky .ch-lede',
  '.ch-sky .ch-actions',
  '.ch-flow .ch-stage',
  '.story-dots',
  '.sky-ui',
] as const;
export const DURATION = STAGGER.start + (INTRO_ITEMS.length - 2) * STAGGER.step + STAGGER.each; // 2910 ms
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

  // The two Bs: an inside copy (behind the front) for the rise, an outside copy (on top) for the flight. They jump out
  // SMALL, GROW as they land side by side (a hair of overshoot), then STRETCH into their places (B2 drags wide to its
  // spot, B1 settles), and only then are the words WRITTEN into the gaps, letter by letter, left to right.
  const cx0 = W / 2;
  const front0 = BOX0.y + RIM * S0;
  const fy = CAP + 50;
  const fx1 = WX + B1.x + 36;
  const fx2 = WX + B2.x + 36;
  const adj = fx1 + 78; // B2 parked beside B1, the pair as it came out of the box
  const T = (x: number, y: number, s: number, kx = 1, ky = 1) =>
    `translate(${f(x)}px, ${f(y)}px) scale(${f(s * kx)}, ${f(s * ky)}) translate(-36px, -50px)`;
  const pathB = (n: number): Keyframe[] => {
    const sx = n === 1 ? -1 : 1;
    const home = n === 1 ? fx1 : adj; // where it lands: B1 in its own place, B2 beside it
    const k: Keyframe[] = [
      { offset: 0, transform: T(cx0 + sx * 26, front0 + 36, 0.42) },
      { offset: 0.24, transform: T(cx0 + sx * 26, front0 + 36, 0.42), easing: BACK }, // waits for the lid
      {
        offset: 0.48,
        transform: T(cx0 + sx * 33, front0 - 60, 0.5, 0.96, 1.06),
        easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
      }, // out, small
      { offset: 0.67, transform: T(home, fy, 1.1, 0.96, 1.04), easing: OUT }, // lands, grown a touch past full size
      { offset: 0.73, transform: T(home, fy, 1), easing: PULL }, // settles
    ];
    if (n === 1) {
      k.push({ offset: 0.8, transform: T(fx1, fy, 1, 0.96, 1.03), easing: BACK }); // recoils as B2 pulls away
      k.push({ offset: 0.9, transform: T(fx1, fy, 1) });
    } else {
      // stretched wide on the way, a hair of overshoot, then still
      k.push({ offset: 0.82, transform: T(adj + (fx2 - adj) * 0.7, fy, 1, 1.22, 0.94), easing: BACK });
      k.push({ offset: 0.91, transform: T(fx2, fy, 1) });
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
  // The words are written: each letter wipes in from its left edge (a narrow slice widening to full) with a small rise,
  // one after the other. "othy" fills the gap between the Bs while B2 stretches out; "ox" follows once B2 is in place.
  const STEP = 0.035;
  const WRITE = 0.06; // one letter's own wipe, of SEQ
  for (const g of svg.querySelectorAll<SVGGElement>('.ltr')) {
    const l = word.letters[Number(g.dataset.i)]!;
    const at = l.i > 5 ? 0.9 + (l.i - 6) * 0.033 : 0.74 + (l.i - 1) * STEP;
    const x = WX + l.x;
    add(
      g,
      [
        { offset: 0, transform: `translate(${f(x)}px, ${CAP + 7}px) scale(0.15, 0.94)` },
        { offset: at, transform: `translate(${f(x)}px, ${CAP + 7}px) scale(0.15, 0.94)`, easing: OUT },
        { offset: at + WRITE, transform: `translate(${f(x)}px, ${CAP}px) scale(1, 1)` },
        { offset: 1, transform: `translate(${f(x)}px, ${CAP}px) scale(1, 1)` },
      ],
      SEQ,
    );
    // solid within a few frames: overlapping letters of one colour merge, half-transparent ones would show the seams
    add(g, [{ opacity: 0 }, { opacity: 0, offset: at }, { opacity: 1, offset: at + 0.02 }, { opacity: 1 }], SEQ);
  }
}

export interface Splash {
  el: HTMLElement;
  anims: Animation[];
  seek: (t: number) => void;
  /** Jump to the assembled page: the overlay fades out, every element is back to its own style. */
  skip: () => void;
}

/**
 * Build the overlay and every animation, paused at 0, and take the page over from the `bb-intro` class (the
 * animations hold the hidden state from here). `target` is the header lockup the flight ends on.
 */
export function createSplash(doc: Document, target: Element | null): Splash {
  const el = doc.createElement('div');
  el.className = 'bb-splash';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;inset:0;z-index:60;pointer-events:none;contain:strict;';
  const stage = doc.createElement('div');
  // the stage's width: the lockup ends at 72 % of it, so about 570 px wide on a desktop and 260 px on a phone
  stage.style.cssText =
    'position:absolute;inset-inline-start:50%;inset-block-start:42%;inline-size:min(800px, 92vw);aspect-ratio:5 / 2;translate:-50% -50%;';
  stage.innerHTML = splashSVG();
  const svg = stage.firstElementChild as SVGSVGElement;
  svg.style.cssText = 'display:block;inline-size:100%;block-size:100%;overflow:visible;transform-origin:0 0;';
  el.append(stage);
  doc.body.append(el);

  const anims: Animation[] = [];
  const add = (node: Element, k: Keyframe[], duration: number, o: KeyframeAnimationOptions = {}) => {
    const a = node.animate(k, { duration, fill: 'both', easing: 'linear', ...o });
    a.pause();
    anims.push(a);
  };
  sequence(svg, add);

  // The flight: map the stage's lockup box onto the header lockup's box, then hand over to it.
  const R = svg.getBoundingClientRect();
  const k = R.width / W;
  const to = target?.getBoundingClientRect();
  const t = (ms: number) => ms / LAND;
  if (to && to.width > 0) {
    const s = to.width / (LW * k);
    const at = `translate(${f(to.left - R.left - X0 * k * s)}px, ${f(to.top - R.top - ICON_Y * k * s)}px) scale(${f(s)})`;
    add(
      svg,
      [
        { offset: 0, transform: 'none', opacity: 1 },
        { offset: t(SEQ), transform: 'none', opacity: 1, easing: 'cubic-bezier(0.5, 0, 0.2, 1)' },
        { offset: t(LAND - 90), transform: at, opacity: 1 },
        { offset: 1, transform: at, opacity: 0 },
      ],
      LAND,
    );
  } else {
    add(svg, [{ opacity: 1 }, { opacity: 1, offset: t(SEQ) }, { opacity: 0 }], LAND);
  }

  const flight = anims[anims.length - 1]!;

  // The page assembles round the flight. Opacity and the `translate` property only: no layout moves, and an element's
  // own `transform` is left alone.
  const items = INTRO_ITEMS.map((q) => doc.querySelector(q));
  if (items[0]) add(items[0], [{ opacity: 0 }, { opacity: 1 }], 140, { delay: LAND - 140 });
  items.slice(1).forEach((node, i) => {
    if (!node) return;
    // the console's window carries a blur of its own: it only fades, so nothing re-blurs while it moves
    const still = false;
    add(
      node,
      [
        { opacity: 0, translate: still ? '0 0' : `0 ${STAGGER.rise}px` },
        { opacity: 1, translate: '0 0' },
      ],
      STAGGER.each,
      { delay: STAGGER.start + i * STAGGER.step, easing: OUT },
    );
  });

  const seek = (ms: number) => {
    for (const a of anims) {
      a.pause();
      a.currentTime = Math.max(0, Math.min(ms, DURATION));
    }
  };
  seek(0);
  doc.documentElement.classList.remove('bb-intro'); // the animations hold the hidden state from here
  let gone = false;
  const pageAnims = anims.filter((a) => (a.effect as KeyframeEffect | null)?.target?.closest?.('.bb-splash') == null);
  const skip = () => {
    if (gone) return;
    gone = true;
    // The overlay's own animations (the flight ends at opacity 0) must outlive the page's: cancelling the flight puts the
    // lockup back at the centre of the screen, which is the flash after the landing. Hide the overlay first, then free the page.
    const landed = flight.playState === 'finished' ? LAND : ((flight.currentTime as number | null) ?? 0);
    for (const a of pageAnims) a.cancel(); // every page element back to its own style: the assembled page
    if (landed >= LAND - 40) {
      el.remove();
      for (const a of anims) a.cancel();
      return;
    }
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    window.setTimeout(() => {
      el.remove();
      for (const a of anims) a.cancel();
    }, 180);
  };
  return { el, anims, seek, skip };
}

const SKIP_ON = ['keydown', 'pointerdown', 'wheel', 'touchstart', 'scroll'] as const;

/**
 * Play it once. Any key, click, tap, wheel or scroll jumps to the assembled page (nothing is prevented: the event
 * still does what it does). `hold` (?splash=hold) builds it paused at 0 for a screenshot harness to seek.
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
  // a stalled animation clock (background tab, headless) must not leave the page hidden
  const timer = window.setTimeout(done, DURATION + 300);
  for (const a of sp.anims) a.play();
  void Promise.all(sp.anims.map((a) => a.finished)).then(done, () => {});
  return sp;
}
