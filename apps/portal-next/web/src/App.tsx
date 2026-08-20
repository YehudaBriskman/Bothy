import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { Overview } from './pages/Overview';
import { Services } from './pages/Services';
import { ServiceDetail } from './pages/ServiceDetail';
import { ProjectDetail } from './pages/ProjectDetail';
import { Ports, Routes as RoutesPage } from './pages/Access';
import { Topology } from './pages/Topology';
import { Settings } from './pages/Settings';
import { ThemeEditor } from './pages/ThemeEditor';
import { Files } from './pages/files/Files';
import { Reader } from './pages/files/Reader';
import { ControlShell } from './pages/control/ControlShell';
import { Control } from './pages/control/Control';
import { LEGACY_PATHS, legacyTarget } from './pages/control/redirects';
import { GUIDE_PATH } from './pages/files/routes';

// Multi-page, one shared poll (lifted into <DataProvider> in main.tsx). The
// AppShell is the persistent layout (one topbar - the global sidebar was
// deleted); pages render into its <Outlet>.
//
// Three top-level destinations now: Overview, Control, Files. Services, Access
// and Topology were three renderings of ONE dataset holding three of the five
// slots, which mis-stated what the box contains; they navigate from the Control
// sidebar instead (pages/control/ControlShell.tsx). Settings is reachable from
// the person menu rather than the nav - it is a destination you go to on
// purpose, not one you scan.
export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Overview />} />

        {/* The section shell renders the left nav and an <Outlet>; everything
            under it is a child route so the nav never unmounts. */}
        <Route path="control" element={<ControlShell />}>
          <Route index element={<Control />} />
          <Route path="services" element={<Services />} />
          <Route path="services/:id" element={<ServiceDetail />} />
          <Route path="systems/:name" element={<ProjectDetail />} />
          <Route path="ports" element={<Ports />} />
          <Route path="routes" element={<RoutesPage />} />
          <Route path="topology" element={<Topology />} />
        </Route>

        <Route path="settings" element={<Settings />} />
        {/* The theme editor is its own route rather than a dialog on Settings:
            it applies the draft to the WHOLE document as you type, so it needs
            the page to itself, and a URL means an unfinished theme survives a
            reload as a thing you can navigate back to. */}
        <Route path="settings/theme/new" element={<ThemeEditor />} />
        <Route path="settings/theme/:id" element={<ThemeEditor />} />

        {/* Bothy Files - one nav entry, two destinations (docs/plans/
            reading-first.md §2). `/files` opens as a READER; the IDE is
            unchanged at `/files/edit`.

            Both take the same `?root=` and `?path=` - path segments would make a
            file whose own path contains slashes an encoding game, and the query
            string is what lets an existing deep link resolve in EITHER mode. The
            route paths and the two link builders live in pages/files/routes.ts
            with a truth table over them, because a builder that drops `path` is
            a link that answers 200 and quietly goes somewhere else. */}
        {/* GUIDE is a third destination, not a third page - same Reader, one
            prop (#149). A BARE /files redirects into it, and a /files that
            carries `?root=` or `?path=` does not: every deep link written before
            this, every recents row and every Edit round trip still lands where
            it always did. `FilesLanding` is that one rule, and it is one rule
            precisely so nobody has to remember it twice. */}
        <Route path="files" element={<FilesLanding />} />
        <Route path="files/guide" element={<Reader mode="guide" />} />
        <Route path="files/edit" element={<Files />} />

        {/* The retired URLs. Built from the table rather than listed again here,
            so the router and pages/control/redirects.ts cannot disagree about
            WHICH urls are covered - checks/redirects.mjs covers the half that can
            still drift, namely where each one lands. This is a dashboard people
            deep-link to from notes and chat, so breaking a bookmark is worse than
            carrying redirects forever; /ports and /routes have been carrying
            exactly this since they were folded into Access, and they are just
            re-pointed. `replace` keeps the dead URL out of the history stack. */}
        {LEGACY_PATHS.map((p) => (
          <Route key={p} path={p} element={<Legacy />} />
        ))}

        {/* A typo'd deep link used to render the Overview with the bad URL still
            in the bar, so a broken link looked like it had worked. */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

// One component for every retired URL, because half the mapping lives in the
// query string: /access carried its view in `?tab=`, and a <Navigate to="/…">
// written per route drops it. A redirect that loses a query parameter is a broken
// link that answers 200.
function Legacy() {
  const loc = useLocation();
  const to = legacyTarget(loc.pathname, loc.search);
  // Unreachable unless the table and this route list have drifted apart, which
  // is what the check exists to prevent. The not-found page rather than null: a
  // blank screen is the one outcome worse than a redirect landing wrong.
  return to ? <Navigate to={to} replace /> : <NotFound />;
}

function NotFound() {
  return (
    <div className="page">
      <div className="state">
        <h4>Page not found</h4>
        <p>
          <span className="mono">{location.hash || '/'}</span> isn’t a page here.
        </p>
        <Link className="btn ghost" to="/">Back to the Overview</Link>
      </div>
    </div>
  );
}

/**
 * What a bare `/files` is (#149).
 *
 * The nav's Files entry points at `/files` with no query, and that now means
 * "the manual" - opening the section on somebody's private notes root was the
 * complaint #94 was filed about and Start only softened it. A REDIRECT rather
 * than rendering the guide at this path, so there is one URL per destination
 * and the address bar always says which one you are in.
 *
 * THE QUERY IS THE TEST, and it is the whole of the rule: `/files?root=notes` or
 * `/files?path=x` is a link somebody already holds - a bookmark, a recents row,
 * the editor's way back - and redirecting it into the guide would break every
 * one of them while still answering 200. `?in=` counts too: a scoped index is a
 * URL the shelf writes. Anything else on the query is not ours, and a bare
 * `?utm_source=` should not be what keeps somebody out of the guide, so only
 * these three are consulted.
 *
 * `replace`, so Back leaves the section rather than bouncing off `/files`.
 */
function FilesLanding() {
  const { search } = useLocation();
  const q = new URLSearchParams(search);
  const asked = q.get('root') || q.get('path') || q.get('in');
  return asked ? <Reader /> : <Navigate to={GUIDE_PATH} replace />;
}
