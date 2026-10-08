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
//
// THE GROUPS FOLD, and only the one holding the page you are on is open
// (2026-10-08: "all of the settings tabs in the side pannel need to be
// compactable ... not in view all all the time"). Three things that decision
// forces, each of which was a defect waiting to happen:
//
//   · the rule and the storage live in lib/prefs.ts, which imports nothing, so
//     checks/settings.mjs can run a truth table over them. Nothing here decides
//     whether a group is open;
//   · THE OPEN STATE IS THE SHELL'S, not the Nav's. `Nav` is rendered twice -
//     the desktop aside and the mobile drawer - and two copies of a useState
//     would mean folding a group in the drawer and finding it open behind it;
//   · each copy gets its own `useId()` prefix. Both are in the DOM at once while
//     the drawer is open, and `aria-controls` pointing at a duplicate id names
//     whichever the browser finds first - which is the OTHER nav's region.
//
// The header is a toggle and NOT also a link. There is no page for a group (the
// registry gives a group an id and a title and nothing else), and a target that
// both navigates and folds is the one nav mistake that cannot be recovered from
// by trying again - whichever you wanted, you get the other half of the time.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { ChevronDown, Menu, X } from 'lucide-react';
import { GROUPS, SECTIONS, groupTitle, sectionById } from '../../lib/settings-index';
import { SettingsSearch } from './SettingsSearch';
import { SectionIcon } from './icons';
import { useUpdatesBehind } from './useUpdatesBehind';
import { DialogClose, DialogSurface, DialogTitle } from '../ui/Dialog';
import './settings.css';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Disclosure } from '../ui/Disclosure';
import { arriveInGroup, groupOpen, toggleGroup, type OpenGroups } from '../../lib/prefs';
import { useOpenGroups } from '../../lib/usePrefs';

interface NavProps {
  /** The stored opinion per group - the shell's, so both copies agree. */
  groups: OpenGroups;
  /** The group holding the page being shown, which is open unless folded. */
  activeGroup: string | null;
  onToggle: (id: string) => void;
  onNavigate?: () => void;
}

function Nav({ groups, activeGroup, onToggle, onNavigate }: NavProps) {
  const behind = useUpdatesBehind();
  const uid = useId();
  return (
    <nav className="set-nav-list" aria-label="Settings sections">
      {GROUPS.map((g) => {
        const open = groupOpen(groups, g.id, activeGroup);
        const headId = `${uid}-h-${g.id}`;
        const panelId = `${uid}-p-${g.id}`;
        return (
          <div className="set-nav-group" key={g.id} role="group" aria-labelledby={headId}>
            {/* The group title IS the toggle's accessible name - a bare chevron
                is a button called "button", which checks/a11y-contract.mjs §6
                refuses outright. */}
            <button
              type="button" className="set-nav-gh" id={headId}
              aria-expanded={open} aria-controls={panelId}
              onClick={() => onToggle(g.id)}
            >
              <Icon icon={ChevronDown} size="sm" className="chev set-nav-chev" />
              <span className="set-nav-gt">{g.title}</span>
            </button>
            {/* A Disclosure (SYS-10): the region stays in the DOM so the
                aria-controls above resolves while it is shut, it folds on grid
                rows rather than on a height, and `inert` keeps the links of a
                shut group off the Tab order. */}
            <Disclosure open={open} id={panelId}>
              <div className="set-nav-items">
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
            </Disclosure>
          </div>
        );
      })}
    </nav>
  );
}

export function SettingsShell() {
  const loc = useLocation();
  const [drawer, setDrawer] = useState(false);
  const sectionId = loc.pathname.split('/')[2] ?? '';
  const section = useMemo(() => sectionById(sectionId), [sectionId]);
  const [groups, setGroups] = useOpenGroups();
  const activeGroup = section?.group ?? null;

  // A navigation always closes the drawer - including one made by the search
  // inside it, which is not a NavLink click.
  useEffect(() => { setDrawer(false); }, [loc.pathname, loc.search]);

  // Arriving at a section unfolds its group, so a hit from "Search settings", a
  // pasted link or the Back button never lands behind a fold.
  //
  // ON ARRIVAL, which is what the ref is for and not a tidiness. Run on every
  // change of `groups` instead and folding the group you are standing in is
  // undone in the same frame: the toggle flips, the effect clears the fold it
  // just wrote, and the group springs back open. A fold of the current group is
  // therefore good until you leave and come back - including a reload, which is
  // an arrival like any other.
  const arrived = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (arrived.current === activeGroup) return;
    arrived.current = activeGroup;
    // arriveInGroup() returns the SAME object when there is nothing to clear,
    // so an arrival into an already-open group writes nothing.
    const next = arriveInGroup(groups, activeGroup);
    if (next !== groups) setGroups(next);
  }, [groups, activeGroup, setGroups]);

  const nav = {
    groups,
    activeGroup,
    onToggle: (id: string) => setGroups(toggleGroup(groups, id, activeGroup)),
  };

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
        <Nav {...nav} />
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
              <Nav {...nav} onNavigate={() => setDrawer(false)} />
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
