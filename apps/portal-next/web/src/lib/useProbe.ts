import { useEffect, useState } from 'react';
import type { Status } from './discover';

// no-cors reachability probe. ONLY for things with no container to ask: host
// processes (@file orphan routes) and the static offline floor. Everything else
// uses Docker's Health, which is honest. no-cors can't read the response, but a
// resolved fetch means the host answered; a timeout means it didn't.
const probe = (u: string): Promise<boolean> =>
  Promise.race([
    fetch(u, { mode: 'no-cors', cache: 'no-store' }).then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 4500)),
  ]).catch(() => false);

// Probe a set of URLs and report the resulting status per URL. Re-runs whenever
// the set of URLs changes (joined key), not on every render.
export function useProbe(urls: string[]): Record<string, Status> {
  const key = urls.slice().sort().join('|');
  const [statuses, setStatuses] = useState<Record<string, Status>>({});

  useEffect(() => {
    if (!urls.length) return;
    let cancelled = false;
    for (const u of urls) {
      probe(u).then((ok) => {
        if (cancelled) return;
        setStatuses((prev) => ({ ...prev, [u]: ok ? 'up' : 'down' }));
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return statuses;
}
