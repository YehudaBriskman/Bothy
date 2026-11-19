/**
 * The camera over the console's canvas (section 03, option C). The frame's four views are one canvas; for each beat
 * (and each part of a beat) the canvas glides and zooms to the part being described, and a soft vignette dims what is
 * out of focus. Transform and opacity only; the glide itself is a CSS transition (story.css `.cf-cam`), so a fast
 * scroll never stutters the canvas: it just heads for the newest target.
 *
 * Created by src/story/console.ts only when the demo is live (wide window, motion allowed). Everything it adds is
 * decoration: an aria-hidden vignette, and the panels move into one wrapper that has no role. `reset()` puts the whole
 * canvas back.
 */
interface Focus {
  els: (HTMLElement | null | undefined)[];
  /** the zoom wanted; the focused part is never cut off, so a large part zooms less */
  z: number;
}

export interface Lens {
  show(beat: number, u: number): void;
  reset(): void;
}

const q = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const qa = <T extends HTMLElement>(root: ParentNode, sel: string) => [...root.querySelectorAll<T>(sel)];

/** Position of el inside `cam` in layout pixels (not touched by any transform), or null when it is not displayed. */
function boxIn(el: HTMLElement, cam: HTMLElement) {
  if (!el.offsetParent) return null;
  let x = 0;
  let y = 0;
  let n: HTMLElement | null = el;
  while (n && n !== cam) {
    x += n.offsetLeft;
    y += n.offsetTop;
    n = n.offsetParent as HTMLElement | null;
  }
  return n === cam ? { x, y, w: el.offsetWidth, h: el.offsetHeight } : null;
}

export function setupLens(cf: HTMLElement, body: HTMLElement): Lens | null {
  if (q(body, '.cf-cam')) return null;
  const cam = document.createElement('div');
  cam.className = 'cf-cam';
  while (body.firstChild) cam.appendChild(body.firstChild);
  body.appendChild(cam);
  const vignette = document.createElement('div');
  vignette.className = 'cf-vignette';
  vignette.setAttribute('aria-hidden', 'true');
  body.appendChild(vignette);

  const rows = qa(cf, '.svc-tr');
  const tiles = qa(cf, '.ch-tile');
  const fields = qa(cf, '.cf-field');

  function focusFor(beat: number, u: number): { key: string; f: Focus | null } {
    switch (beat) {
      case 0:
        if (u < 0.1) return { key: '0a', f: null };
        if (u < 0.4) return { key: '0b', f: { els: [fields[0]], z: 1.7 } };
        if (u < 0.75) return { key: '0c', f: { els: [fields[1]], z: 1.7 } };
        return { key: '0d', f: { els: [q(cf, '.cf-login-btn')], z: 1.7 } };
      case 1:
        return u < 0.45
          ? { key: '1a', f: { els: [q(cf, '.cf-scanbar')], z: 1.5 } }
          : { key: '1b', f: { els: rows.slice(0, 4), z: 1.45 } };
      case 2: {
        const i = Math.min(rows.length - 1, Math.floor(u * rows.length));
        return { key: `2-${i}`, f: { els: [rows[i]], z: 1.6 } };
      }
      case 3:
        return { key: '3', f: { els: [q(cf, '.cf-detail') ?? rows[0]], z: 1.55 } };
      case 4:
        return u < 0.5
          ? { key: '4a', f: { els: tiles.slice(0, 2), z: 1.5 } }
          : { key: '4b', f: { els: [q(cf, '.cf-spark')], z: 1.7 } };
      case 5:
        return { key: '5', f: { els: [q(cf, '.fx-doc') ?? q(cf, '.rd-main')], z: 1.5 } };
      default:
        return u < 0.55
          ? { key: '6a', f: { els: [q(cf, '.cf-cmd')], z: 1.7 } }
          : { key: '6b', f: { els: [q(cf, '.cf-mods')], z: 1.5 } };
    }
  }

  let shown = '';
  function apply(f: Focus | null): boolean {
    const W = body.clientWidth;
    const H = body.clientHeight;
    if (!f || W < 1 || H < 1) {
      cam.style.transform = '';
      vignette.style.opacity = '0';
      return true;
    }
    const boxes = f.els.map((e) => (e ? boxIn(e, cam) : null));
    if (boxes.length === 0 || boxes.some((b) => !b)) return false; // not laid out yet: try again on the next call
    const x0 = Math.min(...boxes.map((b) => b!.x));
    const y0 = Math.min(...boxes.map((b) => b!.y));
    const x1 = Math.max(...boxes.map((b) => b!.x + b!.w));
    const y1 = Math.max(...boxes.map((b) => b!.y + b!.h));
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    const z = Math.max(1, Math.min(f.z, W / (w * 1.05), H / (h * 1.05)));
    // centre the part, but never slide the canvas off its own edge
    const tx = Math.min(0, Math.max(W - W * z, W / 2 - z * (x0 + w / 2)));
    const ty = Math.min(0, Math.max(H - H * z, H / 2 - z * (y0 + h / 2)));
    cam.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${z.toFixed(3)})`;
    vignette.style.opacity = '1';
    return true;
  }

  return {
    show(beat, u) {
      const { key, f } = focusFor(beat, u);
      if (key === shown) return;
      if (apply(f)) shown = key;
    },
    reset() {
      shown = '';
      cam.style.transform = '';
      vignette.style.opacity = '0';
    },
  };
}
