// The "system" rollup — the new organising unit of the portal.
//
// A SYSTEM is one compose project (n.group): a real project like `tals` or
// `cvops`, or a shared stack service (`monitoring`, `kafka`, `postgres`, …), or
// the edge itself. The Overview shows one card per system that is RUNNING
// something right now; systems that exist only as data (stopped, volume-only)
// fall through to the "Data & disk" card instead. Clicking a card opens that
// system's domain page (/systems/:group), which splits its services by type.
//
// Everything here is derived from the already-joined PortalNode[] + /system/df.
// No new fetch, no DOM — pure functions the pages compose.

import type { PortalNode, Status, ServiceType, VolumeRef } from './discover';
import { TYPE_META } from './discover';
import type { SystemDf } from './api';
import { accentVar } from './accents';

export type SystemKind = 'project' | 'stack' | 'infra';

export interface UiLink {
  id: string;
  name: string;
  url: string;
  host: string | null;
  port: number | null;
  status: Status;
  group: string;
  groupKind: string;
}

export interface System {
  key: string; // the compose group, e.g. 'tals' — also the /systems/:name param
  title: string;
  kind: SystemKind;
  accent: string; // css var name, e.g. '--a3'
  nodes: PortalNode[];
  total: number;
  running: number; // up + starting
  up: number;
  down: number;
  starting: number;
  unknown: number;
  hasRunning: boolean;
  uiLinks: UiLink[];
  volumes: VolumeRef[];
  newestUptime: number | null; // smallest uptime = most recently (re)started
  oldestUptime: number | null; // largest uptime = longest continuously up
}

const KIND_RANK: Record<SystemKind, number> = { project: 0, stack: 1, infra: 2 };

// A project's display name comes from its own labelled node if present, else a
// title-cased group slug — same rule as panelize/discover, kept in one place.
function niceTitle(group: string, nodes: PortalNode[]): string {
  const labelled = nodes.find((n) => n.container?.labels?.['dev.portal.project']);
  return (
    labelled?.container?.labels?.['dev.portal.project'] ||
    group.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
  );
}

// The system's kind = the kind of the majority of its nodes (they agree in
// practice; a project's nodes are all 'project'). Infra (edge/portal) is kept
// distinct so it can sort last and read as plumbing.
function kindOf(nodes: PortalNode[]): SystemKind {
  const k = nodes[0]?.groupKind;
  if (k === 'project') return 'project';
  if (k === 'infra') return 'infra';
  return 'stack';
}

export function uiLinkOf(n: PortalNode): UiLink | null {
  if (!n.browsable || !n.url) return null;
  const port = n.ports.find((p) => p.scope === 'public')?.hostPort ?? n.ports[0]?.hostPort ?? null;
  return {
    id: n.id,
    name: n.name,
    url: n.url,
    host: n.host,
    port,
    status: n.status,
    group: n.group,
    groupKind: n.groupKind,
  };
}

// Build one System per group. Sorted: projects → stack → infra, then by number
// running (desc), then title. `hidden` nodes never count.
export function systemsOf(nodes: PortalNode[]): System[] {
  const vis = nodes.filter((n) => !n.hidden);
  const byGroup = new Map<string, PortalNode[]>();
  for (const n of vis) {
    const g = n.group || 'other';
    (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(n);
  }

  const systems: System[] = [];
  for (const [key, ns] of byGroup) {
    let up = 0, down = 0, starting = 0, unknown = 0;
    for (const n of ns) {
      if (n.status === 'up') up++;
      else if (n.status === 'down') down++;
      else if (n.status === 'starting') starting++;
      else unknown++;
    }
    const uptimes = ns.map((n) => n.uptimeSecs).filter((s): s is number => s != null);
    const volSeen = new Set<string>();
    const volumes: VolumeRef[] = [];
    for (const n of ns) for (const v of n.volumes) {
      if (!volSeen.has(v.name)) { volSeen.add(v.name); volumes.push(v); }
    }
    const uiLinks = ns.map(uiLinkOf).filter((x): x is UiLink => x != null);

    systems.push({
      key,
      title: niceTitle(key, ns),
      kind: kindOf(ns),
      accent: accentVar(`project:${key}`),
      nodes: ns,
      total: ns.length,
      running: up + starting,
      up, down, starting, unknown,
      hasRunning: up + starting > 0,
      uiLinks,
      volumes,
      newestUptime: uptimes.length ? Math.min(...uptimes) : null,
      oldestUptime: uptimes.length ? Math.max(...uptimes) : null,
    });
  }

  systems.sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      b.running - a.running ||
      a.title.localeCompare(b.title),
  );
  return systems;
}

