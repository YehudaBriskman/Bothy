// ONE poll for the whole app. usePortalData() opens a single 10s polling loop;
// lifting it into context means every route/page shares that one loop instead of
// each mounting its own (which would multiply the socket-proxy load and desync
// the freshness pill between pages).

import { createContext, useContext, type ReactNode } from 'react';
import { usePortalData, type PortalData } from './api';

interface PortalCtx {
  data: PortalData;
  refresh: () => void;
}

const Ctx = createContext<PortalCtx | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const { data, refresh } = usePortalData();
  return <Ctx.Provider value={{ data, refresh }}>{children}</Ctx.Provider>;
}

export function usePortal(): PortalCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePortal() must be used inside <DataProvider>');
  return v;
}

// Derived helpers shared across pages. Kept here so the health maths is computed
// one way everywhere (Overview tiles, project rollups, the "needs attention"
// list all agree).

export interface HealthCounts {
  total: number;
  up: number;
  down: number;
  starting: number;
  unknown: number;
}

export function healthOf(nodes: { status: string }[]): HealthCounts {
  const c: HealthCounts = { total: nodes.length, up: 0, down: 0, starting: 0, unknown: 0 };
  for (const n of nodes) {
    if (n.status === 'up') c.up++;
    else if (n.status === 'down') c.down++;
    else if (n.status === 'starting') c.starting++;
    else c.unknown++;
  }
  return c;
}

// "Needs attention" — anything a manager should look at: down services and
// orphaned routes (a route with no container is exactly what the portal should
// shout about, per portal.md).
export function needsAttention(nodes: import('./discover').PortalNode[]): import('./discover').PortalNode[] {
  return nodes.filter(
    (n) => n.status === 'down' || n.kind === 'orphan-route',
  );
}
