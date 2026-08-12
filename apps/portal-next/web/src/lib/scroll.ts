// Scrolling: position across navigations, shading at the edges of a scroller,
// and progress through the page.
//
// All three are mounted once by the AppShell.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// ── 1. position across navigations ───────────────────────────────────────────
//
// THE BUG THIS FIXES: nothing reset the scroll offset on a route change, so
// arriving at a page put you wherever the PREVIOUS page had been scrolled to.
// Scroll the Services table to the bottom, click a service, and its detail page
// opened 800px down — on a page you had never scrolled. Worse, it is
// proportional-ish rather than absolute: if the new page is shorter, the browser
// clamps, so the same click landed somewhere different depending on what you
// were looking at before.
//
// The rule people actually expect, and the one the browser applies to real
// documents: a NEW navigation starts at the top; going BACK returns you to where
// you were. React Router's <ScrollRestoration> implements this, but it is
// data-router-only and this app is a plain <HashRouter>, so it is done here.
export function useScrollRestoration() {
  const { key, pathname, search } = useLocation();
  const navType = useNavigationType();
  // Two indexes of the same offsets, because `location.key` is not as stable as
  // it looks. It IS the right primary key — it distinguishes two history entries
  // for the SAME url, so going back to the second visit of /services restores
  // that visit's position rather than the first one's. But HashRouter synthesises
  // `key: "default"` for any entry it did not create itself (a hand-edited
  // fragment, a pasted deep link, anything that arrives as a bare hashchange),
  // and those keys do not round-trip: measured, a POP back to such an entry
  // looked up a key that had never been written and restored 0 — the exact bug
  // this hook exists to fix, just moved.
  // So: write both, read key first and fall back to the path.
  const byKey = useRef(new Map<string, number>());
  const byPath = useRef(new Map<string, number>());
  const path = pathname + search;

  // The browser's own heuristic fights this one: on a hash change it tries to
  // restore a position of its own, landing us in a race we sometimes lose.
  useEffect(() => {
    if (!('scrollRestoration' in history)) return;
    const prev = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    return () => { history.scrollRestoration = prev; };
  }, []);

  // Which location a scroll event belongs to. This indirection is the whole
  // trick, and without it the feature silently destroys its own data:
  //
  // On a push we scroll the window to 0 from a LAYOUT effect. Scroll events are
  // dispatched asynchronously, and React runs passive effects after paint — so
  // the event caused by that reset arrives while the save listener is STILL
  // bound to the location we just left, and writes 0 over the offset we were
  // supposed to remember. Measured exactly that: at push time the map held
  // "/" → 509, and by the time Back was pressed it held "/" → 0, so Back
  // "restored" the top of the page and looked like the restore had never run.
  //
  // Updating this ref in the layout effect BELOW, before the scrollTo, means the
  // stray event is attributed to the page being ARRIVED at (where 0 is the
  // truth) instead of the one being left.
  const cur = useRef({ key, path });

  // Registered once, for the life of the shell: the AppShell never unmounts, and
  // a listener that re-binds per route is what created the ordering bug above.
  useEffect(() => {
    const onScroll = () => {
      byKey.current.set(cur.current.key, window.scrollY);
      byPath.current.set(cur.current.path, window.scrollY);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    cur.current = { key, path };
    const target =
      navType === 'POP' ? byKey.current.get(key) ?? byPath.current.get(path) ?? 0 : 0;
    window.scrollTo(0, target);

    // A fresh navigation to 0 can never be clamped, so it is already done.
    if (target === 0) return;

    // Restoring a REAL offset has to wait for the page to be as tall as it was
    // when you left it, and it is not tall yet:
    //   · the transition is <AnimatePresence mode="wait">, so right now the
    //     OUTGOING page is still what is mounted, and
    //   · the incoming page's height depends on polled data and on charts that
    //     size themselves from a ResizeObserver — both land after paint.
    // Scrolling to 509 in a document that is momentarily 445 tall gets clamped
    // to 445, and the restore silently half-works. (Measured: exactly that, 445
    // instead of 509.) So re-apply each frame until it sticks, with a deadline
    // so this can never become an infinite loop on a genuinely short page.
    let done = false;
    const deadline = performance.now() + 400;
    // If the reader starts scrolling, they have overruled us — a restore that
    // keeps yanking the page back is far worse than one that gives up.
    const surrender = () => { done = true; };
    const opts = { passive: true, once: true } as const;
    window.addEventListener('wheel', surrender, opts);
    window.addEventListener('touchstart', surrender, opts);
    window.addEventListener('keydown', surrender, opts);

    const tick = () => {
      if (done) return;
      window.scrollTo(0, target);
      if (Math.abs(window.scrollY - target) > 1 && performance.now() < deadline) {
        requestAnimationFrame(tick);
      }
    };
    const raf = requestAnimationFrame(tick);

    return () => {
      done = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('wheel', surrender);
      window.removeEventListener('touchstart', surrender);
      window.removeEventListener('keydown', surrender);
    };
  }, [key, path, navType]);
}

// ── 2. edge shading ──────────────────────────────────────────────────────────
//
// An inner shadow on the edge a scroller can still travel towards. Without it a
// clipped list is indistinguishable from a complete one — the single most common
// reason people miss content in a fixed-height panel.
//
// Implemented as data attributes + `box-shadow: inset` rather than a positioned
// ::before, because an absolutely-positioned child of a scroll container SCROLLS
// WITH THE CONTENT and would slide away the moment it was needed. An inset
// shadow is painted on the border box, which does not move.
//
// One observer for the whole document, so a scroller anywhere (including one
// mounted later by a route change) is covered by adding a class and nothing else.
const SHADE_SELECTOR = '.scroll-shade';

const SCROLLS = /^(auto|scroll)$/;

function applyShade(el: HTMLElement) {
  // An axis counts as scrollable only if it OVERFLOWS *and* its computed
  // overflow actually permits scrolling. Both halves are load-bearing: the nav
  // is a horizontal scroller with `overflow-y: hidden` and 2px of vertical
  // padding, so `scrollHeight - clientHeight` is > 1 there even though it can
  // never scroll vertically — measured, and it put a permanent inset shadow
  // across the bottom of the topbar.
  const cs = getComputedStyle(el);
  // 1px of slack: fractional scroll offsets from a trackpad or a zoomed page
  // otherwise leave a shadow stuck on at either end.
  const yScrollable = SCROLLS.test(cs.overflowY) && el.scrollHeight - el.clientHeight > 1;
  const xScrollable = SCROLLS.test(cs.overflowX) && el.scrollWidth - el.clientWidth > 1;
  toggle(el, 'shadeT', yScrollable && el.scrollTop > 1);
  toggle(el, 'shadeB', yScrollable && el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  toggle(el, 'shadeL', xScrollable && el.scrollLeft > 1);
  toggle(el, 'shadeR', xScrollable && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
}

function toggle(el: HTMLElement, key: string, on: boolean) {
  if (on) el.dataset[key] = '1';
  else delete el.dataset[key];
}

export function useScrollShades() {
  useEffect(() => {
    const tracked = new WeakSet<HTMLElement>();
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) applyShade(e.target as HTMLElement);
    });

    const onScroll = (e: Event) => applyShade(e.currentTarget as HTMLElement);

    const scan = () => {
      for (const el of document.querySelectorAll<HTMLElement>(SHADE_SELECTOR)) {
        if (tracked.has(el)) {
          applyShade(el); // content may have changed under a stable element
          continue;
        }
        tracked.add(el);
        el.addEventListener('scroll', onScroll, { passive: true });
        ro.observe(el);
        applyShade(el);
      }
    };

    scan();
    // Content arrives by poll (every 10s), not only by navigation, so a list
    // that grows past its box has to re-shade without any DOM node being added
    // or removed. Subtree + characterData covers both.
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });

    return () => {
      mo.disconnect();
      ro.disconnect();
      for (const el of document.querySelectorAll<HTMLElement>(SHADE_SELECTOR)) {
        el.removeEventListener('scroll', onScroll);
      }
    };
  }, []);
}

// ── 3. progress through the page ─────────────────────────────────────────────
//
// Drives the rail down the left edge. Returns 0 when the page does not scroll at
// all, so the rail can hide itself rather than show a full bar on a short page.
export function useScrollProgress(): number {
  const [p, setP] = useState(0);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setP(max > 40 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0);
    };
    // rAF-coalesced: scroll fires far more often than the 60 times a second this
    // can possibly be seen at.
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    const ro = new ResizeObserver(onScroll);
    ro.observe(document.body);
    measure();

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return p;
}
