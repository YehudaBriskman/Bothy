// Loader - Bothy's ONE loading and in-progress indicator (2026-09-22).
//
// Before this there were four: a CSS ring (.sa-spin) in eleven places, a spun
// lucide glyph (.spin) on three refresh buttons and a save, a pulsing dot on
// followed logs, and bare "Loading…" / "reading…" text. Each said "wait" in its
// own voice, and none of them said WHAT was being waited on.
//
// Now there is one: a thinking-orbs orb (MIT, zero dependencies, a 2D canvas).
// This file is the only place `thinking-orbs` is imported - checks/design-tokens.mjs
// fails on any other import, and on any hand-made spinner coming back.
//
// THE STATE SAYS WHAT KIND OF WAITING. Seven, each mapped to one orb animation:
//
//   work     an update job running                       -> working
//   search   discovery, a search while it queries         -> searching
//   act      a container or cluster action in flight      -> solving
//   stream   following logs live                          -> listening
//   connect  reconnecting, retrying a backend             -> connecting
//   load     first data for a page, card or table         -> breathing
//   refresh  the Control home's Refresh in progress       -> weaving
//
// SIZES are the orb's own three presets, not a scale factor: 20 is its
// inline-text design, 64 its empty-state design and 32 sits between. LOADER
// mirrors --loader-sm/-md/-lg in index.css and the check asserts they agree.
//
// RULES the component carries so call sites cannot forget them:
//   - Only mount it while something is in progress; unmount when it is done.
//     There is no `active` prop on purpose - an idle orb is the thing the
//     brand forbids (no perpetual loops for idle things).
//   - role="status" with a polite live label, visible or sr-only. The canvas
//     itself is aria-hidden so the label is read once. The region being
//     loaded carries aria-busy where the markup allows (components/states.tsx).
//   - Reduced motion - the OS setting OR Settings > Appearance > Motion, via
//     useMotionReduced() - renders the orb PAUSED: a still frame, no animation.
//   - Colour comes from the --loader-ink token, read off the live theme, and the
//     orb's substrate from html[data-theme]; both re-read on a theme change.
//   - OVER CONTENT IT GETS A PLATE (`plate`, 2026-09-23). Bare over a skeleton
//     it was unreadable: the orb printed onto a grey bar, the label crossing the
//     next one. Over content the loader is a higher plane and is drawn like one
//     - opaque --surface-4, the strong hairline, --r-lg, --shadow-3, sized to
//     its words. Opaque and never translucent: decision 4 keeps translucent
//     material for the top bar and the palette, and a blurred plate over
//     skeleton bars is the same defect with a blur on it.
//
// The package is about 50KB, so it is loaded lazily and kept out of the first
// paint's critical path: the placeholder is an empty box of the orb's size, and
// the chunk is fetched when the browser is idle, before most loaders mount.

import { lazy, Suspense, useSyncExternalStore } from 'react';
import { useMotionReduced } from '../../lib/useMotionReduced';
import './Loader.css';

const loadOrb = () => import('thinking-orbs');
const ThinkingOrb = lazy(() => loadOrb().then((m) => ({ default: m.ThinkingOrb })));

// Warm the chunk once the first paint is done, so a loader that mounts later
// does not also wait for its own code. Never on the critical path.
if (typeof window !== 'undefined') {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  const warm = () => { void loadOrb().catch(() => { /* the placeholder stays; nothing else depends on it */ }); };
  if (idle) idle(warm); else setTimeout(warm, 1500);
}

export const LOADER = { sm: 20, md: 32, lg: 64 } as const;
export type LoaderSize = keyof typeof LOADER;

export const LOADER_STATES = {
  work: 'working',
  search: 'searching',
  act: 'solving',
  stream: 'listening',
  connect: 'connecting',
  load: 'breathing',
  refresh: 'weaving',
} as const;
export type LoaderState = keyof typeof LOADER_STATES;

const DEFAULT_LABEL: Record<LoaderState, string> = {
  work: 'Working…',
  search: 'Searching…',
  act: 'Working on it…',
  stream: 'Following live…',
  connect: 'Reconnecting…',
  load: 'Loading…',
  refresh: 'Refreshing…',
};

// ── the ink, read from the theme ────────────────────────────────────────────
// The orb paints on a canvas, which cannot read a CSS variable, so the token is
// resolved on a probe element and normalised to rgb() through a one-pixel
// canvas (a theme may write its colours in any syntax the browser accepts; the
// package parses only #hex and rgb()). One store for every loader on the page.

interface Ink { color: string | undefined; dark: boolean }
let ink: Ink = { color: undefined, dark: true };
let inkKey = '';
const listeners = new Set<() => void>();

