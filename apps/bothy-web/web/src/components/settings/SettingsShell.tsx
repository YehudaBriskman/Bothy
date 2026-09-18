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
// The nav carries no counts and no status marks (principles.md rule 2). The role
// hint beside Users, Credentials, Audit and Backups is a WORD, not a colour, and
// it describes where the data comes from - it is never the gate.

import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import * as RD from '@radix-ui/react-dialog';
import { Menu, X } from 'lucide-react';
import { GROUPS, SECTIONS, groupTitle, sectionById } from '../../lib/settings-index';
import { SettingsSearch } from './SettingsSearch';
import { SectionIcon } from './icons';
import './settings.css';

function Nav({ onNavigate }: { onNavigate?: () => void }) {
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
          <RD.Root open={drawer} onOpenChange={setDrawer}>
            <RD.Trigger className="btn ghost set-drawer-btn">
              <Menu size={16} aria-hidden="true" />
              <span>Sections</span>
            </RD.Trigger>
            <RD.Portal>
              <RD.Overlay className="set-drawer-overlay" />
              <RD.Content className="set-drawer" aria-describedby={undefined}>
                <div className="set-drawer-head">
                  <RD.Title className="set-drawer-title">Settings</RD.Title>
                  <RD.Close className="icon-btn set-drawer-x" aria-label="Close the sections menu">
                    <X size={16} />
                  </RD.Close>
                </div>
                <div className="set-drawer-body scroll-shade">
                  <SettingsSearch />
                  <Nav onNavigate={() => setDrawer(false)} />
                </div>
              </RD.Content>
            </RD.Portal>
          </RD.Root>
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
