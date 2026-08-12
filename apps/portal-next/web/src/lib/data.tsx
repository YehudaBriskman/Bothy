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
  stopped: number;
  unknown: number;
}

export function healthOf(nodes: { status: string }[]): HealthCounts {
  const c: HealthCounts = { total: nodes.length, up: 0, down: 0, starting: 0, stopped: 0, unknown: 0 };
  for (const n of nodes) {
    if (n.status === 'up') c.up++;
    else if (n.status === 'down') c.down++;
    else if (n.status === 'starting') c.starting++;
    else if (n.status === 'stopped') c.stopped++;
    else c.unknown++;
  }
  return c;
}

// Services that are meant to be up right now. A deliberately-stopped service is
// not part of the denominator: with it in, switching a project off dragged the
// healthy % down and made an idle box look broken.
export const expectedUp = (c: HealthCounts) => c.total - c.stopped;

// "Needs attention" — anything a human should actually look at.
//
// Two things used to land here that are not problems:
//   1. every stopped container, because statusOf() collapsed exited(0) into
//      'down' (fixed at the source in discover.ts), and
//   2. orphan routes belonging to a system that is entirely switched off — the
//      four tals.dev.test file-routes point at host processes, so stopping Tals
//      "orphaned" all four at once and each one shouted.
// An orphan route still matters when the rest of its system is up (that IS the
// route-with-no-backend case portal.md wants shouted about), so the rule is
// scoped to the system rather than dropped.
export function needsAttention(nodes: import('./discover').PortalNode[]): import('./discover').PortalNode[] {
  const liveGroups = new Set(
    nodes.filter((n) => n.status === 'up' || n.status === 'starting').map((n) => n.group),
  );
  return nodes.filter((n) => {
    if (n.status === 'down') return true;
    if (n.kind !== 'orphan-route') return false;
    return liveGroups.has(n.group);
  });
}
