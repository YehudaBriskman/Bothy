import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  LayoutDashboard, Gauge, FolderTree,
  Search, RefreshCw, Moon, Sun, Monitor,
} from 'lucide-react';
import { usePortal } from '../lib/data';
import { useTheme } from '../lib/theme';
import { freshnessOf } from '../lib/freshness';
import { useScrollProgress, useScrollRestoration, useScrollShades } from '../lib/scroll';
import { Tooltip } from './Tooltip';
import { Brand } from './Brand';
import { CommandPalette } from './CommandPalette';
import { UserMenu } from './UserMenu';

// Three destinations, and they are three DATASETS rather than three views.
// Services, Access and Topology used to hold three of the five slots between
// them while rendering one dataset - the merged node list - which mis-stated
// what the box contains; they are now four entries in the Control sidebar. Files
// keeps its own slot because it genuinely is a different dataset with a
// different mental model: it reads and writes the box's own trees, which is a
// different job from watching containers.
const NAV = [
  { to: '/', label: 'Overview', Icon: LayoutDashboard, end: true },
  { to: '/control', label: 'Control', Icon: Gauge, end: false },
  { to: '/files', label: 'Files', Icon: FolderTree, end: false },
];

// The topbar control stays a one-tap toggle over the two built-ins and System,
// not a menu of every theme. Cycling through the whole list to get back to where
// you started is the failure mode of putting a registry behind a single button;
// the full picker lives in Settings, where choosing is the point.
function ThemeToggle() {
  const { selection, theme, cycle } = useTheme();
  const Icon = selection === 'system' ? Monitor : theme.appearance === 'light' ? Sun : Moon;
  const label = selection === 'system' ? `System, currently ${theme.name}` : theme.name;
  return (
    <Tooltip label={`Theme: ${label} - click to change`} align="end">
      <button className="icon-btn" onClick={cycle} aria-label={`Theme: ${label}. Click to change.`}>
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
      // `isContentEditable` is not decoration. A tagName test alone was right
      // for exactly as long as every text surface in the app was a <textarea>;
      // BothyFiles' editor is a CodeMirror instance, whose writable element is
      // `<div class="cm-content" contenteditable>`, and a tagName test says DIV.
      // The bug that produces is not subtle: typing `/` opens the command
      // palette and typing `r` refreshes the dashboard, in the middle of a word.
      // The `.cm-editor` clause covers the read-only view too, where the content
      // is deliberately NOT contenteditable but the keys still belong to it.
      const el = e.target instanceof HTMLElement ? e.target : null;
      const inEditor = !!el && (el.isContentEditable || !!el.closest('.cm-editor'));
      const typing = !!el && (/^(input|textarea|select)$/i.test(el.tagName) || inEditor);
      if (typing) {
        // Escape hands a plain form field back to the page. NOT the code editor:
        // there Escape already closes the find panel and collapses multiple
        // cursors, and blurring on top of that would throw the caret away every
        // time someone shuts a search.
        if (e.key === 'Escape' && !inEditor) el.blur();
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

      {/* Skip link - one Tab press to content, past the ten stops in this bar.
          It matters again now that Control has a nav of its own inside the page.

          THE onClick IS THE WHOLE THING, and without it this link had never
          worked. The app is a <HashRouter>, so the fragment IS the route:
          following `#content` sets location.hash to "content", react-router
          normalises that to the path "/content", and the skip link - the app's
          first tab stop, the one control an assistive-technology user reaches
          first - navigated to the not-found page. It cannot be `href="#/…"`
          either, because that is a route and not an element. So the href stays
          as the honest statement of intent for anything reading the markup, and
          the default is prevented and the target focused directly. `main` needs
          tabIndex={-1} to be focusable at all; focusing rather than only
          scrolling is what actually moves the keyboard into the page. */}
      <a
        href="#content"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          const el = document.getElementById('content');
          el?.focus();
          el?.scrollIntoView();
        }}
      >
        Skip to content
      </a>

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
        {/* Last in the right cluster, and the only entry point to /settings -
            which is why it is not a nav slot. */}
        <UserMenu />
      </header>

      {/* Route/page transition - a short fade+rise keyed on the SECTION, not on
          the path. `mode:wait` lets the outgoing page finish before the next
          mounts, so pages never overlap. Reduced-motion collapses the offset to
          a plain fade.

          Keying on the full pathname re-mounted everything under <main> on every
          navigation, and once Control had a sidebar in there that meant the
          "persistent" nav faded out and back in on each of its own links - a
          sidebar-shaped page element rather than a sidebar. The section shell
          runs the same transition around its own <Outlet>, so moving within
          Control still animates; it just animates the part that changed. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.main
          key={loc.pathname.split('/')[1] ?? ''}
          id="content"
          tabIndex={-1}
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
