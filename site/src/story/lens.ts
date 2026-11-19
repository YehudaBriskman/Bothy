/**
 * The camera over the console's canvas (section 03, option C). The frame's four views are one canvas; for each beat
 * (and each part of a beat) the canvas glides and zooms to the part being described, and a soft vignette dims what is
 * out of focus. Transform and opacity only. The camera is SCRUBBED, not animated: its pose is a pure function of the
 * scroll (beat + position inside the beat), interpolated between waypoints that hold on a part and glide to the next
 * one, so if the visitor stops scrolling the camera stops where it is and scrolling back rewinds it. There is no CSS
 * transition on it. The boxes of the parts are measured once per layout and cached, so the scroll handler reads
 * nothing from the layout.
 *
 * Created by src/story/console.ts only when the demo is live (wide window, motion allowed). Everything it adds is
 * decoration: an aria-hidden vignette, and the panels move into one wrapper that has no role. `reset()` puts the whole
 * canvas back.
 */
interface Focus {
  els: (HTMLElement | null | undefined)[];
  /** the zoom wanted; the focused part is never cut off, so a large part zooms less */
  z: number;
  /** a part of the (wide) first element, as [from, share] of its width: used when the whole of it is too wide to zoom on */
  crop?: [number, number];
}

/** The camera holds `f` from u=a to u=b (null: the wide shot), then glides to the next waypoint. */
interface Way {
  a: number;
  b: number;
  id: string;
  f: Focus | null;
}

