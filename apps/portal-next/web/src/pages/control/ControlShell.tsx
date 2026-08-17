// ── the Control section, and its left nav ────────────────────────────────────
//
// Services, Ports, Routes and Topology are four renderings of ONE dataset - the
// merged node list - and they had three top-nav slots and a hidden tab layer
// between them. They now share one slot and navigate from here.
//
// A SIDEBAR IS A NAMED DEAD END IN THIS DESIGN SYSTEM (brand/foundations/
// space-and-layout.md: "a 236px sidebar, deleted - five navigation items over
// roughly 793 pixels of empty column, at every width, on every page"). This is
// deliberately not that, and the differences are the whole argument:
//
//   · it is SCOPED. It exists inside one section rather than beside every page,
//     and it replaces three top-nav slots plus a tab strip rather than adding to
//     them - the item count across the app goes down, not up;
//   · it COLLAPSES to a 46px icon strip and remembers that you collapsed it, so
//     the empty column is a choice rather than a tax. That is the activity strip
//     from Bothy Files, which is the pattern this propagates;
//   · below 900px it stops being a column at all and becomes the same horizontal
//     scroller the topbar nav already is.
//
// It carries NO counts or status marks. A "3" beside Routes would be the one
// piece of chrome in the app that encodes state, which principles.md forbids in
// as many words; the faults live one click away on the section landing, which is
// a page whose whole job is to carry them.

import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Boxes, Gauge, PanelLeftClose, PanelLeftOpen, Plug, Share2, Waypoints } from 'lucide-react';
import './control.css';

// Ports before Routes, which reverses the old tab order. The tabs defaulted to
// Routes; a LIST reads top-down and ports are the concrete thing (a number you
// type) while routes are the edge's own model of the box, so ports first is the
// order of increasing indirection. /access with no ?tab still lands on Routes -
// see redirects.ts. Topology is last because it is the expensive one.
const NAV = [
  { to: '/control/services', label: 'Services', Icon: Boxes },
  { to: '/control/ports', label: 'Ports', Icon: Plug },
  { to: '/control/routes', label: 'Routes', Icon: Waypoints },
  { to: '/control/topology', label: 'Topology', Icon: Share2 },
];

// Versioned like panes.ts's key, for the same reason: a shape change should be a
// reset rather than a crash on somebody's three-week-old localStorage.
const KEY = 'bothy-control-nav-v1';

function useCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      // Private mode, a full quota, a hand-edited value - none of them are a
      // reason for the section not to render.
      return false;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch { /* not fatal */ }
  }, [collapsed]);
  return [collapsed, useCallback(() => setCollapsed((c) => !c), [])];
}

export function ControlShell() {
  const [collapsed, toggle] = useCollapsed();
  const loc = useLocation();
  const reduce = useReducedMotion();

  // There is no keyboard shortcut for the collapse, and that is a decision
  // rather than an omission: every chord this app dispatches is written down in
  // pages/files/keys.ts and shown to the user in two places, so a binding added
  // without a row there would make the Keys sheet lie. The toggle is a real
  // button in the first tab stop of the section, which is enough for one control.
  return (
    <div className="control-sec" data-collapsed={collapsed ? 'true' : 'false'}>
      {/* `aria-label` rather than a visible heading: the section is titled by the
          Control link inside it, and a second <h1> above the page's own would
          give every page here two. NavLink sets aria-current="page" on the
          active entry by itself - that is the whole reason these are NavLinks
          and not Links. */}
      <nav className="ct-nav scroll-shade" aria-label="Control">
        <NavLink to="/control" end className={({ isActive }) => `ct-item ct-home ${isActive ? 'on' : ''}`} title="Control">
          <Gauge size={16} aria-hidden="true" />
          <span className="ct-label">Control</span>
        </NavLink>

        {NAV.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            // `title` is the label's fallback for touch, where neither hover nor
            // focus-visible fires - the same third fallback the topbar nav uses,
            // and the only label at all when this is collapsed.
            title={label}
            className={({ isActive }) => `ct-item ${isActive ? 'on' : ''}`}
          >
            <Icon size={16} aria-hidden="true" />
            <span className="ct-label">{label}</span>
          </NavLink>
        ))}

        <button
          type="button"
          className="ct-collapse"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Show the Control menu labels' : 'Collapse the Control menu'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <PanelLeftOpen size={15} aria-hidden="true" /> : <PanelLeftClose size={15} aria-hidden="true" />}
          <span className="ct-label">Collapse</span>
        </button>
      </nav>

      {/* The page transition moved DOWN here. AppShell keys its <main> on the
          first path segment now, so arriving in Control animates the section
          once; moving between these four entries animates only the body, and the
          nav beside it does not flash on every click. A "persistent sidebar" that
          re-mounts and fades in on each navigation is not persistent, it is a
          sidebar-shaped page element. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={loc.pathname}
          className="ct-body"
          initial={{ opacity: 0, y: reduce ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduce ? 0 : -6 }}
          transition={{ duration: 0.18, ease: [0.2, 0.7, 0.2, 1] }}
        >
          <Outlet />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