// The Overview grid: only systems actively running something.
export const runningSystems = (systems: System[]) => systems.filter((s) => s.hasRunning);
// The Data & disk card also wants systems that are NOT running but still hold
// data (stopped project whose volumes persist).
export const dataOnlySystems = (systems: System[]) =>
  systems.filter((s) => !s.hasRunning && s.volumes.length > 0);

// ── Browsable UIs, split stack vs project (the "Open UI ports" card) ─────────
export interface UiPortGroups {
  stack: UiLink[]; // stack services + edge/infra
  project: UiLink[]; // real projects
}
export function uiPorts(nodes: PortalNode[]): UiPortGroups {
  const links = nodes.filter((n) => !n.hidden).map(uiLinkOf).filter((x): x is UiLink => x != null);
  const byName = (a: UiLink, b: UiLink) => a.name.localeCompare(b.name);
  return {
    project: links.filter((l) => l.groupKind === 'project').sort(byName),
    stack: links.filter((l) => l.groupKind !== 'project').sort(byName),
  };
}

// ── Split a system's services by type (the domain page sections + chips) ─────
export interface TypeSection {
  type: ServiceType;
  label: string;
  nodes: PortalNode[];
}
export function groupByType(nodes: PortalNode[]): TypeSection[] {
  const vis = nodes.filter((n) => !n.hidden);
  const by = new Map<ServiceType, PortalNode[]>();
  for (const n of vis) (by.get(n.serviceType) ?? by.set(n.serviceType, []).get(n.serviceType)!).push(n);
  const sections: TypeSection[] = [];
  for (const [type, ns] of by) {
    sections.push({
      type,
      label: TYPE_META[type].label,
      nodes: ns.sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  sections.sort((a, b) => TYPE_META[a.type].order - TYPE_META[b.type].order);
  return sections;
}

// ── Recent activity — most recently (re)started containers ───────────────────
// Uptime is coarse (docker's "Up 3 minutes"), so this is "what came up lately",
// good enough to notice a restart. thresholdSecs default 30 min.
export function recentlyStarted(nodes: PortalNode[], thresholdSecs = 1800): PortalNode[] {
  return nodes
    .filter((n) => !n.hidden && n.uptimeSecs != null && n.uptimeSecs <= thresholdSecs)
    .sort((a, b) => (a.uptimeSecs ?? 0) - (b.uptimeSecs ?? 0));
}

// ── Disk sizes from /system/df ───────────────────────────────────────────────
export function volumeSize(df: SystemDf | null, name: string): number | null {
  if (!df?.Volumes) return null;
  const v = df.Volumes.find((x) => x.Name === name);
  return v?.UsageData?.Size ?? null;
}
export function systemDiskBytes(df: SystemDf | null, system: System): number | null {
  if (!df?.Volumes) return null;
  let sum = 0;
  let any = false;
  for (const v of system.volumes) {
    const s = volumeSize(df, v.name);
    if (s != null) { sum += s; any = true; }
  }
  return any ? sum : null;
}

// Human byte formatting, shared by every disk surface.
export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

// Human "3m ago" / "2h ago" from an uptime-in-seconds. Uptime IS "time since
// start", so uptime == age-since-started.
export function fmtAgo(secs: number | null): string {
  if (secs == null) return '—';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}
export function fmtUptime(secs: number | null): string {
  if (secs == null) return '—';
  if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}
