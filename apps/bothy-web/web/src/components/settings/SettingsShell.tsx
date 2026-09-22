// ── the Settings area: grouped left nav, search, breadcrumbs, one outlet ──────
//
// GitLab-shaped on purpose (docs/plans/settings-v2.md §3): a scoped sidebar of
// grouped sections, a "Search settings" box, breadcrumbs, and pages made of
// setting blocks. It is the ControlShell precedent - a sidebar INSIDE a section,
// subordinate to the topbar - not the top-level sidebar the design system records
// as a dead end.
//
// BELOW 900px THE NAV IS A DRAWER, and that one IS a recorded dead end
// (brand/quality/responsive.md: "A mobile drawer"). The difference that makes it
// right here, written down in brand/reference/decisions.md: the dead end was a
// drawer for FIVE top-level destinations, which a topbar holds; this is twelve
// grouped destinations plus a search, which a horizontal strip cannot, and the
// costs that sank the old one - the scrim, the focus trap, the focus-order
// workaround - are Radix Dialog's, not hand-written.
//
// The nav carries no status marks (principles.md rule 2), and ONE count: beside
// Updates, how many components are a minor version or more behind
// (docs/plans/updates.md §8, approved 2026-09-18). A number in neutral chrome, not
// a coloured dot, so it states a fact rather than encoding a state - and it draws
// only once the count is known and above zero. The role hint beside Users,
// Credentials, Audit and Backups is a WORD, not a colour, and it describes where
// the data comes from - it is never the gate.

import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { GROUPS, SECTIONS, groupTitle, sectionById } from '../../lib/settings-index';
import { SettingsSearch } from './SettingsSearch';
import { SectionIcon } from './icons';
import { useUpdatesBehind } from './useUpdatesBehind';
import { DialogClose, DialogSurface, DialogTitle } from '../ui/Dialog';
import './settings.css';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const behind = useUpdatesBehind();
  return (
    <nav className="set-nav-list" aria-label="Settings sections">
      {GROUPS.map((g) => (
        <div className="set-nav-group" key={g.id} role="group" aria-labelledby={`set-nav-g-${g.id}`}>
          <p className="set-nav-gh" id={`set-nav-g-${g.id}`}>{g.title}</p>
          {SECTIONS.filter((s) => s.group === g.id).map((s) => (
            <NavLink
              key={s.id}
              to={`/settings/${s.id}`}
              className={({ isActive }) => `set-nav-item ${isActive ? 'on' : ''}`}
              onClick={onNavigate}
            >
              <SectionIcon name={s.icon} />
              <span className="set-nav-label">{s.title}</span>
              {s.needs && <span className="set-nav-needs">{s.needs}</span>}
              {s.id === 'updates' && behind !== null && behind > 0 && (
                <span className="set-nav-count" title={`${behind} a minor version or more behind`}>
                  {behind}<span className="sr-only"> components a minor version or more behind</span>
                </span>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function SettingsShell() {
  const loc = useLocation();
  const [drawer, setDrawer] = useState(false);
  const sectionId = loc.pathname.split('/')[2] ?? '';
  const section = useMemo(() => sectionById(sectionId), [sectionId]);

  // A navigation always closes the drawer - including one made by the search
  // inside it, which is not a NavLink click.
  useEffect(() => { setDrawer(false); }, [loc.pathname, loc.search]);

  // The document title follows the section, so a tab list of five Settings pages
  // is five different names.
  useEffect(() => {
    const prev = document.title;
    document.title = section ? `${section.title} · Settings · Bothy` : 'Settings · Bothy';
    return () => { document.title = prev; };
  }, [section]);

  return (
    <div className="set-shell">
      <aside className="set-side scroll-shade">
        <SettingsSearch />
        <Nav />
      </aside>

      <div className="set-main">
        <div className="set-mobile-bar">
          {/* The drawer is a modal like any other, so it is ui/Dialog's
              DialogSurface: same trap, same Escape, same focus return (to this
              button) as every dialog in the app. */}
          <Button variant="ghost" className="set-drawer-btn" aria-haspopup="dialog" aria-expanded={drawer} onClick={() => setDrawer(true)}>
            <Icon icon={Menu} size="md" />
            <span>Sections</span>
          </Button>
          <DialogSurface
            open={drawer} onOpenChange={setDrawer} title="Settings" titleVisible
            overlayClassName="set-drawer-overlay" className="set-drawer"
          >
            <div className="set-drawer-head">
              <DialogTitle className="set-drawer-title">Settings</DialogTitle>
              <DialogClose className="icon-btn set-drawer-x" aria-label="Close the sections menu">
                <Icon icon={X} size="md" />
              </DialogClose>
            </div>
            <div className="set-drawer-body scroll-shade">
              <SettingsSearch />
              <Nav onNavigate={() => setDrawer(false)} />
            </div>
          </DialogSurface>
          <span className="set-mobile-here">{section?.title ?? 'Settings'}</span>
        </div>

        <div className="set-body settings-page">
          <nav className="set-crumbs" aria-label="Breadcrumb">
            <ol>
              <li><Link to="/settings">Settings</Link></li>
              {section && <li><span>{groupTitle(section.group)}</span></li>}
              {section && <li><span aria-current="page">{section.title}</span></li>}
            </ol>
          </nav>
          {section && (
            <header className="set-head">
              <h1>{section.title}</h1>
              <p className="set-head-lede">{section.lede}</p>
            </header>
          )}
          <Outlet />
        </div>
      </div>
    </div>
  );
}
