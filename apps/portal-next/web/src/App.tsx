import { Link, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { Overview } from './pages/Overview';
import { Services } from './pages/Services';
import { ServiceDetail } from './pages/ServiceDetail';
import { ProjectDetail } from './pages/ProjectDetail';
import { PortsPage } from './pages/PortsPage';
import { RoutesPage } from './pages/RoutesPage';
import { Topology } from './pages/Topology';

// Multi-page, one shared poll (lifted into <DataProvider> in main.tsx). The
// AppShell is the persistent layout (sidebar + topbar); pages render into its
// <Outlet>.
export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Overview />} />
        <Route path="services" element={<Services />} />
        <Route path="services/:id" element={<ServiceDetail />} />
        <Route path="systems/:name" element={<ProjectDetail />} />
        <Route path="ports" element={<PortsPage />} />
        <Route path="routes" element={<RoutesPage />} />
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
