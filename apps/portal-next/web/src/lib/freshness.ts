// The freshness signal, computed one way. Green live / amber degraded|stale /
// red down — always paired with words, never colour alone (portal.md rule).
import type { PortalData } from './api';

export type Freshness = 'live' | 'degraded' | 'stale' | 'down';

export function freshnessOf(data: PortalData): { kind: Freshness; text: string; short: string } {
  const total = data.nodes.length;
  const up = data.nodes.filter((n) => n.status === 'up').length;

  if (data.fails === 0) {
    if (data.errors.length) {
      return {
        kind: 'degraded',
        text: `${up}/${total} up · ${data.errors.map((e) => e.src).join(', ')} unreachable`,
        short: 'degraded',
      };
    }
    return { kind: 'live', text: `${up}/${total} up · live`, short: 'live' };
  }
  if (data.at > 0) {
    const secs = Math.round((Date.now() - data.at) / 1000);
    return { kind: 'stale', text: `stale · last seen ${secs}s ago · retrying`, short: 'stale' };
  }
  return { kind: 'down', text: 'cannot reach APIs · retrying', short: 'offline' };
}
