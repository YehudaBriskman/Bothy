import type { PortalNode } from './discover';

export interface Panel {
  key: string;
  title: string;
  sub: string;
  nodes: PortalNode[];
}

// Projects get one panel each. The stack collapses into ONE panel: each stack
// service is its own compose project (monitoring, mgmt, kafka, wiki, postgres,
// redis), which would otherwise render six near-empty panels for no gain.
export function panelize(nodes: PortalNode[]): Panel[] {
  const vis = nodes.filter((n) => !n.hidden);

  // A project's display name comes from its own depth-1 node if labelled, so
  // "cvops" can present as "CVOps" in breadcrumbs without a second label.
  const nice = new Map<string, string>();
  for (const n of vis) {
    const L = n.container?.labels || {};
    if (L['dev.portal.project']) nice.set(n.group, L['dev.portal.project']);
  }
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
      nodes: stack,
    });
  }

  const infra = vis.filter((n) => n.groupKind === 'infra').sort(byOrder);
  if (infra.length) {
    panels.push({
      key: 'infra',
      title: 'Infrastructure',
      sub: 'the edge itself · usually you can ignore this',
      nodes: infra,
    });
  }
  return panels;
}
