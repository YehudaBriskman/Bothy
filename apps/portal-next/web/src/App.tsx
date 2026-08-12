import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { Overview } from './pages/Overview';
import { Services } from './pages/Services';
import { ServiceDetail } from './pages/ServiceDetail';
import { ProjectDetail } from './pages/ProjectDetail';
import { Access } from './pages/Access';
import { Topology } from './pages/Topology';

// Multi-page, one shared poll (lifted into <DataProvider> in main.tsx). The
// AppShell is the persistent layout (one topbar - the sidebar was deleted);
// pages render into its <Outlet>.
export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Overview />} />
        <Route path="services" element={<Services />} />
        <Route path="services/:id" element={<ServiceDetail />} />
        <Route path="systems/:name" element={<ProjectDetail />} />
        <Route path="access" element={<Access />} />
        {/* /ports and /routes were separate pages and are bookmarked - and this
            is a dashboard people link to from notes and chat, so breaking a
            deep link is worse than carrying two redirects forever. `replace`
            keeps the dead URL out of the history stack. */}
        <Route path="ports" element={<Navigate to="/access?tab=ports" replace />} />
        <Route path="routes" element={<Navigate to="/access?tab=routes" replace />} />
        <Route path="topology" element={<Topology />} />
        {/* A typo'd deep link used to render the Overview with the bad URL still
            in the bar, so a broken link looked like it had worked. */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
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
