/**
 * The reading wheels ("What a bothy is", "One console for one machine"). The markup is complete without this file;
 * with it (and without reduced motion) each section pins and its lines roll up past a centre line as you scroll:
 * the line at the centre is lit and has just been read, the others fall away in opacity and size. The scroll
 * position is the only input (a pure function of it, so scrolling back rewinds), and nothing runs off a frame clock.
 */
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const PER = 0.11; // scroll travel per line, in viewport heights: a quick roll, a line at a time
const HOLD = 0.07; // a short hold on the last line before the section lets go
const MID = 0.54; // where the centre line sits, as a fraction of the stage height (just under the heading)

if (!reduced) {
  const wheels = [...document.querySelectorAll<HTMLElement>('[data-wheel]')].map((sec) => {
    const track = sec.querySelector<HTMLElement>('.wh-track')!;
    const roll = sec.querySelector<HTMLElement>('.wh-roll')!;
    const lines = [...roll.querySelectorAll<HTMLElement>('.wl')];
    return { track, roll, lines, centres: [] as number[] };
  });
  if (wheels.length) {
    document.documentElement.classList.add('js-wheel');
    const measure = () => {
      for (const w of wheels) {
        w.centres = w.lines.map((l) => l.offsetTop + l.offsetHeight / 2);
        // a screen to pin, then PER of a screen of travel per line, and a short hold on the last one
        w.track.style.setProperty('--wh-len', `${Math.round(100 + ((w.lines.length - 1) * PER + HOLD) * 100)}svh`);
      }
    };
    const draw = () => {
      const vh = innerHeight;
      for (const w of wheels) {
        const r = w.track.getBoundingClientRect();
        if (r.bottom < -vh || r.top > vh * 2) continue;
        const n = w.lines.length;
        const f = clamp(-r.top / (vh * PER), 0, n - 1); // the wheel rolls from the instant the stage pins
        const i0 = Math.floor(f);
        const i1 = Math.min(n - 1, i0 + 1);
        const c0 = w.centres[i0] ?? 0;
        const c1 = w.centres[i1] ?? c0;
        const at = c0 + (c1 - c0) * (f - i0);
        w.roll.style.transform = `translate3d(0, ${(vh * MID - at).toFixed(1)}px, 0)`;
        w.lines.forEach((l, k) => {
          const d = ((w.centres[k] ?? 0) - at) / (vh * 0.3); // 0 at the centre line, +1 a third of a screen below
          const a = Math.abs(d);
          // the reading sweep: a line below the centre is dim, crosses to lit as it arrives, and stays lit above
          const sweep = d <= 0 ? 1 : clamp(1 - d / 0.8);
          l.style.setProperty('--o', clamp(1 - a * 0.62, 0.12, 1).toFixed(3));
          l.style.setProperty('--s', (1 - Math.min(a, 2) * 0.045).toFixed(3));
          l.style.setProperty('--r', sweep.toFixed(3));
        });
      }
    };
    const again = () => {
      measure();
      draw();
    };
    again();
    addEventListener('scroll', draw, { passive: true });
    addEventListener('resize', again);
    void document.fonts?.ready.then(again);
    // keyboard: a link inside the wheel was focused off the centre, so bring the wheel round to it
    for (const w of wheels)
      w.roll.addEventListener('focusin', (e) => {
        const line = (e.target as HTMLElement).closest<HTMLElement>('.wl');
        const k = line ? w.lines.indexOf(line) : -1;
        if (k < 0) return;
        const r = w.track.getBoundingClientRect();
        scrollTo({ top: scrollY + r.top + k * PER * innerHeight, behavior: 'instant' });
      });
  }
}
