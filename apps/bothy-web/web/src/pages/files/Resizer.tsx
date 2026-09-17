// ── the drag handle ──────────────────────────────────────────────────────────
//
// Pointer events with setPointerCapture, not mouse events on window. Capture is
// what makes a drag survive the pointer leaving the 5px handle - which it does
// immediately and constantly, because the handle is 5px wide and a hand moving a
// rail 300px does not travel in a straight line. Without capture the drag stops
// the moment the cursor crosses into the panel, which reads as the rail "getting
// stuck". Pointer events also mean the same code handles a trackpad, a touch
// screen and a pen with no second branch.
//
// It is a real separator, not a decorative bar:
//   · role="separator" with aria-valuenow/min/max and an accessible name, so a
//     screen reader announces a resizable boundary and its current size;
//   · arrow keys move it (16px, or 48px with Shift), Home/End go to the limits,
//     Enter/Space collapse the region - a mouse-only resizer is a region a
//     keyboard user simply cannot reach the far side of;
//   · double-click resets to the default, which is the standard escape hatch
//     from a rail dragged somewhere silly.

import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type KeyboardEvent } from 'react';
import { LIMITS, type PaneKey } from './panes';

const STEP = 16;
const BIG_STEP = 48;

export function Resizer({
  axis, pane, value, label, onSize, onNudge, onReset, onToggle,
}: {
  /** 'x' = a vertical bar between columns; 'y' = a horizontal bar between rows. */
  axis: 'x' | 'y';
  pane: PaneKey;
  value: number;
  label: string;
  onSize: (key: PaneKey, v: number) => void;
  onNudge: (key: PaneKey, by: number) => void;
  onReset: (key: PaneKey) => void;
  onToggle: (key: PaneKey) => void;
}) {
  // The gesture's origin, held in a ref because nothing about it should cause a
  // render - the whole point is that a drag writes one CSS variable per frame.
  const from = useRef({ pos: 0, size: 0 });
  // Which side of the handle the region is on. The right rail and the bottom
  // panel grow as the pointer moves TOWARDS the origin, so their delta is
  // inverted; getting this wrong is the classic "the rail runs away from the
  // cursor" bug.
  const sign = pane === 'l' ? 1 : -1;

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    from.current = { pos: axis === 'x' ? e.clientX : e.clientY, size: value };
  }, [axis, value]);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const now = axis === 'x' ? e.clientX : e.clientY;
    onSize(pane, from.current.size + (now - from.current.pos) * sign);
  }, [axis, onSize, pane, sign]);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const big = e.shiftKey ? BIG_STEP : STEP;
    // The grow key is the one pointing AWAY from the region, on both axes.
    const grow = axis === 'x' ? (pane === 'l' ? 'ArrowRight' : 'ArrowLeft') : 'ArrowUp';
    const shrink = axis === 'x' ? (pane === 'l' ? 'ArrowLeft' : 'ArrowRight') : 'ArrowDown';
    switch (e.key) {
      case grow: e.preventDefault(); onNudge(pane, big); break;
      case shrink: e.preventDefault(); onNudge(pane, -big); break;
      case 'Home': e.preventDefault(); onSize(pane, LIMITS[pane].min); break;
      case 'End': e.preventDefault(); onSize(pane, LIMITS[pane].max()); break;
      case 'Enter': case ' ': e.preventDefault(); onToggle(pane); break;
      default: break;
    }
  }, [axis, onNudge, onSize, onToggle, pane]);

  return (
    <div
      className={`fx-sep fx-sep-${axis} fx-sep-${pane}`}
      role="separator"
      tabIndex={0}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={LIMITS[pane].min}
      aria-valuemax={LIMITS[pane].max()}
      title={`${label} - drag, or arrow keys. Double-click to reset.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onReset(pane)}
      onKeyDown={onKeyDown}
    >
      <span className="fx-sep-grip" aria-hidden="true" />
    </div>
  );
}
