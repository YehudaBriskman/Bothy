import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { Overview } from './pages/Overview';
import { Services } from './pages/Services';
import { ServiceDetail } from './pages/ServiceDetail';
import { ProjectDetail } from './pages/ProjectDetail';
import { Ports, Routes as RoutesPage } from './pages/Access';
import { Topology } from './pages/Topology';
import { Settings } from './pages/Settings';
import { Files } from './pages/files/Files';
import { ControlShell } from './pages/control/ControlShell';
import { Control } from './pages/control/Control';
import { LEGACY_PATHS, legacyTarget } from './pages/control/redirects';

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

        {/* BothyFiles - the explorer. `?root=` and `?path=` rather than path
            segments, so a file whose own path contains slashes needs no encoding
            games and a deep link survives being pasted into chat. */}
        <Route path="files" element={<Files />} />

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
