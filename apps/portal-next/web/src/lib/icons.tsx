// Lucide icon mapping - replaces the emoji `iconFor` from the original portal.
// The user explicitly hates the emoji, so NOTHING in the UI renders node.icon
// (the emoji string still exists on PortalNode, it is simply never surfaced).
//
// A service maps to an icon by its container image first, then its display name
// (so @file host processes with no container - e.g. Tilt - still resolve). Order
// matters: the specific product must precede the vendor, exactly like the
// original table, or grafana/loki matches 'grafana' and shows the wrong glyph.

import {
  Database, BarChart3, Target, ScrollText, Waypoints, Container as ContainerIcon,
  Waves, BookOpen, Boxes, MemoryStick, HardDrive, Globe, Wrench, Plug, Gauge,
  Server, Box, Activity, Layers,
  CircleCheck, LoaderCircle, CircleX, CircleHelp, CirclePause,
  type LucideIcon,
} from 'lucide-react';
import type { PortalNode, Status, ServiceType } from './discover';

const IMAGE_ICONS: [string, LucideIcon][] = [
  ['loki', ScrollText], ['promtail', ScrollText], ['dozzle', ScrollText],
  ['grafana', BarChart3], ['prometheus', Target],
  ['traefik', Waypoints], ['portainer', ContainerIcon], ['socket-proxy', Plug],
  ['nginx', Globe], ['postgres', Database], ['redis', MemoryStick],
  ['kafka', Waves],
  ['garage', HardDrive], ['minio', HardDrive], ['s3', HardDrive],
  ['wiki', BookOpen],
  ['minikube', Boxes], ['kube', Boxes], ['k8s', Boxes],
  ['tilt', Wrench],
  ['cadvisor', Gauge], ['node-exporter', Server], ['exporter', Activity],
];

// Also match on the display name / host for things with no image (host procs).
const NAME_ICONS: [string, LucideIcon][] = [
  ['tilt', Wrench], ['grafana', BarChart3], ['prometheus', Target],
  ['traefik', Waypoints], ['portainer', ContainerIcon], ['kafka', Waves],
  ['wiki', BookOpen], ['postgres', Database], ['redis', MemoryStick],
  ['minikube', Boxes],
];

export function iconForNode(node: Pick<PortalNode, 'name' | 'host'> & {
  container?: { image?: string } | null;
}): LucideIcon {
  const img = String(node.container?.image || '').toLowerCase();
  if (img) for (const [k, v] of IMAGE_ICONS) if (img.includes(k)) return v;
  const hay = `${node.name || ''} ${node.host || ''}`.toLowerCase();
  for (const [k, v] of NAME_ICONS) if (hay.includes(k)) return v;
  return Box;
}

// A rendered service icon (inherits currentColor / size from CSS).
export function ServiceIcon({
  node, size = 20, className,
}: {
  node: Parameters<typeof iconForNode>[0];
  size?: number;
  className?: string;
}) {
  const Icon = iconForNode(node);
  return <Icon size={size} className={className} strokeWidth={1.9} aria-hidden="true" />;
}

// ── ServiceType → lucide (the domain page's section headers + type chips) ────
export const TYPE_ICON: Record<ServiceType, LucideIcon> = {
  web: Globe,
  database: Database,
  cache: MemoryStick,
  queue: Waves,
  storage: HardDrive,
  observability: BarChart3,
  edge: Waypoints,
  runtime: Layers,
  other: Box,
};

export function TypeIcon({ type, size = 16, className }: { type: ServiceType; size?: number; className?: string }) {
  const Icon = TYPE_ICON[type];
  return <Icon size={size} strokeWidth={1.9} className={className} aria-hidden="true" />;
}

// ── Status → lucide (keep the coloured treatment via CSS var) ────────────────

export const STATUS_ICON: Record<Status, LucideIcon> = {
  up: CircleCheck,
  starting: LoaderCircle,
  down: CircleX,
  // Pause, not a cross: the glyph has to read "someone switched this off",
  // because form (not colour) is what carries status here.
  stopped: CirclePause,
  unknown: CircleHelp,
};

// A tiny variant used where a filled dot reads better than an outline (e.g. the

// The reserved status tokens, by state.
//
// These were `--ok/--warn/--down/--off/--unk` until the palette was reorganised
// into the `--st-*` family, and this map was not updated with it. Nothing threw:
// an undefined custom property makes `var(--ok)` resolve to nothing, so
// `StatusIcon` silently inherited its parent's colour and every status glyph in
// the app had been rendering in body text for as long as the rename was old.
// That is the failure mode to remember - a dead token name is not an error, it
// is a colour that quietly stops being applied.
// The `-fg` half of each pair, NOT the bare fill, because line 126 sets `color`
// on a 15px glyph. index.css measures the two halves separately and says so: the
// fills are legal at 2.50/1.94/1.46 to 1 in light mode only because they are
// large solid areas beside a track, and it warns in as many words to "re-verify
// if any of these is ever used for a small glyph". This is that glyph. The `-fg`
// values are the ones held at >= 4.5:1.
export const STATUS_VAR: Record<Status, string> = {
  // --st-off-fg is the muted token: a stopped service must recede, not compete
  // with the things that are actually broken.
  up: '--st-up-fg', starting: '--st-warn-fg', down: '--st-down-fg',
  stopped: '--st-off-fg', unknown: '--st-unknown-fg',
};

const STATUS_LABEL: Record<Status, string> = {
  up: 'Up', starting: 'Starting', down: 'Down', stopped: 'Stopped', unknown: 'Unknown',
};

// Status glyph - coloured by the reserved status palette, never colour-alone
// (always carries an accessible label). `spin` animates the starting spinner.
export function StatusIcon({
  status, size = 15, showLabel = false, title,
}: {
  status: Status; size?: number; showLabel?: boolean; title?: string;
}) {
  const Icon = STATUS_ICON[status];
  const label = STATUS_LABEL[status];
  return (
    <span
      className={`si si-${status}`}
      style={{ color: `var(${STATUS_VAR[status]})` }}
      title={title || label}
    >
      <Icon
        size={size}
        strokeWidth={2.2}
        className={status === 'starting' ? 'spin' : undefined}
        aria-hidden="true"
      />
      {showLabel ? <span className="si-label">{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
}
