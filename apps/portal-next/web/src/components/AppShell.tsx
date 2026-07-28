import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  LayoutDashboard, Boxes, Waypoints, Plug, Share2,
  Search, RefreshCw, Moon, Sun, Monitor, Server,
} from 'lucide-react';
import { usePortal } from '../lib/data';
import { useTheme } from '../lib/theme';
import { freshnessOf } from '../lib/freshness';

const NAV = [
  { to: '/', label: 'Overview', Icon: LayoutDashboard, end: true },
  { to: '/services', label: 'Services', Icon: Boxes, end: false },
  { to: '/ports', label: 'Ports', Icon: Plug, end: false },
  { to: '/routes', label: 'Routes', Icon: Waypoints, end: false },
  { to: '/topology', label: 'Topology', Icon: Share2, end: false },
];

function ThemeToggle() {
  const { theme, cycle } = useTheme();
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  return (
    <button className="icon-btn" onClick={cycle} title={`Theme: ${theme} (click to change)`} aria-label={`Theme: ${theme}`}>
      <Icon size={18} />
    </button>
  );
}

export function AppShell() {
  const { data, refresh } = usePortal();
  const nav = useNavigate();
  const loc = useLocation();
  const fresh = freshnessOf(data);
  const searchRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [spin, setSpin] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  // Keep the topbar search in sync with the Services page query param.
  const params = new URLSearchParams(loc.search);
  const urlQ = params.get('q') || '';
  useEffect(() => {
    if (loc.pathname === '/services') setQ(urlQ);
  }, [urlQ, loc.pathname]);

  // "/" focuses search, "r" refreshes — the two keys the old portal had.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(input|textarea|select)$/i.test(e.target.tagName);
      if (typing) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'r') doRefresh();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const reduce = useReducedMotion();

  const doRefresh = () => {
    refresh();
    setSpin(true);
    setTimeout(() => setSpin(false), 700);
  };

  const onSearch = (v: string) => {
    setQ(v);
    const target = `/services${v ? `?q=${encodeURIComponent(v)}` : ''}`;
    nav(target, { replace: loc.pathname === '/services' });
  };

  return (
    <div className="shell">
      <div className="bg" aria-hidden="true">
        <span className="orb a" />
        <span className="orb b" />
        <span className="grid-lines" />
      </div>

      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <NavLink to="/" className="brand" end onClick={() => setNavOpen(false)}>
          <span className="brand-mark"><Server size={18} /></span>
          <span className="brand-text">
            <b>dev.test</b>
            <small><this-node></small>
          </span>
        </NavLink>

        <nav className="nav" aria-label="Primary">
          {NAV.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `nav-item ${isActive ? 'on' : ''}`}
              onClick={() => setNavOpen(false)}
            >
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="side-foot">
          <div className={`pill ${fresh.kind}`} title={fresh.text}>
            <span className="pulse" />
            <span className="pill-short">{fresh.short}</span>
          </div>
          <div className="side-cmds">
            <code>just up</code>
            <code>just doctor</code>
          </div>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <button
            className="icon-btn hamburger"
            onClick={() => setNavOpen((o) => !o)}
            aria-label="Toggle navigation"
          >
            <Boxes size={18} />
          </button>

          <div className={`pill ${fresh.kind} topbar-pill`} title={fresh.text}>
            <span className="pulse" />
            <span>{fresh.text}</span>
          </div>

          <div className="topbar-search">
            <Search size={16} className="search-ico" aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search services…   /"
              value={q}
              onChange={(e) => onSearch(e.target.value)}
              aria-label="Search services"
            />
          </div>

          <button
            className="icon-btn"
            onClick={doRefresh}
            title="Refresh now (r)"
            aria-label="Refresh"
          >
            <RefreshCw size={18} className={spin ? 'spin' : undefined} />
          </button>
          <ThemeToggle />
        </header>

        {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}

        {/* Route/page transition — a short fade+rise keyed on the path. `mode:wait`
            lets the outgoing page finish before the next mounts, so pages never
            overlap. Reduced-motion collapses the offset to a plain fade. */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.main
            key={loc.pathname}
            className="content"
            initial={{ opacity: 0, y: reduce ? 0 : 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduce ? 0 : -8 }}
            transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
          >
            <Outlet />
          </motion.main>
        </AnimatePresence>
      </div>
    </div>
  );
}
