/**
 * Scroll restoration for the home page. The page is taller after its scripts mount than in the prerendered HTML (the
 * pinned console's track alone is ~7.8k px), so the browser's own restoration landed in the wrong place and, with
 * `scroll-behavior: smooth`, swept the whole page past the visitor, driving the story and the sky on the way. So the head
 * script turns the browser's restoration off (`history.scrollRestoration = 'manual'`) and this module does it once the
 * layout has stopped changing: instantly (no smooth scroll), to the place the visitor left (saved on a reload or a back
 * or forward step) or to the #fragment's element. Any wheel, touch, key or click by the visitor cancels it first.
 */
const KEY = `bb-scroll:${location.pathname}`;
const STABLE_FOR = 300; // ms the document height must hold still
const GIVE_UP = 3000; // ms: after this, restore wherever the layout got to

let restored = false;
const w = window as unknown as { __bbRestoring?: boolean };

function read(): number | null {
  try {
    const v = Number(sessionStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
function save() {
  if (!restored) return; // before the restore the scroll is 0 only because we have not moved yet
  try {
    sessionStorage.setItem(KEY, String(Math.round(scrollY)));
  } catch {
    /* a blocked store: the page simply opens at the top next time */
  }
}

try {
  history.scrollRestoration = 'manual';
} catch {
  /* very old browsers */
}

const kind = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type;
const saved = kind === 'reload' || kind === 'back_forward' ? read() : null;
const fragment = location.hash ? decodeURIComponent(location.hash.slice(1)) : '';

let idle = 0;
addEventListener(
  'scroll',
  () => {
    window.clearTimeout(idle);
    idle = window.setTimeout(save, 150);
  },
  { passive: true },
);
addEventListener('pagehide', save);

if (!saved && !fragment) {
  restored = true;
} else {
  w.__bbRestoring = true;
  const cancel = () => finish(false);
  const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
  for (const e of events) addEventListener(e, cancel, { passive: true, once: true });
  const started = performance.now();
  let lastH = -1;
  let since = started;
  const poll = window.setInterval(() => {
    const now = performance.now();
    const h = document.documentElement.scrollHeight;
    if (h !== lastH) {
      lastH = h;
      since = now;
    }
    if ((document.readyState === 'complete' && now - since >= STABLE_FOR) || now - started >= GIVE_UP) finish(true);
  }, 100);
  function finish(go: boolean) {
    window.clearInterval(poll);
    for (const e of events) removeEventListener(e, cancel);
    if (go) {
      const root = document.documentElement;
      root.style.scrollBehavior = 'auto'; // instant: a smooth restore would sweep the story past the visitor
      if (fragment) document.getElementById(fragment)?.scrollIntoView();
      else if (saved) scrollTo(0, Math.min(saved, root.scrollHeight - innerHeight));
      root.style.scrollBehavior = '';
    }
    restored = true;
    window.setTimeout(() => (w.__bbRestoring = false), 200); // its scroll events have been delivered by then
  }
}
