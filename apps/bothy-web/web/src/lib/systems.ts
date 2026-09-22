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

import type { PortalNode, Status, ServiceType, VolumeRef, PlacementSource } from './discover';
import { TYPE_META } from './discover';
import type { SystemDf } from './api';
import { accentVar } from './accents';
import { primaryIdentity } from './discover';
import { uiName } from './ui-names';

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
  key: string; // the display group, e.g. 'tals' - also the /systems/:name param
  /**
   * The derived identities folded into this card - every distinct `node.system`
   * among its nodes, sorted. Exactly `[key]` until somebody sets
   * `dev.portal.group`, and longer the moment they merge two systems into one.
   *
   * It is what makes regrouping non-destructive. A bookmark to
   * /control/systems/postgres still resolves after postgres has been displayed
   * inside a "Data" group, because findSystem() looks here when the key misses,
   * and the accent is hashed from here so the colour a person recognises the
   * card by does not move either.
   */
  identities: string[];
  title: string;
  kind: SystemKind;
  /** Overview section (`bothy`, `projects`, ...), by majority of its nodes. */
  section: string;
  /** Subgroup within the section, or null. Majority of the nodes in `section`. */
  subgroup: string | null;
  /** Who decided the placement - file, label or default - for the winning vote. */
  placedBy: PlacementSource;
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

// Same majority rule for placement. A system's nodes normally agree, but a
// container-name rule in placement.yml can move one member without its siblings,
// and the card has to land somewhere deterministic. Ties go to the first value
// in sort order, never to node order. The subgroup and source are voted among
// the nodes of the winning section only, so a stray member cannot give a card a
// subgroup that belongs to a different section.
const SOURCE_RANK: Record<PlacementSource, number> = { file: 0, label: 1, default: 2 };
function majority<T extends string>(vals: T[]): T | undefined {
  const tally = new Map<T, number>();
  for (const v of vals) tally.set(v, (tally.get(v) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0];
}
export function placementOf(nodes: Pick<PortalNode, 'section' | 'subgroup' | 'placedBy'>[]): {
  section: string; subgroup: string | null; placedBy: PlacementSource;
} {
  const section = majority(nodes.map((n) => n.section)) ?? 'projects';
  const inSection = nodes.filter((n) => n.section === section);
  const sub = majority(inSection.map((n) => n.subgroup ?? ''));
  const bySub = inSection.filter((n) => (n.subgroup ?? '') === (sub ?? ''));
  const placedBy = bySub.map((n) => n.placedBy).sort((a, b) => SOURCE_RANK[a] - SOURCE_RANK[b])[0] ?? 'default';
  return { section, subgroup: sub || null, placedBy };
}

// primaryIdentity() and findSystem() live in discover.ts, next to the identity
// they resolve, and are re-exported here because every consumer already imports
// from this module. The reason they are not DEFINED here is mechanical and
// load-bearing: this module imports things, so `checks/run.sh` cannot compile it
// with a bare tsc, and the two rules that decide whether a bookmark still opens
// and whether a card keeps its colour are exactly the rules that need a truth
// table over them.
export { primaryIdentity, findSystem } from './discover';

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
    const identities = [...new Set(ns.map((n) => n.system || key))].sort();

    systems.push({
      key,
      identities,
      title: niceTitle(key, ns),
      kind: kindOf(ns),
      ...placementOf(ns),
      accent: accentVar(`project:${primaryIdentity(key, identities)}`),
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

// ── Sections and subgroups (the Overview's two display levels) ──────────────
//
// Keys are free strings - placement.yml or a label can invent a section - so
// the two that exist by default get a title and an order, and anything else is
// title-cased and sorted after them alphabetically. Change the order here, in
// one place.
const SECTION_META: Record<string, { title: string; order: number }> = {
  bothy: { title: 'Bothy', order: 0 },
  projects: { title: 'Projects', order: 1 },
};
const SUBGROUP_META: Record<string, { title: string; order: number }> = {
  core: { title: 'Core', order: 0 },
  helpers: { title: 'Helpers', order: 1 },
};
const titled = (k: string) => k.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
export const sectionTitle = (k: string) => SECTION_META[k]?.title ?? titled(k);
export const subgroupTitle = (k: string) => SUBGROUP_META[k]?.title ?? titled(k);
const metaOrder = (meta: Record<string, { order: number }>, a: string, b: string) =>
  (meta[a]?.order ?? 99) - (meta[b]?.order ?? 99) || a.localeCompare(b);

/** Plain words for who placed a system, for the dialog and the chip tooltip. */
export const PLACED_BY_LABEL: Record<PlacementSource, string> = {
  file: 'placement.yml',
  label: 'container label',
  default: 'default for its kind',
};

export interface SubgroupOf {
  /** null = systems in the section that name no subgroup. */
  key: string | null;
  title: string | null;
  systems: System[];
}
export interface SectionOf {
  key: string;
  title: string;
  subgroups: SubgroupOf[];
}

/** section -> subgroup -> systems. Ungrouped systems come first in a section. */
export function sectionsOf(systems: System[]): SectionOf[] {
  const bySection = new Map<string, Map<string | null, System[]>>();
  for (const s of systems) {
    const subs = bySection.get(s.section) ?? bySection.set(s.section, new Map()).get(s.section)!;
    (subs.get(s.subgroup) ?? subs.set(s.subgroup, []).get(s.subgroup)!).push(s);
  }
  return [...bySection.keys()].sort((a, b) => metaOrder(SECTION_META, a, b)).map((key) => {
    const subs = bySection.get(key)!;
    const keys = [...subs.keys()].sort((a, b) =>
      a === null ? -1 : b === null ? 1 : metaOrder(SUBGROUP_META, a, b));
    return {
      key,
      title: sectionTitle(key),
      subgroups: keys.map((k) => ({ key: k, title: k === null ? null : subgroupTitle(k), systems: subs.get(k)! })),
    };
  });
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
  const vis = nodes.filter((n) => !n.hidden);
  const raw = vis.map(uiLinkOf).filter((x): x is UiLink => x != null);
  // Named for the product that opens, not the container that publishes it
  // (lib/ui-names.ts): a system with ONE UI takes its placed title, the rest
  // keep the service name with the product casing fixed. The residue group
  // ("Other containers") is a remainder, not a product, so it never lends its
  // title to a link.
  const perGroup = new Map<string, number>();
  for (const l of raw) perGroup.set(l.group, (perGroup.get(l.group) ?? 0) + 1);
  // The link's OWN node's title, not the last one seen in its group: a group
  // can mix a discovered container with a collector-declared service whose
  // title came from the project (SonarQube's group also holds "Manifests").
  const titleOf = new Map(vis.map((n) => [n.id, n.groupTitle] as const));
  const links = raw.map((l) => ({
    ...l,
    name: uiName(
      l.name,
      isResidue(l.group) ? null : titleOf.get(l.id),
      perGroup.get(l.group) ?? 0,
    ),
  }));
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
