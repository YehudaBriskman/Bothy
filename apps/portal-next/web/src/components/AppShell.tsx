import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  LayoutDashboard, Boxes, Waypoints, Share2, FolderTree,
  Search, RefreshCw, Moon, Sun, Monitor,
} from 'lucide-react';
import { usePortal } from '../lib/data';
import { useTheme } from '../lib/theme';
import { freshnessOf } from '../lib/freshness';
import { useScrollProgress, useScrollRestoration, useScrollShades } from '../lib/scroll';
import { Tooltip } from './Tooltip';
import { Brand } from './Brand';
import { CommandPalette } from './CommandPalette';

// Five destinations. Ports and Routes were two views of "how do I reach this?"
// and are now tabs inside /access. Files is last because it is the only
// destination that is not about the running stack - it reads and writes the
// box's own trees, which is a different job from watching containers.
const NAV = [
  { to: '/', label: 'Overview', Icon: LayoutDashboard, end: true },
  { to: '/services', label: 'Services', Icon: Boxes, end: false },
  { to: '/access', label: 'Access', Icon: Waypoints, end: false },
  { to: '/topology', label: 'Topology', Icon: Share2, end: false },
  { to: '/files', label: 'Files', Icon: FolderTree, end: false },
];

function ThemeToggle() {
  const { theme, cycle } = useTheme();
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  return (
    <Tooltip label={`Theme: ${theme} - click to change`} align="end">
      <button className="icon-btn" onClick={cycle} aria-label={`Theme: ${theme}. Click to change.`}>
        <Icon size={18} />
      </button>
    </Tooltip>
  );
}

export function AppShell() {
  const { data, refresh } = usePortal();
  const loc = useLocation();
  const fresh = freshnessOf(data);

  // Mounted once, for the whole app: a new page starts at the top and Back
  // returns you where you were; every `.scroll-shade` container gets inner
  // shadows on the edge it can still travel towards; the left rail tracks how
  // far down the page you are. See lib/scroll.ts.
  useScrollRestoration();
  useScrollShades();
  const progress = useScrollProgress();
  const [spin, setSpin] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The palette is the only thing that ever takes focus away from the page, so
  // it is also the only thing that has to give it back.
  const restoreFocus = useRef<HTMLElement | null>(null);

  const doRefresh = useCallback(() => {
    refresh();
    setSpin(true);
    setTimeout(() => setSpin(false), 700);
  }, [refresh]);

  const openPalette = () => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    setPaletteOpen(true);
  };
  const closePalette = () => {
    setPaletteOpen(false);
    restoreFocus.current?.focus();
  };

  // ⌘K / Ctrl-K and "/" open the palette; "r" refreshes. The `typing` guard is
  // what keeps "r" from being unpressable inside the palette's own input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        paletteOpen ? closePalette() : openPalette();
        return;
      }
      const typing = e.target instanceof HTMLElement && /^(input|textarea|select)$/i.test(e.target.tagName);
      if (typing) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      if (e.key === '/') { e.preventDefault(); openPalette(); }
      else if (e.key === 'r') doRefresh();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const reduce = useReducedMotion();
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

  return (
    <div className="shell">
      <div className="bg" aria-hidden="true">
        <span className="grid-lines" />
      </div>

      {/* How far down the page you are. Scaled rather than resized, and hidden
          outright when the page is too short to scroll. */}
      <div className="scroll-rail" aria-hidden="true" hidden={progress === 0}>
        <span className="scroll-rail-fill" style={{ transform: `scaleY(${progress})` }} />
      </div>

      {/* Skip link - one Tab press to content. It mattered more with the
          sidebar (6 stops); kept because it costs nothing and the nav is still
          the first thing in the DOM. */}
      <a href="#content" className="skip-link">Skip to content</a>

      <header className="topbar">
        <NavLink to="/" className="brand" end aria-label="Bothy - overview">
          <Brand />
        </NavLink>

        {/* scroll-shade drives the horizontal edge fades when the row overflows;
            `title` is the label's third fallback, for touch, where neither hover
            nor focus-visible fires. */}
        <nav className="nav scroll-shade" aria-label="Primary">
          {NAV.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              title={label}
              className={({ isActive }) => `nav-item ${isActive ? 'on' : ''}`}
            >
              <Icon size={16} />
              <span className="nav-label">{label}</span>
            </NavLink>
          ))}
        </nav>

        <span className="topbar-spacer" />

        <Tooltip label={fresh.text}>
          <div className={`pill ${fresh.kind} topbar-pill`}>
            <span className="pulse" />
            <span className="pill-short">{fresh.short}</span>
          </div>
        </Tooltip>

        <button className="topbar-search" onClick={openPalette} aria-label="Search (Ctrl K)" aria-haspopup="dialog">
          <Search size={15} className="search-ico" aria-hidden="true" />
          <span className="search-label">Search…</span>
          <span className="kbd">{isMac ? '⌘' : 'Ctrl '}K</span>
        </button>

        <Tooltip label="Refresh now (r)" align="end">
          <button className="icon-btn" onClick={doRefresh} aria-label="Refresh now">
            <RefreshCw size={18} className={spin ? 'spin' : undefined} />
          </button>
        </Tooltip>
        <ThemeToggle />
      </header>

      {/* Route/page transition - a short fade+rise keyed on the path. `mode:wait`
          lets the outgoing page finish before the next mounts, so pages never
          overlap. Reduced-motion collapses the offset to a plain fade. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.main
          key={loc.pathname}
          id="content"
          className="content"
          initial={{ opacity: 0, y: reduce ? 0 : 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduce ? 0 : -8 }}
          transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
        >
          <Outlet />
        </motion.main>
      </AnimatePresence>

      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  );
}