interface Pose {
  tx: number;
  ty: number;
  z: number;
}
const WIDE: Pose = { tx: 0, ty: 0, z: 1 };
const sm = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

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

  /** Every beat opens and closes on the wide shot, so the switch between views is never a jump of the camera. */
  function planFor(beat: number): Way[] {
    const W = (a: number, b: number, id: string, f: Focus | null): Way => ({ a, b, id, f });
    const wide = (a: number, b: number) => W(a, b, 'wide', null);
    switch (beat) {
      case 0:
        return [
          wide(0, 0.06),
          W(0.16, 0.44, '0u', { els: [fields[0]], z: 1.7 }),
          W(0.54, 0.76, '0p', { els: [fields[1]], z: 1.7 }),
          W(0.84, 0.95, '0b', { els: [q(cf, '.cf-login-btn')], z: 1.7 }),
          wide(0.99, 1),
        ];
      case 1:
        return [
          wide(0, 0.04),
          W(0.1, 0.5, '1a', { els: [q(cf, '.cf-scanbar')], z: 1.6, crop: [0.55, 0.45] }),
          W(0.62, 0.9, '1b', { els: rows.slice(0, 4), z: 1.45 }),
          wide(0.99, 1),
        ];
      case 2: {
        const n = Math.min(rows.length, 5);
        const out: Way[] = [wide(0, 0.04)];
        for (let i = 0; i < n; i++) {
          const a = 0.1 + (0.8 * i) / n;
          const b = 0.1 + (0.8 * (i + 1)) / n - 0.06;
          out.push(W(a, Math.max(a, b), `2-${i}`, { els: [rows[i]], z: 1.6 }));
        }
        out.push(wide(0.99, 1));
        return out;
      }
      case 3:
        return [
          wide(0, 0.06),
          W(0.12, 0.26, '3r', { els: [rows[0]], z: 1.6 }),
          W(0.56, 0.9, '3d', { els: [q(cf, '.cf-detail') ?? rows[0]], z: 1.55 }),
          wide(0.99, 1),
        ];
      case 4:
        return [
          wide(0, 0.05),
          W(0.12, 0.46, '4a', { els: tiles.slice(0, 2), z: 1.5 }),
          W(0.58, 0.92, '4b', { els: [q(cf, '.cf-spark svg')], z: 1.5 }),
          wide(0.99, 1),
        ];
      case 5:
        return [
          wide(0, 0.06),
          W(0.14, 0.9, '5', { els: [q(cf, '.fx-doc') ?? q(cf, '.rd-main')], z: 1.5 }),
          wide(0.99, 1),
        ];
      default:
        return [
          wide(0, 0.04),
          W(0.08, 0.52, '6a', { els: [q(cf, '.cf-cmd')], z: 1.7, crop: [0, 0.5] }),
          W(0.64, 0.92, '6b', { els: [q(cf, '.cf-mods')], z: 1.5, crop: [0, 0.6] }),
          wide(0.99, 1),
        ];
    }
  }

  // layout-pixel boxes are not touched by the camera's transform, so a pose is computed once and kept until reset()
  const poses = new Map<string, Pose>();
  const plans = new Map<number, Way[]>();
  function poseOf(w: Way): Pose | null {
    if (!w.f) return WIDE;
    const hit = poses.get(w.id);
    if (hit) return hit;
    const W = body.clientWidth;
    const H = body.clientHeight;
    if (W < 1 || H < 1) return null;
    const boxes = w.f.els.map((e) => (e ? boxIn(e, cam) : null));
    if (boxes.length === 0 || boxes.some((b) => !b)) return null; // not laid out yet: try again on the next call
    const c = w.f.crop;
    if (c && boxes[0]) boxes[0] = { ...boxes[0], x: boxes[0].x + boxes[0].w * c[0], w: boxes[0].w * c[1] };
    const x0 = Math.min(...boxes.map((b) => b!.x));
    const y0 = Math.min(...boxes.map((b) => b!.y));
    const x1 = Math.max(...boxes.map((b) => b!.x + b!.w));
    const y1 = Math.max(...boxes.map((b) => b!.y + b!.h));
    const bw = Math.max(1, x1 - x0);
    const bh = Math.max(1, y1 - y0);
    const z = Math.max(1, Math.min(w.f.z, W / (bw * 1.05), H / (bh * 1.05)));
    // centre the part, but never slide the canvas off its own edge
    const tx = Math.min(0, Math.max(W - W * z, W / 2 - z * (x0 + bw / 2)));
    const ty = Math.min(0, Math.max(H - H * z, H / 2 - z * (y0 + bh / 2)));
    const pose = { tx, ty, z };
    poses.set(w.id, pose);
    return pose;
  }

  let shown = '';
  function write(p: Pose, dim: number) {
    const tf =
      p.z === 1 && p.tx === 0 && p.ty === 0
        ? ''
        : `translate(${p.tx.toFixed(1)}px, ${p.ty.toFixed(1)}px) scale(${p.z.toFixed(3)})`;
    const key = `${tf}|${dim.toFixed(2)}`;
    if (key === shown) return;
    shown = key;
    cam.style.transform = tf;
    vignette.style.opacity = dim.toFixed(2);
  }

  return {
    show(beat, u) {
      let plan = plans.get(beat);
      if (!plan) plans.set(beat, (plan = planFor(beat)));
      // find the waypoint held at u, or the pair u lies between
      let k = 0;
      while (k < plan.length - 1 && u >= plan[k + 1]!.a) k++;
      const cur = plan[k]!;
      const next = plan[k + 1];
      const p0 = poseOf(cur);
      if (!p0) return;
      if (!next || u <= cur.b) return write(p0, cur.f ? 1 : 0);
      const p1 = poseOf(next);
      if (!p1) return;
      const t = sm((u - cur.b) / Math.max(1e-6, next.a - cur.b));
      write(
        { tx: p0.tx + (p1.tx - p0.tx) * t, ty: p0.ty + (p1.ty - p0.ty) * t, z: p0.z + (p1.z - p0.z) * t },
        (cur.f ? 1 : 0) + ((next.f ? 1 : 0) - (cur.f ? 1 : 0)) * t,
      );
    },
    reset() {
      shown = '';
      poses.clear();
      plans.clear();
      cam.style.transform = '';
      vignette.style.opacity = '0';
    },
  };
}
