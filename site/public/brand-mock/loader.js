// The opening-box loader: a box opens, two Bs rise out of it, and they pull the rest of the word out between them
// until "BothyBox" stands in its lockup. Pure inline SVG animated with the Web Animations API, no library.
//
// The SVG is written in its FINAL state (the static lockup). Animations run with fill: 'backwards' (each holds its
// first frame through its delay), so: no JavaScript, or prefers-reduced-motion, or an animation that never starts,
// all leave the lockup on screen. Nothing changes size; the stage is the lockup's own box, so there is no layout shift.
import { GLYPHS, layoutWord, byId, bPath, INK, PAPER, AMBER } from './concepts.js';

export const DURATION = 2000; // ms, the whole sequence
const W = 1000;
const H = 400;
// Final lockup: icon 120 high, a 36 gap, then the wordmark on cap height 100.
const ICON = 120;
const GAP = 36;
const word = layoutWord();
const X0 = Math.round((W - (ICON + GAP + word.width)) / 2);
const WX = X0 + ICON + GAP; // wordmark origin x
const CAP = 160; // cap-top y of the wordmark
const ICON_Y = CAP + 50 - ICON / 2;
// The box at the start: centred, big.
const S0 = 3.4;
const BOX0 = { x: W / 2 - 32 * S0, y: 215 - 32 * S0, s: S0 };
const BOX1 = { x: X0, y: ICON_Y, s: ICON / 64 };

// Easing: out with a small overshoot, and a plain out for things that must not overshoot.
const BACK = 'cubic-bezier(0.34, 1.32, 0.52, 1)';
const OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';

const boxT = (b) => `translate(${b.x}px, ${b.y}px) scale(${b.s})`;
const f = (n) => +n.toFixed(2);

/**
 * The three boxes. Each draws, in the 64 grid: `back` (behind the Bs), `front` (in front of them), `lids` (each with a
 * hinge and an open angle or an open transform), and names the concept whose icon the box turns into at the end.
 */
const BOXES = {
  carton: {
    name: 'Carton',
    icon: 'pair',
    note: 'A flat carton; both flaps swing open on their hinges, the pair rises, the carton closes into the BB tile.',
    rim: 29,
    back: `<path fill="${PAPER}" opacity=".28" d="M10 23H54V30H10Z"/>`,
    front: `<path fill="${PAPER}" d="M8 29H56V58H8Z"/><path fill="${INK}" opacity=".16" d="M8 29H56V33H8Z"/>`,
    lids: [
      { d: 'M8 25H32V29H8Z', origin: '0% 100%', open: 'rotate(-148deg)' },
      { d: 'M32 25H56V29H32Z', origin: '100% 100%', open: 'rotate(148deg)' },
    ],
  },
  cube: {
    name: 'Cube',
    icon: 'iso',
    note: 'An isometric box; its amber lid pops and tips back, the pair rises, the lid drops shut and the faces take their Bs.',
    rim: 26,
    back: `<path fill="${INK}" d="M32 6L56 18L32 30L8 18Z"/><path fill="${PAPER}" opacity=".3" d="M32 6L56 18L32 30L8 18Z"/>`,
    front: `<path fill="${PAPER}" d="M8 18L32 30V58L8 46Z"/><path fill="#b1b0ad" d="M32 30L56 18V46L32 58Z"/>`,
    lids: [
      { d: 'M32 6L56 18L32 30L8 18Z', fill: AMBER, origin: '0% 50%', open: 'translate(-6px, -22px) rotate(-24deg)' },
    ],
  },
  bothy: {
    name: 'Bothy',
    icon: 'hut',
    note: 'The hut itself is the box: its roof lifts like a lid, the pair climbs out, the roof settles and the window lights.',
    back: `<path fill="${PAPER}" opacity=".28" d="M11 24H42V31H11Z"/>`,
    rim: 24,
    front: `<path fill="${PAPER}" d="M11 56V24H42V31L39.5 33.5H43A11.25 11.25 0 0 1 43 56Z"/>`,
    lids: [{ d: 'M11 24.5L26.5 8.5L42 24.5Z', origin: '0% 100%', open: 'translate(-1px, -17px) rotate(-11deg)' }],
  },
};
export const LOADERS = Object.entries(BOXES).map(([id, b]) => ({ id, name: b.name, icon: b.icon, note: b.note }));

