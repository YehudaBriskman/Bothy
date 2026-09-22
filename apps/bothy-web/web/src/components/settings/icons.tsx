// Section icons, resolved from the names lib/settings-index.ts stores. Kept out of
// the index so that module stays import-free and checkable with a bare tsc.

import {
  Activity, Archive, Download, Info, KeyRound, LayoutPanelLeft, Palette, RefreshCw, ScrollText, Ship,
  UserRound, Users, Waypoints, type LucideIcon,
} from 'lucide-react';
import { Icon, type IconSize } from '../ui/Icon';

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
  download: Download,
  info: Info,
};

export function SectionIcon({ name, size = 'md' }: { name: string; size?: IconSize }) {
  return <Icon icon={ICONS[name] ?? Info} size={size} className="set-ico" />;
}
