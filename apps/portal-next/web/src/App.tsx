import { Route, Routes } from 'react-router-dom';
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
        {/* legacy alias — projectLink used to point here */}
        <Route path="projects/:name" element={<ProjectDetail />} />
        <Route path="ports" element={<PortsPage />} />
        <Route path="routes" element={<RoutesPage />} />
        <Route path="topology" element={<Topology />} />
        <Route path="*" element={<Overview />} />
      </Route>
    </Routes>
  );
}
