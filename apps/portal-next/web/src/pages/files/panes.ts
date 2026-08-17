// ── the four regions, and what remembers their sizes ─────────────────────────
//
// Three numbers and three booleans. The CENTRE is deliberately absent from both
// lists: it is `minmax(0, 1fr)` and absorbs whatever the other three leave, so
// it has no size of its own to store and nothing to drag. That is the ask, and
// it is also the only arrangement in which the four regions cannot disagree
// about how wide the window is - with an independently sized centre, three
// draggable widths have to be reconciled against one viewport on every resize,
// and the reconciliation is where every "the panel jumped" bug lives.
//
// The sizes are CSS custom properties on the shell root rather than props
// threaded into each region, because the grid template is the only thing that
// reads them. A resize is then one style write on one element, and no region
// re-renders at all while the pointer is moving - which is what keeps a drag at
// 60fps over a tree holding a few hundred rows.

import { useCallback, useEffect, useState } from 'react';

export const DEFAULTS = { l: 268, r: 300, p: 200, s: 460 } as const;

// Minimums are the width below which the region stops being able to do its job:
// 180px is about twenty characters of a file name plus its icon and chevron,
// 220px is a commit subject wrapped to two lines. Below either, collapse is the
// honest state and the toggle is right there.
//
// `s` is the SECOND EDITOR GROUP, and it is here rather than in a resizer of its
// own for one reason: Resizer.tsx already does pointer capture, arrow keys,
// role="separator" and aria-valuenow, and it is parameterised by PaneKey. Adding
// a key is the whole cost of reusing it. It behaves like the right rail - it
// lives on the right, so it grows as the pointer moves LEFT, which is exactly
// what `sign = pane === 'l' ? 1 : -1` in Resizer already says.
export const LIMITS = {
  l: { min: 180, max: () => Math.round(window.innerWidth / 2) },
  r: { min: 220, max: () => Math.round(window.innerWidth / 2) },
  p: { min: 0, max: () => window.innerHeight },
  // Measured against the CENTRE, not the window, and that is not a detail: the
  // rails and the panel have the window to divide up, but the second editor
  // group only ever has whatever the centre column was left. Clamping this one
  // against `innerWidth` let the separator announce `aria-valuenow: 583` while
  // the group it names rendered at 486 - the layout gave way (flex-shrink) and
  // the announcement did not, which makes a screen reader's only readout of this
  // control a number that is simply wrong. 185 is the first group's own minimum
  // plus the 5px separator.
  s: {
    min: 200,
    max: () => {
      const el = typeof document !== 'undefined'
        ? document.querySelector('.bothy-files .fx-groups')
        : null;
      const room = el ? el.clientWidth : window.innerWidth;
      return Math.max(200, Math.round(room - 185));
    },
  },
} as const;

export type PaneKey = 'l' | 'r' | 'p' | 's';

export interface Panes {
  l: number; r: number; p: number; s: number;
  cl: boolean; cr: boolean; cp: boolean; cs: boolean;
}

// Versioned, so a shape change is a reset rather than a crash on somebody's
// three-week-old localStorage.
const KEY = 'bothy-files-panes-v1';

// Below this the three regions cannot coexist: 180 + 220 of minimum rail is
// already more than a phone has, so a rail and the editor are alternatives
// rather than neighbours. Matches the `max-width: 820px` branch in shell.css,
// and the two must move together.
const NARROW = 820;

// A function, not a constant: the first-run default depends on the window. On a
// phone both rails start CLOSED, because 268 + 300 of rail against a 390px
// viewport leaves the editor exactly zero pixels - measured, and it rendered as
// a file that had opened into nothing. The toggles are in the header either way,
// so this is a starting point rather than a restriction.
function fallback(): Panes {
  const narrow = typeof window !== 'undefined' && window.innerWidth <= NARROW;
  return {
    l: DEFAULTS.l, r: DEFAULTS.r, p: DEFAULTS.p, s: DEFAULTS.s,
    cl: narrow, cr: narrow,
    // The bottom panel starts CLOSED at every width. It carries diagnostics, and
    // a diagnostics pane that is open before anything has gone wrong trains
    // people to ignore it.
    cp: true,
    // `cs` exists only so `toggle` has a flag for every PaneKey. The split is
    // created and collapsed by moving TABS, never by hiding a group - a hidden
    // group holding open documents is a place work can go missing.
    cs: false,
  };
}

export function clamp(key: PaneKey, v: number): number {
  const { min, max } = LIMITS[key];
  return Math.max(min, Math.min(max(), Math.round(v)));
}

function read(): Panes {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback();
    const j = JSON.parse(raw) as Partial<Panes>;
    return {
      l: clamp('l', typeof j.l === 'number' ? j.l : DEFAULTS.l),
      r: clamp('r', typeof j.r === 'number' ? j.r : DEFAULTS.r),
      p: clamp('p', typeof j.p === 'number' ? j.p : DEFAULTS.p),
      s: clamp('s', typeof j.s === 'number' ? j.s : DEFAULTS.s),
      cl: !!j.cl, cr: !!j.cr, cp: j.cp !== false, cs: !!j.cs,
    };
  } catch {
    // A quota error, private mode, a hand-edited value - none of them are a
    // reason for the page not to render.
    return fallback();
  }
}

export function usePanes() {
  const [panes, setPanes] = useState<Panes>(read);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(panes)); } catch { /* not fatal */ }
  }, [panes]);

  // A saved 700px rail is legal on a 1600px window and absurd on an 800px one,
  // and the window can change size after the value was stored. Re-clamping on
  // resize is what stops a restored layout from eating a narrow screen.
  useEffect(() => {
    const onResize = () => setPanes((p) => {
      const next = { ...p, l: clamp('l', p.l), r: clamp('r', p.r), p: clamp('p', p.p), s: clamp('s', p.s) };
      return next.l === p.l && next.r === p.r && next.p === p.p && next.s === p.s ? p : next;
    });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const setSize = useCallback((key: PaneKey, v: number) => {
    setPanes((p) => (p[key] === clamp(key, v) ? p : { ...p, [key]: clamp(key, v) }));
  }, []);

  const nudge = useCallback((key: PaneKey, by: number) => {
    setPanes((p) => ({ ...p, [key]: clamp(key, p[key] + by) }));
  }, []);

  const reset = useCallback((key: PaneKey) => {
    setPanes((p) => ({ ...p, [key]: DEFAULTS[key] }));
  }, []);

  const toggle = useCallback((key: PaneKey) => {
    const flag = (`c${key}`) as 'cl' | 'cr' | 'cp' | 'cs';
    setPanes((p) => ({ ...p, [flag]: !p[flag] }));
  }, []);

  return { panes, setSize, nudge, reset, toggle };
}
