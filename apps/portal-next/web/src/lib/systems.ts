// The "system" rollup - the new organising unit of the portal.
//
// A SYSTEM is one compose project (n.group): a real project like `tals` or
// `cvops`, or a shared stack service (`monitoring`, `kafka`, `postgres`, …), or
// the edge itself. The Overview shows one card per system that is RUNNING
// something right now; systems that exist only as data (stopped, volume-only)
// fall through to the "Data & disk" card instead. Clicking a card opens that
// system's domain page (/systems/:group), which splits its services by type.
//
// Everything here is derived from the already-joined PortalNode[] + /system/df.
// No new fetch, no DOM - pure functions the pages compose.

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
  key: string; // the compose group, e.g. 'tals' - also the /systems/:name param
  title: string;
  kind: SystemKind;
  accent: string; // css var name, e.g. '--a3'
  nodes: PortalNode[];
  total: number;
  running: number; // up + starting
  up: number;
  down: number;
  starting: number;
  stopped: number; // switched off on purpose - never an alert
  unknown: number;
  isOff: boolean; // entirely stopped, nothing broken
  uiLinks: UiLink[];
  volumes: VolumeRef[];
  newestUptime: number | null; // smallest uptime = most recently (re)started
  oldestUptime: number | null; // largest uptime = longest continuously up
}

const KIND_RANK: Record<SystemKind, number> = { project: 0, stack: 1, infra: 2 };

// A system's display name now arrives ON THE NODE (`groupTitle`, resolved in
// discover.ts) rather than being looked up again here. This function used to own
// a second copy of that rule - label-or-title-case - and a third lived in
// panels.ts, which is precisely how the Services and Access tables ended up
// printing raw compose slugs while this page printed the pretty name.
//
// The residue names (`unmanaged` -> "Other containers") moved with it. What
// stays here is the SORT: residue belongs last, because it is not a system
// competing for position, it is the remainder.
import { RESIDUE_TITLES } from './discover';

export const isResidue = (key: string) => key in RESIDUE_TITLES;

function niceTitle(_group: string, nodes: PortalNode[]): string {
  return nodes[0]?.groupTitle || _group;
}

// The system's kind = the kind of the MAJORITY of its nodes. They agree in
// practice, but reading nodes[0] made a whole system's kind depend on router
// insertion order - one nested hostname could flip a stack service to
// "Project". Infra (edge/portal) is kept distinct so it sorts last and reads as
// plumbing.
function kindOf(nodes: PortalNode[]): SystemKind {
  const tally: Record<SystemKind, number> = { project: 0, stack: 0, infra: 0 };
  for (const n of nodes) {
    if (n.groupKind === 'project') tally.project++;
    else if (n.groupKind === 'infra') tally.infra++;
    else tally.stack++;
  }
  // Ties resolve toward the more specific kind, in KIND_RANK order.
  return (['project', 'stack', 'infra'] as SystemKind[]).reduce((best, k) =>
    tally[k] > tally[best] ? k : best,
  );
}

export function uiLinkOf(n: PortalNode): UiLink | null {
  if (!n.browsable || !n.url) return null;
  // Only report a port for links that ARE a port. A routed service is reached by
  // hostname, and surfacing its container's published port made the Traefik row
  // read ":80" - the edge's own listener, not the dashboard.
  const port = n.host
    ? null
    : n.ports.find((p) => p.scope === 'public')?.hostPort ?? n.ports[0]?.hostPort ?? null;
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
    let up = 0, down = 0, starting = 0, stopped = 0, unknown = 0;
    for (const n of ns) {
      if (n.status === 'up') up++;
      else if (n.status === 'down') down++;
      else if (n.status === 'starting') starting++;
      else if (n.status === 'stopped') stopped++;
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
      up, down, starting, stopped, unknown,
      // Off in full, and nothing wrong with it - the state a project sits in
      // between sessions. Rendered muted and kept out of every alert count.
      isOff: up + starting === 0 && down === 0 && stopped > 0,
      uiLinks,
      volumes,
      newestUptime: uptimes.length ? Math.min(...uptimes) : null,
      oldestUptime: uptimes.length ? Math.max(...uptimes) : null,
    });
  }

  systems.sort(
    (a, b) =>
      // Residue sorts after everything, ahead of every other rule. It is not a
      // system competing for position; it is the remainder, and a remainder that
      // outranks a real system because it happens to have more containers
      // running is exactly the wrong claim.
      Number(isResidue(a.key)) - Number(isResidue(b.key)) ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      b.running - a.running ||
      a.title.localeCompare(b.title),
  );
  return systems;
}

