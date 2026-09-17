// Section icons, resolved from the names lib/settings-index.ts stores. Kept out of
// the index so that module stays import-free and checkable with a bare tsc.

import {
  Activity, Archive, Info, KeyRound, LayoutPanelLeft, Palette, RefreshCw, ScrollText, Ship,
  UserRound, Users, Waypoints, type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  user: UserRound,
  palette: Palette,
  layout: LayoutPanelLeft,
  refresh: RefreshCw,
  waypoints: Waypoints,
  users: Users,
  key: KeyRound,
  ship: Ship,
  activity: Activity,
  scroll: ScrollText,
  archive: Archive,
  info: Info,
};

export function SectionIcon({ name, size = 16 }: { name: string; size?: number }) {
  const I = ICONS[name] ?? Info;
  return <I size={size} aria-hidden="true" className="set-ico" />;
}