/** The loader's SVG markup, in its final (static lockup) state. */
export function loaderSVG(id, { label = 'BothyBox' } = {}) {
  const box = BOXES[id];
  const icon = byId(box.icon);
  const B1 = word.letters[0];
  const B2 = word.letters[5];
  const bGlyph = (cls) => `<path class="${cls}" d="${GLYPHS.B.d}"/>`;
  const bAt = (l, cls) =>
    `<g class="b ${cls}" data-b="${l === B1 ? 1 : 2}" style="transform: translate(${WX + l.x + 36}px, ${CAP + 50}px) translate(-36px, -50px)">${bGlyph('')}</g>`;
  const rest = word.letters
    .filter((l) => l.ch !== 'B')
    .map(
      (l) =>
        `<g class="ltr" data-i="${l.i}" style="transform: translate(${WX + l.x}px, ${CAP}px)"><path d="${l.d}"/></g>`,
    )
    .join('');
  const lids = box.lids
    .map(
      (l, k) =>
        `<path class="lid" data-k="${k}" fill="${l.fill ?? PAPER}" d="${l.d}" style="transform-box: fill-box; transform-origin: ${l.origin}"/>`,
    )
    .join('');
  const bodyIcon = icon.body({ fg: PAPER, bg: INK, accent: AMBER });
  return (
    `<svg class="loader" data-loader="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">` +
    `<g fill="${PAPER}" fill-rule="evenodd">` +
    // lids sit behind the Bs, so a lifted lid never hides them as they climb out
    `<g class="box box-back" style="transform: ${boxT(BOX1)}; opacity: 0">${box.back}${lids}</g>` +
    `<g class="inside">${bAt(B1, 'b-in')}${bAt(B2, 'b-in')}</g>` +
    `<g class="box box-front" style="transform: ${boxT(BOX1)}; opacity: 0">${box.front}</g>` +
    `<g class="final-icon" style="transform: ${boxT(BOX1)}">${bodyIcon}</g>` +
    `<g class="word">${rest}${bAt(B1, 'b-out')}${bAt(B2, 'b-out')}</g>` +
    `</g></svg>`
  );
}

/**
 * Build the animations on a rendered loader SVG. Returns { play, seek, finish, anims }.
 * Every animation is created paused at 0 so `seek(t)` is deterministic (the screenshot harness and the scrubber use it).
 */