// A system is "clean" only when nothing is down AND nothing is unconfirmed.
// `unknown` is not a pass - it means we could not tell, which is why the old
// down-only rule could report "Has issues 0" beside "Needs attention 7".
//
// `stopped` IS a pass: we know exactly what happened to it (somebody stopped
// it), which is the whole point of separating it from `down`. A system that is
// entirely off is likewise not "unconfirmed" - it is confirmed off.
export const systemHasIssues = (s: System) => !s.isOff && (s.down > 0 || s.unknown > 0);

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

// ── Recent activity - most recently (re)started containers ───────────────────
// Uptime is coarse (docker's "Up 3 minutes"), so this is "what came up lately",
// good enough to notice a restart. thresholdSecs default 30 min.
// A whole-box boot is NOT activity. Docker's uptime is coarse ("Up 21 minutes"),
// so after `just up` every node ties on the same value - the old threshold-only
// rule then listed all 20 containers as one undifferentiated "21m ago" feed, and
// showed nothing at all once the box passed 30 minutes. Report only services
// that started clearly LATER than the box's median, i.e. a genuine restart.
export function recentlyStarted(nodes: PortalNode[], thresholdSecs = 1800): PortalNode[] {
  const running = nodes.filter(
    (n): n is PortalNode & { uptimeSecs: number } => !n.hidden && n.uptimeSecs != null,
  );
  if (!running.length) return [];
  const sorted = running.map((n) => n.uptimeSecs).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const cutoff = Math.min(thresholdSecs, median * 0.6);
  return running
    .filter((n) => n.uptimeSecs <= cutoff)
    .sort((a, b) => a.uptimeSecs - b.uptimeSecs);
}

// ── Disk sizes from /system/df ───────────────────────────────────────────────
export function volumeSize(df: SystemDf | null, name: string): number | null {
  if (!df?.Volumes) return null;
  const v = df.Volumes.find((x) => x.Name === name);
  const size = v?.UsageData?.Size;
  return size == null || size < 0 ? null : size;
}

// Every volume docker knows about, joined to the system that mounts it. Volumes
// with no live mount (RefCount 0 - a renamed or deleted project's leftovers,
// e.g. liba-postgres-data-dev after Liba became Tals) belong to no PortalNode,
// so a nodes-derived disk panel can never show them. That is precisely the case
// a disk panel exists for, hence the join runs this way round: df is the
// authority, systems are matched onto it.
export interface DiskVolume {
  name: string;
  bytes: number | null;
  refCount: number;
  system: System | null;
  destination?: string;
}
export function diskVolumes(df: SystemDf | null, systems: System[]): DiskVolume[] {
  if (!df?.Volumes) return [];
  const owner = new Map<string, { system: System; destination?: string }>();
  for (const s of systems) {
    for (const v of s.volumes) if (!owner.has(v.name)) owner.set(v.name, { system: s, destination: v.destination });
  }
  const out: DiskVolume[] = [];
  for (const v of df.Volumes) {
    if (!v.Name) continue;
    const own = owner.get(v.Name);
    const size = v.UsageData?.Size;
    out.push({
      name: v.Name,
      bytes: size == null || size < 0 ? null : size,
      refCount: v.UsageData?.RefCount ?? 0,
      system: own?.system ?? null,
      destination: own?.destination,
    });
  }
  return out.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
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
  if (n == null) return '-';
  // Docker reports Size: -1 when it did not compute a volume's size. Math.log of
  // a negative is NaN, which rendered literally as "NaN undefined".
  if (n < 0) return '-';
  if (n === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function fmtUptime(secs: number | null): string {
  if (secs == null) return '-';
  if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}
