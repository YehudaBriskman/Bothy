import type { PortalNode } from './discover';

// React Router decodes params for us, so encode on the way out only.
export const serviceLink = (n: Pick<PortalNode, 'id'>) => `/services/${encodeURIComponent(n.id)}`;
export const projectLink = (group: string) => `/projects/${encodeURIComponent(group)}`;

// The one-line subtitle shown under a service name (host, else ports, else name).
export function nodeSub(n: PortalNode): string {
  return n.host || n.ports.map((p) => `:${p.hostPort}`).join(' ') || n.container?.name || n.group;
}
