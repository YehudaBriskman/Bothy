import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// Reveal-on-scroll. A thin IntersectionObserver wrapper that toggles the shared
// `.reveal` → `.reveal.in` transition defined in index.css (opacity + rise).
// The CSS already forces `.reveal` fully visible under prefers-reduced-motion,
// so the observer is purely additive: if it never fires (or IO is unsupported)
// we reveal immediately, never leaving content stuck invisible.
export function Reveal({
  children,
  delay = 0,
  className,
  as: Tag = 'section',
}: {
  children: ReactNode;
  /** stagger, in seconds — applied as transition-delay on the reveal */
  delay?: number;
  className?: string;
  as?: 'section' | 'div';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
            break;
          }
        }
      },
      { rootMargin: '0px 0px -60px 0px', threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);

  const cls = ['reveal', shown ? 'in' : '', className].filter(Boolean).join(' ');
  const style = delay ? { transitionDelay: `${delay}s` } : undefined;

  return (
    <Tag ref={ref as never} className={cls} style={style}>
      {children}
    </Tag>
  );
}
