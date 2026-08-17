import type { PortalNode } from './discover';

export interface Panel {
  key: string;
  title: string;
  sub: string;
  // The compose group this panel represents, when it represents exactly one
  // (project panels do; the aggregated Stack/Infrastructure panels do not).
  group: string | null;
  nodes: PortalNode[];
}

// Projects get one panel each. The stack collapses into ONE panel: each stack
// service is its own compose project (monitoring, mgmt, kafka, wiki, postgres,
// redis), which would otherwise render six near-empty panels for no gain.
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
  const byOrder = (a: PortalNode, b: PortalNode) =>
    (a.depth ?? 9) - (b.depth ?? 9) || a.order - b.order || a.name.localeCompare(b.name);

  const panels: Panel[] = [];
  const projects = [...new Set(vis.filter((n) => n.groupKind === 'project').map((n) => n.group))].sort();
  for (const g of projects) {
    panels.push({
      key: `project:${g}`,
      title: title(g),
      sub: 'project · ' + g,
      group: g,
      nodes: vis.filter((n) => n.group === g).sort(byOrder),
    });
  }

  const stack = vis
    .filter((n) => n.groupKind === 'stack')
    .sort((a, b) => a.group.localeCompare(b.group) || byOrder(a, b));
  if (stack.length) {
    panels.push({
      key: 'stack',
      title: 'Stack',
      sub: 'shared dev services · ' + [...new Set(stack.map((n) => n.group))].join(' · '),
      group: null,
      nodes: stack,
    });
  }

  const infra = vis.filter((n) => n.groupKind === 'infra').sort(byOrder);
  if (infra.length) {
    panels.push({
      key: 'infra',
      title: 'Infrastructure',
      sub: 'the edge itself · usually you can ignore this',
      group: null,
      nodes: infra,
    });
  }
  return panels;
}
