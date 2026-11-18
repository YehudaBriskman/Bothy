// The brand-options gallery: builds every card, stage and lockup from concepts.js and loader.js. No dependencies,
// nothing from another origin. Test hooks: window.__brand.seek(id, ms) and window.__brand.ready.
import { CONCEPTS, byId, iconSVG, wordmarkSVG, lockupSVG, INK, AMBER } from './concepts.js';
import { LOADERS, loaderSVG, animate, DURATION } from './loader.js';

const $ = (id) => document.getElementById(id);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const dataURL = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

// The three carried forward into loaders, and the one recommended.
const TOP = ['hut', 'pair', 'iso'];
const PICK = 'hut';

// Plain-language scores, judged from the 16 px rasters on this page (not a formula).
const SCORES = {
  pair: { s16: 'fair: the counters close up', own: 'low: a BB monogram is common', story: 'BB, not the box' },
  facing: { s16: 'fair', own: 'avoid: too close to a famous fashion BB', story: 'a box made of Bs' },
  backtoback: { s16: 'fair', own: 'avoid: too close to a famous fashion BB', story: 'weak' },
  hut: { s16: 'good: one shape, two clear holes', own: 'high', story: 'the bothy and the B, at once' },
  crate: { s16: 'poor: thin outline, tiny B', own: 'medium', story: 'the box opening' },
  iso: {
    s16: 'poor at 16, fine at 32',
    own: 'medium: toy blocks, keep away from blue open boxes',
    story: 'BothyBox, literally',
  },
  open: { s16: 'poor: three parts', own: 'medium', story: 'the loader as a still' },
  roof: { s16: 'fair: roof survives, Bs blur', own: 'medium-high', story: 'two Bs under one shelter' },
};

// ── A: cards ───────────────────────────────────────────────────────────────────────────────────────────────────
function raster(svg, size, scale) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  c.className = 'px';
  c.style.inlineSize = c.style.blockSize = `${size * scale}px`;
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', `${size} pixel raster, enlarged`);
  const img = new Image();
  img.onload = () => c.getContext('2d').drawImage(img, 0, 0, size, size);
  img.src = dataURL(svg);
  return c;
}

function card(c, n) {
  const el = document.createElement('article');
  el.className = `card${c.id === PICK ? ' is-top' : ''}`;
  el.id = `c-${c.id}`;
  el.setAttribute('aria-labelledby', `t-${c.id}`);
  const tile = iconSVG(c, 'tile');
  const sc = SCORES[c.id];
  el.innerHTML = `
    <div class="card-head"><span class="num">${String(n).padStart(2, '0')}</span><h3 id="t-${c.id}">${esc(c.name)}</h3>
      ${c.id === PICK ? '<span class="badge">Recommended</span>' : TOP.includes(c.id) ? '<span class="badge" style="background:#cfd3e6">Loader</span>' : ''}</div>
    <p>${esc(c.line)}</p>
    <div class="sizes">
      <figure><span class="ico" style="inline-size:180px;block-size:180px">${iconSVG(c, 'tile', { label: `${c.name} icon, 180 pixels` })}</span><figcaption>180</figcaption></figure>
      <figure><span class="ico" style="inline-size:32px;block-size:32px">${tile}</span><figcaption>32</figcaption></figure>
      <figure><span class="ico" style="inline-size:16px;block-size:16px">${tile}</span><figcaption>16</figcaption></figure>
      <figure data-px><figcaption>16 px, ×4</figcaption></figure>
    </div>
    <div class="grounds" role="group" aria-label="${esc(c.name)} on four grounds">
      <div class="ground g-ink" title="one colour on ink"><span class="ico">${iconSVG(c, 'mono')}</span></div>
      <div class="ground g-dusk" title="one colour on the dusk sky"><span class="ico">${iconSVG(c, 'mono')}</span></div>
      <div class="ground g-day" title="ink tile on the day sky"><span class="ico">${tile}</span></div>
      <div class="ground g-paper" title="light tile"><span class="ico">${iconSVG(c, 'light')}</span></div>
    </div>
    <div class="tabs" aria-label="As a favicon">
      <div class="tabstrip light"><div class="tab on"><img alt="" src="${dataURL(tile)}"><span>BothyBox · a shelter for your machine</span></div><div class="tab off"><span>Docs</span></div></div>
      <div class="tabstrip dark"><div class="tab on"><img alt="" src="${dataURL(tile)}"><span>BothyBox · a shelter for your machine</span></div><div class="tab off"><span>Docs</span></div></div>
    </div>
    <dl class="score"><dt>At 16 px</dt><dd>${esc(sc.s16)}</dd><dt>Ownable</dt><dd>${esc(sc.own)}</dd><dt>Says</dt><dd>${esc(sc.story)}</dd></dl>
    <p>${esc(c.why)}</p>
    <div class="files"><a href="svg/${c.id}.svg">tile.svg</a><a href="svg/${c.id}-mono.svg">mono.svg</a><a href="svg/${c.id}-touch.svg">apple-touch (full bleed).svg</a></div>`;
  el.querySelector('[data-px]').prepend(raster(tile, 16, 4));
  return el;
}