function readInk(): Ink {
  const root = document.documentElement;
  const probe = document.createElement('span');
  probe.className = 'ui-loader-probe';
  document.body.appendChild(probe);
  const raw = getComputedStyle(probe).color;
  probe.remove();
  let color: string | undefined;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.fillStyle = raw;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      color = `rgb(${r}, ${g}, ${b})`; // stray-colour-ok: the --loader-ink token itself, resolved for a canvas
    }
  } catch { color = undefined; /* stock grayscale ink */ }
  return { color, dark: root.getAttribute('data-theme') !== 'light' };
}

function refreshInk() {
  const next = readInk();
  const key = `${next.color}|${next.dark}`;
  if (key === inkKey) return;
  inkKey = key;
  ink = next;
  listeners.forEach((l) => l());
}

let stop: (() => void) | null = null;
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (!stop) {
    refreshInk();
    // data-theme / data-bothy-theme: a theme switch. style: the theme editor's
    // live draft and the accent setting write custom properties inline.
    const mo = new MutationObserver(refreshInk);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-bothy-theme', 'style', 'class'] });
    const mqs = ['(prefers-color-scheme: dark)', '(forced-colors: active)', '(prefers-contrast: more)'].map((q) => window.matchMedia?.(q));
    mqs.forEach((m) => m?.addEventListener('change', refreshInk));
    stop = () => { mo.disconnect(); mqs.forEach((m) => m?.removeEventListener('change', refreshInk)); };
  }
  return () => {
    listeners.delete(onChange);
    if (!listeners.size && stop) { stop(); stop = null; inkKey = ''; }
  };
}

function useInk(): Ink {
  return useSyncExternalStore(subscribe, () => ink, () => ink);
}

// ── the component ───────────────────────────────────────────────────────────

export interface LoaderProps {
  /** What kind of waiting this is - see the table at the top. */
  state: LoaderState;
  /** sm = inline with text (20), md = a card or panel (32), lg = a page or empty state (64). */
  size?: LoaderSize;
  /** What is being waited on, in words. Shown beside the orb unless `labelHidden`. */
  label?: string;
  /** Keep the label for screen readers only (a button that already says it, a tight row). */
  labelHidden?: boolean;
  /** Centre the loader in its container (the page and card states). Default: sm inline, md/lg centred. */
  center?: boolean;
  /** false when an enclosing live region already says it (the orb is then
   *  decoration beside those words): no role=status, no second announcement. */
  announce?: boolean;
  /** Draw the loader on its own plate, for when it FLOATS OVER content - a
   *  skeleton, a table still showing the last answer, a chart, a map.
   *
   *  Until 2026-09-23 a Loader laid over a skeleton was printed straight onto
   *  it: the orb sat on a grey bar and its words overlapped the next one down,
   *  so the one thing on screen that says "wait" was the least legible thing on
   *  screen. The plate is the same material a popover and a menu use, because a
   *  loader over a placeholder IS the same thing - a higher plane - and it
   *  gives the clear area without every skeleton variant having to carry a hole
   *  that moves with the layout.
   *
   *  It is a PROP and not a guess: a loader inline in a button, in a table row
   *  or beside a pill must not grow a plate. */
  plate?: boolean;
  className?: string;
}

export function Loader({ state, size = 'sm', label, labelHidden = false, center, announce = true, plate = false, className }: LoaderProps) {
  const reduced = useMotionReduced();
  const { color, dark } = useInk();
  const px = LOADER[size];
  const text = label ?? DEFAULT_LABEL[state];
  const hidden = labelHidden || label === undefined;
  const centred = center ?? size !== 'sm';
  const cls = ['ui-loader', centred ? 'ui-loader-center' : '', plate ? 'ui-loader-plate' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <span className={cls} role={announce ? 'status' : undefined} aria-live={announce ? 'polite' : undefined} data-size={size} data-state={state}>
      <span className="ui-loader-orb" data-size={size}>
        <Suspense fallback={null}>
          <ThinkingOrb
            state={LOADER_STATES[state]}
            size={px}
            theme={dark ? 'dark' : 'light'}
            color={color}
            paused={reduced}
            aria-hidden="true"
            data-paused={reduced ? 'true' : 'false'}
          />
        </Suspense>
      </span>
      {/* Silent (announce=false) with no words of its own: the orb is pure
          decoration beside text that already says it. */}
      {announce || label !== undefined ? <span className={hidden ? 'sr-only' : 'ui-loader-label'}>{text}</span> : null}
    </span>
  );
}
