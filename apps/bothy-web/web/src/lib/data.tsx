// ONE poll for the whole app. usePortalData() opens a single 10s polling loop;
// lifting it into context means every route/page shares that one loop instead of
// each mounting its own (which would multiply the socket-proxy load and desync
// the freshness pill between pages).

import { createContext, useContext, type ReactNode } from 'react';
import { usePortalData, type PortalData } from './api';

interface PortalCtx {
  data: PortalData;
  /** Re-poll now; settles when that poll has answered or failed. */
  refresh: () => Promise<void>;
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
  /** One-shots that ran to completion. A success, and never a fault. */
  done: number;
  /** Exited a fortnight or more ago with nothing of their project running. */
  dormant: number;
  unknown: number;
}

export function healthOf(nodes: { status: string }[]): HealthCounts {
  const c: HealthCounts = {
    total: nodes.length, up: 0, down: 0, starting: 0, stopped: 0, done: 0, dormant: 0, unknown: 0,
  };
  for (const n of nodes) {
    if (n.status === 'up') c.up++;
    else if (n.status === 'down') c.down++;
    else if (n.status === 'starting') c.starting++;
    else if (n.status === 'stopped') c.stopped++;
    else if (n.status === 'done') c.done++;
    else if (n.status === 'dormant') c.dormant++;
    else c.unknown++;
  }
  return c;
}

// Services that are meant to be up right now. A deliberately-stopped service is
// not part of the denominator: with it in, switching a project off dragged the
// healthy % down and made an idle box look broken.
//
// `done` and `dormant` leave it for the same reason and more strongly. A
// one-shot that finished is not something that failed to be up - counting
// `keycloak-db-init` against the box's health meant the strip reported a fault
// on every single deploy, forever. A container from a project nobody has run in
// six weeks is not a service at all any more.
//
// RESTS ON THE PARTITION, so it cannot silently start subtracting something
// twice: every node has exactly one status, and this subtracts the three that
// are not claims about whether something should be running.
export const expectedUp = (c: HealthCounts) => c.total - c.stopped - c.done - c.dormant;

/** The three statuses that are NOT a claim about whether a thing should be up:
 *  shown, countable, and deliberately outside every health measurement. */
export const notExpected = (c: HealthCounts) => c.stopped + c.done + c.dormant;

// "Needs attention" - anything a human should actually look at.
//
// Two things used to land here that are not problems:
//   1. every stopped container, because statusOf() collapsed exited(0) into
//      'down' (fixed at the source in discover.ts), and
//   2. orphan routes belonging to a system that is entirely switched off - the
//      four `tals.<base-domain>` file-routes point at host processes, so stopping Tals
//      "orphaned" all four at once and each one shouted.
// An orphan route still matters when the rest of its system is up (that IS the
// route-with-no-backend case portal.md wants shouted about), so the rule is
// scoped to the system rather than dropped.
//
//   3. (2026-08-12) A `down` container inside a system where NOTHING is
//      running. The same mistake as 2, reached from the other direction, and it
//      appeared the moment discovery started reporting stopped containers:
//      `monorepo-inherited-channellink-1` exited 255 two days ago while its
//      three siblings exited 0, i.e. somebody switched the project off and one
//      container was untidy on the way out. Shouting about it every day since
//      is not a fault report, it is a fault report's ghost.
//
//      A non-zero exit inside a LIVE system is still a real fault and still
//      shouts - that distinction is the whole rule, and it is why this is scoped
//      by system rather than by "is it old".
//   4. (2026-09-23) Anything `done` or `dormant`. Both are now their own status
//      rather than a flavour of stopped/down, and neither can ever be an alert:
//      `done` is a one-shot reporting success, `dormant` is a container that has
//      not run in a fortnight in a project with nothing running. Stated here as
//      an explicit refusal rather than left to fall out of the filters below,
//      because "it happens not to match any rule today" is not a guarantee.
export function needsAttention(nodes: import('./discover').PortalNode[]): import('./discover').PortalNode[] {
  const liveGroups = new Set(
    nodes.filter((n) => n.status === 'up' || n.status === 'starting').map((n) => n.group),
  );
  return nodes.filter((n) => {
    if (n.status === 'done' || n.status === 'dormant') return false;
    // Both cases now ask the same question: is anything in this system alive?
    // If the whole system is off, its wreckage is not news.
    if (n.status === 'down') return liveGroups.has(n.group);
    if (n.kind !== 'orphan-route') return false;
    return liveGroups.has(n.group);
  });
}
