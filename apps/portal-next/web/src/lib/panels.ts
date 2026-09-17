import { groupStorageKey, SECTION_BOTHY, SECTION_PROJECTS } from './discover';
import type { PortalNode } from './discover';
import { sectionTitle, subgroupTitle } from './systems';

export interface Panel {
  key: string;
  title: string;
  sub: string;
  // The compose group this panel represents, when it represents exactly one
  // (project panels do; the aggregated section/subgroup panels do not).
  group: string | null;
  /**
   * Every derived `node.system` folded into this panel, sorted - the same field
   * System carries, and for the same reason: `group` is a display name a label
   * can move, and identity is the half that stays put.
   */
  identities: string[];
  /**
   * What per-browser UI state about this panel is filed under. Equal to `key`
   * until somebody sets `dev.portal.group`; see groupStorageKey() in
   * discover.ts for what goes wrong when a preference is keyed on a name a
   * label can move.
   */
  storeKey: string;
  nodes: PortalNode[];
}

// Projects get one panel each. Every other section/subgroup collapses into ONE
// panel: each stack service is its own compose project (monitoring, postgres,
// auth), which would otherwise render near-empty panels for no gain.
//
// `allNodes` supplies the DISPLAY NAMES and defaults to `nodes`. Names must come
// from the unfiltered set: the label that spells "CVOps" lives on one container,
// so deriving names from the filtered list renamed the panel to "Cvops" the
// moment a filter excluded that one node.
export function panelize(nodes: PortalNode[], allNodes: PortalNode[] = nodes): Panel[] {
  const vis = nodes.filter((n) => !n.hidden);

  // A group's display name is read off the NODE. It used to be re-derived here
  // from the labels - a third implementation of the same rule, after discover.ts
  // and systems.ts - and three copies is how the Overview came to call a system
  // `Identity · Keycloak` while two other pages called it `auth`.
  //
  // Built from `allNodes`, not `nodes`: the title has to survive a filter that
  // excludes the one node carrying the label, which is the reason this function
  // takes both lists in the first place.
  const nice = new Map<string, string>();
  for (const n of allNodes) if (n.groupTitle) nice.set(n.group, n.groupTitle);
  const title = (g: string) =>
    nice.get(g) || g.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  // Identities come from `allNodes` for exactly the reason the titles do. A
  // panel's storage key must not depend on which of its services a filter left
  // on screen: derive it from the filtered list and searching for "api" moves
  // the key of every group whose other containers dropped out, so the layout
  // forgets itself while you type.
  const idents = (ns: PortalNode[]) =>
    [...new Set(ns.filter((n) => !n.hidden).map((n) => n.system || n.group))].sort();
  const identsOfGroup = new Map<string, string[]>();
  for (const n of allNodes) if (!n.hidden) {
    const cur = identsOfGroup.get(n.group) ?? [];
    if (!cur.includes(n.system || n.group)) cur.push(n.system || n.group);
    identsOfGroup.set(n.group, cur.sort());
  }

  const byOrder = (a: PortalNode, b: PortalNode) =>
    (a.depth ?? 9) - (b.depth ?? 9) || a.order - b.order || a.name.localeCompare(b.name);

  const panels: Panel[] = [];
  // One panel per project in the Projects section - the section's members ARE
  // projects, and each already had its own panel under a stable key.
  const inProjects = (n: PortalNode) => n.section === SECTION_PROJECTS && !n.subgroup;
  const projects = [...new Set(vis.filter(inProjects).map((n) => n.group))].sort();
  for (const g of projects) {
    const identities = identsOfGroup.get(g) ?? [g];
    panels.push({
      key: `project:${g}`,
      title: title(g),
      sub: 'project · ' + g,
      group: g,
      identities,
      storeKey: groupStorageKey(`project:${g}`, g, identities),
      nodes: vis.filter((n) => inProjects(n) && n.group === g).sort(byOrder),
    });
  }

  // Everything else: one aggregated panel per section/subgroup.
  //
  // Bothy › Helpers and Bothy › Core keep the keys the old Stack and
  // Infrastructure panels had, `stack` and `infra`. They are the same idea under
  // a better name, so a group somebody collapsed stays collapsed, and the 3D
  // Topology still finds its edge under `infra`.
  const LEGACY: Record<string, { key: string; sub: string }> = {
    [`${SECTION_BOTHY}/helpers`]: { key: 'stack', sub: 'shared dev services' },
    [`${SECTION_BOTHY}/core`]: { key: 'infra', sub: 'the edge, sign-in and Bothy itself' },
  };
  const slot = (n: PortalNode) => `${n.section}/${n.subgroup ?? ''}`;
  const slots = [...new Set(vis.filter((n) => !inProjects(n)).map(slot))];
  const rank = (k: string) => (LEGACY[k] ? (LEGACY[k].key === 'stack' ? 1 : 2) : 0);
  slots.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const k of slots) {
    const [section, subgroup] = k.split('/');
    const ns = vis
      .filter((n) => slot(n) === k)
      .sort((a, b) => a.group.localeCompare(b.group) || byOrder(a, b));
    const legacy = LEGACY[k];
    const key = legacy?.key ?? `section:${k}`;
    panels.push({
      key,
      title: [sectionTitle(section), subgroup && subgroupTitle(subgroup)].filter(Boolean).join(' · '),
      sub: [legacy?.sub, ...new Set(ns.map((n) => n.group))].filter(Boolean).join(' · '),
      group: null,
      identities: idents(allNodes.filter((n) => slot(n) === k)),
      // A structural section, not a display group: no label reaches this string,
      // so it is already the stable key.
      storeKey: groupStorageKey(key, null, []),
      nodes: ns,
    });
  }
  return panels;
}