export function animate(svg) {
  const id = svg.dataset.loader;
  const box = BOXES[id];
  const anims = [];
  const add = (el, frames, o) => {
    const a = el.animate(frames, { fill: 'both', easing: 'linear', ...o });
    a.pause();
    anims.push(a);
    return a;
  };

  // 1. the box: in (0-300), holds while it opens and the pair rises, then flies to the icon slot (1000-1600)
  for (const g of svg.querySelectorAll('.box')) {
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
        { offset: 0.8, transform: boxT(BOX1), opacity: 1 },
        { offset: 0.86, transform: boxT(BOX1), opacity: 1, easing: OUT },
        { offset: 0.96, transform: boxT(BOX1), opacity: 0 },
        { offset: 1, transform: boxT(BOX1), opacity: 0 },
      ],
      { duration: DURATION },
    );
  }
  // 2. the lid(s): open 250-650 with a tiny overshoot, close again as the box lands (1250-1600)
  box.lids.forEach((l, k) => {
    const el = svg.querySelector(`.lid[data-k="${k}"]`);
    add(
      el,
      [
        { offset: 0, transform: 'none' },
        { offset: 0.125, transform: 'none', easing: BACK },
        { offset: 0.33, transform: l.open },
        { offset: 0.52, transform: l.open, easing: BACK },
        { offset: 0.72, transform: 'none' },
        { offset: 1, transform: 'none' },
      ],
      { duration: DURATION },
    );
  });
  // 3. the final icon fades in where the box lands (1700-1950)
  add(svg.querySelector('.final-icon'), [{ opacity: 0 }, { opacity: 0, offset: 0.84, easing: OUT }, { opacity: 1 }], {
    duration: DURATION,
  });

  // 4. the two Bs. Inside copy (behind the front) for the rise; outside copy (on top) for the flight. Same path.
  const B1 = word.letters[0];
  const B2 = word.letters[5];
  const cx0 = W / 2;
  const front0 = BOX0.y + box.rim * S0; // top edge of the front, stage units
  const fy = CAP + 50;
  const fx1 = WX + B1.x + 36; // B1's final centre
  const fx2 = WX + B2.x + 36; // B2's final centre
  const adj = fx1 + 78; // B2 parked right beside B1, the pair as it came out of the box
  // Timeline, as fractions of DURATION: rise 0.24-0.5, fly to the word's start 0.5-0.62, pull 0.62-0.82.
  const PULL = 'cubic-bezier(0.55, 0, 0.25, 1)';
  const P = [0.62, 0.74, 0.82]; // pull keyframes; B2's progress at each is 0, 0.8, 1
  const PP = [0, 0.8, 1];
  const T = (x, y, s, kx = 1, ky = 1) =>
    `translate(${f(x)}px, ${f(y)}px) scale(${f(s * kx)}, ${f(s * ky)}) translate(-36px, -50px)`;
  const pathB = (n) => {
    const sx = n === 1 ? -1 : 1;
    const start = [cx0 + sx * 26, front0 + 36];
    const up = [cx0 + sx * 33, front0 - 60];
    const k = [
      { offset: 0, transform: T(...start, 0.6) },
      { offset: 0.24, transform: T(...start, 0.6), easing: BACK }, // waits for the lid
      { offset: 0.5, transform: T(...up, 0.82, 0.96, 1.06), easing: OUT }, // risen, a touch tall from the push
      { offset: 0.62, transform: T(n === 1 ? fx1 : adj, fy, 1), easing: n === 1 ? OUT : PULL },
    ];
    if (n === 1) {
      // B1 holds its ground and recoils a little as B2 pulls away
      k.push({ offset: 0.7, transform: T(fx1, fy, 1, 0.95, 1.03), easing: BACK });
      k.push({ offset: 0.82, transform: T(fx1, fy, 1) });
    } else {
      // B2 pulls the word out: stretched wide mid-pull, overshoots a hair, settles
      k.push({ offset: P[1], transform: T(adj + (fx2 - adj) * PP[1], fy, 1, 1.16, 0.95), easing: BACK });
      k.push({ offset: P[2], transform: T(fx2, fy, 1) });
    }
    k.push({ offset: 1, transform: T(n === 1 ? fx1 : fx2, fy, 1) });
    return k;
  };
  for (const g of svg.querySelectorAll('.b')) {
    add(g, pathB(+g.dataset.b), { duration: DURATION });
    // The inside copy shows once the box front is opaque and hands over to the outside copy at 0.5, when both are
    // above the box; identical frames make the swap invisible.
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
      { duration: DURATION },
    );
  }
  // 5. the letters, on the same clock as B2's pull: "othy" spreads between B1 and the moving B2 like a bellows,
  //    "ox" unfolds out of B2's back. Squeezed and hidden at the start of the pull, set at its end.
  const b1Right = WX + B1.x + 64;
  for (const g of svg.querySelectorAll('.ltr')) {
    const l = word.letters[+g.dataset.i];
    const tail = l.i > 5;
    const from = tail ? adj - 8 : b1Right - 10;
    const to = WX + l.x;
    const k = [{ offset: 0, transform: `translate(${f(from)}px, ${CAP}px) scale(0.12, 1)` }];
    k.push({ offset: P[0], transform: `translate(${f(from)}px, ${CAP}px) scale(0.12, 1)`, easing: PULL });
    k.push({
      offset: P[1],
      transform: `translate(${f(from + (to - from) * PP[1])}px, ${CAP}px) scale(0.86, 1)`,
      easing: BACK,
    });
    k.push({ offset: P[2], transform: `translate(${to}px, ${CAP}px) scale(1, 1)` });
    k.push({ offset: 1, transform: `translate(${to}px, ${CAP}px) scale(1, 1)` });
    add(g, k, { duration: DURATION });
    // solid almost at once: overlapping letters of one colour merge, half-transparent ones would show the seams
    add(
      g,
      [{ opacity: 0 }, { opacity: 0, offset: P[0] + 0.03 }, { opacity: 1, offset: P[0] + 0.031 }, { opacity: 1 }],
      {
        duration: DURATION,
      },
    );
  }

  const seek = (t) => {
    for (const a of anims) {
      a.pause();
      a.currentTime = Math.max(0, Math.min(t, DURATION));
    }
  };
  seek(0);
  return {
    anims,
    seek,
    play: () => {
      seek(0);
      for (const a of anims) a.play();
    },
    finish: () => seek(DURATION),
    done: () => Promise.all(anims.map((a) => a.finished.catch(() => {}))),
  };
}

export const LOCKUP = { W, H, ICON, GAP, X0, WX, CAP };
// kept for export.mjs: one B path at a size, for the lockup files
export { bPath };
