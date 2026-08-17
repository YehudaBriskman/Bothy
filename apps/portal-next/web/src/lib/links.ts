import type { PortalNode } from './discover';

// React Router decodes params for us, so encode on the way out only.
//
// Both moved under /control when Services and Access became one section. The old
// paths still resolve (pages/control/redirects.ts), so pointing these at them
// would still WORK - it would just make every service click in the app a
// redirect, and make these two functions a stale statement about where a service
// page lives. One line each is cheaper than either.
export const serviceLink = (n: Pick<PortalNode, 'id'>) => `/control/services/${encodeURIComponent(n.id)}`;
// A "system" is a compose group (project OR stack service). Its domain page is
// /control/systems/:group.
export const systemLink = (group: string) => `/control/systems/${encodeURIComponent(group)}`;

// The one-line subtitle shown under a service name (host, else ports, else name).
export function nodeSub(n: PortalNode): string {
  return n.host || n.ports.map((p) => `:${p.hostPort}`).join(' ') || n.container?.name || n.group;
}

// ── One vocabulary for what a node IS ────────────────────────────────────────
// A card said "host process", a table row said "host", the detail page printed
// the raw enum "orphan-route" and the Routes table said "host process" again -
// four names for one thing. Every surface reads this.
export interface KindLabel {
  label: string;
  bad: boolean;
  hint: string;
}
export function kindLabelOf(n: PortalNode): KindLabel {
  if (n.route?.provider === 'file') {
    return {
      label: 'host process',
      bad: false,
      hint: 'Runs on the host, reached through the edge. Expect 502 when it is not running.',
    };
  }
  if (n.kind === 'orphan-route') {
    return {
      label: 'no container',
      bad: true,
      hint: 'Traefik routes this name, but nothing answers on devnet - it may have stopped.',
    };
  }
  if (n.kind === 'unrouted') {
    return {
      label: 'unrouted',
      bad: false,
      hint: 'Publishes a host port but has no edge route.',
    };
  }
  return { label: 'routed', bad: false, hint: 'Routed through the edge by hostname.' };
}

// Why a node's status is 'unknown'. Docker Health is authoritative for
// containers; a host process has no container to ask, and the browser cannot
// tell a 502 error page from a healthy response across origins - so the portal
// says so instead of guessing.
export function unknownReason(n: PortalNode): string | null {
  if (n.status !== 'unknown') return null;
  if (n.route?.provider === 'file') {
    return 'No container to ask. Open it to see whether the process is running.';
  }
  return 'No container matched this route on devnet.';
}