const cards = $('cards');
CONCEPTS.forEach((c, i) => cards.append(card(c, i + 1)));

// ── B: loaders ─────────────────────────────────────────────────────────────────────────────────────────────────
const players = {};
const FRAMES = [300, 700, 1100, 1300, 1450, DURATION];

function stage(l) {
  const el = document.createElement('article');
  el.className = 'stage';
  el.id = `l-${l.id}`;
  el.setAttribute('aria-labelledby', `lt-${l.id}`);
  el.innerHTML = `
    <div class="stage-head"><h3 id="lt-${l.id}">${esc(l.name)} <span class="num">→ ${esc(byId(l.icon).name)}</span></h3><p>${esc(l.note)}</p></div>
    <div class="screen" data-screen>${loaderSVG(l.id)}</div>
    <div class="controls">
      <button type="button" data-play>Replay</button>
      <button type="button" class="ghost" data-sky aria-pressed="false">On the sky</button>
      <label class="scrub">Scrub <input type="range" min="0" max="${DURATION}" step="10" value="${DURATION}" data-scrub aria-describedby="o-${l.id}"><output id="o-${l.id}" data-out>${DURATION} ms</output></label>
    </div>
    <div class="strip" aria-label="The same animation frozen at six moments">${FRAMES.map(
      (t) =>
        `<figure><div class="screen" data-frame="${t}">${loaderSVG(l.id, { label: `${l.name} at ${t} ms` })}</div><figcaption>${t} ms</figcaption></figure>`,
    ).join('')}</div>`;
  const svg = el.querySelector('[data-screen] svg');
  const p = animate(svg);
  players[l.id] = p;
  const out = el.querySelector('[data-out]');
  const scrub = el.querySelector('[data-scrub]');
  const show = (t) => {
    scrub.value = t;
    out.textContent = `${Math.round(t)} ms`;
  };
  p.finish(); // the page opens on the lockup; Replay plays it (or, with reduced motion, just shows it)
  el.querySelector('[data-play]').addEventListener('click', () => {
    if (reduced) {
      p.finish();
      return show(DURATION);
    }
    p.play();
    const tick = () => {
      const t = p.anims[0].currentTime ?? DURATION;
      show(Math.min(t, DURATION));
      if (p.anims[0].playState === 'running') requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  scrub.addEventListener('input', () => {
    p.seek(+scrub.value);
    show(+scrub.value);
  });
  el.querySelector('[data-sky]').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    for (const s of el.querySelectorAll('.screen')) s.classList.toggle('sky', on);
  });
  for (const fr of el.querySelectorAll('[data-frame]')) animate(fr.querySelector('svg')).seek(+fr.dataset.frame);
  return el;
}
const stages = $('stages');
for (const l of LOADERS) stages.append(stage(l));

// Skip: Escape finishes whatever is playing.
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') for (const p of Object.values(players)) p.finish();
});

// Nav idle: the lid part of each loader icon wiggles on hover or focus (CSS, off for reduced motion).
function navIcon(id) {
  const fg = 'currentColor';
  if (id === 'hut') {
    const d = byId('hut').body({ fg, bg: 'transparent', accent: AMBER });
    return (
      `<svg viewBox="0 0 64 64" aria-hidden="true"><clipPath id="nv-lo"><path d="M0 24.5H64V64H0Z"/></clipPath><clipPath id="nv-hi"><path d="M0 0H64V24.5H0Z"/></clipPath>` +
      `<g clip-path="url(#nv-lo)">${d}</g><g class="lidpart" style="transform-origin: 0% 100%"><g clip-path="url(#nv-hi)">${d}</g></g></svg>`
    );
  }
  if (id === 'pair') {
    const s = iconSVG('pair', 'mono');
    const i = s.lastIndexOf('<path');
    return `${s.slice(0, i)}<g class="lidpart" style="transform-origin: 50% 100%">${s.slice(i, -6)}</g></svg>`;
  }
  const s = iconSVG('iso', 'mono');
  const i = s.lastIndexOf('<path');
  return `${s.slice(0, i)}<g class="lidpart" style="transform-origin: 0% 50%">${s.slice(i, -6)}</g></svg>`;
}
const navs = $('navs');
for (const id of TOP) {
  const a = document.createElement('div');
  a.className = 'navbar';
  a.innerHTML = `<a class="nav-brand" href="#c-${id}" aria-label="BothyBox (${esc(byId(id).name)} icon)"><span class="ico">${navIcon(id)}</span><span class="wm">${wordmarkSVG({ title: '' }).replace(' role="img" aria-label=""', ' aria-hidden="true"')}</span></a><span class="links">Docs · Install</span>`;
  navs.append(a);
}

