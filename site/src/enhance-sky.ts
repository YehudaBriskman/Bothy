import { fmt } from './sky/keys.ts';
import { startSky } from './sky/engine.ts';

/**
 * The lazy sky island (build plan S3). Loaded by enhance.ts only on a page that has `[data-sky]`, after the page has
 * loaded: the hero is already real text on a CSS still before this runs. It starts the live sky (or, on touch, a
 * narrow screen, Save-Data or no WebGL, just picks the still's hour class), then wires the dial and pause.
 */
export function mountSky(section: HTMLElement): void {
  const story = section.closest<HTMLElement>('[data-story]');
  const layer = document.querySelector<HTMLElement>('[data-sky-layer]');
  const ui = section.querySelector<HTMLElement>('[data-sky-ui]');
  if (!layer || !ui || !story) return;
  const $ = <T extends Element>(sel: string) => ui.querySelector<T>(sel);
  const hour = $<HTMLInputElement>('[data-sky-hour]');
  const out = $<HTMLOutputElement>('[data-sky-out]');
  const sun = $<SVGElement>('[data-sky-sun]');
  const moon = $<SVGElement>('[data-sky-moon]');
  const now = $<HTMLButtonElement>('[data-sky-now]');
  const pause = $<HTMLButtonElement>('[data-sky-pause]');
  const dbg = $<HTMLElement>('[data-sky-dbg]');
  const base = document.querySelector<HTMLMetaElement>('meta[name=bothy-base]')?.content ?? '/';
  const lit = [...section.querySelectorAll<HTMLElement>('h1, .ch-line, .ch-lede')];
  if (new URLSearchParams(location.search).get('debug') && dbg) dbg.hidden = false;

  const sky = startSky({
    layer,
    story,
    section,
    lit,
    photoBase: `${base}sky/`,
    debugEl: dbg,
    onHour: ({ hour: h, live, name, sunUp }) => {
      if (hour) {
        hour.value = String(h);
        hour.setAttribute('aria-valuetext', `${fmt(h)}, ${name}`);
      }
      if (out) out.textContent = `${fmt(h)}${live ? '' : ' *'}`;
      if (sun) sun.toggleAttribute('hidden', !sunUp);
      if (moon) moon.toggleAttribute('hidden', sunUp);
      if (now) now.hidden = live;
    },
    onStill: () => {
      // nothing animates in the still: the controls that move things have nothing to do
      if (pause) pause.hidden = true;
    },
  });
  section.classList.add('sky-on');

  hour?.addEventListener('input', () => sky.setHour(+hour.value));
  now?.addEventListener('click', () => sky.now());
  pause?.addEventListener('click', () => {
    const paused = sky.togglePause();
    pause.toggleAttribute('data-paused', paused); // the label says the state; aria-pressed would contradict it (APG)
    pause.textContent = (paused ? pause.dataset.play : pause.dataset.pause) ?? pause.textContent;
  });
  if (!sky.animated()) {
    if (pause) pause.hidden = true;
  }
  ui.hidden = false;
}
