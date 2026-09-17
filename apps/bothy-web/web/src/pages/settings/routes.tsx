// The Settings area's routes, as one fragment App.tsx drops in - so adding a
// section is a line here and in lib/settings-index.ts, and never an edit to the
// app's route table. checks/settings-index.mjs asserts the two lists agree.
//
// The theme editor keeps its own full-page routes OUTSIDE the shell
// (/settings/theme/new, /settings/theme/:id): it repaints the whole document while
// you type and needs the page to itself. React Router ranks those static
// segments above `:section`, so they cannot be swallowed by the shell.

import { Link, Navigate, Route } from 'react-router-dom';
import { SettingsShell } from '../../components/settings/SettingsShell';
import { ThemeEditor } from '../ThemeEditor';
import '../Settings.css';
import { ProfileSettings } from './Profile';
import { AppearanceSettings } from './Appearance';
import { LayoutSettings } from './Layout';
import { DataSettings } from './Data';
import { PlacementSettings } from './Placement';
import { UsersSettings } from './Users';
import { CredentialsSettings } from './Credentials';
import { ClusterSettings } from './Cluster';
import { MonitoringSettings } from './Monitoring';
import { AuditSettings } from './Audit';
import { BackupsSettings } from './Backups';
import { AboutSettings } from './About';

export const SETTINGS_PAGES: Record<string, () => React.ReactElement> = {
  profile: ProfileSettings,
  appearance: AppearanceSettings,
  layout: LayoutSettings,
  data: DataSettings,
  placement: PlacementSettings,
  users: UsersSettings,
  credentials: CredentialsSettings,
  cluster: ClusterSettings,
  monitoring: MonitoringSettings,
  audit: AuditSettings,
  backups: BackupsSettings,
  about: AboutSettings,
};

function UnknownSection() {
  return (
    <div className="set-empty">
      <p>There is no settings section at this address.</p>
      <Link className="btn ghost sm" to="/settings/profile">Go to Profile &amp; session</Link>
    </div>
  );
}

export function settingsRoutes() {
  return (
    <>
      <Route path="settings/theme/new" element={<ThemeEditor />} />
      <Route path="settings/theme/:id" element={<ThemeEditor />} />
      <Route path="settings" element={<SettingsShell />}>
        <Route index element={<Navigate to="profile" replace />} />
        {Object.entries(SETTINGS_PAGES).map(([id, Page]) => (
          <Route key={id} path={id} element={<Page />} />
        ))}
        <Route path="*" element={<UnknownSection />} />
      </Route>
    </>
  );
}
