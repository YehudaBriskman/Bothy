// Mock driver for the S6 scene: ?hour=18.5 (default: the visitor's clock), ?still=1 (no motion), ?manual=1 (no clock tick).
// The sky here is photographs cross-faded and tinted, an approximation of the final shader sky, only so the owner sees
// hills and sky together. The hills are the real thing: scene-core.js builds the markup, the hour table grades it.
import { sceneMarkup, sceneVars } from './scene-core.js';
import { sample, localHour, fmt, wrapHour } from '../sky-spike/sky-keys.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const scene = $('scene');
scene.innerHTML = sceneMarkup();

const phone = matchMedia('(max-aspect-ratio: 4/5)').matches;
for (const k of ['day', 'dusk', 'night']) $(`sky-${k}`).src = `../sky/${k}-${phone ? 'phone' : 'desk'}.webp`;

let hour = q.has('hour') ? wrapHour(parseFloat(q.get('hour'))) : localHour();
const rgb = (c) => `rgb(${c.map((v) => Math.round(v)).join(',')})`;

function apply(h) {
  hour = wrapHour(h);
  const s = sample(hour);
  ['day', 'dusk', 'night'].forEach((k, i) => ($(`sky-${k}`).style.opacity = String(s.w[i])));
  // Approximate grade: brightness/saturation by filter, per-channel gain by a multiply layer.
  const peak = Math.max(...s.gain);
  const stage = $('stage');
  stage.style.setProperty('--top', rgb(s.top));
  stage.style.setProperty('--bot', rgb(s.bot));
  for (const k of ['day', 'dusk', 'night']) {
    $(`sky-${k}`).style.filter = `brightness(${Math.min(1.6, s.exp * (peak > 1 ? 1 : 1))}) saturate(${s.sat})`;
  }
  $('sky-tint').style.background = rgb(s.gain.map((g) => (g / peak) * 255));
  const sunX = 10 + 80 * Math.min(1, Math.max(0, (hour - 6.25) / 12.5));
  $('sky-glow').style.background = `radial-gradient(ellipse 70% 40% at ${sunX}% 78%, rgba(${s.glow
    .slice(0, 3)
    .map((v) => Math.round(v * 255))
    .join(',')},${(s.glow[3] * 0.55).toFixed(2)}), transparent 70%)`;
  const vars = sceneVars(s);
  for (const [k, v] of Object.entries(vars)) scene.style.setProperty(k, v);
  $('hour').value = String(hour);
  $('hour-out').textContent = `${fmt(hour)} ${s.name}`;
}
$('hour').addEventListener('input', (e) => apply(parseFloat(e.target.value)));
apply(hour);
if (!q.has('manual') && !q.has('hour')) setInterval(() => apply(localHour()), 60000);

// Motion: only if the visitor allows it. Hidden tab, ?still and the pause box all freeze it.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let paused = q.has('still') || reduce;
const setPaused = (p) => {
  paused = p;
  scene.classList.toggle('is-paused', p || document.hidden);
  $('pause').checked = p;
};
setPaused(paused);
$('pause').addEventListener('change', (e) => setPaused(e.target.checked));
document.addEventListener('visibilitychange', () => setPaused(paused));

// Pointer parallax: fine pointers only, a few pixels, eased, and it stops asking for frames once it has settled.
if (matchMedia('(pointer: fine) and (hover: hover)').matches && !reduce && !q.has('still')) {
  let tx = 0;
  let ty = 0;
  let cx = 0;
  let cy = 0;
  let raf = 0;
  const tick = () => {
    cx += (tx - cx) * 0.08;
    cy += (ty - cy) * 0.08;
    scene.style.setProperty('--px', cx.toFixed(3));
    scene.style.setProperty('--py', cy.toFixed(3));
    raf = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.002 ? requestAnimationFrame(tick) : 0;
  };
  addEventListener('pointermove', (e) => {
    tx = (e.clientX / innerWidth) * 2 - 1;
    ty = (e.clientY / innerHeight) * 2 - 1;
    if (!raf) raf = requestAnimationFrame(tick);
  });
}

window.__scene = { setHour: apply, hour: () => hour };
