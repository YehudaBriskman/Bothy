// Disclosure - a region that opens and closes under a toggle (design audit
// SYS-10, batch 3, 2026-09-22).
//
// Services animated every group's collapse as framer `height: 0 <-> auto`:
// measured 95 -> 64 -> 28 -> 17 -> 0px over ~250ms, a layout pass per frame for
// every group below it (R11.1). This animates `grid-template-rows` from 0fr to
// 1fr instead - the one layout animation the audit accepts, because the browser
// resolves it without measuring the content in script and without the per-frame
// re-render framer's `auto` needs - with the content fading on opacity. Under
// reduced motion (decision 3) the rows snap and the fade stays.
//
// The region is ALWAYS in the DOM, so a toggle's `aria-controls` resolves in the
// collapsed state too - exactly when a screen reader needs it. Its content is
// mounted the first time it opens and kept (a collapsed table costs nothing
// until somebody wants it, and does not re-mount on every toggle). Closed, it is
// `inert` and `visibility: hidden` once the rows have folded, so nothing inside
// is reachable by Tab.

import { useState, type ReactNode } from 'react';
import './Disclosure.css';

export function Disclosure({ open, id, className, children }: {
  open: boolean;
  /** The id a toggle's aria-controls names. */
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const [seen, setSeen] = useState(open);
  if (open && !seen) setSeen(true);
  return (
    <div id={id} className={`ui-disc${className ? ` ${className}` : ''}`} data-open={open} inert={!open}>
      <div className="ui-disc-inner">{seen ? children : null}</div>
    </div>
  );
}
