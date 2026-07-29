import type { PortalNode } from './discover';

// React Router decodes params for us, so encode on the way out only.
export const serviceLink = (n: Pick<PortalNode, 'id'>) => `/services/${encodeURIComponent(n.id)}`;
// A "system" is a compose group (project OR stack service). Its domain page is
// /systems/:group. projectLink is kept as an alias so older call-sites resolve.
export const systemLink = (group: string) => `/systems/${encodeURIComponent(group)}`;
export const projectLink = systemLink;

// The one-line subtitle shown under a service name (host, else ports, else name).
export function nodeSub(n: PortalNode): string {
  return n.host || n.ports.map((p) => `:${p.hostPort}`).join(' ') || n.container?.name || n.group;
}