// ── C: lockups ─────────────────────────────────────────────────────────────────────────────────────────────────
const lk = $('lockups');
lk.className = 'lockups';
lk.innerHTML = `
  <div class="lk"><h3>Horizontal</h3><p>The default: nav, footer, the loader's end state. Icon 1.2 × cap height, gap 0.36 × cap.</p>
    <div class="art">${lockupSVG(PICK, 'h', { clear: true })}</div>
    <div class="art on-sky">${lockupSVG(PICK, 'h')}</div>
    <div class="art on-day">${lockupSVG(PICK, 'h', { fill: INK })}</div></div>
  <div class="lk"><h3>Stacked</h3><p>For square places: the OG card's centre, a README header, a sticker.</p>
    <div class="art">${lockupSVG(PICK, 'v', { clear: true })}</div>
    <div class="art on-sky">${lockupSVG(PICK, 'v')}</div></div>
  <div class="lk"><h3>Minimum sizes</h3>
    <p><b>Horizontal: 96 px wide</b> (the wordmark's counters close below that). <b>Stacked: 64 px wide.</b> <b>Icon alone: 16 px.</b> Below these, use the icon alone.</p>
    <div class="art mins">
      <span style="inline-size:96px">${lockupSVG(PICK, 'h')}</span>
      <span style="inline-size:64px">${lockupSVG(PICK, 'v')}</span>
      <span class="ico" style="inline-size:16px;block-size:16px">${iconSVG(PICK, 'tile')}</span>
    </div>
    <p class="cap">96 px · 64 px · 16 px, shown at 1:1</p></div>
  <div class="lk"><h3>The other two, same rules</h3><p>If the owner prefers the plain BB pair or the cube.</p>
    <div class="art">${lockupSVG('pair', 'h')}</div>
    <div class="art">${lockupSVG('iso', 'h')}</div></div>`;

// ── D: recommendation ──────────────────────────────────────────────────────────────────────────────────────────
$('rec').innerHTML = `<div class="rec">
  <div class="panel"><h3>Icon: Bothy B</h3><ul>
    <li><b>Legible at 16 px.</b> One solid shape with two clear holes; the pair and the cube turn to texture at that size (see the ×4 rasters).</li>
    <li><b>Distinctive.</b> A B with a pitched roof says <i>bothy</i> and <i>B</i> in one stroke; it is not a generic letter in a rounded square.</li>
    <li><b>Fits the sky and the ink.</b> One colour, so it sits on black ink and on any hour of the sky; the window can be lit amber, the site's one warm colour, as the story ends at a lit hut.</li>
    <li><b>Keeps the BB idea where it is strongest:</b> in the loader, where two Bs climb out of the hut and pull out the word, and in the wordmark, whose two capitals are those Bs.</li></ul></div>
  <div class="panel"><h3>Loader: Bothy (with Carton as the runner-up)</h3><ul>
    <li><b>Bothy:</b> the hut's roof lifts like a lid, the pair climbs out, the roof settles and the window lights. Same shape as the favicon, so first visit and every tab agree.</li>
    <li><b>Carton</b> is the most literal box opening and pairs with the BB tile, if the owner wants the two Bs in the icon itself.</li>
    <li><b>Cube</b> is the richest at large sizes but the weakest favicon.</li></ul></div>
  <div class="panel"><h3>Trademark sanity (not a search)</h3><ul>
    <li><b>No formal trademark search was done.</b> Before adopting any mark, run one (at least USPTO, EUIPO and the Israeli register) in the software classes.</li>
    <li><b>Avoided:</b> mirrored or back-to-back Bs (Facing, Back to back) sit too close to a famous fashion house's BB monogram.</li>
    <li><b>Kept clear of:</b> a blue open box drawn as rhombi (a well-known file-sync brand), a single letter in a rounded square (a well-known CSS framework), and the lowercase blue "box" wordmark of a storage company. The Cube and Carton should never go blue.</li>
    <li>Letters in square blocks also echo a broadcaster's three-block logo; the Pair keeps both Bs in one tile, not one block each.</li></ul></div>
</div>`;

window.__brand = {
  ready: true,
  seek: (id, t) => players[id].seek(t),
  play: (id) => players[id].play(),
};
