/**
 * The footer wordmark's light (components/FootMark.tsx draws it, chrome.css paints it). Loaded lazily by enhance.ts
 * when the footer comes near. A mouse or pen moves a soft light across the letters: the pointer position is kept and
 * written as --mx/--my once per frame; the box is measured only on enter and after a scroll, never in the move
 * handler. A device without hover gets one slow sweep the first time the wordmark is in view. Reduced motion: none of
 * this; the CSS shows still, faint outlines instead.
 */
export function mountFootmark(el: HTMLElement): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  if (!matchMedia('(hover: hover)').matches) {
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting && e.intersectionRatio > 0.5)) return;
        io.disconnect();
        el.addEventListener('animationend', () => el.removeAttribute('data-sweep'), { once: true });
        el.setAttribute('data-sweep', '');
      },
      { threshold: [0, 0.5, 1] },
    );
    io.observe(el);
    return;
  }

  let rect: DOMRect | null = null;
  let x = 0;
  let y = 0;
  let frame = 0;
  const paint = () => {
    frame = 0;
    rect ??= el.getBoundingClientRect();
    el.style.setProperty('--mx', `${Math.round(x - rect.left)}px`);
    el.style.setProperty('--my', `${Math.round(y - rect.top)}px`);
  };
  const move = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    x = e.clientX;
    y = e.clientY;
    frame ||= requestAnimationFrame(paint);
  };
  el.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'touch') return;
    rect = null;
    move(e);
    el.setAttribute('data-lit', '');
  });
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerleave', () => el.removeAttribute('data-lit'));
  addEventListener('scroll', () => (rect = null), { passive: true });
}
